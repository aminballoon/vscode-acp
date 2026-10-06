import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

import type { SessionInfo, SessionManager } from '../core/SessionManager';
import type { TurnRouter } from './TurnRouter';
import { getAgentNames } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';

import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';

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
  router: TurnRouter,
  handler: vscode.ChatRequestHandler,
): vscode.ChatRequestHandler {
  const controller = vscode.chat.createChatSessionItemController(ACP_SESSION_TYPE, async () => { /* sessions live in the ACP view */ });
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
    const session = agent && sessionManager.getActiveAgentName() === agent.id ? sessionManager.getActiveSession() : undefined;
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

  /** Connect the selected agent (spawning it if needed) so its models etc. can be listed. */
  const ensureAgent = async (agentName: string | undefined): Promise<SessionInfo | undefined> => {
    if (!agentName) { return undefined; }
    if (sessionManager.getActiveAgentName() === agentName) { return sessionManager.getActiveSession(); }
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Connecting to ${agentName}…` },
      () => sessionManager.connectToAgent(agentName),
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
        const session = sessionManager.getActiveSession();
        if (session && session.agentName === selected[GROUP.agent]) {
          await applySelections(session, selected);
        }
      } catch (e: any) {
        logError('ACP session: applying picker change failed', e);
        vscode.window.showErrorMessage(`ACP: ${e?.message ?? e}`);
      }
    });
  };

  controller.getChatSessionInputState = (_resource, { previousInputState }) => {
    const state = controller.createChatSessionInputState(buildGroups(selectionsOf(previousInputState?.groups)));
    watch(state);
    return state;
  };

  controller.newChatSessionItemHandler = async ({ request }) => {
    const item = controller.createChatSessionItem(
      vscode.Uri.from({ scheme: ACP_SESSION_TYPE, path: `/${randomUUID()}` }),
      request.prompt || request.command || 'ACP chat',
    );
    controller.items.add(item);
    return item;
  };

  // Apply the toolbar selections, then hand over to the regular ACP handler
  const sessionHandler: vscode.ChatRequestHandler = async (request, ctx, stream, token) => {
    const state = ctx.chatSessionContext?.inputState;
    // Normalize against the current config (e.g. the selected agent was removed meanwhile)
    const selected = selectionsOf(buildGroups(selectionsOf(state?.groups)));
    try {
      const session = await ensureAgent(selected[GROUP.agent]);
      if (session) {
        await applySelections(session, selected);
        router.setAutoApproveNextTurn(session.sessionId, selected[GROUP.permissions] === 'auto');
      }
      if (state) { refresh(state); }
    } catch (e: any) {
      logError('ACP session: setup failed', e);
      stream.markdown(`**Could not start ${selected[GROUP.agent] ?? 'the agent'}:** ${e?.message ?? e}`);
      return {};
    }
    return handler(request, ctx, stream, token);
  };

  const participant = vscode.chat.createChatParticipant(ACP_SESSION_TYPE, sessionHandler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');

  context.subscriptions.push(
    controller,
    participant,
    vscode.chat.registerChatSessionContentProvider(ACP_SESSION_TYPE, {
      provideChatSessionContent: () => ({ history: [], requestHandler: sessionHandler }),
    }, participant),
  );

  // Keep pickers in sync when the agent's options change (e.g. a model change adjusts effort levels)
  const onOptionsChanged = () => liveStates.forEach(refresh);
  const events = ['active-session-changed', 'config-options-changed', 'model-changed', 'mode-changed'];
  for (const event of events) { sessionManager.on(event, onOptionsChanged); }
  context.subscriptions.push({ dispose: () => events.forEach(e => sessionManager.off(e, onOptionsChanged)) });
  return sessionHandler;
}
