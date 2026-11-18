// The hand_off tool as a run sees it: the office tool server (src/mcp.ts) in a
// process of its own, as the office starts one for each run, over the office's
// own database (local-db.ts) in a throwaway folder. It checks
// what only the tool server decides: which runs are offered hand_off, that a
// hand-off or a goal's plan carries the run's key to its thread, that a
// hand-off that hands nothing on comes back as an error and one held for the
// owner's yes says it goes ahead on it, what a hand-off's result says, and where an ask or task raised in a chat goes: a goal's work
// to its lead, never onto the desk from a colleague, and a lead's onto the
// thread it names. A goal hire with no job opens no work and puts nothing on
// the desk through any tool. Every tool refuses a key it does not take, so an
// old parameter name does nothing. After every test each goal still has one
// thread. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db, sql, toolServer } from './tool-server.ts';
import { oneThreadPerGoal } from './one-thread.ts';
import { TEMP_IN_APPDATA } from './store-states.ts';

const {
  asks: asksTable,
  connectors,
  goals,
  grants,
  owner,
  staff,
  tasks: tasksTable,
  threads
} = await import('../src/schema.ts');
const { ASK_REPLACED } = await import('../src/desk-answers.ts');
const { and, eq, inArray } = await import('drizzle-orm');
const { givenName, workName } = await import('../src/work-paths.ts');
const { MAIL_FILES_MAX } = await import('../src/mail-attachments.ts');
const { isOffered, OFFICE_TOOLS, RIDES_WITH, STARTER_TOOLS } = await import('../src/tools.ts');
const { MANAGER_ROLE } = await import('../src/managers.ts');
const { HAND_OFF_LIMIT, LEADS_NONE, threadPart } = await import('../src/threads.ts');
const { connectProject, shareProject } = await import('../src/project-sessions.ts');
afterEach(() => oneThreadPerGoal(sql, MANAGER_ROLE));

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
await db
  .insert(staff)
  .values([
    { ...odd('lead', 'Lena'), tools: [...STARTER_TOOLS, 'propose_goal_plan'] },
    odd('paige', 'Paige')
  ]);
// Lena reads Gmail, which Paige lacks.
// Every office has Gmail (0009_google): mark it connected.
await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, 'gmail'));
await db.insert(grants).values({ staffId: 'lead', connectorId: 'gmail', level: 'read' });

const handOffTool = async (c: Client) =>
  (await c.listTools()).tools.find((t) => t.name === 'hand_off');
/** The first text a tool call returned. */
const said = (r: Awaited<ReturnType<Client['callTool']>>) =>
  (r.content as { type: string; text: string }[])[0]?.text ?? '';

// The two fixtures below serve later tests but are set up here, above the
// first test: under --test-force-exit the runner drops every test registered
// after a top-level await.

// A goal's thread, led by Mo, that Pia (no job) and Jo (a job) serve.
const { asks, followUps, jobs, staffGoals, staffSkills, tasks } = await import('../src/schema.ts');
await db
  .insert(staff)
  .values([
    odd('mo', 'Mo'),
    { ...odd('pia', 'Pia'), tools: [...STARTER_TOOLS, 'propose_hire'] },
    odd('jo', 'Jo')
  ]);
// A job description Pia could propose a hire with, so only the goal check stops it.
const { home, OFFICE_FILE_NAMES } = await import('../src/home.ts');
mkdirSync(home('staff', 'pia', 'notes'), { recursive: true });
writeFileSync(home('staff', 'pia', 'notes', 'jd-printer.md'), 'Prints signs.');
const [fair] = await db.insert(goals).values({ title: 'Run the bake sale' }).returning();
const [sale] = await db
  .insert(threads)
  .values({ title: fair.title, goalId: fair.id, hubId: 'mo', holderId: 'mo' })
  .returning();
await db.insert(staffGoals).values([
  { staffId: 'pia', goalId: fair.id, part: 'The signs' },
  { staffId: 'jo', goalId: fair.id, part: 'The cakes' }
]);
await db.insert(jobs).values({
  staffId: 'jo',
  name: 'Weekly accounts',
  instructions: 'Add up.',
  schedule: { every: 'day', at: '09:00' }
});

// Three Odds serving the bake sale Mo leads, holding no office tool, one, and
// every one.
const HOLDERS: Record<string, readonly string[]> = {
  nil: [],
  uno: ['poke_owner'],
  tot: OFFICE_TOOLS.map((t) => t.id)
};
await db
  .insert(staff)
  .values(
    Object.entries(HOLDERS).map(([id, tools]) => ({ ...odd(id, `Odd ${id}`), tools: [...tools] }))
  );
await db
  .insert(staffGoals)
  .values(Object.keys(HOLDERS).map((staffId) => ({ staffId, goalId: fair.id, part: 'Some' })));
// `withGmail` tools come only with Gmail, which only Tot holds.
await db.insert(grants).values({ staffId: 'tot', connectorId: 'gmail', level: 'read' });

test("a run that only reads the owner's no or edit for a lesson is offered no hand_off, and so no continue_work", async () => {
  const plain = await handOffTool(await toolServer('lead', { RUN_KEY: 'k-plain' }));
  assert.ok(plain, 'a chat or follow-up on no thread is offered hand_off');
  assert.ok('continue_work' in (plain.inputSchema.properties ?? {}));
  const lesson = await handOffTool(
    await toolServer('lead', {
      RUN_KEY: 'k-lesson',
      LESSON_RUN: '1',
      OWNER_NOTE: 'Never on a Friday.'
    })
  );
  assert.equal(lesson, undefined);
});

test('the hand_off tool tells the lead to describe the work and the result, never the tools', async () => {
  const t = await handOffTool(await toolServer('lead', { RUN_KEY: 'k-tools' }));
  assert.ok(
    t?.description?.includes(
      'Describe the work and the result you need, never which tools to use: each colleague may run on another coding tool, with tools of its own.'
    )
  );
});

test("a hand-off carries the run's key to its thread, so the hold can see the run", async () => {
  const c = await toolServer('lead', { RUN_KEY: 'k-chat' });
  const r = await c.callTool({
    name: 'hand_off',
    arguments: {
      to: 'paige',
      title: 'Count the chairs',
      brief: 'Count them.'
    }
  });
  assert.equal(r.isError, undefined, said(r));
  const [t] = await db.select().from(threads).where(eq(threads.title, 'Count the chairs'));
  assert.deepEqual(t.runs, ['k-chat']);
});

test("a hand-off that hands nothing on comes back as an error that says so, and one held for the owner's yes says it goes ahead on it", async () => {
  const c = await toolServer('lead', { RUN_KEY: 'k-refused' });
  const r = await c.callTool({
    name: 'hand_off',
    arguments: { to: 'nobody', title: 'Lay the tables', brief: 'Lay them.' }
  });
  assert.equal(r.isError, true);
  assert.match(said(r), /^Nothing was handed off yet\. Nobody called "nobody" works here\./);
  const [parties] = await db
    .insert(threads)
    .values({
      title: 'Plan every party',
      hubId: 'lead',
      holderId: 'lead',
      handOffsUsed: HAND_OFF_LIMIT
    })
    .returning();
  const past = await c.callTool({
    name: 'hand_off',
    arguments: { to: 'paige', title: 'Plan one more', brief: 'Plan it.', continue_work: parties.id }
  });
  // Held, not refused: an error would have the lead hand on again what the ask holds.
  assert.equal(past.isError, undefined, said(past));
  assert.match(
    said(past),
    new RegExp(
      `^This round of work ${parties.id} has taken its ${HAND_OFF_LIMIT} hand-offs, so "Plan one more" waits on .+'s answer to ask #\\d+\\. On a yes it goes to Paige exactly as you wrote it`
    )
  );
  assert.match(said(past), /There is nothing more for you to do for it: do not hand it on again\./);
});

test("a goal's plan carries the run's key to the goal's thread, so the hold can see the run", async () => {
  const [g] = await db.insert(goals).values({ title: 'Host the summer fair' }).returning();
  const c = await toolServer('lead', { RUN_KEY: 'k-plan' });
  const r = await c.callTool({
    name: 'propose_goal_plan',
    arguments: {
      goal_id: g.id,
      why: 'Paige counts the chairs.',
      assign: [{ staff: 'paige', part: 'Count the chairs' }]
    }
  });
  assert.match(said(r), /^Ask \d+ is on/);
  const [t] = await db.select().from(threads).where(eq(threads.goalId, g.id));
  assert.deepEqual(t.runs, ['k-plan']);
});

