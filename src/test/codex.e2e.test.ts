import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { FakeEditSession, Part, assertAgentResultKept, assertEditsShown, readOrNull, recordingStream, resultFile } from './editSession';
import { connectFakeAgent, fixtureTarget, waitFor } from './helpers';

interface Edit { file: string; kind: string }
interface Call { edits: Array<string | Edit>; approval?: string; shell?: boolean }
interface Scenario { calls: Call[]; outside?: boolean }

const fixtures: { base: Record<string, string>; edits: Record<string, Edit>; scenarios: Record<string, Scenario> } = JSON.parse(
  fs.readFileSync(nodePath.resolve(__dirname, '..', '..', 'test-fixtures', 'codex-scenarios.json'), 'utf8'),
);

/**
 * Edit turns in codex-acp's message shapes and timing (test-fixtures/fake-codex.mjs),
 * each run with native edits (VS Code's "files changed") and with diff cards, and
 * with and without the workspace snapshot (unavailable for gitignored files and
 * very large workspaces). Every file the turn changed must be shown, with a diff
 * from its pre-turn content.
 */
suite('Codex edits (replayed codex-acp turns)', function () {
  this.timeout(60_000);

  let api: AcpExtensionApi;

  suiteSetup(async () => {
    api = await connectFakeAgent({ autoApprovePermissions: 'ask' }, 'Fake Codex', 'fake-codex.mjs');
  });

  setup(() => api.changeTracker.keepAll());

  const modes = [
    { native: true, snapshot: true }, { native: false, snapshot: true },
    { native: true, snapshot: false }, { native: false, snapshot: false },
  ];
  for (const [name, scenario] of Object.entries(fixtures.scenarios)) {
    for (const { native, snapshot } of modes) {
      // Shell edits carry no diffs: only the workspace snapshot can find them
      if (!snapshot && (scenario.outside || scenario.calls.some(c => c.shell))) { continue; }
      test(`${name} (${native ? 'native edits' : 'diff cards'}${snapshot ? '' : ', no workspace snapshot'})`, async () => {
        const dir = scenario.outside
          ? fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), 'acp-codex-'))
          : nodePath.join(nodePath.dirname(fixtureTarget()), 'codex-scenario');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        try {
          for (const [file, text] of Object.entries(fixtures.base)) { fs.writeFileSync(nodePath.join(dir, file), text); }
          if (!snapshot) { fs.writeFileSync(nodePath.join(dir, '.gitignore'), '*\n'); }
          const files = scenario.calls.flatMap(c => c.edits.map(e => typeof e === 'string' ? fixtures.edits[e].file : e.file));
          const before = new Map(files.map(f => {
            const p = vscode.Uri.file(nodePath.join(dir, f)).fsPath;
            return [p, readOrNull(p)] as const;
          }));

          const parts: Part[] = [];
          const session = native ? new FakeEditSession() : undefined;
          const turn = Promise.resolve(api.chatHandler(
            { prompt: `codex-scenario ${name} ${dir} ${resultFile()}` } as unknown as vscode.ChatRequest,
            { history: [] } as unknown as vscode.ChatContext,
            session ? session.stream(parts) : recordingStream(parts),
            new vscode.CancellationTokenSource().token,
          ));
          await answerPermissions(parts, scenario.calls.flatMap(c => c.approval ? [c.approval] : []));
          await turn;

          assertAgentResultKept(resultFile());
          assertEditsShown(before, api, parts, session);
        } finally {
          await api.changeTracker.keepAll();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

/** Click the permission buttons for `optionIds`, in order, as the prompts come in. */
async function answerPermissions(parts: Part[], optionIds: string[]): Promise<void> {
  const isPermButton = (p: Part) => p.kind === 'button' && p.value?.command === 'acp.permission.answer';
  const answered = new Set<string>();
  for (const optionId of optionIds) {
    const button = await waitFor(() => parts.find(p => isPermButton(p) && p.value.arguments[1] === optionId && !answered.has(p.value.arguments[0])),
      20_000, `permission prompt (${optionId})`);
    answered.add(button.value.arguments[0]);
    await vscode.commands.executeCommand('acp.permission.answer', ...button.value.arguments);
  }
}
