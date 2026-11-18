// What a colleague sees through a thread is no wider than its own access,
// unless the owner says yes: a hand-off never waits on the office, and is told
// which tools others on the work have that the colleague lacks. A giver whose
// work needs their contents raises a plain ask first, and the owner's answer
// reaches it as any ask's does. Access is compared with every Odd on the
// thread, both ways: what the colleague lacks, and what it has that others
// lack. Tools are outside tools, the web, and the folders the owner gave. The
// office's own code on every migration, in an in-memory PGlite that stands in
// for db.ts (pglite.ts). Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { Level } from '../src/access-words.ts';
import { asks, connectors, followUps, goals, grants, staff, threads } from '../src/schema.ts';
// Types only, erased before run, so the code under test still loads after the mock.
import type { ThreadFor } from '../src/threads.ts';
import { db } from './pglite.ts';
import { TEMP_IN_APPDATA } from './store-states.ts';

// A home of the test's own, so a folder given to an Odd is named from `~`.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'thread-access-')));
process.env.HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));
const { handOff, handOffBrief, handOffContext } = await import('../src/hand-offs.ts');
const { decideAsk, raiseAsk } = await import('../src/office.ts');
const { HAND_OFF_LIMIT } = await import('../src/threads.ts');

const odd = (id: string, name: string, permission: Level = 'draft') => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission,
  desk: `You are ${name}.`
});
await db
  .insert(staff)
  .values([
    odd('cole', 'Cole'),
    odd('paige', 'Paige'),
    odd('rex', 'Rex'),
    odd('nia', 'Nia', 'read')
  ]);
const tool = (id: string, name: string) => ({
  id,
  name,
  description: name,
  kind: 'http' as const,
  readyAt: new Date()
});
// Every office has Gmail (0009_google): mark it connected, and add the rest.
await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, 'gmail'));
await db.insert(connectors).values([tool('slack', 'Slack'), tool('drive', 'Drive')]);
const grant = (staffId: string, connectorId: string, level: Level = 'read') => ({
  staffId,
  connectorId,
  level
});
// Cole has Gmail and Slack. Paige has Slack only, Rex both and Drive, which
// nobody else has, and Nia holds a Gmail grant above her level, which her
// runs do not get.
await db
  .insert(grants)
  .values([
    grant('cole', 'gmail'),
    grant('cole', 'slack'),
    grant('paige', 'slack'),
    grant('rex', 'gmail'),
    grant('rex', 'slack'),
    grant('rex', 'drive'),
    grant('nia', 'gmail', 'act')
  ]);

const work = { title: 'Sum up the client emails', brief: 'Read inbox.md and sum it up.' };
let titles = 0;
/** Cole hands a colleague a piece of work on a new thread, as the hand_off tool does. */
const give = (to: string, thread: ThreadFor = { title: `T${++titles}` }) =>
  handOff({ from: 'cole', to, work, thread });
const asksOn = (id: number) => db.select().from(asks).where(eq(asks.threadId, id));
const ran = (id: number, kind: 'hand_off' | 'resume' | 'carry_out') =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.threadId, id), eq(followUps.kind, kind)));

test('a hand-off to a colleague that lacks a tool goes at once, and the brief says what not to expect', async () => {
  const r = await give('paige');
  assert.ok('id' in r, JSON.stringify(r));
  assert.deepEqual(await asksOn(r.thread), [], 'the office raises no ask of its own');
  const [f] = await ran(r.thread, 'hand_off');
  assert.deepEqual(f.handOff?.withheld, ['Gmail']);
  assert.ok(f.handOff);
  const brief = handOffBrief({
    kind: 'hand_off',
    h: f.handOff,
    colleague: { id: 'cole', name: 'Cole' },
    me: 'paige',
    result: null,
    thread: r.thread
  }).join('\n');
  assert.match(
    brief,
    /You have no access to Gmail, which others on this work have, so do not expect its contents beyond what the brief gives you\. If the work needs more from it, say so in your reply\./
  );
  assert.doesNotMatch(brief, /Someone else on this work has no access/);
  assert.ok(
    brief.includes('Do not say what happens next or who does it: Cole decides.'),
    'only the lead promises a next step'
  );
});

/** Cole, leading a thread, asks the owner whether Paige may read what came from Gmail. */
async function askToShare(): Promise<{ thread: number; ask: number }> {
  const first = await give('rex');
  assert.ok('id' in first, JSON.stringify(first));
  const { ask } = await raiseAsk('cole', {
    title: 'Pass the client emails to Paige?',
    why: 'Paige sums them up, and has no Gmail.',
    ifApproved: 'I hand her the emails.',
    threadId: first.thread
  });
  assert.equal(ask.kind, 'approval', 'a plain ask, as any Odd raises');
  return { thread: first.thread, ask: ask.id };
}

