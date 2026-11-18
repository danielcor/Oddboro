// A round's fixed limit of hand-offs, the owner's answer past it, and
// continuing a thread: the office's own code on every migration, in an
// in-memory PGlite that stands in for db.ts (pglite.ts). Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mock, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { asks, followUps, staff, threads } from '../src/schema.ts';
import { workName } from '../src/work-paths.ts';
// Types only, erased before run, so threads.ts still loads after the mock.
import type { ThreadFor } from '../src/threads.ts';
import { db } from './pglite.ts';
import { ownerWords } from './owner-words.ts';

// Every ledger line goes through `record` below, before any module that writes
// one loads: a test sets `onLine` to act while a decision's line is written.
let onLine: ((askId: number | undefined) => Promise<void>) | undefined;
const ledgerUrl = new URL('../src/office-ledger.ts', import.meta.url).href;
mock.module(ledgerUrl, {
  exports: {
    record: async (...a: Parameters<typeof real.record>) => {
      await onLine?.(a[0].askId);
      return real.record(...a);
    },
    searchLedger: (...a: Parameters<typeof real.searchLedger>) => real.searchLedger(...a),
    precedent: (...a: Parameters<typeof real.precedent>) => real.precedent(...a),
    reindexLedger: () => real.reindexLedger()
  }
});
// The query loads the real module apart from the mock, whose type is the module's own.
const real = (await import(`${ledgerUrl}?real`)) as typeof import('../src/office-ledger.ts');
// Loaded once db.ts is this database, so every query they make lands here.
const { handOff } = await import('../src/hand-offs.ts');
const { decideAsk } = await import('../src/office.ts');
const { HAND_OFF_LIMIT, goalThreads, recentThreads, threadPart } =
  await import('../src/threads.ts');

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
await db.insert(staff).values([odd('cole', 'Cole'), odd('ivy', 'Ivy'), odd('rex', 'Rex')]);

const work = { title: 'More presets', brief: 'Add two presets to presets.json.' };
/** Cole hands Ivy a piece of work, as the hand_off tool does. */
const give = (thread: ThreadFor, from = 'cole') => handOff({ from, to: 'ivy', work, thread });
const row = async (id: number) => (await db.select().from(threads).where(eq(threads.id, id)))[0];
const openAsks = (id: number) =>
  db
    .select()
    .from(asks)
    .where(and(eq(asks.threadId, id), eq(asks.kind, 'hand_offs'), eq(asks.status, 'open')));
const ofKind = (id: number, kind: 'resume' | 'hand_off') =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.threadId, id), eq(followUps.kind, kind)));
const runsOn = (id: number) => db.select().from(followUps).where(eq(followUps.threadId, id));

/** A thread Cole led that ended, after a round of three hand-offs. */
async function ended(status: 'done' | 'stopped' = 'done'): Promise<number> {
  const [t] = await db
    .insert(threads)
    .values({
      title: 'Build a gravity sim',
      hubId: 'cole',
      holderId: 'cole',
      status,
      handOffsUsed: 3,
      endedAt: new Date()
    })
    .returning({ id: threads.id });
  return t.id;
}

/** A thread Cole leads whose round has taken every hand-off it may. */
async function atLimit(): Promise<number> {
  const [t] = await db
    .insert(threads)
    .values({
      title: 'Tune the sim',
      hubId: 'cole',
      holderId: 'cole',
      handOffsUsed: HAND_OFF_LIMIT
    })
    .returning({ id: threads.id });
  return t.id;
}

/** A thread at its limit whose next hand-off asked the owner to keep going. */
async function askedToGoOn(): Promise<{ id: number; ask: number }> {
  const id = await atLimit();
  const r = await give({ id });
  assert.ok('asked' in r, JSON.stringify(r));
  return { id, ask: r.asked };
}

test('a round takes hand-offs up to the limit, and the one past it does not go but raises one ask', async () => {
  const first = await give({ title: 'A whole physics course' });
  assert.ok('id' in first, JSON.stringify(first));
  assert.equal(first.left, HAND_OFF_LIMIT - 1);
  for (let n = 2; n <= HAND_OFF_LIMIT; n++)
    assert.ok('id' in (await give({ id: first.thread })), `hand-off ${n} of the round`);
  const over = await give({ id: first.thread });
  assert.ok('asked' in over, JSON.stringify(over));
  assert.equal((await ofKind(first.thread, 'hand_off')).length, HAND_OFF_LIMIT);
  const [ask] = await openAsks(first.thread);
  assert.equal(ask.id, over.asked);
  assert.equal(ask.staffId, 'cole');
});

