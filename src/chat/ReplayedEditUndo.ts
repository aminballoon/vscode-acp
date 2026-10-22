import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { fingerprint, log, logError } from '../utils/Logger';

/**
 * Saves files that VS Code's Undo reverted but left unsaved.
 *
 * VS Code's chat editing entry saves a file on Undo only while every change to
 * its buffer came from the chat (`allEditsAreFromUs`); any other change clears
 * that for good. Files the agent wrote itself are replayed at the end of the
 * turn (see replayAsExternalEdit), so the agent's write and the replay's
 * write-back of the pre-turn content reach VS Code as disk changes outside an
 * externalEdit. For a file VS Code already tracked in an earlier turn of the
 * chat, Undo then puts the pre-turn content back in the editor buffer only:
 * the agent's content stays on disk and the file is left dirty.
 */
export class ReplayedEditUndo implements vscode.Disposable {
  private readonly replayed = new Map<string, { before: string; after: string }>();
  /** Files whose buffer Undo just reverted; the dirty flag follows in an event of its own. */
  private readonly undone = new Set<string>();
  private readonly sub = vscode.workspace.onDidChangeTextDocument(e => this.onChange(e));

  /** A file shown natively by a replay: its pre-turn content and the agent's. */
  note(path: string, before: string, after: string): void {
    this.replayed.set(path, { before, after });
    this.undone.delete(path);
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    const path = doc.uri.fsPath;
    const replayed = doc.uri.scheme === 'file' ? this.replayed.get(path) : undefined;
    if (!replayed) { return; }
    if (e.contentChanges.length) {
      // VS Code's Undo replaces the whole buffer with the content before the agent's edit
      // (Undo in the editor, Ctrl+Z, is the user's own)
      const [change, ...more] = e.contentChanges;
      const undo = e.reason === undefined && !more.length && change.range.start.isEqual(new vscode.Position(0, 0))
        && change.text === doc.getText() && change.text === replayed.before;
      if (!undo) { this.undone.delete(path); return; }
      this.undone.add(path);
    }
    if (!this.undone.has(path) || !doc.isDirty) { return; }
    this.undone.delete(path);
    void (async () => {
      // VS Code may have saved it after all
      const disk = await fs.readFile(path, 'utf8').catch(() => null);
      if (!doc.isDirty || doc.getText() !== replayed.before || disk !== replayed.after) { return; }
      this.replayed.delete(path);
      log(`[edits] Undo reverted ${path} in the editor only (disk=${fingerprint(disk)}); saving it`);
      await doc.save();
    })().catch(err => logError(`saving ${path} after Undo failed`, err));
  }

  dispose(): void {
    this.sub.dispose();
  }
}
