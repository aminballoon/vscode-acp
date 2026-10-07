import * as assert from 'assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { ORIGINAL, addFakeAgent, connectFakeAgent, fixtureTarget, resetFixture, waitFor } from './helpers';

type Part = { kind: string; value: any };

/** Stream stub that records every response part. */
function recordingStream(parts: Part[]): vscode.ChatResponseStream {
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

/** Send a prompt in an ACP chat session with the given agent picked (auto-approve). */
function askChat(api: AcpExtensionApi, chat: string, prompt: string, agent: string) {
  return api.acpSessionHandler(
    { prompt } as unknown as vscode.ChatRequest,
    {
      history: [],
      chatSessionContext: {
        chatSessionItem: { resource: vscode.Uri.parse(`acp:/${chat}`), label: chat },
        inputState: { groups: [{ id: 'agent', name: 'Agent', items: [], selected: { id: agent, name: agent } },
          { id: 'permissions', name: 'Permissions', items: [], selected: { id: 'auto', name: 'Auto' } }] },
      },
    } as unknown as vscode.ChatContext,
    recordingStream([]), new vscode.CancellationTokenSource().token,
  );
}

/** Run one @acp turn against the fake agent, answering its permission prompt with `optionId`. */
async function runTurn(api: AcpExtensionApi, target: string, optionId: string): Promise<Part[]> {
  const parts: Part[] = [];
  const stream = recordingStream(parts);

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

  test('edit made by a shell command: diff card from the workspace snapshot', async () => {
    const parts: Part[] = [];
    await api.chatHandler(
      { prompt: `shell-edit ${target}` } as unknown as vscode.ChatRequest,
      { history: [] } as unknown as vscode.ChatContext,
      recordingStream(parts), new vscode.CancellationTokenSource().token,
    );
    assert.ok(fs.readFileSync(target, 'utf8').includes('sleep(10)'), 'agent changed the file');
    assert.ok(parts.some(p => p.kind === 'multiDiff'), 'diff card pushed');
    assert.ok(parts.some(p => p.kind === 'button' && p.value?.command === 'acp.changes.undo'), 'Undo button pushed');
    assert.ok(api.changeTracker.get(target)?.baseline?.includes('sleep(2)'), 'baseline is the pre-turn content');

    await vscode.commands.executeCommand('acp.changes.undo', { path: target });
    await waitFor(() => fs.readFileSync(target, 'utf8') === ORIGINAL, 10_000, 'undo to restore file');
  });

  test('edit made by a shell command: native external edit when the session supports it', async () => {
    const parts: Part[] = [];
    const seen: Array<{ before: string; after: string }> = [];
    // What VS Code does for externalEdit: snapshot the files, run the callback, read them back
    const stream = Object.assign(recordingStream(parts), {
      textEdit: () => undefined,
      workspaceEdit: () => undefined,
      externalEdit: async (uris: vscode.Uri[], callback: () => Thenable<unknown>) => {
        const before = fs.readFileSync(uris[0].fsPath, 'utf8');
        await callback();
        seen.push({ before, after: fs.readFileSync(uris[0].fsPath, 'utf8') });
      },
    });
    await api.chatHandler(
      { prompt: `shell-edit ${target}` } as unknown as vscode.ChatRequest,
      { history: [] } as unknown as vscode.ChatContext,
      stream, new vscode.CancellationTokenSource().token,
    );
    assert.strictEqual(seen.length, 1, 'replayed through externalEdit');
    assert.strictEqual(seen[0].before, ORIGINAL, 'VS Code snapshots the pre-turn content');
    assert.ok(seen[0].after.includes('sleep(10)'), 'and reads back the agent result');
    assert.ok(fs.readFileSync(target, 'utf8').includes('sleep(10)'), 'agent result stays on disk');
    assert.ok(!parts.some(p => p.kind === 'multiDiff'), 'no fallback card');
    assert.strictEqual(api.changeTracker.size, 0, 'nothing pending in the fallback tracker');
  });

  test('rejected edit: file untouched, no diff card, nothing pending', async () => {
    const parts = await runTurn(api, target, 'reject');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), ORIGINAL);
    assert.ok(!parts.some(p => p.kind === 'multiDiff'), 'no diff card');
    assert.strictEqual(api.changeTracker.size, 0);
  });

  test('ACP session pickers: model, effort and auto-approve are applied', async () => {
    const parts: Part[] = [];
    const selected = (id: string, value: string) => ({ id, name: id, items: [], selected: { id: value, name: value } });
    const ctx = {
      history: [],
      chatSessionContext: {
        inputState: {
          groups: [
            selected('agent', 'Fake Agent'), selected('model', 'fake-fast'),
            selected('effort', 'high'), selected('permissions', 'auto'),
          ],
        },
      },
    } as unknown as vscode.ChatContext;
    await api.acpSessionHandler(
      { prompt: `edit ${target}` } as unknown as vscode.ChatRequest, ctx,
      recordingStream(parts), new vscode.CancellationTokenSource().token,
    );

    const config = api.activeConfigOptions() as Array<{ id: string; currentValue: string }>;
    assert.strictEqual(config.find(o => o.id === 'model')?.currentValue, 'fake-fast');
    assert.strictEqual(config.find(o => o.id === 'effort')?.currentValue, 'high');
    assert.ok(fs.readFileSync(target, 'utf8').includes('sleep(10)'), 'edit applied without a prompt');
    assert.ok(!parts.some(p => p.kind === 'button' && p.value?.command === 'acp.permission.answer'), 'no permission prompt');
  });

  test('ACP chats: own agent session per chat, saved transcript', async () => {
    const ask = (chat: string, prompt: string) => askChat(api, chat, prompt, 'Fake Agent');
    // Chats persist across runs, so use fresh ids
    const [idA, idB] = [`chat-a-${Date.now()}`, `chat-b-${Date.now()}`];
    await ask(idA, 'hello from a');
    await ask(idB, 'hello from b');
    await ask(idA, `edit ${target}`);

    const a = api.acpChats().find(c => c.id === idA)!;
    const b = api.acpChats().find(c => c.id === idB)!;
    assert.ok(a.acpSessionId && b.acpSessionId, 'both chats are bound to agent sessions');
    assert.notStrictEqual(a.acpSessionId, b.acpSessionId, 'each chat has its own agent session');
    assert.deepStrictEqual(a.turns.map(t => t.prompt), ['hello from a', `edit ${target}`]);
    assert.ok(a.turns[1].response.includes('Edited the file'), 'agent reply recorded');
    assert.ok(a.turns[1].tools.some(t => t.includes('hello.py')), 'tool calls recorded');
    await api.changeTracker.keepAll();
  });

  test('ACP chats: switching agents keeps each chat\'s agent connected', async () => {
    await addFakeAgent('Fake Agent 2');
    const [idA, idB] = [`chat-agent1-${Date.now()}`, `chat-agent2-${Date.now()}`];
    await askChat(api, idA, 'hello from agent 1', 'Fake Agent');
    await askChat(api, idB, 'hello from agent 2', 'Fake Agent 2');
    const sessionOf = (id: string) => api.acpChats().find(c => c.id === id)!.acpSessionId;
    const [sessionA, sessionB] = [sessionOf(idA), sessionOf(idB)];
    assert.deepStrictEqual([...api.connectedAgents()].sort(), ['Fake Agent', 'Fake Agent 2'], 'both agents stay connected');

    // Back and forth, also concurrently: each chat keeps its own agent session
    await Promise.all([askChat(api, idA, 'again 1', 'Fake Agent'), askChat(api, idB, 'again 2', 'Fake Agent 2')]);
    assert.strictEqual(sessionOf(idA), sessionA, 'chat A kept its session');
    assert.strictEqual(sessionOf(idB), sessionB, 'chat B kept its session');
    const a = api.acpChats().find(c => c.id === idA)!;
    const b = api.acpChats().find(c => c.id === idB)!;
    assert.deepStrictEqual([a.agentName, b.agentName], ['Fake Agent', 'Fake Agent 2']);
    assert.ok(a.turns.every(t => t.response) && b.turns.every(t => t.response), 'every turn got its agent\'s reply');
  });

  test('ACP chats: idle agents disconnect and the chat resumes its session', async () => {
    const id = `chat-idle-${Date.now()}`;
    await askChat(api, id, 'hello before idle', 'Fake Agent');
    const before = api.acpChats().find(c => c.id === id)!.acpSessionId;

    const disconnected = await api.disconnectIdleAgents(0);
    assert.ok(disconnected.includes('Fake Agent'), 'idle agent (supports resume) is disconnected');
    assert.ok(!api.connectedAgents().includes('Fake Agent'));

    await askChat(api, id, 'hello after idle', 'Fake Agent');
    const chat = api.acpChats().find(c => c.id === id)!;
    assert.ok(api.connectedAgents().includes('Fake Agent'), 'next message reconnects');
    assert.strictEqual(chat.acpSessionId, before, 'the chat resumed its own agent session');
    assert.ok(chat.turns.at(-1)?.response, 'resumed session answered');
  });

  test('keep clears the pending entry and leaves the agent result', async () => {
    await runTurn(api, target, 'allow-once');
    await vscode.commands.executeCommand('acp.changes.keep', { path: target });
    assert.strictEqual(api.changeTracker.size, 0);
    assert.ok(fs.readFileSync(target, 'utf8').includes('sleep(10)'));
  });
});
