import * as assert from 'assert';
import { formatElapsed, QUIET_MS, TurnActivity } from '../chat/TurnActivity';
import type { ToolState } from '../chat/proposed';

function setup() {
	let t = 0;
	const rendered: Array<ToolState & { isUpdate: boolean }> = [];
	const activity = new TurnActivity('Claude Code', (tool, isUpdate) => rendered.push({ ...tool, isUpdate }), () => t, false);
	return { activity, rendered, advance: (ms: number) => { t += ms; }, last: () => rendered[rendered.length - 1] };
}

suite('Turn activity', () => {
	test('elapsed time reads naturally', () => {
		assert.strictEqual(formatElapsed(8_400), '8s');
		assert.strictEqual(formatElapsed(65_000), '1m 05s');
		assert.strictEqual(formatElapsed(3_725_000), '1h 02m');
	});

	test('a running tool call shows its elapsed time on each tick', () => {
		const { activity, advance, last } = setup();
		activity.tool('t1', '`npm test`', 'in_progress', false);
		assert.strictEqual(last().title, '`npm test`');
		advance(65_000);
		activity.tick();
		assert.deepStrictEqual([last().title, last().isUpdate], ['`npm test` · 1m 05s', true]);
		activity.tool('t1', undefined, 'completed', true);
		assert.deepStrictEqual([last().title, last().status], ['`npm test`', 'completed']);
	});

	test('updates without a title keep the earlier title', () => {
		const { activity, last } = setup();
		activity.tool('g1', 'Grep sleep', 'pending', false);
		activity.tool('g1', null, 'completed', true);
		assert.strictEqual(last().title, 'Grep sleep');
	});

	test('a quiet agent gets a waiting row that hides on the next update', () => {
		const { activity, rendered, advance, last } = setup();
		advance(QUIET_MS - 1);
		activity.tick();
		assert.strictEqual(rendered.length, 0);
		advance(15_000 - (QUIET_MS - 1));
		activity.tick();
		assert.deepStrictEqual([last().title, last().isUpdate, last().presentation], ['Waiting for Claude Code · 15s', false, 'hiddenAfterComplete']);
		const id = last().toolCallId;
		activity.touch();
		assert.deepStrictEqual([last().toolCallId, last().status], [id, 'completed']);
	});

	test('a tick keeps a pending tool call pending', () => {
		const { activity, advance, last } = setup();
		activity.tool('p1', 'Edit file', 'pending', false);
		advance(5_000);
		activity.tick();
		assert.deepStrictEqual([last().title, last().status], ['Edit file · 5s', 'pending']);
	});

	test('no waiting row while a tool call runs', () => {
		const { activity, rendered, advance } = setup();
		activity.tool('t1', 'Terminal', 'in_progress', false);
		advance(QUIET_MS * 3);
		activity.tick();
		assert.ok(rendered.every(r => r.toolCallId === 't1'));
	});

	test('the end of the turn closes a waiting row', () => {
		const { activity, advance, last } = setup();
		advance(QUIET_MS);
		activity.tick();
		activity.dispose();
		assert.strictEqual(last().status, 'completed');
	});
});
