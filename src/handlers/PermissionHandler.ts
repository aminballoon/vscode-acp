import * as vscode from 'vscode';
import { log } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Handles ACP permission requests from agents.
 * Shows VS Code QuickPick for user to select from agent-provided options.
 */
/** Renders a permission request in the chat webview. Resolves to an optionId, 'cancelled', or undefined if no UI is available. */
export type InlinePermissionPrompter = (params: RequestPermissionRequest) => Promise<string | undefined> | undefined;

export class PermissionHandler {
  constructor(private readonly getInlinePrompter?: () => InlinePermissionPrompter | undefined) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const config = vscode.workspace.getConfiguration('acp');
    const autoApprove = config.get<string>('autoApprovePermissions', 'none');

    const title = params.toolCall?.title || 'Permission Request';
    log(`requestPermission: ${title} (autoApprove=${autoApprove})`);

    // Auto-approve: pick first allow-type option
    if (autoApprove === 'allowAll') {
      const allowOption = params.options.find(o =>
        o.kind === 'allow_once' || o.kind === 'allow_always'
      );
      if (allowOption) {
        sendEvent('permission/requested', { permissionType: title, autoApproved: 'true' });
        return {
          outcome: {
            outcome: 'selected',
            optionId: allowOption.optionId,
          },
        };
      }
    }

    // Prefer the in-chat prompt; fall back to QuickPick when the chat view is unavailable
    const inline = this.getInlinePrompter?.();
    if (inline) {
      sendEvent('permission/requested', { permissionType: title, autoApproved: 'false' });
      const answer = await inline(params);
      if (answer !== undefined) {
        if (answer === 'cancelled') {
          sendEvent('permission/responded', { permissionType: title, outcome: 'cancelled' });
          return { outcome: { outcome: 'cancelled' } };
        }
        sendEvent('permission/responded', { permissionType: title, action: answer, outcome: 'selected' });
        return { outcome: { outcome: 'selected', optionId: answer } };
      }
    }

    // Build QuickPick items from agent-provided options
    const items: (vscode.QuickPickItem & { optionId: string })[] = params.options.map(option => {
      const icon = option.kind.startsWith('allow') ? '$(check)' : '$(x)';
      return {
        label: `${icon} ${option.name}`,
        description: option.kind,
        optionId: option.optionId,
      };
    });

    sendEvent('permission/requested', { permissionType: title, autoApproved: 'false' });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: title,
      title: 'ACP Agent Permission Request',
      ignoreFocusOut: true,
    });

    if (!selection) {
      log('Permission cancelled by user');
      sendEvent('permission/responded', { permissionType: title, outcome: 'cancelled' });
      return {
        outcome: { outcome: 'cancelled' },
      };
    }

    log(`Permission selected: ${selection.optionId}`);
    sendEvent('permission/responded', {
      permissionType: title,
      action: selection.optionId,
      outcome: 'selected',
    });
    return {
      outcome: {
        outcome: 'selected',
        optionId: selection.optionId,
      },
    };
  }
}
