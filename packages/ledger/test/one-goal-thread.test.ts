// One goal is one thread, led by the manager: a plan raised again after a no
// goes on it, each hire joins it as a colleague, what the owner tells a
// colleague in chat reaches the lead, what a colleague raises comes back to
// the lead through its hand-off, and only the lead hands the work on to the
// end. After the owner stops it, only a new plan opens it again. After every
// test, the goal still has one thread and no hire leads one. Each Odd's tool calls are scripted through the ledger functions, as the
// office makes them, in an in-memory PGlite that stands in for db.ts
// (pglite.ts). Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  asks,
  followUps,
  goals,
  jobs,
  ledger,
  staff,
  staffGoals,
  threads,
  type GoalPlanItem,
  type Step
} from '../src/schema.ts';
import type { ThreadStory } from '../src/lead-brief.ts';
import type { ThreadFor } from '../src/threads.ts';
import { db, sql } from './pglite.ts';
import { oneThreadPerGoal } from './one-thread.ts';

const G = await import('../src/goals.ts');
const H = await import('../src/hand-offs.ts');
const O = await import('../src/office.ts');
const T = await import('../src/threads.ts');
const B = await import('../src/lead-brief.ts');
const W = await import('../src/goal-work.ts');
const { MANAGER_ROLE } = await import('../src/managers.ts');

const odd = (name: string, role: string) => ({
  name,
  role,
  remit: `${role} work.`,
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`,
  room: 'workspace'
});
await db.insert(staff).values({ id: 'marshall', ...odd('Marshall', MANAGER_ROLE) });
afterEach(() => oneThreadPerGoal(sql, MANAGER_ROLE));

type Row = typeof followUps.$inferSelect;

/** The follow-ups an Odd has not started yet, oldest first. */
const pending = (staffId: string) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.staffId, staffId), isNull(followUps.startedAt)))
    .orderBy(asc(followUps.id));
/** A run that starts and ends at once. */
async function run(f: Row, outcome: 'done' | 'failed' | 'waiting', text: string) {
  assert.ok(await O.startFollowUp(f.id), `follow-up ${f.id} (${f.kind}) could not start`);
  await O.finishFollowUp(f, f.handOff?.title ?? f.kind, outcome, text);
}
/** Every run an Odd has waiting, each ended at once. */
async function runAll(staffId: string, outcome: 'done' | 'waiting' = 'done', text = 'Done.') {
  for (const f of await pending(staffId)) await run(f, outcome, text);
}
/** Marshall hands `to` a piece of the goal's work. */
async function give(to: string, title: string, thread: ThreadFor) {
  const r = await H.handOff({
    from: 'marshall',
    to,
    work: { title, brief: `Do ${title}.` },
    thread
  });
  assert.ok('id' in r, JSON.stringify(r));
  return r;
}
const threadRow = async (id: number) =>
  (await db.select().from(threads).where(eq(threads.id, id)))[0];
const hire = (name: string, part: string): GoalPlanItem => ({
  kind: 'hire',
  hire: {
    name,
    role: `${name}'s role`,
    permission: 'draft',
    remit: `${name} does ${part}.`,
    jobDescriptionFile: `${name}.md`
  },
  part
});
const PLAN = [
  hire('Priya', 'the intake and the spin'),
  hire('Owen', 'the build'),
  hire('Tess', 'the review')
];

// A goal with no thread first, so no goal shares its id with a thread by chance.
await db.insert(goals).values({ title: 'Read more' });
const goal = await G.addGoal({
  title: 'Learn the Game of Life',
  horizon: 'quarter',
  area: 'Learning'
});
const [planning] = await pending('marshall');
const goalThread = planning.threadId;
assert.ok(goalThread, "the manager's planning run is on the goal's thread");

/** Marshall raises the plan, from a run on the thread or from a chat. */
const propose = (run: string) =>
  O.raiseAsk('marshall', {
    kind: 'plan',
    title: `Plan for: ${goal.title}`,
    why: 'Three hires do it.',
    ifApproved: 'Each hire opens in the hire window.',
    plan: { goalId: goal.id, items: PLAN },
    run
  });

