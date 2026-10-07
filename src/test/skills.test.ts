import * as assert from 'assert';
import { promptWithSkills, SkillSelection, skillsLabel } from '../chat/SkillSelection';

suite('Skill selection', () => {
	test('one skill is sent as a slash command', () => {
		assert.strictEqual(promptWithSkills('fix it', ['review']), '/review fix it');
		assert.strictEqual(promptWithSkills('fix it', []), 'fix it');
	});

	test('several skills are named in a preamble', () => {
		assert.strictEqual(
			promptWithSkills('fix it', ['review', 'simplify']),
			'Use these skills for this request: /review, /simplify\n\nfix it',
		);
	});

	test('picks apply to one prompt per agent', () => {
		const s = new SkillSelection();
		let changes = 0;
		s.on('changed', () => changes++);
		s.set('claude', ['review', 'simplify']);
		assert.deepStrictEqual(s.get('codex'), []);
		assert.deepStrictEqual(s.take('claude'), ['review', 'simplify']);
		assert.deepStrictEqual(s.take('claude'), []);
		assert.strictEqual(changes, 2);
	});

	test('label shows the first skill and a count', () => {
		assert.strictEqual(skillsLabel(['review', 'simplify', 'verify']), 'review +2');
		assert.strictEqual(skillsLabel([]), 'Skills');
	});
});
