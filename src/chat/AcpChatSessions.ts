import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

import type { SessionInfo, SessionManager } from '../core/SessionManager';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import type { ChatTurnRunner } from './AcpChatParticipant';
import type { TurnRouter } from './TurnRouter';
import { AcpChatStore, StoredChat, StoredTurn } from './AcpChatStore';
import { getAgentNames } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';

import type { SessionConfigOption, SessionConfigSelectOption, SessionNotification } from '@agentclientprotocol/sdk';

/** Chat session type contributed in package.json (`chatSessions`). */
export const ACP_SESSION_TYPE = 'acp';

type Item = vscode.ChatSessionProviderOptionItem;
type Group = vscode.ChatSessionProviderOptionGroup;

const GROUP = {
  agent: 'agent',
  model: 'model',
  effort: 'effort',
  mode: 'mode',
  permissions: 'permissions',
} as const;

// The picker shows an item's icon instead of its name, so only agents with a logo get one
const PERMISSION_ITEMS: Item[] = [
  { id: 'ask', name: 'Ask', description: 'Confirm each file edit or command', default: true },
  { id: 'auto', name: 'Auto-approve', description: 'Approve every agent request without asking' },
];

function chatResource(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: ACP_SESSION_TYPE, path: `/${id}` });
}

function chatId(resource: vscode.Uri): string {
  return resource.path.replace(/^\//, '');
}

/** Selected item id per option group. */
type Selections = Partial<Record<string, string>>;

function selectionsOf(groups: readonly Group[] | undefined): Selections {
  const out: Selections = {};
  for (const g of groups ?? []) { if (g.selected) { out[g.id] = g.selected.id; } }
  return out;
}

/** Codicon logo for a configured agent, matched by name; undefined when there is none. */
function agentLogo(agentName: string): vscode.ThemeIcon | undefined {
  const name = agentName.toLowerCase();
  if (name.includes('claude')) { return new vscode.ThemeIcon('claude'); }
  if (name.includes('codex') || name.includes('openai')) { return new vscode.ThemeIcon('openai'); }
  if (name.includes('gemini') || name.includes('antigravity')) { return new vscode.ThemeIcon('google-gemini'); }
  if (name.includes('copilot')) { return new vscode.ThemeIcon('copilot'); }
  return undefined;
}

/**
 * Picker labels are shown inline and truncate quickly, so drop trailing
 * qualifiers such as "Default (recommended)"; the full name stays in the description.
 */
function toItem(id: string, name: string, description?: string | null): Item {
  const short = name.replace(/\s*\([^)]*\)\s*$/, '') || name;
  return { id, name: short, description: description ?? (short !== name ? name : undefined) };
}

/** Flatten select options (which may be grouped) into option items. */
function selectItems(option: SessionConfigOption): Item[] {
  if (option.type !== 'select') { return []; }
  const flat: SessionConfigSelectOption[] = [];
  for (const o of option.options) {
    if ('group' in o) { flat.push(...o.options); } else { flat.push(o); }
  }
  return flat.map(o => toItem(o.value, o.name, o.description));
}

function pick(items: Item[], ...ids: Array<string | undefined>): Item | undefined {
  for (const id of ids) {
    const found = id !== undefined ? items.find(i => i.id === id) : undefined;
    if (found) { return found; }
  }
  return items[0];
}

/**
 * Model / effort / mode choices the connected agent offers, with what it
 * currently uses. Prefers ACP Session Config Options over legacy modes/models.
 */
function agentChoices(session: SessionInfo | undefined) {
  const result: Array<{ id: string; name: string; icon: string; items: Item[]; current?: string; configId?: string }> = [];
  if (!session) { return result; }
  const config = session.configOptions ?? [];
  const byCategory = (category: string) => config.find(o => o.category === category && o.type === 'select');

  const model = byCategory('model');
  if (model) {
    result.push({ id: GROUP.model, name: 'Model', icon: 'sparkle', items: selectItems(model), current: String(model.currentValue), configId: model.id });
  } else if (session.models?.availableModels.length) {
    result.push({
      id: GROUP.model, name: 'Model', icon: 'sparkle',
      items: session.models.availableModels.map(m => toItem(m.modelId, m.name, m.description)),
      current: session.models.currentModelId,
    });
  }

  const effort = byCategory('thought_level');
  if (effort) {
    result.push({ id: GROUP.effort, name: 'Effort', icon: 'lightbulb', items: selectItems(effort), current: String(effort.currentValue), configId: effort.id });
  }

  const mode = byCategory('mode');
  if (mode) {
    result.push({ id: GROUP.mode, name: 'Mode', icon: 'symbol-event', items: selectItems(mode), current: String(mode.currentValue), configId: mode.id });
  } else if (session.modes?.availableModes.length) {
    result.push({
      id: GROUP.mode, name: 'Mode', icon: 'symbol-event',
      items: session.modes.availableModes.map(m => toItem(m.id, m.name, m.description)),
      current: session.modes.currentModeId,
    });
  }
  return result;
}

