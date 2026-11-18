// More than one Google account. Each is a connector of its own (`gmail`,
// `gmail-2`), found by `config.google`, never by its id. An Odd asks for
// another account with `ask_for_access` and `another_account`; two such asks
// are twins, and a yes makes the connector and its connect task. With two
// Gmail accounts, `propose_reply` and `propose_filter` must say which one,
// and one email or filter in each account is its own. The tool server
// (src/mcp.ts) runs in a process of its own, as the office starts one for
// each run. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db, toolServer } from './tool-server.ts';

const { asks, connectors, followUps, grants, staff, tasks } = await import('../src/schema.ts');
const { eq } = await import('drizzle-orm');
const { STARTER_TOOLS } = await import('../src/tools.ts');
const { addGoogleAccount, ask, connector, decideAsk, desk, googleConnectors, signedInAs } =
  await import('../src/office.ts');

const odd = (id: string, name: string) => ({
  id,
  name,
  role: 'Mail clerk',
  remit: 'Mail.',
  variant: 'a',
  portrait: 'a',
  permission: 'act' as const,
  desk: `You are ${name}.`,
  tools: [...STARTER_TOOLS, 'ask_for_access']
});
await db.insert(staff).values([odd('ivy', 'Ivy'), odd('jo', 'Jo')]);
await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, 'gmail'));
await signedInAs('gmail', 'ada@example.com');
await db.insert(connectors).values({
  id: 'brain',
  name: 'Brain',
  description: 'A hosted memory.',
  kind: 'http',
  config: { url: 'https://brain.example/mcp' }
});
await db.insert(grants).values([
  { staffId: 'ivy', connectorId: 'gmail', level: 'read' },
  { staffId: 'jo', connectorId: 'gmail', level: 'read' }
]);

/** The first text a tool call returned. */
const said = (r: Awaited<ReturnType<Client['callTool']>>) =>
  (r.content as { type: string; text: string }[])[0]?.text ?? '';
const idOf = (text: string) => Number(/^\w+ (\d+) /.exec(text)?.[1]);
const ANOTHER = {
  connector: 'gmail',
  level: 'read',
  why: 'Bea wants her own inbox read too.',
  another_account: true
};

test('every office starts with one Gmail and one Google Drive, each saying which product it is', async () => {
  assert.equal((await connector('gmail'))?.config.google, 'gmail');
  assert.equal((await connector('google-drive'))?.config.google, 'drive');
  const drive = await addGoogleAccount('drive');
  assert.deepEqual(
    { id: drive.id, name: drive.name, config: drive.config },
    {
      id: 'google-drive-2',
      name: 'Google Drive',
      config: { oauth: 'google', google: 'drive' }
    }
  );
  assert.deepEqual(
    (await googleConnectors('drive')).map((c) => c.id),
    ['google-drive', 'google-drive-2']
  );
  await db.delete(connectors).where(eq(connectors.id, 'google-drive-2'));
});

test('an Odd asks for another Gmail account: two such asks are twins, and a yes makes the connector and its connect task', async () => {
  const first = await (
    await toolServer('ivy', { RUN_KEY: 'k-a' })
  ).callTool({ name: 'ask_for_access', arguments: ANOTHER });
  assert.notEqual(first.isError, true, said(first));
  const twin = await (
    await toolServer('ivy', { RUN_KEY: 'k-b' })
  ).callTool({ name: 'ask_for_access', arguments: ANOTHER });
  const a = (await ask(idOf(said(first))))!;
  const b = (await ask(idOf(said(twin))))!;
  assert.equal(a.title, 'Connect another Gmail account (read)');
  assert.deepEqual(a.access, { connector: 'gmail', level: 'read', another: 'gmail' });
  const shown = (await desk()).asks.map((x) => x.id);
  assert.ok(shown.includes(a.id) && !shown.includes(b.id), 'the twin waits behind the first');

  await decideAsk(a.id, 'approve', null);
  const made = (await googleConnectors('gmail')).map((c) => c.id);
  assert.deepEqual(made, ['gmail', 'gmail-2']);
  for (const id of [a.id, b.id]) {
    const x = (await ask(id))!;
    assert.equal(x.status, 'approved');
    assert.equal(x.access?.connector, 'gmail-2', 'the ask names the new connector');
  }
  const [g] = await db.select().from(grants).where(eq(grants.connectorId, 'gmail-2'));
  assert.equal(g?.staffId, 'ivy');
  const connect = await db.select().from(tasks).where(eq(tasks.askId, a.id));
  assert.deepEqual(
    connect.map((t) => t.title),
    ['Connect another Gmail account for Ivy']
  );
});