test('while the ask is open no hand-off goes and no second ask is raised', async () => {
  const { id, ask } = await askedToGoOn();
  const again = await give({ id });
  assert.ok('problem' in again && again.problem.includes('waits on'), JSON.stringify(again));
  assert.equal((await openAsks(id)).length, 1);
  assert.equal((await ofKind(id, 'hand_off')).length, 0);
  await decideAsk(ask, 'approve', null);
  assert.equal((await ofKind(id, 'hand_off')).length, 1, 'the refused one went too');
});

test('the thread waits on the owner wherever it is shown while the ask is open', async () => {
  const { id } = await askedToGoOn();
  assert.equal((await goalThreads()).find((g) => g.id === id)?.stage, 'waiting_on_you');
  const listed = await recentThreads('cole', { limit: 50 });
  assert.equal(listed.find((g) => g.id === id)?.stage, 'waiting_on_you');
  assert.equal((await row(id)).endedAt, null);
});

test('a yes starts the held hand-off once, exactly as handed, as the first of a new round', async () => {
  const { id, ask } = await askedToGoOn();
  await decideAsk(ask, 'approve', null);
  await decideAsk(ask, 'approve', null);
  const [started, ...more] = await ofKind(id, 'hand_off');
  assert.equal(more.length, 0, 'the held hand-off started twice');
  assert.equal(started?.staffId, 'ivy');
  assert.deepEqual(started?.handOff, { from: 'cole', ...work });
  assert.equal(started?.startedAt, null, 'written for the office to start, as a taken one is');
  assert.equal((await ofKind(id, 'resume')).length, 0, 'the hub woke with nothing to do');
  assert.equal((await row(id)).handOffsUsed, 1);
  const next = await give({ id });
  assert.ok('id' in next, JSON.stringify(next));
  assert.equal(next.left, HAND_OFF_LIMIT - 2);
  for (let n = 3; n <= HAND_OFF_LIMIT; n++) assert.ok('id' in (await give({ id })));
  assert.ok('asked' in (await give({ id })), 'one more round, not an open limit');
});

test("a hand-off past the round's limit keeps its files until the owner's yes", async () => {
  const [other] = await db
    .insert(threads)
    .values({ title: 'Older work', hubId: 'cole', holderId: 'cole' })
    .returning({ id: threads.id });
  const real = join(threadPart(other.id, 'cole'), 'x.md');
  mkdirSync(dirname(real), { recursive: true });
  writeFileSync(real, 'from older work');
  const id = await atLimit();
  const name = `threads-${other.id}-cole-x.md`;
  const r = await handOff({
    from: 'cole',
    to: 'ivy',
    work,
    thread: { id },
    carry: [{ real, name, named: workName(other.id, 'cole/x.md') }]
  });
  assert.ok('asked' in r, JSON.stringify(r));
  assert.equal(readFileSync(join(threadPart(id, 'cole'), name), 'utf8'), 'from older work');
  await decideAsk(r.asked, 'approve', null);
  const [started] = await ofKind(id, 'hand_off');
  assert.deepEqual(started?.handOff?.files, [`cole/${name}`]);
});

test("a yes with the owner's words starts the held hand-off and tells the hub not to hand it on again", async () => {
  const { id, ask } = await askedToGoOn();
  await decideAsk(ask, 'approve', 'Keep it small.');
  assert.equal((await ofKind(id, 'hand_off')).length, 1);
  const [told, ...more] = await ofKind(id, 'resume');
  assert.equal(more.length, 0, 'the hub woke twice');
  assert.equal(told?.staffId, 'cole');
  assert.equal(told?.askId, ask);
  assert.match(told?.note ?? '', /Keep it small\./);
  assert.match(told?.note ?? '', /"More presets" went to Ivy as you handed it/);
  assert.match(told?.note ?? '', /Do not hand it on again\./);
});

test('a stop between the yes and the start of the held hand-off leaves the ask open, and the next yes starts it once', async () => {
  const { id, ask } = await askedToGoOn();
  // The office stops as the held hand-off is written, once.
  await db.execute(sql`create function stop_here() returns trigger language plpgsql as $$
    begin raise exception 'office stopped here'; end $$`);
  await db.execute(sql`create trigger stop_here before insert on follow_ups
    for each row when (new.kind = 'hand_off') execute function stop_here()`);
  try {
    await assert.rejects(decideAsk(ask, 'approve', null), (e: Error) =>
      String(e.cause).includes('office stopped here')
    );
  } finally {
    await db.execute(sql`drop trigger stop_here on follow_ups`);
    await db.execute(sql`drop function stop_here`);
  }
  assert.equal((await openAsks(id)).length, 1, 'the yes was spent with nothing started');
  assert.equal((await row(id)).handOffsUsed, HAND_OFF_LIMIT);
  await decideAsk(ask, 'approve', null);
  assert.equal((await ofKind(id, 'hand_off')).length, 1);
  assert.equal((await row(id)).handOffsUsed, 1);
});

