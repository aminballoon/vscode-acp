import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChangeTracker } from '../changes/ChangeTracker';
import { contentBeforeDiffs } from '../changes/diffUtil';
import { hasChatSessions, isSameMinor, testedVsCodeMinor } from '../chat/proposed';
import { buildDebugReport } from '../utils/DebugReport';
import { fingerprint, log, logTraffic } from '../utils/Logger';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('aminballoon.acp-chat'));
	});

	test('Should activate extension', async () => {
		const ext = vscode.extensions.getExtension('aminballoon.acp-chat');
		assert.ok(ext);
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('Should register ACP commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		const acpCommands = commands.filter(c => c.startsWith('acp.'));
		assert.ok(acpCommands.length > 0, 'ACP commands should be registered');
		assert.ok(acpCommands.includes('acp.connectAgent'), 'connectAgent command should exist');
		assert.ok(!acpCommands.includes('acp.newConversation'), 'the sidebar chat webview and its commands are gone');
		assert.ok(acpCommands.includes('acp.openChat'), 'openChat command should exist');
	});

	test('Tested VS Code release comes from engines.vscode', () => {
		assert.strictEqual(testedVsCodeMinor('^1.143.0'), '1.143');
		assert.strictEqual(testedVsCodeMinor(''), undefined);
		assert.ok(isSameMinor('1.143.1', '1.143'));
		assert.ok(isSameMinor('1.143.0-insider', '1.143'));
		assert.ok(!isSameMinor('1.144.0', '1.143'));
		assert.ok(!isSameMinor('1.1430.0', '1.143'));
	});

	test('Chat sessions API is detected in this VS Code', () => {
		assert.strictEqual(hasChatSessions(), true);
	});

	test('Undo refuses to overwrite user edits unless forced', async () => {
		const files = new Map<string, string>([['file.txt', 'original']]);
		const values = new Map<string, unknown>();
		const tracker = new ChangeTracker({
			read: async path => files.get(path) ?? null,
			readDisk: async path => files.get(path) ?? null,
			write: async (path, content) => { files.set(path, content); },
			remove: async path => { files.delete(path); },
		}, {
			get: <T>(key: string) => values.get(key) as T | undefined,
			update: async (key, value) => { values.set(key, value); },
		});

		await tracker.beforeAgentWrite('file.txt', 'agent version');
		files.set('file.txt', 'user version');

		assert.deepStrictEqual(await tracker.undo('file.txt'), { undone: false, userEdited: true });
		assert.strictEqual(files.get('file.txt'), 'user version');

		assert.deepStrictEqual(await tracker.undo('file.txt', true), { undone: true, userEdited: true });
		assert.strictEqual(files.get('file.txt'), 'original');
	});

	test('Pre-edit content is rebuilt from the diffs an edit tool call reported', () => {
		const update = (oldText: string, newText: string) => ({ oldText, newText, _meta: { kind: 'update' } });
		// Codex sends one block per hunk, with context lines
		assert.strictEqual(contentBeforeDiffs(
			[update('a\nb\n', 'a\nB\n'), update('d\ne\n', 'd\nE\nE2\n')],
			'a\nB\nc\nd\nE\nE2\n',
		), 'a\nb\nc\nd\ne\n');
		// A rewrite is a delete followed by an add of the same file
		assert.strictEqual(contentBeforeDiffs(
			[{ oldText: 'old\n', newText: '', _meta: { kind: 'delete' } }, { oldText: null, newText: 'new\n', _meta: { kind: 'add' } }],
			'new\n',
		), 'old\n');
		assert.strictEqual(contentBeforeDiffs([{ oldText: null, newText: 'x\n' }], 'x\n'), null, 'added file did not exist');
		assert.strictEqual(contentBeforeDiffs([update('a\n', 'b\n')], 'c\n'), undefined, 'file changed again since');
	});

	test('Debug report: log without file contents, traffic only on request, no env values', async () => {
		const config = vscode.workspace.getConfiguration('acp');
		const agents = config.inspect<Record<string, unknown>>('agents')?.globalValue;
		await config.update('agents', { 'Report Agent': { command: 'npx', args: ['some-acp'], env: { SECRET_KEY: 'sk-do-not-leak' } } }, vscode.ConfigurationTarget.Global);
		try {
			log(`[edits] report test ${fingerprint('file body')}`);
			logTraffic('recv', { jsonrpc: '2.0', method: 'session/update', params: { marker: 'traffic-marker' } });
			const sources = { agents: () => [{ name: 'Report Agent', info: { name: 'report-agent', version: '9.9.9' } }], pendingChanges: () => ['/tmp/x.py'] };
			const report = buildDebugReport(sources, false);
			assert.ok(report.includes(`[edits] report test ${fingerprint('file body')}`), 'recent log');
			assert.ok(!report.includes('file body'), 'file content only as a fingerprint');
			assert.ok(report.includes('Report Agent: npx some-acp (env: SECRET_KEY) — connected: report-agent 9.9.9'), report);
			assert.ok(!report.includes('sk-do-not-leak'), 'env values stay out');
			assert.ok(report.includes('/tmp/x.py'), 'pending diff cards');
			assert.ok(!report.includes('traffic-marker'), 'no traffic unless asked');
			assert.ok(buildDebugReport(sources, true).includes('traffic-marker'), 'traffic when asked');
		} finally {
			await config.update('agents', agents, vscode.ConfigurationTarget.Global);
		}
	});
});
