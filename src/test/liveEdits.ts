import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AcpExtensionApi } from '../extension';
import { resetChatView } from './editSession';
import { FollowUpChat } from './followUpChat';
import { EXT_ID, fixtureTarget } from './helpers';

/** A real ACP agent, as the live suites drive it. */
export interface LiveAgent {
  /** Suite title and agent name in the settings. */
  title: string;
  command: string;
  args: string[];
  /** Why the suite is skipped (not logged in), or undefined to run it. */
  skipReason(): string | undefined;
  /** Appended to every prompt: which tools to edit with. */
  rules: string;
  /** How to delete a file with this agent's tools. */
  deleteRule: string;
  /** Session mode in which the agent asks before every edit, and the one it runs in otherwise. */
  askingMode: string;
  defaultMode: string;
}

const TURN_MS = 240_000;

/**
 * The same edit cases for every real agent, through the real Chat view: each
 * case is one chat, turn after turn, and after every turn VS Code must show
 * each changed file with a diff from its content when last kept or undone.
 */
export function liveEditSuite(agent: LiveAgent): void {
  suite(`Edits, live ${agent.title}`, function () {
    this.timeout(900_000);

    let api: AcpExtensionApi;
    const dir = () => nodePath.join(nodePath.dirname(fixtureTarget()), 'live-edits');
    const file = (name: string) => vscode.Uri.file(nodePath.join(dir(), name)).fsPath;
    const files = () => ['a.py', 'b.py', 'gone.py', 'new.py'].map(file);
    let chat: FollowUpChat;

    suiteSetup(async function () {
      const reason = agent.skipReason();
      if (reason) {
        console.log(`[live] ${agent.title} skipped: ${reason}`);
        this.skip();
      }
      api = await vscode.extensions.getExtension<AcpExtensionApi>(EXT_ID)!.activate();
      const config = vscode.workspace.getConfiguration('acp');
      await config.update('agents', {
        ...config.inspect<Record<string, unknown>>('agents')?.globalValue ?? {},
        [agent.title]: { command: agent.command, args: agent.args },
      }, vscode.ConfigurationTarget.Global);
      await config.update('chat.nativeEdits', true, vscode.ConfigurationTarget.Global);
      await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('acp.connectAgent', agent.title);
    });

    setup(async () => {
      // Diff cards (e.g. deletions) of earlier tests are still pending
      await api.changeTracker.keepAll();
      fs.rmSync(dir(), { recursive: true, force: true });
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(file('a.py'), 'import time\n\n\ndef main():\n    time.sleep(2)\n    print("hi")\n');
      fs.writeFileSync(file('b.py'), 'x = 1\ny = 2\n');
      fs.writeFileSync(file('gone.py'), '# to be deleted\n');
      chat = new FollowUpChat(api, files(), TURN_MS);
    });

    teardown(async () => {
      await chat.stopAnswering();
      const config = vscode.workspace.getConfiguration('acp');
      await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);
      await config.update('chat.nativeEdits', true, vscode.ConfigurationTarget.Global);
      await api.setActiveMode(agent.defaultMode).catch(() => undefined);
      await resetChatView();
      await api.changeTracker.keepAll();
      fs.rmSync(dir(), { recursive: true, force: true });
    });

    /** One turn of the chat; `changed` / `unchanged` are file names. */
    const ask = (instructions: string, expect: { changed?: string[]; unchanged?: string[] }, rules = agent.rules) =>
      chat.ask(`@acp In the directory ${dir()}: ${instructions} ${rules}`, {
        changed: expect.changed?.map(file), unchanged: expect.unchanged?.map(file),
      });
    const append = (line: string, ...names: string[]) =>
      `At the end of ${names.join(' and of ')}, add one line: ${line}`;

    /** Switch to the mode that asks before edits, prompts answered in the Chat view. */
    const askingInChatView = async () => {
      await vscode.workspace.getConfiguration('acp').update('autoApprovePermissions', 'ask', vscode.ConfigurationTarget.Global);
      await api.setActiveMode(agent.askingMode);
      for (const p of [file('a.py'), file('b.py')]) { await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false }); }
    };

    test('three files in one turn', () =>
      ask(`${append('# one', 'a.py', 'b.py')}. Delete nothing.`, { changed: ['a.py', 'b.py'] }));

    test('add and delete files, then edit the new file', async () => {
      await ask(`Create new.py containing print("new"). ${agent.deleteRule}`, { changed: ['new.py', 'gone.py'] }, agent.rules.replace(/Do not run commands[^.]*\./, ''));
      await chat.keep();
      await ask(append('# two', 'new.py'), { changed: ['new.py'] });
    });

    test('keep between turns, the same files again and again', async () => {
      await ask(append('# turn 1', 'a.py'), { changed: ['a.py'] });
      await chat.keep();
      await ask(append('# turn 2', 'a.py', 'b.py'), { changed: ['a.py', 'b.py'] });
      await chat.keep();
      await ask(append('# turn 3', 'a.py'), { changed: ['a.py'], unchanged: ['b.py'] });
    });

    test('undo between turns', async () => {
      await ask(append('# turn 1', 'a.py'), { changed: ['a.py'] });
      await chat.undo();
      await ask(append('# turn 2', 'a.py'), { changed: ['a.py'] });
    });

    test('changes left pending between turns', async () => {
      await ask(append('# turn 1', 'a.py'), { changed: ['a.py'] });
      await ask(append('# turn 2', 'a.py'), { changed: ['a.py'] });
    });

    test('the user edits the file between turns', async () => {
      await ask(append('# turn 1', 'a.py'), { changed: ['a.py'] });
      await chat.keep();
      await chat.userEdit(file('a.py'), text => text + '# by the user\n');
      await ask(append('# turn 2', 'a.py'), { changed: ['a.py'] });
    });

    test('asked before every edit, approved in the Chat view, files open', async () => {
      await askingInChatView();
      chat.answerPrompts('allow');
      await ask(append('# turn 1', 'a.py'), { changed: ['a.py'] });
      await chat.keep();
      await ask(append('# turn 2', 'a.py', 'b.py'), { changed: ['a.py', 'b.py'] });
      await chat.keep();
      await ask(append('# turn 3', 'a.py'), { changed: ['a.py'] });
    });

    test('rejected in the Chat view, then approved', async () => {
      await askingInChatView();
      chat.answerPrompts('skip');
      await ask(`${append('# rejected', 'a.py')}. If the edit is not allowed, stop and do not retry.`, { unchanged: ['a.py'] });
      chat.answerPrompts('allow');
      await ask(append('# approved', 'a.py'), { changed: ['a.py'] });
    });

    test('diff cards instead of native edits, kept between turns', async () => {
      await vscode.workspace.getConfiguration('acp').update('chat.nativeEdits', false, vscode.ConfigurationTarget.Global);
      await ask(append('# turn 1', 'a.py'), { changed: ['a.py'] });
      await chat.keep();
      await ask(append('# turn 2', 'a.py'), { changed: ['a.py'] });
    });
  });
}
