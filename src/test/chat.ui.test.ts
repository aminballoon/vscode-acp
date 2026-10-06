import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { connectFakeAgent, fixtureTarget, resetFixture, sleep, waitFor } from './helpers';

// Drives the real Chat view (not the handler directly). Run with the `ui`
// label; screenshots are taken from outside by scripts/ui-screenshots.sh.

/** Signal the external screenshot script, then give it time to capture. */
async function shot(name: string): Promise<void> {
  const dir = process.env.ACP_UI_SIGNAL_DIR;
  if (!dir) { return; }
  fs.writeFileSync(path.join(dir, `${name}.req`), '');
  await waitFor(() => fs.existsSync(path.join(dir, `${name}.png`)), 15_000, `screenshot ${name}`).catch(() => undefined);
}

suite('Chat view UI (fake agent, native edits)', function () {
  this.timeout(180_000);

  suiteTeardown(resetFixture);

  test('edit through the real Chat view', async () => {
    const target = fixtureTarget();
    resetFixture();
    const api = await connectFakeAgent({ 'chat.nativeEdits': process.env.ACP_UI_NATIVE !== '0' });
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
    const edited = () => fs.readFileSync(target, 'utf8').includes('sleep(10)');
    for (let i = 0; i < 20 && !edited(); i++) {
      await vscode.commands.executeCommand('workbench.action.chat.acceptTool');
      await sleep(500);
    }
    await waitFor(edited, 20_000, 'agent to write the file');
    await sleep(3000);
    await shot('03-after-edit');
  });
});
