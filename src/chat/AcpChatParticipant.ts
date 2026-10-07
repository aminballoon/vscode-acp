import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { SessionManager } from '../core/SessionManager';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import type { TurnRouter, ActiveTurn } from './TurnRouter';
import type { ChangeTracker } from '../changes/ChangeTracker';
import { BaselineContentProvider } from '../changes/ChangesView';
import { countLineChanges } from '../changes/diffUtil';
import { TurnFileChange, WorkspaceSnapshot, WorkspaceSnapshots } from '../changes/WorkspaceSnapshot';
import { PickedSkill, promptWithSkills, SkillInstructions, SkillSelection } from './SkillSelection';
import { readSkillBody } from './SkillLibrary';
import { hasNativeEdits, pushDiffs, pushThinking, pushToolCall, trackExternalEdit } from './proposed';
import { TurnActivity } from './TurnActivity';
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
  /** Every file an edit tool call reported this turn (already shown, natively or as a card). */
  reportedPaths: Set<string>;
  /** Files saved in the editor during the turn. */
  savedByUser: Set<string>;
  work: Promise<unknown>[];
  thoughtN: number;
  /** Elapsed time on running tool calls and agent silences. */
  activity: TurnActivity;
}

/** Run a chat request against a given ACP session. */
export type ChatTurnRunner = (
  sessionId: string | null,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) => Promise<vscode.ChatResult>;

