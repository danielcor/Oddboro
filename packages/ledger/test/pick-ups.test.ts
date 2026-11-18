// How work comes back to a thread's lead: an Odd runs once at a time on a
// thread, results that land while the lead runs there come back together in
// one pick-up, and a colleague's run that ends waiting goes back as waiting
// only while something it raised is still open, so the lead is never told it
// waits on the owner after the owner answered. The office's own code on every
// migration, in an in-memory PGlite that stands in for db.ts (pglite.ts). Run
// with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  asks,
  followUps,
  goals,
  ledger,
  planLimits,
  pokes,
  reports,
  staff,
  tasks,
  threads,
  type FollowUpKind
} from '../src/schema.ts';
import { db } from './pglite.ts';
import { ownerWords } from './owner-words.ts';

const H = await import('../src/hand-offs.ts');
const O = await import('../src/office.ts');
const T = await import('../src/threads.ts');
const { answerLeadNow } = await import('./answer-lead.ts');
const B = await import('../src/lead-brief.ts');
const P = await import('../src/task-parking.ts');
const L = await import('../src/leaving.ts');

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
await db.insert(staff).values([odd('lead', 'Lena'), odd('paige', 'Paige'), odd('rex', 'Rex')]);

type Row = typeof followUps.$inferSelect;

/**
 * `lead` hands `to` a piece of work: on a new thread, or on `thread`. `run` is
 * the key of the chat or job it comes from, as `hand_off` passes it.
 */
async function give(to: string, title: string, thread?: number, run?: string): Promise<Row> {
  const r = await H.handOff({
    from: 'lead',
    to,
    work: { title, brief: `Do ${title}.` },
    thread: thread ? { id: thread } : { title: `Thread for ${title}` },
    run
  });
  assert.ok('id' in r, JSON.stringify(r));
  return byId(r.id);
}
async function byId(id: number): Promise<Row> {
  const [row] = await db.select().from(followUps).where(eq(followUps.id, id));
  return row;
}
/** Every follow-up on a thread of one kind, oldest first. */
const onThread = (id: number, kind: FollowUpKind) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.threadId, id), eq(followUps.kind, kind)))
    .orderBy(followUps.id);
const listed = async (id: number) => (await O.followUpsToDo()).some((t) => t.id === id);
/** A run that starts and ends at once. */
async function runs(
  f: Row,
  outcome: 'done' | 'failed' | 'waiting',
  text: string,
  joined?: number[]
) {
  assert.ok(await O.startFollowUp(f.id), `follow-up ${f.id} could not start`);
  await O.finishFollowUp(f, f.handOff?.title ?? 'work', outcome, text, { joined });
}
async function threadOf(id: number) {
  const [t] = await db.select().from(threads).where(eq(threads.id, id));
  return t;
}
/** The colleague's run on `h` raises one ask on the hand-off, as raise_ask does. */
async function raises(h: Row, title: string) {
  const { ask } = await O.raiseAsk(h.staffId, {
    title,
    why: 'The work needs it.',
    ifApproved: 'I do it.',
    handOffId: h.id,
    threadId: h.threadId ?? undefined
  });
  return ask;
}

test('a colleague whose run ends waiting, with its ask still open, goes back waiting, and the later no goes back too', async () => {
  const h = await give('paige', 'Book the venue');
  assert.ok(await O.startFollowUp(h.id));
  const ask = await raises(h, 'Email the venue');
  await O.finishFollowUp(
    h,
    'Book the venue',
    'waiting',
    'Drafted the email; it waits on your yes.'
  );
  await O.decideAsk(ask.id, 'deny', null);
  const backs = await onThread(h.threadId ?? 0, 'handed_back');
  assert.deepEqual(
    backs.map((b) => [b.handOff?.outcome, !!b.handOff?.answered]),
    [
      ['waiting', false],
      ['failed', true]
    ]
  );
});

test('a no that comes while the colleague still runs goes back, and its run ending waiting sends nothing stale after it', async () => {
  const h = await give('paige', 'Price the venue');
  assert.ok(await O.startFollowUp(h.id));
  const ask = await raises(h, 'Call the venue');
  await O.decideAsk(ask.id, 'deny', null);
  await O.finishFollowUp(h, 'Price the venue', 'waiting', 'Asked to call the venue.');
  const backs = await onThread(h.threadId ?? 0, 'handed_back');
  assert.deepEqual(
    backs.map((b) => [b.handOff?.outcome, !!b.handOff?.answered]),
    [['failed', true]]
  );
  // The lead picks the answer up, and nothing waits on the owner any more.
  await runs(backs[0], 'done', 'Moved on without the call.');
  assert.equal((await threadOf(h.threadId ?? 0)).status, 'done');
  const [line] = (await H.handOffsFor('lead')).filter((l) => l.id === h.id);
  assert.equal(line.status, 'failed');
});

test('an ask tied to its hand-off alone, with no thread, still counts: a no while the colleague runs leaves its waiting end nothing stale to send', async () => {
  const h = await give('paige', 'Price the hall');
  assert.ok(await O.startFollowUp(h.id));
  // `raises` also links the thread, which reaches the ask a second way.
  const { ask } = await O.raiseAsk('paige', {
    title: 'Call the hall',
    why: 'The work needs it.',
    ifApproved: 'I do it.',
    handOffId: h.id
  });
  await O.decideAsk(ask.id, 'deny', null);
  await O.finishFollowUp(h, 'Price the hall', 'waiting', 'Asked to call the hall.');
  const backs = await onThread(h.threadId ?? 0, 'handed_back');
  assert.deepEqual(
    backs.map((b) => [b.handOff?.outcome, !!b.handOff?.answered]),
    [['failed', true]]
  );
});

test("a yes that comes while the colleague still runs starts its carry-out only once that run ends, and only the carry-out's result goes back", async () => {
  const h = await give('rex', 'Draft the invite');
  assert.ok(await O.startFollowUp(h.id));
  const ask = await raises(h, 'Send the invite');
  await O.decideAsk(ask.id, 'approve', null);
  const [carry] = await onThread(h.threadId ?? 0, 'carry_out');
  assert.equal(carry.staffId, 'rex');
  assert.equal(
    await listed(carry.id),
    false,
    'the carry-out is listed while the run that raised it runs'
  );
  assert.equal(await O.startFollowUp(carry.id), undefined);
  await O.finishFollowUp(h, 'Draft the invite', 'waiting', 'The invite waits on your yes.');
  assert.deepEqual(await onThread(h.threadId ?? 0, 'handed_back'), []);
  assert.equal(await listed(carry.id), true);
  await runs(carry, 'done', 'Sent the invite.');
  const backs = await onThread(h.threadId ?? 0, 'handed_back');
  assert.deepEqual(
    backs.map((b) => [b.handOff?.outcome, b.note]),
    [['done', 'Sent the invite.']]
  );
});

test('a run that ends waiting having raised nothing still goes back waiting, so the lead is never left without word', async () => {
  const h = await give('paige', 'Check the menu');
  await runs(h, 'waiting', 'Waiting, though I asked for nothing.');
  const backs = await onThread(h.threadId ?? 0, 'handed_back');
  assert.deepEqual(
    backs.map((b) => b.handOff?.outcome),
    ['waiting']
  );
});

test('a lone result is listed and starts at once, and its pick-up joins nothing', async () => {
  const h = await give('paige', 'Write the toast');
  await runs(h, 'done', 'Wrote the toast.');
  const [back] = await onThread(h.threadId ?? 0, 'handed_back');
  assert.equal(await listed(back.id), true);
  assert.deepEqual(await H.resultsToJoin(back), []);
  assert.ok(await O.startFollowUp(back.id));
});

test('results that land while the lead runs on its thread wait, then come back together in one run', async () => {
  const first = await give('paige', 'Piece one');
  const thread = first.threadId ?? 0;
  const second = await give('rex', 'Piece two', thread);
  const third = await give('paige', 'Piece three', thread);
  // Two hand-offs to one colleague run side by side: new work never waits.
  for (const h of [first, second, third]) assert.ok(await O.startFollowUp(h.id));
  await O.finishFollowUp(first, 'Piece one', 'done', 'One is done.');
  const [b1] = await onThread(thread, 'handed_back');
  assert.ok(await O.startFollowUp(b1.id), 'the lead picks the first result up');
  await O.finishFollowUp(second, 'Piece two', 'done', 'Two is done.');
  await O.finishFollowUp(third, 'Piece three', 'failed', 'Three could not be done.');
  const [, b2, b3] = await onThread(thread, 'handed_back');
  for (const b of [b2, b3]) {
    assert.equal(await listed(b.id), false, 'a result is listed while the lead runs');
    assert.equal(await O.startFollowUp(b.id), undefined, 'the lead ran twice at once');
  }
  await O.finishFollowUp(b1, 'Piece one', 'done', 'Checked one; waiting on two and three.');
  assert.ok(await O.startFollowUp(b2.id));
  assert.equal(
    await O.startFollowUp(b3.id),
    undefined,
    'a second pick-up started beside the first'
  );
  const joined = await H.resultsToJoin(b2);
  assert.deepEqual(
    joined.map((j) => j.id),
    [b3.id]
  );
  await O.finishFollowUp(b2, 'Piece two', 'done', 'Both are in.', { joined: [b3.id] });
  const ended = await onThread(thread, 'handed_back');
  assert.deepEqual(
    ended.map((b) => [b.outcome, b.result]),
    [
      ['done', 'Checked one; waiting on two and three.'],
      ['done', 'Both are in.'],
      ['done', 'Both are in.']
    ]
  );
  const onIt = await db.select().from(followUps).where(eq(followUps.threadId, thread));
  for (const f of onIt) assert.equal(await listed(f.id), false);
});

test("the lead's other runs on its thread wait for its pick-up too", async () => {
  const h = await give('rex', 'Order the cake');
  const thread = h.threadId ?? 0;
  await runs(h, 'done', 'Ordered.');
  const [back] = await onThread(thread, 'handed_back');
  assert.ok(await O.startFollowUp(back.id));
  const { ask } = await O.raiseAsk('lead', {
    title: 'Pay for the cake',
    why: 'It needs paying.',
    ifApproved: 'I pay it.',
    threadId: thread
  });
  await O.decideAsk(ask.id, 'approve', null);
  const [carry] = await onThread(thread, 'carry_out');
  assert.equal(await O.startFollowUp(carry.id), undefined);
  await O.finishFollowUp(back, 'Order the cake', 'done', 'Checked the order.');
  assert.ok(await O.startFollowUp(carry.id));
});

test("a hand-off's brief lists each file carried for it, at its full path", () => {
  // hand_off copies each file into the work's folder; the brief names only
  // those still there, so the copies have to exist.
  const paths = [join(T.threadFolder(7), 'lead', 'x.md'), join(T.threadFolder(7), 'paige', 'y.md')];
  for (const p of paths) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'carried');
  }
  const brief = H.handOffBrief({
    kind: 'hand_off',
    h: { from: 'lead', title: 'Piece', brief: 'Do it.', files: ['lead/x.md', 'paige/y.md'] },
    colleague: { id: 'lead', name: 'Lena' },
    me: 'paige',
    result: null,
    thread: 7
  }).join('\n');
  assert.ok(brief.includes(`- Files for this work, in reach: ${paths.join(', ')}.`), brief);
});

