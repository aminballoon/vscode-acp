import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChangeTracker } from '../changes/ChangeTracker';

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
		assert.ok(acpCommands.includes('acp.newConversation'), 'newConversation command should exist');
		assert.ok(acpCommands.includes('acp.openChat'), 'openChat command should exist');
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
});
