// Gmail filters an Odd proposed, as the owner creates them from the Desk
// (`/api/asks/[id]/filter`, `/filter-preview`, filters.ts): the office calls
// Gmail itself, with its own token, on the owner's click alone. The card
// counts the mail a filter matches; Create filter makes a missing label,
// tidies the mail it already matches a page at a time, then makes the filter
// and approves the ask; a Gmail failure leaves the ask open; and a sign-in
// from before filters puts the office's reconnect steps on the desk. Google
// is a stand-in `fetch`. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { FilterAction } from '@oddboro/ledger';
import { L, secrets } from './office-under-test.ts';

process.env.ODDBORO_GOOGLE_CLIENT_SECRET = 'a-client-secret-for-tests';
const route = await import('../../routes/api/asks/[id]/filter/+server.ts');
const preview = await import('../../routes/api/asks/[id]/filter-preview/+server.ts');
const askRoute = await import('../../routes/api/asks/[id]/+server.ts');

secrets.set(
  'gmail:oauth',
  JSON.stringify({
    tokens: { access_token: 'ya29.a-token', refresh_token: '1//a-refresh', expires_in: 3600 },
    savedAt: Date.now()
  })
);
await L.connectorReady('gmail', ['list_filters'], ['list_filters']);
await L.pg`insert into grants ${L.pg({ staff_id: 'paige', connector_id: 'gmail', level: 'read' })}`;

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** What reached Google: each address, its method and its body. */
let google: { url: string; method: string; body: string }[] = [];
/** Google's answer to a call whose address holds the key, when a test wants a failure. */
let fails: Record<string, Response> = {};
/** The owner's labels as Gmail has them. */
const LABELS = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'TRASH', name: 'TRASH', type: 'system' },
  { id: 'Label_3', name: 'Receipts', type: 'user' }
];
const ids = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${from + i}`, threadId: 't' }));
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(GMAIL)) return realFetch(input, init);
  const method = init.method ?? 'GET';
  google.push({ url, method, body: String(init.body ?? '') });
  const failing = Object.keys(fails).find((k) => url.includes(k));
  if (failing) return fails[failing].clone();
  const path = url.slice(GMAIL.length);
  if (path === '/labels' && method === 'GET') return Response.json({ labels: LABELS });
  if (path === '/labels') return Response.json({ id: 'Label_new', name: 'made' });
  if (path.startsWith('/messages?') && path.includes('pageToken=p2'))
    return Response.json({ messages: ids(700, 500) });
  if (path.startsWith('/messages?'))
    return Response.json({ messages: ids(0, 700), nextPageToken: 'p2' });
  if (path === '/messages/batchModify') return new Response(null, { status: 204 });
  if (path === '/settings/filters') return Response.json({ id: 'filter-1' });
  return Response.json({});
}) as typeof fetch;

let n = 0;
beforeEach(() => {
  google = [];
  fails = {};
  n += 1;
});

/** A filter Paige proposes, on the desk, for mail from a sender of its own. */
async function proposed(action: FilterAction = { skipInbox: true, addLabel: 'Newsletters' }) {
  const { ask } = await L.raiseAsk('paige', {
    kind: 'filter',
    title: `Gmail filter ${n}`,
    why: 'You never open them.',
    ifApproved: 'You create it.',
    filter: { criteria: { from: `news${n}@shop.example.com` }, action, summary: 'Daily news.' }
  });
  return { id: ask.id, from: `news${n}@shop.example.com` };
}
const post = (id: number, body: unknown) =>
  route.POST({
    params: { id: String(id) },
    request: new Request(`http://office/api/asks/${id}/filter`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  } as unknown as Parameters<typeof route.POST>[0]);
const counted = async (id: number, search = '') =>
  (
    await preview.GET({
      params: { id: String(id) },
      url: new URL(`http://office/api/asks/${id}/filter-preview${search}`)
    } as unknown as Parameters<typeof preview.GET>[0])
  ).json();
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
const calls = (method: string, path: string) =>
  google.filter((g) => g.method === method && g.url === `${GMAIL}${path}`);
const linesOf = (id: number) =>
  L.pg<{ title: string }[]>`select title from ledger where ask_id = ${id}`;

test("the card's count comes from Gmail's search for the criteria, the ask's own or the owner's changes", async () => {
  const { id, from } = await proposed();
  // Counted page by page (700, then 500), never Gmail's rough estimate.
  assert.deepEqual(await counted(id), { query: `from:(${from})`, about: 1200, more: false });
  assert.equal(
    google[0].url,
    `${GMAIL}/messages?q=${encodeURIComponent(`from:(${from})`)}&maxResults=500`
  );
  const changed = await counted(id, '?subject=Weekly&negatedQuery=sale&hasAttachment=true');
  assert.equal(changed.query, 'subject:(Weekly) -(sale) has:attachment');
  const blank = await refused(counted(id, '?from=%20'));
  assert.equal(blank.status, 400);
});

