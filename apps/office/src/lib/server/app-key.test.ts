// The office in the desktop app answers only requests that carry the app's
// key: the window's cookie, or the shell's header where the shell calls.
// What comes without it: a sign-in callback, a run's gateway call, and a
// link the shell made for the owner's browser. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import type { RequestEvent } from '@sveltejs/kit';
import { kitUrl, ownProof, REQUEST_TARGETS } from './request-targets.ts';

const folder = mkdtempSync(join(tmpdir(), 'oddboro-app-key-'));
// Set before the office's modules load: they read whether they run in the app as they start.
Object.assign(process.env, {
  ODDBORO_APP: '1',
  ODDBORO_HOME: folder,
  ODDBORO_ENV: join(folder, 'none.env'),
  HOME: join(folder, 'home')
});
after(() => rmSync(folder, { recursive: true, force: true }));

const K = await import('./app-key.ts');
const { guardOffice } = await import('./owner-page.ts');
const { closeGateway, openGateway } = await import('./gateway.ts');
const linkRoute = await import('../../routes/api/browser-link/+server.ts');
const proofRoute = await import('../../routes/api/proof/+server.ts');

const KEY = 'a1'.repeat(32);

/** The key as the shell sends it, on a pipe of its own. */
async function given(lines: string, end = false): Promise<boolean> {
  const pipe = new PassThrough();
  const read = K.readKey(pipe, 200);
  pipe.write(lines);
  if (end) pipe.end();
  return read;
}

type Route = (event: RequestEvent) => Response | Promise<Response>;
type Sent = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  from?: string;
};

/** Send a request through `guardOffice` to `route`, as the server does. */
async function send(
  route: Route,
  s: Sent
): Promise<{ status: number; ran: boolean; text: string; csp: string | null }> {
  const method = s.method ?? 'GET';
  const request = new Request(`http://127.0.0.1:4500${s.path ?? '/'}`, {
    method,
    headers: { host: '127.0.0.1:4500', ...s.headers },
    body: method === 'GET' || method === 'HEAD' ? undefined : (s.body ?? '{}')
  });
  const event = {
    request,
    url: kitUrl(request),
    params: {},
    getClientAddress: () => s.from ?? '127.0.0.1'
  } as unknown as RequestEvent;
  let ran = false;
  try {
    const res = await guardOffice({
      event,
      resolve: async (e) => {
        ran = true;
        return route(e);
      }
    });
    return {
      status: res.status,
      ran,
      text: await res.text(),
      csp: res.headers.get('content-security-policy')
    };
  } catch (e) {
    const thrown = e as { status: number; body?: { message?: string } };
    return { status: thrown.status, ran, text: thrown.body?.message ?? '', csp: null };
  }
}

const ok: Route = () => new Response('ok');
const PAGE = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4500' };
const WINDOW = { cookie: `oddboro-key=${KEY}` };
const SHELL = { 'x-oddboro-key': KEY };

test('the key is the first line on the pipe, in the shape the shell makes it', async () => {
  assert.equal(await given(`oddboro:key ${'f'.repeat(64)}\n`), true);
  for (const line of [
    `oddboro:key ${'f'.repeat(63)}\n`,
    `oddboro:key ${'F'.repeat(64)}\n`,
    `oddboro:secret ${'f'.repeat(64)}\n`,
    `{"id":1,"ok":true}\noddboro:key ${'f'.repeat(64)}\n`
  ])
    assert.equal(await given(line), false, line);
  // A pipe that closes, or says nothing in time, gives no key.
  assert.equal(await given(`oddboro:key ${'f'.repeat(64)}`, true), false);
  assert.equal(await given(''), false);
  // A key in two pieces still counts.
  const pipe = new PassThrough();
  const read = K.readKey(pipe, 500);
  pipe.write(`oddboro:key ${KEY.slice(0, 10)}`);
  pipe.write(`${KEY.slice(10)}\n`);
  assert.equal(await read, true);
});

