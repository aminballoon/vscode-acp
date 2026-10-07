import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { DEFAULT_SKILL_PATHS, resolveSkillPaths, WORKSPACE_SKILLS_DIR } from './SkillLibrary';

const workspacePaths = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

/** Files and folders of `acp.skills.paths`, resolved for the open workspace. */
export function configuredSkillPaths(): string[] {
  const entries = vscode.workspace.getConfiguration('acp').get<string[]>('skills.paths', DEFAULT_SKILL_PATHS);
  return resolveSkillPaths(entries, workspacePaths());
}

/**
 * Append entries to `acp.skills.paths` (keeping the defaults on first use).
 * They go where the effective value comes from, so a workspace setting does
 * not hide them from the picker.
 */
async function addSkillPaths(entries: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('acp');
  const inspect = config.inspect<string[]>('skills.paths');
  const [target, current] = inspect?.workspaceValue
    ? [vscode.ConfigurationTarget.Workspace, inspect.workspaceValue]
    : [vscode.ConfigurationTarget.Global, inspect?.globalValue ?? DEFAULT_SKILL_PATHS];
  const known = new Set(resolveSkillPaths(current, workspacePaths()));
  const added = entries.filter(e => !resolveSkillPaths([e], workspacePaths()).every(p => known.has(p)));
  if (added.length) {
    await config.update('skills.paths', [...current, ...added], target);
  }
}

const TEMPLATE = (name: string) => `---
name: ${name}
description: What this skill is for (shown in the Skills picker)
---

Instructions the agent follows when this skill is picked for a prompt.
`;

export function registerSkillCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // A markdown skill in ~/.acp/skills (every project) or .acp/skills (this workspace)
    vscode.commands.registerCommand('acp.skills.new', async () => {
      const name = (await vscode.window.showInputBox({
        title: 'New ACP Skill', prompt: 'Skill name, offered to every agent in the Skills picker', placeHolder: 'api-conventions',
        validateInput: v => !v.trim() ? 'Enter a name' : /[\\/:*?"<>|]/.test(v) ? 'Avoid \\ / : * ? " < > |' : undefined,
      }))?.trim();
      if (!name) { return; }

      // `entry` is the setting that offers the folder: the relative one resolves in every workspace folder
      const folders = [{ label: 'Every project', description: DEFAULT_SKILL_PATHS[0], entry: DEFAULT_SKILL_PATHS[0], dir: nodePath.join(os.homedir(), '.acp', 'skills') }];
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) { folders.push({ label: 'This workspace', description: `${ws.name}/.acp/skills`, entry: DEFAULT_SKILL_PATHS[1], dir: nodePath.join(ws.uri.fsPath, WORKSPACE_SKILLS_DIR) }); }
      const where = folders.length > 1 ? await vscode.window.showQuickPick(folders, { title: `Save skill "${name}" for` }) : folders[0];
      if (!where) { return; }

      const file = nodePath.join(where.dir, `${name.toLowerCase().replace(/\s+/g, '-')}.md`);
      await fs.mkdir(where.dir, { recursive: true });
      // Never overwrite an existing skill: open it instead
      await fs.writeFile(file, TEMPLATE(name), { flag: 'wx' }).catch(e => { if (e?.code !== 'EEXIST') { throw e; } });
      await addSkillPaths([where.entry]);
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),

    // Existing markdown files or folders of them, e.g. ~/.claude/skills
    vscode.commands.registerCommand('acp.skills.addPath', async () => {
      const uris = await vscode.window.showOpenDialog({
        title: 'Add Skills', openLabel: 'Add Skills', canSelectFiles: true, canSelectFolders: true, canSelectMany: true,
        filters: { Markdown: ['md'] },
      });
      if (!uris?.length) { return; }
      await addSkillPaths(uris.map(u => u.fsPath));
      vscode.window.showInformationMessage(`ACP: added ${uris.length === 1 ? nodePath.basename(uris[0].fsPath) : `${uris.length} paths`} to the Skills picker.`);
    }),
  );
}
