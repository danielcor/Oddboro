// All work in flight in one place, and the usage window's guard on new
// hand-offs and on held ones the owner says yes to, which only Odds on
// Claude Code wait for: the office's own code on
// every migration, in an in-memory PGlite that stands in for db.ts (pglite.ts). Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { asks, followUps, goals, planLimits, staff, tasks, threads } from '../src/schema.ts';
// Types only, erased before run, so the code under test still loads after the mock.
import type { ThreadFor } from '../src/threads.ts';
import { db } from './pglite.ts';
import { ownerWords } from './owner-words.ts';

const { handOff } = await import('../src/hand-offs.ts');
const { HAND_OFF_LIMIT, parkThread, parkedThreads, wakeThread } = await import('../src/threads.ts');
const { goalsWindow } = await import('../src/goals.ts');
const { decideAsk, WINDOW_ASK_LAPSED, windowAsksDue, withdrawAsk } =
  await import('../src/office.ts');
const { WINDOW_RESET } = await import('../src/work/parking.ts');
const { parkOnTask } = await import('../src/task-parking.ts');
const { MANAGER_ROLE } = await import('../src/managers.ts');

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

/** `from` hands Ivy a piece of work, as the hand_off tool does. */
const give = (thread: ThreadFor, from = 'cole') =>
  handOff({
    from,
    to: 'ivy',
    work: { title: 'Tune gravity', brief: 'Tune the gravity constant.' },
    thread
  });
const fresh = (title: string, from = 'cole') => give({ title }, from);
const row = async (id: number) => (await db.select().from(threads).where(eq(threads.id, id)))[0];
const resumes = (id: number) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.threadId, id), eq(followUps.kind, 'resume')));

/** The plan's 5-hour window as a run last reported it. */
async function window(share: number, resetsInMs: number) {
  const w = { fiveHour: share, fiveHourResetsAt: new Date(Date.now() + resetsInMs) };
  await db
    .insert(planLimits)
    .values({ id: 'claude', sevenDay: 0, ...w })
    .onConflictDoUpdate({ target: planLimits.id, set: w });
}

/** A new window: the last one's holds are gone, and its ask was raised a day ago. */
async function freshWindow(share: number) {
  await db.update(threads).set({ heldBy: null, resumeAt: null });
  await db
    .update(asks)
    .set({ createdAt: new Date(Date.now() - 86_400_000) })
    .where(eq(asks.kind, 'window'));
  await window(share, 2 * 3_600_000);
}
/** The asks raised in this window. */
const windowAsks = async () =>
  (await db.select().from(asks).where(eq(asks.kind, 'window'))).filter(
    (a) => a.createdAt.getTime() > Date.now() - 3_600_000
  );

/** A thread Cole leads whose round took every hand-off, so the next one asked the owner to go on. */
async function askedToGoOn(title: string): Promise<{ id: number; ask: number }> {
  const [t] = await db
    .insert(threads)
    .values({ title, hubId: 'cole', holderId: 'cole', handOffsUsed: HAND_OFF_LIMIT })
    .returning({ id: threads.id });
  const r = await give({ id: t.id });
  assert.ok('asked' in r, JSON.stringify(r));
  return { id: t.id, ask: r.asked };
}
const handedOn = (id: number) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.threadId, id), eq(followUps.kind, 'hand_off')));

/** The time a held thread waits for has come, as it has for the clock at the reset. */
const reset = (ids: number[]) =>
  db
    .update(threads)
    .set({ resumeAt: new Date(Date.now() - 1000) })
    .where(inArray(threads.id, ids));

