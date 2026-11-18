// The owner changes an Odd's level and office tools in the Settings tab, and
// each change writes its own access line in the Ledger, in the tab's words.
// An Odd asks for a higher level with ask_for_level, or for office tools with
// ask_for_office_tool, in the tool server's own process, as the office starts
// one for each run; the owner's yes makes the Settings tab's own change in the
// transaction that approves the ask, with the tab's ledger words, and starts
// the run that needs it. Two runs asking for no more are twins.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db, sql, toolServer } from './tool-server.ts';

const { asks, followUps, ledger, owner, staff } = await import('../src/schema.ts');
const { eq } = await import('drizzle-orm');
const O = await import('../src/office.ts');
const { setActsOnHandOffs, setPermission, setTool } = O;
const { GRANTABLE_TOOLS } = await import('../src/tools.ts');
const { MANAGER_ROLE } = await import('../src/managers.ts');

const odd = (id: string, name: string, more: Partial<typeof staff.$inferInsert> = {}) => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  tools: [],
  desk: `You are ${name}.`,
  ...more
});
// The owner passed the Act check (act-check.test.ts), so a raise to Act goes
// through. No name, so the owner is still "the owner".
await db.insert(owner).values({ name: '', actCheckAt: new Date() });
await db
  .insert(staff)
  .values([
    odd('ada', 'Ada'),
    odd('sage', 'Sage'),
    odd('max', 'Max', { role: MANAGER_ROLE }),
    odd('pat', 'Pat', { package: { slug: 'pat', version: 1, disclosure: 'Pat is an AI persona.' } })
  ]);

beforeEach(async () => {
  await sql`delete from ledger`;
  await sql`delete from follow_ups`;
  await sql`delete from asks`;
  await db.update(staff).set({ permission: 'draft', tools: [], actsOnHandOffs: false });
});

const lines = () =>
  db
    .select({ kind: ledger.kind, actor: ledger.actor, title: ledger.title, body: ledger.body })
    .from(ledger)
    .orderBy(ledger.id);
const ada = async () => (await db.select().from(staff).where(eq(staff.id, 'ada')))[0];
const sage = async () => (await db.select().from(staff).where(eq(staff.id, 'sage')))[0];
const row = async (id: number) => (await db.select().from(asks).where(eq(asks.id, id)))[0];
const titles = async () => (await db.select().from(ledger)).map((l) => l.title);
const runsOf = async (id: number) =>
  (await db.select().from(followUps).where(eq(followUps.askId, id))).map((f) => f.kind);

/** The first text a tool call returned, and whether it was an error. */
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  return {
    text: (r.content as { text: string }[])[0]?.text ?? '',
    error: r.isError === true
  };
}
const level = (staffId: string, l: 'draft' | 'act', place: { handOffId?: number } = {}) =>
  O.raiseAsk(staffId, {
    kind: 'level',
    title: 'Raise',
    why: 'To send the replies.',
    ifApproved: 'i',
    level: l,
    ...place
  }).then((r) => r.ask);
const tools = (
  staffId: string,
  officeTools: (typeof GRANTABLE_TOOLS)[number][],
  place: { handOffId?: number } = {}
) =>
  O.raiseAsk(staffId, {
    kind: 'office_tool',
    title: 'Turn on',
    why: 'To read the office.',
    ifApproved: 'i',
    officeTools,
    ...place
  }).then((r) => r.ask);

test("the Settings tab's level and tool changes still write their own access line", async () => {
  await setPermission('ada', 'act');
  assert.equal((await ada()).permission, 'act');
  await setPermission('ada', 'read');
  assert.equal((await ada()).permission, 'read');
  await setTool('ada', 'office_report', true);
  assert.deepEqual((await ada()).tools, ['office_report']);
  await setTool('ada', 'office_report', false);
  assert.deepEqual((await ada()).tools, []);
  assert.deepEqual(await lines(), [
    { kind: 'access', actor: 'owner', title: 'Raised Ada from draft to act', body: '' },
    { kind: 'access', actor: 'owner', title: 'Lowered Ada from act to read', body: '' },
    {
      kind: 'access',
      actor: 'owner',
      title: 'Gave Ada Office report',
      body: 'Sees what every Odd did: jobs, runs, asks and tasks.'
    },
    {
      kind: 'access',
      actor: 'owner',
      title: 'Took Office report from Ada',
      body: 'Sees what every Odd did: jobs, runs, asks and tasks.'
    }
  ]);
});

