import * as vscode from 'vscode';
import { diffLines } from 'diff';
import type { RequestPermissionRequest, WriteTextFileRequest } from '@agentclientprotocol/sdk';

import { createFile, hasNativeEdits, pushTextEdits } from './proposed';
import { log } from '../utils/Logger';
import type { ChangeTracker } from '../changes/ChangeTracker';
import { PERMISSION_TOOL, PermissionTool, PermissionInput } from './PermissionTool';

export interface ActiveTurn {
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  /** Lets permission prompts render as native tool confirmations in this turn. */
  toolToken?: vscode.ChatParticipantToolToken;
  /** Whether this turn's chat session accepts native edits (textEdit/externalEdit). */
  native: boolean;
  /** Paths covered by an open externalEdit(); writes there go straight to disk. */
  externalPaths: Set<string>;
  /** Last content written per path via textEdit, served to readTextFile until the turn ends. */
  written: Map<string, string>;
  pendingPermissions: Map<string, (optionId: string) => void>;
}

/**
 * Maps ACP session ids to the chat turn currently streaming, so client-side
 * handlers (fs, permission) can reach the response stream of the active turn.
 */
export class TurnRouter {
  private turns = new Map<string, ActiveTurn>();

  constructor(
    private readonly tracker?: ChangeTracker,
    private readonly permissionTool?: PermissionTool,
  ) {}

  /**
   * Native chat edits (textEdit/externalEdit) are rejected by some session
   * types (e.g. agent host sessions in VS Code 1.140), so they are opt-in.
   */
  get nativeEnabled(): boolean {
    return vscode.workspace.getConfiguration('acp').get<boolean>('chat.nativeEdits', true);
  }
  private permCounter = 0;
  /** Sessions whose agent writes files through the client (fs/write_text_file). */
  private clientFsSessions = new Set<string>();

  usesClientFs(sessionId: string): boolean {
    return this.clientFsSessions.has(sessionId);
  }

  begin(
    sessionId: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    toolToken?: vscode.ChatParticipantToolToken,
    native = false,
  ): ActiveTurn {
    const turn: ActiveTurn = {
      stream, token, toolToken, native,
      externalPaths: new Set(),
      written: new Map(),
      pendingPermissions: new Map(),
    };
    this.turns.set(sessionId, turn);
    return turn;
  }

