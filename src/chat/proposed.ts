import * as vscode from 'vscode';
import { log } from '../utils/Logger';

/**
 * Every call into VS Code's proposed chat API lives in this file, so an API
 * change in a future VS Code release only needs fixing here. Each helper
 * feature-detects and falls back to stable parts.
 */

type ProposedStream = vscode.ChatResponseStream & Partial<{
  textEdit(target: vscode.Uri, edits: vscode.TextEdit | vscode.TextEdit[] | true): void;
  workspaceEdit(edits: Array<{ oldResource?: vscode.Uri; newResource?: vscode.Uri }>): void;
  externalEdit(target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>): Thenable<string>;
  thinkingProgress(delta: { id: string; text?: string | string[] }): void;
}>;

export function hasNativeEdits(stream: vscode.ChatResponseStream): boolean {
  const s = stream as ProposedStream;
  return typeof s.textEdit === 'function' && typeof s.workspaceEdit === 'function';
}

export function createFile(stream: vscode.ChatResponseStream, uri: vscode.Uri): void {
  (stream as ProposedStream).workspaceEdit!([{ newResource: uri }]);
}

export function pushTextEdits(stream: vscode.ChatResponseStream, uri: vscode.Uri, edits: vscode.TextEdit[]): void {
  const s = stream as ProposedStream;
  if (edits.length) { s.textEdit!(uri, edits); }
  s.textEdit!(uri, true);
}

/**
 * Track edits made within `callback` as agent edits (native Keep/Undo).
 * Returns undefined when the API is unavailable; otherwise a promise that
 * settles to whether the chat session accepted the external edit (some
 * session types, e.g. agent host sessions, reject it).
 */
export function trackExternalEdit(
  stream: vscode.ChatResponseStream,
  uris: vscode.Uri[],
  callback: () => Thenable<unknown>,
): Promise<boolean> | undefined {
  const s = stream as ProposedStream;
  if (typeof s.externalEdit !== 'function') { return undefined; }
  return Promise.resolve(s.externalEdit(uris, callback)).then(
    () => { log('externalEdit ok'); return true; },
    e => { log(`externalEdit rejected: ${e?.message ?? e}`); return false; },
  );
}

export function pushThinking(stream: vscode.ChatResponseStream, id: string, text: string): void {
  const s = stream as ProposedStream;
  if (typeof s.thinkingProgress === 'function') {
    s.thinkingProgress({ id, text });
  }
}

/** Diff card in the response. Falls back to anchors when the part is unavailable. */
export function pushDiffs(
  stream: vscode.ChatResponseStream,
  title: string,
  entries: Array<{ originalUri?: vscode.Uri; modifiedUri: vscode.Uri; added: number; removed: number }>,
): void {
  const Part = (vscode as any).ChatResponseMultiDiffPart;
  if (Part) {
    stream.push(new Part(entries.map(e => ({ ...e, goToFileUri: e.modifiedUri })), title, false));
    return;
  }
  for (const e of entries) { stream.anchor(e.modifiedUri); }
}

export interface ToolState {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
}

/** Render/update an ACP tool call as a native tool-invocation part. */
export function pushToolCall(stream: vscode.ChatResponseStream, tool: ToolState, isUpdate: boolean): void {
  const Part = (vscode as any).ChatToolInvocationPart;
  if (!Part) {
    if (!isUpdate) { stream.progress(tool.title); }
    return;
  }
  const done = tool.status === 'completed' || tool.status === 'failed';
  const part = new Part(tool.title, tool.toolCallId);
  part.invocationMessage = tool.title;
  part.pastTenseMessage = tool.title;
  part.isConfirmed = true;
  part.isComplete = done;
  part.isError = tool.status === 'failed';
  part.enablePartialUpdate = isUpdate;
  stream.push(part);
}
