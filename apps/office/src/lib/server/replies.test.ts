// Replies an Odd proposed, as the owner sends them from the Desk
// (`/api/asks/[id]/reply`, replies.ts): the office calls Gmail itself, with
// its own token, on the owner's click alone. Send goes in the thread as a
// reply, Save leaves a Gmail draft, a Gmail failure leaves the ask open, and
// the owner's own changes start the same `edited` run a save in the viewer
// does. A lead's pick-up of a colleague's result tells its tool server whose
// work it was (`VIA`). Google is a stand-in `fetch`. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import type { MailAttachment } from '@oddboro/ledger';
import { chatOf, gave, L, runOf, secrets } from './office-under-test.ts';

process.env.ODDBORO_GOOGLE_CLIENT_SECRET = 'a-client-secret-for-tests';
const route = await import('../../routes/api/asks/[id]/reply/+server.ts');
const originalRoute = await import('../../routes/api/asks/[id]/original/+server.ts');
const askRoute = await import('../../routes/api/asks/[id]/+server.ts');

const ACCESS = 'ya29.an-access-token-for-tests';
const signIn = () =>
  secrets.set(
    'gmail:oauth',
    JSON.stringify({
      tokens: { access_token: ACCESS, refresh_token: '1//a-refresh', expires_in: 3600 },
      savedAt: Date.now()
    })
  );
signIn();
await L.connectorReady('gmail', ['get_thread'], ['get_thread']);
await L.pg`insert into grants ${L.pg({ staff_id: 'paige', connector_id: 'gmail', level: 'read' })}`;

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
/**
 * The email this test's reply answers. Each test answers its own, since the
 * ledger refuses a second reply to one email.
 */
let email = { thread: 't0', message: 'm0' };
let emails = 0;
const b64 = (s: string) => Buffer.from(s).toString('base64url');
/** What reached Google: each address, its method, its body and the token it carried. */
let google: { url: string; method: string; body: string; auth: string | null }[] = [];
/** How Google answers a send or a draft; a test that wants a failure sets it. */
let fails: Response | undefined;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(GMAIL) && !url.startsWith(UPLOAD)) return realFetch(input, init);
  const method = init.method ?? 'GET';
  google.push({
    url,
    method,
    body: String(init.body ?? ''),
    auth: new Headers(init.headers).get('Authorization')
  });
  if (method === 'POST' && fails) return fails;
  const path = url.split('?')[0];
  if (path.endsWith('/messages/send'))
    return Response.json({ id: 'm-sent', threadId: email.thread });
  if (path.endsWith('/drafts')) return Response.json({ id: 'd-1' });
  if (url.includes(`/messages/${email.message}?`))
    return Response.json({
      id: email.message,
      payload: {
        headers: [
          { name: 'Subject', value: 'Lunch on Friday?' },
          { name: 'Message-ID', value: `<${email.message}@mail.example.com>` }
        ]
      }
    });
  if (url.includes(`/threads/${email.thread}`))
    return Response.json({
      id: email.thread,
      messages: [
        {
          id: email.message,
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'Ada <ada@example.com>' },
              { name: 'Date', value: 'Fri, 6 Nov 2026 09:00:00 -0800' },
              { name: 'Subject', value: 'Lunch on Friday?' },
              { name: 'Message-ID', value: `<${email.message}@mail.example.com>` }
            ],
            body: { data: b64('Are you free for lunch on Friday?') }
          }
        },
        {
          id: 'm2',
          labelIds: ['DRAFT'],
          payload: { mimeType: 'text/plain', headers: [], body: { data: b64('half a draft') } }
        }
      ]
    });
  return Response.json({});
}) as typeof fetch;

beforeEach(() => {
  google = [];
  fails = undefined;
  emails += 1;
  email = { thread: `t${emails}`, message: `m${emails}` };
});