test('a move up to Act keeps the choice for work from colleagues the owner made with it, with its own line', async () => {
  // Left out, the stored choice stays: off for every Odd to start with.
  await setPermission('ada', 'act');
  assert.equal((await ada()).actsOnHandOffs, false);
  await setPermission('ada', 'draft');
  await setPermission('ada', 'act', true);
  assert.equal((await ada()).actsOnHandOffs, true);
  // Below Act the choice stays as it was, and the next raise takes a new one.
  await setPermission('ada', 'read');
  assert.equal((await ada()).actsOnHandOffs, true);
  await setPermission('ada', 'act', false);
  assert.equal((await ada()).actsOnHandOffs, false);
  // A move down never takes one.
  await setPermission('ada', 'draft', true);
  assert.equal((await ada()).actsOnHandOffs, false);
  assert.deepEqual(await titles(), [
    'Raised Ada from draft to act',
    'Lowered Ada from act to draft',
    'Raised Ada from draft to act',
    'Let Ada act on its own on work from colleagues',
    'Lowered Ada from act to read',
    'Raised Ada from read to act',
    'Set Ada to ask first on work from colleagues',
    'Lowered Ada from act to draft'
  ]);
});

test('the Settings tab changes the choice for work from colleagues only for an Odd at Act', async () => {
  assert.deepEqual(await setActsOnHandOffs('ada', true), {
    refused: 'Put Ada at Act first. Below Act, work from colleagues cannot pass its level anyway.'
  });
  assert.equal((await ada()).actsOnHandOffs, false);
  await db.update(staff).set({ permission: 'act' }).where(eq(staff.id, 'ada'));
  assert.equal(await setActsOnHandOffs('ada', true), undefined);
  assert.equal((await ada()).actsOnHandOffs, true);
  // The same choice again writes nothing.
  await setActsOnHandOffs('ada', true);
  await setActsOnHandOffs('ada', false);
  assert.equal((await ada()).actsOnHandOffs, false);
  assert.deepEqual(await lines(), [
    {
      kind: 'access',
      actor: 'owner',
      title: 'Let Ada act on its own on work from colleagues',
      body: ''
    },
    {
      kind: 'access',
      actor: 'owner',
      title: 'Set Ada to ask first on work from colleagues',
      body: ''
    }
  ]);
});

test('a level or tool the Odd already has writes no line', async () => {
  await setPermission('ada', 'draft');
  await setTool('ada', 'office_report', false);
  assert.deepEqual(await lines(), []);
});

test('a tool the owner does not grant is refused, and nothing changes', async () => {
  await assert.rejects(setTool('ada', 'my_access', true));
  assert.deepEqual((await ada()).tools, []);
  assert.deepEqual(await lines(), []);
});

test('an Odd asks for a higher level in one call, and is refused one it already holds', async () => {
  const c = await toolServer('sage', { RUN_KEY: 'k-level' });
  const first = await call(c, 'ask_for_level', { level: 'act', why: 'To send the replies.' });
  assert.equal(first.error, false, first.text);
  const [a] = await db.select().from(asks).where(eq(asks.kind, 'level'));
  assert.equal(a.level, 'act');
  assert.equal(a.title, 'Raise Sage from Draft to Act');
  assert.equal(
    a.ifApproved,
    "The office raises Sage from Draft to Act, as the Settings tab does, and Sage picks up the work with it. At Act, Sage uses the tools you connected for Sage at read and write without asking you first, in chats with you, in Sage's jobs and in work you approve. Right after you approve, you choose whether work another Odd hands Sage runs at Draft, where each change waits for your yes, or at Act. A thread Sage picks back up still runs at Draft. Sage stays at Act until you lower it in the Settings tab."
  );
  const held = await call(c, 'ask_for_level', { level: 'draft', why: 'Again.' });
  assert.equal(held.error, true);
  assert.equal(held.text, "Nothing went on the owner's desk. Your level is Draft already.");
});

test('an Odd at Read asking for Draft tells the owner what Draft lets it do', async () => {
  await db.update(staff).set({ permission: 'read' }).where(eq(staff.id, 'ada'));
  const c = await toolServer('ada', { RUN_KEY: 'k-read' });
  const asked = await call(c, 'ask_for_level', { level: 'draft', why: 'To draft the replies.' });
  assert.equal(asked.error, false, asked.text);
  const [a] = await db.select().from(asks).where(eq(asks.kind, 'level'));
  assert.equal(a.title, 'Raise Ada from Read to Draft');
  assert.equal(
    a.ifApproved,
    'The office raises Ada from Read to Draft, as the Settings tab does, and Ada picks up the work with it. At Draft, Ada prepares changes outside the office, and each one waits for your yes. Ada stays at Draft until you lower it in the Settings tab.'
  );
});