test('a pick-up brief names each result it takes, and a lone one reads as it always did', () => {
  const h = { from: 'paige', title: 'Piece one', brief: 'Do one.', outcome: 'done' as const };
  const base = {
    kind: 'handed_back' as const,
    h,
    colleague: { id: 'paige', name: 'Paige' },
    me: 'lead',
    result: 'One is done.',
    thread: 7
  };
  const lone = H.handOffBrief(base).join('\n');
  assert.equal(H.handOffBrief({ ...base, joined: [] }).join('\n'), lone);
  assert.doesNotMatch(lone, /More came back/);
  assert.match(lone, /what came back from Paige/);
  const both = H.handOffBrief({
    ...base,
    joined: [
      {
        h: { from: 'rex', title: 'Piece two', brief: 'Do two.', outcome: 'failed' },
        colleague: { id: 'rex', name: 'Rex' },
        result: 'Two could not be done.'
      }
    ]
  }).join('\n');
  assert.match(both, /More came back while you were busy on this work/);
  assert.match(
    both,
    /- Rex took "Piece two"\. They could not finish it\. What they sent back:\n\nTwo could not be done\./
  );
  assert.match(both, /what came back from each colleague/);
});

test("the lead's brief names the hand-offs still out, and leaves out a result its run already holds", async () => {
  const first = await give('paige', 'Count the chairs');
  const thread = first.threadId ?? 0;
  await give('rex', 'Count the tables', thread);
  await runs(first, 'done', 'Forty chairs.');
  const [back] = await onThread(thread, 'handed_back');
  const story = await B.threadStory(await threadOf(thread));
  const brief = B.threadBrief({ story, shown: [back.id] }).join('\n');
  assert.match(brief, /Still out: "Count the tables" \(Rex\)\./);
  assert.doesNotMatch(brief, /Count the chairs" \(Paige\)\./);
  assert.doesNotMatch(brief, /The latest result/);
  assert.match(B.threadBrief({ story }).join('\n'), /The latest result, from Paige, in full/);
});

test("a lead's chat that hands off on a thread holds its pick-ups there until it ends, and what landed meanwhile comes back in one run", async () => {
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  const first = await give('paige', 'Write the speech', undefined, chat);
  const thread = first.threadId ?? 0;
  const second = await give('rex', 'Book the band', thread, chat);
  for (const h of [first, second]) assert.ok(await O.startFollowUp(h.id));
  await O.finishFollowUp(first, 'Write the speech', 'done', 'The speech is written.');
  const [b1] = await onThread(thread, 'handed_back');
  assert.equal(await listed(b1.id), false, 'a result is listed while the chat still hands off');
  assert.equal(await O.startFollowUp(b1.id), undefined, 'the lead picked up beside its own chat');
  // The chat goes on handing off, and new work still starts at once.
  const third = await give('paige', 'Sign off the plan', thread, chat);
  assert.ok(await O.startFollowUp(third.id));
  await O.finishFollowUp(second, 'Book the band', 'done', 'The band is booked.');
  const [, b2] = await onThread(thread, 'handed_back');
  assert.equal(await O.startFollowUp(b2.id), undefined);
  O.runsGoing.delete(chat);
  assert.equal(await listed(b1.id), true, 'the chat ended, and its pick-up still waits');
  assert.ok(await O.startFollowUp(b1.id));
  assert.deepEqual(
    (await H.resultsToJoin(b1)).map((j) => j.id),
    [b2.id]
  );
  assert.equal(
    await O.startFollowUp(b2.id),
    undefined,
    'a second pick-up started beside the first'
  );
});

test("a lead's chat that hands off on a thread another run opened holds its pick-ups there until it ends", async () => {
  const opened = await give('paige', 'Paint the sign');
  const thread = opened.threadId ?? 0;
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  await give('rex', 'Hang the sign', thread, chat);
  await runs(opened, 'done', 'Painted.');
  const [back] = await onThread(thread, 'handed_back');
  assert.equal(
    await listed(back.id),
    false,
    'the lead picked up beside the chat that handed off there'
  );
  O.runsGoing.delete(chat);
  assert.equal(await listed(back.id), true);
});

test("a lead's pick-up after a task it gave in a chat waits while the chat goes, and is listed to start until it starts", async () => {
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  const h = await give('rex', 'Fit the lights', undefined, chat);
  const thread = h.threadId ?? 0;
  const t = await O.giveTask('lead', {
    title: 'Buy the bulbs',
    why: 'w',
    steps: ['Buy them'],
    threadId: thread,
    run: chat
  });
  await O.finishTask(t.id, true, 'Bought.');
  const [after] = await onThread(thread, 'task_done');
  const toStart = async () => (await O.followUpsToStart()).map((f) => f.id);
  assert.equal(await listed(after.id), false, 'the pick-up started beside the chat');
  assert.ok((await toStart()).includes(after.id), 'a pick-up that waits is not listed to start');
  O.runsGoing.delete(chat);
  assert.ok(await O.startFollowUp(after.id));
  assert.equal((await toStart()).includes(after.id), false, 'a started pick-up is still listed');
  await O.finishFollowUp(after, 'Buy the bulbs', 'done', 'Fitted.');
});

test("a lone hand-off picks up at once, even while the lead's chat hands off on another thread", async () => {
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  await give('rex', 'Hire the photographer', undefined, chat);
  const lone = await give('paige', 'Print the menus');
  await runs(lone, 'done', 'The menus are printed.');
  const [back] = await onThread(lone.threadId ?? 0, 'handed_back');
  assert.equal(await listed(back.id), true);
  assert.ok(await O.startFollowUp(back.id));
  O.runsGoing.delete(chat);
});

test("a lead's chat holds only the lead: a colleague's carry-out on the thread starts while it goes", async () => {
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  const h = await give('rex', 'Draft the menu', undefined, chat);
  assert.ok(await O.startFollowUp(h.id));
  const ask = await raises(h, 'Send the menu');
  // Goes back waiting, as the ask is still open: a result row on the thread from rex.
  await O.finishFollowUp(h, 'Draft the menu', 'waiting', 'The menu waits on your yes.');
  await O.decideAsk(ask.id, 'approve', null);
  const [carry] = await onThread(h.threadId ?? 0, 'carry_out');
  assert.equal(carry.staffId, 'rex');
  assert.ok(await O.startFollowUp(carry.id));
  O.runsGoing.delete(chat);
});

test('after a restart, a result from a chat that was handing off picks up at once, even beside a new chat', async () => {
  const before = randomUUID();
  O.reserveRun({ key: before, staffId: 'test', kind: 'chat' });
  const h = await give('paige', 'Plan the seating', undefined, before);
  const thread = h.threadId ?? 0;
  assert.ok(await O.startFollowUp(h.id));
  // The restart: a new process, where the old chat's key was never held,
  // and its cut-off runs fail, so the result goes back.
  O.runsGoing.delete(before);
  const after = randomUUID();
  O.reserveRun({ key: after, staffId: 'test', kind: 'chat' });
  await O.closeStaleFollowUps();
  const [back] = await onThread(thread, 'handed_back');
  assert.equal(back.handOff?.outcome, 'failed');
  assert.equal(await listed(back.id), true);
  assert.ok(await O.startFollowUp(back.id));
  O.runsGoing.delete(after);
});

/** What the owner's desk got for `staffId`'s runs a restart cut off. */
const cutOffReports = (staffId: string) =>
  db
    .select()
    .from(reports)
    .where(and(eq(reports.staffId, staffId), eq(reports.body, O.CUT_OFF_RESULT)));

test("a hand-off a restart cut off goes back to its lead only, with nothing on the owner's desk", async () => {
  await O.closeStaleFollowUps();
  const before = (await cutOffReports('paige')).length;
  const h = await give('paige', 'Paint the doors');
  assert.ok(await O.startFollowUp(h.id));
  await O.closeStaleFollowUps();
  const backs = await onThread(h.threadId ?? 0, 'handed_back');
  assert.deepEqual(
    backs.map((b) => [b.staffId, b.handOff?.outcome]),
    [['lead', 'failed']]
  );
  assert.equal(
    (await cutOffReports('paige')).length,
    before,
    'the lead redoes it, so the owner is not asked'
  );
});

test("a run a restart cut off with no lead to wake still goes on the owner's desk", async () => {
  await O.closeStaleFollowUps();
  const before = (await cutOffReports('rex')).length;
  const { ask } = await O.raiseAsk('rex', { title: 'Sweep the yard', why: 'w', ifApproved: 'i' });
  await O.decideAsk(ask.id, 'approve', null);
  const [carry] = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.askId, ask.id), eq(followUps.kind, 'carry_out')));
  assert.equal(carry.threadId, null);
  assert.ok(await O.startFollowUp(carry.id));
  await O.closeStaleFollowUps();
  assert.equal((await cutOffReports('rex')).length, before + 1);
});

/** Everything on the owner's desk: reports, asks and tasks, in any state. */
const deskItems = async () =>
  (await db.select().from(reports)).length +
  (await db.select().from(asks)).length +
  (await db.select().from(tasks)).length;

test("a failed hand-off on a goal wakes its lead once, and puts nothing on the owner's desk", async () => {
  const [g] = await db.insert(goals).values({ title: 'Light the pier' }).returning();
  const r = await H.handOff({
    from: 'lead',
    to: 'paige',
    work: { title: 'Hang the lamps', brief: 'Hang them.' },
    thread: { title: 'Light the pier', goalId: g.id }
  });
  assert.ok('id' in r, JSON.stringify(r));
  const h = await byId(r.id);
  const before = await deskItems();
  await runs(h, 'failed', 'The ladder broke.');
  const backs = await onThread(r.thread, 'handed_back');
  assert.deepEqual(
    backs.map((b) => [b.staffId, b.handOff?.outcome]),
    [['lead', 'failed']]
  );
  assert.equal(await deskItems(), before, 'the lead handles it, so the owner is not told');
});

test("a failed run with no lead to wake puts one report on the owner's desk", async () => {
  const { ask } = await O.raiseAsk('rex', { title: 'Mend the gate', why: 'w', ifApproved: 'i' });
  await O.decideAsk(ask.id, 'approve', null);
  const [carry] = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.askId, ask.id), eq(followUps.kind, 'carry_out')));
  const before = await deskItems();
  await runs(carry, 'failed', 'The hinge snapped.');
  const told = await db
    .select()
    .from(reports)
    .where(and(eq(reports.staffId, 'rex'), eq(reports.body, 'The hinge snapped.')));
  assert.equal(told.length, 1);
  assert.equal(await deskItems(), before + 1);
});

test("answers that come while the lead's chat holds its thread join one pick-up, which the claim returns whole", async () => {
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  const h = await give('paige', 'Choose the venue', undefined, chat);
  const thread = h.threadId ?? 0;
  await answerLeadNow(thread, 'First answer.');
  await answerLeadNow(thread, 'Second answer.');
  const [wake, ...more] = await onThread(thread, 'resume');
  assert.equal(more.length, 0, 'the lead would wake twice');
  assert.equal(await listed(wake.id), false);
  O.runsGoing.delete(chat);
  assert.equal((await O.startFollowUp(wake.id))?.note, 'First answer.\nSecond answer.');
});

