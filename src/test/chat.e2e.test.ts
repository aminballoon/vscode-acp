import * as assert from 'assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { ORIGINAL, connectFakeAgent, fixtureTarget, resetFixture, waitFor } from './helpers';

type Part = { kind: string; value: any };

/** Run one @acp turn against the fake agent, answering its permission prompt with `optionId`. */
async function runTurn(api: AcpExtensionApi, target: string, optionId: string): Promise<Part[]> {
  const parts: Part[] = [];
  const rec = (kind: string) => (value: any) => { parts.push({ kind, value }); };
  const stream = {
    markdown: rec('markdown'), anchor: rec('anchor'), button: rec('button'), filetree: rec('filetree'),
    progress: rec('progress'), reference: rec('reference'),
    push: (part: any) => {
      const v = vscode as any;
      const kind = v.ChatResponseMultiDiffPart && part instanceof v.ChatResponseMultiDiffPart ? 'multiDiff'
        : v.ChatToolInvocationPart && part instanceof v.ChatToolInvocationPart ? 'toolInvocation' : 'push';
      parts.push({ kind, value: part });
    },
  } as unknown as vscode.ChatResponseStream;

  const cts = new vscode.CancellationTokenSource();
  const turn = Promise.resolve(api.chatHandler(
    { prompt: `edit ${target}` } as unknown as vscode.ChatRequest,
    { history: [] } as unknown as vscode.ChatContext,
    stream, cts.token,
  ));

  const isPermButton = (p: Part) => p.kind === 'button' && p.value?.command === 'acp.permission.answer';
  await waitFor(() => parts.some(isPermButton), 30_000, 'permission buttons');
  const button = parts.find(p => isPermButton(p) && p.value.arguments[1] === optionId)!;
  await vscode.commands.executeCommand('acp.permission.answer', ...button.value.arguments);
  await turn;
  console.log(`[e2e] ${optionId}:`, parts.map(p => p.kind + (p.kind === 'button' ? `(${p.value.title})` : '')).join(' | '));
  return parts;
}

suite('Chat participant e2e (fake agent)', function () {
  this.timeout(120_000);

  let api: AcpExtensionApi;
  let target: string;

  suiteSetup(async () => {
    target = fixtureTarget();
    api = await connectFakeAgent({ autoApprovePermissions: 'none' });
  });

  setup(async () => {
    await api.changeTracker.keepAll();
    resetFixture();
    // Keep the file open so its buffer can lag behind the agent's disk write
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  });

  suiteTeardown(resetFixture);

  test('approved agent-side edit: diff card, Keep/Undo, undo restores', async () => {
    const parts = await runTurn(api, target, 'allow-once');
    assert.ok(fs.readFileSync(target, 'utf8').includes('sleep(10)'), 'agent wrote the file');

    assert.ok(parts.some(p => p.kind === 'multiDiff'), 'diff card pushed');
    assert.ok(parts.some(p => p.kind === 'button' && p.value?.command === 'acp.changes.keep'), 'Keep button pushed');
    assert.ok(parts.some(p => p.kind === 'button' && p.value?.command === 'acp.changes.undo'), 'Undo button pushed');

    const entry = api.changeTracker.get(target);
    assert.ok(entry, 'pending change entry exists');
    assert.ok(entry.baseline?.includes('sleep(2)'), 'baseline is the pre-edit content');
    assert.ok(entry.agentText.includes('sleep(10)'), 'agentText is the agent result');

    await vscode.commands.executeCommand('acp.changes.undo', { path: target });
    await waitFor(() => fs.readFileSync(target, 'utf8') === ORIGINAL, 10_000, 'undo to restore file');
    assert.strictEqual(api.changeTracker.size, 0);
  });

  test('rejected edit: file untouched, no diff card, nothing pending', async () => {
    const parts = await runTurn(api, target, 'reject');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), ORIGINAL);
    assert.ok(!parts.some(p => p.kind === 'multiDiff'), 'no diff card');
    assert.strictEqual(api.changeTracker.size, 0);
  });

  test('keep clears the pending entry and leaves the agent result', async () => {
    await runTurn(api, target, 'allow-once');
    await vscode.commands.executeCommand('acp.changes.keep', { path: target });
    assert.strictEqual(api.changeTracker.size, 0);
    assert.ok(fs.readFileSync(target, 'utf8').includes('sleep(10)'));
  });
});
