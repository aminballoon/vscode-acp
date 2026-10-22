import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { resetChatView } from './editSession';
import { BETWEEN_TURNS, FOLLOW_UP_SETUPS, FollowUpChat, applySetup, betweenTurns, undoSetup } from './followUpChat';
import { ORIGINAL, connectFakeAgent, fixtureTarget } from './helpers';

/**
 * Edit flows of test-fixtures/fake-agent.mjs: `edit` like claude-agent-acp
 * (the tool call is reported before the agent writes, then a permission
 * prompt), `late-edit` reported after writing, `shell-edit` by a terminal
 * command without diffs. Each turn sequence runs in one chat of the real
 * Chat view, with the user keeping, undoing, editing or leaving the changes
 * between turns.
 */
type Turn = { kind: 'edit' | 'late-edit' | 'shell-edit'; answer?: 'allow' | 'skip' };
const SEQUENCES: Record<string, Turn[]> = {
  'edit, then edit again': [{ kind: 'edit' }, { kind: 'edit' }],
  'edit three times': [{ kind: 'edit' }, { kind: 'edit' }, { kind: 'edit' }],
  'edit reported after writing, twice': [{ kind: 'late-edit' }, { kind: 'late-edit' }],
  'shell edit, twice': [{ kind: 'shell-edit' }, { kind: 'shell-edit' }],
  'edit, then edit reported after writing': [{ kind: 'edit' }, { kind: 'late-edit' }],
  'rejected edit, then approved': [{ kind: 'edit', answer: 'skip' }, { kind: 'edit', answer: 'allow' }],
};

suite('Claude-style edits in the real Chat view, turn after turn', function () {
  this.timeout(120_000);

  let api: AcpExtensionApi;
  let testN = 0;

  suiteSetup(async () => {
    api = await connectFakeAgent({ 'chat.nativeEdits': true, autoApprovePermissions: 'allowAll' });
  });

  for (const [name, turns] of Object.entries(SEQUENCES)) {
    for (const setup of FOLLOW_UP_SETUPS) {
      if (!setup.ask && turns.some(t => t.answer === 'skip')) { continue; }
      for (const between of BETWEEN_TURNS) {
        test(`${name}; ${between} between turns; ${setup.label}`, async () => {
          // A folder of its own: VS Code may still hold models of the files of earlier tests
          const dir = nodePath.join(nodePath.dirname(fixtureTarget()), `claude-scenario-${++testN}`);
          // Diff cards of earlier tests (e.g. deletions) are still pending
          await api.changeTracker.keepAll();
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
          const file = vscode.Uri.file(nodePath.join(dir, 'a.py')).fsPath;
          fs.writeFileSync(file, ORIGINAL);
          const chat = new FollowUpChat(api, [file]);
          await applySetup(setup, [file]);
          try {
            for (const [i, turn] of turns.entries()) {
              if (i > 0) { await betweenTurns(chat, between, file); }
              if (setup.ask) { chat.answerPrompts(turn.answer ?? 'allow'); }
              await chat.ask(`@acp ${turn.kind} ${file}`, turn.answer === 'skip' ? { unchanged: [file] } : { changed: [file] });
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
