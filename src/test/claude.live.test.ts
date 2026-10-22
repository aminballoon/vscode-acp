import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { liveEditSuite } from './liveEdits';

/**
 * Real Claude Code (@agentclientprotocol/claude-agent-acp) through the real
 * Chat view. Uses the Claude account logged in on this machine (`claude`)
 * and spends a little of its usage. Opt-in: `npm run test:claude-live`. Set
 * ACP_CLAUDE_ACP to test another adapter build.
 */
liveEditSuite({
  title: 'Claude Code (live test)',
  command: 'npx',
  args: ['-y', process.env.ACP_CLAUDE_ACP || '@agentclientprotocol/claude-agent-acp@latest'],
  skipReason: () => fs.existsSync(nodePath.join(os.homedir(), '.claude.json')) || process.env.ANTHROPIC_API_KEY
    ? undefined : 'Claude Code is not logged in (run `claude`)',
  rules: 'Edit the files with the Edit or Write tool only. Do not run commands, do not touch other files and do not explain.',
  deleteRule: 'Delete gone.py with `rm gone.py`.',
  // "default" asks before edits; the client answers (auto-approve, or the Chat view)
  askingMode: 'default',
  defaultMode: 'default',
});