test('an answer joins a pick-up still to start even with no run holding it, so a pick-up listed before it misses nothing', async () => {
  const h = await give('rex', 'Order the flowers');
  const thread = h.threadId ?? 0;
  await answerLeadNow(thread, 'Roses.');
  const [wake] = await onThread(thread, 'resume');
  assert.equal(await listed(wake.id), true);
  await answerLeadNow(thread, 'Not red ones.');
  assert.equal((await onThread(thread, 'resume')).length, 1);
  assert.equal((await O.startFollowUp(wake.id))?.note, 'Roses.\nNot red ones.');
  // Once the pick-up started, the next answer writes one of its own.
  await answerLeadNow(thread, 'And lilies.');
  assert.equal((await onThread(thread, 'resume')).length, 2);
});

test("a chat whose hand-off passed the round's limit: the owner's yes starts it beside the chat, and holds the lead's pick-up until the chat ends", async () => {
  const [year] = await db
    .insert(threads)
    .values({ title: 'The year', hubId: 'lead', holderId: 'lead', handOffsUsed: T.HAND_OFF_LIMIT })
    .returning();
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  const r = await H.handOff({
    from: 'lead',
    to: 'paige',
    work: { title: 'Plan the year', brief: 'Plan it.' },
    thread: { id: year.id },
    run: chat
  });
  assert.ok('asked' in r, JSON.stringify(r));
  await O.decideAsk(r.asked, 'approve', 'Start with spring.');
  const [held] = await onThread(r.thread, 'hand_off');
  assert.equal(await listed(held.id), true, 'a hand-off is new work, so it runs beside the chat');
  const [wake] = await onThread(r.thread, 'resume');
  assert.equal(
    await listed(wake.id),
    false,
    'the pick-up runs beside the chat that opened the thread'
  );
  O.runsGoing.delete(chat);
  assert.equal(await listed(wake.id), true);
});

test("a chat whose hand-off the usage window held holds the pick-up the window's yes starts, until the chat ends", async () => {
  const w = { fiveHour: 0.9, fiveHourResetsAt: new Date(Date.now() + 7_200_000), sevenDay: 0.1 };
  await db
    .insert(planLimits)
    .values({ id: 'claude', ...w })
    .onConflictDoUpdate({ target: planLimits.id, set: w });
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  const r = await H.handOff({
    from: 'lead',
    to: 'paige',
    work: { title: 'Book the hall', brief: 'Book it.' },
    thread: { title: 'The hall' },
    run: chat
  });
  assert.ok('problem' in r, JSON.stringify(r));
  const [held] = await db.select().from(asks).where(eq(asks.kind, 'window'));
  await O.decideAsk(held.id, 'approve', null);
  const [t] = await db.select().from(threads).where(eq(threads.title, 'The hall'));
  const [wake] = await onThread(t.id, 'resume');
  assert.equal(await listed(wake.id), false, 'the pick-up runs beside the chat the window held');
  O.runsGoing.delete(chat);
  assert.equal(await listed(wake.id), true);
  await db.delete(planLimits);
});

test('a carry-out on no thread that hands off holds the pick-up of its result while it runs', async () => {
  const { ask } = await O.raiseAsk('lead', { title: 'Plan the party', why: 'w', ifApproved: 'i' });
  await O.decideAsk(ask.id, 'approve', null);
  const [carry] = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.askId, ask.id), eq(followUps.kind, 'carry_out')));
  assert.equal(carry.threadId, null);
  assert.ok(await O.startFollowUp(carry.id));
  // The office gives every run a key, this one too, and hand_off passes it on.
  const key = randomUUID();
  O.reserveRun({ key: key, staffId: 'test', kind: 'chat' });
  const h = await give('rex', 'Find a caterer', undefined, key);
  await runs(h, 'done', 'Found one.');
  const [back] = await onThread(h.threadId ?? 0, 'handed_back');
  assert.equal(
    await O.startFollowUp(back.id),
    undefined,
    'the lead picked up beside its carry-out'
  );
  O.runsGoing.delete(key);
  assert.ok(await O.startFollowUp(back.id));
});

test("a chat that raises a goal's plan holds the pick-up the owner's yes starts on the goal's thread, until the chat ends", async () => {
  const [g] = await db.insert(goals).values({ title: 'Run the fair' }).returning();
  const chat = randomUUID();
  O.reserveRun({ key: chat, staffId: 'test', kind: 'chat' });
  const { ask } = await O.raiseAsk('lead', {
    kind: 'plan',
    title: 'Plan for: Run the fair',
    why: 'w',
    ifApproved: 'i',
    plan: { goalId: g.id, items: [{ kind: 'assign', staff: 'rex', part: 'Stalls' }] },
    run: chat
  });
  await O.decideAsk(ask.id, 'approve', null);
  const [wake] = await onThread(ask.threadId ?? 0, 'resume');
  assert.equal(
    await listed(wake.id),
    false,
    'the pick-up runs beside the chat that raised the plan'
  );
  O.runsGoing.delete(chat);
  assert.equal(await listed(wake.id), true);
});

test('a task given on a hand-off and finished while the run goes sends no stale waiting, and its pick-up runs', async () => {
  const h = await give('rex', 'Sign the lease');
  assert.ok(await O.startFollowUp(h.id));
  const t = await O.giveTask('rex', {
    title: 'Sign it',
    why: 'w',
    steps: ['Sign it'],
    handOffId: h.id,
    threadId: h.threadId ?? undefined
  });
  await O.finishTask(t.id, true, 'Signed.');
  await O.finishFollowUp(h, 'Sign the lease', 'waiting', 'Waiting on the signature.');
  assert.deepEqual(await onThread(h.threadId ?? 0, 'handed_back'), []);
  const [done] = await onThread(h.threadId ?? 0, 'task_done');
  assert.ok(await O.startFollowUp(done.id));
});

test("by kind alone, only a pick-up and a run reading the owner's no, edit or answer work at Draft; only the no and the edit hand nothing on", async () => {
  // Every kind, from the one map the type checker holds to the full list. A
  // hand-off's own run is held to Draft as a run that serves one, which the
  // owner's choice for work from colleagues can lift (`runsAtDraft`).
  const kinds = Object.keys((await import('../src/lessons.ts')).NOTE_IS_OWNERS) as FollowUpKind[];
  assert.deepEqual(kinds.filter(H.atDraft), [
    'denied',
    'handed_back',
    'resume',
    'answered',
    'edited'
  ]);
  assert.deepEqual(kinds.filter(H.servesNoThread), ['denied', 'edited']);
});

test('a thread keeps the key of every run that handed off on it, so each holds the pick-up while it goes', async () => {
  const [first, second] = [randomUUID(), randomUUID()];
  O.reserveRun({ key: first, staffId: 'test', kind: 'chat' });
  O.reserveRun({ key: second, staffId: 'test', kind: 'chat' });
  const h = await give('paige', 'Hang the lights', undefined, first);
  const thread = h.threadId ?? 0;
  await give('rex', 'Test the lights', thread, second);
  assert.deepEqual((await threadOf(thread)).runs, [first, second]);
  await answerLeadNow(thread, 'Warm white.');
  const [wake] = await onThread(thread, 'resume');
  O.runsGoing.delete(second);
  assert.equal(await listed(wake.id), false, 'the pick-up ran beside the first run');
  O.runsGoing.delete(first);
  assert.equal(await listed(wake.id), true);
});

/** A piece of work with its own lead and colleague, so no test leans on another's rows. */
async function ownWork(name: string, goalId?: number) {
  const [lead, colleague] = [`lead-${name}`, `colleague-${name}`];
  await db.insert(staff).values([odd(lead, `Lead ${name}`), odd(colleague, `Colleague ${name}`)]);
  const r = await H.handOff({
    from: lead,
    to: colleague,
    work: { title: `Step of ${name}`, brief: 'Do it.' },
    thread: { title: `Work on ${name}`, goalId }
  });
  assert.ok('id' in r, JSON.stringify(r));
  const h = await byId(r.id);
  return { lead, colleague, h, work: h.threadId ?? 0 };
}
async function parksOn(lead: string, work: number, task: number) {
  const parked = await P.parkOnTask(lead, work, task);
  assert.ok('title' in parked, JSON.stringify(parked));
}
/** The lead's run on `f`, which parks its work on `task` as it goes, as resume_at does, then ends done. */
async function runsAndParks(f: Row, task: number) {
  assert.ok(await O.startFollowUp(f.id), `follow-up ${f.id} could not start`);
  await parksOn(f.staffId, f.threadId ?? 0, task);
  await O.finishFollowUp(f, 'work', 'done', 'Parked it.');
}
// A task the lead gave, on no work: the one kind on no work it may park on (`parkOnTask`).
const aTask = (lead: string, title: string) =>
  O.giveTask(lead, { title, why: 'w', steps: ['Do it'] });

test('a failed wake leaves the task open, its checked steps intact, and its work parked', async () => {
  const work = await ownWork('failed-wake');
  const task = await aTask(work.lead, 'Confirm the route');
  await O.tickStep(task.id, 0);
  await parksOn(work.lead, work.work, task.id);
  await db.execute(
    sql`alter table follow_ups add constraint refuse_test_wake check (kind <> 'resume' or note not like '%Confirm the route%')`
  );
  try {
    await assert.rejects(O.finishTask(task.id, true, 'Use the north path.'));
    assert.equal((await O.task(task.id))?.status, 'open');
    assert.equal((await O.task(task.id))?.steps[0].done, true);
    assert.equal((await threadOf(work.work)).resumeOnTask, task.id);
    assert.deepEqual(await onThread(work.work, 'resume'), []);
    assert.equal(
      (await db.select().from(followUps).where(eq(followUps.taskId, task.id))).length,
      0
    );
  } finally {
    await db.execute(sql`alter table follow_ups drop constraint refuse_test_wake`);
  }
  const attempts = await Promise.all([
    O.finishTask(task.id, true, 'Use the north path.'),
    O.finishTask(task.id, true, 'Use the north path.')
  ]);
  assert.deepEqual(attempts.sort(), [false, true]);
  assert.equal((await onThread(work.work, 'resume')).length, 1);
  assert.equal((await O.task(task.id))?.note, 'Use the north path.');
});