test('a hand-off on a goal the lead does not serve comes back as an error', async () => {
  const c = await toolServer('lead', { RUN_KEY: 'k-held' });
  const goal = await c.callTool({
    name: 'hand_off',
    arguments: { to: 'paige', brief: 'Sort them.', title: 'Sort the mail', goal: 999 }
  });
  assert.equal(goal.isError, true, 'a refused hand-off read as handed over');
  assert.match(said(goal), /^Nothing was handed off yet\. Goal #999 is not one you serve\./);
});

test("a hand-off's result names the work by its title and colleague, never by a follow-up's id", async () => {
  const c = await toolServer('lead', { RUN_KEY: 'k-named' });
  const r = await c.callTool({
    name: 'hand_off',
    arguments: {
      to: 'paige',
      title: 'Stack the chairs',
      brief: 'Stack them.'
    }
  });
  const [t] = await db.select().from(threads).where(eq(threads.title, 'Stack the chairs'));
  assert.equal(
    said(r),
    `Handed "Stack the chairs" to Paige, on work ${t.id}. They start now. You pick up in a fresh run when they finish.\n${HAND_OFF_LIMIT - 1} hand-offs left this round.`
  );
});

test('continuing a finished thread starts a new round with its whole limit', async () => {
  const [t] = await db
    .insert(threads)
    .values({
      title: 'Plan the menu',
      hubId: 'lead',
      holderId: 'lead',
      status: 'done',
      handOffsUsed: HAND_OFF_LIMIT,
      endedAt: new Date()
    })
    .returning();
  const c = await toolServer('lead', { RUN_KEY: 'k-again' });
  const r = await c.callTool({
    name: 'hand_off',
    arguments: {
      to: 'paige',
      title: 'Price the menu',
      brief: 'Price it.',
      continue_work: t.id
    }
  });
  assert.equal(r.isError, undefined, said(r));
  assert.equal(said(r).split('\n')[1], `${HAND_OFF_LIMIT - 1} hand-offs left this round.`);
});

const chat = { OWNER_SAID: 'Pia, can you make the signs blue?' };
const ask = { title: 'Make the signs blue', why: 'They asked.', if_approved: 'I make them.' };
const raisedBy = async (staffId: string) => ({
  asks: await db.select().from(asks).where(eq(asks.staffId, staffId)),
  tasks: await db.select().from(tasks).where(eq(tasks.staffId, staffId))
});

test("a goal hire with no job is offered tell_lead in chat, and raising the goal's work itself is refused as an error", async () => {
  const c = await toolServer('pia', { ...chat, RUN_KEY: 'k-pia' });
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('tell_lead'), 'serving the goal is enough, with no hand-off yet');
  const r = await c.callTool({ name: 'raise_ask', arguments: ask });
  assert.equal(r.isError, true);
  assert.match(said(r), /Pass .+ words to Mo with tell_lead/);
  const t = await c.callTool({
    name: 'give_owner_a_task',
    arguments: { title: 'Pick a blue', why: 'Only you know.', steps: ['Pick one'] }
  });
  assert.equal(t.isError, true);
  assert.deepEqual(await raisedBy('pia'), { asks: [], tasks: [] });
});

test('tell_lead requires a reading', async () => {
  const c = await toolServer('pia', { ...chat, RUN_KEY: 'k-pia-reading' });
  const tool = (await c.listTools()).tools.find((t) => t.name === 'tell_lead');
  assert.ok(tool?.inputSchema.required?.includes('reading'), "the lead reads it as the Odd's");
  assert.match(tool?.description ?? '', /work it out in chat and pass nothing on/);
});

test("tell_lead hands the lead the chat's last exchange, as the office set it", async () => {
  await db.insert(staff).values(odd('tam', 'Tam'));
  const [fence] = await db.insert(goals).values({ title: 'Paint the fence' }).returning();
  const [paint] = await db
    .insert(threads)
    .values({ title: fence.title, goalId: fence.id, hubId: 'mo', holderId: 'mo' })
    .returning();
  await db.insert(staffGoals).values({ staffId: 'tam', goalId: fence.id, part: 'The paint' });
  const c = await toolServer('tam', {
    OWNER_SAID: 'Tam, use green.',
    CHAT_EXCHANGE: 'Just before, Tam said: "Which colour?".',
    RUN_KEY: 'k-tam'
  });
  const r = await c.callTool({
    name: 'tell_lead',
    arguments: { work: paint.id, words: 'use green.', reading: 'They want green paint.' }
  });
  assert.equal(r.isError, undefined, said(r));
  const [wake] = await db.select().from(followUps).where(eq(followUps.threadId, paint.id));
  assert.match(
    wake.note ?? '',
    /They want green paint\. Just before, Tam said: "Which colour\?"\.$/
  );
});

test("tell_lead copies every file the owner attached into the colleague's part of the work under the owner's name for it, or the next free one, lists each for the lead, and says which did not come and why, never holding back the words", async (t) => {
  await db.insert(staff).values(odd('una', 'Una'));
  const [roof] = await db.insert(goals).values({ title: 'Fix the roof' }).returning();
  const [mend] = await db
    .insert(threads)
    .values({ title: roof.title, goalId: roof.id, hubId: 'mo', holderId: 'mo' })
    .returning();
  await db.insert(staffGoals).values({ staffId: 'una', goalId: roof.id, part: 'The tiles' });
  const shot = 'attachments/20261111-090000-aaaa-roof.png';
  const notes = 'attachments/20261111-090000-bbbb-notes.md';
  const plan = 'attachments/20261111-090000-cccc-plan.md';
  for (const [path, text] of [
    [shot, 'png'],
    [notes, 'the owner notes'],
    [plan, 'the plan']
  ])
    put(join(home('staff', 'una'), path), text);
  const part = threadPart(mend.id, 'una');
  // Already in the work: a different file where the notes would land, and the same plan.
  put(join(part, 'notes.md'), "Una's own notes");
  put(join(part, 'plan.md'), 'the plan');
  const c = await toolServer('una', {
    OWNER_SAID: 'Una, the leak is by the chimney [Image #1].',
    OWNER_FILES: JSON.stringify([
      { tag: 'Image #1', path: shot, name: 'roof.png' },
      { tag: 'notes.md', path: notes, name: 'notes.md' },
      { tag: 'plan.md', path: plan, name: 'plan.md' },
      { tag: 'gone.png', path: 'attachments/20261111-090000-dddd-gone.png', name: 'gone.png' }
    ]),
    RUN_KEY: 'k-una'
  });
  t.after(() => c.close());
  const tool = (await c.listTools()).tools.find((x) => x.name === 'tell_lead');
  assert.match(tool?.description ?? '', /Every file they attached to it goes too/);
  const r = await c.callTool({
    name: 'tell_lead',
    arguments: {
      work: mend.id,
      words: 'the leak is by the chimney [Image #1].',
      reading: 'The leak is near the chimney.'
    }
  });
  assert.equal(r.isError, undefined, said(r));
  assert.match(said(r), /The 3 files they attached went too\./);
  assert.match(said(r), /Did not go: gone\.png, since .+\. Tell .+ so\./);
  assert.deepEqual(partNow(part), {
    'notes-2.md': 'the owner notes',
    'notes.md': "Una's own notes",
    'plan.md': 'the plan',
    'roof.png': 'png'
  });
  const [wake] = await db.select().from(followUps).where(eq(followUps.threadId, mend.id));
  assert.equal(wake.staffId, 'mo');
  const note = wake.note ?? '';
  assert.ok(note.includes("words: the leak is by the chimney [Image #1]. Una's own reading"), note);
  assert.ok(
    note.endsWith(
      ` attached 3 files to that message, now in this work: Image #1 at ${join(part, 'roof.png')}; notes.md at ${join(part, 'notes-2.md')}; plan.md at ${join(part, 'plan.md')}. One file the owner attached did not come: gone.png, since the office cannot read it.`
    ),
    note
  );
  assert.ok(!note.includes('\n'), 'the note stays on one line');
});

