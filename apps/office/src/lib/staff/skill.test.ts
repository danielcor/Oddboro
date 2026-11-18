// What the office reads from a SKILL.md's front matter: its name, when to use
// it, and whether it asks for tools, in each way YAML writes them, and nothing
// from a file without front matter. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { descriptionProblem, frontMatter, mentionsFiles, nameProblem } from './skill.ts';

test('front matter gives the name, the description and whether it asks for tools', () => {
  assert.deepEqual(
    frontMatter(
      '---\nname: invoice-check\ndescription: Use when an invoice comes in.\nallowed-tools: Read, Grep\n---\n# Steps\n'
    ),
    { name: 'invoice-check', description: 'Use when an invoice comes in.', asksForTools: true }
  );
  // Quoted values, a folded block, a list of tools, and Windows line ends.
  assert.deepEqual(
    frontMatter(
      '---\r\nname: "weekly report"\r\ndescription: >\r\n  Use on Fridays,\r\n  for the report.\r\nallowed-tools:\r\n  - Bash\r\n---\r\nText'
    ),
    { name: 'weekly report', description: 'Use on Fridays, for the report.', asksForTools: true }
  );
});

test('missing parts stay missing', () => {
  assert.deepEqual(frontMatter('---\nname: notes\n---\nKeep notes.'), {
    name: 'notes',
    asksForTools: false
  });
  assert.deepEqual(frontMatter('---\ndescription: ""\nallowed-tools:\n---\n'), {
    asksForTools: false
  });
  // No front matter, or one never closed, gives nothing.
  assert.deepEqual(frontMatter('# Notes\nname: not front matter'), { asksForTools: false });
  assert.deepEqual(frontMatter('---\nname: open'), { asksForTools: false });
});

test('a skill that points at other files says so', () => {
  assert.ok(mentionsFiles('Run scripts/check.py first.'));
  assert.ok(mentionsFiles('See [the form](reference/form.md).'));
  assert.ok(mentionsFiles('Fill in template.csv.'));
  assert.ok(!mentionsFiles('Read SKILL.md again. See [docs](https://example.com/a.md).'));
});

test('a name and a description must be one short line', () => {
  assert.equal(nameProblem('invoice-check'), undefined);
  assert.equal(nameProblem(''), 'Give the skill a name.');
  assert.match(nameProblem('a/b') ?? '', /letters, numbers/);
  assert.equal(descriptionProblem(''), 'Say in one line when to use this skill.');
  assert.match(descriptionProblem('x'.repeat(501)) ?? '', /500 characters/);
});