test("a yes to sharing a tool's contents reaches the giver on the thread with the owner's words, and its hand-off then goes", async () => {
  const { thread, ask } = await askToShare();
  await decideAsk(ask, 'approve', 'Yes, but leave out anything from the bank.');
  const [carry, ...more] = await ran(thread, 'carry_out');
  assert.equal(more.length, 0);
  assert.equal(carry.staffId, 'cole');
  assert.equal(carry.askId, ask);
  assert.equal(carry.note, 'Yes, but leave out anything from the bank.');
  const r = await give('paige', { id: thread });
  assert.ok('id' in r, JSON.stringify(r));
  assert.equal((await asksOn(thread)).length, 1, 'the hand-off raised no second ask');
});

test("a no to sharing a tool's contents brings the giver back on the thread with the answer", async () => {
  const { thread, ask } = await askToShare();
  await decideAsk(ask, 'deny', 'Not the client mail.');
  const [wake] = await ran(thread, 'resume');
  assert.equal(wake?.staffId, 'cole');
  assert.match(
    wake?.note ?? '',
    /said no to "Pass the client emails to Paige\?": Not the client mail\./
  );
  assert.equal((await ran(thread, 'hand_off')).filter((f) => f.staffId === 'paige').length, 0);
});

test('a colleague with every tool the others have is told nothing is withheld', async () => {
  const r = await give('rex');
  assert.ok('id' in r, JSON.stringify(r));
  assert.equal((await ran(r.thread, 'hand_off'))[0]?.handOff?.withheld, undefined);
});

test('a grant above the colleague level is not its access', async () => {
  const r = await give('nia');
  assert.ok('id' in r, JSON.stringify(r));
  // Her Gmail grant is above her level, so Gmail is withheld as Slack is.
  assert.deepEqual((await ran(r.thread, 'hand_off'))[0]?.handOff?.withheld, ['Gmail', 'Slack']);
});

test('continuing a thread checks access the same way', async () => {
  const [t] = await db
    .insert(threads)
    .values({
      title: 'Done before',
      hubId: 'cole',
      holderId: 'cole',
      status: 'done',
      endedAt: new Date()
    })
    .returning({ id: threads.id });
  const r = await give('paige', { id: t.id });
  assert.ok('id' in r && r.thread === t.id, JSON.stringify(r));
  assert.deepEqual((await ran(t.id, 'hand_off'))[0]?.handOff?.withheld, ['Gmail']);
});

/** Cole hands `to` more work on a thread he leads. */
const more = (to: string, thread: number) =>
  handOff({ from: 'cole', to, work, thread: { id: thread } });

test("a colleague is compared with every Odd on the thread, so a third Odd's tool it lacks is named in its brief", async () => {
  const first = await give('rex');
  assert.ok('id' in first, JSON.stringify(first));
  const r = await more('paige', first.thread);
  assert.ok('id' in r, JSON.stringify(r));
  const f = (await ran(r.thread, 'hand_off')).find((x) => x.staffId === 'paige');
  assert.deepEqual(f?.handOff?.withheld, ['Drive', 'Gmail']);
});

test('a colleague with a tool someone on the thread lacks is told never to write its contents there, and to ask the owner instead', async () => {
  const first = await give('paige');
  assert.ok('id' in first, JSON.stringify(first));
  // Cole lacks Drive, and Paige lacks Gmail and Drive, which Rex has.
  const r = await more('rex', first.thread);
  assert.ok('id' in r, JSON.stringify(r));
  const f = (await ran(r.thread, 'hand_off')).find((x) => x.staffId === 'rex');
  assert.ok(f?.handOff);
  assert.deepEqual(f.handOff.kept, ['Drive', 'Gmail']);
  const rule =
    /Someone else on this work has no access to Drive and Gmail, which you have\. Never write anything from Drive and Gmail into your part of its folder or your reply.*raise_ask/;
  const brief = handOffBrief({
    kind: 'hand_off',
    h: f.handOff,
    colleague: { id: 'cole', name: 'Cole' },
    me: 'rex',
    result: null,
    thread: r.thread
  }).join('\n');
  assert.match(brief, rule);
  // A later run on the same hand-off is told again.
  const later = handOffContext({ h: f.handOff, giver: 'Cole', me: 'rex', thread: r.thread });
  assert.match(later.join('\n'), rule);
});