// Wren does the steps of the work with no goal at the end of the file. Set up
// here, above the first test: under --test-force-exit the runner drops every
// test registered after a top-level await.
await db.insert(staff).values({ id: 'wren', ...odd('Wren', 'Researcher') });

test('a plan raised again after a no goes on the same thread, opened again for a new round', async () => {
  const { ask: first } = await propose('planning-run');
  await run(planning, 'done', 'Plan raised.');
  await O.decideAsk(first.id, 'deny', 'Fewer hires.');
  await runAll('marshall');
  const ended = await threadRow(goalThread);
  assert.equal(ended.status, 'done', 'the no ends the round');

  const { ask: second } = await propose('chat-1');
  assert.equal(second.threadId, goalThread);
  const t = await threadRow(goalThread);
  assert.equal(t.status, 'open', 'not "finished" while the plan waits on the owner');
  assert.equal(t.endedAt, null);
  assert.ok(t.runs.includes('chat-1'), "the lead's chat holds its pick-ups until it ends");
  const brief = B.threadBrief({ story: await B.threadStory(t) }).join('\n');
  assert.ok(brief.includes(`Still waiting on {owner}: "${second.title}".`));
  assert.match(brief, /Nobody serves the goal yet, from the office's records/);
});

const hired: Record<string, string> = {};

test('each hire joins the goal thread as a colleague: no first day, no thread of its own, and the lead is woken', async () => {
  const [plan] = await db
    .select()
    .from(asks)
    .where(and(eq(asks.kind, 'plan'), eq(asks.status, 'open')));
  const { hires } = await G.approvePlan(plan.id, [0, 1, 2], null);
  assert.equal(hires.length, 3);
  for (const a of hires) {
    assert.equal(a.threadId, goalThread);
    const h = a.hire;
    assert.ok(h?.goal, 'a hire ask from a plan names its goal');
    const row = await O.hire(odd(h.name, h.role));
    hired[row.name] = row.id;
    await G.approveHire(a.id, row.id);
  }
  const ids = Object.values(hired);
  const firstDays = await db
    .select()
    .from(followUps)
    .where(and(inArray(followUps.staffId, ids), eq(followUps.kind, 'first_day')));
  assert.equal(firstDays.length, 0);
  assert.equal(
    (await db.select().from(threads).where(inArray(threads.hubId, ids))).length,
    0,
    'no hire leads a thread'
  );
  const brief = B.threadBrief({ story: await B.threadStory(await threadRow(goalThread)) });
  for (const line of [
    '- Priya: the intake and the spin',
    '- Owen: the build',
    '- Tess: the review'
  ])
    assert.ok(brief.includes(line), `the lead's brief has "${line}" from the office's records`);
  assert.ok(!brief.join('\n').includes('Nobody serves the goal yet'));
  const wakes = (await pending('marshall')).filter((f) => f.threadId === goalThread);
  assert.equal(wakes.length, 1, 'the answers join one pick-up for the lead');
  assert.equal(wakes[0].kind, 'resume');
});

test('a hire that serves the goal works on its thread before the lead hands it anything', async () => {
  const rows = await T.threadsOn(hired.Owen);
  assert.deepEqual(
    rows.map((r) => [r.id, r.lead, r.goalId]),
    [[goalThread, 'Marshall', goal.id]]
  );
  assert.deepEqual(await T.threadsOn('marshall'), [], 'never one it leads');
});

let intake: number;
test('a hand-off for the goal goes on its one thread', async () => {
  await runAll('marshall');
  const r = await give(hired.Priya, 'The intake', { title: 'The intake', goalId: goal.id });
  assert.equal(r.thread, goalThread);
  const [f] = await pending(hired.Priya);
  const t = await O.giveTask(hired.Priya, {
    title: 'Answer the intake',
    why: 'Priya needs it to start.',
    steps: ['Answer each question in intake.md below'],
    handOffId: f.id,
    threadId: goalThread
  });
  intake = t.id;
  await run(f, 'waiting', 'The intake is on your desk.');
});

test("what the owner tells a colleague in chat about the goal wakes the lead, and the colleague's own raising is refused", async () => {
  const said = 'Priya, use the Game of Life glider for the spin.';
  const r = await T.tellLead({
    staffId: hired.Priya,
    threadId: goalThread,
    said,
    words: 'use the Game of Life glider for the spin.',
    reading: 'They want the spin to use the glider.'
  });
  assert.deepEqual(r, { lead: 'Marshall' });
  const wake = (await pending('marshall')).find((f) => f.kind === 'resume');
  assert.match(wake?.note ?? '', /Game of Life glider/);
  const rule = await W.goalWork(hired.Priya, await T.threadsOn(hired.Priya));
  assert.deepEqual(rule, { leads: ['Marshall'] });
  const brief = T.threadsOnBrief(await T.threadsOn(hired.Priya));
  assert.ok(brief.includes(T.nextIsLeads('its lead')));
});

test("a colleague's task carries its hand-off, and the owner's answer comes back to the lead", async () => {
  await runAll('marshall');
  await give(hired.Priya, 'Pick the spin', { id: goalThread });
  const [f] = await pending(hired.Priya);
  assert.ok(f.handOff);
  assert.ok(
    H.handOffContext({ h: f.handOff, giver: 'Marshall', me: hired.Priya, thread: goalThread })
      .join('\n')
      .includes(T.nextIsLeads('Marshall'))
  );
  const t = await O.giveTask(hired.Priya, {
    title: 'Pick the spin',
    why: 'Only you know which you like.',
    steps: ['Pick one of the two spins in spins.md below'],
    handOffId: f.id,
    threadId: goalThread
  });
  assert.equal(t.handOffId, f.id);
  assert.equal(t.threadId, goalThread);
  await run(f, 'waiting', 'The spin is on your desk.');
  await runAll('marshall');

  await O.finishTask(intake, false, null);
  await O.finishTask(t.id, true, null);
  const [done] = await pending(hired.Priya);
  assert.equal(done.kind, 'task_done');
  assert.equal((await H.servesHandOff(done))?.id, f.id);
  await run(done, 'done', 'Glider spin it is.');
  const back = (await pending('marshall')).filter((b) => b.kind === 'handed_back');
  assert.ok(
    back.some((b) => b.handOff?.id === f.id && b.note === 'Glider spin it is.'),
    'the spin comes back to the lead'
  );
});

test('the lead hands on to the end, and every run on the thread is its own or serves a hand-off', async () => {
  await runAll('marshall');
  await give(hired.Owen, 'Build the board', { id: goalThread });
  await runAll(hired.Owen);
  await runAll('marshall');
  await give(hired.Tess, 'Review the board', { id: goalThread });
  await runAll(hired.Tess);
  await runAll('marshall');

  const onGoal = await db.select().from(threads).where(eq(threads.goalId, goal.id));
  assert.deepEqual(
    onGoal.map((t) => t.id),
    [goalThread],
    'the goal has one thread'
  );
  const t = onGoal[0];
  assert.equal(t.status, 'done');
  const story = await B.threadStory(t);
  assert.deepEqual(story.waiting, [], 'nothing still waits on the owner');

  const runs = await db.select().from(followUps).where(eq(followUps.threadId, goalThread));
  for (const f of runs)
    assert.ok(
      f.staffId === t.hubId || (await H.servesHandOff(f)),
      `${f.kind} ${f.id} by ${f.staffId} is neither the lead's nor a hand-off's`
    );
  const given = runs.filter((f) => f.kind === 'hand_off');
  const returned = runs.filter((f) => f.kind === 'handed_back');
  for (const h of given)
    assert.ok(
      returned.some((b) => b.handOff?.id === h.id),
      `hand-off ${h.id} has no hand-back`
    );
  const offThread = await db
    .select()
    .from(followUps)
    .where(and(inArray(followUps.staffId, Object.values(hired)), isNull(followUps.threadId)));
  assert.deepEqual(offThread, [], 'no hire runs off the thread');

  const brief = B.threadBrief({ story }).join('\n');
  assert.match(brief, /Pick the spin \([^)]+\): finished\./);
  assert.doesNotMatch(brief, /Still waiting on/);
  assert.match(brief, /The plan \{owner\} approved, part by part:/);
  assert.match(brief, /- Priya \(a hire\): the intake and the spin/);
  assert.match(brief, /Hand on the next piece this plan gives/);

  const notLead = await H.handOff({
    from: hired.Owen,
    to: hired.Tess,
    work: { title: 'A second board', brief: 'Build another.' },
    thread: { title: 'A second board', goalId: goal.id }
  });
  assert.ok('problem' in notLead, 'only the lead hands on for the goal');
  assert.equal((await threadRow(goalThread)).status, 'done', 'a refused hand-off changes nothing');
});

