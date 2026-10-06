export interface FileIO {
  /** Returns file text, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /**
   * Read straight from disk, bypassing editor buffers. Used for agents that
   * write files themselves: the buffer may lag behind the disk write.
   */
  readDisk?(path: string): Promise<string | null>;
}

export interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface PendingChange {
  /** Content before the first un-kept agent write; null = file did not exist. */
  baseline: string | null;
  /** Last content the agent wrote; used to detect user edits made afterwards. */
  agentText: string;
  /** Bumped whenever the baseline is (re)set so diff URIs are not cached. */
  version: number;
}

export interface UndoResult {
  undone: boolean;
  /** True when the file differs from what the agent wrote (user edited it). */
  userEdited: boolean;
}

const STORE_KEY = 'acp.pendingChanges';

/**
 * Tracks files modified by agents as "pending" until the user keeps them.
 * Pure logic — no vscode dependency, so it can be tested in plain node.
 */
export class ChangeTracker {
  private entries = new Map<string, PendingChange>();
  private chains = new Map<string, Promise<unknown>>();
  private listeners = new Set<() => void>();
  private versionCounter = 0;

  constructor(
    private readonly io: FileIO,
    private readonly store: Store,
    private readonly log: (msg: string) => void = () => {},
  ) {
    const saved = store.get<Record<string, PendingChange>>(STORE_KEY) ?? {};
    for (const [path, entry] of Object.entries(saved)) {
      this.entries.set(path, entry);
      this.versionCounter = Math.max(this.versionCounter, entry.version);
    }
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  list(): Array<[string, PendingChange]> {
    return [...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  get(path: string): PendingChange | undefined {
    return this.entries.get(path);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Call right before the client writes `newContent` on behalf of an agent. */
  beforeAgentWrite(path: string, newContent: string): Promise<void> {
    return this.serial(path, async () => {
      const existing = this.entries.get(path);
      if (existing) {
        existing.agentText = newContent;
      } else {
        const baseline = await this.io.read(path);
        this.entries.set(path, { baseline, agentText: newContent, version: ++this.versionCounter });
      }
      await this.persist();
    });
  }

  /**
   * Snapshot the current content as baseline before an agent edits a file it
   * writes itself. No-op when an entry already exists.
   */
  captureBaseline(path: string): Promise<void> {
    return this.serial(path, async () => {
      if (this.entries.has(path)) { return; }
      const baseline = await this.readDisk(path);
      this.entries.set(path, { baseline, agentText: baseline ?? '', version: ++this.versionCounter });
      await this.persist();
    });
  }

  /**
   * After the agent finished with a file: record what it left on disk, or drop
   * the entry when nothing changed (edit rejected / failed). Returns whether a
   * pending change remains.
   */
  noteAgentResult(path: string): Promise<boolean> {
    return this.serial(path, async () => {
      const entry = this.entries.get(path);
      if (!entry) { return false; }
      const current = await this.readDisk(path);
      if (current === entry.baseline) {
        this.entries.delete(path);
        await this.persist();
        return false;
      }
      entry.agentText = current ?? '';
      await this.persist();
      return true;
    });
  }

  /**
   * For agents that write files themselves and only report a diff.
   * Strict: only adopts oldText as baseline when disk already equals newText
   * exactly (guards against fragment diffs) and no entry exists yet.
   */
  noteExternalDiff(path: string, oldText: string | null | undefined, newText: string): Promise<void> {
    return this.serial(path, async () => {
      const existing = this.entries.get(path);
      if (existing) {
        const current = await this.io.read(path);
        if (current === newText) { existing.agentText = newText; await this.persist(); }
        return;
      }
      const current = await this.io.read(path);
      if (current !== newText) {
        this.log(`ChangeTracker: skip external diff for ${path} (disk != newText)`);
        return;
      }
      const baseline = oldText ?? null;
      if (baseline === newText) { return; }
      this.entries.set(path, { baseline, agentText: newText, version: ++this.versionCounter });
      await this.persist();
    });
  }

  keep(path: string): Promise<void> {
    return this.serial(path, async () => {
      if (this.entries.delete(path)) { await this.persist(); }
    });
  }

  /**
   * Restore baseline. Unless `force`, refuses when the user edited the file
   * after the agent (returns userEdited=true, undone=false) so callers can confirm.
   */
  undo(path: string, force = false): Promise<UndoResult> {
    return this.serial(path, async () => {
      const entry = this.entries.get(path);
      if (!entry) { return { undone: false, userEdited: false }; }
      const current = await this.readDisk(path);
      // An editor buffer that still shows the baseline is just stale, not a user edit
      const buffer = await this.io.read(path);
      const userEdited = (current !== null && current !== entry.agentText)
        || (buffer !== null && buffer !== current && buffer !== entry.baseline);
      if (userEdited && !force) { return { undone: false, userEdited }; }
      if (entry.baseline === null) {
        if (current !== null) { await this.io.remove(path); }
      } else {
        await this.io.write(path, entry.baseline);
      }
      this.entries.delete(path);
      await this.persist();
      return { undone: true, userEdited };
    });
  }

  async keepAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(p => this.keep(p)));
  }

  /** Returns paths that were skipped because the user edited them. */
  async undoAll(force = false): Promise<string[]> {
    const skipped: string[] = [];
    for (const path of [...this.entries.keys()]) {
      const r = await this.undo(path, force);
      if (r.userEdited && !r.undone) { skipped.push(path); }
    }
    return skipped;
  }

  /** Drop entries whose content equals baseline (e.g. permission was denied). */
  async prune(): Promise<void> {
    for (const [path, entry] of [...this.entries]) {
      await this.serial(path, async () => {
        const current = await this.readDisk(path);
        if (current === entry.baseline) {
          this.entries.delete(path);
          await this.persist();
        }
      });
    }
  }

  private readDisk(path: string): Promise<string | null> {
    return this.io.readDisk ? this.io.readDisk(path) : this.io.read(path);
  }

  private serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.chains.set(path, tail);
    void tail.then(() => { if (this.chains.get(path) === tail) { this.chains.delete(path); } });
    return next;
  }

  private async persist(): Promise<void> {
    await this.store.update(STORE_KEY, Object.fromEntries(this.entries));
    for (const l of this.listeners) { try { l(); } catch { /* ignore */ } }
  }
}