test("tell_lead lands an attachment under the last part of the owner's name for it, and never under a hidden name or an instruction file's", async (t) => {
  await db.insert(staff).values(odd('uri', 'Uri'));
  const [deck] = await db.insert(goals).values({ title: 'Paint the deck' }).returning();
  const [paint] = await db
    .insert(threads)
    .values({ title: deck.title, goalId: deck.id, hubId: 'mo', holderId: 'mo' })
    .returning();
  await db.insert(staffGoals).values({ staffId: 'uri', goalId: deck.id, part: 'The boards' });
  const kept = (name: string) => {
    const path = `attachments/20261111-090000-eeee-${name}`;
    put(join(home('staff', 'uri'), path), name);
    return path;
  };
  const c = await toolServer('uri', {
    OWNER_SAID: 'Uri, use these colours.',
    OWNER_FILES: JSON.stringify([
      { tag: 'colours.md', path: kept('colours.md'), name: '../../colours.md' },
      { tag: '.env', path: kept('env.txt'), name: 'x/.env' },
      { tag: 'CLAUDE.md', path: kept('CLAUDE.md'), name: 'CLAUDE.md' }
    ]),
    RUN_KEY: 'k-uri'
  });
  t.after(() => c.close());
  const r = await c.callTool({
    name: 'tell_lead',
    arguments: { work: paint.id, words: 'use these colours.', reading: 'Use these colours.' }
  });
  assert.equal(r.isError, undefined, said(r));
  const part = threadPart(paint.id, 'uri');
  assert.deepEqual(partNow(part), { 'colours.md': 'colours.md' });
  const [wake] = await db.select().from(followUps).where(eq(followUps.threadId, paint.id));
  assert.ok(
    wake.note?.endsWith(
      ` now in this work: colours.md at ${join(part, 'colours.md')}. 2 files the owner attached did not come: .env, since it is a hidden file; CLAUDE.md, since it is an instruction file.`
    ),
    wake.note ?? ''
  );
});

test('tell_lead with no files attached says nothing of files, to the lead or in its description', async (t) => {
  await db.insert(staff).values(odd('xan', 'Xan'));
  await db.insert(staffGoals).values({ staffId: 'xan', goalId: fair.id, part: 'The till' });
  const c = await toolServer('xan', { OWNER_SAID: 'Xan, count the till twice.', RUN_KEY: 'k-xan' });
  t.after(() => c.close());
  const tool = (await c.listTools()).tools.find((x) => x.name === 'tell_lead');
  assert.doesNotMatch(tool?.description ?? '', /attached/);
  const r = await c.callTool({
    name: 'tell_lead',
    arguments: { work: sale.id, words: 'count the till twice.', reading: 'Count it twice.' }
  });
  assert.equal(r.isError, undefined, said(r));
  assert.doesNotMatch(said(r), /attached|Did not go/);
  const wakes = await db.select().from(followUps).where(eq(followUps.threadId, sale.id));
  assert.ok(
    wakes.some((w) =>
      w.note?.endsWith("Xan's own reading, which is not the owner's words: Count it twice.")
    )
  );
});

test('a goal hire with no job opens no work and puts nothing on the desk, whatever tool it reaches for', async () => {
  const c = await toolServer('pia', { ...chat, RUN_KEY: 'k-pia-all' });
  const work = {
    to: 'jo',
    title: 'Print the signs',
    brief: 'Print them.'
  };
  const calls = [
    { name: 'hand_off', arguments: work },
    { name: 'hand_off', arguments: { ...work, goal: fair.id } },
    { name: 'hand_off', arguments: { ...work, continue_work: sale.id } },
    { name: 'ask_for_access', arguments: { connector: 'gmail', level: 'read', why: 'Signs.' } },
    {
      name: 'propose_hire',
      arguments: {
        name: 'Remy',
        role: 'Printer',
        remit: 'Prints the signs.',
        job_description_file: 'notes/jd-printer.md',
        permission: 'draft',
        why: 'The signs need printing.'
      }
    }
  ];
  for (const call of calls) {
    const r = await c.callTool(call);
    assert.equal(r.isError, true, `${call.name} ${JSON.stringify(call.arguments)}: ${said(r)}`);
  }
  assert.deepEqual(await raisedBy('pia'), { asks: [], tasks: [] });
  assert.deepEqual(await db.select().from(threads).where(eq(threads.hubId, 'pia')), []);

  // Off a chat, where no tell_lead is offered, opening a thread still refuses it.
  const run = await toolServer('pia', { RUN_KEY: 'k-pia-run' });
  const opened = await run.callTool({ name: 'hand_off', arguments: work });
  assert.equal(opened.isError, true);
  assert.equal(said(opened), LEADS_NONE);
});

test('a goal hire with a job is told to pass goal work to the lead, and its own ask lands on no thread', async () => {
  const c = await toolServer('jo', { ...chat, RUN_KEY: 'k-jo' });
  const tool = (await c.listTools()).tools.find((t) => t.name === 'raise_ask');
  assert.match(
    tool?.description ?? '',
    /Never for work another Odd leads that you are on: .+ tell_lead\./
  );
  const own = await c.callTool({
    name: 'raise_ask',
    arguments: { ...ask, title: 'Pay the flour bill' }
  });
  assert.equal(own.isError, undefined, said(own));
  const [a] = (await raisedBy('jo')).asks;
  assert.equal(a.threadId, null);
});

test("a goal hire with a job opens its own job's work as a thread of its own", async () => {
  const c = await toolServer('jo', { ...chat, RUN_KEY: 'k-jo-open' });
  const own = await c.callTool({
    name: 'hand_off',
    arguments: { to: 'pia', title: 'Count the till', brief: 'Count it.' }
  });
  assert.equal(own.isError, undefined, said(own));
  const [led] = await db.select().from(threads).where(eq(threads.hubId, 'jo'));
  assert.equal(led.goalId, null, "its own job's work opens a thread of its own");
});

test('a lead off its threads may say which thread an ask is for, left out reads as none, and one it does not lead is refused', async () => {
  const c = await toolServer('mo', { ...chat, RUN_KEY: 'k-mo' });
  const tool = (await c.listTools()).tools.find((t) => t.name === 'raise_ask');
  assert.ok(tool && 'work' in (tool.inputSchema.properties ?? {}), 'a lead is offered work');
  assert.ok(
    !tool.inputSchema.required?.includes('work'),
    'work may be left out, and then the ask is for none of it'
  );
  const [lenas] = await db.select().from(threads).where(eq(threads.hubId, 'lead'));
  const wrong = await c.callTool({ name: 'raise_ask', arguments: { ...ask, work: lenas.id } });
  assert.equal(wrong.isError, true);
  assert.match(said(wrong), /not work you lead/);
  const right = await c.callTool({ name: 'raise_ask', arguments: { ...ask, work: sale.id } });
  assert.equal(right.isError, undefined, said(right));
  const [a] = (await raisedBy('mo')).asks;
  assert.equal(a.threadId, sale.id);
  const [t] = await db.select().from(threads).where(eq(threads.id, sale.id));
  assert.deepEqual(t.runs, ['k-mo'], "the lead's chat holds its pick-ups until it ends");
  assert.equal(t.status, 'open', 'the work stays open while the ask is on the desk');
});

test('a lead naming a thread it leads is never refused, even when it also serves a goal another Odd leads', async () => {
  // Lena leads the summer fair's thread, from her plan, has a job, and serves Mo's bake sale.
  await db.insert(jobs).values({
    staffId: 'lead',
    name: 'Daily post',
    instructions: 'Sort it.',
    schedule: { every: 'day', at: '09:00' }
  });
  await db.insert(staffGoals).values({ staffId: 'lead', goalId: fair.id, part: 'The till' });
  const [own] = await db.select().from(threads).where(eq(threads.title, 'Host the summer fair'));
  assert.equal(own.hubId, 'lead');
  const c = await toolServer('lead', { ...chat, RUN_KEY: 'k-lena' });
  const r = await c.callTool({
    name: 'raise_ask',
    arguments: { ...ask, title: 'Book the field', work: own.id }
  });
  assert.equal(r.isError, undefined, said(r));
  const [a] = await db.select().from(asks).where(eq(asks.title, 'Book the field'));
  assert.equal(a.threadId, own.id);
});

// A chat resumed after a parameter was renamed still uses the old name. Every
// tool refuses a key it does not take (mcp-run.ts `tool`), and names the ones it does.
/** A finished piece of work Lena leads, to continue. */
const finished = async (title: string) =>
  (
    await db
      .insert(threads)
      .values({
        title,
        hubId: 'lead',
        holderId: 'lead',
        status: 'done',
        endedAt: new Date()
      })
      .returning()
  )[0];
const workCount = async () => (await db.select().from(threads)).length;
const more = { to: 'paige', brief: 'Do it again.' };

