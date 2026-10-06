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
