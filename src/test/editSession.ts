import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { sleep, waitFor } from './helpers';

/** Checks that agent edits end up in the chat response with the right diffs. */

export type Part = { kind: string; value: any };

/** Stream stub that records every response part. */
export function recordingStream(parts: Part[]): vscode.ChatResponseStream {
  const rec = (kind: string) => (value: any) => { parts.push({ kind, value }); };
  return {
    markdown: rec('markdown'), anchor: rec('anchor'), button: rec('button'), filetree: rec('filetree'),
    progress: rec('progress'), reference: rec('reference'),
    push: (part: any) => {
      const v = vscode as any;
      const kind = v.ChatResponseMultiDiffPart && part instanceof v.ChatResponseMultiDiffPart ? 'multiDiff'
        : v.ChatToolInvocationPart && part instanceof v.ChatToolInvocationPart ? 'toolInvocation' : 'push';
      parts.push({ kind, value: part });
    },
  } as unknown as vscode.ChatResponseStream;
}

export function readOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Stand-in for VS Code's chat editing session ("files changed" with native
 * Keep/Undo), following ChatEditingSession.startExternalEdits: externalEdit
 * snapshots the files a moment after being asked (it goes through IPC, while
 * an agent may already be writing), runs the callback and reads them back.
 * A file's diff starts from its content when it was first tracked, changed or
 * not, so tracking a file after the agent wrote it shows no change.
 */
export class FakeEditSession {
  readonly files = new Map<string, { original: string | null; modified: string | null }>();

  constructor(private readonly snapshotDelayMs = 100) {}

  stream(parts: Part[]): vscode.ChatResponseStream {
    return Object.assign(recordingStream(parts), {
      textEdit: () => undefined,
      workspaceEdit: () => undefined,
      externalEdit: async (target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
        const paths = (Array.isArray(target) ? target : [target]).map(u => u.fsPath);
        await sleep(this.snapshotDelayMs);
        const before = paths.map(readOrNull);
        await callback();
        paths.forEach((p, i) => {
          const known = this.files.get(p);
          this.files.set(p, { original: known ? known.original : before[i], modified: readOrNull(p) });
        });
        return 'ok';
      },
    });
  }
}

/**
 * Every file whose content now differs from `before` must be shown with a
 * diff from its `before` content: natively (in `session`) or as a diff card
 * with Keep/Undo (ChangeTracker). Nothing else may be shown.
 */
export function assertEditsShown(
  before: Map<string, string | null>,
  api: AcpExtensionApi,
  parts: Part[],
  session?: FakeEditSession,
): void {
  const carded = new Set(parts.filter(p => p.kind === 'multiDiff')
    .flatMap(p => (p.value.value ?? []) as Array<{ modifiedUri: vscode.Uri }>)
    .map(d => d.modifiedUri.fsPath));
  const problems: string[] = [];
  const shownNatively = (p: string) => {
    const tracked = session?.files.get(p);
    return tracked && tracked.original !== tracked.modified ? tracked : undefined;
  };
  const paths = new Set([...before.keys(), ...[...session?.files.keys() ?? []].filter(shownNatively), ...carded]);
  for (const p of paths) {
    const name = nodePath.basename(p);
    if (!before.has(p)) {
      problems.push(`${name}: shown but not part of the edit`);
      continue;
    }
    const was = before.get(p)!;
    const now = readOrNull(p);
    const native = shownNatively(p);
    const card = carded.has(p) ? api.changeTracker.get(p) : undefined;
    if (was === now) {
      if (native || card) { problems.push(`${name}: unchanged but shown`); }
    } else if (native) {
      if (native.original !== was) { problems.push(`${name}: native diff starts from ${JSON.stringify(native.original)}`); }
      if (native.modified !== now) { problems.push(`${name}: native diff ends at ${JSON.stringify(native.modified)}`); }
    } else if (card) {
      if (card.baseline !== was) { problems.push(`${name}: diff card starts from ${JSON.stringify(card.baseline)}`); }
    } else {
      problems.push(`${name}: changed but not shown`);
    }
  }
  assert.deepStrictEqual(problems, [], problems.join('\n'));
}

