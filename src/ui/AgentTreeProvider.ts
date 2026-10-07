import * as vscode from 'vscode';

import { SessionManager } from '../core/SessionManager';
import { AgentStatusInfo, AgentStatusStore } from '../core/AgentStatus';
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
      this.description = status?.account?.label ?? status?.account?.email ?? 'connected';
    } else {
      this.contextValue = 'agent-disconnected';
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }
    this.command = { command: 'acp.openChat', title: 'Open ACP Chat', arguments: [agentName] };
    this.tooltip = `${agentName} — ${connected ? 'connected' : 'not connected'}\nClick to open an ACP chat`;
  }
}

class DetailItem extends vscode.TreeItem {
  constructor(agentName: string, label: string, value: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `agent-${agentName}-${label}`;
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip ?? `${label}: ${value}`;
    this.contextValue = 'agent-detail';
  }
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
  if (s.context) {
    const pct = s.context.size ? Math.round(s.context.used / s.context.size * 100) : 0;
    rows.push(new DetailItem(agentName, 'Context', `${compact(s.context.used)} / ${compact(s.context.size)} (${pct}%)`, 'dashboard',
      'Context window used by the agent\'s latest session'));
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
  for (const l of Object.values(s.limits ?? {})) {
    const pct = Math.round(l.usedPercent);
    const resets = l.resetsAt ? ` · resets ${formatReset(l.resetsAt)}` : '';
    const icon = l.status === 'rejected' || pct >= 100 ? 'error' : pct >= 80 ? 'warning' : 'watch';
    rows.push(new DetailItem(agentName, l.label, `${pct}% used${resets}`, icon,
      `${l.label}: ${pct}% used${l.resetsAt ? `, resets ${new Date(l.resetsAt).toLocaleString()}` : ''}`));
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