test("the lead's chat is told where its goal stands, from the same record as its pick-ups, bounded to openings", async () => {
  const stories = await B.ledStories('marshall', 'chat');
  assert.deepEqual(
    stories.map((s) => s.thread.id),
    [goalThread]
  );
  const shown = stories[0].latest ? [stories[0].latest.id] : [];
  const known = B.threadKnown({ story: stories[0], shown }).join('\n');
  const chat = B.workLedBrief(stories);
  assert.ok(chat.includes(known), "the chat holds all the lead's pick-ups know");
  assert.ok(B.threadBrief({ story: stories[0], shown }).join('\n').includes(known));
  assert.match(chat, /Review the board \(Tess\): finished\./);
  assert.match(chat, /^Where it stands: finished\.$/m, 'the chat says the work has finished');
  assert.match(chat, /- Priya: the intake and the spin/);
  assert.match(chat, /The plan \{owner\} approved, part by part:/);
  assert.match(
    chat,
    /When you hand \{owner\} a result built there, such as a page, attach that file itself, never a copy: name it from threads\//
  );
  assert.match(chat, /Answer \{owner\} from it, over anything you said earlier in this chat\./);
  assert.doesNotMatch(chat, /Outcome:/, 'a chat is never told to end with an outcome');
  for (const id of Object.values(hired))
    assert.deepEqual(await B.ledStories(id, 'chat'), [], `${id} leads no goal`);

  await db.update(goals).set({ status: 'paused' }).where(eq(goals.id, goal.id));
  assert.deepEqual(
    (await B.ledStories('marshall', 'chat')).map((s) => s.thread.id),
    [goalThread],
    'a paused goal stays, since it is still the lead to answer for'
  );
  await db.update(goals).set({ status: 'met' }).where(eq(goals.id, goal.id));
  assert.deepEqual(await B.ledStories('marshall', 'chat'), [], 'a met goal drops out');
  await db.update(goals).set({ status: 'active' }).where(eq(goals.id, goal.id));
});

