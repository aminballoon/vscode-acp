import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

/**
 * Markdown skills offered to every agent. Unlike an agent's own slash
 * commands, their instructions are sent along with the prompt, so any ACP
 * agent can follow them.
 */
export interface FileSkill {
  name: string;
  description?: string;
  /** The skill's markdown file. */
  path: string;
}

/** `~/.acp/skills` for every project, `.acp/skills` for one workspace. */
export const DEFAULT_SKILL_PATHS = ['~/.acp/skills', '.acp/skills'];
export const WORKSPACE_SKILLS_DIR = nodePath.join('.acp', 'skills');

/**
 * Absolute paths for the configured entries: `~` is the home folder and
 * relative entries resolve in each workspace folder.
 */
export function resolveSkillPaths(entries: string[], workspaceFolders: string[], home = os.homedir()): string[] {
  const out = new Set<string>();
  for (const entry of entries.map(e => e.trim()).filter(Boolean)) {
    if (/^~(?=$|[\\/])/.test(entry)) {
      out.add(nodePath.join(home, entry.slice(1)));
    } else if (nodePath.isAbsolute(entry)) {
      out.add(nodePath.normalize(entry));
    } else {
      for (const ws of workspaceFolders) { out.add(nodePath.join(ws, entry)); }
    }
  }
  return [...out];
}

const FRONT_MATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Name, description (front matter, both optional) and instructions of a skill file. */
export function parseSkill(text: string, fallbackName: string): { name: string; description?: string; body: string } {
  const match = FRONT_MATTER.exec(text);
  const meta: Record<string, string> = {};
  for (const line of match?.[1].split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) { meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2'); }
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || undefined,
    body: (match ? text.slice(match[0].length) : text).trim(),
  };
}

/** Skills in the given files and folders; missing paths are skipped. */
export async function loadSkills(paths: string[]): Promise<FileSkill[]> {
  const files = [...new Set((await Promise.all(paths.map(skillFiles))).flat())];
  const skills = await Promise.all(files.map(async file => {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) { return undefined; }
    const { name, description } = parseSkill(text, fallbackName(file));
    return { name, description, path: file };
  }));
  return skills.filter(s => s !== undefined);
}

/** The instructions of a skill file, read when the prompt is sent so edits apply right away. */
export async function readSkillBody(file: string): Promise<string> {
  return parseSkill(await fs.readFile(file, 'utf8'), fallbackName(file)).body;
}

/**
 * Markdown files of a path: the file itself, or a folder's `.md` files plus
 * the `SKILL.md` of each subfolder (the layout of `~/.claude/skills`).
 */
async function skillFiles(p: string): Promise<string[]> {
  const stat = await fs.stat(p).catch(() => undefined);
  if (!stat) { return []; }
  if (stat.isFile()) { return isMarkdown(p) ? [p] : []; }
  const names = (await fs.readdir(p).catch(() => [] as string[])).sort();
  const files = await Promise.all(names.map(async name => {
    const full = nodePath.join(p, name);
    // stat (not the dirent) so symlinked skills count too
    const s = await fs.stat(full).catch(() => undefined);
    if (s?.isFile() && isMarkdown(name)) { return full; }
    if (!s?.isDirectory()) { return undefined; }
    const skill = nodePath.join(full, 'SKILL.md');
    return await fs.stat(skill).then(x => x.isFile(), () => false) ? skill : undefined;
  }));
  return files.filter(f => f !== undefined);
}

function isMarkdown(p: string): boolean {
  return /\.md$/i.test(p);
}

/** File name without `.md`; for a `SKILL.md`, the name of its folder. */
function fallbackName(file: string): string {
  const base = nodePath.basename(file, nodePath.extname(file));
  return base.toUpperCase() === 'SKILL' ? nodePath.basename(nodePath.dirname(file)) : base;
}
