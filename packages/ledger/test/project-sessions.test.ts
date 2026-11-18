import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db } from './pglite.ts';
import { eq } from 'drizzle-orm';
import {
  ledger,
  projectRequests,
  projectSessions,
  reports,
  staff,
  threads,
  followUps
} from '../src/schema.ts';
const {
  advancedMode,
  connectProject,
  shareProject,
  letSendUnasked,
  requestProject,
  claimProject,
  finishProject,
  changeProjectRequest,
  setAdvancedMode
} = await import('../src/project-sessions.ts');
const { setOwnerName } = await import('../src/office.ts');
await setOwnerName('Tester');
await setAdvancedMode(true);

/** An Odd at `permission` with a session shared with it. `unasked` lets it send there without asking. */
async function fixture(permission: 'act' | 'draft' | 'read', unasked = permission === 'act') {
  const id = randomUUID();
  await db.insert(staff).values({
    id,
    name: 'Office tester',
    role: 'Tester',
    remit: 'Test project work.',
    variant: 'a',
    portrait: 'a',
    permission,
    desk: 'Test office'
  });
  const s = await connectProject('codex', randomUUID(), '/project', 'Example');
  await shareProject(s.id, id);
  if (unasked) await letSendUnasked(s.id, id);
  return { id: randomUUID(), staffId: id, sessionId: s.id, prompt: 'Read the project note.' };
}

test('one native ID has one project and a retried instruction has one delivery', async () => {
  const work = await fixture('act');
  const [a, b] = await Promise.all([requestProject(work), requestProject(work)]);
  assert.equal(a.id, b.id);
  await assert.rejects(requestProject({ ...work, prompt: 'Different work.' }), /different work/);
  const claims = await Promise.all([claimProject(work.sessionId), claimProject(work.sessionId)]);
  assert.equal(claims.filter(Boolean).length, 1);
  await changeProjectRequest(work.id, work.sessionId, ['sending'], 'uncertain');
  assert.equal(await claimProject(work.sessionId), undefined);
  const uuid = randomUUID();
  const s = await connectProject('claude', uuid, '/one', 'One');
  assert.equal((await connectProject('claude', uuid, '/one', 'Again')).id, s.id);
  await assert.rejects(connectProject('claude', uuid, '/two', 'Two'), /different project/);
});

test('sharing, a run ceiling, a later downgrade and owner takeover govern dispatch', async () => {
  const work = await fixture('act');
  await assert.rejects(requestProject({ ...work, staffId: 'another' }), /not been shared/);
  assert.equal((await requestProject({ ...work, draft: true })).state, 'proposed');
  assert.equal(await claimProject(work.sessionId), undefined);
  await changeProjectRequest(work.id, work.sessionId, ['proposed'], 'authorized');
  assert.equal((await claimProject(work.sessionId))?.id, work.id);
  const later = await fixture('act');
  await requestProject(later);
  await db.update(staff).set({ permission: 'draft' }).where(eq(staff.id, later.staffId));
  assert.equal(await claimProject(later.sessionId), undefined);
  assert.ok(await changeProjectRequest(later.id, later.sessionId, ['proposed'], 'authorized'));
  await shareProject(later.sessionId, null);
  assert.equal(await claimProject(later.sessionId), undefined);
  await assert.rejects(requestProject({ ...later, id: randomUUID() }), /not been shared/);
  await assert.rejects(requestProject(await fixture('read')), /Draft or Act/);
});

test('a repeated provider callback delivers one report and one pickup on the assigning thread', async () => {
  const work = await fixture('act');
  const [thread] = await db
    .insert(threads)
    .values({ title: 'Project review', hubId: work.staffId, holderId: work.staffId })
    .returning();
  await requestProject({ ...work, threadId: thread.id });
  await claimProject(work.sessionId);
  await finishProject(work.id, randomUUID(), 'Wrong conversation');
  await Promise.all([
    finishProject(work.id, work.sessionId, 'See notes.md'),
    finishProject(work.id, work.sessionId, 'See notes.md')
  ]);
  const deliveries = await db.select().from(reports).where(eq(reports.staffId, work.staffId));
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].body, /notes\.md/);
  const pickups = await db.select().from(followUps).where(eq(followUps.threadId, thread.id));
  assert.equal(pickups.length, 1);
  assert.equal(pickups[0].staffId, work.staffId);
});