test('without the key every request is refused, reads included, before any other rule', async () => {
  for (const s of [
    { path: '/' },
    { path: '/api/ledger' },
    { method: 'POST', path: '/api/goals', headers: PAGE },
    { path: '/api/events', headers: { cookie: `oddboro-key=${'b2'.repeat(32)}` } },
    { path: '/api/ledger', headers: { cookie: `oddboro-key=${KEY.slice(1)}` } },
    { path: '/', from: '192.168.1.20' }
  ] as Sent[]) {
    const r = await send(ok, s);
    assert.deepEqual([s.path, r.status, r.ran, r.text], [s.path, 403, false, K.OPEN_FROM_APP]);
  }
});

test("the window's cookie passes, and the other rules still apply after it", async () => {
  for (const s of [
    { path: '/' },
    { path: '/api/events' },
    { path: '/api/ledger', headers: { cookie: `theme=dark; oddboro-key=${KEY}; x=1` } },
    { method: 'POST', path: '/api/goals', headers: { ...WINDOW, ...PAGE } }
  ] as Sent[]) {
    const r = await send(ok, { ...s, headers: { ...WINDOW, ...s.headers } });
    assert.deepEqual([s.path, r.status, r.ran], [s.path, 200, true]);
  }
  // The key is not the owner's page: an action still needs the page's own headers.
  const action = await send(ok, { method: 'POST', path: '/api/goals', headers: WINDOW });
  assert.deepEqual([action.status, action.ran], [403, false]);
  const named = await send(ok, { headers: { ...WINDOW, host: 'rebind.evil.example:4500' } });
  assert.deepEqual(
    [named.status, named.text],
    [403, 'This office answers only at its own address']
  );
  const away = await send(ok, { headers: WINDOW, from: '192.168.1.20' });
  assert.deepEqual([away.status, away.ran], [403, false]);
});

test("the shell's header counts only where the shell calls", async () => {
  for (const path of ['/api/update', '/api/browser-link']) {
    for (const method of ['GET', 'POST']) {
      const r = await send(ok, { method, path, headers: SHELL });
      assert.deepEqual([path, method, r.status, r.ran], [path, method, 200, true]);
    }
  }
  for (const s of [
    { path: '/' },
    { path: '/api/ledger' },
    { method: 'POST', path: '/api/goals', headers: PAGE }
  ] as Sent[]) {
    const r = await send(ok, { ...s, headers: { ...SHELL, ...s.headers } });
    assert.deepEqual([s.path, r.status, r.ran], [s.path, 403, false]);
  }
  const wrong = await send(ok, {
    method: 'POST',
    path: '/api/update',
    headers: { 'x-oddboro-key': 'b2'.repeat(32) }
  });
  assert.deepEqual([wrong.status, wrong.ran], [403, false]);
});

test('the sign-in callbacks pass without the key, as GETs to those two paths alone', async () => {
  for (const path of ['/account/callback', '/connect/callback']) {
    const r = await send(ok, { path: `${path}?code=c&state=s` });
    assert.deepEqual([path, r.status, r.ran], [path, 200, true]);
    for (const s of [
      { method: 'POST', path, headers: PAGE },
      { path: `${path}/__data.json` },
      { path: `${path}x` }
    ] as Sent[]) {
      const refused = await send(ok, s);
      assert.deepEqual([s.method, s.path, refused.status], [s.method, s.path, 403]);
    }
  }
});

test("a run's token reaches its gateway without the key, and nothing else", async () => {
  const notes = {
    id: 'notes',
    name: 'Notes',
    readTools: [],
    tools: [],
    config: {}
  } as unknown as import('@oddboro/ledger').ConnectorRow;
  const { token } = openGateway([{ connector: notes, level: 'read' }], 60_000);
  const auth = { authorization: `Bearer ${token}` };
  const run = await send(ok, { method: 'POST', path: '/api/gateway/notes', headers: auth });
  assert.deepEqual([run.status, run.ran], [200, true]);
  const elsewhere = await send(ok, { path: '/api/ledger', headers: auth });
  assert.deepEqual([elsewhere.status, elsewhere.text], [403, K.OPEN_FROM_APP]);
  await closeGateway(token);
  const ended = await send(ok, { method: 'POST', path: '/api/gateway/notes', headers: auth });
  assert.deepEqual([ended.status, ended.ran], [403, false]);
});

