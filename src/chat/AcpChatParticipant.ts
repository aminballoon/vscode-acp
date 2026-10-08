import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { SessionManager } from '../core/SessionManager';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import type { TurnRouter, ActiveTurn } from './TurnRouter';
import type { ChangeTracker } from '../changes/ChangeTracker';
import { BaselineContentProvider } from '../changes/ChangesView';
import { contentBeforeDiffs, countLineChanges } from '../changes/diffUtil';
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
  /** Per tool call: settles when the call ends, which ends its externalEdit callbacks. */
  externals: Map<string, { ended: Promise<void>; end: () => void }>;
  /**
   * Per tool call: the files each externalEdit covers, whether the session
   * accepted it (native Keep/Undo) and their content when VS Code snapshotted them.
   */
  externalResults: Map<string, Array<{ paths: string[]; accepted: Promise<boolean>; atStart: Map<string, string | null> }>>;
  kinds: Map<string, ToolKind>;
  /** Files each edit tool call touches; snapshotted before and compared after. */
  editPaths: Map<string, Set<string>>;
  /**
   * Edit tool calls that were already running when first reported: the agent
   * writes without waiting for the client (Codex), so VS Code cannot look at
   * the files first. Their files are shown at the end of the turn, from their
   * pre-turn content.
   */
  writesFirst: Set<string>;
  /** Every file an edit tool call reported this turn (already shown, natively or as a card). */
  reportedPaths: Set<string>;
  /** Latest diff blocks of each edit tool call that did not fail, in the order the calls started. */
  diffs: Map<string, ToolCallContent[]>;
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
  /** Number of chat requests finished, edits reported included; read by UI tests. */
  requestsDone(): number;
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
  let requestCount = 0, requestsDone = 0;
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
      externals: new Map(), externalResults: new Map(), kinds: new Map(), editPaths: new Map(), reportedPaths: new Set(), diffs: new Map(), writesFirst: new Set(), savedByUser: new Set(), work: [], thoughtN: 0,
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
      for (const external of state.externals.values()) { external.end(); }
      // Report edits of tool calls that never reached completed/failed
      for (const id of [...state.editPaths.keys()]) { finishToolEdits(id, state, tracker); }
      // externalEdit must settle before the response completes
      await Promise.allSettled([...state.work, ...[...state.externalResults.values()].flat().map(b => b.accepted)]);
      savedSub.dispose();
      await reportUntrackedEdits(snapshot, state, tracker).catch(e => logError('workspace diff failed', e));
      sessionUpdateHandler.removeListener(listener);
      cancelSub.dispose();
      router.end(sessionId);
      requestsDone++;
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
  return { handler, runTurn, requestCount: () => requestCount, requestsDone: () => requestsDone };
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
      if (!isUpdate && status !== 'pending') { st.writesFirst.add(u.toolCallId); }
      if (u.content?.some(c => c.type === 'diff')) { st.diffs.set(u.toolCallId, u.content); }
      // Paths often arrive only in later updates (Claude sends empty locations first)
      const tool: ToolCallInfo = { ...u, kind: u.kind ?? st.kinds.get(u.toolCallId) };
      trackToolEdits(tool, st, router, tracker);
      if (status === 'completed' || status === 'failed') {
        st.externals.get(u.toolCallId)?.end();
        st.externals.delete(u.toolCallId);
        if (status === 'failed') { st.diffs.delete(u.toolCallId); }
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
  if (!tool.kind || !EDIT_KINDS.has(tool.kind)) { return; }
  const paths = editPathsOf(tool);
  if (!paths.length) { return; }

  // Tracking a file after the agent wrote it would show no change: VS Code
  // diffs from a file's content when it first tracks it
  if (st.writesFirst.has(tool.toolCallId) || tool.status === 'completed' || tool.status === 'failed') { return; }
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
  if (!fresh.length || !turn.native || router.usesClientFs(st.sessionId) || !hasNativeEdits(turn.stream)) {
    return;
  }
  // One patch can name more files in later updates (codex-acp's PatchApplyUpdated):
  // each batch gets its own externalEdit, all ending with the tool call
  let external = st.externals.get(tool.toolCallId);
  if (!external) {
    let end = () => {};
    const ended = new Promise<void>(resolve => { end = resolve; });
    external = { ended, end };
    st.externals.set(tool.toolCallId, external);
  }
  const { ended } = external;
  fresh.forEach(p => turn.externalPaths.add(p));
  const atStart = new Map<string, string | null>();
  const accepted = trackExternalEdit(turn.stream, fresh.map(p => vscode.Uri.file(p)), async () => {
    // VS Code snapshots the files before calling back, so this is what it compares against.
    // Agents that write without waiting (Codex) may already have written some of them.
    await Promise.all(fresh.map(async p => { atStart.set(p, await readDisk(p)); }));
    await ended;
  });
  if (accepted) {
    st.externalResults.set(tool.toolCallId, [...st.externalResults.get(tool.toolCallId) ?? [], { paths: fresh, accepted, atStart }]);
  }
}