test('another account needs a first one, connected or asked for: alone it is refused', async () => {
  const c = await toolServer('jo', { RUN_KEY: 'k-c' });
  const drive = await c.callTool({
    name: 'ask_for_access',
    arguments: { ...ANOTHER, connector: 'google-drive' }
  });
  assert.equal(drive.isError, true);
  assert.match(said(drive), /Ask for google-drive without another_account first/);
  const brain = await c.callTool({
    name: 'ask_for_access',
    arguments: { ...ANOTHER, connector: 'brain' }
  });
  assert.equal(brain.isError, true);
  assert.match(said(brain), /only for Gmail and Google Drive/);
  // A plain ask for Gmail is not a twin of one for another account.
  const plain = await c.callTool({
    name: 'ask_for_access',
    arguments: { connector: 'gmail', level: 'read', why: 'w' }
  });
  const more = await c.callTool({ name: 'ask_for_access', arguments: ANOTHER });
  const shown = (await desk()).asks.map((x) => x.id);
  assert.ok(shown.includes(idOf(said(plain))) && shown.includes(idOf(said(more))));
});

const REPLY = {
  to: ['Cy <cy@example.com>'],
  subject: 'Re: Hello',
  body: 'Hi Cy.',
  summary: 'Cy says hello.',
  why: 'Cy wrote.'
};
const FILTER = { from: 'news@shop.example.com', skip_inbox: true, summary: 's', why: 'w' };

test('with two Gmail accounts, propose_reply lists both and must be told which; the reply keeps it', async () => {
  await signedInAs('gmail-2', 'bea@example.com');
  const c = await toolServer('ivy', { RUN_KEY: 'k-d' });
  const t = (await c.listTools()).tools.find((x) => x.name === 'propose_reply')!;
  const arg = (t.inputSchema.properties as Record<string, { description?: string }>).account;
  assert.match(arg.description!, /gmail \(ada@example\.com\), gmail-2 \(bea@example\.com\)/);
  assert.ok(t.inputSchema.required?.includes('account'), 'required with two');

  const none = await c.callTool({ name: 'propose_reply', arguments: REPLY });
  assert.equal(none.isError, true, 'refused without an account');
  const r = await c.callTool({
    name: 'propose_reply',
    arguments: { ...REPLY, gmail_thread_id: 't9', account: 'gmail-2' }
  });
  assert.notEqual(r.isError, true, said(r));
  const reply = (await ask(idOf(said(r))))?.reply;
  assert.equal(reply?.connector, 'gmail-2');
  assert.equal(reply?.account, 'bea@example.com');
});

test('with one Gmail account, propose_reply takes it without being told', async () => {
  const c = await toolServer('jo', { RUN_KEY: 'k-e' });
  const t = (await c.listTools()).tools.find((x) => x.name === 'propose_reply')!;
  assert.ok(!t.inputSchema.required?.includes('account'));
  const r = await c.callTool({
    name: 'propose_reply',
    arguments: { ...REPLY, gmail_thread_id: 't-jo' }
  });
  assert.notEqual(r.isError, true, said(r));
  const reply = (await ask(idOf(said(r))))?.reply;
  assert.equal(reply?.connector, 'gmail');
  assert.equal(reply?.account, 'ada@example.com');
});

