import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';

import { log } from '../utils/Logger';

/** Larger files are left out of snapshots (and so never reported). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Workspaces with more new files than this in one go are not snapshotted. */
const MAX_NEW_FILES = 20_000;

/** Never worth snapshotting, also outside git repositories (where no .gitignore applies). */
const DEFAULT_EXCLUDES = [
  'node_modules/', 'bower_components/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '.DS_Store',
  '.next/', '.nuxt/', '.turbo/', '.parcel-cache/', '.cache/', '.gradle/', '.vscode-test/', 'coverage/',
];

/** Run git against the shadow repository of a work tree. */
function git(gitDir: string, root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', [
      // Exact bytes and no side effects: no eol conversion, fsmonitor, auto gc or path quoting
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false',
      '-c', 'core.quotepath=false', '-c', 'gc.auto=0',
      ...args,
    ], {
      cwd: root,
      env: shadowEnv(gitDir, root),
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'buffer',
    }, (err, stdout, stderr) => {
      if (err) { reject(Object.assign(err, { stderr: stderr.toString('utf8') })); } else { resolve(stdout); }
    });
  });
}

function shadowEnv(gitDir: string, root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) {
    delete env[key];
  }
  return env;
}

function gitRoot(cwd: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }, (err, out) => {
      resolve(err ? undefined : out.trim() || undefined);
    });
  });
}

/** UTF-8 text of a file's bytes; undefined for binary or non-UTF-8 content. */
function asText(buf: Buffer): string | undefined {
  if (buf.length > MAX_FILE_BYTES || buf.includes(0)) { return undefined; }
  const text = buf.toString('utf8');
  return Buffer.byteLength(text, 'utf8') === buf.length && Buffer.from(text, 'utf8').equals(buf) ? text : undefined;
}

async function readText(path: string): Promise<string | null | undefined> {
  try {
    return asText(await fs.readFile(path));
  } catch {
    return null; // missing
  }
}

