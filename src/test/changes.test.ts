import * as assert from 'assert';
import * as vscode from 'vscode';

import { ChangeTracker } from '../changes/ChangeTracker';
import { contentBeforeDiffs, countLineChanges, FileDiff } from '../changes/diffUtil';
import { fingerprint } from '../utils/Logger';
import { isApproval, PERMISSION_APPROVED, PermissionTool } from '../chat/PermissionTool';
import { TurnRouter } from '../chat/TurnRouter';
import { markEdited } from '../chat/proposed';
import { PermissionHandler } from '../handlers/PermissionHandler';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

/** ChangeTracker over in-memory files and storage, as the extension drives it turn after turn. */
function memoryTracker(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const values = new Map<string, unknown>();
  const io = {
    read: async (p: string) => files.get(p) ?? null,
    readDisk: async (p: string) => files.get(p) ?? null,
    write: async (p: string, c: string) => { files.set(p, c); },
    remove: async (p: string) => { files.delete(p); },
  };
  const store = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  };
  return { files, tracker: new ChangeTracker(io, store), reopen: () => new ChangeTracker(io, store) };
}

const update = (oldText: string, newText: string): FileDiff => ({ oldText, newText, _meta: { kind: 'update' } });

suite('Pending changes across turns (ChangeTracker)', () => {
  test('a permission snapshot left by an edit VS Code showed natively is dropped, so the next turn starts fresh', async () => {
    const { files, tracker } = memoryTracker({ a: 'v1' });
    await tracker.captureBaseline('a'); // permission request, turn 1
    files.set('a', 'v2'); // the agent writes; VS Code shows it natively
    await tracker.keep('a'); // what the end of the turn does for natively shown files
    assert.strictEqual(tracker.get('a'), undefined);

    await tracker.captureBaseline('a'); // turn 2
    files.set('a', 'v3');
    assert.ok(await tracker.noteAgentResult('a'));
    assert.strictEqual(tracker.get('a')?.baseline, 'v2', 'diff of turn 2 starts from what turn 1 left');
  });

  test('prune drops unchanged snapshots of the given files only', async () => {
    const { files, tracker } = memoryTracker({ rejected: 'r', mine: 'm', other: 'o' });
    await tracker.captureBaseline('rejected'); // permission denied: never written
    await tracker.captureBaseline('mine');
    files.set('mine', 'm2'); // written: a real pending change
    await tracker.captureBaseline('other'); // another session, about to write
    await tracker.prune(p => p === 'rejected' || p === 'mine');
    assert.strictEqual(tracker.get('rejected'), undefined);
    assert.ok(tracker.get('mine'), 'changed files stay pending');
    assert.ok(tracker.get('other'), 'files of other turns are left alone');
  });

  test('prune skips entries removed meanwhile', async () => {
    const { tracker } = memoryTracker({ a: 'x' });
    await tracker.captureBaseline('a');
    const pruning = tracker.prune();
    await tracker.keep('a');
    await pruning;
    assert.strictEqual(tracker.size, 0);
  });

  test('two turns without Keep: the card keeps the first baseline and Undo restores the pre-agent content', async () => {
    const { files, tracker } = memoryTracker({ a: 'v1' });
    await tracker.noteTurnChange('a', 'v1');
    files.set('a', 'v2');
    assert.ok(await tracker.noteAgentResult('a'));
    await tracker.noteTurnChange('a', 'v2'); // turn 2 found by the workspace snapshot
    files.set('a', 'v3');
    assert.ok(await tracker.noteAgentResult('a'));
    assert.strictEqual(tracker.get('a')?.baseline, 'v1');
    assert.deepStrictEqual(await tracker.undo('a'), { undone: true, userEdited: false });
    assert.strictEqual(files.get('a'), 'v1');
  });

  test('Keep between turns: the next card starts from the kept content', async () => {
    const { files, tracker } = memoryTracker({ a: 'v1' });
    await tracker.captureBaseline('a');
    files.set('a', 'v2');
    await tracker.noteAgentResult('a');
    await tracker.keep('a');
    await tracker.captureBaseline('a');
    files.set('a', 'v3');
    await tracker.noteAgentResult('a');
    assert.strictEqual(tracker.get('a')?.baseline, 'v2');
    await tracker.undo('a');
    assert.strictEqual(files.get('a'), 'v2', 'Undo goes back to the kept content only');
  });

  test('the user edits between turns: Undo refuses until forced', async () => {
    const { files, tracker } = memoryTracker({ a: 'v1' });
    await tracker.captureBaseline('a');
    files.set('a', 'v2');
    await tracker.noteAgentResult('a');
    files.set('a', 'v2 + user');
    assert.deepStrictEqual(await tracker.undo('a'), { undone: false, userEdited: true });
    assert.strictEqual(files.get('a'), 'v2 + user');
  });

  test('an unchanged result drops the entry; a changed one records what the agent left', async () => {
    const { files, tracker } = memoryTracker({ same: 's', changed: 'c' });
    await tracker.captureBaseline('same');
    await tracker.captureBaseline('changed');
    files.set('changed', 'c2');
    assert.strictEqual(await tracker.noteAgentResult('same'), false);
    assert.strictEqual(await tracker.noteAgentResult('changed'), true);
    assert.strictEqual(tracker.get('same'), undefined);
    assert.strictEqual(tracker.get('changed')?.agentText, 'c2');
  });

  test('a new file: Undo deletes it; a deleted file: Undo restores it', async () => {
    const { files, tracker } = memoryTracker({ gone: 'old' });
    await tracker.captureBaseline('new');
    files.set('new', 'created');
    await tracker.noteAgentResult('new');
    await tracker.captureBaseline('gone');
    files.delete('gone');
    assert.ok(await tracker.noteAgentResult('gone'));
    await tracker.undoAll();
    assert.strictEqual(files.has('new'), false);
    assert.strictEqual(files.get('gone'), 'old');
    assert.strictEqual(tracker.size, 0);
  });

  test('captureBaseline keeps an existing baseline; versions grow so diff URIs are not cached', async () => {
    const { files, tracker } = memoryTracker({ a: 'v1' });
    await tracker.captureBaseline('a');
    const first = tracker.get('a')!.version;
    files.set('a', 'v2');
    await tracker.captureBaseline('a');
    assert.strictEqual(tracker.get('a')?.baseline, 'v1');
    await tracker.keep('a');
    await tracker.captureBaseline('a');
    assert.ok(tracker.get('a')!.version > first);
  });

  test('pending changes survive a restart; keepAll can be limited to some files', async () => {
    const { files, tracker, reopen } = memoryTracker({ a: 'a1', b: 'b1' });
    for (const p of ['a', 'b']) { await tracker.captureBaseline(p); files.set(p, p + '2'); await tracker.noteAgentResult(p); }
    const again = reopen();
    assert.deepStrictEqual(again.list().map(([p]) => p), ['a', 'b']);
    await again.keepAll(p => p === 'a');
    assert.deepStrictEqual(again.list().map(([p]) => p), ['b']);
  });

  test('concurrent calls on one file run in order', async () => {
    const { files, tracker } = memoryTracker({ a: 'v1' });
    const capture = tracker.captureBaseline('a');
    files.set('a', 'v2'); // written before the capture ran: the baseline is what it read
    const result = tracker.noteAgentResult('a');
    await Promise.all([capture, result]);
    assert.strictEqual(tracker.get('a'), undefined, 'captured after the write: nothing to show');
  });

  test('external diffs are adopted only when the disk holds their new text', async () => {
    const { files, tracker } = memoryTracker({ a: 'new' });
    await tracker.noteExternalDiff('a', 'fragment', 'other');
    assert.strictEqual(tracker.get('a'), undefined);
    await tracker.noteExternalDiff('a', 'old', 'new');
    assert.strictEqual(tracker.get('a')?.baseline, 'old');
    files.set('a', 'newer');
    await tracker.noteExternalDiff('a', 'new', 'newer');
    assert.strictEqual(tracker.get('a')?.baseline, 'old', 'later diffs keep the first baseline');
    assert.strictEqual(tracker.get('a')?.agentText, 'newer');
  });
});

