import * as vscode from 'vscode';

import { SessionManager } from '../core/SessionManager';
import { AgentStatusInfo, AgentStatusStore, UsageLimit } from '../core/AgentStatus';
import { getAgentNames } from '../config/AgentConfig';

type Node = GroupItem | AgentTreeItem | DetailItem;

class GroupItem extends vscode.TreeItem {
  constructor(readonly connected: boolean, count: number) {
    super(connected ? 'Connected' : 'Not connected',
      connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = connected ? 'group-connected' : 'group-disconnected';
    this.description = String(count);
    this.contextValue = 'agent-group';
  }
}

/** A configured agent; connect / disconnect / restart are inline and context actions. */
export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    public readonly connected: boolean,
    status: AgentStatusInfo | undefined,
    hasDetails: boolean,
  ) {
    super(agentName, hasDetails ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `agent-${agentName}`;
    if (connected) {
      this.contextValue = 'agent-connected';
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
      const name = status?.account?.label ?? status?.account?.email ?? 'connected';
      const worst = Object.values(status?.limits ?? {}).sort((a, b) => b.usedPercent - a.usedPercent)[0];
      this.description = worst ? `${name} · ${Math.round(worst.usedPercent)}%` : name;
      this.tooltip = agentTooltip(agentName, status);
    } else {
      this.contextValue = 'agent-disconnected';
      this.iconPath = new vscode.ThemeIcon('circle-outline');
      this.tooltip = `${agentName} — not connected\nClick to open an ACP chat`;
    }
    this.command = { command: 'acp.openChat', title: 'Open ACP Chat', arguments: [agentName] };
  }
}

class DetailItem extends vscode.TreeItem {
  constructor(agentName: string, label: string, value: string, icon: string | vscode.ThemeIcon, tooltip?: string | vscode.MarkdownString) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `agent-${agentName}-${label}`;
    this.description = value;
    this.iconPath = typeof icon === 'string' ? new vscode.ThemeIcon(icon) : icon;
    this.tooltip = tooltip ?? `${label}: ${value}`;
    this.contextValue = 'agent-detail';
  }
}

/** Green below 50%, yellow below 80%, red from 80% (or when the agent refused for the limit). */
function levelColor(pct: number, rejected = false): vscode.ThemeColor {
  return new vscode.ThemeColor(rejected || pct >= 80 ? 'charts.red' : pct >= 50 ? 'charts.yellow' : 'charts.green');
}

/** Text bar for the tree: `▰▰▰▱▱▱▱▱` (narrow in the tree's font, filled and empty easy to tell apart). */
function textBar(pct: number, cells = 8): string {
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(cells, Math.round(pct / 100 * cells)));
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

/** Green → yellow → red along the bar, so each filled cell gets the color of its position. */
const STOPS: Array<[number, number, number]> = [[0x2b, 0xb3, 0x9a], [0xe9, 0xc2, 0x4b], [0xe5, 0x48, 0x4d]];
function stepColor(t: number): string {
  const [from, to, f] = t < 0.5 ? [STOPS[0], STOPS[1], t * 2] : [STOPS[1], STOPS[2], (t - 0.5) * 2];
  return '#' + from.map((c, i) => Math.round(c + (to[i] - c) * f).toString(16).padStart(2, '0')).join('');
}

/** Colored bar for hover tooltips (VS Code allows `color:` styles on spans). */
function htmlBar(pct: number, cells = 24): string {
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(cells, Math.round(pct / 100 * cells)));
  let bar = '';
  for (let i = 0; i < filled; i++) { bar += `<span style="color:${stepColor(i / (cells - 1))};">█</span>`; }
  return bar + `<span style="color:#8080804d;">${'█'.repeat(cells - filled)}</span>`;
}

/** "in 1h 12m" / "in 3 days". */
function countdown(at: number): string {
  const min = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (min < 60) { return `in ${min}m`; }
  if (min < 48 * 60) { return `in ${Math.floor(min / 60)}h ${min % 60}m`; }
  return `in ${Math.round(min / 1440)} days`;
}

function limitMarkdown(l: UsageLimit): string {
  const pct = Math.round(l.usedPercent);
  const reset = l.resetsAt ? `\n\nResets ${new Date(l.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${countdown(l.resetsAt)})` : '';
  return `**${l.label}** — ${pct}% used${l.status === 'rejected' ? ' · limit reached' : ''}\n\n${htmlBar(pct)}${reset}`;
}

function markdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text);
  md.supportHtml = true;
  return md;
}

/** Hover card of a connected agent: account and every limit with a colored bar. */
function agentTooltip(agentName: string, s: AgentStatusInfo | undefined): vscode.MarkdownString {
  const parts = [`### ${agentName}`];
  const a = s?.account;
  if (a?.label || a?.email) { parts.push([a.label, a.email].filter(Boolean).join(' · ')); }
  for (const l of Object.values(s?.limits ?? {})) { parts.push(limitMarkdown(l)); }
  parts.push('_Click to open an ACP chat_');
  return markdown(parts.join('\n\n---\n\n'));
}

const compact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

/** "3:10 PM" today, else "Oct 12, 3:10 PM". */
function formatReset(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** What each connected agent reported: account, context window, cost, tokens. */
function details(agentName: string, s: AgentStatusInfo | undefined): DetailItem[] {
  if (!s) { return []; }
  const rows: DetailItem[] = [];
  const a = s.account;
  if (a?.email || a?.label) {
    rows.push(new DetailItem(agentName, 'Account', a.email ?? a.label!, 'account', [a.label, a.email].filter(Boolean).join(' — ')));
  }
  if (a?.plan) { rows.push(new DetailItem(agentName, 'Plan', a.plan, 'credit-card')); }
  for (const l of Object.values(s.limits ?? {})) {
    const pct = Math.round(l.usedPercent);
    const rejected = l.status === 'rejected' || pct >= 100;
    const resets = l.resetsAt ? `  ↻ ${formatReset(l.resetsAt)}` : '';
    rows.push(new DetailItem(agentName, l.label, `${pct}% ${textBar(pct)}${resets}`,
      new vscode.ThemeIcon(rejected ? 'error' : 'dashboard', levelColor(pct, rejected)), markdown(limitMarkdown(l))));
  }
  if (s.context) {
    const pct = s.context.size ? Math.round(s.context.used / s.context.size * 100) : 0;
    rows.push(new DetailItem(agentName, 'Context', `${pct}% ${textBar(pct)}  ${compact(s.context.used)} / ${compact(s.context.size)}`,
      new vscode.ThemeIcon('dashboard', levelColor(pct)),
      markdown(`**Context window** — ${pct}% used\n\n${htmlBar(pct)}\n\n${compact(s.context.used)} of ${compact(s.context.size)} tokens in the agent's latest session`)));
  }
  if (s.cost) {
    rows.push(new DetailItem(agentName, 'Cost', `${s.cost.amount.toFixed(2)} ${s.cost.currency}`, 'graph',
      'Cost the agent reported for its sessions since it connected'));
  }
  if (s.turns) {
    const turns = `${s.turns} turn${s.turns === 1 ? '' : 's'}`;
    rows.push(new DetailItem(agentName, 'Usage', s.tokens ? `${compact(s.tokens)} tokens · ${turns}` : turns, 'pulse',
      'Tokens the agent reported since it connected'));
  }
  if (s.version) { rows.push(new DetailItem(agentName, 'Version', `${s.title ?? ''} ${s.version}`.trim(), 'info')); }
  return rows;
}

/** The "Agents" view: connected agents with their status, then the other configured agents. */
export class AgentTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly sessionManager: SessionManager, private readonly status: AgentStatusStore) {
    sessionManager.on('agent-connected', () => this.refresh());
    sessionManager.on('agent-disconnected', () => this.refresh());
    status.on('changed', () => this.refresh());
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    const names = getAgentNames();
    const isConnected = (n: string) => this.sessionManager.isAgentConnected(n);
    if (!element) {
      const connected = names.filter(isConnected).length;
      return [new GroupItem(true, connected), new GroupItem(false, names.length - connected)];
    }
    if (element instanceof GroupItem) {
      return names.filter(n => isConnected(n) === element.connected)
        .map(n => new AgentTreeItem(n, element.connected, this.status.get(n),
          element.connected && details(n, this.status.get(n)).length > 0));
    }
    if (element instanceof AgentTreeItem && element.connected) {
      return details(element.agentName, this.status.get(element.agentName));
    }
    return [];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
