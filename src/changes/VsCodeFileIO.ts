import * as vscode from 'vscode';
import type { FileIO } from './ChangeTracker';

/** FileIO backed by VS Code; prefers open editor buffers (matches readTextFile). */
export class VsCodeFileIO implements FileIO {
  async read(path: string): Promise<string | null> {
    const uri = vscode.Uri.file(path);
    const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
    if (open) { return open.getText(); }
    return this.readDisk(path);
  }

  async readDisk(path: string): Promise<string | null> {
    const uri = vscode.Uri.file(path);
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
    } catch {
      return null;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
    // A clean buffer may be stale (agent wrote to disk); editing it can be a no-op,
    // so write to disk and let VS Code reload. Dirty buffers are overwritten via save.
    if (open?.isDirty) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, open.lineCount, 0), content);
      await vscode.workspace.applyEdit(edit);
      await open.save();
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
    }
  }

  async remove(path: string): Promise<void> {
    await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
  }
}
