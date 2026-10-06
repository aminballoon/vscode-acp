import * as vscode from 'vscode';
import * as nodePath from 'node:path';

import type { SessionManager } from '../core/SessionManager';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import type { TurnRouter, ActiveTurn } from './TurnRouter';
import type { ChangeTracker } from '../changes/ChangeTracker';
import { BaselineContentProvider } from '../changes/ChangesView';
import { countLineChanges } from '../changes/diffUtil';
import { hasNativeEdits, pushDiffs, pushThinking, pushToolCall, trackExternalEdit } from './proposed';
import { log, logError } from '../utils/Logger';

import type {
  SessionNotification, SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind,
} from '@agentclientprotocol/sdk';

export const PARTICIPANT_ID = 'acp.agent';

const EDIT_KINDS = new Set<ToolKind>(['edit', 'delete', 'move']);

/** The fields shared by `tool_call` and `tool_call_update` that edit tracking needs. */
interface ToolCallInfo {
  toolCallId: string;
  kind?: ToolKind | null;
  status?: string | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
}

/** Per-turn bookkeeping shared by the update renderer. */
interface TurnState {
  turn: ActiveTurn;
  sessionId: string;
  /** Resolvers that end an externalEdit callback, per tool call. */
  externals: Map<string, () => void>;
  /** Per tool call: whether the session accepted externalEdit (native Keep/Undo). */
  externalResults: Map<string, Promise<boolean>>;
  kinds: Map<string, ToolKind>;
  /** Files each edit tool call touches; snapshotted before and compared after. */
  editPaths: Map<string, Set<string>>;
  work: Promise<unknown>[];
  thoughtN: number;
}

export interface ChatParticipantHandle {
  handler: vscode.ChatRequestHandler;
  /** Number of chat requests handled; read by UI tests. */
  requestCount(): number;
}

/**
 * Chat participant that drives the active ACP session from VS Code's native
 * Chat view.
 *
 * File edits: where the chat session supports native edits, they are tracked
 * by VS Code ("files changed" bar, inline Keep/Undo). Otherwise each edited
 * file is snapshotted before the agent edits it and compared afterwards, and
 * the response shows a diff card with Keep/Undo backed by ChangeTracker.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
  sessionUpdateHandler: SessionUpdateHandler,
  router: TurnRouter,
  tracker: ChangeTracker,
): ChatParticipantHandle {
  let requestCount = 0;

  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const sessionId = sessionManager.getActiveSessionId();
    if (!sessionId) {
      stream.markdown('No ACP agent is connected.\n\n');
      stream.button({ title: 'Connect to Agent', command: 'acp.connectAgent' });
      return {};
    }

    requestCount++;
    const sessionResource = (request as { sessionResource?: vscode.Uri }).sessionResource;
    const turn = router.begin(sessionId, stream, token, request.toolInvocationToken, sessionResource);
    log(`chat request: sessionResource=${sessionResource?.toString() ?? 'n/a'} native=${turn.native}`);

    const state: TurnState = {
      turn, sessionId,
      externals: new Map(), externalResults: new Map(), kinds: new Map(), editPaths: new Map(), work: [], thoughtN: 0,
    };

    const listener = (n: SessionNotification) => {
      if (n.sessionId !== sessionId) { return; }
      try {
        renderUpdate(n.update, state, router, tracker);
      } catch (e) {
        logError('chat participant: render failed', e);
      }
    };
    sessionUpdateHandler.addListener(listener);
    const cancelSub = token.onCancellationRequested(() => {
      void sessionManager.cancelTurn(sessionId).catch(e => logError('cancel failed', e));
      router.cancelPermissions(sessionId);
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
      for (const id of [...state.editPaths.keys()]) { finishToolEdits(id, state, tracker); }
      // externalEdit must settle before the response completes
      await Promise.allSettled([...state.work, ...state.externalResults.values()]);
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
  return { handler, requestCount: () => requestCount };
}

function renderUpdate(u: SessionUpdate, st: TurnState, router: TurnRouter, tracker: ChangeTracker): void {
  const { stream } = st.turn;
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      if (u.content.type === 'text') { stream.markdown(u.content.text); }
      break;
    case 'agent_thought_chunk':
      if (u.content.type === 'text') { pushThinking(stream, `thought-${++st.thoughtN}`, u.content.text); }
      break;
    case 'tool_call':
    case 'tool_call_update': {
      const isUpdate = u.sessionUpdate === 'tool_call_update';
      const status = u.status ?? (isUpdate ? 'in_progress' : 'pending');
      pushToolCall(stream, { toolCallId: u.toolCallId, title: u.title ?? 'Tool call', status }, isUpdate);
      if (u.kind) { st.kinds.set(u.toolCallId, u.kind); }
      // Paths often arrive only in later updates (Claude sends empty locations first)
      const tool: ToolCallInfo = { ...u, kind: u.kind ?? st.kinds.get(u.toolCallId) };
      trackToolEdits(tool, st, router, tracker);
      if (status === 'completed' || status === 'failed') {
        st.externals.get(u.toolCallId)?.();
        st.externals.delete(u.toolCallId);
        finishToolEdits(u.toolCallId, st, tracker);
      }
      break;
    }
    case 'plan': {
      const lines = u.entries.map(e => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`);
      if (lines.length) { stream.markdown(`\n\n${lines.join('\n')}\n\n`); }
      break;
    }
  }
}

function editPathsOf(tool: ToolCallInfo): string[] {
  const paths = new Set<string>();
  for (const c of tool.content ?? []) { if (c.type === 'diff') { paths.add(c.path); } }
  for (const l of tool.locations ?? []) { paths.add(l.path); }
  return [...paths].map(p => vscode.Uri.file(p).fsPath);
}

/**
 * While an edit tool call is pending/in progress: snapshot each newly known
 * file (before the agent writes it) and, for native sessions, wrap the call in
 * externalEdit so VS Code tracks the disk change with native Keep/Undo.
 */