test('an ask the lead raised on its finished thread opens it again for a new round', async () => {
  const ended = await threadRow(goalThread);
  const { ask: a } = await O.raiseAsk('marshall', {
    title: 'Share the board on the family screen',
    why: 'It is done.',
    ifApproved: 'I put it up.',
    threadId: goalThread,
    run: 'chat-2'
  });
  const t = await threadRow(goalThread);
  assert.ok(ended.handOffsUsed > 0, 'the last round took hand-offs');
  assert.equal(t.status, 'open');
  assert.equal(t.endedAt, null);
  assert.equal(t.handOffsUsed, 0, 'a new round of work');
  assert.ok(t.runs.includes('chat-2'));
  await O.decideAsk(a.id, 'deny', null);
  await runAll('marshall');
  assert.equal((await threadRow(goalThread)).status, 'done');

  const task = await O.giveTask('marshall', {
    title: 'Hang the board',
    why: 'Only you can reach.',
    steps: ['Hang it by the door'],
    threadId: goalThread,
    run: 'chat-3'
  });
  const t2 = await threadRow(goalThread);
  assert.equal(t2.status, 'open', 'a task opens it again too');
  assert.ok(t2.runs.includes('chat-3'));
  await O.finishTask(task.id, false, null);
  await runAll('marshall');
});

