// Answers to things an Odd raised on no work wake it once: each joins its
// `answered` run still waiting to start, a line each, as answers on a thread
// join its lead's pick-up. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { followUps, staff } from '../src/schema.ts';
import { db } from './pglite.ts';

const { decideAsk, finishTask, giveTask, raiseAsk, startFollowUp } =
  await import('../src/office.ts');

const odd = (id: string, name: string) => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`
});
await db.insert(staff).values([odd('ada', 'Ada'), odd('ivy', 'Ivy'), odd('sam', 'Sam')]);

const askNo = async (staffId: string, title: string) => {
  const { ask } = await raiseAsk(staffId, { title, why: 'w', ifApproved: 'i' });
  assert.equal(await decideAsk(ask.id, 'deny', null), true);
  return ask;
};
const answered = (staffId: string) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.staffId, staffId), eq(followUps.kind, 'answered')))
    .orderBy(followUps.id);
const lines = (note: string | null) => (note ?? '').split('\n');

test('five nos on no work give one queued run that carries all five answers', async () => {
  const titles = ['Buy paper', 'Buy ink', 'Buy pens', 'Buy tape', 'Buy glue'];
  for (const t of titles) await askNo('ada', t);
  const runs = await answered('ada');
  assert.equal(runs.length, 1, 'one run, not five');
  assert.equal(runs[0].threadId, null);
  const said = lines(runs[0].note);
  assert.equal(said.length, 5);
  titles.forEach((t, i) => assert.match(said[i], new RegExp(`"${t}"`)));

  // A task Ada gave on no work, dropped, joins the same run.
  const task = await giveTask('ada', { title: 'Sign the form', why: 'w', steps: ['Sign'] });
  await finishTask(task.id, false, 'not now');
  const after = await answered('ada');
  assert.equal(after.length, 1);
  assert.match(lines(after[0].note)[5], /"Sign the form": not now/);
});

test('an answer after that run was claimed starts a new one', async () => {
  await askNo('ivy', 'Order chairs');
  const [first] = await answered('ivy');
  assert.ok(await startFollowUp(first.id), 'the run is claimed');
  await askNo('ivy', 'Order desks');
  const runs = await answered('ivy');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].note, first.note, 'the claimed run keeps only what it was claimed with');
  assert.equal(lines(runs[1].note).length, 1);
  assert.match(runs[1].note ?? '', /"Order desks"/);
});

test('answers for two different Odds give two runs, one each', async () => {
  await db.delete(followUps);
  await askNo('ada', 'Paint the door');
  await askNo('sam', 'Paint the gate');
  await askNo('ada', 'Paint the wall');
  const ada = await answered('ada');
  const sam = await answered('sam');
  assert.equal(ada.length, 1);
  assert.equal(sam.length, 1);
  assert.equal(lines(ada[0].note).length, 2);
  assert.equal(lines(sam[0].note).length, 1);
  assert.match(sam[0].note ?? '', /"Paint the gate"/);
});