  end(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) { return; }
    for (const resolve of [...turn.pendingPermissions.values()]) { resolve('cancelled'); }
    this.turns.delete(sessionId);
  }

  get(sessionId: string): ActiveTurn | undefined {
    return this.turns.get(sessionId);
  }

  /** Content the agent wrote this turn that the editor buffer may not reflect yet. */
  recentlyWritten(sessionId: string, path: string): string | undefined {
    return this.turns.get(sessionId)?.written.get(path);
  }

  /**
   * Route an agent file write into the chat's native edit UI (per-hunk Keep/Undo).
   * Returns false when there is no active turn or the API is unavailable.
   */
  async nativeWrite(params: WriteTextFileRequest): Promise<boolean> {
    this.clientFsSessions.add(params.sessionId);
    const turn = this.turns.get(params.sessionId);
    if (!turn || !turn.native || !hasNativeEdits(turn.stream)) { return false; }
    const uri = vscode.Uri.file(params.path);
    if (turn.externalPaths.has(uri.fsPath)) { return false; }

    let oldText = '';
    let exists = true;
    try {
      oldText = (await vscode.workspace.openTextDocument(uri)).getText();
    } catch {
      exists = false;
    }
    if (!exists) { createFile(turn.stream, uri); }

    pushTextEdits(turn.stream, uri, minimalEdits(oldText, params.content));
    turn.written.set(uri.fsPath, params.content);
    log(`nativeWrite: ${params.path} (${exists ? 'edit' : 'new'})`);
    return true;
  }

  /** Ask for permission using buttons in the response. Returns undefined when no turn is active. */
  requestPermission(params: RequestPermissionRequest): Promise<string> | undefined {
    const turn = this.turns.get(params.sessionId);
    if (!turn) { return undefined; }
    // Snapshot files the agent is about to edit, before the user approves
    for (const l of params.toolCall?.locations ?? []) {
      void this.tracker?.captureBaseline(vscode.Uri.file(l.path).fsPath);
    }
    if (turn.toolToken && this.permissionTool) {
      return this.confirmWithTool(turn, params);
    }
    const id = `perm-${++this.permCounter}`;
    turn.stream.markdown(`\n\n**${params.toolCall?.title || 'Permission request'}**\n\n`);
    for (const o of params.options) {
      turn.stream.button({
        title: o.name,
        command: 'acp.permission.answer',
        arguments: [id, o.optionId],
      });
    }
    return new Promise<string>(resolve => {
      turn.pendingPermissions.set(id, optionId => {
        turn.pendingPermissions.delete(id);
        resolve(optionId);
      });
    });
  }

  /**
   * Native confirmation (Allow / Skip). VS Code's own "allow for session /
   * always" choices auto-approve later calls, so approval maps to allow_once.
   */
  private async confirmWithTool(turn: ActiveTurn, params: RequestPermissionRequest): Promise<string> {
    const allow = params.options.find(o => o.kind === 'allow_once') ?? params.options.find(o => o.kind.startsWith('allow'));
    const reject = params.options.find(o => o.kind === 'reject_once') ?? params.options.find(o => o.kind.startsWith('reject'));
    const title = params.toolCall?.title || 'Allow agent action?';
    const tc: any = params.toolCall ?? {};
    const files = (tc.locations ?? []).map((l: any) => vscode.workspace.asRelativePath(l.path));
    const input: PermissionInput = { action: title };
    if (files.length) { input.files = files; }
    if (typeof tc.rawInput?.command === 'string') { input.command = tc.rawInput.command; }
    const id = this.permissionTool!.register(input, describeToolCall(params));
    try {
      await vscode.lm.invokeTool(PERMISSION_TOOL, { input: id, toolInvocationToken: turn.toolToken }, turn.token);
      log(`permission: allowed via native confirmation (${title})`);
      return allow?.optionId ?? 'cancelled';
    } catch (e: any) {
      log(`permission: not allowed (${title}): ${e?.name ?? ''} ${e?.message ?? e}`);
      if (turn.token.isCancellationRequested) { return 'cancelled'; }
      return reject?.optionId ?? 'cancelled';
    } finally {
      this.permissionTool!.release(id);
    }
  }

  answerPermission(permId: string, optionId: string): void {
    for (const turn of this.turns.values()) {
      const resolve = turn.pendingPermissions.get(permId);
      if (resolve) { resolve(optionId); return; }
    }
  }
}

/** Markdown body for a permission confirmation: target files and diff preview. */
function describeToolCall(params: RequestPermissionRequest): string {
  const lines: string[] = [];
  const tc: any = params.toolCall ?? {};
  for (const c of tc.content ?? []) {
    if (c?.type === 'diff' && typeof c.newText === 'string') {
      const body: string[] = [];
      for (const part of diffLines(c.oldText ?? '', c.newText)) {
        if (!part.added && !part.removed) { continue; }
        const sign = part.added ? '+' : '-';
        for (const l of part.value.replace(/\n$/, '').split('\n')) { body.push(sign + l); }
      }
      lines.push('```diff\n' + body.slice(0, 60).join('\n') + '\n```');
    } else if (c?.type === 'content' && c.content?.type === 'text') {
      lines.push(c.content.text);
    }
  }
  if (!lines.length) {
    for (const l of tc.locations ?? []) { lines.push(`\`${l.path}\``); }
  }
  if (!lines.length && tc.rawInput?.command) {
    lines.push('```sh\n' + String(tc.rawInput.command) + '\n```');
  }
  return lines.join('\n\n') || 'The agent wants to run this action.';
}

/** Line-level edits so unchanged regions don't show up as one giant hunk. */
function minimalEdits(oldText: string, newText: string): vscode.TextEdit[] {
  const edits: vscode.TextEdit[] = [];
  let line = 0;
  const parts = diffLines(oldText, newText);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const count = p.count ?? 0;
    if (p.removed) {
      const next = parts[i + 1];
      const range = new vscode.Range(line, 0, line + count, 0);
      if (next?.added) {
        edits.push(vscode.TextEdit.replace(range, next.value));
        i++;
      } else {
        edits.push(vscode.TextEdit.delete(range));
      }
      line += count;
    } else if (p.added) {
      edits.push(vscode.TextEdit.insert(new vscode.Position(line, 0), p.value));
    } else {
      line += count;
    }
  }
  return edits;
}