test("a hand_off with a parameter's old name is refused, names continue_work, and opens no new work", async () => {
  const t = await finished('Fold the napkins');
  const c = await toolServer('lead', { RUN_KEY: 'k-old-name' });
  const before = await workCount();
  const r = await c.callTool({
    name: 'hand_off',
    arguments: { ...more, title: 'Fold more napkins', continue_thread: t.id }
  });
  assert.equal(r.isError, true, said(r));
  assert.match(said(r), /hand_off takes only .*\bcontinue_work\b.*\. Nothing was done\./);
  assert.equal(await workCount(), before, 'the old name opened new work');
});

test("a raise_ask with a parameter's old name is refused, names work, and puts nothing on the desk", async () => {
  const before = (await raisedBy('mo')).asks.length;
  const c = await toolServer('mo', { ...chat, RUN_KEY: 'k-mo-old' });
  const r = await c.callTool({ name: 'raise_ask', arguments: { ...ask, thread: sale.id } });
  assert.equal(r.isError, true, said(r));
  assert.match(said(r), /raise_ask takes only .*\bwork\b.*\. Nothing was done\./);
  assert.equal((await raisedBy('mo')).asks.length, before);
});

test('a call with only the keys a tool takes still works, with its optional ones or without', async () => {
  const t = await finished('Iron the cloths');
  const c = await toolServer('lead', { RUN_KEY: 'k-known' });
  const before = await workCount();
  const r = await c.callTool({
    name: 'hand_off',
    arguments: { ...more, title: 'Iron more cloths', continue_work: t.id }
  });
  assert.equal(r.isError, undefined, said(r));
  assert.match(said(r), new RegExp(`on work ${t.id}\\.`));
  assert.equal(await workCount(), before, 'continuing opened new work');
  const asks = await c.callTool({ name: 'my_asks', arguments: {} });
  assert.equal(asks.isError, undefined, said(asks));
});

test('my_tasks lists each task the Odd gave and how the owner finished it', async () => {
  await db.insert(staff).values(odd('tasker', 'Tasha'));
  const given = (title: string) => ({ staffId: 'tasker', title, why: 'w' });
  await db.insert(tasksTable).values([
    {
      ...given('Pick a blue'),
      status: 'done',
      doneAt: new Date(),
      note: 'Thanks.',
      steps: [
        {
          text: 'Pick one',
          done: true,
          action: { kind: 'choice', options: ['Navy'] },
          answer: 'Navy'
        }
      ]
    },
    { ...given('Sign the form'), status: 'dropped', doneAt: new Date(), steps: [] },
    {
      ...given('Sort the post'),
      steps: [
        { text: 'Pick one', done: true, action: { kind: 'choice', options: ['A'] }, answer: 'A' }
      ]
    }
  ]);
  const r = await (
    await toolServer('tasker', { RUN_KEY: 'k-tasks' })
  ).callTool({
    name: 'my_tasks',
    arguments: {}
  });
  assert.equal(r.isError, undefined, said(r));
  assert.match(said(r), /FINISHED: Pick a blue \(Pick one: Navy Thanks\.\)/);
  assert.match(said(r), /DROPPED: Sign the form$/m);
  assert.match(said(r), /OPEN: Sort the post$/m);
});

test('my_asks says an ask the Odd replaced was replaced, and still says what the owner sent back', async () => {
  await db.insert(staff).values(odd('asker', 'Asha'));
  const raised = (title: string) => ({ staffId: 'asker', title, why: 'w', ifApproved: 'i' });
  await db.insert(asksTable).values([
    { ...raised('Buy paint'), status: 'revise', reason: ASK_REPLACED, decidedAt: new Date() },
    { ...raised('Buy brushes'), status: 'revise', reason: 'Fewer.', decidedAt: new Date() }
  ]);
  const r = await (
    await toolServer('asker', { RUN_KEY: 'k-asks' })
  ).callTool({
    name: 'my_asks',
    arguments: {}
  });
  assert.equal(r.isError, undefined, said(r));
  assert.match(said(r), /REPLACED: Buy paint$/m);
  assert.match(said(r), /SENT BACK: Buy brushes \(change: Fewer\.\)/);
  assert.ok(!said(r).includes(ASK_REPLACED), said(r));
});

test('every office tool refuses a key it does not take, and says which keys it does', async () => {
  // Every office tool granted, serving the bake sale Mo leads: a chat offers
  // tell_lead, and a run on that work offers resume_at.
  await db.insert(staff).values({ ...odd('all', 'Ada'), tools: OFFICE_TOOLS.map((t) => t.id) });
  await db.insert(staffGoals).values({ staffId: 'all', goalId: fair.id, part: 'Everything' });
  // Gmail at any level offers propose_reply, and at write ask_for_standing_yes.
  await db.insert(grants).values({ staffId: 'all', connectorId: 'gmail', level: 'act' });
  // A skill the owner attached offers read_skill.
  await db
    .insert(staffSkills)
    .values({ staffId: 'all', name: 'every', description: 'Use always.', text: 'Do it.' });
  // A native conversation shared with Ada offers the project tools, in Advanced
  // mode. The owner row keeps the name every other test here reads.
  await db
    .insert(owner)
    .values({ name: 'the owner', advancedAt: new Date() })
    .onConflictDoUpdate({ target: owner.id, set: { advancedAt: new Date() } });
  const project = await connectProject('claude', 'every-tool-test', '/project', 'Tests');
  await shareProject(project.id, 'all');
  const reached = new Set<string>();
  const runs: Record<string, string>[] = [chat, { THREAD_ID: String(sale.id) }];
  for (const env of runs) {
    const c = await toolServer('all', { ...env, RUN_KEY: `k-all-${reached.size}` });
    for (const { name } of (await c.listTools()).tools) {
      reached.add(name);
      const r = await c.callTool({ name, arguments: { not_a_key: 1 } });
      assert.equal(r.isError, true, `${name}: ${said(r)}`);
      assert.match(said(r), new RegExp(`${name} takes (only|no arguments).*Nothing was done\\.`));
    }
  }
  assert.deepEqual(
    OFFICE_TOOLS.filter((t) => !t.prompt)
      .map((t) => t.id)
      .filter((id) => !reached.has(id)),
    [],
    'an office tool this test never reached'
  );
  assert.deepEqual(await raisedBy('all'), { asks: [], tasks: [] });
  assert.deepEqual(await db.select().from(threads).where(eq(threads.hubId, 'all')), []);
});

// A chat with the owner's words offers tell_lead, and a run on the sale's
// thread offers resume_at.
const RUNS = { chat, thread: { THREAD_ID: String(sale.id) } };
type Run = keyof typeof RUNS;
/**
 * A tool that rides with a listed one and is offered in one kind of run only.
 * A listed tool says so on its own row (`inChat`), which the test reads and a
 * test below pins.
 */
const RIDES_ONLY_IN: Partial<Record<keyof typeof RIDES_WITH, Run>> = { resume_at: 'thread' };
const registered = async (staffId: string, run: Run) => {
  const c = await toolServer(staffId, { ...RUNS[run], RUN_KEY: `k-${staffId}-${run}` });
  return (await c.listTools()).tools.map((t) => t.name).sort();
};

test('every tool the server registers is a listed office tool or rides with one', async () => {
  const listed = new Set<string>([...OFFICE_TOOLS.map((t) => t.id), ...Object.keys(RIDES_WITH)]);
  for (const run of ['chat', 'thread'] as const)
    assert.deepEqual(
      (await registered('tot', run)).filter((n) => !listed.has(n)),
      [],
      run
    );
});

// One test per tool server: each takes seconds to start, and a test has 15.
for (const [id, holds] of Object.entries(HOLDERS))
  for (const run of ['chat', 'thread'] as const)
    test(`an Odd holding ${holds.length} of the office tools (${id}) in a ${run} has exactly the always tools, the ones it holds and the ones that ride with them, as each row's conditions allow`, async () => {
      // None of these Odds is the Office Manager, only Tot holds Gmail, and none at Read and write.
      const toolRun = { gmail: id === 'tot', write: false, chat: run === 'chat', manager: false };
      const offered = new Set<string>(
        OFFICE_TOOLS.filter((t) => isOffered(holds, t.id, toolRun)).map((t) => t.id)
      );
      // A cast only to name the keys: Object.keys types them as strings.
      const riding = (Object.keys(RIDES_WITH) as (keyof typeof RIDES_WITH)[]).filter(
        (name) => offered.has(RIDES_WITH[name]) && (RIDES_ONLY_IN[name] ?? run) === run
      );
      const want = [...offered, ...riding].sort();
      assert.deepEqual(await registered(id, run), want, `${id} in a ${run}`);
    });

