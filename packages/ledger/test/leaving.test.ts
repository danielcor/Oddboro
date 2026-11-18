// An Odd leaves the office, and comes back. An Odd told in chat to leave asks
// the owner first with leave_office; the Office Manager asks to let another
// go with remove_odd and to bring one back with bring_back_odd. Each is an ask,
// and only the owner's yes acts. Leaving is soft: the row stays, the Odd runs
// nothing and shows nowhere, its jobs turn off, its pokes are cancelled and
// its open work closes. Bringing it back turns its jobs on again. The tools
// run in the tool server's own process, as the office starts one for each run.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db, sql, toolServer } from './tool-server.ts';

const { ASK_KINDS, asks, followUps, jobs, ledger, pokes, reports, staff, tasks } =
  await import('../src/schema.ts');
const { OWNER_ANSWERS } = await import('../src/desk-answers.ts');
const { eq } = await import('drizzle-orm');
const O = await import('../src/office.ts');
const H = await import('../src/hand-offs.ts');
const L = await import('../src/leaving.ts');
const { MANAGER_ROLE } = await import('../src/managers.ts');
const { HIRE_DEFAULTS } = await import('../src/grantable.ts');

const odd = (id: string, name: string, more: Partial<typeof staff.$inferInsert> = {}) => ({
  id,
  name,
  role: 'Writer',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`,
  ...more
});

beforeEach(async () => {
  for (const t of [
    'ledger',
    'follow_ups',
    'attachments',
    'tasks',
    'asks',
    'threads',
    'reports',
    'pokes',
    'runs',
    'jobs'
  ])
    await sql.unsafe(`delete from ${t}`);
  await sql`delete from staff`;
  await db
    .insert(staff)
    .values([
      odd('rico', 'Rico'),
      odd('mo', 'Mo', { role: MANAGER_ROLE, tools: HIRE_DEFAULTS.manager.tools })
    ]);
});

/** The first text a tool call returned, and whether it was an error. */
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[])[0]?.text ?? '', error: r.isError === true };
}
const tools = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
const askOf = async (id: number) => (await db.select().from(asks).where(eq(asks.id, id)))[0];
const row = async (id: string) => (await db.select().from(staff).where(eq(staff.id, id)))[0];
const said = { OWNER_SAID: 'You are fired, Rico. Please leave.' };

test('leave_office is offered only in a chat, never to the manager, and raises one ask for the yes', async () => {
  assert.ok(!(await tools(await toolServer('rico', { RUN_KEY: 'k-1' }))).includes('leave_office'));
  assert.ok(
    !(await tools(await toolServer('mo', { RUN_KEY: 'k-2', ...said }))).includes('leave_office')
  );
  const c = await toolServer('rico', { RUN_KEY: 'k-3', ...said });
  const r = await call(c, 'leave_office', { why: 'They said I am fired.' });
  assert.equal(r.error, false, r.text);
  const [a] = await db.select().from(asks).where(eq(asks.kind, 'remove'));
  assert.equal(a.staffId, 'rico');
  assert.equal(a.odd, 'rico');
  assert.equal(a.title, 'Let Rico go from the office');
  // Asking left it working: only the yes acts.
  assert.ok(await O.staffer('rico'));
  const again = await call(c, 'leave_office', { why: 'Again.' });
  assert.ok(again.error, again.text);
});

test("the owner's yes lets the Odd go: off the roster, jobs off, pokes cancelled, its open work closed", async () => {
  const job = await O.addJob({
    staffId: 'rico',
    name: 'Digest',
    instructions: 'Write it.',
    schedule: { every: 'day', at: '08:00' }
  });
  const paused = await O.addJob({
    staffId: 'rico',
    name: 'Old',
    instructions: 'Off already.',
    schedule: { every: 'day', at: '09:00' }
  });
  await O.updateJob(paused.id, { enabled: false });
  await O.schedulePoke('rico', new Date(Date.now() + 3_600_000), 'Hello later');
  const { ask: other } = await O.raiseAsk('rico', {
    title: 'Buy a desk',
    why: 'w',
    ifApproved: 'i'
  });
  const [task] = await db
    .insert(tasks)
    .values({ staffId: 'rico', title: 'Sign in', why: 'w', steps: [] })
    .returning();
  await db.insert(reports).values({ staffId: 'rico', title: 'Done', body: 'b' });
  await db.insert(followUps).values({ staffId: 'rico', kind: 'first_day', note: null });
  const { ask } = await O.raiseAsk('rico', {
    kind: 'remove',
    odd: 'rico',
    title: 'Let Rico go from the office',
    why: 'w',
    ifApproved: 'i'
  });

  await O.decideAsk(ask.id, 'approve', null);

  assert.equal(await O.staffer('rico'), undefined);
  assert.ok((await O.anyStaffer('rico'))?.leftAt);
  assert.deepEqual(
    (await O.roster()).map((p) => p.id),
    ['mo']
  );
  assert.deepEqual((await row('rico')).jobsOff, [job.id]);
  assert.deepEqual(
    (await db.select().from(jobs)).map((j) => j.enabled),
    [false, false]
  );
  assert.deepEqual(await O.enabledJobs(), []);
  assert.equal((await db.select().from(pokes))[0].status, 'cancelled');
  // Its other ask is withdrawn by the office, and nobody reads it for a lesson.
  const closed = await askOf(other.id);
  assert.equal(closed.status, 'denied');
  assert.match(closed.reason ?? '', /Rico left the office/);
  const fups = await db.select().from(followUps);
  assert.ok(fups.every((f) => f.kind !== 'denied'));
  assert.ok(fups.every((f) => f.outcome === 'failed'));
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].status, 'dropped');
  const desk = await O.desk();
  assert.equal(desk.asks.length + desk.tasks.length + desk.reports.length, 0);
  assert.deepEqual(await O.followUpsToDo(), []);
  const lines = (await db.select().from(ledger)).map((l) => l.title);
  assert.ok(lines.includes('Let Rico go from the office'), lines.join('\n'));
  assert.ok(lines.includes('Withdrawn: Buy a desk'), lines.join('\n'));
});

test('an Odd that left has no tool server, so no run of it can start', async () => {
  await L.removeOdd('rico');
  await assert.rejects(toolServer('rico', { RUN_KEY: 'k-gone' }));
});

test('the manager stays: neither the owner nor remove_odd can let it go', async () => {
  assert.deepEqual(await L.removeOdd('mo'), {
    refused: `Mo is the ${MANAGER_ROLE}, and every office keeps one.`
  });
  const c = await toolServer('mo', { RUN_KEY: 'k-4', ...said });
  const r = await call(c, 'remove_odd', { odd: 'mo', why: 'w' });
  assert.ok(r.error, r.text);
  assert.equal((await db.select().from(asks)).length, 0);
});

test("remove_odd asks to let another go, and the owner's yes closes any other ask about it", async () => {
  const c = await toolServer('mo', { RUN_KEY: 'k-5', ...said });
  const r = await call(c, 'remove_odd', { odd: 'rico', why: 'They asked me to.' });
  assert.equal(r.error, false, r.text);
  const { ask: own } = await O.raiseAsk('rico', {
    kind: 'remove',
    odd: 'rico',
    title: 'Let Rico go from the office',
    why: 'w',
    ifApproved: 'i'
  });
  const [manager] = await db.select().from(asks).where(eq(asks.staffId, 'mo'));
  assert.equal(manager.odd, 'rico');
  await O.decideAsk(manager.id, 'approve', null);
  assert.equal(await O.staffer('rico'), undefined);
  assert.equal((await askOf(own.id)).status, 'denied');
});

test("bring_back_odd lists who left, and the owner's yes brings the Odd back with its jobs on again", async () => {
  const job = await O.addJob({
    staffId: 'rico',
    name: 'Digest',
    instructions: 'Write it.',
    schedule: { every: 'day', at: '08:00' }
  });
  await L.removeOdd('rico');
  const c = await toolServer('mo', { RUN_KEY: 'k-6', ...said });
  const listed = (await c.listTools()).tools.find((t) => t.name === 'bring_back_odd');
  assert.match(listed?.description ?? '', /rico \(Rico, Writer\)/);
  const working = await call(c, 'bring_back_odd', { odd: 'mo', why: 'w' });
  assert.ok(working.error, working.text);
  const r = await call(c, 'bring_back_odd', { odd: 'rico', why: 'Bring Rico back.' });
  assert.equal(r.error, false, r.text);
  const [a] = await db.select().from(asks).where(eq(asks.kind, 'bring_back'));
  await O.decideAsk(a.id, 'approve', null);
  const back = await row('rico');
  assert.equal(back.leftAt, null);
  assert.equal(back.jobsOff, null);
  const [j] = await db.select().from(jobs).where(eq(jobs.id, job.id));
  assert.equal(j.enabled, true);
  assert.ok(j.nextRunAt && j.nextRunAt > new Date());
  assert.ok(await O.staffer('rico'));
});

test('a remove or bring_back ask takes yes or no only', async () => {
  const { ask } = await O.raiseAsk('rico', {
    kind: 'remove',
    odd: 'rico',
    title: 'Let Rico go from the office',
    why: 'w',
    ifApproved: 'i'
  });
  await assert.rejects(O.decideAsk(ask.id, 'iterate', 'Change it'));
  // A no keeps the Odd, and it reads the reason as any no.
  await O.decideAsk(ask.id, 'deny', 'Stay, please.');
  assert.ok(await O.staffer('rico'));
});

test('every kind whose yes moves an Odd refuses a yes it cannot carry out, and stays open', async () => {
  const moves = ASK_KINDS.filter((kind) => {
    const yes = OWNER_ANSWERS.ask[kind].approve;
    return ('by' in yes ? yes.then : yes).some((e) => e === 'odd_leaves' || e === 'odd_returns');
  });
  assert.ok(moves.length, 'no ask kind moves an Odd');
  for (const kind of moves) {
    const [ask] = await db
      .insert(asks)
      .values({ staffId: 'mo', kind, odd: 'ghost', title: kind, why: 'w', ifApproved: 'i' })
      .returning();
    await assert.rejects(O.decideAsk(ask.id, 'approve', null), {
      message: 'No Odd by that name ever worked here.'
    });
    assert.equal((await askOf(ask.id)).status, 'open', kind);
  }
});

// Rico leads work it handed Bea; Bea's result comes back to Rico's pick-up.
type Row = typeof followUps.$inferSelect;
const followUp = async (id: number): Promise<Row> =>
  (await db.select().from(followUps).where(eq(followUps.id, id)))[0];

/** Rico hands Bea a step on new work, and Bea's run starts on it. */
async function handsBea(): Promise<Row> {
  await db.insert(staff).values(odd('bea', 'Bea'));
  const r = await H.handOff({
    from: 'rico',
    to: 'bea',
    work: { title: 'Draw the map', brief: 'Draw it.' },
    thread: { title: 'The map' }
  });
  assert.ok('id' in r, JSON.stringify(r));
  assert.ok(await O.startFollowUp(r.id));
  return followUp(r.id);
}
/** Rico's pick-ups of what Bea sent back, oldest first. */
const ricosPickUps = async (): Promise<Row[]> =>
  (await db.select().from(followUps).where(eq(followUps.staffId, 'rico')))
    .filter((f) => f.kind === 'handed_back')
    .sort((a, b) => a.id - b.id);
/** Bea's run raises an ask on the step, as raise_ask does there. */
const beaAsks = async (h: Row) =>
  (
    await O.raiseAsk('bea', {
      title: 'Buy ink',
      why: 'The map needs it.',
      ifApproved: 'I buy it.',
      handOffId: h.id,
      threadId: h.threadId ?? undefined
    })
  ).ask;
const pokesOf = (id: string) => db.select().from(pokes).where(eq(pokes.staffId, id));

test("a lead removed while it picks up a colleague's result leaves nothing on the desk, and the colleague pokes the owner", async () => {
  const h = await handsBea();
  await O.finishFollowUp(h, 'Draw the map', 'done', 'Drew it.');
  const [back] = await ricosPickUps();
  assert.ok(await O.startFollowUp(back.id));
  assert.equal(await L.removeOdd('rico'), undefined);
  // The office stops the run as Rico leaves, and records it as stopped.
  await O.finishFollowUp(back, 'Draw the map', 'failed', 'Stopped.');
  assert.deepEqual(await db.select().from(reports).where(eq(reports.staffId, 'rico')), []);
  assert.deepEqual(
    (await pokesOf('bea')).map((p) => p.message),
    [
      'Bea finished "Draw the map", but could not hand it back to Rico because Rico is no longer here.'
    ]
  );
});

test("no 'could not hand it back' poke when the hand-back is the owner's own answer", async () => {
  const h = await handsBea();
  const ask = await beaAsks(h);
  await O.finishFollowUp(h, 'Draw the map', 'waiting', 'Asked for ink.');
  const [waited] = await ricosPickUps();
  assert.ok(await O.startFollowUp(waited.id));
  await O.finishFollowUp(waited, 'Draw the map', 'done', 'Waiting on the ink.');
  await O.decideAsk(ask.id, 'deny', null);
  const [, answer] = await ricosPickUps();
  // Only the answered mark keeps this one from poking: it ended failed, not waiting.
  assert.equal(answer.handOff?.answered, true);
  assert.equal(answer.handOff?.outcome, 'failed');
  assert.equal(await L.removeOdd('rico'), undefined);
  assert.equal((await followUp(answer.id)).outcome, 'failed');
  assert.deepEqual(await pokesOf('bea'), []);
});

test("no poke when the colleague's run ended waiting", async () => {
  const h = await handsBea();
  await beaAsks(h);
  await O.finishFollowUp(h, 'Draw the map', 'waiting', 'Asked for ink.');
  const [waiting] = await ricosPickUps();
  assert.equal(waiting.handOff?.outcome, 'waiting');
  assert.notEqual(waiting.handOff?.answered, true);
  assert.equal(await L.removeOdd('rico'), undefined);
  assert.equal((await followUp(waiting.id)).outcome, 'failed');
  assert.deepEqual(await pokesOf('bea'), []);
});

test('an Odd brought back does not start work its leaving already failed', async () => {
  const [r] = await db
    .insert(followUps)
    .values({ staffId: 'rico', kind: 'first_day', note: null })
    .returning();
  assert.equal(await L.removeOdd('rico'), undefined);
  assert.equal((await followUp(r.id)).outcome, 'failed');
  assert.equal(await L.bringBack('rico'), undefined);
  assert.deepEqual(
    (await O.followUpsToDo()).map((f) => f.id),
    []
  );
  assert.equal(await O.startFollowUp(r.id), undefined);
  assert.equal((await followUp(r.id)).startedAt, null);
});

test("after a lead is brought back, the owner's next answer starts a pick-up instead of joining one its leaving failed", async () => {
  const h = await handsBea();
  const work = h.threadId;
  assert.ok(work);
  const task = await O.giveTask(null, {
    title: 'Sign the map',
    why: 'It needs a name on it.',
    steps: ['Sign it'],
    threadId: work
  });
  const { ask } = await O.raiseAsk('rico', {
    title: 'Buy ink',
    why: 'The map needs ink.',
    ifApproved: 'Rico buys ink.',
    threadId: work
  });
  // Rico's own runs on the work, oldest first.
  const ricosOnWork = async () =>
    (await db.select().from(followUps).where(eq(followUps.staffId, 'rico')))
      .filter((f) => f.threadId === work)
      .sort((a, b) => a.id - b.id);
  await O.decideAsk(ask.id, 'deny', null);
  const [denied] = (await ricosOnWork()).filter((f) => f.kind === 'resume');
  assert.ok(
    denied && denied.startedAt === null && denied.outcome === null,
    'the no queued a pick-up'
  );
  assert.equal(await L.removeOdd('rico'), undefined);
  assert.equal((await followUp(denied.id)).outcome, 'failed');
  assert.equal(await L.bringBack('rico'), undefined);
  await O.finishTask(task.id, false, 'no');
  const waiting = (await ricosOnWork()).filter((f) => f.outcome === null && f.startedAt === null);
  assert.equal(waiting.length, 1, JSON.stringify(waiting));
  assert.match(waiting[0].note ?? '', /dropped/);
});

test('a callback given to whenOddLeaves runs once when the Odd leaves, after its leaving is saved', async () => {
  // A connection of its own, open already, so the callback's read goes the
  // moment it runs. One from the pool may still be connecting, and a read
  // that waits for it would find the leaving saved whenever the callback ran.
  const own = await sql.reserve();
  const seen: { id: string; leftAt: PromiseLike<{ left_at: Date | null }[]> }[] = [];
  const stop = L.whenOddLeaves(
    (id) =>
      void seen.push({
        id,
        leftAt: own<
          { left_at: Date | null }[]
        >`select left_at from staff where id = ${id}`.execute()
      })
  );
  try {
    assert.equal(await L.removeOdd('rico'), undefined);
    // Gone already: a second leaving has nothing to stop.
    await L.removeOdd('rico');
    assert.deepEqual(
      seen.map((s) => s.id),
      ['rico']
    );
    const [read] = await seen[0].leftAt;
    assert.ok(read?.left_at, 'the callback ran before the leaving was saved');
  } finally {
    stop();
    own.release();
  }
});

test('a leaving that cannot close all its open work leaves the Odd in the office with that work as it was', async () => {
  const stopped: string[] = [];
  const stop = L.whenOddLeaves((id) => void stopped.push(id));
  const { ask } = await O.raiseAsk('rico', { title: 'Buy ink', why: 'w', ifApproved: 'i' });
  const task = await O.giveTask('rico', { title: 'Sign in', why: 'w', steps: ['Sign in'] });
  // The task's drop fails, as any write might.
  await sql.unsafe(`create function refuse_drop() returns trigger language plpgsql as $$
    begin raise exception 'The desk is busy.'; end $$`);
  await sql.unsafe(`create trigger refuse_drop before update on tasks for each row
    when (new.status = 'dropped') execute function refuse_drop()`);
  try {
    // The database's words come as the cause of the failed query.
    await assert.rejects(L.removeOdd('rico'), (e: Error) =>
      /The desk is busy/.test(String(e.cause))
    );
  } finally {
    await sql.unsafe('drop trigger refuse_drop on tasks');
    await sql.unsafe('drop function refuse_drop');
    stop();
  }
  assert.ok(await O.staffer('rico'), 'the Odd left with its work still open');
  assert.equal((await askOf(ask.id)).status, 'open');
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].status, 'open');
  assert.deepEqual(stopped, []);
});

test('an edit the owner saves to a file of an Odd that left queues no lesson run', async () => {
  const { learnFromEdit } = await import('../src/lessons.ts');
  assert.equal(await L.removeOdd('rico'), undefined);
  assert.equal(
    await learnFromEdit('rico', { path: 'notes/plan.md', before: 'mine' }, 'theirs'),
    false
  );
  assert.deepEqual(
    (await db.select().from(followUps).where(eq(followUps.staffId, 'rico'))).filter(
      (f) => f.outcome === null
    ),
    []
  );
});

test('a tool call still running when its test ends is cut off with its tool server', async () => {
  const c = await toolServer('rico', { RUN_KEY: 'k-left-running', ...said });
  void c.callTool({ name: 'leave_office', arguments: { why: 'Left running.' } }).catch(() => {});
});

test('so the next test starts with nothing the last one left running', async () => {
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(await db.select().from(asks), []);
});
