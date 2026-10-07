import * as vscode from 'vscode';

import { AgentManager } from './core/AgentManager';
import { ConnectionManager } from './core/ConnectionManager';
import { SessionManager } from './core/SessionManager';
import { SessionHistoryStore } from './core/SessionHistoryStore';
import { ChangeTracker } from './changes/ChangeTracker';
import { VsCodeFileIO } from './changes/VsCodeFileIO';
import { registerChangesView } from './changes/ChangesView';
import { TurnRouter } from './chat/TurnRouter';
import { PermissionTool, PERMISSION_TOOL } from './chat/PermissionTool';
import { registerChatParticipant } from './chat/AcpChatParticipant';
import { registerAcpChatSessions } from './chat/AcpChatSessions';
import type { StoredChat } from './chat/AcpChatStore';
import { SessionUpdateHandler } from './handlers/SessionUpdateHandler';
import { AgentTreeProvider } from './ui/AgentTreeProvider';
import { AgentStatusInfo, AgentStatusStore } from './core/AgentStatus';
import { readCodexRateLimits } from './core/CodexRateLimits';
import { ClaudeUsageProbe } from './core/ClaudeUsageProbe';
import { StatusBarManager } from './ui/StatusBarManager';
import { getAgentNames } from './config/AgentConfig';
import { fetchRegistry } from './config/RegistryClient';
import { log, logError, disposeChannels, getOutputChannel, getTrafficChannel } from './utils/Logger';
import { initTelemetry, sendEvent } from './utils/TelemetryManager';

/** Exposed for integration tests. */
export interface AcpExtensionApi {
  changeTracker: ChangeTracker;
  chatHandler: vscode.ChatRequestHandler;
  chatRequestCount(): number;
  /** Request handler of the "ACP" chat session type (applies picker selections first). */
  acpSessionHandler: vscode.ChatRequestHandler;
  /** Config options of the active ACP session. */
  activeConfigOptions(): unknown[] | null;
  /** Saved ACP chats. */
  acpChats(): StoredChat[];
  /** Names of the agents currently connected. */
  connectedAgents(): string[];
  /** Disconnect ACP chat agents idle for `maxIdleMs` (what the idle timer does). */
  disconnectIdleAgents(maxIdleMs: number): Promise<string[]>;
  /** Account and usage an agent reported. */
  agentStatus(agentName: string): AgentStatusInfo | undefined;
  /** What the chat sessions list shows, including agent sessions not owned by a chat. */
  listAcpChats(): Promise<StoredChat[]>;
  /** Open a listed chat (loads an imported agent session's history). */
  openAcpChat(id: string): Promise<StoredChat | undefined>;
}