export interface ChatParticipantHandle {
  /** Run a request against a specific session (ACP chat sessions bind one per chat). */
  runTurn: ChatTurnRunner;
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
  skills: SkillSelection,
): ChatParticipantHandle {
  let requestCount = 0;
  const snapshots = new WorkspaceSnapshots(context.globalStorageUri.fsPath);

  const handler: vscode.ChatRequestHandler = (request, _ctx, stream, token) =>
    runTurn(sessionManager.getActiveSessionId(), request, stream, token);

  const runTurn: ChatTurnRunner = async (sessionId, request, stream, token) => {
    if (!sessionId) {
      stream.markdown('No ACP agent is connected.\n\n');
      stream.button({ title: 'Connect to Agent', command: 'acp.connectAgent' });
      return {};
    }

    requestCount++;
    const sessionResource = (request as { sessionResource?: vscode.Uri }).sessionResource;
    const turn = router.begin(sessionId, stream, token, request.toolInvocationToken, sessionResource);
    log(`chat request: sessionResource=${sessionResource?.toString() ?? 'n/a'} native=${turn.native}`);

    const session = sessionManager.getSession(sessionId);
    const state: TurnState = {
      turn, sessionId,
      externals: new Map(), externalResults: new Map(), kinds: new Map(), editPaths: new Map(), reportedPaths: new Set(), savedByUser: new Set(), work: [], thoughtN: 0,
      activity: new TurnActivity(session?.agentDisplayName || session?.agentName || 'agent', (tool, isUpdate) => pushToolCall(stream, tool, isUpdate)),
    };

    const listener = (n: SessionNotification) => {
      if (n.sessionId !== sessionId) { return; }
      try {
        state.activity.touch();
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

    // Edits made outside edit tool calls (shell commands, the agent's own patch
    // tooling) are found by comparing the git working tree after the turn
    const cwd = session?.cwd;
    const snapshot = cwd ? await snapshots.take(cwd) : undefined;
    // Files saved in the editor meanwhile were changed by the user, not the agent
    const savedSub = vscode.workspace.onDidSaveTextDocument(d => state.savedByUser.add(d.uri.fsPath));

    try {
      // Slash commands picked in the chat input go to the agent as typed (`/compact ...`),
      // together with the skills picked in the toolbar for this prompt
      const picked = session?.agentName ? skills.take(session.agentName) : [];
      const commands = [
        ...(request.command ? [request.command] : []),
        ...picked.filter(s => !s.path && s.name !== request.command).map(s => s.name),
      ];
      const instructions = await readInstructions(picked, stream);
      // The skill instructions stay out of the session title
      sessionManager.recordFirstPrompt(sessionId, promptWithSkills(request.prompt, commands));
      const res = await sessionManager.sendPrompt(sessionId, promptWithSkills(request.prompt, commands, instructions));
      sessionManager.touchHistory(sessionId);
      if (res.stopReason === 'refusal') { stream.markdown('\n\n_The agent refused this request._'); }
    } catch (e: any) {
      logError('chat participant: prompt failed', e);
      stream.markdown(`\n\n**Error:** ${e?.message ?? e}`);
    } finally {
      state.activity.dispose();
      for (const done of state.externals.values()) { done(); }
      // Report edits of tool calls that never reached completed/failed
      for (const id of [...state.editPaths.keys()]) { finishToolEdits(id, state, tracker); }
      // externalEdit must settle before the response completes
      await Promise.allSettled([...state.work, ...state.externalResults.values()]);
      savedSub.dispose();
      if (snapshot) {
        await reportUntrackedEdits(snapshot, state, tracker).catch(e => logError('workspace diff failed', e));
      }
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
  return { handler, runTurn, requestCount: () => requestCount };
}

/** Instructions of the picked markdown skills; a missing file is reported and skipped. */
async function readInstructions(picked: PickedSkill[], stream: vscode.ChatResponseStream): Promise<SkillInstructions[]> {
  const read = await Promise.all(picked.filter(s => s.path).map(skill => readSkillBody(skill.path!).then(
    body => ({ name: skill.name, body }),
    e => {
      logError(`skill ${skill.path} could not be read`, e);
      stream.markdown(`_Skill **${skill.name}** was skipped: ${skill.path} could not be read._\n\n`);
      return undefined;
    },
  )));
  return read.filter(s => s !== undefined);
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
      st.activity.tool(u.toolCallId, u.title, status, isUpdate);
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
    // A file only counts as shown if it changed after our snapshot. Agents that
    // report an edit after writing it (e.g. Codex) leave it unchanged here; the
    // end-of-turn workspace comparison then shows it from the real pre-turn content.
    if (await st.externalResults.get(toolCallId)) {
      for (const p of paths) {
        const entry = tracker.get(p);
        if (entry && await readDisk(p) !== entry.baseline) { st.reportedPaths.add(p); }
      }
      await Promise.all([...paths].map(p => tracker.keep(p)));
    } else {
      (await reportEdits([...paths], st.turn.stream, tracker)).forEach(p => st.reportedPaths.add(p));
    }
  })().catch(e => logError('finishToolEdits failed', e)));
}

/** Show files the turn changed that no edit tool call reported. */
async function reportUntrackedEdits(snapshot: WorkspaceSnapshot, st: TurnState, tracker: ChangeTracker): Promise<void> {
  const { turn } = st;
  // Files wrapped in externalEdit are judged by reportedPaths: a late snapshot shows nothing
  const skip = (p: string) => st.reportedPaths.has(p) || turn.written.has(p) || st.savedByUser.has(p);
  const changes = (await snapshot.changes())
    .map(c => ({ ...c, path: vscode.Uri.file(c.path).fsPath }))
    .filter(c => !skip(c.path));
  if (!changes.length) { return; }
  log(`workspace diff: ${changes.map(c => c.path).join(', ')}`);

  // Native "files changed" (per-hunk Keep/Undo) where the chat session supports it
  const native = turn.native && hasNativeEdits(turn.stream) ? await replayAsExternalEdit(changes, turn) : new Set<string>();
  const rest = changes.filter(c => !native.has(c.path));
  if (!rest.length) { return; }
  await Promise.all(rest.map(c => tracker.noteTurnChange(c.path, c.before)));
  await reportEdits(rest.map(c => c.path), turn.stream, tracker);
}

/**
 * VS Code tracks an external edit by snapshotting files when it starts and
 * reading them back when it ends. The agent already wrote these files, so put
 * the pre-turn content back for a moment and redo the agent's write inside
 * externalEdit. Deletions and files with unsaved editor changes are left to
 * the diff card. Returns the paths that are now tracked natively.
 */
async function replayAsExternalEdit(changes: TurnFileChange[], turn: ActiveTurn): Promise<Set<string>> {
  const eligible = changes.filter(c => c.after !== null && !findOpenDocument(c.path)?.isDirty);
  if (!eligible.length) { return new Set(); }
  const uris = eligible.map(c => vscode.Uri.file(c.path));
  const writeAfter = () => Promise.all(eligible.map((c, i) => vscode.workspace.fs.writeFile(uris[i], Buffer.from(c.after!, 'utf8'))));
  try {
    await Promise.all(eligible.map((c, i) => c.before === null
      ? vscode.workspace.fs.delete(uris[i])
      : vscode.workspace.fs.writeFile(uris[i], Buffer.from(c.before, 'utf8'))));
    // Open editors must show the pre-turn content before VS Code snapshots it
    await Promise.all(eligible.map(c => documentShows(c.path, c.before ?? '')));
    const result = trackExternalEdit(turn.stream, uris, writeAfter);
    if (result && await result) { return new Set(eligible.map(c => c.path)); }
  } catch (e) {
    logError('replaying shell edits as external edit failed', e);
  }
  // Whatever happened, leave the agent's result on disk
  await writeAfter().catch(e => logError('restoring agent result failed', e));
  return new Set();
}

function findOpenDocument(path: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === path);
}

/** Resolve once the open editor buffer (if any) has reloaded to `text`, or after a timeout. */
function documentShows(path: string, text: string, timeoutMs = 3000): Promise<void> {
  const doc = findOpenDocument(path);
  if (!doc || doc.getText() === text) { return Promise.resolve(); }
  return new Promise(resolve => {
    const done = () => { sub.dispose(); clearTimeout(timer); resolve(); };
    const sub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.fsPath === path && e.document.getText() === text) { done(); }
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

/** Compare against baseline, then show the diff and Keep/Undo in the response. */
async function readDisk(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Returns the paths shown (those that changed). */
async function reportEdits(paths: string[], stream: vscode.ChatResponseStream, tracker: ChangeTracker): Promise<string[]> {
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
  if (!entries.length) { return []; }

  pushDiffs(stream, 'Agent changes', entries);
  for (const p of changed) {
    const name = nodePath.basename(p);
    stream.button({ title: `Keep ${name}`, command: 'acp.changes.keep', arguments: [{ path: p }] });
    stream.button({ title: `Undo ${name}`, command: 'acp.changes.undo', arguments: [{ path: p }] });
    stream.button({ title: 'Open diff', command: 'acp.changes.openDiff', arguments: [{ path: p }] });
  }
  return changed;
}