function trackToolEdits(tool: ToolCallInfo, st: TurnState, router: TurnRouter, tracker: ChangeTracker): void {
  if (!tool.kind || !EDIT_KINDS.has(tool.kind) || tool.status === 'completed' || tool.status === 'failed') { return; }
  const paths = editPathsOf(tool);
  if (!paths.length) { return; }

  const known = st.editPaths.get(tool.toolCallId) ?? new Set<string>();
  const fresh = paths.filter(p => !known.has(p));
  for (const p of fresh) {
    known.add(p);
    st.work.push(tracker.captureBaseline(p).catch(e => logError('captureBaseline failed', e)));
  }
  st.editPaths.set(tool.toolCallId, known);
  if (fresh.length) { log(`edit ${tool.toolCallId}: snapshot ${fresh.join(', ')}`); }

  // Agents writing through fs/write_text_file get precise textEdits instead
  const { turn } = st;
  if (!turn.native || st.externals.has(tool.toolCallId) || router.usesClientFs(st.sessionId) || !hasNativeEdits(turn.stream)) {
    return;
  }
  paths.forEach(p => turn.externalPaths.add(p));
  const done = new Promise<void>(resolve => st.externals.set(tool.toolCallId, resolve));
  const result = trackExternalEdit(turn.stream, paths.map(p => vscode.Uri.file(p)), () => done);
  if (result) {
    st.externalResults.set(tool.toolCallId, result);
  } else {
    st.externals.delete(tool.toolCallId);
  }
}

/**
 * After an edit tool call ends: if VS Code tracked it natively, its own
 * "files changed" UI owns Keep/Undo, so drop our snapshot. Otherwise show the
 * fallback diff card.
 */
function finishToolEdits(toolCallId: string, st: TurnState, tracker: ChangeTracker): void {
  const paths = st.editPaths.get(toolCallId);
  if (!paths?.size) { return; }
  st.editPaths.delete(toolCallId);
  st.work.push((async () => {
    if (await st.externalResults.get(toolCallId)) {
      await Promise.all([...paths].map(p => tracker.keep(p)));
    } else {
      await reportEdits([...paths], st.turn.stream, tracker);
    }
  })().catch(e => logError('finishToolEdits failed', e)));
}

/** Compare against baseline, then show the diff and Keep/Undo in the response. */
async function reportEdits(paths: string[], stream: vscode.ChatResponseStream, tracker: ChangeTracker): Promise<void> {
  const pending = await Promise.all(paths.map(p => tracker.noteAgentResult(p)));
  const changed = paths.filter((_, i) => pending[i]);
  log(`edit result: ${changed.length ? changed.join(', ') : 'no changes'}`);

  const entries = changed.flatMap(p => {
    const entry = tracker.get(p);
    if (!entry) { return []; }
    return [{
      originalUri: entry.baseline === null ? undefined : BaselineContentProvider.uriFor(p, entry.version),
      modifiedUri: vscode.Uri.file(p),
      ...countLineChanges(entry.baseline ?? '', entry.agentText),
    }];
  });
  if (!entries.length) { return; }

  pushDiffs(stream, 'Agent changes', entries);
  for (const p of changed) {
    const name = nodePath.basename(p);
    stream.button({ title: `Keep ${name}`, command: 'acp.changes.keep', arguments: [{ path: p }] });
    stream.button({ title: `Undo ${name}`, command: 'acp.changes.undo', arguments: [{ path: p }] });
    stream.button({ title: 'Open diff', command: 'acp.changes.openDiff', arguments: [{ path: p }] });
  }
}