/** Files in the real chat editing session, with the content their diffs start from. */
async function vsCodeEditingSession(): Promise<Map<string, string | null>> {
  await vscode.commands.executeCommand('chatEditing.viewChanges');
  // A multi-diff tab (TabInputTextMultiDiff, not in @types/vscode 1.85)
  type MultiDiff = { textDiffs: Array<{ original?: vscode.Uri; modified: vscode.Uri }> };
  const tab = await waitFor(() => vscode.window.tabGroups.all.flatMap(g => g.tabs)
    .find(t => Array.isArray((t.input as MultiDiff | undefined)?.textDiffs)), 5_000, 'changes editor').catch(() => undefined);
  const result = new Map<string, string | null>();
  if (!tab) { return result; }
  for (const d of (tab.input as MultiDiff).textDiffs) {
    const original = d.original ? (await vscode.workspace.openTextDocument(d.original)).getText() : null;
    result.set(d.modified.fsPath, original);
  }
  await vscode.window.tabGroups.close(tab);
  return result;
}

/**
 * Real VS Code: every file whose content now differs from `before` must be in
 * the chat editing session with a diff from its `before` content, or (e.g.
 * deletions) have a diff card with Keep/Undo from that content.
 */
export async function assertVsCodeShows(before: Map<string, string | null>, api: AcpExtensionApi): Promise<void> {
  const session = await vsCodeEditingSession();
  const problems: string[] = [];
  for (const [p, was] of before) {
    const now = readOrNull(p);
    const name = nodePath.basename(p);
    if (was === now) {
      if (session.has(p) && session.get(p) !== now) { problems.push(`${name}: unchanged but shown`); }
    } else if (!session.has(p)) {
      const card = api.changeTracker.get(p);
      if (!card) { problems.push(`${name}: changed but not in VS Code's editing session`); }
      else if (card.baseline !== was) { problems.push(`${name}: diff card starts from ${JSON.stringify(card.baseline)}`); }
    } else if (session.get(p) !== (was ?? '')) {
      problems.push(`${name}: VS Code's diff starts from ${JSON.stringify(session.get(p))}`);
    }
  }
  assert.deepStrictEqual(problems, [], problems.join('\n'));
}

/** Send `query` from a new chat in the real Chat view and wait until the turn has finished. */
export async function askInChatView(api: AcpExtensionApi, query: string, timeoutMs = 30_000): Promise<void> {
  // The Chat view refuses requests without a model; the fake-lm fixture provides one
  const [model] = await waitFor(async () => {
    const m = await vscode.lm.selectChatModels({ vendor: 'acp-test' });
    return m.length ? m : undefined;
  }, 20_000, 'fake language model');
  await vscode.commands.executeCommand('workbench.action.chat.newChat');
  const done = api.chatRequestsDone();
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query, modelSelector: { vendor: model.vendor, id: model.id },
  });
  await waitFor(() => api.chatRequestsDone() > done, timeoutMs, 'turn to finish');
  await sleep(1000);
}

/** Keep every edit of the chat and close the editors, ready for the next test. */
export async function resetChatView(): Promise<void> {
  await vscode.commands.executeCommand('chatEditing.acceptAllFiles').then(undefined, () => undefined);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** The fake agent's result file: what it left in each file (null: deleted). */
export function resultFile(): string {
  return nodePath.join(fs.realpathSync(os.tmpdir()), `fake-codex-result-${process.pid}.json`);
}

/** Nothing may overwrite, restore or delete what the agent left in its files. */
export function assertAgentResultKept(file: string): void {
  const result: Record<string, string | null> = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = Object.entries(result).filter(([p, content]) => readOrNull(p) !== content)
    .map(([p, content]) => `${nodePath.basename(p)}: holds ${JSON.stringify(readOrNull(p))}, the agent left ${JSON.stringify(content)}`);
  assert.deepStrictEqual(problems, [], problems.join('\n'));
}
