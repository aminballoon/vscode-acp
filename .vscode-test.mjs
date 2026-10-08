import { defineConfig } from '@vscode/test-cli';
import { execSync } from 'node:child_process';

const node = execSync('/bin/zsh -l -c "command -v node"').toString().trim();

export default defineConfig([
	{
		label: 'unit',
		files: ['out/test/extension.test.js', 'out/test/skills.test.js', 'out/test/activity.test.js'],
	},
	{
		// Runs against the locally installed VS Code so proposed APIs and the
		// native Chat view behave like the user's setup.
		label: 'e2e',
		files: ['out/test/chat.e2e.test.js', 'out/test/codex.e2e.test.js'],
		useInstallation: { fromPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
		workspaceFolder: './test-fixtures/ws',
		launchArgs: [
			'--enable-proposed-api=aminballoon.acp-chat',
			'--disable-extension=formulahendry.acp-client',
		],
		env: { ACP_E2E_NODE: node },
		mocha: { ui: 'tdd', timeout: 120000 },
	},
	{
		// Drives the real Chat view; see scripts/ui-test.sh for screenshots.
		label: 'ui',
		extensionDevelopmentPath: ['.', './test-fixtures/fake-lm'],
		files: ['out/test/chat.sessions.ui.test.js', 'out/test/chat.ui.test.js'],
		useInstallation: { fromPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
		workspaceFolder: './test-fixtures/ws',
		launchArgs: [
			'--enable-proposed-api=aminballoon.acp-chat',
			'--disable-extension=formulahendry.acp-client',
		],
		env: { ACP_E2E_NODE: node, ACP_UI_SIGNAL_DIR: process.env.ACP_UI_SIGNAL_DIR ?? '', ACP_UI_NATIVE: process.env.ACP_UI_NATIVE ?? '1' },
		mocha: { ui: 'tdd', timeout: 180000 },
	},
	{
		// Codex edit turns through the real Chat view; checks VS Code's own editing session.
		label: 'ui-codex',
		extensionDevelopmentPath: ['.', './test-fixtures/fake-lm'],
		files: 'out/test/codex.ui.test.js',
		useInstallation: { fromPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
		workspaceFolder: './test-fixtures/ws',
		launchArgs: [
			'--enable-proposed-api=aminballoon.acp-chat',
			'--disable-extension=formulahendry.acp-client',
		],
		env: { ACP_E2E_NODE: node },
		mocha: { ui: 'tdd', timeout: 180000 },
	},
	{
		// Real Codex (codex-acp) through the real Chat view. Opt-in: uses the Codex account.
		label: 'codex-live',
		extensionDevelopmentPath: ['.', './test-fixtures/fake-lm'],
		files: 'out/test/codex.live.test.js',
		useInstallation: { fromPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
		workspaceFolder: './test-fixtures/ws',
		launchArgs: [
			'--enable-proposed-api=aminballoon.acp-chat',
			'--disable-extension=formulahendry.acp-client',
		],
		env: { ACP_E2E_NODE: node, ACP_CODEX_ACP: process.env.ACP_CODEX_ACP ?? '' },
		mocha: { ui: 'tdd', timeout: 600000 },
	},
]);
