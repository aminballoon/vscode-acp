import * as vscode from 'vscode';
import { createHash } from 'node:crypto';

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('ACP Client');
  }
  return _outputChannel;
}

export function getTrafficChannel(): vscode.OutputChannel {
  if (!_trafficChannel) {
    _trafficChannel = vscode.window.createOutputChannel('ACP Traffic');
  }
  return _trafficChannel;
}

/**
 * Recent output of both channels, kept for the debug report (output channels
 * cannot be read back). Bounded by characters, oldest entries dropped first.
 */
class RecentLines {
  private lines: string[] = [];
  private size = 0;
  constructor(private readonly maxChars: number) {}
  push(line: string): void {
    this.lines.push(line);
    this.size += line.length + 1;
    let drop = 0;
    while (this.size > this.maxChars && drop < this.lines.length - 1) { this.size -= this.lines[drop++].length + 1; }
    if (drop) { this.lines.splice(0, drop); }
  }
  text(): string {
    return this.lines.join('\n');
  }
}

const recentLog = new RecentLines(8 * 1024 * 1024);
const recentTraffic = new RecentLines(24 * 1024 * 1024);

function appendLog(line: string): void {
  recentLog.push(line);
  getOutputChannel().appendLine(line);
}

/** What the ACP Client channel showed recently. */
export function recentLogText(): string {
  return recentLog.text();
}

/** What the ACP Traffic channel showed recently. */
export function recentTrafficText(): string {
  return recentTraffic.text();
}

/**
 * Identifies file content in logs without revealing it: length and a short
 * hash, so two log lines show whether the content was the same.
 */
export function fingerprint(text: string | null | undefined): string {
  if (text === null) { return 'missing'; }
  if (text === undefined) { return 'unknown'; }
  return `${text.length}c#${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${message}`;
  appendLog(formatted);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  appendLog(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  if (error instanceof Error && error.stack) {
    appendLog(error.stack);
  }
}

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acp');
  if (!config.get<boolean>('logTraffic', true)) {
    return;
  }
  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const timestamp = new Date().toISOString();

  // Classify message type
  const msg = data as Record<string, unknown> | null;
  let label = '';
  if (msg && typeof msg === 'object') {
    if ('method' in msg && 'id' in msg) {
      label = ` [REQUEST] ${msg.method}`;
    } else if ('method' in msg && !('id' in msg)) {
      label = ` [NOTIFICATION] ${msg.method}`;
    } else if ('result' in msg || 'error' in msg) {
      label = ` [RESPONSE] id=${msg.id}`;
    }
  }

  const entry = `[${timestamp}] ${arrow}${label}\n${JSON.stringify(data, null, 2)}\n`;
  recentTraffic.push(entry);
  getTrafficChannel().appendLine(entry);
}

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
}
