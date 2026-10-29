import * as vscode from 'vscode';
import { log, logError } from '../utils/Logger';

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';

import { spawn, ChildProcess, SpawnOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';

interface ManagedTerminal {
  id: string;
  process: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  exitPromise: Promise<void>;
  vsTerminal?: vscode.Terminal;
}

/** Signal the command and everything it started (its process group, see `detached`). */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // the group is gone; signal the process itself
    }
  }
  child.kill(signal);
}

/**
 * Manages terminals that ACP agents request (terminal/create, terminal/output, etc.).
 * Uses real child processes for capturing output, with VS Code terminals for display.
 */
export class TerminalHandler {
  private terminals: Map<string, ManagedTerminal> = new Map();
  private nextId = 1;

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${this.nextId++}`;
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024; // 1MB default

    log(`createTerminal: ${params.command} ${(params.args || []).join(' ')} (id=${terminalId})`);

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (params.env) {
      for (const v of params.env) {
        env[v.name] = v.value;
      }
    }

    // With arguments the command runs as is (a shell would split arguments at spaces);
    // without, it is a command line for the shell. On Windows cross-spawn runs .cmd/.bat
    // scripts through cmd.exe with each argument quoted.
    const options: SpawnOptions = {
      cwd: params.cwd || undefined,
      env,
      // Own process group, so kill reaches what the command started too
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const child = params.args?.length
      ? crossSpawn(params.command, params.args, options)
      : spawn(params.command, { ...options, shell: true });
    // Decode across chunks: a multi-byte character can be split between two
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    let output = '';
    let truncated = false;

    const appendOutput = (text: string) => {
      output += text;
      // Truncate from beginning if over limit
      const byteLength = Buffer.byteLength(output, 'utf-8');
      if (byteLength > outputByteLimit) {
        const excess = byteLength - outputByteLimit;
        // Find a safe character boundary to truncate at
        let cutPoint = 0;
        let bytes = 0;
        for (let i = 0; i < output.length; i++) {
          bytes += Buffer.byteLength(output[i], 'utf-8');
          if (bytes >= excess) {
            cutPoint = i + 1;
            break;
          }
        }
        output = output.substring(cutPoint);
        truncated = true;
      }
    };

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const exitPromise = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        const managed = this.terminals.get(terminalId);
        if (managed) {
          managed.exitCode = code;
          managed.exitSignal = signal;
          managed.exited = true;
        }
        resolve();
      });
      // The command could not start (e.g. not found): report it as an exit
      child.on('error', err => {
        appendOutput(`${err.message}\n`);
        const managed = this.terminals.get(terminalId);
        if (managed) {
          managed.output = output;
          managed.exited = true;
        }
        resolve();
      });
    });

    // Also create a VS Code terminal for visual output
    const writeEmitter = new vscode.EventEmitter<string>();
    // VS Code ignores writes until open(): hold output that comes earlier
    let pending: string[] | undefined = [`$ ${params.command} ${(params.args || []).join(' ')}\r\n`];
    const write = (text: string) => {
      if (pending) { pending.push(text); } else { writeEmitter.fire(text); }
    };
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open() {
        const held = pending ?? [];
        pending = undefined;
        writeEmitter.fire(held.join(''));
      },
      close() { /* no-op */ },
    };
    const vsTerminal = vscode.window.createTerminal({
      name: `ACP: ${params.command}`,
      pty,
    });

    // Stream output to VS Code terminal
    child.stdout?.on('data', (text: string) => write(text.replace(/\n/g, '\r\n')));
    child.stderr?.on('data', (text: string) => write(text.replace(/\n/g, '\r\n')));

    const managed: ManagedTerminal = {
      id: terminalId,
      process: child,
      output: '',
      truncated: false,
      outputByteLimit,
      exitCode: null,
      exitSignal: null,
      exited: false,
      exitPromise,
      vsTerminal,
    };

    // Keep output reference updated
    const timer = setInterval(() => {
      managed.output = output;
      managed.truncated = truncated;
    }, 100);

    child.on('close', () => {
      managed.output = output;
      managed.truncated = truncated;
      clearInterval(timer);
    });

    this.terminals.set(terminalId, managed);

    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    const response: TerminalOutputResponse = {
      output: managed.output,
      truncated: managed.truncated,
    };

    if (managed.exited) {
      response.exitStatus = {
        exitCode: managed.exitCode,
        signal: managed.exitSignal,
      };
    }

    return response;
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    await managed.exitPromise;

    return {
      exitCode: managed.exitCode,
      signal: managed.exitSignal,
    };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    try {
      killTree(managed.process, 'SIGTERM');
    } catch (e) {
      logError(`Failed to kill terminal ${params.terminalId}`, e);
    }

    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    log(`releaseTerminal: ${params.terminalId}`);

    // Kill if still running
    if (!managed.exited) {
      try {
        killTree(managed.process, 'SIGTERM');
      } catch {
        // ignore
      }
    }

    // Don't dispose VS Code terminal — keep output visible per ACP spec
    this.terminals.delete(params.terminalId);

    return {};
  }

  dispose(): void {
    for (const [, managed] of this.terminals) {
      try {
        if (!managed.exited) {
          killTree(managed.process, 'SIGKILL');
        }
        managed.vsTerminal?.dispose();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }
}
