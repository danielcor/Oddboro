// Email replies an Odd proposes (`propose_reply`), and whose work an item came
// from (`via`). The tool server (src/mcp.ts) runs in a process of its own, as
// the office starts one for each run, over the office's own database. It
// holds: propose_reply is offered only to an Odd that holds the tool and Gmail
// at any level; each call raises one `reply` ask, going back where it came
// from like raise_ask's; only the office's send or save approves one, with one
// ledger line; replies are never twins, and a second reply to one email is
// refused, even from two runs at once; and raise_ask, give_owner_a_task and
// propose_reply store the colleague the office names in `VIA`. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db, sql, toolServer } from './tool-server.ts';

const { connectors, grants, staff } = await import('../src/schema.ts');
const { eq } = await import('drizzle-orm');
const { STARTER_TOOLS } = await import('../src/tools.ts');
const { approveReply, ask, decideAsk, desk, raiseAsk } = await import('../src/office.ts');
const { handOff } = await import('../src/hand-offs.ts');

const odd = (id: string, name: string, tools = STARTER_TOOLS) => ({
  id,
  name,
  role: 'Mail clerk',
  remit: 'Mail.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`,
  tools
});
await db.insert(staff).values([
  odd('lead', 'Marshall'),
  odd('paige', 'Paige'),
  odd('nora', 'Nora'),
  // Hired from a proposal that listed only some office tools.
  odd('tess', 'Tess', ['search_ledger'])
]);
await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, 'gmail'));
// Paige and Tess read Gmail; Nora holds only Drive.
await db.insert(grants).values([
  { staffId: 'paige', connectorId: 'gmail', level: 'read' },
  { staffId: 'tess', connectorId: 'gmail', level: 'act' },
  { staffId: 'nora', connectorId: 'google-drive', level: 'read' }
]);

const offered = async (c: Client) =>
  (await c.listTools()).tools.find((t) => t.name === 'propose_reply');
/** The first text a tool call returned. */
const said = (r: Awaited<ReturnType<Client['callTool']>>) =>
  (r.content as { type: string; text: string }[])[0]?.text ?? '';
const REPLY = {
  gmail_thread_id: 't1',
  in_reply_to: 'm1',
  to: ['Ada <ada@example.com>'],
  subject: 'Re: Lunch on Friday?',
  body: 'Hi Ada,\n\nFriday works.',
  summary: 'Ada asks whether Friday lunch works.',
  why: 'She asked yesterday.'
};
/** The id in "Reply 12 is on ...". */
const idOf = (text: string) => Number(/^Reply (\d+) /.exec(text)?.[1]);

test('propose_reply is offered to every Odd that holds Gmail, at any level, whatever tools it was hired with', async () => {
  const t = await offered(await toolServer('paige', { RUN_KEY: 'k-paige' }));
  assert.ok(t, 'Paige reads Gmail and holds the tool');
  for (const words of [
    'One reply per call',
    'Nothing is sent until',
    'Never put reply drafts in a file',
    'may edit the recipients, subject and body'
  ])
    assert.ok(t.description?.includes(words), words);
  assert.equal(await offered(await toolServer('nora', { RUN_KEY: 'k-nora' })), undefined);
  assert.ok(
    await offered(await toolServer('tess', { RUN_KEY: 'k-tess' })),
    'a hire list cannot leave it out'
  );
});

