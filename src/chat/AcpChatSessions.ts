import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';

import type { SessionInfo, SessionManager } from '../core/SessionManager';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import type { ChatTurnRunner } from './AcpChatParticipant';
import type { TurnRouter } from './TurnRouter';
import { PickedSkill, SkillSelection, skillsLabel } from './SkillSelection';
import { loadSkills } from './SkillLibrary';
import { configuredSkillPaths } from './SkillCommands';
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
  skills: 'skills',
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

/** Whether two group lists show the same items and selections. */
function sameGroups(a: readonly Group[], b: readonly Group[] | undefined): boolean {
  const key = (groups: readonly Group[] | undefined) => JSON.stringify((groups ?? []).map(g => [
    g.id, g.selected?.id, g.items.map(i => [i.id, i.name, i.description, (i.icon as vscode.ThemeIcon | undefined)?.id]),
  ]));
  return key(a) === key(b);
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
  skills: SkillSelection,
): {
  handler: vscode.ChatRequestHandler;
  store: AcpChatStore;
  disconnectIdleAgents(maxIdleMs: number): Promise<string[]>;
  preferAgent(agentName: string): void;
  /** Saved chats plus agent sessions not owned by a chat (what the sessions list shows). */
  listChats(): Promise<StoredChat[]>;
  /** A chat as opened from the list (loads an imported session's history). */
  openChat(id: string): Promise<StoredChat | undefined>;
} {
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const store = new AcpChatStore(`${storageDir}/acp-chats`);

  const toItem = (chat: StoredChat): vscode.ChatSessionItem => {
    const item = controller.createChatSessionItem(chatResource(chat.id), chat.label);
    item.description = chat.agentName;
    item.timing = { created: chat.createdAt, lastRequestEnded: chat.updatedAt };
    return item;
  };
  /**
   * Add agent sessions that no ACP chat owns yet: sessions the agent lists
   * (session/list, connected agents only) and ones created in this workspace.
   */
  const importAgentSessions = async () => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const found: Array<{ agentName: string; sessionId: string; title?: string; at: number }> = [];
    for (const agentName of getAgentNames()) {
      for (const e of sessionManager.getHistoryStore()?.list(agentName, cwd) ?? []) {
        if (!e.title && !e.firstPrompt) { continue; } // never used, e.g. opened just to list models
        found.push({ agentName, sessionId: e.sessionId, title: e.title ?? e.firstPrompt, at: Date.parse(e.lastActiveAt) });
      }
      if (sessionManager.isAgentConnected(agentName) && sessionManager.getCachedCapabilities(agentName)?.list) {
        try {
          const { sessions } = await sessionManager.listSessions(agentName, { cwd });
          for (const s of sessions) {
            found.push({ agentName, sessionId: s.sessionId, title: s.title ?? undefined, at: Date.parse(s.updatedAt ?? '') });
          }
        } catch (e) {
          logError(`ACP session: listing ${agentName} sessions failed`, e);
        }
      }
    }
    const owned = new Set(store.list().map(c => c.acpSessionId));
    for (const f of found) {
      if (owned.has(f.sessionId)) { continue; }
      owned.add(f.sessionId);
      const chat = store.ensure(`agent-${f.sessionId.replace(/[^\w-]/g, '_')}`, f.title || `${f.agentName} session`);
      Object.assign(chat, {
        agentName: f.agentName, acpSessionId: f.sessionId, imported: true,
        selections: { [GROUP.agent]: f.agentName },
        updatedAt: Number.isNaN(f.at) ? chat.updatedAt : f.at,
      });
    }
  };

  /** Replay an imported session (session/load) into the chat's transcript. */
  const importHistory = async (chat: StoredChat) => {
    const { agentName, acpSessionId } = chat;
    if (!agentName || !acpSessionId) { return; }
    const turns: StoredTurn[] = [];
    let tools = new Map<string, string>();
    let lastUser = false;
    const listener = (n: SessionNotification) => {
      if (n.sessionId !== acpSessionId) { return; }
      const u = n.update;
      if (u.sessionUpdate === 'user_message_chunk' && u.content.type === 'text') {
        if (!lastUser) {
          tools = new Map();
          turns.push({ prompt: '', response: '', tools: [], at: Date.now() });
        }
        turns[turns.length - 1].prompt += u.content.text;
        lastUser = true;
        return;
      }
      lastUser = false;
      const turn = turns[turns.length - 1];
      if (!turn) { return; }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
        turn.response += u.content.text;
      } else if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u.title) {
        tools.set(u.toolCallId, u.title);
        turn.tools = [...tools.values()];
      }
    };
    sessionUpdateHandler.addListener(listener);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Loading ${agentName} session…` },
        async () => {
          await sessionManager.ensureConnected(agentName);
          if (sessionManager.getConnectionForSession(acpSessionId)) { return; } // already open
          const caps = sessionManager.getCachedCapabilities(agentName);
          if (caps?.load) {
            await sessionManager.loadSession(agentName, acpSessionId, { exclusive: false });
          } else if (caps?.resume) {
            await sessionManager.resumeSession(agentName, acpSessionId, { exclusive: false }); // no history to show
          }
        },
      );
      chat.turns = turns;
      chat.imported = false;
      await store.save(chat);
    } catch (e) {
      logError(`ACP session: loading ${acpSessionId} failed`, e);
    } finally {
      sessionUpdateHandler.removeListener(listener);
    }
  };

  const controller = vscode.chat.createChatSessionItemController(ACP_SESSION_TYPE, async () => {
    await store.load();
    await importAgentSessions();
    controller.items.replace(store.list().filter(c => c.turns.length || c.imported).map(toItem));
  });

  /** Agent preselected for the next blank chat (from the Agents view). */
  let preferredAgent: string | undefined;

  /** Agent whose slash commands the chat input offers: the one last picked or used. */
  let commandsAgent: string | undefined;
  const showCommandsOf = (agentName: string | undefined) => {
    commandsAgent = agentName;
    const names = (agentName ? sessionManager.getAgentSession(agentName)?.availableCommands ?? [] : []).map(c => c.name);
    void vscode.commands.executeCommand('setContext', 'acp.agentCommands', `,${names.join(',')},`);
  };
  sessionManager.on('available-commands-changed', (sessionId: string) => {
    if (sessionManager.getSession(sessionId)?.agentName === commandsAgent) { showCommandsOf(commandsAgent); }
  });
  const liveStates = new Set<vscode.ChatSessionInputState>();
  /**
   * Selections each input state showed after our last update. Only values that
   * differ from these were picked by the user: our own updates echo back as
   * change events, and re-applying them makes chats with different picks
   * overwrite each other's agent options in a loop.
   */
  const shown = new WeakMap<vscode.ChatSessionInputState, Selections>();

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

    // Skills for the next prompt: picked (several at once) in a quick pick, shown as one item.
    // Markdown skills work with any agent, so the picker shows even without agent commands
    if (agent) {
      const picked = skills.get(agent.id).map(s => s.name);
      const none: Item = { id: 'none', name: picked.length ? 'No skills' : 'Skills', description: 'Run the prompt without a skill' };
      const items = picked.length ? [none, { id: 'picked', name: skillsLabel(picked), description: picked.join(', ') }] : [none];
      groups.push({
        id: GROUP.skills, name: 'Skills', icon: new vscode.ThemeIcon('extensions'), items, selected: items[items.length - 1],
        commands: [
          { title: 'Choose Skills…', command: 'acp.skills.choose', arguments: [agent.id] },
          { title: 'New Skill…', command: 'acp.skills.new' },
          { title: 'Add Skill Files…', command: 'acp.skills.addPath' },
        ],
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

  const refresh = (state: vscode.ChatSessionInputState, selections = selectionsOf(state.groups)) => {
    const groups = buildGroups(selections);
    shown.set(state, selectionsOf(groups));
    if (!sameGroups(groups, state.groups)) { state.groups = groups; }
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

  /** The agent session a chat's picker changes apply to: the chat's own one, else the agent's current one. */
  const sessionForPicks = (state: vscode.ChatSessionInputState, agentName: string): SessionInfo | undefined => {
    const chat = state.sessionResource ? store.get(chatId(state.sessionResource)) : undefined;
    const own = chat?.agentName === agentName && chat.acpSessionId ? sessionManager.getSession(chat.acpSessionId) : undefined;
    return own ?? sessionManager.getAgentSession(agentName);
  };

  /** A user picked new values in a chat's toolbar: show them, connect the agent or apply them to it. */
  const onUserChange = async (state: vscode.ChatSessionInputState, selected: Selections) => {
    const previous = shown.get(state) ?? {};
    const changed = Object.keys({ ...previous, ...selected }).filter(k => selected[k] !== previous[k]);
    if (!changed.length) { return; } // echo of our own update
    refresh(state, selected);
    try {
      // Only a user pick connects an agent; our own refreshes (e.g. fallback after
      // the agent was removed from settings) must not spawn one
      if (changed.includes(GROUP.agent)) {
        await ensureAgent(selected[GROUP.agent]);
        refresh(state);
        showCommandsOf(selected[GROUP.agent]);
        return;
      }
      const agentName = selected[GROUP.agent];
      if (changed.includes(GROUP.skills) && selected[GROUP.skills] === 'none' && agentName) {
        skills.set(agentName, []);
      }
      const session = agentName ? sessionForPicks(state, agentName) : undefined;
      if (session) {
        await applySelections(session, Object.fromEntries(changed.map(k => [k, selected[k]])));
      }
    } catch (e: any) {
      logError('ACP session: applying picker change failed', e);
      vscode.window.showErrorMessage(`ACP: ${e?.message ?? e}`);
    }
  };

  const watch = (state: vscode.ChatSessionInputState) => {
    liveStates.add(state);
    shown.set(state, selectionsOf(state.groups));
    state.onDidDispose(() => liveStates.delete(state));
    // Only fires if VS Code broadcasts a change to every input state (when
    // provideHandleOptionsChange is not used); see the content provider
    state.onDidChange(() => onUserChange(state, selectionsOf(state.groups)));
  };

  /** The input state of the chat (or blank chat editor) a toolbar change came from. */
  const stateForResource = (resource: vscode.Uri): vscode.ChatSessionInputState | undefined => {
    const live = liveByChat.get(chatId(resource));
    if (live) { return live; }
    const key = resource.toString();
    for (const state of liveStates) {
      // Blank chat editors only have VS Code's internal untitled resource
      const r = state.sessionResource ?? (state as { untitledSessionResource?: vscode.Uri }).untitledSessionResource;
      if (r?.toString() === key) { return state; }
    }
    return undefined;
  };

  /** Input state shown for each open chat; its picks are what the toolbar displays. */
  const liveByChat = new Map<string, vscode.ChatSessionInputState>();

  // VS Code asks again when a request is sent (and VS Code then replaces the
  // chat's earlier state), so an open chat keeps what its toolbar shows; the
  // saved picks only seed a chat that is opened from the list
  controller.getChatSessionInputState = async (resource, { previousInputState }) => {
    await store.load();
    const id = resource ? chatId(resource) : undefined;
    const live = id ? liveByChat.get(id) : undefined;
    const saved = id ? store.get(id)?.selections : undefined;
    let selections = live ? selectionsOf(live.groups)
      : saved && Object.keys(saved).length ? saved : selectionsOf(previousInputState?.groups);
    if (!id && preferredAgent) {
      selections = { ...selections, [GROUP.agent]: preferredAgent };
      preferredAgent = undefined;
    }
    showCommandsOf(selections[GROUP.agent]);
    const state = controller.createChatSessionInputState(buildGroups(selections));
    watch(state);
    if (id) {
      liveByChat.set(id, state);
      state.onDidDispose(() => { if (liveByChat.get(id) === state) { liveByChat.delete(id); } });
    }
    return state;
  };

  controller.newChatSessionItemHandler = async ({ request, inputState }) => {
    const chat = store.ensure(randomUUID(), request.prompt || request.command || 'ACP chat');
    // Keep the blank editor's picks when the chat gets its own resource
    chat.selections = selectionsOf(inputState?.groups) as Record<string, string>;
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
      showCommandsOf(agentName);
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
      provideChatSessionContent: async (resource, _token, { inputState }) => {
        await store.load();
        const chat = store.get(chatId(resource));
        if (chat?.imported && !chat.turns.length) { await importHistory(chat); }
        // VS Code only shows pickers that have a value for existing sessions
        const options = selectionsOf(inputState?.groups ?? buildGroups(chat?.selections ?? {})) as Record<string, string>;
        return { title: chat?.label, history: historyOf(chat), options, requestHandler: sessionHandler };
      },
      // Tells us which chat a toolbar change came from; without it VS Code
      // applies the change to the input state of every open ACP chat
      provideHandleOptionsChange: (resource, updates) => {
        const state = stateForResource(resource);
        if (!state) { log(`ACP session: no input state for ${resource.toString()}`); return; }
        const selected = { ...selectionsOf(state.groups) };
        for (const u of updates) {
          if (u.value === undefined) { delete selected[u.optionId]; } else { selected[u.optionId] = u.value; }
        }
        void onUserChange(state, selected);
      },
    }, participant),
  );

  // Keep pickers in sync when the agent's options change (e.g. a model change adjusts effort levels)
  const onOptionsChanged = () => liveStates.forEach(state => refresh(state));
  const events = ['active-session-changed', 'config-options-changed', 'model-changed', 'mode-changed', 'available-commands-changed'];
  for (const event of events) { sessionManager.on(event, onOptionsChanged); }
  skills.on('changed', onOptionsChanged);
  context.subscriptions.push({ dispose: () => {
    events.forEach(e => sessionManager.off(e, onOptionsChanged));
    skills.off('changed', onOptionsChanged);
  } });

  // Multi-select for the agent's next prompt: markdown skills (any agent) and the agent's own commands
  // From the picker VS Code passes `{ inputState, sessionResource }` instead of our arguments
  context.subscriptions.push(vscode.commands.registerCommand('acp.skills.choose', async (arg?: string | { inputState?: vscode.ChatSessionInputState }) => {
    const fromPicker = typeof arg === 'object' ? selectionsOf(arg.inputState?.groups)[GROUP.agent] : arg;
    const agentName = fromPicker ?? commandsAgent ?? sessionManager.getActiveAgentName() ?? undefined;
    if (!agentName) {
      vscode.window.showInformationMessage('ACP: pick an agent first.');
      return;
    }
    const fileSkills = await loadSkills(configuredSkillPaths());
    const commands = sessionManager.getAgentSession(agentName)?.availableCommands ?? [];
    const current = skills.get(agentName);
    const isPicked = (s: PickedSkill) => current.some(c => c.name === s.name && c.path === s.path);

    type SkillItem = vscode.QuickPickItem & { skill?: PickedSkill };
    const item = (skill: PickedSkill, description?: string, detail?: string): SkillItem =>
      ({ label: skill.name, description, detail, picked: isPicked(skill), skill });
    const items: SkillItem[] = [];
    if (fileSkills.length) {
      items.push({ label: 'Skills · every agent', kind: vscode.QuickPickItemKind.Separator });
      items.push(...fileSkills.map(s => item({ name: s.name, path: s.path }, s.description, s.path.replace(os.homedir(), '~'))));
    }
    if (commands.length) {
      items.push({ label: `${agentName} commands`, kind: vscode.QuickPickItemKind.Separator });
      items.push(...commands.map(c => item({ name: c.name }, c.description)));
    }
    if (!items.length) {
      const action = await vscode.window.showInformationMessage(
        `ACP: no skills yet. Create one, or add markdown files you already have.`, 'New Skill…', 'Add Skill Files…',
      );
      if (action) { await vscode.commands.executeCommand(action === 'New Skill…' ? 'acp.skills.new' : 'acp.skills.addPath'); }
      return;
    }
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true, matchOnDescription: true, title: `Skills for the next prompt to ${agentName}`, placeHolder: 'Pick one or more skills',
    });
    if (picks) { skills.set(agentName, picks.flatMap(p => p.skill ? [p.skill] : [])); }
  }));
  return {
    handler: sessionHandler, store, disconnectIdleAgents,
    listChats: async () => {
      await store.load();
      await importAgentSessions();
      return store.list();
    },
    openChat: async (id: string) => {
      const chat = store.get(id);
      if (chat?.imported && !chat.turns.length) { await importHistory(chat); }
      return chat;
    },
    preferAgent: (agentName: string) => { preferredAgent = agentName; },
  };
}