test('finishing a task wakes the thread parked on it once, and a dropped task wakes it too and says so, each telling the work of the run its end starts for the Odd', async () => {
  const finished = await ownWork('finished');
  const proof = await aTask(finished.lead, 'Proof the banner');
  await parksOn(finished.lead, finished.work, proof.id);
  await O.finishTask(proof.id, true, null);
  await O.finishTask(proof.id, true, null);
  const woken = await onThread(finished.work, 'resume');
  assert.equal(woken.length, 1);
  assert.match(
    woken[0].note ?? '',
    /finished "Proof the banner", the task you parked this work on\. Another run of yours picks up from that task too and carries its own part: do only this work's here\. Pick it up now\.$/
  );
  assert.equal((await threadOf(finished.work)).resumeOnTask, null);

  const dropped = await ownWork('dropped');
  const print = await aTask(dropped.lead, 'Print\nthe banner');
  await parksOn(dropped.lead, dropped.work, print.id);
  await O.finishTask(print.id, false, 'Not needed\nany more.');
  // A drop on no work answers the Odd that gave the task with a run of its own.
  const answered = await db.select().from(followUps).where(eq(followUps.taskId, print.id));
  assert.deepEqual(
    answered.map((f) => [f.kind, f.staffId]),
    [['answered', dropped.lead]]
  );
  const told = await onThread(dropped.work, 'resume');
  assert.equal(told.length, 1);
  assert.match(
    told[0].note ?? '',
    /dropped "Print the banner", the task you parked this work on, so it will not be finished\. Another run of yours picks up from that task too and carries its own part: do only this work's here\. Decide what comes of the work now: Not needed any more\.$/
  );
  assert.equal((told[0].note ?? '').split('\n').length, 1, 'answers() splits a note on newlines');
  assert.equal((await threadOf(dropped.work)).resumeOnTask, null);

  // Work that ended another way while parked stays ended. An ended thread
  // keeps the park it had, as the owner's answer past the hand-off limit leaves it.
  const ended = await ownWork('ended');
  const frame = await aTask(ended.lead, 'Frame the banner');
  await parksOn(ended.lead, ended.work, frame.id);
  await db
    .update(threads)
    .set({ status: 'done', endedAt: new Date() })
    .where(eq(threads.id, ended.work));
  await O.finishTask(frame.id, true, null);
  assert.deepEqual(await onThread(ended.work, 'resume'), []);
});

/**
 * A goal's work parked on a task of its own, stopped by the owner's no to more
 * hand-offs, with every run on it ended, so only the park could still hold it.
 */
async function stoppedWhileParked(name: string) {
  const [goal] = await db
    .insert(goals)
    .values({ title: `Goal of ${name}` })
    .returning();
  const { lead, colleague, h, work } = await ownWork(name, goal.id);
  const task = await aTask(lead, `Task of ${name}`);
  await runs(h, 'done', 'Did it.');
  await runsAndParks((await onThread(work, 'handed_back'))[0], task.id);
  await db.update(threads).set({ handOffsUsed: T.HAND_OFF_LIMIT }).where(eq(threads.id, work));
  const more = await H.handOff({
    from: lead,
    to: colleague,
    work: { title: `More of ${name}`, brief: 'Do more.' },
    thread: { id: work }
  });
  assert.ok('asked' in more, JSON.stringify(more));
  await O.decideAsk(more.asked, 'deny', null);
  assert.equal((await threadOf(work)).status, 'stopped');
  // Read before the lead's pick-up, whose claim would end the park anyway.
  const parkAfterStop = (await threadOf(work)).resumeOnTask;
  await runs((await onThread(work, 'resume'))[0], 'done', 'Said where it stands.');
  return { lead, colleague, goalId: goal.id, work, task: task.id, parkAfterStop };
}
type Stopped = Awaited<ReturnType<typeof stoppedWhileParked>>;

/** A new plan for the goal, which is the one thing that opens stopped work again. */
async function planReopens({ lead, colleague, goalId, work }: Stopped) {
  const { ask } = await O.raiseAsk(lead, {
    kind: 'plan',
    title: `Plan for goal ${goalId}`,
    why: 'w',
    ifApproved: 'i',
    plan: { goalId, items: [{ kind: 'assign', staff: colleague, part: 'A part' }] }
  });
  assert.equal(ask.threadId, work);
  assert.equal((await threadOf(work)).endedAt, null);
  return ask;
}

/** The reopened work names no task it waits on, and can end once the plan is answered. */
async function notHeldByPark(stopped: Stopped, plan: { id: number }) {
  const { work } = stopped;
  assert.equal((await B.threadStory(await threadOf(work))).parkedOn, undefined);
  await O.decideAsk(plan.id, 'deny', null);
  const pickUp = (await onThread(work, 'resume')).find((f) => f.outcome === null);
  assert.ok(pickUp, "the owner's answer to the plan started no pick-up");
  await runs(pickUp, 'done', 'Closed the plan.');
  assert.equal((await threadOf(work)).status, 'done');
}

test('stopping work parked on a task stops it waiting on that task', async () => {
  const { parkAfterStop } = await stoppedWhileParked('stop-clears');
  assert.equal(parkAfterStop, null);
});

test('work reopened by a plan while its task is still open is not held by the park the owner stopped', async () => {
  const stopped = await stoppedWhileParked('planned-task-open');
  await notHeldByPark(stopped, await planReopens(stopped));
});

test('work reopened by a plan after its task ended is not held by the park the owner stopped', async () => {
  const stopped = await stoppedWhileParked('planned-task-ended');
  await O.finishTask(stopped.task, true, null);
  await notHeldByPark(stopped, await planReopens(stopped));
});

test("a task's end does not answer work that was stopped while parked on it", async () => {
  const stillStopped = await stoppedWhileParked('stays-stopped');
  const reopened = await stoppedWhileParked('reopened-before-task-ends');
  await planReopens(reopened);
  for (const { work, task } of [stillStopped, reopened]) {
    const before = await onThread(work, 'resume');
    await O.finishTask(task, true, null);
    assert.deepEqual(await onThread(work, 'resume'), before);
  }
});

test('a connect task the office drops wakes the work parked on it, and says it was dropped', async () => {
  const { lead, work } = await ownWork('connect');
  const [connect] = await db
    .insert(tasks)
    .values({
      staffId: lead,
      title: 'Connect the printer',
      why: 'w',
      steps: [
        {
          text: 'Paste the key',
          done: false,
          action: { kind: 'secret', connector: 'printer', name: 'key' }
        }
      ]
    })
    .returning();
  await parksOn(lead, work, connect.id);
  await O.reconfigureConnector('printer', {});
  const woken = await onThread(work, 'resume');
  assert.equal(woken.length, 1);
  assert.match(woken[0].note ?? '', /dropped "Connect the printer".+so it will not be finished/);
  assert.equal((await threadOf(work)).resumeOnTask, null);
});

test('a task its Odd takes off the desk wakes the work parked on it once, and says so', async () => {
  const { lead, work } = await ownWork('withdrawn');
  const task = await aTask(lead, 'Sign the form');
  await parksOn(lead, work, task.id);
  await O.withdrawTask(task.id, 'Not needed now.');
  await O.withdrawTask(task.id, 'Not needed now.');
  const woken = await onThread(work, 'resume');
  assert.equal(woken.length, 1);
  assert.match(
    woken[0].note ?? '',
    /^"Sign the form", the task you parked this work on, was taken off .+'s desk, so it will not be finished\. Decide what comes of the work now: Not needed now\.$/
  );
  assert.equal((await threadOf(work)).resumeOnTask, null);
});

/**
 * Work `hub` leads, with `parker` handed a step on it. `hub` gives a task on
 * that work, and `parker` parks work it leads elsewhere on that task, as an Odd
 * on the task's work may.
 */
async function parkedOnColleaguesTask(name: string) {
  const { lead: hub, colleague: parker, work } = await ownWork(name);
  const helper = `helper-${name}`;
  await db.insert(staff).values(odd(helper, `Helper ${name}`));
  const task = await O.giveTask(hub, {
    title: `Check the ${name} copy`,
    why: 'w',
    steps: ['Check it'],
    threadId: work
  });
  const r = await H.handOff({
    from: parker,
    to: helper,
    work: { title: `Layout of ${name}`, brief: 'Lay it out.' },
    thread: { title: `Layout run of ${name}` }
  });
  assert.ok('id' in r, JSON.stringify(r));
  const parked = (await byId(r.id)).threadId ?? 0;
  await parksOn(parker, parked, task.id);
  return { hub, parker, parked, task: task.id, owner: await O.ownerName() };
}

test("the task's Odd leaving takes the task off the desk: the work parked on it wakes once, told so, and is not left to the run of an Odd that left", async () => {
  const { hub, parked, owner } = await parkedOnColleaguesTask('hub-leaves');
  assert.equal(await L.removeOdd(hub), undefined);
  const woken = await onThread(parked, 'resume');
  assert.equal(woken.length, 1);
  assert.equal(
    woken[0].note,
    `"Check the hub-leaves copy", the task you parked this work on, was taken off ${owner}'s desk, so it will not be finished. Decide what comes of the work now: Lead hub-leaves left the office, so this will not go ahead.`
  );
  assert.equal((await threadOf(parked)).resumeOnTask, null);
});

test("an Odd that leaves stops the work it parked on another's task, and that task's end wakes nothing", async () => {
  const { parker, parked, task } = await parkedOnColleaguesTask('parker-leaves');
  assert.equal(await L.removeOdd(parker), undefined);
  const stopped = await threadOf(parked);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.resumeOnTask, null, "leaving ends the park, as the owner's stop does");
  await O.finishTask(task, true, null);
  assert.deepEqual(await onThread(parked, 'resume'), []);
});

test("a colleague's run leaves the lead's park, and a lead's run that parks again on the same task stays open and parked, and wakes once at the task's end", async () => {
  const { lead, h, work } = await ownWork('stays-open');
  const sign = await aTask(lead, 'Sign the banner');
  await parksOn(lead, work, sign.id);
  await runs(h, 'done', 'Drew it.');
  assert.equal((await threadOf(work)).resumeOnTask, sign.id, "a colleague's run lifts no park");
  const [back] = await onThread(work, 'handed_back');
  await runsAndParks(back, sign.id);
  const after = await threadOf(work);
  assert.equal(after.resumeOnTask, sign.id, 'a park made during the run outlives its claim');
  assert.equal(after.status, 'open');
  assert.equal(after.endedAt, null);
  await O.finishTask(sign.id, true, null);
  await O.finishTask(sign.id, true, null);
  assert.equal((await onThread(work, 'resume')).length, 1, 'the wake found it still open');
});

test("a parked thread's lead is told what it waits on", async () => {
  const { lead, work } = await ownWork('told');
  const check = await aTask(lead, 'Check the\nspelling');
  await parksOn(lead, work, check.id);
  const story = await B.threadStory(await threadOf(work));
  assert.ok(
    B.threadKnown({ story }).includes(
      'It is parked until {owner} finishes or drops "Check the spelling". You pick it up then.'
    )
  );
  assert.match(
    B.threadBrief({ story }).join('\n'),
    /resume_at after_task, when it waits on a task/
  );
  const card = (await T.threadsFor(lead)).find((t) => t.id === work);
  assert.equal(card?.parkedOn, 'Check the\nspelling');
  const row = (await T.goalThreads()).find((t) => t.id === work);
  assert.equal(row?.parkedOn, 'Check the\nspelling');

  const at = new Date(Date.now() + 3_600_000);
  assert.ok(await T.parkThread(lead, work, at), 'a time replaces the task');
  const timed = await threadOf(work);
  assert.equal(timed.resumeOnTask, null);
  assert.ok(
    B.threadKnown({ story: await B.threadStory(timed) }).some((l) =>
      l.startsWith('It picks back up at ')
    )
  );

  await parksOn(lead, work, check.id);
  assert.equal((await threadOf(work)).resumeAt, null, 'a task replaces the time');
});