test("a link for the owner's browser works once, for its own path, within a minute", async () => {
  const path = '/api/staff/paige/attachments/plan%20v2.pdf';
  const mint = await send(linkRoute.POST as Route, {
    method: 'POST',
    path: '/api/browser-link',
    headers: SHELL,
    body: JSON.stringify({ path })
  });
  assert.equal(mint.status, 200);
  const { code } = JSON.parse(mint.text) as { code: string };
  const at = (p: string, c = code) => `${p}?${K.LINK_QUERY}=${encodeURIComponent(c)}`;
  const first = await send(ok, { path: at(path) });
  assert.deepEqual([first.status, first.ran], [200, true]);
  const again = await send(ok, { path: at(path) });
  assert.deepEqual([again.status, again.text], [403, K.OPEN_FROM_APP]);
  // Another path spends the code and gets nothing.
  const other = K.mintLink(path);
  assert.equal((await send(ok, { path: at('/api/ledger', other) })).status, 403);
  assert.equal((await send(ok, { path: at(path, other) })).status, 403);
  // An action is never let in by a link, and the code is still good for its GET.
  const third = K.mintLink(path);
  const post = await send(ok, { method: 'POST', path: at(path, third), headers: PAGE });
  assert.equal(post.status, 403);
  assert.equal((await send(ok, { path: at(path, third) })).status, 200);
  // A minute later it opens nothing.
  const old = K.mintLink(path, Date.now() - K.LINK_MS - 1);
  assert.equal((await send(ok, { path: at(path, old) })).status, 403);
  assert.equal((await send(ok, { path: at(path, 'made-up') })).status, 403);
});

test('only the shell makes a link, never the page', async () => {
  const r = await send(linkRoute.POST as Route, {
    method: 'POST',
    path: '/api/browser-link',
    headers: { ...WINDOW, ...PAGE },
    body: JSON.stringify({ path: '/' })
  });
  assert.deepEqual([r.status, r.ran, r.text], [403, true, 'Only the app makes browser links']);
});

test("the window's pages may load only from the office itself, data, blob and https", async () => {
  const html: Route = () => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } });
  const page = await send(html, { headers: WINDOW });
  assert.equal(page.csp, K.WINDOW_CSP);
  assert.match(page.csp!, /img-src 'self' data: blob: https:;/);
  assert.doesNotMatch(page.csp!, /http:/);
  // A route's own policy stays, and data gets none.
  const own: Route = () =>
    new Response('x', {
      headers: { 'content-type': 'text/html', 'content-security-policy': 'sandbox' }
    });
  assert.equal((await send(own, { headers: WINDOW })).csp, 'sandbox');
  assert.equal((await send(ok, { headers: WINDOW })).csp, null);
});

test('the office proves it holds the key: HMAC of the label and the nonce, never the key', async () => {
  const nonce = 'c3'.repeat(32);
  const r = await send(proofRoute.GET as Route, { path: `/api/proof?nonce=${nonce}` });
  assert.deepEqual([r.status, r.ran], [200, true]);
  assert.equal(r.text, createHmac('sha256', KEY).update(`oddboro-proof:${nonce}`).digest('hex'));
  assert.notEqual(r.text, createHmac('sha256', KEY).update(nonce).digest('hex'));
  assert.ok(!r.text.includes(KEY));
  // Another key would answer otherwise, so only the server with this one passes the shell's check.
  assert.notEqual(
    r.text,
    createHmac('sha256', 'b2'.repeat(32)).update(`oddboro-proof:${nonce}`).digest('hex')
  );
});