const PROPOSED = {
  to: ['Ada <ada@example.com>'],
  cc: [],
  subject: 'Re: Lunch on Friday?',
  body: 'Hi Ada,\n\nFriday works. Noon?\n\nJosh',
  summary: 'Ada asks whether Friday lunch works.'
};
/** A reply Paige proposes, on the desk. */
async function proposed(): Promise<number> {
  const { ask } = await L.raiseAsk('paige', {
    kind: 'reply',
    title: 'Reply to Ada: Re: Lunch on Friday?',
    why: 'Ada asked about lunch.',
    ifApproved: 'You send it.',
    reply: { ...PROPOSED, gmailThreadId: email.thread, inReplyTo: email.message }
  });
  return ask.id;
}
const post = (id: number, body: unknown) =>
  route.POST({
    params: { id: String(id) },
    request: new Request(`http://office/api/asks/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  } as unknown as Parameters<typeof route.POST>[0]);
/** What the route said when it refused. */
async function refused(r: unknown): Promise<{ status: number; message: string }> {
  try {
    await r;
  } catch (e) {
    const h = e as { status: number; body: { message: string } };
    return { status: h.status, message: h.body.message };
  }
  assert.fail('the route took it');
}
/** The raw email Gmail was given, decoded. */
const rawOf = (body: string) => {
  const b = JSON.parse(body) as { raw?: string; message?: { raw: string } };
  return Buffer.from(b.raw ?? b.message!.raw, 'base64url').toString();
};
const edits = async (id: number) =>
  L.pg<{ edit: { path: string; before: string } }[]>`
    select edit from follow_ups where kind = 'edited' and staff_id = 'paige'
      and edit->>'path' = ${`replies/${id}.md`}`;

test('Send sends it in the thread as a reply to the message, then approves the ask with what went', async () => {
  const id = await proposed();
  await post(id, { action: 'send', ...PROPOSED });
  const sent = google.find((g) => g.url === `${GMAIL}/messages/send`);
  assert.ok(sent, 'Gmail was asked to send it');
  assert.equal(sent.auth, `Bearer ${ACCESS}`);
  assert.equal(JSON.parse(sent.body).threadId, email.thread);
  const raw = rawOf(sent.body);
  const answers = `<${email.message}@mail\\.example\\.com>`;
  assert.match(raw, new RegExp(`^In-Reply-To: ${answers}$`, 'm'));
  assert.match(raw, new RegExp(`^References: ${answers}$`, 'm'));
  assert.match(raw, /^To: Ada <ada@example\.com>$/m);
  assert.ok(!google.some((g) => g.url.endsWith('/drafts')));
  const a = (await L.ask(id))!;
  assert.equal(a.status, 'approved');
  assert.equal(a.reply?.sent?.action, 'send');
  assert.equal(a.reply?.sent?.gmailId, 'm-sent');
  const lines = await L.pg<{ title: string }[]>`select title from ledger where ask_id = ${id}`;
  assert.deepEqual(
    lines.map((l) => l.title),
    [`Sent: ${a.title}`],
    'one ledger line says it was sent'
  );
  // Nothing was changed, so there is nothing to learn from.
  assert.equal((await edits(id)).length, 0);
  // No run carries a reply out: the office already did. On no work, the Odd hears so, once.
  assert.deepEqual(
    [...(await L.pg`select kind from follow_ups where ask_id = ${id}`)],
    [{ kind: 'answered' }]
  );
});

test("the Odd's files go with it, less any the owner took off, through Gmail's upload address; the owner cannot add one", async () => {
  const dir = L.home('staff', 'paige');
  mkdirSync(join(dir, 'attachments'), { recursive: true });
  writeFileSync(join(dir, 'attachments', '20261110-081108-35bc-image.png'), 'one');
  writeFileSync(join(dir, 'notes.pdf'), 'two');
  const files = [
    L.mailAttachment('paige', 'attachments/20261110-081108-35bc-image.png'),
    L.mailAttachment('paige', 'notes.pdf')
  ] as MailAttachment[];
  const { ask } = await L.raiseAsk('paige', {
    kind: 'reply',
    title: 'Reply to Ada: Re: Lunch on Friday?',
    why: 'Ada asked about lunch.',
    ifApproved: 'You send it.',
    reply: {
      ...PROPOSED,
      gmailThreadId: email.thread,
      inReplyTo: email.message,
      attachments: files
    }
  });
  // The owner took notes.pdf off, and named a file the Odd never attached.
  await post(ask.id, {
    action: 'send',
    ...PROPOSED,
    attachments: ['attachments/20261110-081108-35bc-image.png', 'secret.md']
  });
  const sent = google.find((g) => g.url === `${UPLOAD}/messages/send?uploadType=multipart`);
  assert.ok(sent, 'Gmail was given it at its upload address');
  assert.ok(!google.some((g) => g.url === `${GMAIL}/messages/send`));
  assert.ok(sent.body.includes(`{"threadId":"${email.thread}"}`));
  assert.ok(sent.body.includes('Content-Type: message/rfc822'));
  assert.ok(sent.body.includes('filename="image.png"'));
  assert.ok(sent.body.includes(Buffer.from('one').toString('base64')));
  assert.ok(!sent.body.includes('notes.pdf'), 'a file the owner took off went');
  assert.ok(!sent.body.includes('secret.md'), 'a file the Odd never attached went');
  const a = (await L.ask(ask.id))!;
  assert.equal(a.status, 'approved');
  assert.deepEqual(
    a.reply?.attachments?.map((f) => f.name),
    ['image.png']
  );
});

test('Save to Gmail drafts leaves a draft in the thread and sends nothing', async () => {
  const id = await proposed();
  await post(id, { action: 'draft', ...PROPOSED, cc: ['Bea <bea@example.com>'] });
  assert.ok(!google.some((g) => g.url.endsWith('/messages/send')), 'nothing was sent');
  const draft = google.find((g) => g.url === `${GMAIL}/drafts`);
  assert.ok(draft);
  assert.equal(JSON.parse(draft.body).message.threadId, email.thread);
  assert.match(rawOf(draft.body), /^Cc: Bea <bea@example\.com>$/m);
  const a = (await L.ask(id))!;
  assert.equal(a.status, 'approved');
  assert.deepEqual(a.reply?.cc, ['Bea <bea@example.com>']);
  assert.equal(a.reply?.sent?.action, 'draft');
  const [line] = await L.pg<{ title: string }[]>`select title from ledger where ask_id = ${id}`;
  assert.equal(line.title, `Saved to Gmail drafts: ${a.title}`);
});

test('a Gmail failure leaves the ask open and says so in plain words', async () => {
  const id = await proposed();
  fails = Response.json({ error: { message: 'Invalid To header' } }, { status: 400 });
  const r = await refused(post(id, { action: 'send', ...PROPOSED }));
  assert.equal(r.status, 502);
  assert.equal(r.message, 'Nothing was sent. Gmail said: Invalid To header');
  const a = (await L.ask(id))!;
  assert.equal(a.status, 'open');
  assert.equal(a.reply?.sent, undefined);
  assert.equal(
    (await L.pg`select 1 from ledger where ask_id = ${id}`).length,
    0,
    'no line in the ledger'
  );
});

test("the owner's changes to the body start the edited run, with the Odd's version before", async () => {
  const id = await proposed();
  const body = 'Hi Ada,\n\nFriday works. See you at noon.\n\nJosh';
  await post(id, { action: 'send', ...PROPOSED, body });
  const [run] = await edits(id);
  assert.ok(run, 'an edited follow-up started');
  assert.equal(run.edit.before, `Subject: ${PROPOSED.subject}\n\n${PROPOSED.body}\n`);
  const kept = readFileSync(join(L.home('staff', 'paige'), 'replies', `${id}.md`), 'utf8');
  assert.equal(kept, `Subject: ${PROPOSED.subject}\n\n${body}\n`);
  assert.equal((await L.ask(id))?.reply?.body, body);
});

test('a footer the owner deleted stays deleted: Send sends the body exactly as they left it', async () => {
  const { ask } = await L.raiseAsk('paige', {
    kind: 'reply',
    title: 'Reply to Ada: Re: Lunch on Friday?',
    why: 'Ada asked about lunch.',
    ifApproved: 'You send it.',
    reply: {
      ...PROPOSED,
      body: `${PROPOSED.body}\n\nSent from Oddboro`,
      gmailThreadId: email.thread,
      inReplyTo: email.message
    }
  });
  await post(ask.id, { action: 'send', ...PROPOSED });
  const sent = google.find((g) => g.url === `${GMAIL}/messages/send`)!;
  const raw = rawOf(sent.body);
  assert.match(raw, /^Content-Type: text\/plain; charset="UTF-8"$/m, 'one plain part');
  assert.equal(
    Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(),
    PROPOSED.body.replace(/\n/g, '\r\n')
  );
  assert.equal((await L.ask(ask.id))?.reply?.body, PROPOSED.body);
});

test('a reply is approved only by sending or saving it', async () => {
  const id = await proposed();
  const r = await refused(
    askRoute.POST({
      params: { id: String(id) },
      request: new Request(`http://office/api/asks/${id}`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' })
      })
    } as unknown as Parameters<typeof askRoute.POST>[0])
  );
  assert.equal(r.status, 400);
  await assert.rejects(L.decideAsk(id, 'approve', null), /Send the reply/);
  assert.equal((await L.ask(id))?.status, 'open');
});