// The test above works out what a run gets with `isOffered`, so a condition
// dropped from a row, or from `isOffered`, changes what it expects too. These
// hold the rows themselves, and what `isOffered` gives for each condition.
test('only leave_office, withdraw, tell_lead, draft_bug_report, oddboro_update, remove_odd and bring_back_odd wait for a chat, only leave_office is kept from the manager, and only see_office shapes the prompt and is never offered, even to a chat holding it', () => {
  const where = (field: 'inChat' | 'notToManager' | 'prompt') =>
    OFFICE_TOOLS.filter((t) => t[field]).map((t) => t.id);
  assert.deepEqual(where('inChat'), [
    'leave_office',
    'withdraw',
    'tell_lead',
    'draft_bug_report',
    'oddboro_update',
    'remove_odd',
    'bring_back_odd'
  ]);
  assert.deepEqual(where('notToManager'), ['leave_office']);
  assert.deepEqual(where('prompt'), ['see_office']);
  assert.equal(
    isOffered(['see_office'], 'see_office', { chat: true, manager: false, gmail: false }),
    false
  );
});

test('isOffered gives an always tool to every run its row allows, and a held tool only to an Odd holding it', () => {
  const job = { chat: false, manager: false, gmail: false };
  const chatRun = { ...job, chat: true };
  // my_tasks sets no condition: even the manager's job run with no Gmail has it.
  assert.equal(isOffered([], 'my_tasks', { ...job, manager: true }), true);
  assert.equal(isOffered([], 'leave_office', chatRun), true);
  assert.equal(isOffered([], 'leave_office', job), false);
  assert.equal(isOffered([], 'leave_office', { ...chatRun, manager: true }), false);
  assert.equal(isOffered([], 'tell_lead', job), false);
  assert.equal(isOffered([], 'tell_lead', chatRun), true);
  assert.equal(isOffered([], 'propose_reply', chatRun), false);
  assert.equal(isOffered([], 'propose_reply', { ...job, gmail: true }), true);
  assert.equal(isOffered([], 'ask_for_standing_yes', job), false);
  assert.equal(isOffered([], 'ask_for_standing_yes', { ...job, write: true }), true);
  assert.equal(isOffered([], 'search_ledger', chatRun), false);
  assert.equal(isOffered(['search_ledger'], 'search_ledger', job), true);
});

test('a hire proposal names every office tool the owner can give, and none every Odd has', async () => {
  const c = await toolServer('tot', { RUN_KEY: 'k-tot-hint' });
  const hire = (await c.listTools()).tools.find((t) => t.name === 'propose_hire');
  const hint = (hire?.inputSchema.properties?.office_tools as { description?: string })
    ?.description;
  const named = hint?.match(/has: (.*)\. Leave/)?.[1].split(', ');
  assert.deepEqual(
    named,
    OFFICE_TOOLS.filter((t) => !t.always).map((t) => t.id)
  );
});

test(
  "the hand_off tool names what each colleague lacks of the lead's tools once, in plain words",
  { skip: TEMP_IN_APPDATA },
  async () => {
    // The tool server's home, holding the folder Lena gave her Odds, so it is
    // shown as ~/x and is on the disk for a colleague that has it.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'oddboro-lacks-')));
    const x = join(home, 'x');
    mkdirSync(x);
    const folders = [{ path: x, write: false }];
    await db.update(staff).set({ web: true, folders }).where(eq(staff.id, 'lead'));
    // Wes has Gmail and the web, so lacks the folder; Fay has Gmail and the folder, so lacks the web.
    await db.insert(staff).values([
      { ...odd('wes', 'Wes'), web: true },
      { ...odd('fay', 'Fay'), folders }
    ]);
    await db
      .insert(grants)
      .values(
        ['wes', 'fay'].map((staffId) => ({ staffId, connectorId: 'gmail', level: 'read' as const }))
      );
    try {
      const t = await handOffTool(await toolServer('lead', { RUN_KEY: 'k-lacks', HOME: home }));
      const lines = (t?.description ?? '').split('\n');
      for (const line of [
        '- wes: Wes, Tester. Tests. Lacks your folder ~/x.',
        '- fay: Fay, Tester. Tests. Lacks the web.',
        '- paige: Paige, Tester. Tests. Lacks your Gmail, the web, and your folder ~/x.'
      ])
        assert.ok(lines.includes(line), `${line}\n${t?.description}`);
    } finally {
      await db.delete(grants).where(inArray(grants.staffId, ['wes', 'fay']));
      await db.delete(staff).where(inArray(staff.id, ['wes', 'fay']));
      await db.update(staff).set({ web: false, folders: [] }).where(eq(staff.id, 'lead'));
      rmSync(home, { recursive: true, force: true });
    }
  }
);

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
/** Fails a refusal that names a file by its path from the office's folder, which hand_off never takes back. */
const notByOfficePath = (r: Awaited<ReturnType<Client['callTool']>>) =>
  assert.doesNotMatch(said(r), /staff[\\/]/, said(r));
/** An Odd of the test's own, with its own folder and its own work, so no test sees another's files. */
async function carrier(id: string) {
  await db.insert(staff).values({ ...odd(id, id), tools: [...STARTER_TOOLS] });
  const c = await toolServer(id, { RUN_KEY: `k-${id}` });
  return {
    c,
    /** Writes a file in this Odd's own folder. */
    own: (path: string, text = 'mine') => put(join(home('staff', id), path), text),
    /** New work this Odd leads, opened by handing Paige its first piece. */
    open: async (title: string) => {
      const r = await c.callTool({
        name: 'hand_off',
        arguments: { to: 'paige', title, brief: 'Start it.' }
      });
      assert.equal(r.isError, undefined, said(r));
      const [t] = await db.select().from(threads).where(eq(threads.title, title));
      return t.id;
    },
    /** Hands Paige a piece of `work`, naming `files`. */
    give: (work: number, title: string, files: string[]) =>
      c.callTool({
        name: 'hand_off',
        arguments: { to: 'paige', title, brief: 'Do it.', continue_work: work, files }
      })
  };
}
const handedOn = (work: number) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.threadId, work), eq(followUps.kind, 'hand_off')));
const handedAs = async (work: number, title: string) =>
  (await handedOn(work)).find((f) => f.handOff?.title === title);

test("a hand-off carrying a file from other work the sender is on puts it in this work's folder", async () => {
  const { open, give } = await carrier('ann');
  const other = await open('Ann other work');
  const here = await open('Ann this work');
  put(join(threadPart(other, 'ann'), 'x.md'), 'from the other work');
  const r = await give(here, 'Use the notes', [workName(other, 'ann/x.md')]);
  assert.equal(r.isError, undefined, said(r));
  const name = `threads-${other}-ann-x.md`;
  assert.equal(readFileSync(join(threadPart(here, 'ann'), name), 'utf8'), 'from the other work');
  assert.deepEqual((await handedAs(here, 'Use the notes'))?.handOff?.files, [`ann/${name}`]);
});

test('a hand-off naming a file the sender cannot read is refused with an error, and nothing is handed on', async (t) => {
  const { c, own, open, give } = await carrier('bea');
  t.after(() => c.close());
  // Bea's own folder is there, as every Odd's is, so only the rule stops each file.
  own('mine.md');
  const here = await open('Bea work');
  const { c: theirServer, open: openTheirs } = await carrier('bea-other');
  t.after(() => theirServer.close());
  const theirs = await openTheirs('Work Bea is not on');
  put(join(threadPart(theirs, 'bea-other'), 'x.md'), 'not for Bea');
  // Another Odd's own file, by its path from Bea's folder and by its full path.
  put(join(home('staff', 'paige'), 'x.md'), "Paige's");
  const before = (await handedOn(here)).length;
  const shut = [
    'nope.md',
    '../paige/x.md',
    join(home('staff', 'paige'), 'x.md'),
    workName(theirs, 'bea-other/x.md'),
    join(threadPart(theirs, 'bea-other'), 'x.md')
  ];
  for (const name of shut) {
    const r = await give(here, 'Use it', [name]);
    assert.equal(r.isError, true, name);
    assert.ok(said(r).startsWith(`Nothing was handed off yet. You cannot read ${name}.`), said(r));
  }
  assert.equal((await handedOn(here)).length, before);
  const works = await workCount();
  const opening = await c.callTool({
    name: 'hand_off',
    arguments: { to: 'paige', title: 'Bea new work', brief: 'Do it.', files: ['nope.md'] }
  });
  assert.equal(opening.isError, true);
  assert.equal(await workCount(), works, 'a refused hand-off opened new work');
});