/** The owner's words reaching `work`'s lead from its colleague's chat (`tellLead`): the lead's pick-up still to start. */
async function toldLead(colleague: string, work: number): Promise<Row> {
  const said = 'Go ahead without the signing.';
  const told = await T.tellLead({
    staffId: colleague,
    threadId: work,
    said,
    words: said,
    reading: 'Sam wants it done now.'
  });
  assert.ok('lead' in told, JSON.stringify(told));
  const pickUp = (await onThread(work, 'resume')).find((f) => f.startedAt === null);
  assert.ok(pickUp, "the owner's words started no pick-up");
  return pickUp;
}
const parkedLine = async (work: number) =>
  B.threadKnown({ story: await B.threadStory(await threadOf(work)) }).find((l) =>
    l.startsWith('It is parked until')
  );

test("work parked on a task that the owner's words pick up ends when that run ends done, waits on nothing, and the task's later end wakes nothing", async () => {
  const { lead, colleague, h, work } = await ownWork('go-ahead');
  const sign = await aTask(lead, 'Sign\nthe poster');
  await runs(h, 'done', 'Drew it.');
  await runsAndParks((await onThread(work, 'handed_back'))[0], sign.id);
  const goAhead = await toldLead(colleague, work);
  const claimed = await O.startFollowUp(goAhead.id);
  assert.deepEqual(claimed?.unparked, { task: 'Sign\nthe poster' });
  assert.equal(await parkedLine(work), undefined, 'the run is not told it is still parked');
  await O.finishFollowUp(goAhead, 'work', 'done', 'Went ahead.');
  const after = await threadOf(work);
  assert.equal(after.resumeOnTask, null);
  assert.equal(after.status, 'done');
  assert.notEqual(after.endedAt, null);
  const card = (await T.threadsFor(lead)).find((t) => t.id === work);
  assert.equal(card?.parkedOn, undefined);
  assert.equal(card?.stage, 'done');
  await O.finishTask(sign.id, false, null);
  assert.equal((await onThread(work, 'resume')).length, 1, "the task's end woke nothing");
});

test('a hand-back that picks up work parked on a task ends the park, and its claim names the wait it ended', async () => {
  const { lead, h, work } = await ownWork('hand-back');
  const sign = await aTask(lead, 'Sign the flyer');
  await parksOn(lead, work, sign.id);
  await runs(h, 'done', 'Drew it.');
  const [back] = await onThread(work, 'handed_back');
  assert.deepEqual((await O.startFollowUp(back.id))?.unparked, { task: 'Sign the flyer' });
  assert.equal((await threadOf(work)).resumeOnTask, null);
  assert.equal(await parkedLine(work), undefined);
});

test('work parked on a time that the owner picks up early is parked no more, so the clock never wakes it', async () => {
  const { lead, colleague, h, work } = await ownWork('early');
  await runs(h, 'done', 'Drew it.');
  const [back] = await onThread(work, 'handed_back');
  assert.ok(await O.startFollowUp(back.id));
  const at = new Date(Date.now() + 3_600_000);
  assert.ok(await T.parkThread(lead, work, at));
  await O.finishFollowUp(back, 'work', 'done', 'Parked it till later.');
  const early = await toldLead(colleague, work);
  const claimed = await O.startFollowUp(early.id);
  assert.equal(claimed?.unparked && 'at' in claimed.unparked && +claimed.unparked.at, +at);
  assert.equal((await threadOf(work)).resumeAt, null);
  assert.ok(!(await T.parkedThreads()).some((p) => p.id === work), 'the clock has no wake for it');
});

test("work the usage window holds stays held whatever picks it up: the hold is the office's, not the lead's", async () => {
  const { lead, colleague, work } = await ownWork('held');
  const { ask: hold } = await O.raiseAsk(lead, {
    title: 'Hold for the window',
    why: 'w',
    ifApproved: 'i'
  });
  const reset = new Date(Date.now() + 3_600_000);
  await db
    .update(threads)
    .set({ heldBy: hold.id, resumeAt: reset, resumeOnTask: null })
    .where(eq(threads.id, work));
  const pickUp = await toldLead(colleague, work);
  assert.equal((await O.startFollowUp(pickUp.id))?.unparked, undefined);
  const after = await threadOf(work);
  assert.equal(after.heldBy, hold.id);
  assert.equal(after.resumeAt?.getTime(), reset.getTime());
});

test("a pick-up that waits on the lead's run still going ends no park, so the park that run made stands", async () => {
  const { lead, colleague, h, work } = await ownWork('queued');
  const sign = await aTask(lead, 'Sign the menu');
  await runs(h, 'done', 'Drew it.');
  const [back] = await onThread(work, 'handed_back');
  assert.ok(await O.startFollowUp(back.id));
  await parksOn(lead, work, sign.id);
  const waiting = await toldLead(colleague, work);
  assert.equal(await O.startFollowUp(waiting.id), undefined, 'it waits for the run going');
  assert.equal((await threadOf(work)).resumeOnTask, sign.id);
  await O.finishFollowUp(back, 'work', 'done', 'Parked it.');
  assert.equal(
    (await threadOf(work)).resumeOnTask,
    sign.id,
    'a pick-up never started ends no park'
  );
});

test("a task's end that wakes parked work leaves its pick-up no wait to end", async () => {
  const { lead, work } = await ownWork('woken');
  const proof = await aTask(lead, 'Proof the menu');
  await parksOn(lead, work, proof.id);
  await O.finishTask(proof.id, true, null);
  const [woken] = await onThread(work, 'resume');
  const claimed = await O.startFollowUp(woken.id);
  assert.ok(claimed);
  assert.equal(claimed.unparked, undefined);
});

/**
 * Work parked on a task of `title`, whose lead's pick-up of a hand-back ended
 * the park as it started: that pick-up as listed, before its claim, still running.
 */
async function liftedPark(name: string, title: string) {
  const { lead, h, work } = await ownWork(name);
  const task = await aTask(lead, title);
  await parksOn(lead, work, task.id);
  await runs(h, 'done', 'Drew it.');
  const [back] = await onThread(work, 'handed_back');
  assert.deepEqual((await O.startFollowUp(back.id))?.unparked, { task: title });
  return { lead, work, task, back };
}
/** A run cut off as a sign-in lapse cuts one off. */
const fails = (f: Row) => O.finishFollowUp(f, 'work', 'failed', 'Claude Code is signed out.');

test('a lead run that ended a park on a task and then fails parks the work on that task again, and its end wakes it once', async () => {
  const { lead, work, task, back } = await liftedPark('fails-open', 'Sign the flyer');
  assert.equal((await threadOf(work)).resumeOnTask, null, 'the claim ended the park');
  await fails(back);
  const after = await threadOf(work);
  assert.equal(after.resumeOnTask, task.id);
  assert.equal(after.status, 'open');
  assert.equal(after.endedAt, null);
  const card = (await T.threadsFor(lead)).find((t) => t.id === work);
  // What the chat's card reads to say who picks it up and when (`workLine` in the office).
  assert.equal(card?.parkedOn, 'Sign the flyer');
  assert.equal(card?.stage, 'under_way');
  assert.equal(card?.holder, card?.hub);
  await O.finishTask(task.id, true, null);
  await O.finishTask(task.id, true, null);
  const woken = await onThread(work, 'resume');
  assert.equal(woken.length, 1);
  assert.match(
    woken[0].note ?? '',
    /finished "Sign the flyer", the task you parked this work on\./
  );
});

test('a lead run that ended a park on a task fails after the task was finished: the work wakes once, told it was finished and that its other run was set going back then', async () => {
  const { work, task, back } = await liftedPark('fails-finished', 'Proof the flyer');
  await O.finishTask(task.id, true, 'Looks right.');
  assert.deepEqual(await onThread(work, 'resume'), [], 'nothing was parked on it as it ended');
  await fails(back);
  const woken = await onThread(work, 'resume');
  assert.equal(woken.length, 1);
  assert.match(
    woken[0].note ?? '',
    /finished "Proof the flyer", the task you parked this work on\. Another run of yours was set going when the task ended and carries its own part: do only this work's part here\. Pick it up now: Looks right\.$/
  );
  const after = await threadOf(work);
  assert.equal(after.resumeOnTask, null);
  assert.equal(after.endedAt, null);
  await O.finishTask(task.id, true, null);
  assert.equal((await onThread(work, 'resume')).length, 1);
});

test('a lead run that ended a park on a task fails after the task was dropped: the work wakes once, told it was dropped and that its other run was set going back then', async () => {
  const { work, task, back } = await liftedPark('fails-dropped', 'Print the flyer');
  await O.finishTask(task.id, false, null);
  assert.deepEqual(
    (await db.select().from(followUps).where(eq(followUps.taskId, task.id))).map((f) => f.kind),
    ['answered']
  );
  await fails(back);
  const woken = await onThread(work, 'resume');
  assert.equal(woken.length, 1);
  assert.match(
    woken[0].note ?? '',
    /dropped "Print the flyer", the task you parked this work on, so it will not be finished\. Another run of yours was set going when the task ended and carries its own part: do only this work's part here\. Decide what comes of the work now\.$/
  );
  assert.equal((await threadOf(work)).resumeOnTask, null);
});

test('a failed run that gives back a park on a task that ended wakes the work in the same transaction', async () => {
  const { work, task, back } = await liftedPark('fails-wake-refused', 'Fold the flyer');
  await O.finishTask(task.id, true, null);
  // The wake's own write fails, wherever the code makes it. Written with the
  // run's end, it takes the end with it, so the run can end again; written
  // after, the run has ended and nothing wakes the work again.
  await db.execute(
    sql.raw(`create function refuse_wake() returns trigger language plpgsql as $$
      begin
        if new.thread_id = ${work} and new.kind = 'resume' then raise exception 'wake refused'; end if;
        return new;
      end $$`)
  );
  await db.execute(
    sql.raw(
      'create trigger refuse_wake before insert on follow_ups for each row execute function refuse_wake()'
    )
  );
  try {
    // The database's own error, which drizzle wraps as the cause of its own.
    await assert.rejects(fails(back), (err: Error) => /wake refused/.test(String(err.cause)));
  } finally {
    await db.execute(sql.raw('drop trigger refuse_wake on follow_ups'));
    await db.execute(sql.raw('drop function refuse_wake()'));
  }
  assert.equal((await byId(back.id)).outcome, null, 'the run did not end without its wake');
  assert.equal(await fails(back), true);
  assert.equal((await onThread(work, 'resume')).length, 1);
});

test('a lead run that ended a park on a task and ends waiting on the owner leaves the park ended, so the task wakes nothing', async () => {
  const { lead, work, task, back } = await liftedPark('waits', 'Sign the leaflet');
  // What the run waits on, which brings its lead back once the owner answers.
  await O.raiseAsk(lead, { title: 'Which leaflet?', why: 'w', ifApproved: 'i', threadId: work });
  await O.finishFollowUp(back, 'work', 'waiting', 'Asked which leaflet first.');
  const after = await threadOf(work);
  assert.equal(after.resumeOnTask, null);
  assert.equal(after.endedAt, null);
  await O.finishTask(task.id, true, null);
  assert.deepEqual(await onThread(work, 'resume'), [], "the task's end woke nothing");
});

