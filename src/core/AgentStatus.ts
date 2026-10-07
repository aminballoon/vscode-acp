import { EventEmitter } from 'node:events';
import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk';

export interface AgentAccount {
  /** E.g. "ChatGPT Free". */
  label?: string;
  email?: string;
  plan?: string;
}

/** A usage limit window of the agent's account (e.g. the five-hour limit). */
export interface UsageLimit {
  label: string;
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
  /** E.g. "rejected" once the limit is reached (Claude). */
  status?: string;
}

/** What a connected agent has told us about itself, its account and its usage. */
export interface AgentStatusInfo {
  title?: string;
  version?: string;
  account?: AgentAccount;
  /** Context window of the agent's latest session (usage_update). */
  context?: { used: number; size: number };
  /** Cost reported by the agent, summed over its sessions (usage_update). */
  cost?: { amount: number; currency: string };
  /** Tokens reported at the end of each turn since the agent connected. */
  tokens: number;
  /** Turns since the agent connected. */
  turns: number;
  /** Usage limits of the account, by label. */
  limits?: Record<string, UsageLimit>;
}

const CLAUDE_LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly Opus limit',
  seven_day_sonnet: 'Weekly Sonnet limit',
  seven_day_overage_included: 'Weekly limit (incl. extra usage)',
  overage: 'Extra usage',
};

/**
 * Collects per-agent status from what ACP agents send: agent info from
 * `initialize`, usage_update notifications, the usage of prompt responses and
 * agent extensions: `_auth/status_update` (account / plan, codex-acp and
 * claude-agent-acp) and `_claude/sdkMessage` rate limit events. Codex rate
 * limits come from its rollout files (see CodexRateLimits).
 */
export class AgentStatusStore extends EventEmitter {
  private status = new Map<string, AgentStatusInfo>();
  /** Latest cost per session: usage_update carries the session total, not a delta. */
  private sessionCost = new Map<string, { agentName: string; amount: number; currency: string }>();

  get(agentName: string): AgentStatusInfo | undefined {
    return this.status.get(agentName);
  }

  private entry(agentName: string): AgentStatusInfo {
    let s = this.status.get(agentName);
    if (!s) {
      s = { tokens: 0, turns: 0 };
      this.status.set(agentName, s);
    }
    return s;
  }

  private changed(agentName: string): void {
    this.emit('changed', agentName);
  }

  noteConnected(agentName: string, info: { title?: string | null; version?: string | null } | undefined): void {
    const s = this.entry(agentName);
    s.title = info?.title ?? undefined;
    s.version = info?.version ?? undefined;
    this.changed(agentName);
  }

  noteDisconnected(agentName: string): void {
    this.status.delete(agentName);
    for (const [id, c] of this.sessionCost) { if (c.agentName === agentName) { this.sessionCost.delete(id); } }
    this.changed(agentName);
  }

  /** Agent extension notifications (method names start with `_`). */
  noteExtNotification(agentName: string, method: string, params: Record<string, unknown>): void {
    if (method === '_claude/sdkMessage') {
      const message = params.message as { type?: string; rate_limit_info?: Record<string, unknown> } | undefined;
      if (message?.type === 'rate_limit_event' && message.rate_limit_info) { this.noteClaudeRateLimit(agentName, message.rate_limit_info); }
      return;
    }
    if (method !== '_auth/status_update') { return; }
    const status = params.authStatus as { label?: string; account?: { email?: string; plan?: string } } | undefined;
    if (!status) { return; }
    this.entry(agentName).account = {
      label: status.label, email: status.account?.email, plan: status.account?.plan,
    };
    this.changed(agentName);
  }

  noteSessionUpdate(agentName: string, n: SessionNotification): void {
    const u = n.update;
    if (u.sessionUpdate !== 'usage_update') { return; }
    const s = this.entry(agentName);
    s.context = { used: u.used, size: u.size };
    if (u.cost) {
      this.sessionCost.set(n.sessionId, { agentName, amount: u.cost.amount, currency: u.cost.currency });
      const costs = [...this.sessionCost.values()].filter(c => c.agentName === agentName);
      s.cost = { amount: costs.reduce((sum, c) => sum + c.amount, 0), currency: u.cost.currency };
    }
    this.changed(agentName);
  }

  /** claude-agent-acp forwards the SDK's rate_limit_event (utilization 0–1, resetsAt in epoch seconds). */
  private noteClaudeRateLimit(agentName: string, info: Record<string, unknown>): void {
    const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'five_hour';
    const utilization = typeof info.utilization === 'number' ? info.utilization : undefined;
    const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : undefined;
    if (utilization === undefined && info.status === undefined) { return; }
    const label = CLAUDE_LIMIT_LABELS[type] ?? type;
    const percent = utilization === undefined ? (info.status === 'rejected' ? 100 : 0) : utilization <= 1 ? utilization * 100 : utilization;
    this.noteLimits(agentName, [{
      label, usedPercent: percent,
      resetsAt: resetsAt === undefined ? undefined : resetsAt < 1e12 ? resetsAt * 1000 : resetsAt,
      status: typeof info.status === 'string' ? info.status : undefined,
    }]);
  }

  /** Merge limit windows (a newer report of a window replaces the older one). */
  noteLimits(agentName: string, limits: UsageLimit[]): void {
    if (!limits.length) { return; }
    const s = this.entry(agentName);
    s.limits = { ...s.limits, ...Object.fromEntries(limits.map(l => [l.label, l])) };
    this.changed(agentName);
  }

  notePromptResponse(agentName: string, response: PromptResponse): void {
    const s = this.entry(agentName);
    s.turns++;
    s.tokens += response.usage?.totalTokens ?? 0;
    this.changed(agentName);
  }
}
