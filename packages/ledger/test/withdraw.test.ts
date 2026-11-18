// An Odd takes its own open asks and tasks off the owner's desk with
// `withdraw`, only in a chat, on the owner's word. A withdrawn ask is a no by
// the office: no run reads it for a lesson. The tool runs in the tool
// server's own process, as the office starts one for each run.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db, sql, toolServer } from './tool-server.ts';

const { asks, followUps, staff, tasks } = await import('../src/schema.ts');
const { eq } = await import('drizzle-orm');
const O = await import('../src/office.ts');

const odd = (id: string, name: string) => ({
  id,
  name,
  role: 'Mail Clerk',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`
});

beforeEach(async () => {
  for (const t of ['ledger', 'follow_ups', 'attachments', 'tasks', 'asks'])
    await sql.unsafe(`delete from ${t}`);
  await sql`delete from staff`;
  await db.insert(staff).values([odd('wren', 'Wren'), odd('ada', 'Ada')]);
});

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[])[0]?.text ?? '', error: r.isError === true };
}
const tools = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
const askOf = async (id: number) => (await db.select().from(asks).where(eq(asks.id, id)))[0];
const taskOf = async (id: number) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const raise = async (staffId: string, title: string) =>
  (await O.raiseAsk(staffId, { title, why: 'w', ifApproved: 'i' })).ask;
const said = { OWNER_SAID: 'Can you clear all your open asks on my desk please?' };

test('withdraw is offered only in a chat, on the owner’s words', async () => {
  assert.ok(!(await tools(await toolServer('wren', { RUN_KEY: 'k-1' }))).includes('withdraw'));
  assert.ok(
    (await tools(await toolServer('wren', { RUN_KEY: 'k-2', ...said }))).includes('withdraw')
  );
});

test("withdraw takes the Odd's own open asks and tasks off the desk, as the office's no, and leaves everything else", async () => {
  const one = await raise('wren', 'Archive one');
  const two = await raise('wren', 'Archive two');
  const decided = await raise('wren', 'Already answered');
  await O.decideAsk(decided.id, 'approve', null);
  const ada = await raise('ada', 'Ada’s own');
  const [mine] = await db
    .insert(tasks)
    .values({ staffId: 'wren', title: 'Sign in', why: 'w', steps: [] })
    .returning();

  const c = await toolServer('wren', { RUN_KEY: 'k-3', ...said });
  const r = await call(c, 'withdraw', {
    asks: [one.id, two.id, decided.id, ada.id, 999],
    tasks: [mine.id]
  });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, new RegExp(`Took off .*ask ${one.id}, ask ${two.id}, task ${mine.id}`));
  assert.match(r.text, new RegExp(`left as it is: ask ${decided.id}, ask ${ada.id}, ask 999`));

  for (const id of [one.id, two.id]) {
    const a = await askOf(id);
    assert.equal(a.status, 'denied');
    assert.match(a.reason ?? '', /Wren took it off your desk, as you said in chat: "Can you clear/);
  }
  assert.equal((await taskOf(mine.id)).status, 'dropped');
  // What it did not own or that was already answered stays as it was.
  assert.equal((await askOf(decided.id)).status, 'approved');
  assert.equal((await askOf(ada.id)).status, 'open');
  // The office's no starts no run to read it for a lesson.
  const denied = await db.select().from(followUps).where(eq(followUps.kind, 'denied'));
  assert.deepEqual(denied, []);
});

test('withdraw with nothing named is refused', async () => {
  const c = await toolServer('wren', { RUN_KEY: 'k-4', ...said });
  const r = await call(c, 'withdraw', {});
  assert.equal(r.error, true);
});

test('withdrawing an ask or task the owner already answered closes nothing and says so', async () => {
  const asked = await raise('wren', 'Book the hall');
  await O.decideAsk(asked.id, 'approve', null);
  const [given] = await db
    .insert(tasks)
    .values({ staffId: 'wren', title: 'Sign in', why: 'w', steps: [] })
    .returning();
  assert.equal(await O.finishTask(given.id, true, 'Signed in.'), true);
  const before = { ask: await askOf(asked.id), task: await taskOf(given.id) };

  assert.equal(await O.withdrawAsk(asked.id, 'Wren took it off.'), false);
  assert.equal(await O.withdrawTask(given.id, 'Wren took it off.'), false);
  assert.deepEqual(await askOf(asked.id), before.ask);
  assert.deepEqual(await taskOf(given.id), before.task);

  const c = await toolServer('wren', { RUN_KEY: 'k-5', ...said });
  const r = await call(c, 'withdraw', { asks: [asked.id], tasks: [given.id] });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^Nothing was taken off\./);
  assert.match(
    r.text,
    new RegExp(`Not yours or not open, so left as it is: ask ${asked.id}, task ${given.id}\\.`)
  );
});