test("a reply carries files from the Odd's own folder only, each under the name a recipient sees", async () => {
  const { home } = await import('../src/home.ts');
  const dir = join(home('staff', 'paige'), 'attachments');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '20261110-081108-35bc-image.png'), 'png');
  writeFileSync(join(home('staff', 'paige'), 'chat.jsonl'), '{}');
  mkdirSync(home('staff', 'nora'), { recursive: true });
  writeFileSync(join(home('staff', 'nora'), 'notes.md'), 'Nora’s');
  const c = await toolServer('paige', { RUN_KEY: 'k-files' });
  const withFiles = (attachments: string[], thread: string) =>
    c.callTool({
      name: 'propose_reply',
      arguments: { ...REPLY, gmail_thread_id: thread, in_reply_to: `m-${thread}`, attachments }
    });
  const r = await withFiles(['attachments/20261110-081108-35bc-image.png'], 't-files');
  assert.notEqual(r.isError, true, said(r));
  assert.deepEqual((await ask(idOf(said(r))))?.reply?.attachments, [
    {
      path: 'attachments/20261110-081108-35bc-image.png',
      name: 'image.png',
      mediaType: 'image/png',
      size: 3
    }
  ]);
  // Another Odd's file, the office's own, a hidden one and a missing one never go.
  for (const [n, bad] of [
    '../nora/notes.md',
    join(home('staff', 'nora'), 'notes.md'),
    'chat.jsonl',
    '.claude/settings.json',
    'nope.png'
  ].entries()) {
    const no = await withFiles([bad], `t-bad-${n}`);
    assert.equal(no.isError, true, bad);
    assert.match(said(no), /is not a file in your folder/, bad);
  }
});

test("an email never carries one of the office's own files at the top of an Odd's folder, a persona's session among them", async () => {
  const { home, OFFICE_FILE_NAMES } = await import('../src/home.ts');
  const { mailAttachment } = await import('../src/mail-attachments.ts');
  mkdirSync(home('staff', 'paige'), { recursive: true });
  assert.ok(OFFICE_FILE_NAMES.includes('persona-session.json'));
  // The same file under another name goes, so only the name turns these down.
  writeFileSync(home('staff', 'paige', 'kept.json'), '{}');
  const kept = mailAttachment('paige', 'kept.json');
  assert.ok(!('problem' in kept), JSON.stringify(kept));
  for (const name of OFFICE_FILE_NAMES) {
    writeFileSync(home('staff', 'paige', name), '{}');
    assert.deepEqual(
      mailAttachment('paige', name),
      { problem: `${name} is not a file in your folder.` },
      name
    );
  }
});

test('each call raises one reply ask with the email, and the owner sees it on the desk', async () => {
  const c = await toolServer('paige', { RUN_KEY: 'k-one' });
  const r = await c.callTool({ name: 'propose_reply', arguments: REPLY });
  assert.notEqual(r.isError, true, said(r));
  assert.match(said(r), /Nothing is sent until they send it/);
  const a = await ask(idOf(said(r)));
  assert.equal(a?.kind, 'reply');
  assert.equal(a?.title, 'Reply to Ada <ada@example.com>: Re: Lunch on Friday?');
  assert.deepEqual(a?.reply, {
    gmailThreadId: 't1',
    inReplyTo: 'm1',
    to: ['Ada <ada@example.com>'],
    cc: [],
    subject: 'Re: Lunch on Friday?',
    body: 'Hi Ada,\n\nFriday works.\n\nSent from Oddboro',
    summary: 'Ada asks whether Friday lunch works.',
    connector: 'gmail'
  });
  assert.equal(a?.via, null);
  // A body that already ends with the footer keeps one.
  const signed = await c.callTool({
    name: 'propose_reply',
    arguments: {
      ...REPLY,
      gmail_thread_id: 't-signed',
      in_reply_to: 'm-signed',
      body: 'Hi Ada.\n\nSent from [Oddboro](https://oddboro.com)\n'
    }
  });
  assert.equal(
    (await ask(idOf(said(signed))))?.reply?.body,
    'Hi Ada.\n\nSent from [Oddboro](https://oddboro.com)\n'
  );
  const bad = await c.callTool({ name: 'propose_reply', arguments: { ...REPLY, draft: 'x' } });
  assert.equal(bad.isError, true, 'a key it does not take is refused');
});