test("a colleague's run never keeps its key on the thread, so it cannot hold the lead's pick-ups", async () => {
  await O.raiseAsk(hired.Owen, {
    title: 'Buy a bigger screen',
    why: 'The board is small.',
    ifApproved: 'You get steps.',
    threadId: goalThread,
    run: 'owen-run'
  });
  await O.giveTask(hired.Owen, {
    title: 'Plug the screen in',
    why: 'Only you can.',
    steps: ['Plug it in'],
    threadId: goalThread,
    run: 'owen-run'
  });
  assert.ok(!(await threadRow(goalThread)).runs.includes('owen-run'));
});

test("after the owner stops the goal's thread, only a new plan opens it again: no other ask, and no hand-off", async () => {
  // The round has taken its limit, so the lead's next hand-off asks the owner.
  assert.equal((await threadRow(goalThread)).endedAt, null);
  await db
    .update(threads)
    .set({ handOffsUsed: T.HAND_OFF_LIMIT })
    .where(eq(threads.id, goalThread));
  const big = await H.handOff({
    from: 'marshall',
    to: hired.Owen,
    work: { title: 'A board for every room', brief: 'Build them all.' },
    thread: { id: goalThread }
  });
  assert.ok('asked' in big, JSON.stringify(big));
  await O.decideAsk(big.asked, 'deny', null);
  assert.equal((await threadRow(goalThread)).status, 'stopped');
  assert.match(
    B.workLedBrief(await B.ledStories('marshall', 'chat')),
    /^Where it stands: it has stopped, so it cannot be continued\.$/m,
    "the lead's chat says the goal's work has stopped"
  );
  assert.match(
    (await T.notLed({ hubId: 'marshall', threadId: goalThread })) ?? '',
    /stopped/,
    'the lead may not name a stopped thread from a chat'
  );

  // A run on the thread, such as one carrying out an earlier yes, still raises there.
  const { ask: late } = await O.raiseAsk('marshall', {
    title: 'Return the spare board',
    why: 'It is not needed now.',
    ifApproved: 'I return it.',
    threadId: goalThread
  });
  assert.equal((await threadRow(goalThread)).status, 'stopped', 'an ask leaves it stopped');
  assert.equal(
    (await T.goalThreads()).find((g) => g.id === goalThread)?.stage,
    'waiting_on_you',
    'a stopped thread with an open ask still shows it waits on the owner'
  );
  await O.decideAsk(late.id, 'deny', null);
  await runAll('marshall');
  assert.equal((await threadRow(goalThread)).status, 'stopped');

  const handed = await H.handOff({
    from: 'marshall',
    to: hired.Owen,
    work: { title: 'One more board', brief: 'Build it.' },
    thread: { title: 'One more board', goalId: goal.id }
  });
  assert.ok('problem' in handed, 'no hand-off for the goal while its thread is stopped');

  const { ask: plan } = await propose('chat-after-stop');
  assert.equal(plan.threadId, goalThread, 'the new plan goes on the same thread');
  const t = await threadRow(goalThread);
  assert.equal(t.status, 'open');
  assert.equal(t.endedAt, null);
  assert.equal(t.handOffsUsed, 0, 'the new plan starts a new round');
  assert.doesNotMatch(
    B.workLedBrief(await B.ledStories('marshall', 'chat')),
    /Where it stands/,
    'work under way has no ended line'
  );
  await O.decideAsk(plan.id, 'deny', null);
  await runAll('marshall');
});

test('a hire with a job and a goal is told the rule in chat rather than refused, and its job work lands on no thread', async () => {
  await O.addJob({
    staffId: hired.Tess,
    name: 'Weekly tidy',
    instructions: 'Tidy the notes.',
    schedule: { every: 'day', at: '09:00' }
  });
  assert.equal(await W.goalWork(hired.Tess, await T.threadsOn(hired.Tess)), undefined);
  const { ask: a } = await O.raiseAsk(hired.Tess, {
    title: 'Archive last week',
    why: 'My job.',
    ifApproved: 'I archive it.'
  });
  assert.equal(a.threadId, null);
});