test("a colleague's run claimed on parked work that fails after its lead's run ended the park gives nothing back", async () => {
  const { lead, colleague, h, work } = await ownWork('colleague-fails');
  const task = await aTask(lead, 'Sign the brochure');
  await parksOn(lead, work, task.id);
  assert.ok(await O.startFollowUp(h.id));
  const goAhead = await toldLead(colleague, work);
  assert.deepEqual((await O.startFollowUp(goAhead.id))?.unparked, { task: 'Sign the brochure' });
  await O.finishFollowUp(goAhead, 'work', 'done', 'Went ahead.');
  await fails(h);
  const after = await threadOf(work);
  assert.equal(after.resumeOnTask, null, 'the park its lead ended stays ended');
  assert.equal(after.endedAt, null);
  await O.finishTask(task.id, true, null);
  assert.equal((await onThread(work, 'resume')).length, 1, "the task's end woke nothing");
});

test('a lead run that ended a park and parked again before it failed keeps the park it made, on another task or a time', async () => {
  const onTask = await liftedPark('fails-reparked', 'Sign the menu');
  const other = await aTask(onTask.lead, 'Price the menu');
  await parksOn(onTask.lead, onTask.work, other.id);
  await fails(onTask.back);
  assert.equal((await threadOf(onTask.work)).resumeOnTask, other.id);

  const onTime = await liftedPark('fails-retimed', 'Sign the card');
  const at = new Date(Date.now() + 3_600_000);
  assert.ok(await T.parkThread(onTime.lead, onTime.work, at));
  await fails(onTime.back);
  const timed = await threadOf(onTime.work);
  assert.equal(timed.resumeOnTask, null);
  assert.equal(timed.resumeAt?.getTime(), at.getTime());
});

test('a lead run that ended a park on a task fails after the owner stopped the work: it stays stopped, parked on nothing', async () => {
  const { work, back } = await liftedPark('fails-stopped', 'Sign the poster');
  // As the owner's no to more hand-offs stops it (`answerHandOffs`).
  await db
    .update(threads)
    .set({ status: 'stopped', endedAt: new Date() })
    .where(eq(threads.id, work));
  await fails(back);
  const after = await threadOf(work);
  assert.equal(after.status, 'stopped');
  assert.equal(after.resumeOnTask, null);
});

test('a lead run that ended a park on a task fails after its lead left the office: no park comes back and nothing wakes', async () => {
  const { lead, work, back } = await liftedPark('lead-leaves-mid-run', 'Sign the sticker');
  assert.equal(await L.removeOdd(lead), undefined);
  // As the office's stop of the run going (`whenOddLeaves`) ends it.
  await fails(back);
  const after = await threadOf(work);
  assert.equal(after.status, 'stopped');
  assert.equal(after.resumeOnTask, null, 'no park comes back on work its lead left');
  assert.deepEqual(await onThread(work, 'resume'), []);
});

/**
 * `parkedOnColleaguesTask`, with the parker's pick-up of its helper's result
 * ending the park as it started: that pick-up as listed, still running.
 */
async function liftedColleaguesPark(name: string) {
  const parked = await parkedOnColleaguesTask(name);
  const [step] = await onThread(parked.parked, 'hand_off');
  await runs(step, 'done', 'Laid it out.');
  const [back] = await onThread(parked.parked, 'handed_back');
  assert.deepEqual((await O.startFollowUp(back.id))?.unparked, { task: `Check the ${name} copy` });
  return { ...parked, back };
}

test("a lead run that ended a park on another Odd's task fails after that Odd left the office: the work wakes once, told the task was taken off the desk, never that the owner dropped it", async () => {
  const { hub, parked, back, owner } = await liftedColleaguesPark('hub-leaves-mid-run');
  assert.equal(await L.removeOdd(hub), undefined);
  assert.deepEqual(await onThread(parked, 'resume'), [], 'nothing was parked on it as it ended');
  await fails(back);
  const woken = await onThread(parked, 'resume');
  assert.equal(woken.length, 1);
  assert.equal(
    woken[0].note,
    `"Check the hub-leaves-mid-run copy", the task you parked this work on, was taken off ${owner}'s desk, so it will not be finished. Decide what comes of the work now: Lead hub-leaves-mid-run left the office, so this will not go ahead.`
  );
  assert.equal((await threadOf(parked)).resumeOnTask, null);
});

test("a lead run that ended a park on another Odd's task fails after that Odd left and was brought back: the work is still told the task was taken off the desk, and that no run carries the Odd's stopped work", async () => {
  const { hub, parked, back, owner } = await liftedColleaguesPark('hub-back-mid-run');
  assert.equal(await L.removeOdd(hub), undefined);
  // Back before the run fails: nothing about the Odd says it ever left.
  assert.equal(await L.bringBack(hub), undefined);
  await fails(back);
  const woken = await onThread(parked, 'resume');
  assert.equal(woken.length, 1);
  assert.equal(
    woken[0].note,
    `"Check the hub-back-mid-run copy", the task you parked this work on, was taken off ${owner}'s desk, so it will not be finished. Decide what comes of the work now: Lead hub-back-mid-run left the office, so this will not go ahead.`
  );
  assert.equal((await threadOf(parked)).resumeOnTask, null);
});

test("a lead run that ended a park on another Odd's task fails after that Odd took it off the desk itself: the work is told so, never that the owner dropped it", async () => {
  const { parked, back, task, owner } = await liftedColleaguesPark('hub-withdraws-mid-run');
  await O.withdrawTask(task, 'Not needed now.');
  await fails(back);
  const woken = await onThread(parked, 'resume');
  assert.equal(woken.length, 1);
  assert.equal(
    woken[0].note,
    `"Check the hub-withdraws-mid-run copy", the task you parked this work on, was taken off ${owner}'s desk, so it will not be finished. A run on "Work on hub-withdraws-mid-run", the work that task was given on, was set going when the task ended, and its lead carries that work's own part: do only this work's part here. Decide what comes of the work now: Not needed now.`
  );
});

test("a lead run that ended a park on another Odd's task fails after the owner dropped it: the work is told it was dropped, even when that Odd left after the drop", async () => {
  const plain = await liftedColleaguesPark('dropped-mid-run');
  await O.finishTask(plain.task, false, 'Not this week.');
  await fails(plain.back);
  const told = await onThread(plain.parked, 'resume');
  assert.equal(told.length, 1);
  assert.equal(
    told[0].note,
    `${plain.owner} dropped "Check the dropped-mid-run copy", the task you parked this work on, so it will not be finished. A run on "Work on dropped-mid-run", the work that task was given on, was set going when the task ended, and its lead carries that work's own part: do only this work's part here. Decide what comes of the work now: Not this week.`
  );

  const thenLeft = await liftedColleaguesPark('dropped-then-left');
  await O.finishTask(thenLeft.task, false, 'Not this week.');
  const [ended] = await db.select().from(tasks).where(eq(tasks.id, thenLeft.task));
  // The Odd leaves strictly after the drop, as two actions of the owner's do.
  while (Date.now() <= (ended.doneAt?.getTime() ?? 0)) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await L.removeOdd(thenLeft.hub), undefined);
  await fails(thenLeft.back);
  const heard = await onThread(thenLeft.parked, 'resume');
  assert.equal(heard.length, 1);
  // No run on the task's own work is named: its lead left, so it runs nothing.
  assert.equal(
    heard[0].note,
    `${thenLeft.owner} dropped "Check the dropped-then-left copy", the task you parked this work on, so it will not be finished. Decide what comes of the work now: Not this week.`
  );
});

test('an Odd that leaves while its work is parked on its own task wakes nothing: taking that task off the desk finds no park', async () => {
  const { lead, work } = await ownWork('own-task-leaves');
  const task = await aTask(lead, 'Sign the badge');
  await parksOn(lead, work, task.id);
  assert.equal(await L.removeOdd(lead), undefined);
  const [withdrawn] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(withdrawn.status, 'dropped', 'leaving took the task off the desk');
  assert.deepEqual(await onThread(work, 'resume'), [], 'no wake for an Odd that left');
  assert.equal(
    (await threadOf(work)).resumeOnTask,
    null,
    "leaving ends the park, as the owner's stop does"
  );
});

test('work its lead parked until a time, and then left the office, is never woken by the clock', async () => {
  const { lead, work } = await ownWork('time-leaves');
  assert.ok(await T.parkThread(lead, work, new Date(Date.now() + 3_600_000)));
  assert.equal(await L.removeOdd(lead), undefined);
  // The time comes after the Odd left.
  await db
    .update(threads)
    .set({ resumeAt: new Date(Date.now() - 1000) })
    .where(eq(threads.id, work));
  assert.ok(!(await T.parkedThreads()).some((p) => p.id === work), 'the clock finds nothing due');
  await T.wakeThread(work);
  assert.deepEqual(await onThread(work, 'resume'), []);
});

test("a lead that leaves takes its work out of the usage window's hold, so at the reset only the other work it held wakes, and the wake leaves the ask to the clock", async () => {
  const gone = await ownWork('held-lead-leaves');
  const stays = await ownWork('held-lead-stays');
  const { ask: hold } = await O.raiseAsk(stays.lead, {
    title: 'Hold both for the window',
    why: 'w',
    ifApproved: 'i'
  });
  const reset = new Date(Date.now() + 3_600_000);
  for (const work of [gone.work, stays.work])
    await db.update(threads).set({ heldBy: hold.id, resumeAt: reset }).where(eq(threads.id, work));
  assert.equal(await L.removeOdd(gone.lead), undefined);
  const stopped = await threadOf(gone.work);
  assert.equal(stopped.heldBy, null, 'nothing holds work its lead left');
  assert.equal(stopped.resumeAt, null, 'nothing wakes it at the reset');
  // The window resets.
  await db
    .update(threads)
    .set({ resumeAt: new Date(Date.now() - 1000) })
    .where(eq(threads.id, stays.work));
  await T.wakeThread(stays.work);
  const [ask] = await db.select().from(asks).where(eq(asks.id, hold.id));
  assert.equal(ask.status, 'open', 'the office clock takes the ask off the desk, not the wake');
  assert.equal((await onThread(stays.work, 'resume')).length, 1);
  assert.deepEqual(await onThread(gone.work, 'resume'), []);
});

/** Every report an Odd ever put on the desk, read or not. */
const reportsOf = (staffId: string) =>
  db.select().from(reports).where(eq(reports.staffId, staffId));

