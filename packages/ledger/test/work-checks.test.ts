// The database refuses a state no work change may leave (the CHECK
// constraints in schema.ts). One test drives a production write through the
// work core and reads the row it left; one writes each refused state by
// hand; one reads that each check leaves the rows an office already holds
// unchecked. All run every migration, in an in-memory PGlite that stands in for
// db.ts (pglite.ts). Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { asks, followUps, staff, tasks, threads } from '../src/schema.ts';
import { db, sql } from './pglite.ts';

const { giveTask } = await import('../src/office.ts');
const { parkThread } = await import('../src/threads.ts');
const { parkOnTask } = await import('../src/task-parking.ts');

await db.insert(staff).values({
  id: 'lea',
  name: 'Lea',
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft',
  desk: 'You are Lea.'
});

test('parking a thread on a task through the transition clears its time', async () => {
  const [work] = await db
    .insert(threads)
    .values({ title: 'Plan the fair', hubId: 'lea', holderId: 'lea' })
    .returning({ id: threads.id });
  assert.ok(await parkThread('lea', work.id, new Date(Date.now() + 60 * 60 * 1000)));
  const task = await giveTask('lea', {
    title: 'Book the hall',
    why: 'The fair needs a room.',
    steps: ['Book it']
  });
  const parked = await parkOnTask('lea', work.id, task.id);
  assert.ok('title' in parked, JSON.stringify(parked));
  const [row] = await db
    .select({ resumeAt: threads.resumeAt, resumeOnTask: threads.resumeOnTask })
    .from(threads)
    .where(eq(threads.id, work.id));
  // `threads_one_park`: a park on a task holds no time beside it.
  assert.deepEqual(row, { resumeAt: null, resumeOnTask: task.id });
});

test('the database refuses each state no work change writes', async () => {
  const [work] = await db
    .insert(threads)
    .values({ title: 'Paint the sign', hubId: 'lea', holderId: 'lea' })
    .returning({ id: threads.id });
  const task = await giveTask('lea', {
    title: 'Pick the colour',
    why: 'The sign needs one.',
    steps: ['Pick it']
  });
  const [hold] = await db
    .insert(asks)
    .values({ staffId: 'lea', kind: 'window', title: 'Keep going?', why: 'w', ifApproved: 'i' })
    .returning({ id: asks.id });
  const [run] = await db
    .insert(followUps)
    .values({ staffId: 'lea', kind: 'first_day', note: null })
    .returning({ id: followUps.id });
  // One write per check, each breaking only that check on rows written whole. Each
  // runs only once the one before it was refused, so a refused write changed nothing.
  const broken: [string, () => Promise<unknown>][] = [
    [
      'follow_ups_ended_together',
      () => sql`update follow_ups set outcome = 'done' where id = ${run.id}`
    ],
    [
      'follow_ups_one_unpark',
      () =>
        sql`update follow_ups set unparked_task = ${task.id}, unparked_at = now() where id = ${run.id}`
    ],
    [
      'threads_one_park',
      () =>
        sql`update threads set resume_at = now(), resume_on_task = ${task.id} where id = ${work.id}`
    ],
    [
      'threads_held_has_time',
      () => sql`update threads set held_by = ${hold.id} where id = ${work.id}`
    ],
    ['tasks_withdrawn_dropped', () => sql`update tasks set withdrawn = true where id = ${task.id}`],
    ['asks_open_undecided', () => sql`update asks set decided_at = now() where id = ${hold.id}`]
  ];
  for (const [check, write] of broken)
    await assert.rejects(write, (err: Error) => err.message.includes(`"${check}"`), check);
});

test('each check skips the rows an office already holds, so a row an older version wrote never stops the upgrade', async () => {
  // NOT VALID is a hand edit to the migration, which drizzle cannot write, so
  // generating the migration again would drop it with every other test green.
  const names = [asks, followUps, tasks, threads]
    .flatMap((t) => getTableConfig(t).checks.map((c) => c.name))
    .sort();
  assert.ok(names.length > 0, 'the work tables declare no check');
  const rows = await sql<{ conname: string; convalidated: boolean }>`
    select conname, convalidated from pg_constraint where contype = 'c' order by conname`;
  assert.deepEqual(
    rows.filter((r) => names.includes(r.conname)),
    names.map((conname) => ({ conname, convalidated: false }))
  );
});
