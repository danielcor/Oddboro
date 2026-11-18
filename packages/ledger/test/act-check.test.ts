// The Act check: nothing puts an Odd at Act until the owner passed it, not the
// Settings tab, not a level ask's yes and not a hire. The office checks the
// answers, keeps the pass once with one ledger line, and never asks again.
// Read and Draft never need it, and an Odd already at Act stays there.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db, sql } from './tool-server.ts';

const { asks, ledger, owner, staff } = await import('../src/schema.ts');
const { eq } = await import('drizzle-orm');
const O = await import('../src/office.ts');
const { ACT_CHECK, ACT_CHECK_NEEDED, wrongAnswers } = await import('../src/act-check.ts');

const RIGHT = ACT_CHECK.map((item) => item.answer);
const odd = (id: string, name: string, permission: 'read' | 'draft' | 'act' = 'draft') => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission,
  tools: [],
  desk: `You are ${name}.`
});
await db.insert(owner).values({ name: 'Nora' });
await db.insert(staff).values([odd('ada', 'Ada'), odd('sage', 'Sage', 'act')]);

beforeEach(async () => {
  await sql`delete from ledger`;
  await sql`delete from follow_ups`;
  await sql`delete from asks`;
  await db.update(owner).set({ actCheckAt: null });
  await db.update(staff).set({ permission: 'draft' }).where(eq(staff.id, 'ada'));
});

const level = async (id: string) =>
  (await db.select().from(staff).where(eq(staff.id, id)))[0].permission;
const titles = async () => (await db.select().from(ledger)).map((l) => l.title);
const levelAsk = () =>
  O.raiseAsk('ada', {
    kind: 'level',
    level: 'act',
    title: 'Raise Ada from Draft to Act',
    why: 'Replies every day.',
    ifApproved: 'Ada works at Act.'
  });

test('the right answers are one place, and the check finds each wrong one', () => {
  assert.deepEqual(RIGHT, [true, true, false]);
  assert.deepEqual(wrongAnswers(RIGHT), []);
  assert.deepEqual(wrongAnswers([false, true, true]), [0, 2]);
  assert.equal(wrongAnswers([true, true]), undefined);
  assert.equal(wrongAnswers(['true', true, false]), undefined);
});

test('the Settings tab cannot put an Odd at Act before the check, and can after it', async () => {
  await assert.rejects(O.setPermission('ada', 'act'), (e) => e instanceof O.ActCheckNeeded);
  assert.equal(await level('ada'), 'draft');
  assert.deepEqual(await titles(), []);
  assert.deepEqual(await O.passActCheck(RIGHT), { wrong: [] });
  await O.setPermission('ada', 'act');
  assert.equal(await level('ada'), 'act');
});

test('Read and Draft never need the check, and an Odd already at Act stays there', async () => {
  await O.setPermission('ada', 'read');
  await O.setPermission('ada', 'draft');
  assert.equal(await level('ada'), 'draft');
  assert.equal(await level('sage'), 'act');
  assert.equal(await O.actCheckPassed(), false);
});

test('wrong answers do not pass, change nothing and write no line', async () => {
  assert.deepEqual(await O.passActCheck([true, false, true]), { wrong: [1, 2] });
  assert.equal(await O.actCheckPassed(), false);
  assert.deepEqual(await titles(), []);
  await assert.rejects(O.passActCheck([true]), /true or false/);
  assert.equal(await O.actCheckPassed(), false);
});

test('a pass is kept once, with its time and one ledger line', async () => {
  await O.passActCheck(RIGHT);
  const [first] = await db.select().from(owner);
  assert.ok(first.actCheckAt);
  await O.passActCheck(RIGHT);
  const [again] = await db.select().from(owner);
  assert.deepEqual(again.actCheckAt, first.actCheckAt);
  assert.deepEqual(await titles(), ['Passed the Act check']);
});

test("a level ask's yes to Act is refused before the check, and the ask stays open", async () => {
  const { ask } = await levelAsk();
  await assert.rejects(O.decideAsk(ask.id, 'approve', null), { message: ACT_CHECK_NEEDED });
  const [still] = await db.select().from(asks).where(eq(asks.id, ask.id));
  assert.equal(still.status, 'open');
  assert.equal(await level('ada'), 'draft');
  await O.passActCheck(RIGHT);
  assert.equal(await O.decideAsk(ask.id, 'approve', null), true);
  assert.equal(await level('ada'), 'act');
});

test('a hire at Act waits for the check; a hire at Draft never does', async () => {
  const hire = (name: string, permission: 'draft' | 'act') =>
    O.hire({
      name,
      role: 'Tester',
      remit: 'Tests.',
      desk: `You are ${name}.`,
      room: 'workspace',
      variant: 'a',
      portrait: 'a',
      permission
    });
  await assert.rejects(hire('Rowan', 'act'), (e) => e instanceof O.ActCheckNeeded);
  assert.equal((await hire('Remy', 'draft')).permission, 'draft');
  await O.passActCheck(RIGHT);
  assert.equal((await hire('Rowan', 'act')).permission, 'act');
});

test('a hire at Act keeps the choice for work from colleagues, with its own line; a hire below Act never takes one', async () => {
  await O.passActCheck(RIGHT);
  const hire = (name: string, permission: 'draft' | 'act', actsOnHandOffs: boolean) =>
    O.hire({
      name,
      role: 'Tester',
      remit: 'Tests.',
      desk: `You are ${name}.`,
      room: 'workspace',
      variant: 'a',
      portrait: 'a',
      permission,
      actsOnHandOffs
    });
  await sql`delete from ledger`;
  assert.equal((await hire('Iris', 'act', true)).actsOnHandOffs, true);
  assert.equal((await hire('Ivo', 'act', false)).actsOnHandOffs, false);
  assert.equal((await hire('Ines', 'draft', true)).actsOnHandOffs, false);
  assert.deepEqual(await titles(), [
    'Hired Iris, Tester',
    'Let Iris act on its own on work from colleagues',
    'Hired Ivo, Tester',
    'Hired Ines, Tester'
  ]);
});
