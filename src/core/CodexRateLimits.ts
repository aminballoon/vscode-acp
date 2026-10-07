import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import type { UsageLimit } from './AgentStatus';

/** How far back to look for a session's rollout file (day directories). */
const MAX_DAYS = 45;
/** Rate limits are near the end of a rollout; only read its tail. */
const TAIL_BYTES = 512 * 1024;

interface CodexWindow { used_percent?: number; window_minutes?: number; resets_at?: number }

function windowLabel(minutes: number | undefined): string {
  if (!minutes) { return 'Limit'; }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 7 ? 'Weekly limit' : `${days}-day limit`;
  }
  return minutes % 60 === 0 ? `${minutes / 60}-hour limit` : `${minutes}-minute limit`;
}

/** Day directories of ~/.codex/sessions (YYYY/MM/DD), newest first. */
async function dayDirs(root: string): Promise<string[]> {
  const sorted = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).filter(n => /^\d+$/.test(n)).sort().reverse();
  const out: string[] = [];
  for (const y of await sorted(root)) {
    for (const m of await sorted(nodePath.join(root, y))) {
      for (const d of await sorted(nodePath.join(root, y, m))) {
        out.push(nodePath.join(root, y, m, d));
        if (out.length >= MAX_DAYS) { return out; }
      }
    }
  }
  return out;
}

/** The rollout of a session, or the most recent rollout when no session is given. */
async function findRollout(root: string, sessionId?: string): Promise<string | undefined> {
  for (const dir of await dayDirs(root)) {
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')).sort().reverse();
    const match = sessionId ? files.find(f => f.includes(sessionId)) : files[0];
    if (match) { return nodePath.join(dir, match); }
  }
  return undefined;
}

async function tail(path: string): Promise<string> {
  const handle = await fs.open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Codex records the account's rate limits in each session's rollout file
 * (`token_count` events). codex-acp does not forward them over ACP, so read
 * the latest ones from the session's rollout under $CODEX_HOME/sessions.
 */
export async function readCodexRateLimits(sessionId?: string): Promise<UsageLimit[] | undefined> {
  const home = process.env.CODEX_HOME || nodePath.join(os.homedir(), '.codex');
  try {
    const file = await findRollout(nodePath.join(home, 'sessions'), sessionId);
    if (!file) { return undefined; }
    const lines = (await tail(file)).split('\n').filter(l => l.includes('"rate_limits"')).reverse();
    for (const line of lines) {
      let limits: { primary?: CodexWindow | null; secondary?: CodexWindow | null } | undefined;
      try {
        const event = JSON.parse(line);
        limits = event?.payload?.rate_limits ?? event?.payload?.info?.rate_limits ?? event?.rate_limits;
      } catch {
        continue; // the first line of the tail may be cut off
      }
      if (!limits) { continue; }
      return [limits.primary, limits.secondary].filter((w): w is CodexWindow => !!w && w.used_percent !== undefined).map(w => ({
        label: windowLabel(w.window_minutes),
        usedPercent: w.used_percent!,
        resetsAt: w.resets_at ? w.resets_at * 1000 : undefined,
      }));
    }
  } catch {
    // no Codex home, unreadable rollout
  }
  return undefined;
}