test("a goal's hand-offs from a chat compare each colleague with everyone on the goal's work", async () => {
  const [g] = await db.insert(goals).values({ title: 'Run the fair' }).returning({ id: goals.id });
  // From a chat, Cole names the goal, not its thread, for each hand-off.
  const onGoal = { title: 'Run the fair', goalId: g.id };
  const first = await handOff({ from: 'cole', to: 'paige', work, thread: onGoal });
  assert.ok('id' in first, JSON.stringify(first));
  const r = await handOff({ from: 'cole', to: 'rex', work, thread: onGoal });
  assert.ok('id' in r && r.thread === first.thread, JSON.stringify(r));
  const f = (await ran(r.thread, 'hand_off')).find((x) => x.staffId === 'rex');
  // Cole lacks Drive, and Paige, already on the goal's work, lacks Gmail too.
  assert.deepEqual(f?.handOff?.kept, ['Drive', 'Gmail']);
});

test("a held hand-off carries access as it is at the owner's yes, as a fresh hand-off then would", async () => {
  // Tess has Slack only, so the hand-off is held telling her Gmail is withheld.
  await db.insert(staff).values(odd('tess', 'Tess'));
  await db.insert(grants).values(grant('tess', 'slack'));
  const [t] = await db
    .insert(threads)
    .values({
      title: 'Tune the inbox',
      hubId: 'cole',
      holderId: 'cole',
      handOffsUsed: HAND_OFF_LIMIT
    })
    .returning({ id: threads.id });
  const held = await give('tess', { id: t.id });
  assert.ok('asked' in held, JSON.stringify(held));
  // While the ask waits, the owner gives Tess Drive, which Cole lacks.
  await db.insert(grants).values(grant('tess', 'drive'));
  await decideAsk(held.asked, 'approve', null);
  const [started] = await ran(t.id, 'hand_off');
  assert.deepEqual(started?.handOff?.withheld, ['Gmail']);
  assert.deepEqual(started?.handOff?.kept, ['Drive'], 'Tess is not told to keep Drive out');
  const fresh = await give('tess');
  assert.ok('id' in fresh, JSON.stringify(fresh));
  const [now] = await ran(fresh.thread, 'hand_off');
  assert.deepEqual(started?.handOff, now?.handOff);
});

test(
  'a colleague is told of the web and the folders others on the thread hold and it lacks, and never to pass on its own',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const p = join(HOME, 'p');
    mkdirSync(join(p, 'sub'), { recursive: true });
    // Wes browses the web. Fay was given ~/p, Sol only ~/p/sub, and Pia nothing.
    await db
      .insert(staff)
      .values([
        { ...odd('wes', 'Wes'), web: true },
        { ...odd('fay', 'Fay'), folders: [{ path: p, write: true }] },
        { ...odd('sol', 'Sol'), folders: [{ path: join(p, 'sub'), write: false }] },
        odd('pia', 'Pia')
      ]);
    const from = (giver: string, to: string) =>
      handOff({ from: giver, to, work, thread: { title: `${giver} to ${to}` } });
    const handedTo = async (r: Awaited<ReturnType<typeof from>>, to: string) => {
      assert.ok('id' in r, JSON.stringify(r));
      const f = (await ran(r.thread, 'hand_off')).find((x) => x.staffId === to);
      assert.ok(f?.handOff);
      return f.handOff;
    };

    const toPia = await handedTo(await from('wes', 'pia'), 'pia');
    assert.deepEqual(toPia.withheld, ['the web']);
    const brief = handOffBrief({
      kind: 'hand_off',
      h: toPia,
      colleague: { id: 'wes', name: 'Wes' },
      me: 'pia',
      result: null,
      thread: 0
    }).join('\n');
    assert.match(brief, /You have no access to the web, which others on this work have/);

    const toFay = await handedTo(await from('wes', 'fay'), 'fay');
    assert.deepEqual(toFay.kept, ['~/p'], 'Wes lacks ~/p, so Fay keeps it out');

    // Fay's ~/p holds Sol's ~/p/sub, so she lacks nothing of Sol's.
    const fromSol = await handedTo(await from('sol', 'fay'), 'fay');
    assert.equal(fromSol.withheld, undefined);
    assert.deepEqual(fromSol.kept, ['~/p'], 'Sol has only ~/p/sub');

    // Kit and Lou were both given ~/gone, since deleted from the disk. Lou's runs
    // no longer get it, so it is not hers, and what Kit read there is withheld.
    const gone = join(HOME, 'gone');
    mkdirSync(gone);
    rmSync(gone, { recursive: true });
    const given = [{ path: gone, write: false }];
    await db.insert(staff).values([
      { ...odd('kit', 'Kit'), folders: given },
      { ...odd('lou', 'Lou'), folders: given }
    ]);
    const toLou = await handedTo(await from('kit', 'lou'), 'lou');
    assert.deepEqual(toLou.withheld, ['~/gone']);
  }
);