test('a result from earlier work stays readable after the owner ends its thread', async () => {
  const work = await fixture('act');
  const [thread] = await db
    .insert(threads)
    .values({
      title: 'Ended project',
      hubId: work.staffId,
      holderId: work.staffId,
      status: 'stopped',
      endedAt: new Date()
    })
    .returning();
  await requestProject({ ...work, threadId: thread.id });
  await claimProject(work.sessionId);
  await finishProject(work.id, work.sessionId, 'The saved result.');
  assert.equal(
    (await db.select().from(followUps).where(eq(followUps.threadId, thread.id))).length,
    0
  );
  assert.equal(
    (await db.select().from(reports).where(eq(reports.staffId, work.staffId))).length,
    1
  );
  assert.equal(
    (await db.select().from(threads).where(eq(threads.id, thread.id)))[0].status,
    'stopped'
  );
});

test("a project result's resume goes to the Odd that sent the work, not the thread's hub", async () => {
  const work = await fixture('act');
  const hub = await fixture('act');
  const [thread] = await db
    .insert(threads)
    .values({ title: 'Shared project', hubId: hub.staffId, holderId: hub.staffId })
    .returning();
  await requestProject({ ...work, threadId: thread.id });
  await claimProject(work.sessionId);
  await finishProject(work.id, work.sessionId, 'See plan.md');
  const pickups = await db.select().from(followUps).where(eq(followUps.threadId, thread.id));
  assert.deepEqual(
    pickups.map((f) => [f.kind, f.staffId]),
    [['resume', work.staffId]]
  );
});

test('an Odd at Act still waits for the owner unless its session lets it send without asking', async () => {
  const work = await fixture('act', false);
  assert.equal((await requestProject(work)).state, 'proposed');
  assert.equal(await claimProject(work.sessionId), undefined);
  // The leave names one Odd, the one the session is shared with.
  const other = await fixture('act', false);
  await assert.rejects(letSendUnasked(work.sessionId, other.staffId), /Odd allowed to send work/);
  await letSendUnasked(work.sessionId, work.staffId);
  const next = { ...work, id: randomUUID() };
  assert.equal((await requestProject(next)).state, 'queued');
  // At Draft the same leave sends nothing: the run's ceiling still holds it.
  assert.equal(
    (await requestProject({ ...work, id: randomUUID(), draft: true })).state,
    'proposed'
  );
  // A queued request goes back to the owner when the leave is taken back before it is claimed.
  await letSendUnasked(work.sessionId, null);
  assert.equal(await claimProject(work.sessionId), undefined);
  const [row] = await db.select().from(projectRequests).where(eq(projectRequests.id, next.id));
  assert.equal(row.state, 'proposed');
  // Sharing with another Odd drops the leave, so the new Odd never inherits it.
  await letSendUnasked(work.sessionId, work.staffId);
  await shareProject(work.sessionId, other.staffId);
  const [s] = await db.select().from(projectSessions).where(eq(projectSessions.id, work.sessionId));
  assert.equal(s.sendsUnasked, null);
});

test('turning advanced mode off revokes every grant, stops waiting work and is a ledger line', async () => {
  const waiting = await fixture('draft');
  await requestProject(waiting);
  const before = await db.select().from(ledger);
  await setAdvancedMode(false);
  assert.equal(await advancedMode(), false);
  const titles = (await db.select().from(ledger))
    .slice(before.length)
    .map((r) => [r.kind, r.title]);
  assert.deepEqual(titles, [['decision', 'Turned off advanced mode']]);
  const shared = await db.select().from(projectSessions);
  assert.ok(shared.every((s) => s.staffId === null && s.sendsUnasked === null));
  const [row] = await db.select().from(projectRequests).where(eq(projectRequests.id, waiting.id));
  assert.equal(row.state, 'stopped');
  await assert.rejects(
    requestProject({ id: randomUUID(), sessionId: waiting.sessionId, prompt: 'Owner work.' }),
    /Advanced mode is off/
  );
  // Turning it off again changes nothing and writes no second line.
  await setAdvancedMode(false);
  assert.equal((await db.select().from(ledger)).length, before.length + 1);
  await setAdvancedMode(true);
  const [on] = (await db.select().from(ledger)).slice(before.length + 1);
  assert.equal(on.title, 'Turned on advanced mode');
  assert.match(on.body, /outside Oddboro’s limits/);
});