test('a second reply to the same email is refused naming the open one; revises replaces it; and a sent one closes the email', async () => {
  const c = await toolServer('paige', { RUN_KEY: 'k-twice' });
  const email = { ...REPLY, gmail_thread_id: 't-twice', in_reply_to: 'm-twice' };
  const first = idOf(said(await c.callTool({ name: 'propose_reply', arguments: email })));
  const again = await c.callTool({ name: 'propose_reply', arguments: email });
  assert.equal(again.isError, true, said(again));
  assert.equal(
    said(again),
    `Nothing went on the owner's desk. Your reply #${first} to this email is already there. To change it, call propose_reply again with revises: ${first}.`
  );
  const revised = await c.callTool({
    name: 'propose_reply',
    arguments: { ...email, body: 'Hi Ada,\n\nFriday at noon works.', revises: first }
  });
  assert.notEqual(revised.isError, true, said(revised));
  const second = idOf(said(revised));
  assert.equal((await ask(first))?.status, 'revise');
  await assert.rejects(decideAsk(second, 'approve', null), /Send the reply/);
  const a = (await ask(second))!;
  const sent = { ...a.reply!, sent: { action: 'send' as const, at: '2026-11-07', gmailId: 'g1' } };
  assert.equal(await approveReply(second, sent), true);
  const lines = await sql<{ title: string; body: string }[]>`
    select title, body from ledger where ask_id = ${second}`;
  assert.equal(lines.length, 1, 'one ledger line');
  assert.equal(lines[0].title, `Sent: ${a.title}`);
  assert.match(lines[0].body, /^To Ada <ada@example\.com>\. Subject: Re: Lunch on Friday\?\./);
  assert.deepEqual(
    [...(await sql`select kind from follow_ups where ask_id = ${second}`)],
    [{ kind: 'answered' }],
    'no run carries a reply out: the Odd, on no work, hears it was sent, once'
  );
  const late = await c.callTool({ name: 'propose_reply', arguments: email });
  assert.equal(late.isError, true, said(late));
  assert.equal(
    said(late),
    `Nothing went on the owner's desk. That email already has a reply: your reply #${second} was sent. Do not propose another.`
  );
});

test('two runs proposing a reply to the same email at once leave one on the desk', async () => {
  const [one, two] = await Promise.all([
    toolServer('paige', { RUN_KEY: 'k-race-1' }),
    toolServer('paige', { RUN_KEY: 'k-race-2' })
  ]);
  const email = { ...REPLY, gmail_thread_id: 't-race', in_reply_to: 'm-race' };
  const results = await Promise.all(
    [one, two, one, two].map((c) => c.callTool({ name: 'propose_reply', arguments: email }))
  );
  assert.equal(results.filter((r) => r.isError !== true).length, 1, results.map(said).join('\n'));
  const rows = await sql`
    select id from asks where staff_id = 'paige' and reply->>'gmailThreadId' = 't-race'`;
  assert.equal(rows.length, 1);
});