test("a run serving a colleague's hand-off, held to Draft, is told why raising its level would not change it", async () => {
  await db.update(staff).set({ permission: 'act' }).where(eq(staff.id, 'sage'));
  for (const [env, said] of [
    [
      { CEILING: 'draft', HAND_OFF_ID: '7' },
      "Nothing went on the owner's desk. Your level is Act already. Work another Odd hands you runs at Draft whatever your level, since the owner chose to be asked first there, so raising it does not change this run."
    ],
    [{ CEILING: 'draft' }, "Nothing went on the owner's desk. Your level is Act already."],
    [{ HAND_OFF_ID: '7' }, "Nothing went on the owner's desk. Your level is Act already."]
  ] as const) {
    const c = await toolServer('sage', { RUN_KEY: 'k-capped', ...env });
    const held = await call(c, 'ask_for_level', { level: 'act', why: 'To send the replies.' });
    assert.equal(held.error, true, held.text);
    assert.equal(held.text, said, JSON.stringify(env));
  }
  assert.deepEqual(await db.select().from(asks), []);
});

test("a level ask raised in a colleague's hand-off says the run after the yes works at Draft at most", async () => {
  const c = await toolServer('sage', { RUN_KEY: 'k-hand-off', HAND_OFF_ID: '7' });
  const asked = await call(c, 'ask_for_level', { level: 'act', why: 'To send the replies.' });
  assert.equal(asked.error, false, asked.text);
  const [a] = await db.select().from(asks).where(eq(asks.kind, 'level'));
  assert.equal(
    asked.text,
    `Ask ${a.id} is on the owner's desk. When they say yes, your level is Act, and a new run of yours picks up the work; it serves a colleague's hand-off, so it works at Draft at most, unless the owner lets you act on your own on work from colleagues when they say yes. Check my_asks later for their decision.`
  );
});

test('a level ask raised in its own work says the run after the yes works at the new level', async () => {
  const c = await toolServer('sage', { RUN_KEY: 'k-own' });
  const asked = await call(c, 'ask_for_level', { level: 'act', why: 'To send the replies.' });
  assert.equal(asked.error, false, asked.text);
  const [a] = await db.select().from(asks).where(eq(asks.kind, 'level'));
  assert.equal(
    asked.text,
    `Ask ${a.id} is on the owner's desk. When they say yes, a new run of yours picks up the work at Act. Check my_asks later for their decision.`
  );
});

test('an Odd asks for any office tool the Settings tab grants, and only the ones it lacks reach the desk', async () => {
  assert.ok(GRANTABLE_TOOLS.length > 0);
  await db
    .update(staff)
    .set({ tools: ['search_ledger'] })
    .where(eq(staff.id, 'sage'));
  const c = await toolServer('sage', { RUN_KEY: 'k-tools' });
  const listed = (await c.listTools()).tools.find((t) => t.name === 'ask_for_office_tool');
  const input = listed?.inputSchema.properties?.tools as { items: { enum: string[] } };
  assert.deepEqual(input.items.enum, GRANTABLE_TOOLS);
  const asked = await call(c, 'ask_for_office_tool', {
    tools: ['remove_odd', 'search_ledger'],
    why: 'To help the owner tidy up.'
  });
  assert.equal(asked.error, false, asked.text);
  const [a] = await db.select().from(asks).where(eq(asks.kind, 'office_tool'));
  assert.deepEqual(a.officeTools, ['remove_odd']);
  assert.equal(a.title, 'Turn on Remove Odds');
  assert.equal(
    a.ifApproved,
    'The office turns on Remove Odds for Sage, as the Settings tab does, and Sage picks up the work with it.\n- Remove Odds: Asks you to let another Odd go from the office. It goes only on your yes.'
  );
  const held = await call(c, 'ask_for_office_tool', { tools: ['search_ledger'], why: 'Again.' });
  assert.equal(held.error, true, held.text);
  assert.equal(held.text, "Nothing went on the owner's desk. You already have Search the ledger.");
});

test('the Office Manager and a persona Odd may each ask for a higher level and for office tools', async () => {
  for (const id of ['max', 'pat']) {
    const c = await toolServer(id, { RUN_KEY: `k-${id}` });
    const l = await call(c, 'ask_for_level', { level: 'act', why: 'To send the replies.' });
    assert.equal(l.error, false, l.text);
    const t = await call(c, 'ask_for_office_tool', { tools: ['office_report'], why: 'To see.' });
    assert.equal(t.error, false, t.text);
    const kinds = (await db.select().from(asks).where(eq(asks.staffId, id))).map((a) => a.kind);
    assert.deepEqual(kinds.sort(), ['level', 'office_tool'], id);
  }
});