test('the email it answers comes from Gmail as plain text, skipping a draft', async () => {
  const id = await proposed();
  const got = await (
    await originalRoute.GET({ params: { id: String(id) } } as unknown as Parameters<
      typeof originalRoute.GET
    >[0])
  ).json();
  assert.deepEqual(got, {
    from: 'Ada <ada@example.com>',
    date: 'Fri, 6 Nov 2026 09:00:00 -0800',
    subject: 'Lunch on Friday?',
    body: 'Are you free for lunch on Friday?'
  });
});

test('with Gmail signed out, nothing goes, and the desk gets the steps to sign in again', async () => {
  const id = await proposed();
  secrets.delete('gmail:oauth');
  try {
    const r = await refused(post(id, { action: 'send', ...PROPOSED }));
    assert.equal(r.status, 409);
    assert.match(
      r.message,
      /^Gmail is not signed in\. Nothing was sent\. Sign in from "Reconnect /
    );
    assert.equal(google.length, 0);
    assert.equal((await L.ask(id))?.status, 'open');
    const [task] = await L.pg`select title from tasks where status = 'open' and staff_id = 'paige'`;
    assert.match(task.title, /^Reconnect Gmail/);
  } finally {
    signIn();
  }
});

test("a lead's pick-up of a colleague's result tells its tool server whose work it was", async () => {
  const h = await gave('lead', 'cleo', { title: 'Sort the inbox' });
  const f = await L.startFollowUp(h.id);
  assert.ok(f, "Cleo's hand-off could not start");
  await L.finishFollowUp(f, 'Sort the inbox', 'done', 'Sorted.');
  const [back] = await L.pg<{ id: number }[]>`
    select id from follow_ups where staff_id = 'lead' and kind = 'handed_back' and thread_id = ${h.thread}`;
  const pickUp = await runOf(back.id);
  assert.equal(pickUp.env.VIA, 'cleo');
  const chat = await chatOf('lead');
  assert.equal(chat.env.VIA, undefined, 'a chat names nobody');
});