test('a reply raised on a hand-off goes back to the lead once it is sent or saved', async () => {
  const h = await handOff({
    from: 'lead',
    to: 'paige',
    work: { title: 'Answer the inbox', brief: 'Draft replies.' },
    thread: { title: 'The inbox' }
  });
  assert.ok('id' in h, JSON.stringify(h));
  const c = await toolServer('paige', {
    RUN_KEY: 'k-hand-off',
    HAND_OFF_ID: String(h.id),
    THREAD_ID: String(h.thread)
  });
  const id = idOf(
    said(
      await c.callTool({
        name: 'propose_reply',
        arguments: { ...REPLY, gmail_thread_id: 't-hand-off', in_reply_to: 'm-hand-off' }
      })
    )
  );
  const a = (await ask(id))!;
  assert.equal(a.handOffId, h.id);
  assert.equal(a.threadId, h.thread);
  await approveReply(id, { ...a.reply!, sent: { action: 'draft', at: 'now', gmailId: 'd1' } });
  const [back] = await sql<{ note: string }[]>`
    select note from follow_ups where staff_id = 'lead' and kind = 'handed_back' and thread_id = ${h.thread}`;
  assert.ok(back, 'the answer went back to the lead');
  assert.match(back.note, /saved to Gmail drafts "Reply to Ada/);
});

test('raise_ask, give_owner_a_task and propose_reply store the colleague whose work it came from', async () => {
  const c = await toolServer('lead', { RUN_KEY: 'k-via', VIA: 'paige' });
  const raised = said(
    await c.callTool({
      name: 'raise_ask',
      arguments: {
        title: 'Unsubscribe you from the sale emails',
        why: 'Paige found ten.',
        if_approved: 'I do it.',
        work: null
      }
    })
  );
  const askId = Number(/^Ask (\d+) /.exec(raised)?.[1]);
  assert.equal((await ask(askId))?.via, 'paige');
  const given = said(
    await c.callTool({
      name: 'give_owner_a_task',
      arguments: {
        title: 'Fill in the brackets',
        why: 'Only you know.',
        steps: ['Read it.'],
        work: null
      }
    })
  );
  const taskId = Number(/^Task (\d+) /.exec(given)?.[1]);
  const [task] = await sql<{ via: string }[]>`select via from tasks where id = ${taskId}`;
  assert.equal(task.via, 'paige');
  // Marshall holds no Gmail: give him read, so he is offered the tool.
  await db.insert(grants).values({ staffId: 'lead', connectorId: 'gmail', level: 'read' });
  const withGmail = await toolServer('lead', { RUN_KEY: 'k-via-2', VIA: 'paige' });
  // He leads the inbox work from the hand-off above, so he names the work it is for, or none.
  const id = idOf(
    said(await withGmail.callTool({ name: 'propose_reply', arguments: { ...REPLY, work: null } }))
  );
  assert.equal((await ask(id))?.via, 'paige');
  const plain = await toolServer('lead', { RUN_KEY: 'k-no-via' });
  const own = said(
    await plain.callTool({
      name: 'raise_ask',
      arguments: {
        title: 'Archive the old receipts',
        why: 'They pile up.',
        if_approved: 'I do it.',
        work: null
      }
    })
  );
  assert.equal((await ask(Number(/^Ask (\d+) /.exec(own)?.[1])))?.via, null);
});

test("an Odd's new version of its own open reply takes the old one's place on the desk", async () => {
  const reply = (body: string) => ({
    to: ['nate@example.com'],
    cc: [],
    subject: 'Re: Monday',
    body,
    summary: 'Nate asks about Monday.'
  });
  const before = await raiseAsk('paige', {
    kind: 'reply',
    title: 'Reply to Nate',
    why: 'w',
    ifApproved: 'i',
    reply: reply('Yes.')
  });
  const after = await raiseAsk('paige', {
    kind: 'reply',
    title: 'Reply to Nate',
    why: 'w',
    ifApproved: 'i',
    revises: before.ask.id,
    reply: reply('Yes, 12:30 works.')
  });
  const shown = (await desk()).asks.map((x) => x.id);
  assert.ok(shown.includes(after.ask.id));
  assert.ok(!shown.includes(before.ask.id));
  assert.equal((await ask(before.ask.id))?.status, 'revise');
});

test('a lead that leaves out work still gives a task, on no work', async () => {
  // The lead leads the inbox work from the hand-offs above, so its tools take
  // work. A session that kept the tools' older form sends none at all.
  const c = await toolServer('lead', { RUN_KEY: 'k-no-work' });
  const given = said(
    await c.callTool({
      name: 'give_owner_a_task',
      arguments: {
        title: 'Tell me your favourite animal',
        why: 'Only you know.',
        steps: ['Say it.']
      }
    })
  );
  const taskId = Number(/^Task (\d+) /.exec(given)?.[1]);
  assert.ok(taskId, `the task went on the desk: ${given}`);
  const [task] = await sql<
    { thread_id: number | null }[]
  >`select thread_id from tasks where id = ${taskId}`;
  assert.equal(task.thread_id, null);
});