test('a lead that leaves with a task open on its own work is woken by nothing, and no report says it could not pick the work back up, even once it is back', async () => {
  const { lead, work } = await ownWork('leaves-with-own-task');
  await O.giveTask(lead, { title: 'Sign the lease', why: 'w', steps: ['Sign it'], threadId: work });
  assert.equal(await L.removeOdd(lead), undefined);
  assert.deepEqual(await onThread(work, 'resume'), [], 'nothing wakes a lead that left');
  assert.deepEqual(await reportsOf(lead), []);
  assert.equal(await L.bringBack(lead), undefined);
  assert.deepEqual(
    (await O.desk()).reports.filter((r) => r.staffId === lead),
    []
  );
  const toEnd = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.staffId, lead), isNull(followUps.outcome)));
  assert.deepEqual(toEnd, [], 'nothing runs on the work it left');
});

test('a pick-up still to start when its lead leaves ends failed, with no report on the desk', async () => {
  const { lead, work } = await ownWork('leaves-with-pick-up');
  await answerLeadNow(work, 'Use blue.');
  assert.equal(await L.removeOdd(lead), undefined);
  const [pickUp] = await onThread(work, 'resume');
  assert.equal(pickUp.outcome, 'failed');
  assert.deepEqual(await reportsOf(lead), []);
});

/** What the owner hears of a colleague's result that no lead takes: its pokes, and its Ledger lines. */
async function heardOf(colleague: string) {
  const poked = await db.select().from(pokes).where(eq(pokes.staffId, colleague));
  const lines = await db.select().from(ledger).where(eq(ledger.actor, colleague));
  return { poked, lines };
}

test('a colleague that finishes after its lead left hands nothing back: it pokes the owner, the Ledger says nothing picks the work up, and the desk gets nothing', async () => {
  const { lead, colleague, h, work } = await ownWork('lead-leaves-mid-step');
  assert.ok(await O.startFollowUp(h.id));
  assert.equal(await L.removeOdd(lead), undefined);
  const before = await deskItems();
  await O.finishFollowUp(h, 'Step of lead-leaves-mid-step', 'done', 'Drew it.');
  assert.deepEqual(await onThread(work, 'handed_back'), [], 'nothing waits on a lead that left');
  assert.equal(await deskItems(), before);
  const { poked, lines } = await heardOf(colleague);
  assert.equal(poked.length, 1);
  assert.equal(
    poked[0].message,
    'Colleague lead-leaves-mid-step finished "Step of lead-leaves-mid-step", but could not hand it back to Lead lead-leaves-mid-step because Lead lead-leaves-mid-step is no longer here.'
  );
  assert.equal(poked[0].status, 'waiting');
  assert.ok(poked[0].at <= new Date(), 'it goes now');
  const line = lines.find((l) => l.title.startsWith('Finished, but Lead lead-leaves-mid-step'));
  assert.ok(line, lines.map((l) => l.title).join('\n'));
  assert.match(
    line.body ?? '',
    /nothing picks the work up\. What .+ did stays in the work's folder\./
  );
  ownerWords(line.title, line.body, poked[0].message);
});

test('a step that starts after its lead left, and fails, hands nothing back, and the colleague says it could not finish', async () => {
  const { lead, colleague, h, work } = await ownWork('lead-left-before-step');
  assert.equal(await L.removeOdd(lead), undefined);
  await runs(h, 'failed', 'The ink ran out.');
  assert.deepEqual(await onThread(work, 'handed_back'), []);
  assert.deepEqual(await reportsOf(colleague), [], 'the poke tells the owner, not the desk');
  const { poked } = await heardOf(colleague);
  assert.deepEqual(
    poked.map((p) => p.message),
    [
      'Colleague lead-left-before-step could not finish "Step of lead-left-before-step", and could not hand it back to Lead lead-left-before-step because Lead lead-left-before-step is no longer here.'
    ]
  );
});

test('a result waiting for its lead when the lead leaves ends there: the colleague pokes the owner, and no report says the lead could not pick it up', async () => {
  const { lead, colleague, h, work } = await ownWork('lead-leaves-with-result');
  await runs(h, 'done', 'Drew it.');
  const [back] = await onThread(work, 'handed_back');
  assert.equal(back.startedAt, null);
  assert.equal(await L.removeOdd(lead), undefined);
  assert.equal((await byId(back.id)).outcome, 'failed');
  assert.deepEqual(await reportsOf(lead), []);
  const { poked } = await heardOf(colleague);
  assert.deepEqual(
    poked.map((p) => p.message),
    [
      'Colleague lead-leaves-with-result finished "Step of lead-leaves-with-result", but could not hand it back to Lead lead-leaves-with-result because Lead lead-leaves-with-result is no longer here.'
    ]
  );
});

test("the owner's answer to what a colleague raised goes back to no lead that left, and leaves nothing waiting", async () => {
  const { lead, h, work } = await ownWork('lead-leaves-before-answer');
  const ask = await raises(h, 'Which ink?');
  await runs(h, 'waiting', 'Asked which ink.');
  const [waiting] = await onThread(work, 'handed_back');
  await runs(waiting, 'done', 'Waited.');
  assert.equal(await L.removeOdd(lead), undefined);
  await O.decideAsk(ask.id, 'deny', 'No ink this week.');
  const open = (await onThread(work, 'handed_back')).filter((f) => f.outcome === null);
  assert.deepEqual(open, [], 'no result waits on a lead that left');
});

test('a lead run that ended no park and fails ends the work failed, parked on nothing', async () => {
  const { h, work } = await ownWork('fails-unparked');
  await runs(h, 'done', 'Drew it.');
  const [back] = await onThread(work, 'handed_back');
  assert.equal((await O.startFollowUp(back.id))?.unparkedTask, null);
  await fails(back);
  const after = await threadOf(work);
  assert.equal(after.status, 'failed');
  assert.equal(after.resumeOnTask, null);
});

test('a lead run on work the usage window holds that fails leaves the hold as it was and parks on no task', async () => {
  const { lead, colleague, work } = await ownWork('fails-held');
  const { ask: hold } = await O.raiseAsk(lead, {
    title: 'Hold the failed run for the window',
    why: 'w',
    ifApproved: 'i'
  });
  const reset = new Date(Date.now() + 3_600_000);
  await db
    .update(threads)
    .set({ heldBy: hold.id, resumeAt: reset, resumeOnTask: null })
    .where(eq(threads.id, work));
  const pickUp = await toldLead(colleague, work);
  const claimed = await O.startFollowUp(pickUp.id);
  assert.equal(claimed?.unparkedAt, null, 'the hold is not a time the run lifted');
  await fails(pickUp);
  const after = await threadOf(work);
  assert.equal(after.heldBy, hold.id);
  assert.equal(after.resumeAt?.getTime(), reset.getTime());
  assert.equal(after.resumeOnTask, null);
  assert.equal(after.status, 'open');
});

/**
 * Work its lead parked until `at`, whose lead's pick-up of the owner's words
 * ended the park as it started: that pick-up as listed, before its claim, still running.
 */
async function liftedTime(name: string, at: Date) {
  const { lead, colleague, h, work } = await ownWork(name);
  await runs(h, 'done', 'Drew it.');
  const [back] = await onThread(work, 'handed_back');
  assert.ok(await O.startFollowUp(back.id));
  assert.ok(await T.parkThread(lead, work, at));
  await O.finishFollowUp(back, 'work', 'done', 'Parked it till later.');
  const early = await toldLead(colleague, work);
  const claimed = await O.startFollowUp(early.id);
  assert.equal(claimed?.unparked && 'at' in claimed.unparked && +claimed.unparked.at, +at);
  assert.equal((await threadOf(work)).resumeAt, null, 'the claim ended the park');
  return { lead, work, early };
}

test('a lead run that ended a park on a time still to come and then fails parks the work until that time again', async () => {
  const at = new Date(Date.now() + 3_600_000);
  const { lead, work, early } = await liftedTime('fails-timed', at);
  await fails(early);
  const after = await threadOf(work);
  assert.equal(after.resumeAt?.getTime(), at.getTime());
  assert.equal(after.resumeOnTask, null);
  assert.equal(after.heldBy, null);
  assert.equal(after.status, 'open');
  const parked = (await T.parkedThreads()).find((p) => p.id === work);
  assert.equal(parked?.resumeAt.getTime(), at.getTime(), 'the clock wakes it at that time');
  // What the chat's card reads to say when its lead picks it up (`workLine` in the office).
  const card = (await T.threadsFor(lead)).find((t) => t.id === work);
  assert.equal(card?.resumeAt?.getTime(), at.getTime());
  const waking = (await onThread(work, 'resume')).filter((f) => f.startedAt === null);
  assert.deepEqual(waking, [], 'nothing wakes it before then');
});

test('a lead run that ended a park on a time that passed while it ran, then fails, leaves the work for the clock to wake once', async () => {
  const at = new Date(Date.now() + 200);
  const { work, early } = await liftedTime('fails-time-passed', at);
  while (Date.now() <= at.getTime()) await new Promise((r) => setTimeout(r, 20));
  const before = (await onThread(work, 'resume')).length;
  await fails(early);
  assert.equal((await onThread(work, 'resume')).length, before, 'the failure itself wakes nothing');
  const due = (await T.parkedThreads()).find((p) => p.id === work);
  assert.ok(due && due.resumeAt <= new Date(), 'the clock finds it due');
  // Two looks of the clock at once, as a change to threads and its timer can bring.
  await Promise.all([T.wakeThread(work), T.wakeThread(work)]);
  const woken = await onThread(work, 'resume');
  assert.equal(woken.length, before + 1);
  assert.equal(woken.at(-1)?.startedAt, null);
  assert.equal((await threadOf(work)).resumeAt, null);
  assert.ok(!(await T.parkedThreads()).some((p) => p.id === work), 'nothing is left to wake');
});

test('a lead run that ended a park on a time and parked again before it failed keeps the park it made, on another time or a task', async () => {
  const later = new Date(Date.now() + 7_200_000);
  const onTime = await liftedTime('timed-retimed', new Date(Date.now() + 3_600_000));
  assert.ok(await T.parkThread(onTime.lead, onTime.work, later));
  await fails(onTime.early);
  assert.equal((await threadOf(onTime.work)).resumeAt?.getTime(), later.getTime());

  const onTask = await liftedTime('timed-retasked', new Date(Date.now() + 3_600_000));
  const task = await aTask(onTask.lead, 'Sign the timetable');
  await parksOn(onTask.lead, onTask.work, task.id);
  await fails(onTask.early);
  const tasked = await threadOf(onTask.work);
  assert.equal(tasked.resumeOnTask, task.id);
  assert.equal(tasked.resumeAt, null);
});

/**
 * A lead's own work with a task given on it, and, unless `parked` is false, a
 * second piece of work of the same lead parked on that task, as in the run
 * where both picked up at once and did the parked work twice.
 */
async function taskOnOwnWork(name: string, parked = true) {
  const { lead, colleague, work } = await ownWork(name);
  const task = await O.giveTask(lead, {
    title: `Approve\nthe ${name} copy`,
    why: 'w',
    steps: ['Approve it'],
    threadId: work
  });
  const other = parked
    ? await H.handOff({
        from: lead,
        to: colleague,
        work: { title: `Print of ${name}`, brief: 'Print it.' },
        thread: { title: `Print\nrun of ${name}` }
      })
    : undefined;
  const otherWork = other && 'id' in other ? ((await byId(other.id)).threadId ?? 0) : undefined;
  if (otherWork) await parksOn(lead, otherWork, task.id);
  return { work, otherWork, task: task.id, owner: await O.ownerName() };
}