test('Create filter makes the missing label, tidies the matching mail in pages, makes the filter, then approves the ask', async () => {
  const { id, from } = await proposed();
  const criteria = { from };
  const action = { skipInbox: true, markRead: true, addLabel: 'Newsletters' };
  const res = await (await post(id, { criteria, action, tidy: true })).json();
  assert.equal(res.ok, true);
  const [label] = calls('POST', '/labels');
  assert.equal(JSON.parse(label.body).name, 'Newsletters', 'the missing label was made');
  const changes = { addLabelIds: ['Label_new'], removeLabelIds: ['INBOX', 'UNREAD'] };
  const pages = google.filter((g) => g.url.startsWith(`${GMAIL}/messages?`));
  assert.equal(pages.length, 2, 'both pages of matching mail were read');
  const batches = calls('POST', '/messages/batchModify').map((b) => JSON.parse(b.body));
  assert.deepEqual(
    batches.map((b) => b.ids.length),
    [1000, 200]
  );
  for (const b of batches)
    assert.deepEqual({ ...b, ids: undefined }, { ids: undefined, ...changes });
  const [made] = calls('POST', '/settings/filters');
  assert.deepEqual(JSON.parse(made.body), { criteria, action: changes });
  assert.ok(
    google.indexOf(made) > google.indexOf(calls('POST', '/messages/batchModify')[1]),
    'the filter is made last, so a failure before it leaves nothing made twice'
  );
  const a = (await L.ask(id))!;
  assert.equal(a.status, 'approved');
  assert.equal(a.filter?.created?.gmailId, 'filter-1');
  assert.equal(a.filter?.created?.tidied, 1200);
  assert.equal(a.filter?.matching, 1200);
  assert.deepEqual(a.filter?.action, action, "the owner's version is kept");
  assert.deepEqual(
    (await linesOf(id)).map((l) => l.title),
    [
      `Created a Gmail filter: mail from ${from} will skip the inbox, be marked read and get the label "Newsletters", and tidied 1200 emails`
    ]
  );
  // No run carries a filter out: the office already did. On no work, the Odd hears so, once.
  assert.deepEqual(
    [...(await L.pg`select kind from follow_ups where ask_id = ${id}`)],
    [{ kind: 'answered' }]
  );
});

test('a label that exists is used as it is, and without tidy no mail changes', async () => {
  const { id, from } = await proposed({ addLabel: 'receipts', star: true });
  await post(id, { criteria: { from }, action: { addLabel: 'receipts', star: true }, tidy: false });
  assert.equal(calls('POST', '/labels').length, 0);
  assert.equal(calls('POST', '/messages/batchModify').length, 0);
  const [made] = calls('POST', '/settings/filters');
  assert.deepEqual(JSON.parse(made.body).action, {
    addLabelIds: ['Label_3', 'STARRED'],
    removeLabelIds: []
  });
  const a = (await L.ask(id))!;
  assert.equal(a.filter?.created?.tidied, 0);
  assert.equal(a.filter?.matching, 1200, 'the count still comes from Gmail');
  assert.doesNotMatch((await linesOf(id))[0].title, /tidied/);
});

test("one of Gmail's own labels is refused, so a filter cannot send mail to the trash", async () => {
  const { id, from } = await proposed();
  const r = await refused(
    post(id, { criteria: { from }, action: { addLabel: 'Trash' }, tidy: true })
  );
  assert.equal(r.status, 400);
  assert.equal(
    r.message,
    `Nothing was created. "Trash" is one of Gmail's own labels. Pick another name.`
  );
  assert.equal(calls('POST', '/settings/filters').length, 0);
  assert.equal((await L.ask(id))?.status, 'open');
});

test('a Gmail failure leaves the ask open and says so in plain words', async () => {
  const { id, from } = await proposed();
  fails = {
    '/settings/filters': Response.json(
      { error: { message: 'Filter already exists' } },
      { status: 400 }
    )
  };
  const r = await refused(
    post(id, { criteria: { from }, action: { skipInbox: true }, tidy: false })
  );
  assert.equal(r.status, 502);
  assert.equal(r.message, 'Nothing was created. Gmail said: Filter already exists');
  const a = (await L.ask(id))!;
  assert.equal(a.status, 'open');
  assert.equal(a.filter?.created, undefined);
  assert.equal((await linesOf(id)).length, 0, 'no line in the ledger');
});

test('a sign-in from before filters says Gmail needs signing in again, and puts the reconnect steps on the desk', async () => {
  const { id, from } = await proposed();
  fails = {
    '/labels': Response.json(
      { error: { code: 403, message: 'Request had insufficient authentication scopes.' } },
      { status: 403 }
    )
  };
  const r = await refused(
    post(id, { criteria: { from }, action: { addLabel: 'News' }, tidy: true })
  );
  assert.equal(r.status, 409);
  assert.match(
    r.message,
    /^Gmail's sign-in is from before filters, so Gmail needs signing in again\. Nothing was created\. Sign in from "Reconnect Gmail/
  );
  assert.equal((await L.ask(id))?.status, 'open');
  const [task] = await L.pg<{ title: string; why: string }[]>`
    select title, why from tasks where status = 'open' and staff_id = 'paige'`;
  assert.match(task.title, /^Reconnect Gmail/);
  assert.match(task.why, /filter settings/);
});

test('a filter is approved only by creating it, and the route checks what the page sent', async () => {
  const { id, from } = await proposed();
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
  assert.equal(
    (await refused(post(id, { criteria: { from }, action: {}, tidy: true }))).status,
    400
  );
  assert.equal(
    (await refused(post(id, { criteria: { from }, action: { star: 'yes' }, tidy: true }))).status,
    400
  );
  assert.equal(
    (await refused(post(id, { criteria: { from: ' ' }, action: { star: true }, tidy: true })))
      .status,
    400
  );
  assert.equal(google.length, 0, 'nothing reached Gmail');
  assert.equal((await L.ask(id))?.status, 'open');
});
