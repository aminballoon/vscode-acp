import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { askInChatView, assertVsCodeShows, readOrNull, resetChatView } from './editSession';
import { EXT_ID, fixtureTarget } from './helpers';

const AGENT = 'Codex (live test)';

/**
 * Real Codex (@agentclientprotocol/codex-acp) through the real Chat view.
 * Uses the Codex account logged in on this machine and spends a little of
 * its quota. Opt-in: `npm run test:codex-live`. Set ACP_CODEX_ACP to test
 * another adapter build (e.g. `@agentclientprotocol/codex-acp@preview`).
 */
suite('Codex edits, live codex-acp', function () {
  this.timeout(300_000);

  let api: AcpExtensionApi;
  const dir = () => nodePath.join(nodePath.dirname(fixtureTarget()), 'codex-live');

  suiteSetup(async function () {
    const home = process.env.CODEX_HOME || nodePath.join(os.homedir(), '.codex');
    if (!fs.existsSync(nodePath.join(home, 'auth.json')) && !process.env.OPENAI_API_KEY) {
      console.log('[codex-live] skipped: Codex is not logged in (run `codex login`)');
      this.skip();
    }
    api = await vscode.extensions.getExtension<AcpExtensionApi>(EXT_ID)!.activate();
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('agents', {
      ...config.inspect<Record<string, unknown>>('agents')?.globalValue ?? {},
      [AGENT]: { command: 'npx', args: ['-y', process.env.ACP_CODEX_ACP || '@agentclientprotocol/codex-acp@latest'] },
    }, vscode.ConfigurationTarget.Global);
    await config.update('chat.nativeEdits', true, vscode.ConfigurationTarget.Global);
    await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('acp.connectAgent', AGENT);
  });

  setup(() => {
    fs.rmSync(dir(), { recursive: true, force: true });
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(nodePath.join(dir(), 'a.py'), 'import time\n\n\ndef main():\n    time.sleep(2)\n    print("hi")\n');
    fs.writeFileSync(nodePath.join(dir(), 'b.py'), 'x = 1\ny = 2\n');
    fs.writeFileSync(nodePath.join(dir(), 'c.py'), 'SPEED = 0.5\n');
    fs.writeFileSync(nodePath.join(dir(), 'gone.py'), '# to be deleted\n');
  });

  teardown(async () => {
    await resetChatView();
    fs.rmSync(dir(), { recursive: true, force: true });
  });

  /** Ask Codex for exact edits, check it made them and that VS Code shows every changed file. */
  async function expectEdits(instructions: string, changed: string[]): Promise<void> {
    const files = ['a.py', 'b.py', 'c.py', 'gone.py', 'new.py'].map(f => vscode.Uri.file(nodePath.join(dir(), f)).fsPath);
    const before = new Map(files.map(p => [p, readOrNull(p)] as const));
    await askInChatView(api, `@acp In the directory ${dir()}: ${instructions} `
      + 'Edit the files with apply_patch only. Do not run commands, do not touch other files and do not explain.', 240_000);
    const unchanged = changed.filter(f => before.get(vscode.Uri.file(nodePath.join(dir(), f)).fsPath) === readOrNull(nodePath.join(dir(), f)));
    assert.deepStrictEqual(unchanged, [], `unchanged after the turn (Codex skipped the edit, or something undid it): ${unchanged.join(', ')}`);
    await assertVsCodeShows(before, api);
  }

  test('three files in one patch', () => expectEdits(
    'In one single patch: in a.py change time.sleep(2) to time.sleep(10); in b.py change y = 2 to y = 3; in c.py change SPEED = 0.5 to SPEED = 0.03.',
    ['a.py', 'b.py', 'c.py'],
  ));

  test('add, delete and the same file in two patches', () => expectEdits(
    'First patch: create new.py containing print("new"), delete gone.py and in a.py change time.sleep(2) to time.sleep(5). '
    + 'Then, in a second, separate patch: in a.py change time.sleep(5) to time.sleep(10) and in b.py change x = 1 to x = 4.',
    ['a.py', 'b.py', 'gone.py', 'new.py'],
  ));
});