test("the goal's lead is never refused its own goal's work", async () => {
  assert.equal(await W.goalWork('marshall', await T.threadsOn('marshall')), undefined);
  // An Odd with no job that leads one goal's thread and is handed work on
  // another's, as in an office with no manager: never refused, since some of
  // its work is its own.
  await db.insert(staff).values({ id: 'nell', ...odd('Nell', 'Gardener') });
  const [herbs] = await db.insert(goals).values({ title: 'Plant herbs' }).returning();
  await db
    .insert(threads)
    .values({ title: herbs.title, goalId: herbs.id, hubId: 'nell', holderId: 'nell' });
  await give('nell', 'Water the board', { id: goalThread });
  assert.equal(await W.goalWork('nell', await T.threadsOn('nell')), undefined);
});

test("a hire handed many errands since still has its goal's thread in its chat, so tell_lead stays on", async () => {
  for (let i = 0; i < 6; i++)
    await H.handOff({
      from: 'marshall',
      to: hired.Priya,
      work: { title: `Errand ${i}`, brief: 'Do it.' },
      thread: { title: `Errand ${i}` }
    });
  const on = await T.threadsOn(hired.Priya);
  assert.ok(
    on.some((t) => t.id === goalThread),
    "the goal's thread is never cut"
  );
  assert.equal(on.filter((t) => t.goalId === null).length, 5, 'other threads are still capped');
  assert.deepEqual(
    on.map((t) => t.id),
    on.map((t) => t.id).sort((a, b) => b - a),
    'newest first'
  );
  assert.deepEqual(await W.goalWork(hired.Priya, on), { leads: ['Marshall'] });
});

test('a hire whose goal link fails is not approved, and nobody is woken', async () => {
  await G.addGoal({ title: 'Bake bread', horizon: 'quarter', area: 'Kitchen' });
  const [bread] = (await pending('marshall')).filter((f) => f.kind === 'goal');
  assert.ok(bread.threadId, "the manager's planning run is on the new goal's thread");
  const { ask: proposed } = await O.raiseAsk('marshall', {
    title: 'Hire Gus, Baker',
    why: 'For the goal "Bake bread": the loaves',
    ifApproved: 'The hire window opens with this filled in. You hire from there.',
    // A goal gone since the proposal: linking the hire to it fails.
    hire: {
      name: 'Gus',
      role: 'Baker',
      permission: 'draft',
      remit: 'Gus bakes the loaves.',
      jobDescriptionFile: 'Gus.md',
      goal: { id: 9999, part: 'the loaves' }
    },
    threadId: bread.threadId
  });
  const gus = await O.hire(odd('Gus', 'Baker'));
  const before = (await pending('marshall')).length;
  await assert.rejects(G.approveHire(proposed.id, gus.id), /No such Odd or goal/);
  const [after] = await db.select().from(asks).where(eq(asks.id, proposed.id));
  assert.equal(after.status, 'open', 'the proposal stays on the desk');
  assert.equal(after.decidedAt, null);
  assert.equal((await pending('marshall')).length, before, 'the lead is not woken');
  assert.deepEqual(
    await db.select().from(followUps).where(eq(followUps.askId, proposed.id)),
    [],
    'no follow-up answers it'
  );
  assert.deepEqual(
    await db.select().from(ledger).where(eq(ledger.askId, proposed.id)),
    [],
    'no decision is recorded'
  );
  assert.deepEqual(await db.select().from(staffGoals).where(eq(staffGoals.staffId, gus.id)), []);
});

test('hiring answers only a proposed hire: any other ask stays open', async () => {
  const { ask: other } = await O.raiseAsk('marshall', {
    title: 'Buy flour',
    why: 'For the bread.',
    ifApproved: 'I order it.'
  });
  const ida = await O.hire(odd('Ida', 'Baker'));
  await assert.rejects(G.approveHire(other.id, ida.id), /not a proposed hire/);
  const [after] = await db.select().from(asks).where(eq(asks.id, other.id));
  assert.equal(after.status, 'open');
});

