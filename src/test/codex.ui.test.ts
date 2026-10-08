import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { askInChatView, assertAgentResultKept, assertVsCodeShows, readOrNull, resetChatView, resultFile } from './editSession';
import { connectFakeAgent, fixtureTarget } from './helpers';

interface Edit { file: string; kind: string }
interface Scenario { calls: Array<{ edits: Array<string | Edit>; approval?: string; shell?: boolean }>; outside?: boolean }

const fixtures: { base: Record<string, string>; edits: Record<string, Edit>; scenarios: Record<string, Scenario> } = JSON.parse(
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
});
