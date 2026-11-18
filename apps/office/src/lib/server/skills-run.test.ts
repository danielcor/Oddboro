// A run's prompt lists the owner's skills on its Odd by name and when to use
// each, and tells it to read one with read_skill, never the skill's text. The
// same on every AI tool, since the office builds one prompt for all of them.
// That read_skill gives the text is the ledger's staff-skills.test.ts. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatOf, L } from './office-under-test.ts';

const TEXT = 'Step one: open the invoice. Step two: check the total.';

test('a run lists each skill by name and when to use it, without its text', async () => {
  for (const id of ['paige', 'gus']) {
    await L.setSkill(id, 'invoice-check', null, {
      description: 'Use when an invoice comes in.',
      text: TEXT
    });
    await L.setSkill(id, 'notes', null, { description: 'Use for meeting notes.', text: 'Notes.' });
    const { system } = await chatOf(id);
    assert.ok(
      system.includes(
        '\n## Your skills\n\nBefore you follow one of these skills, call read_skill with its name to get its full instructions.\n\n- invoice-check: Use when an invoice comes in.\n- notes: Use for meeting notes.\n'
      ),
      `${id}'s prompt has no skills section`
    );
    assert.ok(!system.includes(TEXT), `${id}'s prompt carries a skill's text`);
  }
  // An Odd with no skill hears nothing of them.
  assert.ok(!(await chatOf('cleo')).system.includes('read_skill'));
});