suite('Pre-edit content from reported diffs (contentBeforeDiffs)', () => {
  test('hunks of one update, in file order', () => {
    assert.strictEqual(contentBeforeDiffs([update('a\nb\n', 'a\nB\n'), update('d\ne\n', 'd\nE\n')], 'a\nB\nc\nd\nE\n'), 'a\nb\nc\nd\ne\n');
  });

  test('a hunk whose new text repeats earlier in the file is matched after the previous hunk', () => {
    assert.strictEqual(contentBeforeDiffs([update('x\n', 'y\n'), update('z\n', 'y\n')], 'y\ny\n'), 'x\nz\n');
  });

  test('an append hunk with the last line as context', () => {
    assert.strictEqual(contentBeforeDiffs([update('last\n', 'last\n# more\n')], 'first\nlast\n# more\n'), 'first\nlast\n');
  });

  test('add, delete and rewrite', () => {
    assert.strictEqual(contentBeforeDiffs([{ oldText: null, newText: 'n\n', _meta: { kind: 'add' } }], 'n\n'), null);
    assert.strictEqual(contentBeforeDiffs([{ oldText: 'o\n', newText: '', _meta: { kind: 'delete' } }], null), 'o\n');
    assert.strictEqual(contentBeforeDiffs(
      [{ oldText: 'o\n', newText: '', _meta: { kind: 'delete' } }, { oldText: null, newText: 'n\n', _meta: { kind: 'add' } }], 'n\n'), 'o\n');
  });

  test('without _meta.kind: a missing oldText means a new file', () => {
    assert.strictEqual(contentBeforeDiffs([{ newText: 'n\n' }], 'n\n'), null);
    assert.strictEqual(contentBeforeDiffs([{ oldText: 'a', newText: 'b' }], 'xbx'), 'xax');
  });

  test('an add, then updates of the same file in a later call of the turn', () => {
    // Undone last call first: the update, then the add
    const afterUpdate = contentBeforeDiffs([update('1\n', '2\n')], '2\n');
    assert.strictEqual(afterUpdate, '1\n');
    assert.strictEqual(contentBeforeDiffs([{ oldText: null, newText: '1\n', _meta: { kind: 'add' } }], afterUpdate!), null);
  });

  test('diffs that no longer match what is on disk give up', () => {
    assert.strictEqual(contentBeforeDiffs([update('a', 'b')], 'c'), undefined, 'changed again since');
    assert.strictEqual(contentBeforeDiffs([update('a', 'b')], null), undefined, 'deleted since');
    assert.strictEqual(contentBeforeDiffs([{ oldText: null, newText: 'n', _meta: { kind: 'add' } }], 'other'), undefined);
    assert.strictEqual(contentBeforeDiffs([{ oldText: 'o', newText: '', _meta: { kind: 'delete' } }], 'still here'), undefined);
    assert.strictEqual(contentBeforeDiffs([update('a', '')], 'abc'), undefined, 'an empty new text cannot be located');
  });

  test('no diffs: the content as it is', () => {
    assert.strictEqual(contentBeforeDiffs([], 'x'), 'x');
  });
});