test('a hand-off naming an instruction file is refused', async () => {
  const { own, open, give } = await carrier('cat');
  const here = await open('Cat work');
  // The last is a backslash in a name on a Mac and Linux, and the Windows path on Windows.
  const names = ['CLAUDE.md', join('.claude', 'x'), join('.Claude', 'y'), '.claude\\w'];
  for (const name of names) own(name);
  const inWork = join(threadPart(here, 'paige'), '.claude', 'z');
  put(inWork, 'in the work');
  const before = (await handedOn(here)).length;
  for (const name of [...names, workName(here, 'paige/.claude/z')]) {
    const r = await give(here, 'Use it', [name]);
    assert.equal(r.isError, true, name);
    assert.ok(said(r).startsWith(`Nothing was handed off yet. ${name} is an instruction`), said(r));
    notByOfficePath(r);
  }
  assert.equal((await handedOn(here)).length, before);
  assert.equal(existsSync(threadPart(here, 'cat')), false, 'an instruction file was copied');
});

test("a full path in the giver's own folder carries that file, and one in this work's folder names the file there", async (t) => {
  const { c, own, open, give } = await carrier('amy');
  t.after(() => c.close());
  const here = await open('Amy work');
  own(join('notes', 'full.md'), 'by its full path');
  put(join(threadPart(here, 'paige'), 'z.md'), 'already here');
  const r = await give(here, 'By full paths', [
    join(home('staff', 'amy'), 'notes', 'full.md'),
    join(threadPart(here, 'paige'), 'z.md')
  ]);
  assert.equal(r.isError, undefined, said(r));
  assert.deepEqual((await handedAs(here, 'By full paths'))?.handOff?.files, [
    'paige/z.md',
    'amy/notes-full.md'
  ]);
  assert.equal(
    readFileSync(join(threadPart(here, 'amy'), 'notes-full.md'), 'utf8'),
    'by its full path'
  );
});

test("the office's own files at the top of the giver's folder never go with a hand-off, by any name, and each refusal names the file as the Odd did", async (t) => {
  const { c, own, open, give } = await carrier('ola');
  t.after(() => c.close());
  const here = await open('Ola work');
  // Upper case too: a Mac's and Windows's disks read it as the same file.
  for (const name of OFFICE_FILE_NAMES) for (const n of [name, name.toUpperCase()]) own(n, '{}');
  const before = (await handedOn(here)).length;
  for (const office of OFFICE_FILE_NAMES)
    for (const name of [
      office,
      `./${office}`,
      office.toUpperCase(),
      join(home('staff', 'ola'), office)
    ]) {
      const r = await give(here, 'Use it', [name]);
      assert.equal(r.isError, true, name);
      assert.ok(
        said(r).startsWith(`Nothing was handed off yet. ${name} is one of the office's own files`),
        said(r)
      );
    }
  assert.equal((await handedOn(here)).length, before);
  assert.equal(existsSync(threadPart(here, 'ola')), false, 'an office file was copied');
  // Below the top, a file of that name is the Odd's own, and goes.
  const below = join('notes', OFFICE_FILE_NAMES[0]);
  own(below, 'notes of its own');
  const r = await give(here, 'Use the notes', [below]);
  assert.equal(r.isError, undefined, said(r));
  assert.deepEqual((await handedAs(here, 'Use the notes'))?.handOff?.files, [
    `ola/notes-${OFFICE_FILE_NAMES[0]}`
  ]);
});

