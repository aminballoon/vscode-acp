import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promptWithSkills, SkillSelection, skillsLabel } from '../chat/SkillSelection';
import { loadSkills, parseSkill, readSkillBody, resolveSkillPaths } from '../chat/SkillLibrary';

suite('Skill selection', () => {
	test('one command is sent as a slash command', () => {
		assert.strictEqual(promptWithSkills('fix it', ['review']), '/review fix it');
		assert.strictEqual(promptWithSkills('fix it', []), 'fix it');
	});

	test('several commands are named in a preamble', () => {
		assert.strictEqual(
			promptWithSkills('fix it', ['review', 'simplify']),
			'Use these skills for this request: /review, /simplify\n\nfix it',
		);
	});

	test('markdown skills are sent as instructions ahead of the prompt', () => {
		assert.strictEqual(
			promptWithSkills('fix it', [], [{ name: 'api', body: 'Use plural nouns.' }]),
			'Follow these skills for this request:\n\n<skill name="api">\nUse plural nouns.\n</skill>\n\nfix it',
		);
		assert.ok(promptWithSkills('fix it', ['review'], [{ name: 'api', body: 'x' }]).startsWith('/review Follow these skills'));
	});

	test('picks apply to one prompt per agent', () => {
		const s = new SkillSelection();
		let changes = 0;
		s.on('changed', () => changes++);
		s.set('claude', [{ name: 'review' }, { name: 'api', path: '/skills/api.md' }]);
		assert.deepStrictEqual(s.get('codex'), []);
		assert.deepStrictEqual(s.take('claude'), [{ name: 'review' }, { name: 'api', path: '/skills/api.md' }]);
		assert.deepStrictEqual(s.take('claude'), []);
		assert.strictEqual(changes, 2);
	});

	test('label shows the first skill and a count', () => {
		assert.strictEqual(skillsLabel(['review', 'simplify', 'verify']), 'review +2');
		assert.strictEqual(skillsLabel([]), 'Skills');
	});
});

suite('Skill library', () => {
	test('front matter gives name and description; both are optional', () => {
		assert.deepStrictEqual(
			parseSkill('---\r\nname: api\r\ndescription: "REST rules"\r\n---\r\nUse plural nouns.\r\n', 'file'),
			{ name: 'api', description: 'REST rules', body: 'Use plural nouns.' },
		);
		assert.deepStrictEqual(parseSkill('Just do it.', 'file'), { name: 'file', description: undefined, body: 'Just do it.' });
	});

	test('paths resolve ~ and workspace-relative entries', () => {
		assert.deepStrictEqual(
			resolveSkillPaths(['~/.acp/skills', '.acp/skills', '/abs/a.md', ' '], ['/ws1', '/ws2'], '/home/me'),
			['/home/me/.acp/skills', '/ws1/.acp/skills', '/ws2/.acp/skills', '/abs/a.md'],
		);
	});

	test('loads .md files, SKILL.md folders and single files; skips missing paths', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-skills-'));
		try {
			fs.writeFileSync(path.join(root, 'api.md'), '---\ndescription: REST rules\n---\nUse plural nouns.');
			fs.writeFileSync(path.join(root, 'notes.txt'), 'not a skill');
			fs.mkdirSync(path.join(root, 'review'));
			fs.writeFileSync(path.join(root, 'review', 'SKILL.md'), '---\nname: careful-review\n---\nCheck everything.');
			fs.writeFileSync(path.join(root, 'review', 'reference.md'), 'only SKILL.md counts in subfolders');
			const single = path.join(os.tmpdir(), `acp-single-${process.pid}.md`);
			fs.writeFileSync(single, 'Be brief.');
			try {
				const skills = await loadSkills([root, single, path.join(root, 'missing'), root]);
				assert.deepStrictEqual(skills.map(s => [s.name, s.description]), [
					['api', 'REST rules'], ['careful-review', undefined], [path.basename(single, '.md'), undefined],
				]);
				assert.strictEqual(await readSkillBody(path.join(root, 'review', 'SKILL.md')), 'Check everything.');
			} finally {
				fs.rmSync(single, { force: true });
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
