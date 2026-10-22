import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { askInChatView, assertAgentResultKept, assertVsCodeShows, readOrNull, resetChatView, resultFile } from './editSession';
import { connectFakeAgent, fixtureTarget, sleep } from './helpers';

interface Edit { file: string; kind: string }
interface Scenario { calls: Array<{ edits: Array<string | Edit>; approval?: string; shell?: boolean }>; outside?: boolean }

const fixtures: {
  base: Record<string, string>; edits: Record<string, Edit>; scenarios: Record<string, Scenario>;
  followUps: Record<string, { turns: Scenario[] }>;
} = JSON.parse(
  fs.readFileSync(nodePath.resolve(__dirname, '..', '..', 'test-fixtures', 'codex-scenarios.json'), 'utf8'),
);

/**
 * Codex edit turns (test-fixtures/fake-codex.mjs) through the real Chat view
 * with native edits: VS Code's own editing session must list every changed
 * file, with a diff from its pre-turn content.
 */
suite('Codex edits in the real Chat view', function () {
  this.timeout(120_000);

  let api: AcpExtensionApi;

  suiteSetup(async () => {
    api = await connectFakeAgent({ 'chat.nativeEdits': true, autoApprovePermissions: 'allowAll' }, 'Fake Codex', 'fake-codex.mjs');
  });

  for (const [name, scenario] of Object.entries(fixtures.scenarios)) {
    // Permissions are auto-approved here (allowAll)
    if (scenario.calls.some(c => c.approval && !c.approval.startsWith('allow'))) { continue; }
    test(name, async () => {
      const dir = scenario.outside
        ? fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), 'acp-codex-'))
        : nodePath.join(nodePath.dirname(fixtureTarget()), 'codex-scenario');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      try {
        for (const [file, text] of Object.entries(fixtures.base)) { fs.writeFileSync(nodePath.join(dir, file), text); }
        const files = scenario.calls.flatMap(c => c.edits.map(e => typeof e === 'string' ? fixtures.edits[e].file : e.file));
        const before = new Map(files.map(f => {
          const p = vscode.Uri.file(nodePath.join(dir, f)).fsPath;
          return [p, readOrNull(p)] as const;
        }));

        await askInChatView(api, `@acp codex-scenario ${name} ${dir} ${resultFile()}`);
        assertAgentResultKept(resultFile());
        await assertVsCodeShows(before, api);
      } finally {
        await resetChatView();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // The same chat continues after its edits were kept: each turn's edits must show again
  const variants = [{ ask: false, open: false }, { ask: false, open: true }, { ask: true, open: true }];
  for (const [name, { turns }] of Object.entries(fixtures.followUps)) {
    for (const { ask, open } of variants) {
      const asks = turns.some(t => t.calls.some(c => c.approval));
      if (ask && !asks) { continue; }
      test(`follow-up: ${name}${open ? ', files open' : ''}${ask ? ', approved in the Chat view' : ''}`, async () => {
        const dir = nodePath.join(nodePath.dirname(fixtureTarget()), 'codex-scenario');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const config = vscode.workspace.getConfiguration('acp');
        if (ask) { await config.update('autoApprovePermissions', 'ask', vscode.ConfigurationTarget.Global); }
        let asking = true;
        // Approve the native tool confirmations ("Allow") while the turns run
        const approving = (async () => {
          while (ask && asking) {
            await vscode.commands.executeCommand('workbench.action.chat.acceptTool').then(undefined, () => undefined);
            await sleep(300);
          }
        })();
        try {
          for (const [file, text] of Object.entries(fixtures.base)) { fs.writeFileSync(nodePath.join(dir, file), text); }
          if (open) {
            for (const file of Object.keys(fixtures.base)) {
              await vscode.window.showTextDocument(vscode.Uri.file(nodePath.join(dir, file)), { preview: false });
            }
          }
          for (const [i, turn] of turns.entries()) {
            const files = turn.calls.flatMap(c => c.edits.map(e => typeof e === 'string' ? fixtures.edits[e].file : e.file));
            const before = new Map(files.map(f => {
              const p = vscode.Uri.file(nodePath.join(dir, f)).fsPath;
              return [p, readOrNull(p)] as const;
            }));
            await askInChatView(api, `@acp codex-scenario ${name} #${i} ${dir} ${resultFile()}`, undefined, i > 0);
            assertAgentResultKept(resultFile());
            await assertVsCodeShows(before, api);
            // Keep, as the user does before asking for more
            await vscode.commands.executeCommand('chatEditing.acceptAllFiles');
          }
        } finally {
          asking = false;
          await approving;
          if (ask) { await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global); }
          await resetChatView();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});
