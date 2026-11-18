// The owner's skills on an Odd: added, updated and removed by name, each
// change only while the saved copy is the one the owner reviewed, so two open
// windows cannot both win, and each recorded as the owner's. read_skill gives
// an Odd only its own skill's text, and an Odd with no skill is not offered
// it. The tool server runs in its own process, as for a run (tool-server.ts).
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db, sql, toolServer } from './tool-server.ts';

const { staff } = await import('../src/schema.ts');
const { setSkill, skillsOf } = await import('../src/office.ts');

const odd = (id: string, name: string) => ({
  id,
  name,
  role: 'Reviewer',
  remit: 'Review invoices.',
  variant: 'a',
  portrait: 'a',
  desk: `You are ${name}.`
});
await db
  .insert(staff)
  .values([odd('reader', 'Reader'), odd('other', 'Other'), odd('plain', 'Plain')]);

const receipts = { description: 'Use for receipts.', text: 'Check every receipt.' };
const totals = { description: 'Use for totals.', text: 'Check every total.' };
const ownerLines = async () =>
  (await sql<{ title: string }[]>`select title from ledger where actor = 'owner' order by id`).map(
    (r) => r.title
  );

test('a skill is added, updated and removed only against the copy the owner reviewed', async () => {
  // Two windows add the same name at once: one wins.
  const adds = await Promise.all([
    setSkill('reader', 'invoices', null, receipts),
    setSkill('reader', 'invoices', null, totals)
  ]);
  assert.equal(adds.filter(Boolean).length, 1);
  const [kept] = await skillsOf('reader');
  assert.equal(kept.name, 'invoices');
  const stale = kept.text === receipts.text ? totals : receipts;
  // A window that saw the other copy, or none, changes nothing.
  assert.equal(await setSkill('reader', 'invoices', stale, receipts), false);
  assert.equal(await setSkill('reader', 'invoices', null, receipts), false);
  assert.equal(await setSkill('reader', 'invoices', stale, null), false);
  // Against the saved copy, it updates, and a second skill sits beside it.
  const now = { description: kept.description, text: kept.text };
  const next = { description: 'Use before paying.', text: 'Check the total, then the date.' };
  assert.ok(await setSkill('reader', 'invoices', now, next));
  assert.ok(await setSkill('reader', 'dates', null, { description: 'Use for dates.', text: 'X' }));
  assert.deepEqual(
    (await skillsOf('reader')).map((s) => [s.name, s.description]),
    [
      ['dates', 'Use for dates.'],
      ['invoices', 'Use before paying.']
    ]
  );
  assert.equal(await setSkill('reader', 'invoices', now, null), false);
  assert.ok(await setSkill('reader', 'invoices', next, null));
  assert.deepEqual(
    (await skillsOf('reader')).map((s) => s.name),
    ['dates']
  );
  assert.deepEqual(await ownerLines(), [
    "Added Reader's skill invoices",
    "Updated Reader's skill invoices",
    "Added Reader's skill dates",
    "Removed Reader's skill invoices"
  ]);
  // An Odd that left the office takes no skill.
  await sql`update staff set left_at = now() where id = 'plain'`;
  assert.equal(await setSkill('plain', 'x', null, receipts), false);
  await sql`update staff set left_at = null where id = 'plain'`;
});

/** The text a read_skill call returned, and whether it was an error. */
async function read(id: string, name: string) {
  const c = await toolServer(id, { RUN_KEY: `k-${id}` });
  const listed = (await c.listTools()).tools.map((t) => t.name);
  if (!listed.includes('read_skill')) return { offered: false, text: '', error: true };
  const r = await c.callTool({ name: 'read_skill', arguments: { name } });
  return {
    offered: true,
    text: (r.content as { text: string }[])[0]?.text ?? '',
    error: r.isError === true
  };
}

test("read_skill gives an Odd its own skill's text and refuses any other", async () => {
  await sql`delete from staff_skills`;
  await setSkill('reader', 'invoices', null, receipts);
  await setSkill('other', 'secrets', null, { description: 'Use never.', text: 'Not yours.' });
  assert.deepEqual(await read('reader', 'Invoices'), {
    offered: true,
    text: 'Check every receipt.',
    error: false
  });
  const theirs = await read('reader', 'secrets');
  assert.equal(theirs.error, true);
  assert.equal(theirs.text, 'You have no skill named secrets. Your skills: invoices.');
  assert.doesNotMatch(theirs.text, /Not yours/);
  assert.equal((await read('reader', 'missing')).error, true);
  // An Odd with no skill is not offered the tool.
  assert.equal((await read('plain', 'invoices')).offered, false);
});
