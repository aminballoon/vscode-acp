import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { liveEditSuite } from './liveEdits';

/**
 * Real Codex (@agentclientprotocol/codex-acp) through the real Chat view.
 * Uses the Codex account logged in on this machine and spends a little of
 * its quota. Opt-in: `npm run test:codex-live`. Set ACP_CODEX_ACP to test
 * another adapter build (e.g. `@agentclientprotocol/codex-acp@preview`).
 */
liveEditSuite({
  title: 'Codex (live test)',
  command: 'npx',
  args: ['-y', process.env.ACP_CODEX_ACP || '@agentclientprotocol/codex-acp@latest'],
  skipReason: () => {
    const home = process.env.CODEX_HOME || nodePath.join(os.homedir(), '.codex');
    return fs.existsSync(nodePath.join(home, 'auth.json')) || process.env.OPENAI_API_KEY ? undefined : 'Codex is not logged in (run `codex login`)';
  },
  rules: 'Edit the files with apply_patch only. Do not run commands, do not touch other files and do not explain.',
  deleteRule: 'Delete gone.py in the same patch.',
  // Read-only asks before every edit; "Auto review" edits workspace files without asking
  askingMode: 'read-only',
  defaultMode: 'agent',
});
