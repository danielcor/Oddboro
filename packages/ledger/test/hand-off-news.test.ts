// The floor's news of each hand-off: the office's own code on every migration,
// in an in-memory PGlite that stands in for db.ts (pglite.ts). Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desc, eq } from 'drizzle-orm';
import { followUps, staff, threads } from '../src/schema.ts';
import { db } from './pglite.ts';

// Loaded once db.ts is this database, so every query they make lands here.
const { handOff } = await import('../src/hand-offs.ts');
const { handOffMark, handOffNewsSince } = await import('../src/hand-off-news.ts');
const { decideAsk, finishFollowUp, raiseAsk } = await import('../src/office.ts');

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
await db.insert(staff).values([odd('cole', 'Cole'), odd('ivy', 'Ivy')]);

const holderOf = async (id: number) =>
  (await db.select().from(threads).where(eq(threads.id, id)))[0].holderId;
const followUp = async (id: number) =>
  (await db.select().from(followUps).where(eq(followUps.id, id)))[0];

test('a hand-off and its hand-back are each news once, and an owner-answered hand-back is none', async () => {
  const start = await handOffMark();
  const given = await handOff({
    from: 'cole',
    to: 'ivy',
    work: { title: 'More presets', brief: 'Add two presets.' },
    thread: { title: 'Build a gravity sim' }
  });
  assert.ok('id' in given, JSON.stringify(given));

  const first = await handOffNewsSince(start);
  assert.deepEqual(first.news, [{ kind: 'given', from: 'cole', to: 'ivy' }]);
  assert.equal(await holderOf(given.thread), 'ivy', 'the colleague holds the thread');
  assert.deepEqual((await handOffNewsSince(first.mark)).news, [], 'a second read tells nothing');

  await finishFollowUp(await followUp(given.id), 'More presets', 'done', 'Added two.');
  const back = await handOffNewsSince(first.mark);
  assert.deepEqual(back.news, [{ kind: 'back', from: 'ivy', to: 'cole' }]);
  assert.equal(await holderOf(given.thread), 'cole', 'the thread is back with its hub');
  assert.deepEqual((await handOffNewsSince(back.mark)).news, []);

  const { ask } = await raiseAsk('ivy', {
    title: 'Ship the presets',
    why: 'They are ready.',
    ifApproved: 'I ship them.',
    handOffId: given.id
  });
  await decideAsk(ask.id, 'deny', null);
  // The no goes back to the lead as a hand-back that carries the owner's answer.
  const [last] = await db.select().from(followUps).orderBy(desc(followUps.id)).limit(1);
  assert.deepEqual(
    [last.kind, last.staffId, last.handOff?.answered],
    ['handed_back', 'cole', true]
  );
  const answered = await handOffNewsSince(back.mark);
  assert.deepEqual(answered.news, [], 'nobody worked, so nobody walks over');
  assert.ok(answered.mark > back.mark, 'and the mark moves past it');
});