test("the office's own files never go with a hand-off through a folder linked to the giver's own", async (t) => {
  const { c, own, open, give } = await carrier('lin');
  t.after(() => c.close());
  const here = await open('Lin work');
  for (const name of OFFICE_FILE_NAMES) own(name, '{}');
  const mine = home('staff', 'lin');
  // A junction on Windows, which needs no admin.
  symlinkSync(mine, join(mine, 'notes'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = (await handedOn(here)).length;
  for (const office of OFFICE_FILE_NAMES) {
    const name = join('notes', office);
    const r = await give(here, 'Use it', [name]);
    assert.equal(r.isError, true, name);
    assert.ok(
      said(r).startsWith(`Nothing was handed off yet. ${name} is reached through a link`),
      said(r)
    );
  }
  assert.equal((await handedOn(here)).length, before);
  assert.equal(existsSync(threadPart(here, 'lin')), false, 'an office file was copied');
});

test("a hidden file never goes with a hand-off, from the giver's folder or the work's", async (t) => {
  const { c, own, open, give } = await carrier('hid');
  t.after(() => c.close());
  const here = await open('Hid work');
  own('.notes.md');
  own(join('drafts', '.x.md'));
  put(join(threadPart(here, 'paige'), '.y.md'), 'hidden in the work');
  const before = (await handedOn(here)).length;
  for (const name of [
    '.notes.md',
    join('drafts', '.x.md'),
    join(home('staff', 'hid'), '.notes.md'),
    workName(here, 'paige/.y.md')
  ]) {
    const r = await give(here, 'Use it', [name]);
    assert.equal(r.isError, true, name);
    assert.ok(said(r).startsWith(`Nothing was handed off yet. ${name} is a hidden file`), said(r));
  }
  assert.equal((await handedOn(here)).length, before);
  assert.equal(existsSync(threadPart(here, 'hid')), false, 'a hidden file was copied');
});

test(
  "the owner's chat attachments go with a hand-off from the giver's attachments folder, and never through one swapped for a link",
  { skip: TEMP_IN_APPDATA },
  async (t) => {
    const { c, own, open, give } = await carrier('ada');
    t.after(() => c.close());
    const here = await open('Ada work');
    const kept = 'attachments/20261110-081108-35bc-image.png';
    own(kept, 'png');
    const r = await give(here, 'Look at the screenshot', [kept]);
    assert.equal(r.isError, undefined, said(r));
    const lands = 'attachments-20261110-081108-35bc-image.png';
    assert.deepEqual((await handedAs(here, 'Look at the screenshot'))?.handOff?.files, [
      `ada/${lands}`
    ]);
    const part = threadPart(here, 'ada');
    assert.deepEqual(partNow(part), { [lands]: 'png' });

    // The Odd writes its own folder, so it can swap attachments/ for a link:
    // out of its folder, or to another folder in it.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'oddboro-attachments-')));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'out.png'), 'not hers');
    own(join('pics', 'in.png'), 'hers');
    const folder = join(home('staff', 'ada'), 'attachments');
    rmSync(folder, { recursive: true });
    const before = (await handedOn(here)).length;
    for (const [target, named, why] of [
      [outside, 'attachments/out.png', 'You cannot read attachments/out.png'],
      [
        join(home('staff', 'ada'), 'pics'),
        'attachments/in.png',
        'attachments/in.png is reached through a link'
      ]
    ]) {
      symlinkSync(target, folder, 'dir');
      try {
        const linked = await give(here, 'Through a linked folder', [named]);
        assert.equal(linked.isError, true, said(linked));
        assert.ok(said(linked).startsWith(`Nothing was handed off yet. ${why}`), said(linked));
        notByOfficePath(linked);
      } finally {
        unlinkSync(folder);
      }
    }
    assert.equal((await handedOn(here)).length, before);
    assert.deepEqual(partNow(part), { [lands]: 'png' });
  }
);

test('a hand-off carries as many files as an email may, and no more', async (t) => {
  const { c, own, open, give } = await carrier('max');
  t.after(() => c.close());
  const here = await open('Max work');
  const names = Array.from({ length: MAIL_FILES_MAX + 1 }, (_, i) => `f${i}.md`);
  for (const name of names) own(name, name);
  const before = (await handedOn(here)).length;
  const over = await give(here, 'Too many', names);
  assert.equal(over.isError, true, said(over));
  assert.equal((await handedOn(here)).length, before);
  assert.equal(existsSync(threadPart(here, 'max')), false, 'a file was copied');
  const r = await give(here, 'As many as it may', names.slice(0, MAIL_FILES_MAX));
  assert.equal(r.isError, undefined, said(r));
  assert.equal((await handedAs(here, 'As many as it may'))?.handOff?.files?.length, MAIL_FILES_MAX);
});

test(
  'a file in a folder the owner gave the giver never goes with a hand-off, by its full path or its office name',
  { skip: TEMP_IN_APPDATA },
  async (t) => {
    const { c, own, open, give } = await carrier('gil');
    t.after(() => c.close());
    // Its own folder is there, as every Odd's is, so only the rule stops the file.
    own('notes.md');
    const given = realpathSync(mkdtempSync(join(tmpdir(), 'oddboro-given-')));
    t.after(() => rmSync(given, { recursive: true, force: true }));
    writeFileSync(join(given, 'site.md'), 'from the given folder');
    await db
      .update(staff)
      .set({ folders: [{ path: given, write: false }] })
      .where(eq(staff.id, 'gil'));
    const here = await open('Gil work');
    const before = (await handedOn(here)).length;
    for (const name of [join(given, 'site.md'), givenName(basename(given), 'site.md')]) {
      const r = await give(here, 'Use the site', [name]);
      assert.equal(r.isError, true, name);
      assert.ok(said(r).startsWith(`Nothing was handed off yet. You cannot read ${name}`), said(r));
    }
    assert.equal((await handedOn(here)).length, before);
  }
);

test("a file already in this work's folder is listed for the colleague and not copied", async () => {
  const { open, give } = await carrier('dee');
  const here = await open('Dee work');
  put(join(threadPart(here, 'paige'), 'y.md'), 'already here');
  const r = await give(here, 'Check it', [workName(here, 'paige/y.md')]);
  assert.equal(r.isError, undefined, said(r));
  assert.deepEqual((await handedAs(here, 'Check it'))?.handOff?.files, ['paige/y.md']);
  assert.equal(existsSync(threadPart(here, 'dee')), false, 'the file was copied');
});

test("a hand-off a v0.0.9 office stored, naming a file in the giver's own folder, briefs the colleague that the file is no longer there", async () => {
  const { handOffBrief } = await import('../src/hand-offs.ts');
  const { own, open } = await carrier('vic');
  const here = await open('Vic work');
  // Before the upgrade, hand_off stored the path in the giver's own folder and
  // copied the file only as the colleague's run started.
  const kept = 'attachments/20261110-081108-35bc-image.png';
  own(kept, 'png');
  const [row] = await db
    .insert(followUps)
    .values({
      staffId: 'paige',
      kind: 'hand_off',
      threadId: here,
      handOff: { from: 'vic', title: 'Look at the screenshot', brief: 'Say.', files: [kept] }
    })
    .returning();
  try {
    assert.ok(row.handOff && row.threadId);
    const brief = handOffBrief({
      kind: 'hand_off',
      h: row.handOff,
      colleague: { id: 'vic', name: 'Vic' },
      me: 'paige',
      result: null,
      thread: row.threadId
    }).join('\n');
    assert.ok(
      brief.includes(
        `- Files Vic named for this work that are no longer there: ${kept}. Say so in your reply if the work needs them.`
      ),
      brief
    );
    assert.doesNotMatch(brief, /in reach/);
  } finally {
    await db.delete(followUps).where(eq(followUps.id, row.id));
  }
});

test('a hand-off naming two files that would land under one name is refused and names both', async () => {
  const { own, open, give } = await carrier('eve');
  const here = await open('Eve work');
  const nested = join('a', 'b.md');
  own('a-b.md');
  own(nested);
  const before = (await handedOn(here)).length;
  const r = await give(here, 'Use both', ['a-b.md', nested]);
  assert.equal(r.isError, true);
  assert.ok(said(r).includes('a-b.md') && said(r).includes(nested), said(r));
  // Named as the Odd wrote it, not as the office found it in its folder.
  const dotted = await give(here, 'Use both', ['./a-b.md', nested]);
  assert.ok(said(dotted).includes(`one name: ./a-b.md and ${nested}.`), said(dotted));
  // A backslash too: `ownFile` gives Windows's separator there. And case, which
  // a Mac's and Windows's disks do not tell apart.
  own('a\\c.md');
  own('a-c.md');
  own('Q-r.md');
  own(join('q', 'r.md'));
  for (const pair of [
    ['a-c.md', 'a\\c.md'],
    ['Q-r.md', join('q', 'r.md')]
  ]) {
    const again = await give(here, 'Use both', pair);
    assert.equal(again.isError, true, said(again));
  }
  assert.equal(existsSync(threadPart(here, 'eve')), false, 'a file was copied');
  assert.equal((await handedOn(here)).length, before);
});

test('a hand-off is refused when a carried file would land on a file it names from this work', async () => {
  const { own, open, give } = await carrier('fox');
  const here = await open('Fox work');
  own('c.md', 'from the folder');
  put(join(threadPart(here, 'fox'), 'c.md'), 'already here');
  const r = await give(here, 'Use both', ['c.md', workName(here, 'fox/c.md')]);
  assert.equal(r.isError, true);
  assert.equal(readFileSync(join(threadPart(here, 'fox'), 'c.md'), 'utf8'), 'already here');
});

test('a file named twice is carried once', async () => {
  const { own, open, give } = await carrier('gus');
  const here = await open('Gus work');
  own('d.md');
  const r = await give(here, 'Use it', ['d.md', join('.', 'd.md')]);
  assert.equal(r.isError, undefined, said(r));
  assert.deepEqual((await handedAs(here, 'Use it'))?.handOff?.files, ['gus/d.md']);
});

/** Each file in a part of the work with its words, or null when the part is not there. */
const partNow = (part: string) =>
  existsSync(part)
    ? Object.fromEntries(
        readdirSync(part)
          .sort()
          .map((name) => [name, readFileSync(join(part, name), 'utf8')])
      )
    : null;

test('a carried file never replaces a different file already in the work, and nothing in the hand-off is copied', async (t) => {
  const { c, own, open, give } = await carrier('ivy');
  // Each tool server holds up to 5 of the office database's 64 connections
  // until it stops, and a later test's server is cut off once they run out.
  t.after(() => c.close());
  const here = await open('Ivy work');
  const part = threadPart(here, 'ivy');
  put(join(part, 'notes.md'), 'DRAFT BUILT ON THE WORK');
  own('notes.md', 'old scratch in own folder');
  own('fresh.md', 'new');
  const before = (await handedOn(here)).length;
  // The last is named as the Odd wrote it, not as the office found it in its folder.
  for (const files of [['notes.md'], ['fresh.md', 'notes.md'], ['./notes.md']]) {
    const r = await give(here, 'Use the notes', files);
    assert.equal(r.isError, true, said(r));
    assert.ok(
      said(r).startsWith(
        `Nothing was handed off yet. ${files.at(-1)} would land on ${workName(here, 'ivy/notes.md')},`
      ),
      said(r)
    );
    notByOfficePath(r);
  }
  assert.deepEqual(partNow(part), { 'notes.md': 'DRAFT BUILT ON THE WORK' });
  assert.equal((await handedOn(here)).length, before);

  // A file from other work is named by its path in that work.
  const other = await open('Ivy other work');
  const from = workName(other, 'ivy/x.md');
  put(join(threadPart(other, 'ivy'), 'x.md'), 'from the other work');
  const lands = `threads-${other}-ivy-x.md`;
  put(join(part, lands), 'A DIFFERENT DRAFT');
  const fromWork = await give(here, 'Use the other notes', [from]);
  assert.equal(fromWork.isError, true, said(fromWork));
  assert.ok(
    said(fromWork).startsWith(
      `Nothing was handed off yet. ${from} would land on ${workName(here, `ivy/${lands}`)},`
    ),
    said(fromWork)
  );
  assert.equal(readFileSync(join(part, lands), 'utf8'), 'A DIFFERENT DRAFT');
  assert.equal((await handedOn(here)).length, before);
});

test('a carried file with the same words as the one already in the work is not copied again, and the hand-off goes', async (t) => {
  const { c, own, open, give } = await carrier('jay');
  t.after(() => c.close());
  const here = await open('Jay work');
  own('same.md', 'the same words');
  const first = await give(here, 'First', ['same.md']);
  assert.equal(first.isError, undefined, said(first));
  const again = await give(here, 'Again', ['same.md']);
  assert.equal(again.isError, undefined, said(again));
  assert.deepEqual((await handedAs(here, 'Again'))?.handOff?.files, ['jay/same.md']);
  assert.deepEqual(partNow(threadPart(here, 'jay')), { 'same.md': 'the same words' });
});

test(
  'a hand-off naming a file the office cannot open is refused by the name the Odd gave it, and the work is left as it was',
  {
    skip:
      (process.platform === 'win32' && 'Windows keeps letting the owner read a file after chmod') ||
      (process.getuid?.() === 0 && 'root reads a file with no permissions')
  },
  async (t) => {
    const { c, own, open, give } = await carrier('kit');
    t.after(() => c.close());
    const here = await open('Kit work');
    const part = threadPart(here, 'kit');
    const locked = join(home('staff', 'kit'), 'locked.md');
    own('a.md', 'readable');
    own('locked.md', 'the earlier words');
    const before = (await handedOn(here)).length;
    const refused = async (files: string[]) => {
      const r = await give(here, 'Use it', files);
      assert.equal(r.isError, true, said(r));
      assert.ok(
        said(r).startsWith('Nothing was handed off yet. The office cannot open locked.md to copy'),
        said(r)
      );
      notByOfficePath(r);
      for (const full of [home(), realpathSync(home())])
        assert.ok(!said(r).includes(full), `a full path: ${said(r)}`);
      assert.doesNotMatch(said(r), /EACCES/);
    };
    try {
      chmodSync(locked, 0o000);
      await refused(['locked.md']);
      await refused(['a.md', 'locked.md']);
      assert.equal(partNow(part), null, 'a refused hand-off made the part or copied into it');

      chmodSync(locked, 0o644);
      const first = await give(here, 'First', ['locked.md']);
      assert.equal(first.isError, undefined, said(first));
      const handed = (await handedOn(here)).length;
      own('locked.md', 'the new words');
      chmodSync(locked, 0o000);
      await refused(['a.md', 'locked.md']);
      assert.deepEqual(partNow(part), { 'locked.md': 'the earlier words' });
      assert.equal((await handedOn(here)).length, handed);
      assert.equal(handed, before + 1);
    } finally {
      chmodSync(locked, 0o644);
    }

    // A file from other work is named by its path in that work.
    const other = await open('Kit other work');
    const shut = join(threadPart(other, 'kit'), 'shut.md');
    put(shut, 'from the other work');
    const from = workName(other, 'kit/shut.md');
    try {
      chmodSync(shut, 0o000);
      const r = await give(here, 'Use the other', [from]);
      assert.equal(r.isError, true, said(r));
      assert.ok(
        said(r).startsWith(`Nothing was handed off yet. The office cannot open ${from} to copy`),
        said(r)
      );
    } finally {
      chmodSync(shut, 0o644);
    }
  }
);

test(
  "a hand-off never copies through a link in the sender's part of the work",
  { skip: TEMP_IN_APPDATA },
  async () => {
    const { own, open, give } = await carrier('hal');
    const here = await open('Hal work');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'oddboro-carry-')));
    try {
      own('e.md', 'the new words');
      const target = join(outside, 'target.md');
      writeFileSync(target, 'untouched');
      const part = threadPart(here, 'hal');
      mkdirSync(part, { recursive: true });
      symlinkSync(target, join(part, 'e.md'));
      const r = await give(here, 'Through a file link', ['e.md']);
      assert.equal(r.isError, true, said(r));
      assert.ok(said(r).startsWith('Nothing was handed off yet. e.md would land on'), said(r));
      notByOfficePath(r);
      assert.equal(readFileSync(target, 'utf8'), 'untouched');
      assert.equal(lstatSync(join(part, 'e.md')).isSymbolicLink(), true, 'the link was changed');

      rmSync(part, { recursive: true });
      symlinkSync(outside, part);
      const before = (await handedOn(here)).length;
      const linked = await give(here, 'Through a folder link', ['e.md']);
      assert.equal(linked.isError, true);
      assert.ok(said(linked).startsWith('Nothing was handed off yet.'), said(linked));
      assert.equal(existsSync(join(outside, 'e.md')), false, 'copied through the link');
      assert.equal((await handedOn(here)).length, before, 'the hand-off was not taken back');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }
);

