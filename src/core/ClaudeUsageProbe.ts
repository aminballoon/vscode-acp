import * as fs from 'node:fs/promises';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import type { UsageLimit } from './AgentStatus';
import type { SessionManager } from './SessionManager';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { log, logError } from '../utils/Logger';

const PROBE_TIMEOUT_MS = 20_000;
/** Don't ask more often than this per agent. */
const MIN_INTERVAL_MS = 60_000;

/** "Weekly · all models" → "Weekly limit"; other labels stay as Claude names them. */
function limitLabel(label: string): string {
  return label === 'Weekly · all models' ? 'Weekly limit' : label;
}

/** "Oct 7, 3:00 PM GMT+7" (no year) → epoch ms of the next such moment. */
function parseReset(text: string): number | undefined {
  const now = new Date();
  const at = Date.parse(text.replace(/^(\w{3} \d{1,2}),/, `$1, ${now.getFullYear()},`));
  if (Number.isNaN(at)) { return undefined; }
  // A reset is in the future: a date that looks past belongs to next year
  return at < now.getTime() - 86_400_000 ? Date.parse(text.replace(/^(\w{3} \d{1,2}),/, `$1, ${now.getFullYear() + 1},`)) : at;
}

/** Limits in claude-agent-acp's structured `/usage` reply: `**5-hour limit** — **42%** · Resets Oct 7, 3:00 PM GMT+7`. */
export function parseUsageMarkdown(markdown: string): UsageLimit[] {
  const limits: UsageLimit[] = [];
  for (const m of markdown.matchAll(/^\*\*(.+?)\*\* — \*\*(\d+(?:\.\d+)?)%\*\*(?: · Resets (.+))?$/gm)) {
    const label = limitLabel(m[1].replace(/\\(.)/g, '$1'));
    limits.push({ label, usedPercent: Number(m[2]), resetsAt: m[3] ? parseReset(m[3].trim()) : undefined });
  }
  return limits;
}

/**
 * Reads Claude Code's plan usage limits (five-hour, weekly) by sending `/usage`,
 * which claude-agent-acp answers locally from the SDK's usage API without a
 * model call. It runs in a side session whose cwd is in the extension's storage,
 * so it never shows up in the workspace's sessions or a chat's conversation;
 * the same side session is resumed each time.
 */
export class ClaudeUsageProbe {
  /** Side session ids: their updates must not count as the agent's usage. */
  readonly sessionIds = new Set<string>();
  private lastRun = new Map<string, number>();
  private running = new Set<string>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly cwd: string,
    private readonly state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> },
  ) {}

  /** Limits of the agent's account, or undefined when unavailable or asked too recently. */
  async read(agentName: string, force = false): Promise<UsageLimit[] | undefined> {
    const last = this.lastRun.get(agentName) ?? 0;
    if (this.running.has(agentName) || (!force && Date.now() - last < MIN_INTERVAL_MS)) { return undefined; }
    this.running.add(agentName);
    this.lastRun.set(agentName, Date.now());
    try {
      const conn = await this.sessionManager.ensureConnected(agentName);
      const sessionId = await this.sideSession(agentName, conn.connection);
      let text = '';
      const listener = (n: SessionNotification) => {
        if (n.sessionId === sessionId && n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text') {
          text += n.update.content.text;
        }
      };
      this.sessionUpdateHandler.addListener(listener);
      try {
        await Promise.race([
          conn.connection.prompt({ sessionId, prompt: [{ type: 'text', text: '/usage' }] }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), PROBE_TIMEOUT_MS)),
        ]);
      } finally {
        this.sessionUpdateHandler.removeListener(listener);
      }
      const limits = parseUsageMarkdown(text);
      log(`Claude usage: ${limits.map(l => `${l.label} ${l.usedPercent}%`).join(', ') || 'no limits in /usage reply'}`);
      return limits.length ? limits : undefined;
    } catch (e) {
      logError(`Claude usage probe failed for ${agentName}`, e);
      return undefined;
    } finally {
      this.running.delete(agentName);
    }
  }

  private async sideSession(agentName: string, connection: Awaited<ReturnType<SessionManager['ensureConnected']>>['connection']): Promise<string> {
    const key = `acp.usageProbeSession.${agentName}`;
    const known = this.state.get<string>(key);
    if (known && this.sessionIds.has(known)) { return known; }
    await fs.mkdir(this.cwd, { recursive: true });
    if (known && this.sessionManager.getCachedCapabilities(agentName)?.resume) {
      try {
        await connection.resumeSession({ sessionId: known, cwd: this.cwd, mcpServers: [] });
        this.sessionIds.add(known);
        return known;
      } catch {
        // gone: start a new one
      }
    }
    const { sessionId } = await connection.newSession({ cwd: this.cwd, mcpServers: [] });
    this.sessionIds.add(sessionId);
    await this.state.update(key, sessionId);
    return sessionId;
  }
}
