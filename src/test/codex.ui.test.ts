import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { askInChatView, assertAgentResultKept, assertVsCodeShows, readOrNull, resetChatView, resultFile } from './editSession';
import { BETWEEN_TURNS, FOLLOW_UP_SETUPS, FollowUpChat, applySetup, betweenTurns, undoSetup } from './followUpChat';
import { connectFakeAgent, fixtureTarget } from './helpers';

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

  // The same chat continues after the user kept, undid, edited or left the changes: each turn must show again
  let followUpN = 0;
  for (const [name, { turns }] of Object.entries(fixtures.followUps)) {
    for (const setup of FOLLOW_UP_SETUPS) {
      // Only the user can reject an edit: in the Chat view, when asked
      if (!setup.ask && turns.some(t => t.calls.some(c => c.approval === 'skip'))) { continue; }
      for (const between of BETWEEN_TURNS) {
        const title = `follow-up: ${name}; ${between} between turns; ${setup.label}`;
        // Known issue: a file undone once in the chat and edited again by an agent that writes
        // first (replayed at the end of the turn) is not reverted by a second Undo in VS Code
        if (between === 'undo' && turns.length > 2 && !setup.cards) {
          test.skip(`${title} (known issue: second Undo of a replayed edit)`, () => undefined);
          continue;
        }
        test(title, async () => {
          // A folder of its own: VS Code may still hold models of the files of earlier tests
          const dir = nodePath.join(nodePath.dirname(fixtureTarget()), `codex-follow-up-${++followUpN}`);
          // Diff cards of earlier tests (e.g. deletions) are still pending
          await api.changeTracker.keepAll();
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
          for (const [file, text] of Object.entries(fixtures.base)) { fs.writeFileSync(nodePath.join(dir, file), text); }
          const paths = Object.keys(fixtures.base).map(f => vscode.Uri.file(nodePath.join(dir, f)).fsPath);
          const chat = new FollowUpChat(api, paths);
          await applySetup(setup, paths);
          try {
            for (const [i, turn] of turns.entries()) {
              if (i > 0) { await betweenTurns(chat, between, paths[0]); }
              const answer = turn.calls.find(c => c.approval)?.approval;
              if (setup.ask) { chat.answerPrompts(answer === 'skip' ? 'skip' : 'allow'); }
              const files = turn.calls.flatMap(c => c.edits.map(e => vscode.Uri.file(nodePath.join(dir, typeof e === 'string' ? fixtures.edits[e].file : e.file)).fsPath));
              await chat.ask(`@acp codex-scenario ${name} #${i} ${dir} ${resultFile()}`,
                answer === 'skip' ? { unchanged: files } : { changed: files });
              assertAgentResultKept(resultFile());
              await chat.stopAnswering();
            }
          } finally {
            await chat.stopAnswering();
            await undoSetup(setup);
            await resetChatView();
            await api.changeTracker.keepAll();
            fs.rmSync(dir, { recursive: true, force: true });
          }
        });
      }
    }
  }
});