test(
  'a link in the work to a file with the same words as the carried one is refused, never taken as carried before',
  { skip: TEMP_IN_APPDATA },
  async (t) => {
    const { c, own, open, give } = await carrier('lou');
    t.after(() => c.close());
    const here = await open('Lou work');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'oddboro-same-')));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    own('f.md', 'the same words');
    const target = join(outside, 'target.md');
    writeFileSync(target, 'the same words');
    const part = threadPart(here, 'lou');
    mkdirSync(part, { recursive: true });
    symlinkSync(target, join(part, 'f.md'));
    const before = (await handedOn(here)).length;
    const r = await give(here, 'Through a link to the same words', ['f.md']);
    assert.equal(r.isError, true, said(r));
    assert.ok(said(r).startsWith('Nothing was handed off yet. f.md would land on'), said(r));
    notByOfficePath(r);
    assert.equal(lstatSync(join(part, 'f.md')).isSymbolicLink(), true, 'the link was changed');
    assert.equal((await handedOn(here)).length, before);
  }
);

test("an Odd that names GitHub's address with a key header gets the catalog's GitHub, which signs in", async () => {
  const c = await toolServer('jo', { RUN_KEY: 'k-jo-github' });
  const r = await c.callTool({
    name: 'ask_for_access',
    arguments: {
      connector: 'https://api.githubcopilot.com/mcp/x/repos/readonly',
      level: 'read',
      why: 'Read the repositories.',
      key_header: 'Authorization'
    }
  });
  assert.equal(r.isError, undefined, said(r));
  const [github] = await db.select().from(connectors).where(eq(connectors.id, 'github'));
  assert.deepEqual(github?.config, { url: 'https://api.githubcopilot.com/mcp/', oauth: true });
  const asked = (await raisedBy('jo')).asks.filter((a) => a.kind === 'access');
  assert.deepEqual(
    asked.map((a) => a.access?.connector),
    ['github']
  );
  const byAddress = (await db.select().from(connectors)).filter((x) => x.id !== 'github');
  assert.ok(!byAddress.some((x) => x.config.url?.includes('githubcopilot')));
});

test("resume_at after_task parks on another work's open task, and refuses one done, on this work, or missing", async () => {
  await db.insert(staff).values(odd('tess', 'Tess'));
  const work = async (title: string) =>
    (await db.insert(threads).values({ title, hubId: 'tess', holderId: 'tess' }).returning())[0];
  const mine = await work('Plan the menu');
  const other = await work('Book the caterer');
  const task = async (title: string, threadId: number, status: 'open' | 'done' = 'open') =>
    (
      await db
        .insert(tasks)
        // A done task has its time, as the office ends one.
        .values({
          staffId: 'tess',
          title,
          why: 'w',
          steps: [],
          threadId,
          status,
          doneAt: status === 'done' ? new Date() : null
        })
        .returning()
    )[0];
  const open = await task('Proof the menu', other.id);
  const done = await task('Print the menu', other.id, 'done');
  const onThis = await task('Taste the soup', mine.id);
  const c = await toolServer('tess', { RUN_KEY: 'k-tess', THREAD_ID: String(mine.id) });
  const park = (after_task: number, more: Record<string, unknown> = {}) =>
    c.callTool({ name: 'resume_at', arguments: { after_task, ...more } });
  const parkedOn = async (id: number) =>
    (await db.select().from(threads).where(eq(threads.id, id)))[0].resumeOnTask;

  const refusals: [Awaited<ReturnType<typeof park>>, RegExp][] = [
    [await park(done.id), /Already finished: do it now, in this run\./],
    [await park(onThis.id), /That task is on this work/],
    [await park(999_999), /There is no task 999999\./],
    [await park(open.id, { in_minutes: 5 }), /after_task alone/],
    [await park(open.id, { at: '18:50' }), /after_task alone/]
  ];
  for (const [r, why] of refusals) {
    assert.equal(r.isError, true, said(r));
    assert.match(said(r), why);
    assert.equal(await parkedOn(mine.id), null, said(r));
  }

  const r = await park(open.id);
  assert.ok(!r.isError, said(r));
  assert.match(
    said(r),
    new RegExp(`Work ${mine.id} picks back up when .+ drops "Proof the menu"\\.`)
  );
  assert.equal(await parkedOn(mine.id), open.id);

  const notMine = await toolServer('tess', { RUN_KEY: 'k-tess-2', THREAD_ID: String(sale.id) });
  const led = await notMine.callTool({ name: 'resume_at', arguments: { after_task: open.id } });
  assert.equal(led.isError, true, said(led));
  assert.match(said(led), /has ended, or is not work you lead/);
  assert.equal(await parkedOn(sale.id), null);
});