test('other work lists the threads for no goal still in flight, each with what it waits on oldest first', async () => {
  const [g] = await db.insert(goals).values({ title: 'Ship the sim' }).returning();
  const made = await db
    .insert(threads)
    .values([
      { title: 'For the goal', goalId: g.id, hubId: 'cole', holderId: 'cole' },
      { title: 'Under way', hubId: 'cole', holderId: 'ivy' },
      { title: 'Waiting', hubId: 'rex', holderId: 'rex' },
      { title: 'Done', hubId: 'cole', holderId: 'cole', status: 'done', endedAt: new Date() },
      { title: 'Stopped', hubId: 'cole', holderId: 'cole', status: 'stopped', endedAt: new Date() }
    ])
    .returning();
  const waiting = made[2].id;
  const ask = (title: string, minutesAgo: number) => ({
    staffId: 'rex',
    title,
    why: 'Why.',
    ifApproved: 'Then.',
    threadId: waiting,
    createdAt: new Date(Date.now() - minutesAgo * 60_000)
  });
  await db.insert(asks).values([ask('Newer', 5), ask('Older', 50)]);

  const { goals: listed, other } = await goalsWindow();
  const titles = other.map((t) => t.title);
  assert.ok(titles.includes('Under way') && titles.includes('Waiting'), titles.join(', '));
  for (const out of ['For the goal', 'Done', 'Stopped'])
    assert.ok(!titles.includes(out), `${out} is not other work`);
  assert.deepEqual(
    other.find((t) => t.id === waiting)?.waiting.map((w) => w.title),
    ['Older', 'Newer']
  );
  assert.equal(other.find((t) => t.id === waiting)?.stage, 'waiting_on_you');
  assert.ok(titles.indexOf('Waiting') < titles.indexOf('Under way'), 'newest thread first');
  assert.deepEqual(
    listed.find((x) => x.id === g.id)?.threads.map((t) => t.title),
    ['For the goal']
  );
});

test('under the guard of 85%, or with no window reported, hand-offs go', async () => {
  await db.delete(planLimits);
  assert.ok('id' in (await fresh('No window yet')));
  await window(0.84, 3_600_000);
  assert.ok('id' in (await fresh('Under the guard')));
  // A window already past its reset reads as unused, however full it was.
  await window(0.99, -1000);
  assert.ok('id' in (await fresh('After the reset')));
  assert.equal((await windowAsks()).length, 0);
  await window(0.85, 3_600_000);
  assert.ok('problem' in (await fresh('At the guard')), 'at 85% the office holds');
});

test('past the guard, a hand-off is refused, its thread held until the reset, and one ask raised for the whole office', async () => {
  await freshWindow(0.5);
  const running = await fresh('Before the window filled');
  assert.ok('id' in running);
  await window(0.87, 2 * 3_600_000);
  const resets = (await db.select().from(planLimits))[0].fiveHourResetsAt;

  const a = await fresh('Build a moon');
  assert.ok('problem' in a, JSON.stringify(a));
  assert.match(a.problem, /at 87%/);
  const b = await fresh('Draw the rings', 'rex');
  assert.ok('problem' in b);

  const raised = await windowAsks();
  assert.equal(raised.length, 1, 'one ask for the whole office');
  assert.equal(raised[0].staffId, 'cole', 'with no manager, under the hub that hit the guard');
  assert.match(
    raised[0].title,
    /^Your Claude plan's 5-hour window is 87% used\. Pause work Odds pass to each other until it resets at .+, or let it carry on\?$/
  );
  ownerWords(raised[0].title, raised[0].why, raised[0].ifApproved);
  const held = (await db.select().from(threads).where(eq(threads.heldBy, raised[0].id))).map(
    (t) => t.title
  );
  assert.deepEqual(held.sort(), ['Build a moon', 'Draw the rings']);
  const moon = (await db.select().from(threads).where(eq(threads.title, 'Build a moon')))[0];
  assert.equal(moon.resumeAt?.getTime(), resets?.getTime());
  const clock = (await parkedThreads()).find((p) => p.id === moon.id);
  assert.equal(clock?.resumeAt.getTime(), resets?.getTime(), 'the office clock wakes it then');
  assert.equal(moon.handOffsUsed, 0, 'a held hand-off is not counted');
  assert.equal(moon.status, 'open');
  const handed = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.threadId, moon.id), eq(followUps.kind, 'hand_off')));
  assert.equal(handed.length, 0, 'nothing is handed on');

  // Work already going is never stopped.
  const [going] = await db.select().from(followUps).where(eq(followUps.id, running.id));
  assert.equal(going.outcome, null);
  assert.equal((await row(running.thread)).heldBy, null);
});