/**
 * After an edit tool call ends: files VS Code tracked natively get Keep/Undo
 * from its own "files changed" UI, so drop our snapshot. The rest get the
 * fallback diff card.
 */
function finishToolEdits(toolCallId: string, st: TurnState, tracker: ChangeTracker): void {
  const paths = st.editPaths.get(toolCallId);
  if (!paths?.size) { return; }
  st.editPaths.delete(toolCallId);
  st.work.push((async () => {
    const batches = await Promise.all((st.externalResults.get(toolCallId) ?? []).map(async b => await b.accepted ? [b] : []));
    const native = new Set(batches.flat().flatMap(b => b.paths));
    // A file only counts as shown if it changed after VS Code's snapshot. Agents
    // that write while reporting an edit may leave it unchanged here; the end
    // of the turn then shows it from its pre-turn content.
    for (const b of batches.flat()) {
      for (const p of b.paths) {
        if (b.atStart.has(p) && await readDisk(p) !== b.atStart.get(p)) { st.reportedPaths.add(p); }
      }
    }
    await Promise.all([...native].map(p => tracker.keep(p)));
    const rest = [...paths].filter(p => !native.has(p));
    if (rest.length) {
      (await reportEdits(rest, st.turn.stream, tracker)).forEach(p => st.reportedPaths.add(p));
    }
  })().catch(e => logError('finishToolEdits failed', e)));
}

/**
 * Content before the turn of the files edit tool calls changed, rebuilt from
 * their diffs: undo each call's diffs, last call first, starting from what is
 * on disk now. Files whose diffs do not match are left out.
 */
async function preTurnFromDiffs(st: TurnState): Promise<Map<string, string | null>> {
  const lastFirst = [...st.diffs.values()].reverse().map(content => content.flatMap(c => c.type === 'diff' ? [c] : []));
  const paths = new Set(lastFirst.flat().map(d => vscode.Uri.file(d.path).fsPath));
  const result = new Map<string, string | null>();
  for (const path of paths) {
    let content: string | null | undefined = await readDisk(path);
    for (const diffs of lastFirst) {
      const own = diffs.filter(d => vscode.Uri.file(d.path).fsPath === path);
      if (own.length && content !== undefined) { content = contentBeforeDiffs(own, content); }
    }
    if (content !== undefined) { result.set(path, content); }
  }
  return result;
}

/** Show files the turn changed that are not shown yet. */
async function reportUntrackedEdits(snapshot: WorkspaceSnapshot | undefined, st: TurnState, tracker: ChangeTracker): Promise<void> {
  const { turn } = st;
  // Files wrapped in externalEdit are judged by reportedPaths: a late snapshot shows nothing
  const skip = (p: string) => st.reportedPaths.has(p) || turn.written.has(p) || st.savedByUser.has(p);
  const snapshotChanges = await snapshot?.changes().catch(e => { logError('workspace diff failed', e); return []; });
  const fromSnapshot = (snapshotChanges ?? []).map(c => ({ ...c, path: vscode.Uri.file(c.path).fsPath }));
  // The workspace snapshot has the real pre-turn content; edit tool diffs cover
  // the files it misses (no snapshot: workspace too large, not readable, ...)
  const found = new Set(fromSnapshot.map(c => c.path));
  const fromDiffs = await Promise.all([...await preTurnFromDiffs(st)].filter(([p]) => !found.has(p))
    .map(async ([path, before]) => ({ path, before, after: await readDisk(path) })));
  const changes = [...fromSnapshot, ...fromDiffs.filter(c => c.after !== c.before)].filter(c => !skip(c.path));
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
 * their earlier content back for a moment and redo the agent's write inside
 * externalEdit. Deletions (VS Code would write a deleted file back) and files
 * with unsaved editor changes are left to the diff card. Returns the paths
 * that are now tracked natively.
 */
async function replayAsExternalEdit(changes: TurnFileChange[], turn: ActiveTurn): Promise<Set<string>> {
  // Never overwrite what the agent may have written since (it can still be running)
  const eligible = (await Promise.all(changes.map(async c =>
    c.after !== null && !findOpenDocument(c.path)?.isDirty && await readDisk(c.path) === c.after ? [c] : []))).flat();
  if (!eligible.length) { return new Set(); }
  const uris = eligible.map(c => vscode.Uri.file(c.path));
  const writeAfter = () => Promise.all(eligible.map(async (c, i) => {
    if (await readDisk(c.path) === c.before) { await vscode.workspace.fs.writeFile(uris[i], Buffer.from(c.after!, 'utf8')); }
  }));
  try {
    await Promise.all(eligible.map((c, i) => c.before === null
      ? vscode.workspace.fs.delete(uris[i])
      : vscode.workspace.fs.writeFile(uris[i], Buffer.from(c.before, 'utf8'))));
    // Open editors must show the pre-turn content before VS Code snapshots it
    await Promise.all(eligible.map(c => documentShows(c.path, c.before ?? '')));
    const result = trackExternalEdit(turn.stream, uris, writeAfter);
    if (result && await result) { return new Set(eligible.map(c => c.path)); }
  } catch (e) {
    logError('replaying edits as external edit failed', e);
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