test('a finished task tells its own work which parked work picked up, so the lead leaves it to that work', async () => {
  const { work, otherWork, task } = await taskOnOwnWork('told-own');
  await O.finishTask(task, true, 'Looks right.\nShip it.');
  const [done] = await onThread(work, 'task_done');
  assert.deepEqual(done.pickedUp, ['Print\nrun of told-own']);
  assert.equal(done.note, 'Looks right.\nShip it.', "the note stays the owner's words alone");
  const [woken] = await onThread(otherWork ?? 0, 'resume');
  assert.match(
    woken.note ?? '',
    /"Work on told-own", the work that task was given on, picks up too, and its lead carries that work's own part: do only this work's here\. Pick it up now: Looks right\. Ship it\.$/
  );
});

test('a finished task with nothing parked on it gives its own work the note alone', async () => {
  const { work, task } = await taskOnOwnWork('alone', false);
  await O.finishTask(task, true, 'Looks right.\nShip it.');
  const [done] = await onThread(work, 'task_done');
  assert.equal(done.pickedUp, null);
  assert.equal(done.note, 'Looks right.\nShip it.');
});

test('a dropped task tells its own work which parked work picked up, and the parked work hears of its own', async () => {
  const { work, otherWork, task, owner } = await taskOnOwnWork('dropped-own');
  await O.finishTask(task, false, 'Not needed.');
  const [answer] = await onThread(work, 'resume');
  assert.equal(
    answer.note,
    `${owner} dropped "Approve\nthe dropped-own copy": Not needed. "Print run of dropped-own" was waiting on this too and has picked up on its own; leave that work to it.`
  );
  const [woken] = await onThread(otherWork ?? 0, 'resume');
  assert.match(woken.note ?? '', /"Work on dropped-own", the work that task was given on/);

  const lone = await taskOnOwnWork('dropped-alone', false);
  await O.finishTask(lone.task, false, 'Not needed.');
  const [alone] = await onThread(lone.work, 'resume');
  assert.equal(alone.note, `${owner} dropped "Approve\nthe dropped-alone copy": Not needed.`);
});

test('a lead run that ended a park on a task given on other work fails after the task was finished: the work hears a run on that work was set going back then', async () => {
  const { work, otherWork = 0, task } = await taskOnOwnWork('fails-own');
  const [h] = await onThread(otherWork, 'hand_off');
  await runs(h, 'done', 'Printed a proof.');
  const [back] = await onThread(otherWork, 'handed_back');
  assert.deepEqual((await O.startFollowUp(back.id))?.unparked, {
    task: 'Approve\nthe fails-own copy'
  });
  await O.finishTask(task, true, null);
  const [done] = await onThread(work, 'task_done');
  assert.equal(done.pickedUp, null, 'the park was lifted, so that run was told of no parked work');
  await fails(back);
  const woken = await onThread(otherWork, 'resume');
  assert.equal(woken.length, 1);
  assert.match(
    woken[0].note ?? '',
    /the task you parked this work on\. A run on "Work on fails-own", the work that task was given on, was set going when the task ended, and its lead carries that work's own part: do only this work's part here\. Pick it up now\.$/
  );
});

/**
 * A lead's access ask, raised on its own work or, with `onWork` false, from a
 * chat, approved, so its connect task is on the desk; and, unless `parked` is
 * false, a second piece of the lead's work parked on that connect task.
 */
async function connectWithParked(name: string, { onWork = true, parked = true } = {}) {
  const { lead, colleague, work } = await ownWork(name);
  const { ask } = await O.raiseAsk(lead, {
    title: `Connect Gmail for ${name}`,
    why: 'w',
    ifApproved: 'i',
    access: { connector: 'gmail', level: 'read' },
    threadId: onWork ? work : undefined
  });
  await O.decideAsk(ask.id, 'approve', null);
  const [connect] = await db.select().from(tasks).where(eq(tasks.askId, ask.id));
  assert.ok(connect, 'the yes made no connect task');
  const other = parked
    ? await H.handOff({
        from: lead,
        to: colleague,
        work: { title: `Mail of ${name}`, brief: 'Sort it.' },
        thread: { title: `Inbox of ${name}` }
      })
    : undefined;
  const otherWork = other && 'id' in other ? ((await byId(other.id)).threadId ?? 0) : undefined;
  if (otherWork) await parksOn(lead, otherWork, connect.id);
  return { lead, work, otherWork, ask: ask.id, connect: connect.id };
}
const carryOuts = (askId: number) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.askId, askId), eq(followUps.kind, 'carry_out')));

test("a connect task's end tells the carry-out on the ask's work which parked work picked up, and tells that work the ask's work picks up too", async () => {
  const { work, otherWork, ask, connect } = await connectWithParked('carry-on-work');
  await O.finishTask(connect, true, null);
  const [carry] = await carryOuts(ask);
  assert.equal(carry.threadId, work);
  assert.deepEqual(carry.pickedUp, ['Inbox of carry-on-work']);
  const [woken] = await onThread(otherWork ?? 0, 'resume');
  assert.match(
    woken.note ?? '',
    /"Work on carry-on-work", the work that task was given on, picks up too, and its lead carries that work's own part: do only this work's here\. Pick it up now\.$/
  );
});

test('a connect task for an ask raised in a chat tells its carry-out which parked work picked up, and tells that work another run of its own carries the access work', async () => {
  const { otherWork, ask, connect } = await connectWithParked('carry-from-chat', {
    onWork: false
  });
  await O.finishTask(connect, true, null);
  const [carry] = await carryOuts(ask);
  assert.equal(carry.threadId, null);
  assert.deepEqual(carry.pickedUp, ['Inbox of carry-from-chat']);
  const [woken] = await onThread(otherWork ?? 0, 'resume');
  assert.match(
    woken.note ?? '',
    /the task you parked this work on\. Another run of yours picks up from that task too and carries its own part: do only this work's here\. Pick it up now\.$/
  );
});

test('a connect task with nothing parked on it starts its carry-out with nothing picked up', async () => {
  const { ask, connect } = await connectWithParked('carry-alone', { parked: false });
  await O.finishTask(connect, true, null);
  const [carry] = await carryOuts(ask);
  assert.equal(carry.pickedUp, null);
});

test('a dropped connect task for an ask raised in a chat answers its Odd with a run of its own, and the work parked on it hears of that run', async () => {
  const { otherWork, connect } = await connectWithParked('carry-dropped', { onWork: false });
  await O.finishTask(connect, false, null);
  assert.deepEqual(
    (await db.select().from(followUps).where(eq(followUps.taskId, connect))).map((f) => f.kind),
    ['answered']
  );
  const [woken] = await onThread(otherWork ?? 0, 'resume');
  assert.match(
    woken.note ?? '',
    /dropped "Connect Gmail .+", the task you parked this work on, so it will not be finished\. Another run of yours picks up from that task too and carries its own part: do only this work's here\. Decide what comes of the work now\.$/
  );
});

test("a dropped task given on a hand-off answers the lead that handed the work, and the work its Odd parked on it hears that the hand-off's work picks up", async () => {
  const { lead, colleague, h } = await ownWork('dropped-hand-off');
  const task = await O.giveTask(colleague, {
    title: 'Check the hall',
    why: 'w',
    steps: ['Do it'],
    handOffId: h.id,
    threadId: h.threadId ?? undefined
  });
  const own = await H.handOff({
    from: colleague,
    to: lead,
    work: { title: 'Hall of dropped-hand-off', brief: 'Book it.' },
    thread: { title: 'Venue of dropped-hand-off' }
  });
  assert.ok('id' in own, JSON.stringify(own));
  const parked = (await byId(own.id)).threadId ?? 0;
  await parksOn(colleague, parked, task.id);
  await O.finishTask(task.id, false, 'Not needed.');
  assert.deepEqual(
    (await onThread(h.threadId ?? 0, 'handed_back')).map((f) => f.staffId),
    [lead]
  );
  assert.deepEqual(await db.select().from(followUps).where(eq(followUps.taskId, task.id)), []);
  const [woken] = await onThread(parked, 'resume');
  assert.match(
    woken.note ?? '',
    /dropped "Check the hall", the task you parked this work on, so it will not be finished\. "Work on dropped-hand-off", the work that task was given on, picks up too, and its lead carries that work's own part: do only this work's here\. Decide what comes of the work now: Not needed\.$/
  );
});

test("work parks only on a task its lead gave or a task on work it is on, and another Odd's task reads as no task at all", async () => {
  const { lead, work } = await ownWork('park-reach');
  const other = 'other-lead-park-reach';
  await db.insert(staff).values(odd(other, 'Other lead'));
  // The lead works on the other lead's work, so a task there is one it can see.
  const handed = await H.handOff({
    from: other,
    to: lead,
    work: { title: 'Help with the stall', brief: 'Help.' },
    thread: { title: 'The stall' }
  });
  assert.ok('id' in handed, JSON.stringify(handed));
  const stall = (await byId(handed.id)).threadId ?? 0;
  const onTheirWork = await O.giveTask(other, {
    title: 'Book the stall',
    why: 'w',
    steps: ['Book it'],
    threadId: stall
  });
  await parksOn(lead, work, onTheirWork.id);

  const theirs = await O.giveTask('rex', { title: 'Rex private errand', why: 'w', steps: ['Go'] });
  const theirsDone = await O.giveTask('rex', { title: 'Rex done errand', why: 'w', steps: ['Go'] });
  await O.finishTask(theirsDone.id, true, null);
  const elsewhere = await ownWork('park-elsewhere');
  const onOtherWork = await O.giveTask(elsewhere.lead, {
    title: 'Sign the elsewhere copy',
    why: 'w',
    steps: ['Sign it'],
    threadId: elsewhere.work
  });
  for (const id of [theirs.id, theirsDone.id, onOtherWork.id])
    assert.deepEqual(await P.parkOnTask(lead, work, id), { problem: `There is no task ${id}.` });
  assert.equal((await threadOf(work)).resumeOnTask, onTheirWork.id, 'a refusal left the park');

  await O.finishTask(theirs.id, true, 'SENTINEL only for Rex');
  assert.ok(
    !(await onThread(work, 'resume')).some((f) => f.note?.includes('SENTINEL')),
    "the other Odd's note reached the work"
  );

  const own = await aTask(lead, 'Own finished errand');
  await O.finishTask(own.id, true, null);
  assert.deepEqual(await P.parkOnTask(lead, work, own.id), {
    problem: 'Already finished: do it now, in this run.'
  });
});

test('work that has ended cannot be parked on a task', async () => {
  const { lead, work } = await ownWork('park-ended');
  const task = await aTask(lead, 'Proof the ended copy');
  await db.update(threads).set({ status: 'done', endedAt: new Date() }).where(eq(threads.id, work));
  assert.deepEqual(await P.parkOnTask(lead, work, task.id), {
    problem: `Work ${work} has ended, or is not work you lead.`
  });
  assert.equal((await threadOf(work)).resumeOnTask, null);
});