test('an ask raised before asks held their hand-off still wakes the lead to hand on again on a yes', async () => {
  const id = await atLimit();
  const [a] = await db
    .insert(asks)
    .values({
      staffId: 'cole',
      kind: 'hand_offs',
      threadId: id,
      title: 'Cole needs a few more steps to finish Tune the sim. Go ahead?',
      why: 'Cole has handed on as many pieces of Tune the sim as the office lets work go.',
      ifApproved: 'Cole hands on the next piece.'
    })
    .returning({ id: asks.id });
  await decideAsk(a.id, 'approve', null);
  assert.equal((await ofKind(id, 'hand_off')).length, 0);
  const [told, ...more] = await ofKind(id, 'resume');
  assert.equal(more.length, 0, 'the lead woke twice');
  assert.equal(told?.staffId, 'cole');
  assert.equal(told?.askId, a.id);
  assert.match(told?.note ?? '', /Hand on the next piece now\./);
  assert.equal((await row(id)).handOffsUsed, 0);
});

test('a no stops the work, starts nothing, refuses the next hand-off, and tells the lead', async () => {
  const { id, ask } = await askedToGoOn();
  await decideAsk(ask, 'deny', null);
  const t = await row(id);
  assert.equal(t.status, 'stopped');
  assert.notEqual(t.endedAt, null);
  const [told] = await ofKind(id, 'resume');
  assert.equal(told?.staffId, 'cole');
  assert.match(told?.note ?? '', /stopped/);
  assert.equal((await ofKind(id, 'hand_off')).length, 0, 'the held hand-off went on a no');
  const r = await give({ id });
  assert.ok('problem' in r && r.problem.includes('has ended (stopped)'), JSON.stringify(r));
});

test("a hand-off that lands between the owner's no to more hand-offs and the work's stop is refused, and raises no new ask", async () => {
  const { id, ask } = await askedToGoOn();
  let landed: ReturnType<typeof give> | undefined;
  onLine = async (askId) => {
    if (askId !== ask || landed) return;
    // The lead hands off again as the no's line is written, and gets a quarter
    // second to land: where the stop is a step after the no, it lands before
    // the stop; where the stop commits with the no, it waits for both.
    landed = give({ id });
    await Promise.race([landed, new Promise((done) => setTimeout(done, 250))]);
  };
  try {
    await decideAsk(ask, 'deny', null);
  } finally {
    onLine = undefined;
  }
  assert.ok(landed, "the no's line was never written");
  const r = await landed;
  assert.ok('problem' in r && r.problem.includes('has ended (stopped)'), JSON.stringify(r));
  assert.equal((await ofKind(id, 'hand_off')).length, 0, 'a hand-off went on stopped work');
  assert.equal((await openAsks(id)).length, 0, 'stopped work asks to go on');
});

test('the ask takes a yes or a no only, never a send-back', async () => {
  const { id, ask } = await askedToGoOn();
  await assert.rejects(decideAsk(ask, 'iterate', 'Fewer steps.'), /yes or no/);
  assert.equal((await openAsks(id)).length, 1);
});

test('the ask names the work and the held hand-off by their titles, with no count or thread', async () => {
  const { ask } = await askedToGoOn();
  const [a] = await db.select().from(asks).where(eq(asks.id, ask));
  assert.equal(a.title, 'Cole needs a few more steps to finish Tune the sim. Go ahead?');
  assert.equal(
    a.ifApproved,
    'Ivy starts on "More presets" now, as Cole asked. If you say no, Tune the sim stops.'
  );
  ownerWords(a.title, a.why, a.ifApproved);
});

test('continuing a finished thread reopens it for a new round', async () => {
  const id = await ended();
  const r = await give({ id });
  assert.ok('id' in r, JSON.stringify(r));
  assert.equal(r.left, HAND_OFF_LIMIT - 1);
  const t = await row(id);
  assert.equal(t.status, 'open');
  assert.equal(t.endedAt, null);
  assert.equal(t.handOffsUsed, 1);
});

test('only the hub may continue a thread', async () => {
  const id = await ended();
  assert.ok('problem' in (await give({ id }, 'rex')));
  assert.equal((await row(id)).status, 'done');
  assert.equal((await runsOn(id)).length, 0);
});

test('a stopped thread cannot be continued', async () => {
  const id = await ended('stopped');
  const r = await give({ id });
  assert.ok('problem' in r && r.problem.includes('has ended (stopped)'), JSON.stringify(r));
  assert.equal((await row(id)).status, 'stopped');
  assert.equal((await runsOn(id)).length, 0);
});
