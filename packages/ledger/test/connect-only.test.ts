// An Odd asks to connect a tool only (`connect_only`), for work a separate
// proposal does. The owner may approve the proposal before the tool is
// connected: then the work waits on the connect task, and finishing it wakes
// the work once. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { connectors, followUps, staff, tasks, threads } from '../src/schema.ts';
import { db } from './pglite.ts';

const { decideAsk, desk, finishTask, raiseAsk } = await import('../src/office.ts');
const { parkOnTask } = await import('../src/task-parking.ts');

await db.insert(staff).values({
  id: 'paige',
  name: 'Paige',
  role: 'Mail clerk',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'act',
  desk: 'You are Paige.'
});

/**
 * Paige's work on booking the dentist: an access ask for Google Drive and a
 * proposal, both on the work. The owner approves the proposal first, then
 * the access, which gives the owner a connect task. Paige then parks the work
 * on that task.
 */
async function proposalFirst(connectOnly: boolean) {
  await db.delete(followUps);
  await db.update(connectors).set({ readyAt: null }).where(eq(connectors.id, 'google-drive'));
  const [work] = await db
    .insert(threads)
    .values({ title: `Book the dentist (${connectOnly})`, hubId: 'paige', holderId: 'paige' })
    .returning();
  const { ask: access } = await raiseAsk('paige', {
    title: 'Connect Google Drive (write)',
    why: 'To book the dentist.',
    ifApproved: 'Google Drive is connected.',
    access: { connector: 'google-drive', level: 'act', ...(connectOnly && { connectOnly: true }) },
    threadId: work.id
  });
  const { ask: proposal } = await raiseAsk('paige', {
    title: 'Book the dentist on Tuesday',
    why: 'The slot is free.',
    ifApproved: 'I add the event.',
    threadId: work.id
  });
  await decideAsk(proposal.id, 'approve', null);
  await decideAsk(access.id, 'approve', null);
  const [connect] = await db.select().from(tasks).where(eq(tasks.askId, access.id));
  assert.ok(connect, 'the yes to the access ask gave no connect task');
  // The proposal's carry-out ran and ended waiting on the connection.
  await db
    .update(followUps)
    .set({ outcome: 'waiting', doneAt: new Date(), startedAt: new Date() })
    .where(eq(followUps.askId, proposal.id));
  return { work, access, connect, park: await parkOnTask('paige', work.id, connect.id) };
}

const resumes = (threadId: number) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.kind, 'resume'), eq(followUps.threadId, threadId)));

test('a connect-only ask approved after its proposal: the work waits on the connection, and finishing it wakes the work once', async () => {
  const { work, access, connect, park } = await proposalFirst(true);
  assert.deepEqual(park, { title: connect.title });
  // Its card on the desk does not say the Odd picks up when it is done.
  assert.deepEqual((await desk()).connectOnly, [connect.id]);
  assert.deepEqual(await resumes(work.id), []);
  await finishTask(connect.id, true, null);
  assert.equal((await resumes(work.id)).length, 1, 'finishing the connection woke the work once');
  const carried = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.kind, 'carry_out'), eq(followUps.askId, access.id)));
  assert.deepEqual(carried, [], 'a connect-only ask starts no work of its own');
});

test('an ordinary access ask on the work still refuses the park: the connection itself brings the work back', async () => {
  const { connect, park } = await proposalFirst(false);
  assert.ok(!(await desk()).connectOnly.includes(connect.id));
  assert.ok(
    'problem' in park && /That task is on this work/.test(park.problem),
    JSON.stringify(park)
  );
});
