import * as assert from 'assert';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { askInChatView, assertVsCodeShows, readOrNull, vsCodeEditingSession } from './editSession';
import { sleep } from './helpers';

/** How the user answers the agent's permission prompts in the Chat view. */
export type Answer = 'allow' | 'skip';

/**
 * One chat in the real Chat view, turn after turn, as a user drives it: the
 * agent edits, the user keeps, undoes, edits the files themself or leaves the
 * changes pending, then asks for more. Tracks what each file's diff must
 * start from (its content when last kept or undone) and checks after every
 * turn that VS Code shows exactly that.
 */
export class FollowUpChat {
  /** Content each file's diff must start from. */
  readonly baseline = new Map<string, string | null>();
  private turns = 0;
  private answering?: Promise<void>;
  private answer?: Answer;

  constructor(private readonly api: AcpExtensionApi, readonly paths: string[], private readonly timeoutMs = 30_000) {
    this.rebase();
  }

  private rebase(): void {
    for (const p of this.paths) { this.baseline.set(p, readOrNull(p)); }
  }

  /** Answer native tool confirmations in the Chat view as they come (until `stopAnswering`). */
  answerPrompts(answer: Answer): void {
    this.answer = answer;
    this.answering ??= (async () => {
      while (this.answer) {
        const command = this.answer === 'allow' ? 'workbench.action.chat.acceptTool' : 'workbench.action.chat.skipTool';
        await vscode.commands.executeCommand(command).then(undefined, () => undefined);
        await sleep(300);
      }
    })();
  }

  async stopAnswering(): Promise<void> {
    this.answer = undefined;
    await this.answering;
    this.answering = undefined;
  }

  /**
   * Send one turn. Files in `changed` must differ from before the turn, files
   * in `unchanged` must not; then VS Code must show every file that differs
   * from its baseline, with a diff from that baseline.
   */
  async ask(query: string, expect: { changed?: string[]; unchanged?: string[] } = {}): Promise<void> {
    const before = new Map(this.paths.map(p => [p, readOrNull(p)] as const));
    await askInChatView(this.api, query, this.timeoutMs, this.turns++ > 0);
    const name = (p: string) => nodePath.basename(p);
    const problems = [
      ...(expect.changed ?? []).filter(p => readOrNull(p) === before.get(p)).map(p => `${name(p)}: unchanged after the turn`),
      ...(expect.unchanged ?? []).filter(p => readOrNull(p) !== before.get(p)).map(p => `${name(p)}: changed, but should not have`),
    ];
    assert.deepStrictEqual(problems, [], `turn ${this.turns}: ${problems.join('\n')}`);
    await assertVsCodeShows(this.baseline, this.api);
  }

  /** Keep everything: VS Code's "Keep" and the diff cards' "Keep All"; nothing may stay pending. */
  async keep(): Promise<void> {
    await vscode.commands.executeCommand('chatEditing.acceptAllFiles');
    await vscode.commands.executeCommand('acp.changes.keepAll');
    this.rebase();
    // After Keep, VS Code's diff of each file starts from its current content
    let pending: string[] = [];
    for (let i = 0; i < 10; i++) {
      const session = await vsCodeEditingSession();
      pending = this.paths.filter(p => session.has(p) && session.get(p) !== (readOrNull(p) ?? ''));
      if (!pending.length) { return; }
      console.log(`[follow-up] still pending after Keep (attempt ${i + 1}): ${pending.map(p => nodePath.basename(p)).join(', ')}`);
      await sleep(500);
      await vscode.commands.executeCommand('chatEditing.acceptAllFiles');
    }
    assert.fail(`Keep did not take in VS Code: ${pending.map(p => nodePath.basename(p)).join(', ')}`);
  }

  /** Undo everything (per file: "Undo All" asks first); files must return to their baseline. */
  async undo(): Promise<void> {
    for (const p of this.paths) {
      await vscode.commands.executeCommand('chatEditing.discardFile', vscode.Uri.file(p)).then(undefined, () => undefined);
    }
    await this.api.changeTracker.undoAll(true);
    await sleep(500);
    const problems = this.paths.filter(p => readOrNull(p) !== this.baseline.get(p))
      .map(p => {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === p);
        const editor = doc?.isDirty ? ` (unsaved in the editor: ${JSON.stringify(doc.getText())})` : '';
        return `${nodePath.basename(p)}: holds ${JSON.stringify(readOrNull(p))} after Undo, not ${JSON.stringify(this.baseline.get(p))}${editor}`;
      });
    assert.deepStrictEqual(problems, [], problems.join('\n'));
  }

  /** The user edits a file in the editor and saves it (after keeping the agent's changes). */
  async userEdit(path: string, edit: (text: string) => string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(path);
    const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, all, edit(doc.getText()));
    assert.ok(await vscode.workspace.applyEdit(we), 'user edit applied');
    assert.ok(await doc.save(), 'user edit saved');
    this.baseline.set(path, readOrNull(path));
  }
}

/** What the user does between two turns of the same chat. */
export type BetweenTurns = 'keep' | 'undo' | 'leave pending' | 'edit the file';
export const BETWEEN_TURNS: BetweenTurns[] = ['keep', 'undo', 'leave pending', 'edit the file'];

export async function betweenTurns(chat: FollowUpChat, action: BetweenTurns, file: string): Promise<void> {
  switch (action) {
    case 'keep': return chat.keep();
    case 'undo': return chat.undo();
    case 'leave pending': return;
    case 'edit the file':
      await chat.keep();
      return chat.userEdit(file, text => text + '# by the user\n');
  }
}

/** How the chat runs: files open in editors, prompts answered in the Chat view, diff cards instead of native edits. */
export interface FollowUpSetup { label: string; open?: boolean; ask?: boolean; cards?: boolean }
export const FOLLOW_UP_SETUPS: FollowUpSetup[] = [
  { label: 'files closed' },
  { label: 'files open', open: true },
  { label: 'files open, approved in the Chat view', open: true, ask: true },
  { label: 'files open, diff cards', open: true, cards: true },
];

export async function applySetup(setup: FollowUpSetup, paths: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('acp');
  if (setup.ask) { await config.update('autoApprovePermissions', 'ask', vscode.ConfigurationTarget.Global); }
  if (setup.cards) { await config.update('chat.nativeEdits', false, vscode.ConfigurationTarget.Global); }
  if (setup.open) {
    for (const p of paths) { await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false }); }
  }
}

export async function undoSetup(setup: FollowUpSetup): Promise<void> {
  const config = vscode.workspace.getConfiguration('acp');
  if (setup.ask) { await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global); }
  if (setup.cards) { await config.update('chat.nativeEdits', true, vscode.ConfigurationTarget.Global); }
}