test('the proof answers only a GET with a nonce of 64 hex digits', async () => {
  for (const nonce of [
    '',
    'c3'.repeat(31),
    'c3'.repeat(33),
    'C3'.repeat(32),
    `${'c3'.repeat(31)}zz`,
    KEY + '&x=1'
  ]) {
    const r = await send(proofRoute.GET as Route, {
      path: `/api/proof?nonce=${encodeURIComponent(nonce)}`
    });
    assert.deepEqual([nonce, r.status], [nonce, 400]);
  }
  const post = await send(ok, {
    method: 'POST',
    path: `/api/proof?nonce=${'c3'.repeat(32)}`,
    headers: PAGE
  });
  assert.deepEqual([post.status, post.ran, post.text], [403, false, K.OPEN_FROM_APP]);
  // Only that path: the same nonce elsewhere opens nothing.
  const elsewhere = await send(ok, { path: `/api/ledger?nonce=${'c3'.repeat(32)}` });
  assert.deepEqual([elsewhere.status, elsewhere.ran], [403, false]);
});

test('without a key the office proves nothing', async () => {
  const before = await given('');
  assert.equal(before, false);
  assert.equal(K.proof('c3'.repeat(32)), undefined);
  assert.equal(await given(`oddboro:key ${KEY}\n`), true);
});

test('without the key only an exact exception passes, judged on the address the request was sent to', async () => {
  const notes = {
    id: 'notes',
    name: 'Notes',
    readTools: [],
    tools: [],
    config: {}
  } as unknown as import('@oddboro/ledger').ConnectorRow;
  const { token } = openGateway([{ connector: notes, level: 'read' }], 60_000);
  const RUN = { authorization: `Bearer ${token}` };
  const proofs = { get: {}, shell: SHELL, run: RUN };
  const at = (path: string, code: string) =>
    `${path}${path.includes('?') ? '&' : '?'}${K.LINK_QUERY}=${encodeURIComponent(code)}`;
  let rows = 0;
  try {
    for (const { target, kitPath, app } of REQUEST_TARGETS) {
      rows++;
      const path = target.replace('<root>', folder);
      if (app === 'unparsed') {
        assert.throws(() => new Request(`http://127.0.0.1:4500${path}`), TypeError, target);
        continue;
      }
      const named: Record<string, string> = kitPath ? { 'x-sveltekit-pathname': kitPath } : {};
      if (app === 'passes') {
        const proof = proofs[ownProof(path)];
        const method = proof === proofs.get ? 'GET' : 'POST';
        const r = await send(ok, { method, path, headers: { ...named, ...proof } });
        assert.deepEqual([target, r.status, r.ran], [target, 200, true]);
        // Without its proof, an action there is refused like anywhere else.
        const bare = await send(ok, { method: 'POST', path, headers: { ...named, ...PAGE } });
        assert.deepEqual([target, bare.status, bare.ran], [target, 403, false]);
        continue;
      }
      for (const method of ['GET', 'POST'])
        for (const proof of Object.values(proofs)) {
          const r = await send(ok, { method, path, headers: { ...named, ...proof } });
          assert.deepEqual(
            [target, kitPath, method, r.status, r.ran],
            [target, kitPath, method, 403, false]
          );
        }
      // A link opens only the address it was made for: not another, and not
      // this one under the path Kit routes it on.
      const routed = kitUrl(
        new Request(`http://127.0.0.1:4500${path}`, { headers: named })
      ).pathname;
      const links = [K.mintLink('/api/events')];
      if (routed !== new URL(path, 'http://office').pathname) links.push(K.mintLink(routed));
      for (const code of links) {
        const r = await send(ok, { path: at(path, code), headers: named });
        assert.deepEqual([target, kitPath, r.status, r.ran], [target, kitPath, 403, false]);
      }
    }
  } finally {
    await closeGateway(token);
  }
  assert.equal(rows, REQUEST_TARGETS.length);
});