test('a yes lets hand-offs run until the reset, and wakes only the threads the window held', async () => {
  await freshWindow(0.5);
  const own = await fresh('Parked by its hub');
  assert.ok('id' in own);
  const later = new Date(Date.now() + 3 * 3_600_000);
  assert.ok(await parkThread('cole', own.thread, later));
  await window(0.9, 2 * 3_600_000);
  const a = await fresh('Build a comet');
  assert.ok('problem' in a);
  const [ask] = await windowAsks();
  const [comet] = await db.select().from(threads).where(eq(threads.heldBy, ask.id));
  // A held thread whose hub then parks it to its own time is no longer the window's.
  const tail = await fresh('Build a tail');
  assert.ok('problem' in tail);
  const [tailRow] = await db.select().from(threads).where(eq(threads.title, 'Build a tail'));
  assert.ok(await parkThread('cole', tailRow.id, later));

  await decideAsk(ask.id, 'approve', null);
  const t = await row(comet.id);
  assert.equal(t.heldBy, null);
  assert.equal(t.resumeAt, null);
  const [woke] = await resumes(comet.id);
  assert.match(woke.note ?? '', /let hand-offs run until the usage window resets/);
  assert.ok('id' in (await fresh('After the yes')), 'later hand-offs in the window go');
  assert.equal((await row(own.thread)).resumeAt?.getTime(), later.getTime(), 'its own time stands');
  assert.equal((await resumes(own.thread)).length, 0);
  assert.equal((await row(tailRow.id)).resumeAt?.getTime(), later.getTime());
  assert.equal((await resumes(tailRow.id)).length, 0);
});

test('a no holds them, the reset wakes each held thread, and the clock takes an unanswered ask off the desk at the reset, not before', async () => {
  await freshWindow(0.9);
  assert.ok('problem' in (await fresh('Build a star')));
  const [ask] = await windowAsks();
  await decideAsk(ask.id, 'deny', 'Not while I am working');
  const [star] = await db.select().from(threads).where(eq(threads.title, 'Build a star'));
  assert.equal((await row(star.id)).heldBy, ask.id, 'a no keeps it held');
  assert.equal((await resumes(star.id)).length, 0);
  const lesson = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.askId, ask.id), eq(followUps.kind, 'denied')));
  assert.equal(lesson.length, 0, 'the office raised it, so no Odd learns from the no');
  assert.ok('problem' in (await fresh('Build a nebula')), 'a no holds later hand-offs too');

  await reset([star.id]);
  await wakeThread(star.id);
  const [woke] = await resumes(star.id);
  assert.equal(woke.note, WINDOW_RESET);
  assert.equal((await row(star.id)).heldBy, null);

  // An ask nobody answered is due to leave the desk at the window's reset.
  await freshWindow(0.9);
  assert.ok('problem' in (await fresh('Build a planet')));
  assert.ok('problem' in (await fresh('Build a belt', 'rex')));
  const [open] = await windowAsks();
  const [plan] = await db.select().from(planLimits);
  const due = async () => (await windowAsksDue()).filter((a) => a.id === open.id);
  assert.deepEqual(await due(), [{ id: open.id, at: plan.fiveHourResetsAt }]);
  const both = (await db.select().from(threads).where(eq(threads.heldBy, open.id))).map(
    (t) => t.id
  );
  // Waking the work it held leaves it on the desk: the clock takes it off at the reset.
  await reset(both);
  for (const id of both) await wakeThread(id);
  assert.equal((await windowAsks())[0].status, 'open');
  await withdrawAsk(open.id, WINDOW_ASK_LAPSED);
  const [closed] = await windowAsks();
  assert.equal(closed.status, 'denied');
  assert.equal(closed.reason, WINDOW_ASK_LAPSED);
  assert.deepEqual(await due(), []);
});

test('continuing a finished thread past the guard opens it again for a new round, held until the reset', async () => {
  await freshWindow(0.95);
  const [t] = await db
    .insert(threads)
    .values({
      title: 'A finished sim',
      hubId: 'cole',
      holderId: 'cole',
      status: 'done',
      handOffsUsed: 3,
      endedAt: new Date()
    })
    .returning();
  const r = await give({ id: t.id });
  assert.ok('problem' in r, JSON.stringify(r));
  const after = await row(t.id);
  assert.equal(after.endedAt, null);
  assert.equal(after.status, 'open');
  assert.equal(after.handOffsUsed, 0, "the hub's pick-up starts the round afresh");
  assert.ok(after.heldBy && after.resumeAt);
});

test('the window ask is filed under the manager, since it is for the whole office', async () => {
  await db.insert(staff).values({ ...odd('mo', 'Mo'), role: MANAGER_ROLE });
  await freshWindow(0.9);
  assert.ok('problem' in (await fresh('Build a sun', 'rex')));
  const [raised] = await windowAsks();
  assert.equal(raised.staffId, 'mo');
});