suite('Line counts and log fingerprints', () => {
  test('countLineChanges counts added and removed lines', () => {
    assert.deepStrictEqual(countLineChanges('a\nb\n', 'a\nB\nc\n'), { added: 2, removed: 1 });
    assert.deepStrictEqual(countLineChanges('', 'x\n'), { added: 1, removed: 0 });
    assert.deepStrictEqual(countLineChanges('same\n', 'same\n'), { added: 0, removed: 0 });
  });

  test('fingerprint tells contents apart without showing them', () => {
    assert.strictEqual(fingerprint('secret code'), fingerprint('secret code'));
    assert.notStrictEqual(fingerprint('secret code'), fingerprint('secret cods'));
    assert.ok(!fingerprint('secret code').includes('secret'));
    assert.match(fingerprint('abc'), /^3c#[0-9a-f]{8}$/);
    assert.strictEqual(fingerprint(null), 'missing');
    assert.strictEqual(fingerprint(undefined), 'unknown');
  });
});

suite('Permission answers from the Chat view', () => {
  const result = (text: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

  test('only the tool\'s own result is an approval: "Skip" resolves too, with VS Code\'s text', () => {
    assert.strictEqual(isApproval(result(PERMISSION_APPROVED)), true);
    assert.strictEqual(isApproval(result('The user chose to skip the tool call, they want to proceed without running it')), false);
    assert.strictEqual(isApproval(result('approved')), false);
    assert.strictEqual(isApproval(new vscode.LanguageModelToolResult([])), false);
  });
});

suite('Answering permission requests after VS Code snapshotted the files', () => {
  const request = (sessionId: string, path: string): RequestPermissionRequest => ({
    sessionId,
    toolCall: { toolCallId: 't1', title: 'Edit', kind: 'edit', status: 'pending', locations: [{ path }] },
    options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }],
  });
  const newRouter = () => {
    const { tracker } = memoryTracker({ '/w/a.py': 'v1' });
    const router = new TurnRouter(tracker, new PermissionTool());
    const turn = router.begin('s1', {} as vscode.ChatResponseStream, new vscode.CancellationTokenSource().token);
    return { router, turn, tracker };
  };

  test('waits until the externalEdit of the file has started', async () => {
    const { router, turn } = newRouter();
    let start = () => {};
    turn.editStarts.set('/w/a.py', new Promise<void>(r => { start = r; }));
    let answered = false;
    const prepared = router.prepareAnswer(request('s1', '/w/a.py')).then(() => { answered = true; });
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(answered, false, 'no answer before VS Code snapshotted the file');
    start();
    await prepared;
    assert.strictEqual(answered, true);
    assert.ok(turn.permissionPaths.has('/w/a.py'));
  });

  test('gives up waiting after the timeout', async () => {
    const { router, turn } = newRouter();
    turn.editStarts.set('/w/a.py', new Promise<void>(() => {}));
    const t0 = Date.now();
    await router.prepareAnswer(request('s1', '/w/a.py'), 100);
    assert.ok(Date.now() - t0 < 2000);
  });

  test('files without an externalEdit and requests outside a turn answer at once; the file is snapshotted', async () => {
    const { router, tracker } = newRouter();
    await router.prepareAnswer(request('s1', '/w/a.py'));
    await router.prepareAnswer(request('other-session', '/w/a.py'));
    await new Promise(r => setTimeout(r, 0));
    assert.strictEqual(tracker.get('/w/a.py')?.baseline, 'v1');
  });

  test('auto-approved requests wait for the preparation too', async () => {
    const config = vscode.workspace.getConfiguration('acp');
    const before = config.inspect('autoApprovePermissions')?.globalValue;
    await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);
    try {
      const order: string[] = [];
      const handler = new PermissionHandler(async () => { order.push('prompt'); return 'no'; }, async () => { order.push('prepare'); });
      const res = await handler.requestPermission(request('s1', '/w/a.py'));
      assert.deepStrictEqual(res, { outcome: { outcome: 'selected', optionId: 'yes' } });
      assert.deepStrictEqual(order, ['prepare']);
    } finally {
      await config.update('autoApprovePermissions', before, vscode.ConfigurationTarget.Global);
    }
  });
});

suite('Files shown by an externalEdit go back to "modified"', () => {
  test('markEdited ends a text edit of each file (VS Code resets a kept file only for text edits)', () => {
    const calls: Array<[string, unknown]> = [];
    const stream = { textEdit: (uri: vscode.Uri, edits: unknown) => { calls.push([uri.fsPath, edits]); } } as unknown as vscode.ChatResponseStream;
    markEdited(stream, [vscode.Uri.file('/w/a.py'), vscode.Uri.file('/w/b.py')]);
    assert.deepStrictEqual(calls, [[vscode.Uri.file('/w/a.py').fsPath, true], [vscode.Uri.file('/w/b.py').fsPath, true]]);
  });

  test('without the proposed API it does nothing', () => {
    assert.doesNotThrow(() => markEdited({} as vscode.ChatResponseStream, [vscode.Uri.file('/w/a.py')]));
  });
});