test('the manager still opens a thread when it serves a goal and has no job', async () => {
  await db.insert(staffGoals).values({ staffId: 'marshall', goalId: goal.id, part: 'the lead' });
  await db.delete(jobs).where(eq(jobs.staffId, 'marshall'));
  const r = await give(hired.Priya, 'Sweep up', { title: 'Sweep up' });
  assert.equal((await threadRow(r.thread)).hubId, 'marshall');
});

// The tests below read a piece of work with no goal, whatever ran before them.

/** A new piece of work Marshall leads, with one step handed to Wren and back. */
async function workWithAStep(title: string, result = 'Done.') {
  const { thread } = await give('wren', `${title}: first step`, { title });
  for (const f of await pending('wren')) await run(f, 'done', result);
  return thread;
}
/** Marshall raises an ask on the work. */
const askOn = (threadId: number, title: string, revises?: number) =>
  O.raiseAsk('marshall', {
    title,
    why: 'The hidden why.',
    ifApproved: 'The hidden if.',
    threadId,
    revises
  });
const storyOn = async (id: number) => (await B.ledStories('marshall', { thread: id }))[0];
const headings = (lines: string) => lines.split('\n').filter((l) => l.startsWith('## '));
const CHOICE: Step = {
  text: 'Pick one',
  done: false,
  action: { kind: 'choice', options: ['Navy', 'Teal'] }
};

test("a task the owner finished on a thread appears in that thread's story with their choice", async () => {
  const id = await workWithAStep('Choose the colours');
  const task = await O.giveTask('marshall', {
    title: 'Pick a blue',
    why: 'w',
    steps: [CHOICE],
    threadId: id
  });
  await O.tickStep(task.id, 0, 'Navy');
  await O.finishTask(task.id, true, null);
  assert.deepEqual((await storyOn(id)).said, [
    { what: 'Pick a blue', how: 'finished', words: 'Pick one: Navy' }
  ]);
});

test("a colleague's story tells the owner's answers and the status, and not the text of the asks", async () => {
  const id = await workWithAStep('Stock the shelves');
  const { ask } = await askOn(id, 'Buy the pack');
  await O.decideAsk(ask.id, 'approve', 'Yes');
  // Only a goal's work holds a plan, so this one is given it: it must stay out all the same.
  const story = { ...(await storyOn(id)), plan: { parts: ['Priya: the spin'], answer: 'Go.' } };
  const told = B.threadOnKnown({ story }).join('\n');
  assert.ok(told.includes('"Buy the pack": approved. Their words: Yes'), told);
  assert.match(told, /Marshall leads this work\. You are on it\./);
  for (const hidden of ['The hidden why.', 'The hidden if.', 'Priya: the spin', 'Go.'])
    assert.ok(!told.includes(hidden), `a colleague read "${hidden}"`);
});

test('an ask the Odd replaced with a new version is not told as something the owner said', async () => {
  const id = await workWithAStep('Paint the door');
  const first = await askOn(id, 'Buy paint');
  const second = await askOn(id, 'Buy better paint', first.ask.id);
  assert.equal((await storyOn(id)).said.length, 0, 'nothing is answered yet');
  // Approved with no reason, so a filter that compared a null reason would lose it.
  await O.decideAsk(second.ask.id, 'approve', null);
  assert.deepEqual((await storyOn(id)).said, [{ what: 'Buy better paint', how: 'approved' }]);
});

test("an answer or a step's result that holds a heading stays inside its story, on one line", async () => {
  const id = await workWithAStep('Write the page', 'It is written.\n## Not a section');
  const { ask } = await askOn(id, 'Publish it');
  await O.decideAsk(ask.id, 'deny', 'Not yet.\n## Not a section');
  const story = await storyOn(id);
  assert.deepEqual(headings(B.threadOnKnown({ story }).join('\n')), [`## Work ${id}`]);
  assert.deepEqual(headings(B.workLedBrief([story])), [`## Work ${id}`]);
  assert.deepEqual(headings(B.workOnBrief([story])), [`## Work ${id}`]);
  // A pick-up's brief holds the latest result whole, so this one says it already holds it.
  const shown = story.latest ? [story.latest.id] : [];
  assert.deepEqual(headings(B.threadKnown({ story, shown }).join('\n')), [`## Work ${id}`]);
  assert.deepEqual(story.said, [
    { what: 'Publish it', how: 'turned down', words: 'Not yet. ## Not a section' }
  ]);

  const titled = await storyOn(await workWithAStep('Plan the day\n## Not a section'));
  const heading = [`## Work ${titled.thread.id}`];
  assert.deepEqual(headings(B.threadOnKnown({ story: titled }).join('\n')), heading);
  assert.deepEqual(headings(B.workLedBrief([titled])), heading);
});