test('one email or filter in each account is its own; the same one twice in one account is refused', async () => {
  const c = await toolServer('ivy', { RUN_KEY: 'k-f' });
  const same = { ...REPLY, gmail_thread_id: 't9' };
  const other = await c.callTool({
    name: 'propose_reply',
    arguments: { ...same, account: 'gmail' }
  });
  assert.notEqual(other.isError, true, "thread t9 in Ada's mailbox is another email");
  const again = await c.callTool({
    name: 'propose_reply',
    arguments: { ...same, account: 'gmail-2' }
  });
  assert.equal(again.isError, true);
  assert.match(said(again), /already there/);

  const f1 = await c.callTool({
    name: 'propose_filter',
    arguments: { ...FILTER, account: 'gmail' }
  });
  const f2 = await c.callTool({
    name: 'propose_filter',
    arguments: { ...FILTER, account: 'gmail-2' }
  });
  assert.notEqual(f1.isError, true, said(f1));
  assert.notEqual(f2.isError, true, said(f2));
  assert.equal((await ask(idOf(said(f2))))?.filter?.connector, 'gmail-2');
  const f3 = await c.callTool({
    name: 'propose_filter',
    arguments: { ...FILTER, account: 'gmail-2' }
  });
  assert.equal(f3.isError, true);
  const open = await db.select().from(asks).where(eq(asks.kind, 'filter'));
  assert.equal(open.length, 2);
});

test('an Odd that needs two mailboxes asks for both at once, before either is connected', async () => {
  const c = await toolServer('jo', { RUN_KEY: 'k-both' });
  const first = await c.callTool({
    name: 'ask_for_access',
    arguments: { connector: 'google-drive', level: 'read', why: 'Both drives.' }
  });
  assert.notEqual(first.isError, true, said(first));
  const second = await c.callTool({
    name: 'ask_for_access',
    arguments: { ...ANOTHER, connector: 'google-drive', why: 'Both drives.' }
  });
  assert.notEqual(second.isError, true, said(second));
  const titles = (await desk()).asks
    .filter((a) => a.staffId === 'jo' && a.title.includes('Google Drive'))
    .map((a) => a.title);
  assert.deepEqual(titles.sort(), [
    'Connect Google Drive (read)',
    'Connect another Google Drive account (read)'
  ]);
});

test('two connection-only requests and a separate approval start the proposed work once', async () => {
  const client = await toolServer('jo', { RUN_KEY: 'k-one-action' });
  const ids: number[] = [];
  for (const connector of ['gmail', 'brain']) {
    await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, connector));
    const reply = await client.callTool({
      name: 'ask_for_access',
      arguments: {
        connector,
        level: 'write',
        why: 'For a separately proposed invoice.',
        connect_only: true
      }
    });
    assert.notEqual(reply.isError, true, said(reply));
    const id = idOf(said(reply));
    assert.match((await ask(id))!.ifApproved, /only connects the tool/);
    ids.push(id);
  }
  const reply = await client.callTool({
    name: 'raise_ask',
    arguments: {
      title: 'Save the invoice total',
      why: 'The receipts are ready.',
      if_approved: 'Record the total in the prepared services.'
    }
  });
  assert.notEqual(reply.isError, true, said(reply));
  const action = idOf(said(reply));
  for (const id of [...ids, action]) await decideAsk(id, 'approve', null);
  const work = await db.select().from(followUps).where(eq(followUps.staffId, 'jo'));
  assert.deepEqual(
    work.filter((f) => f.askId && [...ids, action].includes(f.askId)).map((f) => f.askId),
    [action]
  );
  const access = await db.select().from(grants).where(eq(grants.staffId, 'jo'));
  assert.deepEqual(
    access
      .filter((g) => g.level === 'act')
      .map((g) => g.connectorId)
      .sort(),
    ['brain', 'gmail']
  );
});
