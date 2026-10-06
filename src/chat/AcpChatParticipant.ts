import * as vscode from 'vscode';
import { diffLines } from 'diff';

import type { SessionManager } from '../core/SessionManager';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import type { TurnRouter, ActiveTurn } from './TurnRouter';
import type { ChangeTracker } from '../changes/ChangeTracker';
import { BaselineContentProvider } from '../changes/ChangesView';
import { hasNativeEdits, pushDiffs, pushThinking, pushToolCall, trackExternalEdit } from './proposed';
import { log, logError } from '../utils/Logger';

import type { SessionNotification } from '@agentclientprotocol/sdk';

export const PARTICIPANT_ID = 'acp.agent';

/** Number of chat requests handled; read by UI tests. */
export let chatRequestCount = 0;

const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

/** Per-turn bookkeeping shared by the update renderer. */
interface TurnState {
  stream: vscode.ChatResponseStream;
  turn: ActiveTurn;
  sessionId: string;
  externals: Map<string, () => void>;
  /** Per tool call: whether the session accepted externalEdit (native Keep/Undo). */
  externalResults: Map<string, Promise<boolean>>;
  kinds: Map<string, string>;
  /** Files each edit tool call touches; used to snapshot before and report after. */
  editPaths: Map<string, Set<string>>;
  work: Promise<unknown>[];
  thoughtN: number;
}

/**
 * Chat participant that drives the active ACP session from VS Code's native
 * Chat view.
 *
 * File edits are tracked session-type-independently: snapshot the file before
 * the agent edits it, compare after, then show the diff plus Keep/Undo in the
 * response (backed by ChangeTracker). Native textEdit/externalEdit is opt-in
 * (`acp.chat.nativeEdits`) because some session types reject it.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
  sessionUpdateHandler: SessionUpdateHandler,
  router: TurnRouter,
  tracker: ChangeTracker,
): vscode.ChatRequestHandler {
  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const sessionId = sessionManager.getActiveSessionId();
    if (!sessionId) {
      stream.markdown('No ACP agent is connected.\n\n');
      stream.button({ title: 'Connect to Agent', command: 'acp.connectAgent' });
      return {};
    }

    chatRequestCount++;
    const ref = (request as any).sessionResource as vscode.Uri | undefined;
    // Agent host sessions (Copilot CLI etc.) reject extension edits; use the fallback there
    const native = router.nativeEnabled && !ref?.scheme.startsWith('agent-host');
    log(`chat request: sessionResource=${ref?.toString() ?? 'n/a'} native=${native}`);

    const state: TurnState = {
      stream, sessionId,
      turn: router.begin(sessionId, stream, token, request.toolInvocationToken, native),
      externals: new Map(), externalResults: new Map(), kinds: new Map(), editPaths: new Map(), work: [], thoughtN: 0,
    };

    const listener = (n: SessionNotification) => {
      if (n.sessionId !== sessionId) { return; }
      try {
        renderUpdate(n.update as any, state, router, tracker);
      } catch (e) {
        logError('chat participant: render failed', e);
      }
    };
    sessionUpdateHandler.addListener(listener);
    const cancelSub = token.onCancellationRequested(() => {
      void sessionManager.cancelTurn(sessionId).catch(e => logError('cancel failed', e));
      for (const resolve of [...state.turn.pendingPermissions.values()]) { resolve('cancelled'); }
    });

    try {
      sessionManager.recordFirstPrompt(sessionId, request.prompt);
      const res = await sessionManager.sendPrompt(sessionId, request.prompt);
      sessionManager.touchHistory(sessionId);
      if (res.stopReason === 'refusal') { stream.markdown('\n\n_The agent refused this request._'); }
    } catch (e: any) {
      logError('chat participant: prompt failed', e);
      stream.markdown(`\n\n**Error:** ${e?.message ?? e}`);
    } finally {
      for (const done of state.externals.values()) { done(); }
      // Report edits of tool calls that never reached completed/failed
      for (const [id, paths] of state.editPaths) {
        state.editPaths.delete(id);
        state.work.push(finishEdit(id, [...paths], state, tracker));
      }
      // externalEdit must settle before the response completes
      state.work.push(...state.externalResults.values());
      await Promise.allSettled(state.work);
      sessionUpdateHandler.removeListener(listener);
      cancelSub.dispose();
      router.end(sessionId);
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');

  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand('acp.permission.answer', (permId: string, optionId: string) => {
      router.answerPermission(permId, optionId);
    }),
  );
  return handler;
}

function renderUpdate(u: any, st: TurnState, router: TurnRouter, tracker: ChangeTracker): void {
  const { stream } = st;
  switch (u?.sessionUpdate) {
    case 'agent_message_chunk':
      if (u.content?.type === 'text') { stream.markdown(u.content.text); }
      break;
    case 'agent_thought_chunk':
      if (u.content?.type === 'text') { pushThinking(stream, `thought-${++st.thoughtN}`, u.content.text); }
      break;
    case 'tool_call':
      pushToolCall(stream, { toolCallId: u.toolCallId, title: u.title ?? 'Tool call', status: u.status ?? 'pending' }, false);
      noteToolKind(u, st);
      snapshotEdit(u, st, tracker);
      maybeTrackExternalEdit(u, st, router);
      break;
    case 'tool_call_update': {
      pushToolCall(stream, { toolCallId: u.toolCallId, title: u.title ?? 'Tool call', status: u.status ?? 'in_progress' }, true);
      noteToolKind(u, st);
      // Paths often arrive only in later updates (Claude sends empty locations first)
      const merged = { ...u, kind: u.kind ?? st.kinds.get(u.toolCallId) };
      snapshotEdit(merged, st, tracker);
      maybeTrackExternalEdit(merged, st, router);
      if (u.status === 'completed' || u.status === 'failed') {
        st.externals.get(u.toolCallId)?.();
        st.externals.delete(u.toolCallId);
        const paths = st.editPaths.get(u.toolCallId);
        if (paths?.size) {
          st.editPaths.delete(u.toolCallId);
          st.work.push(finishEdit(u.toolCallId, [...paths], st, tracker));
        }
      }
      break;
    }
    case 'plan': {
      const lines = (u.entries ?? []).map((e: any) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`);
      if (lines.length) { stream.markdown(`\n\n${lines.join('\n')}\n\n`); }
      break;
    }
  }
}

function noteToolKind(u: any, st: TurnState): void {
  if (u.kind) { st.kinds.set(u.toolCallId, u.kind); }
}

function editPathsOf(u: any): string[] {
  const paths = new Set<string>();
  for (const c of u.content ?? []) { if (c?.type === 'diff' && c.path) { paths.add(c.path); } }
  for (const l of u.locations ?? []) { if (l?.path) { paths.add(l.path); } }
  return [...paths].map(p => vscode.Uri.file(p).fsPath);
}

/**
 * Snapshot files an edit tool call is about to touch. Runs as soon as paths
 * are known, which for permissioned edits is before the write happens.
 */
