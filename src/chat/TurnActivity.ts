import type { ToolState } from './proposed';

/** How often running rows are redrawn. */
export const TICK_MS = 1000;
/** Silence from the agent, with no tool running, before a "Waiting for …" row appears. */
export const QUIET_MS = 10_000;

/** "8s", "1m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) { return `${s}s`; }
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 3600) { return `${Math.floor(s / 60)}m ${pad(s % 60)}s`; }
  return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

export type RenderTool = (tool: ToolState, isUpdate: boolean) => void;

/**
 * Keeps a turn visibly alive, so a slow step can be told apart from a hung one.
 * Running tool calls show how long they have been running, redrawn every
 * second; when the agent goes quiet with nothing running, a temporary
 * "Waiting for <agent>" row counts the silence until the next update.
 */
export class TurnActivity {
  /** Every tool call of the turn; `start` is set while it runs. */
  private readonly tools = new Map<string, { title: string; status: string; start?: number }>();
  private lastUpdate: number;
  private waiting: { id: string; since: number } | undefined;
  private waitN = 0;
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly agentName: string,
    private readonly render: RenderTool,
    private readonly now: () => number = Date.now,
    autoTick = true,
  ) {
    this.lastUpdate = now();
    this.timer = autoTick ? setInterval(() => this.tick(), TICK_MS) : undefined;
  }

  /** Any session update from the agent ends a silence. */
  touch(): void {
    this.lastUpdate = this.now();
    this.endWaiting();
  }

  /** Render a tool call or its update. Updates that omit the title keep the earlier one. */
  tool(toolCallId: string, title: string | null | undefined, status: string, isUpdate: boolean): void {
    const prev = this.tools.get(toolCallId);
    const done = status === 'completed' || status === 'failed';
    this.tools.set(toolCallId, {
      title: title ?? prev?.title ?? 'Tool call',
      status,
      start: done ? undefined : prev?.start ?? this.now(),
    });
    this.renderTool(toolCallId, isUpdate);
  }

  tick(): void {
    const running = [...this.tools].filter(([, t]) => t.start !== undefined).map(([id]) => id);
    for (const id of running) { this.renderTool(id, true); }
    const quiet = this.now() - this.lastUpdate;
    if (this.waiting) {
      this.renderWaiting('in_progress', true);
    } else if (!running.length && quiet >= QUIET_MS) {
      this.waiting = { id: `acp-waiting-${++this.waitN}`, since: this.lastUpdate };
      this.renderWaiting('in_progress', false);
    }
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); }
    this.endWaiting();
  }

  private renderTool(id: string, isUpdate: boolean): void {
    const { title, status, start } = this.tools.get(id)!;
    const elapsed = start === undefined ? 0 : this.now() - start;
    this.render({ toolCallId: id, title: elapsed >= 1000 ? `${title} · ${formatElapsed(elapsed)}` : title, status }, isUpdate);
  }

  private renderWaiting(status: string, isUpdate: boolean): void {
    const w = this.waiting!;
    const title = `Waiting for ${this.agentName} · ${formatElapsed(this.now() - w.since)}`;
    this.render({ toolCallId: w.id, title, status, presentation: 'hiddenAfterComplete' }, isUpdate);
  }

  private endWaiting(): void {
    if (!this.waiting) { return; }
    this.renderWaiting('completed', true);
    this.waiting = undefined;
  }
}