/** gitignore pattern matching exactly one path. */
function exactPattern(rel: string): string {
  return '/' + rel.replace(/[\\*?[\]!#]/g, c => '\\' + c).replace(/^ /, '\\ ');
}

export interface TurnFileChange {
  path: string;
  /** Content before the turn; null when the file did not exist. */
  before: string | null;
  /** Content after the turn; null when the file was deleted. */
  after: string | null;
}

/**
 * Snapshots of the workspace taken before and after agent turns, to find
 * files an agent changed without an edit tool call (shell commands such as
 * `sed -i`, the agent's own patch tooling, scripts).
 *
 * Uses a private "shadow" git repository in the extension's storage whose
 * work tree is the workspace: it works with or without a git repository,
 * never touches the user's repository, honors .gitignore files, stores exact
 * bytes (no eol conversion) and only rehashes files that changed.
 */
export class WorkspaceSnapshots {
  /** Serializes git commands per shadow repository (they share one index). */
  private queues = new Map<string, Promise<unknown>>();
  private disabled = new Set<string>();
  private collected = new Set<string>();

  constructor(private readonly storageDir: string) {}

  /** Snapshot of the work tree containing `cwd`; undefined when unavailable (no git, too large). */
  async take(cwd: string): Promise<WorkspaceSnapshot | undefined> {
    const root = await gitRoot(cwd) ?? cwd;
    if (this.disabled.has(root)) { return undefined; }
    const gitDir = nodePath.join(this.storageDir, 'snapshots', createHash('sha1').update(root).digest('hex').slice(0, 16) + '.git');
    try {
      const tree = await this.serial(gitDir, async () => {
        await this.ensureRepo(gitDir, root);
        return this.writeTree(gitDir, root);
      });
      return new WorkspaceSnapshot(tree, root, gitDir, this);
    } catch (e: any) {
      log(`workspace snapshot unavailable for ${root}: ${e?.message ?? e}`);
      this.disabled.add(root);
      return undefined;
    }
  }

  /** @internal Tree of the work tree's current state. */
  async writeTree(gitDir: string, root: string): Promise<string> {
    await this.excludeLargeNewFiles(gitDir, root);
    for (let attempt = 0; ; attempt++) {
      try {
        await git(gitDir, root, ['add', '-A', '--ignore-errors']);
        break;
      } catch (e: any) {
        // Nested repositories without a commit abort `git add`; leave them out and retry
        const nested = [...String(e?.stderr ?? '').matchAll(/'([^']+)' does not have a commit checked out/g)].map(m => m[1].replace(/\/$/, ''));
        if (!nested.length || attempt >= 3) { break; } // keep whatever was staged
        await fs.appendFile(nodePath.join(gitDir, 'info', 'exclude'), nested.map(exactPattern).join('\n') + '\n');
      }
    }
    return (await git(gitDir, root, ['write-tree'])).toString('utf8').trim();
  }

  /** @internal */
  serial<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(gitDir) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(gitDir, run.catch(() => undefined));
    return run;
  }

  private async ensureRepo(gitDir: string, root: string): Promise<void> {
    try {
      await fs.access(nodePath.join(gitDir, 'HEAD'));
    } catch {
      await fs.mkdir(gitDir, { recursive: true });
      await git(gitDir, root, ['init', '-q']);
      const info = nodePath.join(gitDir, 'info');
      await fs.mkdir(info, { recursive: true });
      await fs.writeFile(nodePath.join(info, 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n');
      // Highest precedence: store every file byte for byte, whatever .gitattributes says
      await fs.writeFile(nodePath.join(info, 'attributes'), '* -text -filter -ident\n');
      log(`workspace snapshot: created shadow repository for ${root}`);
    }
    if (!this.collected.has(gitDir)) {
      // Snapshot trees are unreferenced; let git drop old ones now and then
      this.collected.add(gitDir);
      void this.serial(gitDir, () => git(gitDir, root, ['-c', 'gc.auto=6700', 'gc', '--auto', '--quiet', '--prune=2.days.ago'])).catch(() => undefined);
    }
  }

  /** Keep big files (logs, media, archives) out of the shadow repository. */
  private async excludeLargeNewFiles(gitDir: string, root: string): Promise<void> {
    const out = (await git(gitDir, root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString('utf8');
    const files = out.split('\0').filter(Boolean);
    if (files.length > MAX_NEW_FILES) {
      throw new Error(`${files.length} files to snapshot (limit ${MAX_NEW_FILES})`);
    }
    const large: string[] = [];
    await Promise.all(files.map(async rel => {
      try {
        if ((await fs.stat(nodePath.join(root, rel))).size > MAX_FILE_BYTES) { large.push(rel); }
      } catch { /* vanished */ }
    }));
    if (large.length) {
      await fs.appendFile(nodePath.join(gitDir, 'info', 'exclude'), large.map(exactPattern).join('\n') + '\n');
    }
  }
}

export class WorkspaceSnapshot {
  constructor(
    private readonly tree: string,
    private readonly root: string,
    private readonly gitDir: string,
    private readonly owner: WorkspaceSnapshots,
  ) {}

  /** Text files whose content differs from the snapshot. */
  async changes(): Promise<TurnFileChange[]> {
    const { gitDir, root } = this;
    const entries = await this.owner.serial(gitDir, async () => {
      const now = await this.owner.writeTree(gitDir, root);
      if (now === this.tree) { return []; }
      const out = (await git(gitDir, root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', this.tree, now])).toString('utf8');
      const fields = out.split('\0').filter(Boolean);
      const result: Array<{ status: string; rel: string }> = [];
      for (let i = 0; i + 1 < fields.length; i += 2) { result.push({ status: fields[i], rel: fields[i + 1] }); }
      return result;
    });

    const changes: TurnFileChange[] = [];
    await Promise.all(entries.map(async ({ status, rel }) => {
      const path = nodePath.join(root, ...rel.split('/'));
      const before = status === 'A' ? null : await this.blobText(rel);
      const after = await readText(path);
      if (before === undefined || after === undefined || before === after) { return; }
      changes.push({ path, before, after });
    }));
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async blobText(rel: string): Promise<string | undefined> {
    try {
      return asText(await git(this.gitDir, this.root, ['cat-file', 'blob', `${this.tree}:${rel}`]));
    } catch {
      return undefined; // e.g. a submodule entry
    }
  }
}