test('a story keeps the newest ten things the owner decided, oldest first', async () => {
  const id = await workWithAStep('Answer a lot');
  for (let i = 0; i < 11; i++) {
    const { ask } = await askOn(id, `Question ${i}`);
    await O.decideAsk(ask.id, 'approve', null);
  }
  assert.deepEqual(
    (await storyOn(id)).said.map((s) => s.what),
    Array.from({ length: 10 }, (_, i) => `Question ${i + 1}`)
  );
});

test("a chat is told each live goal's work and the latest five others, for its lead and for a colleague", async () => {
  const made: number[] = [];
  for (let i = 0; i < 6; i++) made.push(await workWithAStep(`Errand ${i}`));
  const latest = made.slice(1).reverse();
  const led = await B.ledStories('marshall', 'chat');
  assert.ok(
    led.some((s) => s.thread.id === goalThread),
    "a live goal's work stays, however much else there is"
  );
  assert.deepEqual(
    led.filter((s) => s.thread.goalId === null).map((s) => s.thread.id),
    latest
  );
  assert.deepEqual(
    (await B.onStories('wren')).map((s) => s.thread.id),
    latest
  );
  assert.deepEqual(await B.storyOf(0), [], 'no such work has no story');
  assert.deepEqual(
    (await B.storyOf(made[0])).map((s) => s.thread.id),
    [made[0]]
  );
});

test("a chat's story holds the last steps of each piece of work and says how many came before, and stays bounded", async () => {
  const row = await threadRow(await workWithAStep('Fill a story'));
  const full = (id: number, goalId: number | null = null): ThreadStory => ({
    thread: { ...row, id, goalId, title: 't'.repeat(140), status: 'open' },
    steps: Array.from({ length: 8 }, (_, i) => ({
      title: `s${i}`.padEnd(140, 's'),
      to: 'Wren',
      outcome: 'done' as const,
      text: 'r'.repeat(2_000)
    })),
    latest: { id: 1, from: 'Wren', text: 'THE WHOLE RESULT' },
    waiting: [],
    said: Array.from({ length: 10 }, (_, i) => ({
      what: `${i}`.padEnd(140, 'w'),
      how: 'approved',
      words: 'x'.repeat(500)
    })),
    lead: 'Marshall'
  });
  const one = B.workLedBrief([full(1)]);
  assert.match(one, /3 earlier steps are left out here\./);
  assert.match(one, /^4\. s3/m, 'each step keeps its real number');
  assert.ok(!one.includes('THE WHOLE RESULT'), 'a chat reads no full result');
  assert.ok(one.length < 12_000, `one story took ${one.length} characters`);
  assert.match(B.workOnBrief([full(1)]), /3 earlier steps are left out here\./);

  const brief = (s: ThreadStory) => B.workLedBrief([s]);
  const twelve = Array.from({ length: 12 }, (_, i) => full(i + 1));
  const fit = B.fitStories(twelve, brief, B.CHAT_STORIES_MAX);
  assert.deepEqual(
    fit.kept.map((s) => s.thread.id),
    [12, 11],
    'whole stories, newest first'
  );
  assert.ok(fit.used <= B.CHAT_STORIES_MAX, `used ${fit.used}`);
  assert.equal(fit.used, B.workLedBrief(fit.kept).length, 'the sum is the length of the brief');

  const withGoal = B.fitStories([...twelve, full(0, goal.id)], brief, B.CHAT_STORIES_MAX);
  assert.deepEqual(
    withGoal.kept.map((s) => s.thread.id),
    [0, 12],
    "a live goal's story comes before newer work"
  );
});
