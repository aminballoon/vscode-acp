import * as vscode from 'vscode';
import { log } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';

import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Shows a permission request in a chat UI. Resolves to the chosen optionId,
 * 'cancelled', or undefined when that UI is unavailable.
 */
export type InlinePermissionPrompter = (params: RequestPermissionRequest) => Promise<string | undefined>;

/** The agent's preferred allow / reject option (the "once" variant when offered). */
export function pickOption(options: PermissionOption[], kind: 'allow' | 'reject'): PermissionOption | undefined {
  return options.find(o => o.kind === `${kind}_once`) ?? options.find(o => o.kind.startsWith(kind));
}

/**
 * Handles ACP permission requests from agents: auto-approve when configured,
 * otherwise the in-chat prompt, falling back to a QuickPick.
 */
export class PermissionHandler {
  constructor(private readonly inlinePrompter?: InlinePermissionPrompter) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const autoApprove = vscode.workspace.getConfiguration('acp').get<string>('autoApprovePermissions', 'none');
    const title = params.toolCall?.title || 'Permission Request';
    log(`requestPermission: ${title} (autoApprove=${autoApprove})`);

    const allowOption = autoApprove === 'allowAll' ? pickOption(params.options, 'allow') : undefined;
    if (allowOption) {
      sendEvent('permission/requested', { permissionType: title, autoApproved: 'true' });
      return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
    }

    sendEvent('permission/requested', { permissionType: title, autoApproved: 'false' });
    const answer = (await this.inlinePrompter?.(params)) ?? await this.quickPick(params, title);

    if (answer === 'cancelled') {
      log('Permission cancelled by user');
      sendEvent('permission/responded', { permissionType: title, outcome: 'cancelled' });
      return { outcome: { outcome: 'cancelled' } };
    }
    log(`Permission selected: ${answer}`);
    sendEvent('permission/responded', { permissionType: title, action: answer, outcome: 'selected' });
    return { outcome: { outcome: 'selected', optionId: answer } };
  }

  private async quickPick(params: RequestPermissionRequest, title: string): Promise<string> {
    const items = params.options.map(option => ({
      label: `${option.kind.startsWith('allow') ? '$(check)' : '$(x)'} ${option.name}`,
      description: option.kind,
      optionId: option.optionId,
    }));
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: title,
      title: 'ACP Agent Permission Request',
      ignoreFocusOut: true,
    });
    return selection?.optionId ?? 'cancelled';
  }
}