function snapshotEdit(u: any, st: TurnState, tracker: ChangeTracker): void {
  if (!EDIT_KINDS.has(u.kind) || u.status === 'completed' || u.status === 'failed') { return; }
  const known = st.editPaths.get(u.toolCallId) ?? new Set<string>();
  for (const p of editPathsOf(u)) {
    if (known.has(p)) { continue; }
    known.add(p);
    st.work.push(tracker.captureBaseline(p).catch(e => logError('captureBaseline failed', e)));
  }
  if (known.size) { st.editPaths.set(u.toolCallId, known); }
  log(`snapshotEdit: ${u.toolCallId} kind=${u.kind} paths=${[...known].join(',')}`);
}

/**
 * After an edit tool call ends: if VS Code tracked it natively, its own
 * "files changed" UI owns Keep/Undo, so drop our snapshot. Otherwise show the
 * fallback diff card.
 */
async function finishEdit(toolCallId: string, paths: string[], st: TurnState, tracker: ChangeTracker): Promise<void> {
  try {
    const nativeOk = await st.externalResults.get(toolCallId);
    if (nativeOk) {
      for (const p of paths) { await tracker.keep(p); }
      return;
    }
    await reportEdits(paths, st.stream, tracker);
  } catch (e) {
    logError('finishEdit failed', e);
  }
}

/** Compare against baseline, then show the diff and Keep/Undo in the response. */
async function reportEdits(paths: string[], stream: vscode.ChatResponseStream, tracker: ChangeTracker): Promise<void> {
  const changed: string[] = [];
  for (const p of paths) {
    const hasChange = await tracker.noteAgentResult(p);
    log(`reportEdits: ${p} pending=${hasChange}`);
    if (hasChange) { changed.push(p); }
  }
  if (!changed.length) { return; }

  const entries = [];
  for (const p of changed) {
    const entry = tracker.get(p);
    if (!entry) { continue; }
    let added = 0, removed = 0;
    for (const part of diffLines(entry.baseline ?? '', entry.agentText)) {
      if (part.added) { added += part.count ?? 0; }
      else if (part.removed) { removed += part.count ?? 0; }
    }
    entries.push({
      originalUri: entry.baseline === null ? undefined : BaselineContentProvider.uriFor(p, entry.version),
      modifiedUri: vscode.Uri.file(p),
      added, removed,
    });
  }
  log(`reportEdits: pushing diff card for ${entries.length} file(s)`);
  pushDiffs(stream, 'Agent changes', entries);
  for (const p of changed) {
    const name = p.split('/').pop();
    stream.button({ title: `Keep ${name}`, command: 'acp.changes.keep', arguments: [{ path: p }] });
    stream.button({ title: `Undo ${name}`, command: 'acp.changes.undo', arguments: [{ path: p }] });
    stream.button({ title: `Open diff`, command: 'acp.changes.openDiff', arguments: [{ path: p }] });
  }
}

/**
 * Opt-in: wrap an agent-side edit in externalEdit so VS Code tracks it with
 * native Keep/Undo. Only where `acp.chat.nativeEdits` is enabled.
 */
function maybeTrackExternalEdit(u: any, st: TurnState, router: TurnRouter): void {
  if (!st.turn.native || !EDIT_KINDS.has(u.kind)) { return; }
  if (u.status === 'completed' || u.status === 'failed') { return; }
  if (st.externals.has(u.toolCallId)) { return; }
  if (router.usesClientFs(st.sessionId) || !hasNativeEdits(st.stream)) { return; }

  const paths = editPathsOf(u);
  if (!paths.length) { return; }

  paths.forEach(p => st.turn.externalPaths.add(p));
  const done = new Promise<void>(resolve => st.externals.set(u.toolCallId, resolve));
  const result = trackExternalEdit(st.stream, paths.map(p => vscode.Uri.file(p)), () => done);
  if (!result) {
    st.externals.delete(u.toolCallId);
    return;
  }
  st.externalResults.set(u.toolCallId, result);
  log(`externalEdit started: ${u.toolCallId} ${paths.join(', ')}`);
}
