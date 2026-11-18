// The titles of the threads an Odd can read, for its Storage tab: the same
// test `workFile` uses, so a file Storage lists is one that opens. The
// office's own code on every migration, in an in-memory PGlite that stands in
// for db.ts (pglite.ts). Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { followUps, goals, staff, staffGoals, threads } from '../src/schema.ts';
import { db } from './pglite.ts';

// Loaded once db.ts is this database, so every query they make lands here.
const { isOnThread, workTitles } = await import('../src/threads.ts');

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
await db.insert(staff).values([odd('vera', 'Vera'), odd('jax', 'Jax'), odd('rex', 'Rex')]);

async function thread(title: string, hubId: string, goalId?: number): Promise<number> {
  const [{ id }] = await db
    .insert(threads)
    .values({ title, hubId, holderId: hubId, goalId })
    .returning({ id: threads.id });
  return id;
}
const handed = (staffId: string, threadId: number) =>
  db
    .insert(followUps)
    .values({ staffId, kind: 'hand_off', threadId, outcome: 'done', doneAt: new Date() });

test('an Odd gets the titles of the threads it leads and works on, and of no other', async () => {
  const led = await thread('Vera leads', 'vera');
  const worked = await thread('Vera was handed', 'jax');
  await handed('vera', worked);
  const off = await thread('Vera is off this', 'jax');

  const titles = await workTitles('vera', [led, worked, off, 987654]);
  assert.deepEqual(
    [...titles].sort(([a], [b]) => a - b),
    [
      [led, 'Vera leads'],
      [worked, 'Vera was handed']
    ]
  );
  for (const [id, on] of [
    [led, true],
    [worked, true],
    [off, false]
  ] as const)
    assert.equal(await isOnThread('vera', id), on, 'the same test as workFile');
});

test('a closed thread keeps its title, since workFile has no status filter', async () => {
  const id = await thread('Finished', 'vera');
  await db.update(threads).set({ status: 'done', endedAt: new Date() }).where(eq(threads.id, id));
  assert.deepEqual([...(await workTitles('vera', [id]))], [[id, 'Finished']]);
  assert.equal(await isOnThread('vera', id), true);
});

test('an Odd taken off a goal with no hand-off loses the title, as workFile loses the file', async () => {
  const [{ id: goalId }] = await db
    .insert(goals)
    .values({ title: 'A goal' })
    .returning({ id: goals.id });
  await db.insert(staffGoals).values({ staffId: 'rex', goalId, part: 'Builds it' });
  const id = await thread('The goal', 'jax', goalId);
  assert.deepEqual([...(await workTitles('rex', [id]))], [[id, 'The goal']]);

  await db
    .delete(staffGoals)
    .where(and(eq(staffGoals.staffId, 'rex'), eq(staffGoals.goalId, goalId)));
  assert.deepEqual([...(await workTitles('rex', [id]))], []);
  assert.equal(await isOnThread('rex', id), false);
});

test('no ids asks nothing and finds nothing', async (t) => {
  const select = t.mock.method(db, 'select');
  assert.deepEqual([...(await workTitles('vera', []))], []);
  assert.equal(select.mock.callCount(), 0);
});