export function activate(context: vscode.ExtensionContext): AcpExtensionApi {
  log('ACP Client extension activating...');

  // --- Telemetry ---
  const telemetryReporter = initTelemetry();
  context.subscriptions.push(telemetryReporter);

  // --- Core services ---
  const sessionUpdateHandler = new SessionUpdateHandler();
  const agentManager = new AgentManager();
  const fileIO = new VsCodeFileIO();
  const changeTracker = new ChangeTracker(fileIO, context.workspaceState, log);
  const permissionTool = new PermissionTool();
  context.subscriptions.push(vscode.lm.registerTool(PERMISSION_TOOL, permissionTool));
  const turnRouter = new TurnRouter(changeTracker, permissionTool);
  const connectionManager = new ConnectionManager(sessionUpdateHandler, {
    changeTracker,
    turnRouter,
    // In a chat turn: native confirmation; otherwise PermissionHandler falls back to a QuickPick
    permissionPrompter: params => turnRouter.requestPermission(params),
  });
  const sessionManager = new SessionManager(
    agentManager,
    connectionManager,
    sessionUpdateHandler,
  );

  // Agent sessions created in this workspace, listed in the chat sessions view
  // for agents that cannot list their sessions themselves (session/list)
  const historyStore = new SessionHistoryStore(context.workspaceState);
  sessionManager.setHistoryStore(historyStore);
  context.subscriptions.push({ dispose: () => historyStore.dispose() });

  // What agents report about their account and usage, shown in the Agents view
  const agentStatus = new AgentStatusStore();
  connectionManager.onExtNotification = (agentId, method, params) => {
    const name = agentManager.getAgent(agentId)?.name;
    if (name) { agentStatus.noteExtNotification(name, method, params); }
  };
  // Codex keeps its rate limits in its own session files, not in ACP messages
  const isCodex = (name: string) => /codex/i.test(sessionManager.getAgentSession(name)?.initResponse.agentInfo?.name ?? name);
  // Claude Code answers `/usage` (plan limits) locally; asked in a hidden side session
  const isClaude = (name: string) => /claude/i.test(sessionManager.getAgentSession(name)?.initResponse.agentInfo?.name ?? name);
  const claudeUsage = new ClaudeUsageProbe(
    sessionManager, sessionUpdateHandler, vscode.Uri.joinPath(context.globalStorageUri, 'usage-probe').fsPath, context.globalState);
  const refreshLimits = (name: string, sessionId?: string, force = false) => {
    if (!sessionManager.isAgentConnected(name)) { return; }
    if (isCodex(name)) {
      void readCodexRateLimits(sessionId).then(limits => { if (limits) { agentStatus.noteLimits(name, limits); } });
    } else if (isClaude(name)) {
      void claudeUsage.read(name, force).then(limits => { if (limits) { agentStatus.noteLimits(name, limits); } });
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand('acp.refreshUsage', (item?: { agentName?: string }) => {
    for (const name of item?.agentName ? [item.agentName] : sessionManager.getConnectedAgentNames()) { refreshLimits(name, undefined, true); }
  }));
  sessionManager.on('agent-connected', (name: string) => {
    agentStatus.noteConnected(name, sessionManager.getAgentSession(name)?.initResponse.agentInfo ?? undefined);
    refreshLimits(name);
  });
  sessionManager.on('agent-disconnected', (name: string) => agentStatus.noteDisconnected(name));
  sessionManager.on('prompt-response', (name: string, response, sessionId: string) => {
    agentStatus.notePromptResponse(name, response);
    refreshLimits(name, sessionId);
  });
  sessionUpdateHandler.addListener(n => {
    const name = sessionManager.getSession(n.sessionId)?.agentName;
    if (name) { agentStatus.noteSessionUpdate(name, n); }
  });
  // Session state the agent pushes: slash commands / skills, config options and title
  sessionUpdateHandler.addListener(({ sessionId, update }) => {
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        sessionManager.applyAvailableCommands(sessionId, update.availableCommands ?? []);
        break;
      case 'config_option_update':
        sessionManager.applyConfigOptions(sessionId, update.configOptions ?? []);
        break;
      case 'session_info_update':
        sessionManager.applySessionInfoUpdate(sessionId, update);
        break;
    }
  });

  // --- UI ---
  const agentTreeProvider = new AgentTreeProvider(sessionManager, agentStatus);
  const treeView = vscode.window.createTreeView('acp-sessions', { treeDataProvider: agentTreeProvider });

  const chatParticipant = registerChatParticipant(context, sessionManager, sessionUpdateHandler, turnRouter, changeTracker);
  // "ACP" chat session type: agent / model / effort / permission pickers in the Chat input
  const acpSessions = registerAcpChatSessions(context, sessionManager, sessionUpdateHandler, turnRouter, chatParticipant.runTurn);

  const statusBarManager = new StatusBarManager(sessionManager);

  // --- Pending changes (Keep / Undo) ---
  registerChangesView(context, changeTracker, fileIO);

  // --- Commands ---

  // Connect to Agent (primary action — inline icon in tree or pick from list)
  const connectAgentCmd = vscode.commands.registerCommand('acp.connectAgent', async (agentNameOrItem?: string | any) => {
    // Handle tree item object or string
    let agentName: string | undefined;
    if (typeof agentNameOrItem === 'string') {
      agentName = agentNameOrItem;
    } else if (agentNameOrItem?.agentName) {
      agentName = agentNameOrItem.agentName;
    }

    if (!agentName) {
      const agentNames = getAgentNames();
      if (agentNames.length === 0) {
        vscode.window.showWarningMessage(
          'No ACP agents configured. Add agents in Settings > ACP > Agents.',
        );
        return;
      }
      agentName = await vscode.window.showQuickPick(agentNames, {
        placeHolder: 'Select an agent to connect',
        title: 'Connect to Agent',
      });
      if (!agentName) { return; }
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to ${agentName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.connectToAgent(agentName!, { exclusive: false });
        },
      );
    } catch (e: any) {
      logError('Failed to connect to agent', e);
      vscode.window.showErrorMessage(`Failed to connect: ${e.message}`);
    }
  });

  // Disconnect Agent
  const disconnectAgentCmd = vscode.commands.registerCommand('acp.disconnectAgent', async (item?: any) => {
    const agentName = item?.agentName || sessionManager.getActiveAgentName();
    if (!agentName) {
      vscode.window.showInformationMessage('No agent connected.');
      return;
    }
    await sessionManager.disconnectAgent(agentName);
    vscode.window.showInformationMessage(`Disconnected from ${agentName}.`);
  });

  // Open a new ACP chat in the Chat view, optionally with an agent preselected
  const openChatCmd = vscode.commands.registerCommand('acp.openChat', async (arg?: string | { agentName?: string }) => {
    const agentName = typeof arg === 'string' ? arg : arg?.agentName;
    if (agentName) { acpSessions.preferAgent(agentName); }
    await vscode.commands.executeCommand('workbench.action.chat.openNewChatSessionInPlace.acp', 'sidebar');
  });

  // Restart Agent
  const restartAgentCmd = vscode.commands.registerCommand('acp.restartAgent', async (item?: { agentName?: string }) => {
    const activeSession = item?.agentName ? sessionManager.getAgentSession(item.agentName) : sessionManager.getActiveSession();
    if (!activeSession) { return; }

    const agentName = activeSession.agentName;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Restarting ${activeSession.agentDisplayName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.disconnectAgent(agentName);
          await sessionManager.connectToAgent(agentName, { exclusive: false });
        },
      );
      vscode.window.showInformationMessage(`Restarted ${agentName}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to restart: ${e.message}`);
    }
  });

  // Show Log
  const showLogCmd = vscode.commands.registerCommand('acp.showLog', () => {
    sendEvent('command/showLog');
    getOutputChannel().show();
  });

  // Show Traffic
  const showTrafficCmd = vscode.commands.registerCommand('acp.showTraffic', () => {
    sendEvent('command/showTraffic');
    getTrafficChannel().show();
  });

  // Refresh Agents tree
  const refreshAgentsCmd = vscode.commands.registerCommand('acp.refreshAgents', () => {
    agentTreeProvider.refresh();
  });

  // Add Agent Configuration
  const addAgentCmd = vscode.commands.registerCommand('acp.addAgent', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Agent name',
      placeHolder: 'my-agent',
      title: 'Add ACP Agent',
    });
    if (!name) { return; }

    const command = await vscode.window.showInputBox({
      prompt: 'Command to launch the agent',
      placeHolder: 'npx',
      title: 'Agent Command',
    });
    if (!command) { return; }

    const argsStr = await vscode.window.showInputBox({
      prompt: 'Arguments (space-separated)',
      placeHolder: '-y @my-org/agent',
      title: 'Agent Arguments',
    });
    const args = argsStr ? argsStr.split(/\s+/) : [];

    const config = vscode.workspace.getConfiguration('acp');
    const agents: Record<string, any> = { ...(config.get<Record<string, any>>('agents') || {}) };
    agents[name] = { command, args };
    await config.update('agents', agents, vscode.ConfigurationTarget.Global);
    agentTreeProvider.refresh();
    vscode.window.showInformationMessage(`Agent "${name}" added.`);
    sendEvent('agent/added');
  });

  // Remove Agent
  const removeAgentCmd = vscode.commands.registerCommand('acp.removeAgent', async (item?: any) => {
    const config = vscode.workspace.getConfiguration('acp');
    const agents: Record<string, any> = { ...(config.get<Record<string, any>>('agents') || {}) };
    const agentNames = Object.keys(agents);
    if (agentNames.length === 0) {
      vscode.window.showInformationMessage('No agents configured.');
      return;
    }

    const name = item?.agentName ?? await vscode.window.showQuickPick(agentNames, {
      placeHolder: 'Select agent to remove',
      title: 'Remove ACP Agent',
    });
    if (!name) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Remove agent "${name}"?`, { modal: true }, 'Remove',
    );
    if (confirm !== 'Remove') { return; }

    // Disconnect if connected
    if (sessionManager.isAgentConnected(name)) {
      await sessionManager.disconnectAgent(name);
    }

    delete agents[name];
    await config.update('agents', agents, vscode.ConfigurationTarget.Global);
    agentTreeProvider.refresh();
    vscode.window.showInformationMessage(`Agent "${name}" removed.`);
    sendEvent('agent/removed', { agentName: name });
  });

  // Browse Registry
  const browseRegistryCmd = vscode.commands.registerCommand('acp.browseRegistry', async () => {
    sendEvent('registry/browse');
    try {
      const agents = await fetchRegistry();
      const items = agents.map(a => ({
        label: a.name,
        description: a.command,
        detail: a.description || '',
      }));
      if (items.length === 0) {
        vscode.window.showInformationMessage('No agents found in registry.');
        return;
      }
      await vscode.window.showQuickPick(items, {
        placeHolder: 'ACP Agent Registry',
        title: 'Available ACP Agents',
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to fetch registry: ${e.message}`);
    }
  });

  // --- Register disposables ---
  context.subscriptions.push(
    treeView,
    statusBarManager,
    connectAgentCmd,
    disconnectAgentCmd,
    openChatCmd,
    restartAgentCmd,
    showLogCmd,
    showTrafficCmd,
    refreshAgentsCmd,
    addAgentCmd,
    removeAgentCmd,
    browseRegistryCmd,
    {
      dispose: () => {
        sessionManager.dispose();
        sessionUpdateHandler.dispose();
        agentTreeProvider.dispose();
        disposeChannels();
      },
    },
  );

  sendEvent('extension/activated', { version: vscode.extensions.getExtension('aminballoon.acp-chat')?.packageJSON?.version ?? 'unknown' });
  log('ACP Client extension activated.');
  return {
    changeTracker,
    chatHandler: chatParticipant.handler,
    chatRequestCount: chatParticipant.requestCount,
    acpSessionHandler: acpSessions.handler,
    acpChats: () => acpSessions.store.list(),
    connectedAgents: () => sessionManager.getConnectedAgentNames(),
    disconnectIdleAgents: ms => acpSessions.disconnectIdleAgents(ms),
    listAcpChats: () => acpSessions.listChats(),
    agentStatus: name => agentStatus.get(name),
    openAcpChat: id => acpSessions.openChat(id),
    activeConfigOptions: () => sessionManager.getActiveSession()?.configOptions ?? null,
  };
}

export function deactivate(): void {
  log('ACP Client extension deactivated.');
}
