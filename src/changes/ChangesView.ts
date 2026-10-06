import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import type { ChangeTracker } from './ChangeTracker';
import { countLineChanges } from './diffUtil';

export const BASELINE_SCHEME = 'acp-baseline';

/**
 * Serves baseline content for the left side of the diff editor. The entry
 * version is part of the URI, so a new baseline gets a new document.
 */
export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly tracker: ChangeTracker) {}

  static uriFor(path: string, version: number): vscode.Uri {
    return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: vscode.Uri.file(path).path, query: String(version) });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const entry = this.tracker.get(vscode.Uri.file(uri.path).fsPath);
    return entry?.baseline ?? '';
  }
}

class ChangeItem extends vscode.TreeItem {
  constructor(public readonly path: string, added: number, removed: number, isNew: boolean) {
    super(nodePath.basename(path), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(path);
    const rel = vscode.workspace.asRelativePath(path);
    this.description = `${rel === path ? nodePath.dirname(path) : nodePath.dirname(rel)}  +${added} -${removed}${isNew ? ' (new)' : ''}`;
    this.contextValue = 'acpChange';
    this.command = { command: 'acp.changes.openDiff', title: 'Open Diff', arguments: [this] };
  }
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: { dispose(): void };

  constructor(private readonly tracker: ChangeTracker, private readonly io: { read(p: string): Promise<string | null> }) {
    this.sub = tracker.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(item: ChangeItem): vscode.TreeItem { return item; }

  getChildren(): Promise<ChangeItem[]> {
    // Counts reflect the current file, including the user's edits after the agent
    return Promise.all(this.tracker.list().map(async ([path, entry]) => {
      const current = (await this.io.read(path)) ?? '';
      const { added, removed } = countLineChanges(entry.baseline ?? '', current);
      return new ChangeItem(path, added, removed, entry.baseline === null);
    }));
  }

  dispose(): void { this.sub.dispose(); this.emitter.dispose(); }
}

export function registerChangesView(
  context: vscode.ExtensionContext,
  tracker: ChangeTracker,
  io: { read(p: string): Promise<string | null> },
): void {
  const provider = new BaselineContentProvider(tracker);
  const tree = new ChangesTreeProvider(tracker, io);
  const treeView = vscode.window.createTreeView('acp-changes', { treeDataProvider: tree });

  const syncBadge = () => {
    treeView.badge = tracker.size ? { value: tracker.size, tooltip: `${tracker.size} pending file(s)` } : undefined;
    void vscode.commands.executeCommand('setContext', 'acp.hasPendingChanges', tracker.size > 0);
  };
  syncBadge();

  const pathOf = (arg?: { path?: string } | vscode.Uri): string | undefined => {
    if (arg instanceof vscode.Uri) { return arg.fsPath; }
    return arg?.path;
  };

  const reg = vscode.commands.registerCommand;
  context.subscriptions.push(
    treeView, tree,
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, provider),
    tracker.onDidChange(syncBadge),
    reg('acp.changes.openDiff', async (arg?: any) => {
      const path = pathOf(arg);
      const entry = path && tracker.get(path);
      if (!path || !entry) { return; }
      await vscode.commands.executeCommand(
        'vscode.diff',
        BaselineContentProvider.uriFor(path, entry.version),
        vscode.Uri.file(path),
        `${nodePath.basename(path)} (Agent changes)`,
      );
    }),
    reg('acp.changes.keep', async (arg?: any) => {
      const path = pathOf(arg);
      if (path) { await tracker.keep(path); }
    }),
    reg('acp.changes.undo', async (arg?: any) => {
      const path = pathOf(arg);
      if (!path) { return; }
      const r = await tracker.undo(path);
      if (r.userEdited && !r.undone) {
        const choice = await vscode.window.showWarningMessage(
          `${nodePath.basename(path)} was edited after the agent changed it. Undo will discard your edits too.`,
          { modal: true }, 'Undo Anyway',
        );
        if (choice !== 'Undo Anyway') { return; }
        await tracker.undo(path, true);
      }
    }),
    reg('acp.changes.keepAll', async () => { await tracker.keepAll(); }),
    reg('acp.changes.undoAll', async () => {
      if (!tracker.size) { return; }
      const ok = await vscode.window.showWarningMessage(
        `Undo all ${tracker.size} pending file(s)?`, { modal: true }, 'Undo All');
      if (ok !== 'Undo All') { return; }
      const skipped = await tracker.undoAll();
      if (skipped.length) {
        const choice = await vscode.window.showWarningMessage(
          `${skipped.length} file(s) were edited after the agent: ${skipped.map(p => nodePath.basename(p)).join(', ')}. Undo them anyway?`,
          { modal: true }, 'Undo Anyway');
        if (choice === 'Undo Anyway') {
          for (const p of skipped) { await tracker.undo(p, true); }
        }
      }
    }),
  );
}
