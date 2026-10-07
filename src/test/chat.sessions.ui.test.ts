import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { connectFakeAgent, fixtureTarget, resetFixture, sleep, waitFor } from './helpers';

// Drives the "ACP" chat session type in the real Chat view: agent / model /
// effort / permission pickers below the input. Screenshots via
// scripts/ui-screenshots.sh.

async function shot(name: string): Promise<void> {
  const dir = process.env.ACP_UI_SIGNAL_DIR;
  if (!dir) { return; }
  fs.writeFileSync(path.join(dir, `${name}.req`), '');
  await waitFor(() => fs.existsSync(path.join(dir, `${name}.png`)), 15_000, `screenshot ${name}`).catch(() => undefined);
}

suite('ACP chat session type UI', function () {
  this.timeout(180_000);

  suiteTeardown(resetFixture);

  test('pickers and an edit in an ACP session', async () => {
    const target = fixtureTarget();
    resetFixture();
    // Named like Claude so the agent picker shows the Claude logo
    const api = await connectFakeAgent({ 'chat.nativeEdits': true }, 'Claude Code (fake)');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));

    // A chat saved by an earlier run (a fresh VS Code process) should reopen with its history
    const saved = api.acpChats().find(c => c.turns.length);
    if (saved) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`acp:/${saved.id}`));
      await sleep(3000);
      await shot('s00-restored');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }

    // What clicking an agent in the Agents view does: a new ACP chat with that agent picked
    await vscode.commands.executeCommand('acp.openChat', 'Claude Code (fake)');
    await sleep(3000);
    await shot('s01-acp-session');

    const before = api.chatRequestCount();
    // Plain prompt, no @acp: the ACP session routes it to the selected agent
    // The Chat view refuses requests without a model; the fake-lm fixture provides one
    const [model] = await waitFor(async () => {
      const m = await vscode.lm.selectChatModels({ vendor: 'acp-test' });
      return m.length ? m : undefined;
    }, 20_000, 'fake language model');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: 'change the delay in hello.py to 10 seconds',
      modelSelector: { vendor: model.vendor, id: model.id },
    });
    await waitFor(() => api.chatRequestCount() > before, 30_000, 'request to reach the ACP session');
    await sleep(1500);
    await shot('s02-permission');

    const edited = () => fs.readFileSync(target, 'utf8').includes('sleep(10)');
    for (let i = 0; i < 20 && !edited(); i++) {
      await vscode.commands.executeCommand('workbench.action.chat.acceptTool');
      await sleep(500);
    }
    await waitFor(edited, 20_000, 'agent to write the file');
    await sleep(3000);
    await shot('s03-after-edit');

    // Agents view: connected agents with what they reported (account, context, usage)
    await vscode.commands.executeCommand('acp-sessions.focus');
    await sleep(1500);
    await shot('s04-agents');
  });
});