/**
 * Registers the "ACP" chat session type: a native chat session whose input
 * toolbar has pickers for the agent, its model, reasoning effort, mode and
 * permission policy. Requests are served by the regular ACP chat handler.
 */
export function registerAcpChatSessions(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
  sessionUpdateHandler: SessionUpdateHandler,
  router: TurnRouter,
  runTurn: ChatTurnRunner,
): { handler: vscode.ChatRequestHandler; store: AcpChatStore; disconnectIdleAgents(maxIdleMs: number): Promise<string[]> } {
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const store = new AcpChatStore(`${storageDir}/acp-chats`);

  const toItem = (chat: StoredChat): vscode.ChatSessionItem => {
    const item = controller.createChatSessionItem(chatResource(chat.id), chat.label);
    item.description = chat.agentName;
    item.timing = { created: chat.createdAt, lastRequestEnded: chat.updatedAt };
    return item;
  };
  const controller = vscode.chat.createChatSessionItemController(ACP_SESSION_TYPE, async () => {
    await store.load();
    controller.items.replace(store.list().filter(c => c.turns.length).map(toItem));
  });
  const liveStates = new Set<vscode.ChatSessionInputState>();
  /** Agent each input state showed after our last update; a different value means the user picked it. */
  const shownAgent = new WeakMap<vscode.ChatSessionInputState, string | undefined>();

  const buildGroups = (previous: Selections): Group[] => {
    const agentItems: Item[] = getAgentNames().map(name => ({ id: name, name, icon: agentLogo(name) }));
    const agent = pick(agentItems, previous[GROUP.agent], sessionManager.getActiveAgentName() ?? undefined);
    const groups: Group[] = [{
      id: GROUP.agent, name: 'Agent', icon: new vscode.ThemeIcon('hubot'), items: agentItems, selected: agent,
      commands: [{ title: 'Add Agent…', command: 'acp.addAgent' }],
    }];

    // Model / effort / mode are only known once the selected agent is connected
    const session = agent ? sessionManager.getAgentSession(agent.id) : undefined;
    const choices = agentChoices(session);
    for (const choice of choices) {
      if (!choice.items.length) { continue; }
      groups.push({
        id: choice.id, name: choice.name, icon: new vscode.ThemeIcon(choice.icon), items: choice.items,
        selected: pick(choice.items, previous[choice.id], choice.current),
      });
    }

    // Agents with their own modes (e.g. Claude: Manual / Accept edits / Bypass) already
    // cover the permission policy, so only offer ours otherwise. Not `kind: 'permissions'`:
    // VS Code hides its permission picker in sessions locked to an extension agent.
    if (choices.some(c => c.id === GROUP.mode)) { return groups; }
    groups.push({
      id: GROUP.permissions, name: 'Permissions', icon: new vscode.ThemeIcon('shield'), items: PERMISSION_ITEMS,
      selected: pick(PERMISSION_ITEMS, previous[GROUP.permissions]),
    });
    return groups;
  };

  const refresh = (state: vscode.ChatSessionInputState) => {
    state.groups = buildGroups(selectionsOf(state.groups));
    shownAgent.set(state, selectionsOf(state.groups)[GROUP.agent]);
  };

  /**
   * Connect the selected agent (spawning it if needed) so its models etc. can be listed.
   * Other agents stay connected, so each chat can keep its own agent.
   */
  const ensureAgent = async (agentName: string | undefined): Promise<SessionInfo | undefined> => {
    if (!agentName) { return undefined; }
    const existing = sessionManager.getAgentSession(agentName);
    if (existing) { return existing; }
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Connecting to ${agentName}…` },
      () => sessionManager.connectToAgent(agentName, { exclusive: false }),
    );
  };

  /** Push the picked model / effort / mode to the agent when they differ from its current values. */
  const applySelections = async (session: SessionInfo, selected: Selections): Promise<void> => {
    for (const choice of agentChoices(session)) {
      const value = selected[choice.id];
      if (!value || value === choice.current || !choice.items.some(i => i.id === value)) { continue; }
      log(`ACP session: set ${choice.id}=${value}`);
      if (choice.configId) {
        await sessionManager.setConfigOption(session.sessionId, choice.configId, value);
      } else if (choice.id === GROUP.model) {
        await sessionManager.setModel(session.sessionId, value);
      } else if (choice.id === GROUP.mode) {
        await sessionManager.setMode(session.sessionId, value);
      }
    }
  };

  const watch = (state: vscode.ChatSessionInputState) => {
    liveStates.add(state);
    shownAgent.set(state, selectionsOf(state.groups)[GROUP.agent]);
    state.onDidDispose(() => liveStates.delete(state));
    state.onDidChange(async () => {
      const selected = selectionsOf(state.groups);
      try {
        // Only a user pick connects an agent; our own refreshes (e.g. fallback after
        // the agent was removed from settings) must not spawn one
        if (selected[GROUP.agent] !== shownAgent.get(state)) {
          shownAgent.set(state, selected[GROUP.agent]);
          await ensureAgent(selected[GROUP.agent]);
          refresh(state);
          return;
        }
        const agentName = selected[GROUP.agent];
        const session = agentName ? sessionManager.getAgentSession(agentName) : undefined;
        if (session) {
          await applySelections(session, selected);
        }
      } catch (e: any) {
        logError('ACP session: applying picker change failed', e);
        vscode.window.showErrorMessage(`ACP: ${e?.message ?? e}`);
      }
    });
  };

  controller.getChatSessionInputState = async (resource, { previousInputState }) => {
    await store.load();
    const saved = resource ? store.get(chatId(resource))?.selections : undefined;
    const state = controller.createChatSessionInputState(buildGroups(saved ?? selectionsOf(previousInputState?.groups)));
    watch(state);
    return state;
  };

  controller.newChatSessionItemHandler = async ({ request }) => {
    const chat = store.ensure(randomUUID(), request.prompt || request.command || 'ACP chat');
    const item = toItem(chat);
    controller.items.add(item);
    return item;
  };

  /** ACP sessions already bound to a chat; a fresh chat must not reuse them. */
  const isClaimed = (sessionId: string) => store.list().some(c => c.acpSessionId === sessionId);

  /**
   * Reattach a chat to its agent session after the agent was disconnected
   * (idle timeout, restart): session/resume when supported (no replay), else
   * session/load. Neither calls the model; the agent reads its own saved history.
   */
  const restoreSession = async (agentName: string, sessionId: string): Promise<SessionInfo | undefined> => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Reconnecting to ${agentName}…` },
        () => sessionManager.ensureConnected(agentName),
      );
      const caps = sessionManager.getCachedCapabilities(agentName);
      if (caps?.resume) { return await sessionManager.resumeSession(agentName, sessionId, { exclusive: false }); }
      if (caps?.load) { return await sessionManager.loadSession(agentName, sessionId, { exclusive: false }); }
    } catch (e) {
      logError(`ACP session: could not restore ${sessionId}, starting a new one`, e);
    }
    return undefined;
  };

  /**
   * The agent session for a chat: its own live session, a restored one after
   * a disconnect or restart, the agent's still unused session, or a new one.
   */
  const sessionForChat = async (chat: StoredChat, agentName: string): Promise<SessionInfo> => {
    const own = chat.agentName === agentName ? chat.acpSessionId : undefined;
    if (own && sessionManager.getConnectionForSession(own)) {
      return sessionManager.activateSession(own)!;
    }
    const restored = own && chat.turns.length ? await restoreSession(agentName, own) : undefined;
    if (restored) { return restored; }
    await ensureAgent(agentName);
    const current = sessionManager.getAgentSession(agentName);
    if (current && !isClaimed(current.sessionId)) { return sessionManager.activateSession(current.sessionId)!; }
    return sessionManager.startNewSession(agentName);
  };

  /**
   * Disconnect agents whose chats have been idle for `maxIdleMs`. Only agents
   * that can restore a session (resume / load) are disconnected, so no chat
   * loses its context; the next message reconnects transparently.
   */
  const disconnectIdleAgents = async (maxIdleMs: number): Promise<string[]> => {
    const used = new Set(store.list().map(c => c.agentName));
    const idle = sessionManager.getIdleAgentNames(maxIdleMs).filter(name => {
      const caps = sessionManager.getCachedCapabilities(name);
      return used.has(name) && (caps?.resume || caps?.load);
    });
    for (const name of idle) {
      log(`ACP session: disconnecting idle agent ${name}`);
      await sessionManager.disconnectAgent(name);
    }
    return idle;
  };
  const idleTimer = setInterval(() => {
    const minutes = vscode.workspace.getConfiguration('acp').get<number>('chat.idleDisconnectMinutes', 15);
    if (minutes > 0) {
      disconnectIdleAgents(minutes * 60_000).catch(e => logError('ACP session: idle disconnect failed', e));
    }
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(idleTimer) });

  /** Collect the agent's reply and tool calls for the transcript while a turn runs. */
  const recordTurn = (sessionId: string, prompt: string) => {
    const turn: StoredTurn = { prompt, response: '', tools: [], at: Date.now() };
    // Latest title per tool call: agents often rename a call once its input is known
    const tools = new Map<string, string>();
    const listener = (n: SessionNotification) => {
      if (n.sessionId !== sessionId) { return; }
      const u = n.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
        turn.response += u.content.text;
      } else if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u.title) {
        tools.set(u.toolCallId, u.title);
      }
    };
    sessionUpdateHandler.addListener(listener);
    return {
      turn,
      stop: () => {
        sessionUpdateHandler.removeListener(listener);
        turn.tools = [...tools.values()];
      },
    };
  };

  // Bind the chat to its agent session, apply the toolbar selections, then
  // hand over to the regular ACP handler and save the turn
  const sessionHandler: vscode.ChatRequestHandler = async (request, ctx, stream, token) => {
    await store.load();
    const state = ctx.chatSessionContext?.inputState;
    const resource = ctx.chatSessionContext?.chatSessionItem?.resource;
    const chat = store.ensure(resource ? chatId(resource) : randomUUID(), request.prompt || 'ACP chat');
    // Normalize against the current config (e.g. the selected agent was removed meanwhile)
    const selected = selectionsOf(buildGroups(selectionsOf(state?.groups)));
    const agentName = selected[GROUP.agent];
    if (!agentName) {
      stream.markdown('No ACP agent is configured. Add one with **ACP: Add Agent Configuration**.');
      return {};
    }

    let session: SessionInfo;
    try {
      session = await sessionForChat(chat, agentName);
      await applySelections(session, selected);
      router.setAutoApproveNextTurn(session.sessionId, selected[GROUP.permissions] === 'auto');
      if (state) { refresh(state); }
    } catch (e: any) {
      logError('ACP session: setup failed', e);
      stream.markdown(`**Could not start ${agentName}:** ${e?.message ?? e}`);
      return {};
    }

    const recording = recordTurn(session.sessionId, request.prompt);
    try {
      // Explicit session: another chat may switch the active one meanwhile
      return await runTurn(session.sessionId, request, stream, token);
    } finally {
      recording.stop();
      Object.assign(chat, {
        agentName,
        acpSessionId: session.sessionId,
        selections: Object.fromEntries(Object.entries(selectionsOf(state?.groups)).filter(([, v]) => v)) as Record<string, string>,
      });
      chat.turns.push(recording.turn);
      await store.save(chat).catch(e => logError('ACP session: saving chat failed', e));
      controller.items.add(toItem(chat));
    }
  };

  /** Rebuild the chat history shown when a saved chat is opened. */
  const historyOf = (chat: StoredChat | undefined): Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> => {
    const turns: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> = [];
    for (const t of chat?.turns ?? []) {
      turns.push(new vscode.ChatRequestTurn2(t.prompt, undefined, [], ACP_SESSION_TYPE, [], undefined, undefined, undefined, undefined));
      const parts: vscode.ChatResponseMarkdownPart[] = [];
      if (t.tools.length) {
        parts.push(new vscode.ChatResponseMarkdownPart(`_${t.tools.map(x => x.replace(/[_*`]/g, '')).join(' · ')}_\n\n`));
      }
      parts.push(new vscode.ChatResponseMarkdownPart(t.response || '_(no reply)_'));
      turns.push(new vscode.ChatResponseTurn2(parts, {}, ACP_SESSION_TYPE));
    }
    return turns;
  };

  const participant = vscode.chat.createChatParticipant(ACP_SESSION_TYPE, sessionHandler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');

  context.subscriptions.push(
    controller,
    participant,
    vscode.chat.registerChatSessionContentProvider(ACP_SESSION_TYPE, {
      provideChatSessionContent: async resource => {
        await store.load();
        const chat = store.get(chatId(resource));
        // Saved picker values; VS Code only shows pickers that have a value for existing sessions
        const options = Object.fromEntries(
          buildGroups(chat?.selections ?? {}).filter(g => g.selected).map(g => [g.id, g.selected!.id]),
        );
        return { title: chat?.label, history: historyOf(chat), options, requestHandler: sessionHandler };
      },
    }, participant),
  );

  // Keep pickers in sync when the agent's options change (e.g. a model change adjusts effort levels)
  const onOptionsChanged = () => liveStates.forEach(refresh);
  const events = ['active-session-changed', 'config-options-changed', 'model-changed', 'mode-changed'];
  for (const event of events) { sessionManager.on(event, onOptionsChanged); }
  context.subscriptions.push({ dispose: () => events.forEach(e => sessionManager.off(e, onOptionsChanged)) });
  return { handler: sessionHandler, store, disconnectIdleAgents };
}
