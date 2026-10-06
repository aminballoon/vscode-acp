import * as vscode from 'vscode';

export const PERMISSION_TOOL = 'acp_permission';

/** Tool input; doubles as the human-readable "Input" VS Code shows in the confirmation. */
export interface PermissionInput {
  action: string;
  files?: string[];
  command?: string;
}

/**
 * A tool whose only purpose is to show VS Code's native tool-confirmation UI
 * (Allow / Skip, with "allow in session / always" options) for ACP permission
 * requests. TurnRouter invokes it with the chat request's toolInvocationToken.
 * Only inputs registered by the extension are accepted, so a language model
 * calling it directly gets an error.
 */
export class PermissionTool implements vscode.LanguageModelTool<PermissionInput> {
  private details = new Map<string, string[]>();

  /** Register a pending ask; returns the input to invoke the tool with. */
  register(input: PermissionInput, details: string): PermissionInput {
    const key = JSON.stringify(input);
    this.details.set(key, [...(this.details.get(key) ?? []), details]);
    return input;
  }

  release(input: PermissionInput): void {
    const key = JSON.stringify(input);
    const rest = (this.details.get(key) ?? []).slice(1);
    if (rest.length) { this.details.set(key, rest); } else { this.details.delete(key); }
  }

  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<PermissionInput>): vscode.PreparedToolInvocation {
    const details = this.details.get(JSON.stringify(options.input))?.[0];
    const title = options.input?.action || 'Agent action';
    if (details === undefined) { return { invocationMessage: title }; }
    return {
      invocationMessage: title,
      confirmationMessages: { title, message: new vscode.MarkdownString(details) },
      // Hide the confirmation once handled; the ACP tool call itself stays visible
      presentation: 'hiddenAfterComplete',
    };
  }

  invoke(options: vscode.LanguageModelToolInvocationOptions<PermissionInput>): vscode.LanguageModelToolResult {
    if (!this.details.has(JSON.stringify(options.input))) {
      throw new Error('This tool is internal to the ACP Agents extension.');
    }
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('approved')]);
  }
}