test("a yes to a level ask sets exactly that level with the Settings tab's ledger line, and starts the work that waited", async () => {
  const a = await level('sage', 'act');
  await O.decideAsk(a.id, 'approve', null);
  assert.equal((await sage()).permission, 'act');
  assert.equal((await row(a.id)).status, 'approved');
  assert.deepEqual(await titles(), ['Raised Sage from draft to act']);
  assert.deepEqual(await runsOf(a.id), ['carry_out']);
});

test('a yes to a level ask for Act takes the choice for work from colleagues with it, and writes its line', async () => {
  const a = await level('sage', 'act');
  await O.decideAsk(a.id, 'approve', null, false, false, true);
  assert.equal((await sage()).permission, 'act');
  assert.equal((await sage()).actsOnHandOffs, true);
  assert.deepEqual(await titles(), [
    'Raised Sage from draft to act',
    'Let Sage act on its own on work from colleagues'
  ]);
  assert.deepEqual(await runsOf(a.id), ['carry_out']);
});

test('a yes to a level ask the Odd already passed changes nothing and still starts the work', async () => {
  const a = await level('sage', 'draft');
  await db.update(staff).set({ permission: 'act' }).where(eq(staff.id, 'sage'));
  await O.decideAsk(a.id, 'approve', null);
  assert.equal((await sage()).permission, 'act');
  assert.equal((await row(a.id)).status, 'approved');
  assert.deepEqual(await runsOf(a.id), ['carry_out']);
});

test("a yes to an office tool ask turns on exactly those tools with the Settings tab's ledger line, and starts the work", async () => {
  await db
    .update(staff)
    .set({ tools: ['search_ledger'] })
    .where(eq(staff.id, 'sage'));
  const a = await tools('sage', ['list_goals', 'office_report']);
  await O.decideAsk(a.id, 'approve', null);
  assert.deepEqual([...(await sage()).tools].sort(), [
    'list_goals',
    'office_report',
    'search_ledger'
  ]);
  assert.deepEqual(await titles(), ['Gave Sage Office report and All goals']);
  assert.deepEqual(await runsOf(a.id), ['carry_out']);
});

test("a yes whose grant fails leaves the ask open and the Odd's tools as they were", async () => {
  const a = await tools('sage', ['office_report']);
  await db
    .update(asks)
    .set({ officeTools: ['raise_ask'] })
    .where(eq(asks.id, a.id));
  await assert.rejects(O.decideAsk(a.id, 'approve', null), /not an office tool you grant/);
  assert.equal((await row(a.id)).status, 'open');
  assert.deepEqual((await sage()).tools, []);
  assert.deepEqual(await titles(), []);
});

test('two runs asking for no more are twins: the desk shows the first, and one yes answers both', async () => {
  for (const [first, twin] of [
    [await level('sage', 'act'), await level('sage', 'draft', { handOffId: 7 })],
    [
      await tools('sage', ['office_report', 'list_goals']),
      await tools('sage', ['office_report'], { handOffId: 8 })
    ]
  ]) {
    const shown = (await O.desk()).asks.map((x) => x.id);
    assert.ok(shown.includes(first.id) && !shown.includes(twin.id), 'the twin waits behind it');
    await O.decideAsk(first.id, 'approve', null);
    assert.equal((await row(twin.id)).status, 'approved');
    const runs = await db.select().from(followUps).where(eq(followUps.askId, twin.id));
    assert.equal(runs.length, 1, 'one run, the hand-off twin, does the work');
    assert.deepEqual(await runsOf(first.id), [], first.kind);
    assert.deepEqual(
      (await O.standsFor(await row(twin.id))).map((x) => x.id),
      [first.id],
      `the ${first.kind} run is told it stands for the first`
    );
  }
});

test('Deny leaves the level and tools as they were', async () => {
  const l = await level('sage', 'act');
  const t = await tools('sage', ['office_report']);
  await O.decideAsk(l.id, 'deny', 'Not now.');
  await O.decideAsk(t.id, 'deny', 'Not now.');
  const after = await sage();
  assert.equal(after.permission, 'draft');
  assert.deepEqual(after.tools, []);
  assert.equal((await row(l.id)).status, 'denied');
  assert.equal((await row(t.id)).status, 'denied');
});
