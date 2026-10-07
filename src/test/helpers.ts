import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';

/** Shared setup for the e2e and UI suites (fake ACP agent + fixture workspace). */

export const EXT_ID = 'aminballoon.acp-chat';
/** Content of test-fixtures/ws/hello.py; the fake agent changes sleep(2) to sleep(10). */
export const ORIGINAL = 'import time\n\n\ndef main():\n    time.sleep(2)\n    print("hi")\n';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) { return v; }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Absolute path of the fixture file the fake agent edits. */
export function fixtureTarget(): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) { throw new Error('test must run with the test-fixtures/ws workspace folder'); }
  return vscode.Uri.file(path.join(ws, 'hello.py')).fsPath;
}

export function resetFixture(): void {
  fs.writeFileSync(fixtureTarget(), ORIGINAL);
}

/** Activate the extension, configure the fake agent and connect to it. */
export async function connectFakeAgent(
  settings: Record<string, unknown> = {},
  agentName = 'Fake Agent',
): Promise<AcpExtensionApi> {
  const api = await vscode.extensions.getExtension<AcpExtensionApi>(EXT_ID)!.activate();
  await addFakeAgent(agentName);
  const config = vscode.workspace.getConfiguration('acp');
  for (const [key, value] of Object.entries(settings)) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }
  await vscode.commands.executeCommand('acp.connectAgent', agentName);
  return api;
}

/** Configure a fake agent under `agentName` without connecting to it. */
export async function addFakeAgent(agentName: string): Promise<void> {
  const repo = path.resolve(path.dirname(fixtureTarget()), '..', '..');
  const config = vscode.workspace.getConfiguration('acp');
  // Add to the fake agents configured so far (an open ACP session may still use them)
  const existing = config.inspect<Record<string, unknown>>('agents')?.globalValue ?? {};
  await config.update('agents', {
    ...existing,
    [agentName]: {
      command: process.env.ACP_E2E_NODE || 'node',
      args: [path.join(repo, 'test-fixtures', 'fake-agent.mjs')],
    },
  }, vscode.ConfigurationTarget.Global);
}
