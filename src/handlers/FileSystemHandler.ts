import * as vscode from 'vscode';
import { log, logError } from '../utils/Logger';
import type { ChangeTracker } from '../changes/ChangeTracker';
import type { TurnRouter } from '../chat/TurnRouter';

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * Handles ACP file system requests using VS Code's workspace filesystem API.
 * This gives us access to unsaved editor buffers automatically.
 */
export class FileSystemHandler {

  constructor(
    private readonly tracker?: ChangeTracker,
    private readonly router?: TurnRouter,
  ) {}

  /**
   * Read a text file. Uses VS Code API to include unsaved editor content.
   */
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    log(`readTextFile: ${params.path}`);

    try {
      const uri = vscode.Uri.file(params.path);

      // Check if the file is open in an editor with unsaved changes
      const openDoc = vscode.workspace.textDocuments.find(
        doc => doc.uri.fsPath === uri.fsPath
      );

      // A native chat edit may not have reached the editor buffer yet
      const recent = this.router?.recentlyWritten(params.sessionId, uri.fsPath);

      let content: string;
      if (recent !== undefined) {
        content = recent;
      } else if (openDoc) {
        content = openDoc.getText();
      } else {
        const raw = await vscode.workspace.fs.readFile(uri);
        content = Buffer.from(raw).toString('utf-8');
      }

      // Handle line/limit parameters
      if (params.line !== undefined && params.line !== null
        || params.limit !== undefined && params.limit !== null) {
        const lines = content.split('\n');
        const startLine = (params.line ?? 1) - 1; // 1-based → 0-based
        const endLine = params.limit
          ? startLine + params.limit
          : lines.length;
        content = lines.slice(startLine, endLine).join('\n');
      }

      return { content };
    } catch (e) {
      logError(`readTextFile failed: ${params.path}`, e);
      throw e;
    }
  }

  /**
   * Write a text file. Creates parent directories if needed.
   * Opens the file in the editor so the user can see changes.
   */
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    log(`writeTextFile: ${params.path}`);

    try {
      // Native chat edit (per-hunk Keep/Undo) when a chat turn is streaming
      if (await this.router?.nativeWrite(params)) {
        return {};
      }

      const uri = vscode.Uri.file(params.path);
      const encoded = Buffer.from(params.content, 'utf-8');

      // Record baseline so the change stays pending until the user keeps it
      await this.tracker?.beforeAgentWrite(uri.fsPath, params.content);

      await vscode.workspace.fs.writeFile(uri, encoded);

      // Open the file in the editor so the user sees the change
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

      return {};
    } catch (e) {
      logError(`writeTextFile failed: ${params.path}`, e);
      throw e;
    }
  }
}