test('past the guard, a hand-off to an Odd on another tool goes, one to an Odd on Claude Code is held, and the ask names only the Odds on Claude Code', async () => {
  await db.insert(staff).values({ ...odd('cody', 'Cody'), agent: 'codex' });
  await freshWindow(0.89);
  const toCodex = await handOff({
    from: 'cole',
    to: 'cody',
    work: { title: 'Port the sim', brief: 'Port it.' },
    thread: { title: 'Port the sim' }
  });
  assert.ok('id' in toCodex, JSON.stringify(toCodex));
  assert.equal((await windowAsks()).length, 0, 'a hand-off to Codex raised the ask');
  assert.ok('problem' in (await fresh('Build a moon base')), 'a hand-off to Claude Code went');
  const [raised] = await windowAsks();
  assert.equal(
    raised.why,
    "The Odds on Claude Code share your Claude plan's 5-hour window: Cole, Ivy, Mo, and Rex. Past 85% of it, the office pauses work handed to them so the window lasts. Work for Odds on other tools, and runs already going, carry on."
  );
  ownerWords(raised.title, raised.why, raised.ifApproved);
});

test("past the guard, on a goal's thread, its Claude lead's hand-off to an Odd on Codex goes and one to an Odd on Claude Code is held", async () => {
  await freshWindow(0.9);
  // Mo, the manager on Claude Code, leads every goal's thread; Cody runs on Codex.
  const onGoal = async (to: string, title: string) => {
    const [g] = await db.insert(goals).values({ title }).returning();
    return handOff({
      from: 'mo',
      to,
      work: { title, brief: 'Do it.' },
      thread: { title, goalId: g.id }
    });
  };
  const toCodex = await onGoal('cody', 'Map the stars');
  assert.ok('id' in toCodex, JSON.stringify(toCodex));
  const toClaude = await onGoal('ivy', 'Name the stars');
  assert.ok('problem' in toClaude, JSON.stringify(toClaude));
  assert.match(toClaude.problem, /usage window is at 90%/);
});

test('work parked on a task that the usage window then holds waits on the window, not the task', async () => {
  await db.insert(staff).values(odd('wren', 'Wren'));
  const [t] = await db
    .insert(threads)
    .values({ title: 'Parked, then held', hubId: 'wren', holderId: 'wren' })
    .returning();
  const [task] = await db
    .insert(tasks)
    .values({ staffId: 'wren', title: 'Sign off the sim', why: 'w', steps: [] })
    .returning();
  assert.ok('title' in (await parkOnTask('wren', t.id, task.id)));
  await freshWindow(0.95);
  const r = await give({ id: t.id }, 'wren');
  assert.ok('problem' in r, JSON.stringify(r));
  const after = await row(t.id);
  assert.equal(after.resumeOnTask, null, 'a hold on the window replaces a park on a task');
  assert.ok(after.resumeAt, 'the window reset wakes it');
});

test('past the guard, a yes to more hand-offs starts nothing: the held hand-off waits for the window, and its lead hears to hand it on then', async () => {
  await freshWindow(0.5);
  const { id, ask } = await askedToGoOn('Tune the orbit');
  await window(0.9, 2 * 3_600_000);
  const resets = (await db.select().from(planLimits))[0].fiveHourResetsAt;

  await decideAsk(ask, 'approve', null);
  assert.equal((await handedOn(id)).length, 0, 'the held hand-off started past the guard');
  const [decided] = await db.select().from(asks).where(eq(asks.id, ask));
  assert.equal(decided.status, 'approved');
  const [raised, ...more] = await windowAsks();
  assert.equal(more.length, 0);
  const t = await row(id);
  assert.equal(t.heldBy, raised?.id, "held under the window's ask, as a new hand-off is");
  assert.equal(t.resumeAt?.getTime(), resets?.getTime());
  assert.equal(t.handOffsUsed, 0, 'the yes starts a new round');
  const [told, ...again] = await resumes(id);
  assert.equal(again.length, 0, 'the lead woke twice');
  assert.equal(told?.askId, ask);
  assert.match(told?.note ?? '', /"Tune gravity" has not gone to Ivy yet: hand it on again/);
  assert.match(told?.note ?? '', /usage window is at 90%/);

  // The owner lets hand-offs run: the lead's hand-off goes, the first of the new round.
  await decideAsk(raised.id, 'approve', null);
  const next = await give({ id });
  assert.ok('id' in next, JSON.stringify(next));
  assert.equal(next.left, HAND_OFF_LIMIT - 1);
});

test('under the guard, a yes to more hand-offs starts the held hand-off at once', async () => {
  await freshWindow(0.84);
  const { id, ask } = await askedToGoOn('Tune the tides');
  await decideAsk(ask, 'approve', null);
  assert.equal((await handedOn(id)).length, 1);
  assert.equal((await row(id)).heldBy, null);
  assert.equal((await windowAsks()).length, 0);
});
