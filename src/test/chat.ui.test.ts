import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';

// Drives the real Chat view (not the handler directly). Run with the `ui`
// label; screenshots are taken from outside by the runner script.
const EXT_ID = 'aminballoon.acp-agents';
const ORIGINAL = 'import time\n\n\ndef main():\n    time.sleep(2)\n    print("hi")\n';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) { return v; }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Signal the external screenshot script, then give it time to capture. */
async function shot(name: string): Promise<void> {
  const dir = process.env.ACP_UI_SIGNAL_DIR;
  if (!dir) { return; }
  fs.writeFileSync(path.join(dir, `${name}.req`), '');
  await waitFor(() => fs.existsSync(path.join(dir, `${name}.png`)), 15_000, `screenshot ${name}`).catch(() => undefined);
}

suite('Chat view UI (fake agent, native edits)', function () {
  this.timeout(180_000);

  test('edit through the real Chat view', async () => {
    const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const repo = path.resolve(ws, '..', '..');
    const target = vscode.Uri.file(path.join(ws, 'hello.py')).fsPath;
    fs.writeFileSync(target, ORIGINAL);

    const api = await vscode.extensions.getExtension<AcpExtensionApi>(EXT_ID)!.activate();
    const acpConfig = vscode.workspace.getConfiguration('acp');
    await acpConfig.update('agents', {
      'Fake Agent': { command: process.env.ACP_E2E_NODE || 'node', args: [path.join(repo, 'test-fixtures', 'fake-agent.mjs')] },
    }, vscode.ConfigurationTarget.Global);
    await acpConfig.update('chat.nativeEdits', process.env.ACP_UI_NATIVE !== '0', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('acp.connectAgent', 'Fake Agent');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));

    // The Chat view refuses requests without a model; the fake-lm fixture provides one
    const [model] = await waitFor(async () => {
      const m = await vscode.lm.selectChatModels({ vendor: 'acp-test' });
      return m.length ? m : undefined;
    }, 20_000, 'fake language model');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: '@acp change the delay in hello.py to 10 seconds',
      modelSelector: { vendor: model.vendor, id: model.id },
    });
    await sleep(2000);
    await shot('01-chat-open');
    await waitFor(() => api.chatRequestCount() > 0, 20_000, '@acp request to reach the participant');

    await sleep(1500);
    await shot('02-permission');
    // Approve the native tool confirmation ("Allow")
    for (let i = 0; i < 20 && !fs.readFileSync(target, 'utf8').includes('sleep(10)'); i++) {
      await vscode.commands.executeCommand('workbench.action.chat.acceptTool');
      await sleep(500);
    }
    await waitFor(() => fs.readFileSync(target, 'utf8').includes('sleep(10)'), 20_000, 'agent to write the file');
    await sleep(3000);
    await shot('03-after-edit');
    assert.ok(true);
  });
});
