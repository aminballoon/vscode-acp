import * as vscode from 'vscode';
import * as os from 'node:os';

import { recentLogText, recentTrafficText } from './Logger';

/** What the report needs from the rest of the extension. */
export interface DebugReportSources {
  /** Connected agents: config name and what the agent reported at initialize. */
  agents(): Array<{ name: string; info?: { name?: string | null; title?: string | null; version?: string | null } | null }>;
  /** Files with a pending diff card. */
  pendingChanges(): string[];
}

const SETTINGS = [
  'acp.chat.nativeEdits', 'acp.autoApprovePermissions', 'acp.logTraffic',
  'files.autoSave', 'files.autoSaveDelay', 'chat.editing.autoAcceptDelay',
];

/**
 * Plain-text report for bug reports: versions, relevant settings, connected
 * agents and the recent ACP Client log. The protocol traffic (prompts and
 * file contents) is only included when `withTraffic`.
 */
export function buildDebugReport(sources: DebugReportSources, withTraffic: boolean): string {
  const ext = vscode.extensions.getExtension('aminballoon.acp-chat');
  const lines = [
    '# ACP debug report',
    '',
    `Created: ${new Date().toISOString()}`,
    `Extension: ${ext?.packageJSON?.version ?? 'unknown'} (${ext?.extensionPath ?? '?'})`,
    `${vscode.env.appName}: ${vscode.version}${vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : ''}`,
    `OS: ${os.platform()} ${os.release()} ${os.arch()}`,
    '',
    '## Settings',
  ];
  for (const key of SETTINGS) {
    const i = key.lastIndexOf('.');
    lines.push(`${key}: ${JSON.stringify(vscode.workspace.getConfiguration(key.slice(0, i)).get(key.slice(i + 1)))}`);
  }

  // Commands only: env values may hold API keys
  const configured = vscode.workspace.getConfiguration('acp').get<Record<string, { command?: string; args?: string[]; env?: object }>>('agents') ?? {};
  lines.push('', '## Agents');
  for (const [name, cfg] of Object.entries(configured)) {
    const connected = sources.agents().find(a => a.name === name);
    const info = connected?.info;
    lines.push(`${name}: ${[cfg.command, ...cfg.args ?? []].join(' ')}`
      + (cfg.env && Object.keys(cfg.env).length ? ` (env: ${Object.keys(cfg.env).join(', ')})` : '')
      + (connected ? ` — connected: ${info?.name ?? '?'} ${info?.version ?? ''}`.trimEnd() : ''));
  }

  const pending = sources.pendingChanges();
  lines.push('', '## Pending diff cards', pending.length ? pending.join('\n') : 'none');
  lines.push('', '## ACP Client log', recentLogText() || '(empty)');
  if (withTraffic) { lines.push('', '## ACP Traffic', recentTrafficText() || '(empty: acp.logTraffic is off)'); }
  return lines.join('\n') + '\n';
}

/** Ask what to include, then save the report where the user chooses and open it. */
export async function exportDebugReport(sources: DebugReportSources): Promise<void> {
  const pick = await vscode.window.showQuickPick([
    { label: 'Log only', description: 'Versions, settings and the ACP Client log (file names, no file contents)', traffic: false },
    { label: 'Log and protocol traffic', description: 'Also every message with the agent: prompts, replies and file contents', traffic: true },
  ], { title: 'Export ACP debug report', placeHolder: 'What should the report include?' });
  if (!pick) { return; }

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(folder, `acp-debug-${stamp}.log`),
    filters: { Log: ['log', 'txt'] },
    title: 'Save ACP debug report',
  });
  if (!target) { return; }

  await vscode.workspace.fs.writeFile(target, Buffer.from(buildDebugReport(sources, pick.traffic), 'utf8'));
  const open = await vscode.window.showInformationMessage(`ACP debug report saved to ${target.fsPath}`, 'Open', 'Show in Folder');
  if (open === 'Open') {
    await vscode.window.showTextDocument(target);
  } else if (open === 'Show in Folder') {
    await vscode.commands.executeCommand('revealFileInOS', target);
  }
}
