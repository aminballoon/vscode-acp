import { diffLines } from 'diff';

export interface DiffRow {
  /** '+' added, '-' removed, ' ' unchanged (or '…' for a collapsed run). */
  t: '+' | '-' | ' ';
  s: string;
}

/** Number of added and removed lines between two texts. */
export function countLineChanges(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const part of diffLines(oldText, newText)) {
    if (part.added) { added += part.count ?? 0; }
    else if (part.removed) { removed += part.count ?? 0; }
  }
  return { added, removed };
}

/** One ACP `diff` content block; `_meta.kind` is set by codex-acp. */
export interface FileDiff {
  oldText?: string | null;
  newText: string;
  _meta?: { [key: string]: unknown } | null;
}

function kindOf(d: FileDiff): unknown {
  return d._meta?.kind ?? (d.oldText === null || d.oldText === undefined ? 'add' : 'update');
}

/**
 * Content of a file before the edits described by `diffs` (in reported
 * order), given its content `now` after them. Update blocks may be hunks with
 * context rather than whole files. Returns undefined when the diffs do not
 * match `now` (e.g. the file changed again since).
 */
export function contentBeforeDiffs(diffs: FileDiff[], now: string | null): string | null | undefined {
  let content = now;
  for (let end = diffs.length; end > 0;) {
    const d = diffs[end - 1];
    const kind = kindOf(d);
    if (kind === 'add') {
      if (content !== d.newText) { return undefined; }
      content = null;
      end--;
    } else if (kind === 'delete') {
      if (content !== null || typeof d.oldText !== 'string') { return undefined; }
      content = d.oldText;
      end--;
    } else {
      // Hunks of an update are in file order: undo each run of them in one forward pass
      let start = end - 1;
      while (start > 0 && kindOf(diffs[start - 1]) === 'update') { start--; }
      if (content === null) { return undefined; }
      let out = '', cursor = 0;
      for (const h of diffs.slice(start, end)) {
        const at = h.newText ? content.indexOf(h.newText, cursor) : -1;
        if (at < 0) { return undefined; }
        out += content.slice(cursor, at) + (h.oldText ?? '');
        cursor = at + h.newText.length;
      }
      content = out + content.slice(cursor);
      end = start;
    }
  }
  return content;
}

/**
 * Line rows for a compact diff preview. With `context`, unchanged runs longer
 * than six lines are collapsed to their first and last two lines; without it,
 * only changed lines are returned.
 */
export function diffRows(oldText: string, newText: string, opts: { context: boolean; max: number }): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const part of diffLines(oldText, newText)) {
    const t = part.added ? '+' : part.removed ? '-' : ' ';
    if (t === ' ' && !opts.context) { continue; }
    const lines = part.value.replace(/\n$/, '').split('\n');
    const shown = t === ' ' && lines.length > 6 ? [...lines.slice(0, 2), '…', ...lines.slice(-2)] : lines;
    for (const s of shown) { rows.push({ t, s }); }
  }
  return rows.slice(0, opts.max);
}
