// The New Altitude sign-in, end to end against a fake New Altitude
// (`fake-new-altitude.ts`): routes through the server's real `handle`, the
// callback page, the live line and the page's data, over the office's own
// database in a throwaway folder. The secret store is a Map. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import type { RequestEvent } from '@sveltejs/kit';
import type { AccountStatus } from '#lib/account.ts';
import { fakeNewAltitude, LOST_ANSWERS, MEMBER } from './fake-new-altitude.ts';

const SECRET = 'new-altitude-account:oauth';
const store = new Map<string, string>();
const reads = { count: 0 };
let storeAnswer: { ok: true } | { ok: false; problem: string } = { ok: true };
/** When set, every write throws it, as a locked keyring's does. */
let writeFails: Error | undefined;
// The real module's other exports too, such as `useShellSecrets`, which the
// office's server hooks import.
const realSecrets = await import('@oddboro/ledger/secrets');
mock.module('@oddboro/ledger/secrets', {
  namedExports: {
    ...realSecrets,
    getSecret: (connector: string, name: string) => {
      reads.count++;
      return store.get(`${connector}:${name}`);
    },
    setSecret: (connector: string, name: string, value: string) => {
      if (writeFails) throw writeFails;
      store.set(`${connector}:${name}`, value);
    },
    deleteSecret: (connector: string, name: string) => store.delete(`${connector}:${name}`),
    secretStore: () => storeAnswer
  }
});

// Everything the office prints, for the check that no secret reaches a log.
const printed: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const real = console[level];
  console[level] = (...args: unknown[]) => {
    printed.push(
      args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')
    );
    real(...args);
  };
}

const folder = mkdtempSync(join(tmpdir(), 'oddboro-account-'));
const port = await new Promise<number>((done) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => done(p));
  });
});
const settings = join(folder, 'settings.env');
const SETTINGS = 'OFFICE_TIME_ZONE=UTC\n';
writeFileSync(settings, SETTINGS);
const fake = await fakeNewAltitude();
// Set before the office's modules load: they read where everything is as they start.
Object.assign(process.env, {
  ODDBORO_HOME: folder,
  ODDBORO_DB_PORT: String(port),
  ODDBORO_ENV: settings,
  ODDBORO_PORT: '4517',
  ODDBORO_LOCAL_DB: '1',
  ODDBORO_ACCOUNT_SITE: `${fake.origin}/`
});
const { startLocalDatabase } = await import('@oddboro/ledger/local-db');
const stopDatabase = await startLocalDatabase();
const { bringUpToDate } = await import('@oddboro/ledger/upgrade');
await bringUpToDate();
const L = await import('@oddboro/ledger');
const { accountStatus, accountToken } = await import('./account.ts');
const { bus } = await import('./events.ts');
const route = await import('../../routes/api/account/+server.ts');
const callback = await import('../../routes/account/callback/+page.server.ts');
const page = await import('../../routes/+page.server.ts');
const hooks = await import('../../hooks.server.ts');
const { PAGE, sender } = await import('./diagnostics-harness.ts');
const send = sender(hooks.handle);

// The database keeps timers for its open connections from the first page
// load on, so the count starts after one: what is left is the sign-in's.
await page.load({} as Parameters<typeof page.load>[0]);
const timersAtStart = timers();
const heard: AccountStatus[] = [];
bus.on('event', (e: { type: string; status?: AccountStatus }) => {
  if (e.type === 'account' && e.status) heard.push(e.status);
});

after(async () => {
  await fake.close();
  await L.pg.end();
  await stopDatabase();
  rmSync(folder, { recursive: true, force: true });
});

function timers() {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

type Handler = (event: RequestEvent) => Response | Promise<Response>;
/** A request to /api/account through `handle`, as the owner's page sends it: its status and answer. */
async function account(
  method: 'GET' | 'POST' | 'DELETE'
): Promise<{ status: number; body: Record<string, unknown> }> {
  let body: Record<string, unknown> = {};
  const r = await send({
    route: '/api/account',
    method,
    headers: method === 'GET' ? {} : PAGE,
    resolve: async (e) => {
      try {
        const res = await (route[method] as Handler)(e);
        body = (await res.clone().json()) as Record<string, unknown>;
        return res;
      } catch (thrown) {
        // `error()` throws its answer; Kit sends its body.
        body = (thrown as { body?: Record<string, unknown> }).body ?? {};
        throw thrown;
      }
    }
  });
  return { status: r.status, body };
}

type Loaded = { ok: boolean; title: string; message: string };
async function callbackPage(query: string): Promise<Loaded> {
  const url = new URL(`http://127.0.0.1:4517/account/callback?${query}`);
  return (await callback.load({ url } as unknown as Parameters<typeof callback.load>[0])) as Loaded;
}

/** What New Altitude's sign-in page does: the browser lands on the callback with a code. */
async function signInPage(url: string): Promise<URLSearchParams> {
  const res = await fetch(url, { redirect: 'manual' });
  return new URL(res.headers.get('location') ?? '').searchParams;
}

// Every secret value the flow handled, for the log check.
const handled = new Set<string>();
function remember(back: URLSearchParams) {
  handled.add(back.get('code') ?? '');
  handled.add(back.get('state') ?? '');
}

/** Sign in, then New Altitude's page: the callback's query, not opened yet. */
async function returnFrom(): Promise<URLSearchParams> {
  const { body } = await account('POST');
  const back = await signInPage(String(body.url));
  remember(back);
  return back;
}

/** A whole sign-in: Sign in, New Altitude's page, the callback. */
async function signIn(): Promise<void> {
  const done = await callbackPage((await returnFrom()).toString());
  assert.equal(done.title, 'Signed in');
}

const OLD = 'This sign-in link is old. Start it again from Oddboro.';
const failed = (message: string): Loaded => ({ ok: false, title: 'Not signed in', message });

type Blob = {
  tokens?: { access_token: string; refresh_token?: string; expires_in?: number };
  savedAt?: number;
  profile?: unknown;
};
/** The sign-in as the store holds it. The test reads it only after the office wrote it. */
const saved = () => JSON.parse(store.get(SECRET) ?? '{}') as Blob;
const grants = (type: string) =>
  fake.seen.filter(
    (s) => s.path === '/token' && new URLSearchParams(s.body).get('grant_type') === type
  );
/** Make the kept access token due, as if it were saved long ago. */
function makeDue() {
  const blob = saved();
  blob.savedAt = Date.now() - (blob.tokens?.expires_in ?? 0) * 1000;
  store.set(SECRET, JSON.stringify(blob));
}

let latestUrl: string;

test('signing in registers once, asks for profile and personas, and sends the owner to New Altitude with PKCE', async () => {
  const first = await account('POST');
  assert.equal(first.status, 200);
  const registered = fake.seen.filter((s) => s.path === '/register');
  assert.equal(registered.length, 1);
  const client = JSON.parse(registered[0].body);
  assert.deepEqual(client.redirect_uris, ['http://127.0.0.1:4517/account/callback']);
  assert.equal(client.scope, 'profile personas');
  assert.equal(client.token_endpoint_auth_method, 'none');

  const firstUrl = new URL(String(first.body.url));
  const q = firstUrl.searchParams;
  assert.equal(`${firstUrl.origin}${firstUrl.pathname}`, `${fake.origin}/authorize`);
  assert.equal(q.get('scope'), 'profile personas');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('code_challenge'));
  assert.ok(q.get('state'));
  // The configured site, though the site's own document names another origin.
  assert.equal(q.get('resource'), `${fake.origin}/`);

  const second = await account('POST');
  assert.equal(second.status, 200);
  assert.equal(fake.seen.filter((s) => s.path === '/register').length, 1);
  // Each Sign in starts afresh, so only the newest page can finish.
  latestUrl = String(second.body.url);
});

test('the callback trades the code, asks who signed in once, and every open page hears it', async () => {
  const back = await signInPage(latestUrl);
  remember(back);
  const page = await callbackPage(back.toString());
  assert.deepEqual(page, {
    ok: true,
    title: 'Signed in',
    message: `You are signed in to New Altitude as ${MEMBER.email}. You can close this tab.`
  });

  const codes = grants('authorization_code');
  assert.equal(codes.length, 1);
  const verifier = new URLSearchParams(codes[0].body).get('code_verifier');
  assert.ok(verifier);
  handled.add(verifier);
  const me = fake.seen.filter((s) => s.path === '/api/me');
  assert.equal(me.length, 1);
  assert.equal(me[0].headers.authorization, 'Bearer access-1');

  const account = { id: MEMBER.id, name: MEMBER.name, email: MEMBER.email };
  assert.deepEqual(heard.at(-1), { state: 'in', account });
  const blob = saved();
  assert.equal(blob.tokens?.access_token, 'access-1');
  assert.equal(blob.tokens?.refresh_token, 'refresh-1');
  // The picture New Altitude also sends is not kept.
  assert.deepEqual(blob.profile, account);

  assert.deepEqual(await callbackPage(back.toString()), failed(OLD));
});

test("the page loads with the account's status and no request to New Altitude", async () => {
  const before = fake.seen.length;
  const data = (await page.load({} as Parameters<typeof page.load>[0])) as {
    account: AccountStatus;
  };
  assert.equal(data.account.state, 'in');
  assert.equal(fake.seen.length, before);
});

test("a page's account check reads the secret store once", async () => {
  reads.count = 0;
  const r = await account('GET');
  assert.equal(r.status, 200);
  assert.equal(reads.count, 1);
  assert.deepEqual(r.body.status, {
    state: 'in',
    account: { id: MEMBER.id, name: MEMBER.name, email: MEMBER.email }
  });
});

test('two refreshes at once send one request', async () => {
  fake.expiresIn = 60;
  makeDue();
  const tokens = await Promise.all([accountToken(), accountToken(), accountToken()]);
  assert.equal(grants('refresh_token').length, 1);
  assert.deepEqual(tokens, ['access-2', 'access-2', 'access-2']);
});

test('a refused refresh shows Sign in again and keeps who it was', async () => {
  // The tokens from the last refresh last 60 seconds, inside the refresh margin.
  fake.refuseNextRefresh = { error: 'invalid_grant', error_description: 'agreement_required' };
  const told = heard.length;
  assert.equal(await accountToken(), undefined);
  const expired = {
    state: 'expired',
    account: { id: MEMBER.id, name: MEMBER.name, email: MEMBER.email }
  };
  assert.deepEqual(accountStatus(), expired);
  assert.deepEqual(heard.slice(told), [expired]);
  assert.equal(saved().tokens, undefined);
});

test('a refresh that cannot reach New Altitude keeps the sign-in', async () => {
  await signIn();
  fake.down.add('/token');
  try {
    assert.equal(await accountToken(), undefined);
  } finally {
    fake.down.delete('/token');
  }
  assert.equal(accountStatus().state, 'in');
  assert.ok(saved().tokens?.refresh_token);
});

test('signing out ends the sign-in at New Altitude and removes it from this computer', async () => {
  // Signed in from the test before.
  const refresh = saved().tokens?.refresh_token;
  assert.ok(refresh);
  const revokes = () => fake.seen.filter((s) => s.path === '/revoke');
  let told = heard.length;
  const out = await account('DELETE');
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.status, { state: 'out' });
  assert.equal(revokes().length, 1);
  const sent = new URLSearchParams(revokes()[0].body);
  assert.equal(sent.get('token'), refresh);
  assert.equal(sent.get('token_type_hint'), 'refresh_token');
  assert.equal(store.has(SECRET), false);
  assert.deepEqual(accountStatus(), { state: 'out' });
  assert.deepEqual(heard.slice(told), [{ state: 'out' }]);

  // New Altitude cannot be reached: the sign-in still goes from this computer.
  await signIn();
  fake.down.add('/revoke');
  try {
    assert.equal((await account('DELETE')).status, 200);
  } finally {
    fake.down.delete('/revoke');
  }
  assert.equal(store.has(SECRET), false);
  assert.deepEqual(accountStatus(), { state: 'out' });
  assert.ok(
    printed.some((p) => p.includes(`[account] could not reach ${new URL(fake.origin).host}`))
  );

  // A refresh still running when the owner signs out cannot write the sign-in back.
  await signIn();
  makeDue();
  const held = fake.hold('/token');
  const using = accountToken();
  const release = await held;
  told = heard.length;
  const leaving = account('DELETE');
  // Let the sign-out reach its wait before the refresh answers.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([using, leaving]);
  assert.equal(store.has(SECRET), false);
  assert.deepEqual(accountStatus(), { state: 'out' });
  assert.deepEqual(heard.at(-1), { state: 'out' });
});

const SIGNED_IN = {
  state: 'in',
  account: { id: MEMBER.id, name: MEMBER.name, email: MEMBER.email }
} as const;
const revokes = () => fake.seen.filter((s) => s.path === '/revoke').length;

test('an older sign-in page is refused before any exchange, and the newest still finishes', async () => {
  const older = await returnFrom();
  const newer = await returnFrom();
  const exchanges = grants('authorization_code').length;
  assert.deepEqual(await callbackPage(older.toString()), failed(OLD));
  assert.equal(grants('authorization_code').length, exchanges);
  assert.equal((await callbackPage(newer.toString())).title, 'Signed in');
  assert.deepEqual(accountStatus(), SIGNED_IN);
});

test('a refused sign-in gives the reason and leaves the current account signed in', async () => {
  const exchanges = grants('authorization_code').length;
  const denied = await callbackPage('error=access_denied');
  assert.match(denied.message, /did not grant access/);
  assert.match((await callbackPage('error=temporarily_unavailable')).message, /Wait a little/);
  assert.deepEqual(accountStatus(), SIGNED_IN);
  assert.equal(grants('authorization_code').length, exchanges);
});

test('a sign-in page that lands while a sign-in holds tokens is refused, and the tokens stay', async () => {
  // Signed in from the test before. While a new page is open, another office
  // on this computer signs in to the same secret.
  const live = saved();
  await account('DELETE');
  const back = await returnFrom();
  store.set(SECRET, JSON.stringify({ ...saved(), ...live }));
  const exchanges = grants('authorization_code').length;
  assert.deepEqual(await callbackPage(back.toString()), failed(OLD));
  assert.equal(grants('authorization_code').length, exchanges);
  assert.deepEqual(saved().tokens, live.tokens);
  await account('DELETE');
});

test('New Altitude unreachable for who signed in: the callback signs out and leaves nothing behind', async () => {
  const back = await returnFrom();
  const ended = revokes();
  fake.down.add('/api/me');
  let page: Loaded;
  try {
    page = await callbackPage(back.toString());
  } finally {
    fake.down.delete('/api/me');
  }
  assert.deepEqual(
    page,
    failed('New Altitude did not finish the sign-in. Try Sign in again from Oddboro.')
  );
  // The tokens the code bought are ended at New Altitude and gone here.
  assert.equal(revokes(), ended + 1);
  assert.equal(store.has(SECRET), false);
  assert.deepEqual(accountStatus(), { state: 'out' });
  assert.equal(await accountToken(), undefined);
  assert.ok((await account('POST')).body.url, 'Sign in starts a new sign-in');
});

test('New Altitude failing to say who signed in: the callback signs out with a plain reason', async () => {
  const back = await returnFrom();
  fake.failing.add('/api/me');
  let page: Loaded;
  try {
    page = await callbackPage(back.toString());
  } finally {
    fake.failing.delete('/api/me');
  }
  assert.deepEqual(page, failed('New Altitude did not say who signed in. Try Sign in again.'));
  assert.equal(store.has(SECRET), false);
  assert.deepEqual(accountStatus(), { state: 'out' });
});

test('Sign in on a kept sign-in with no account asks who it is, and every open page hears it', async () => {
  await signIn();
  const blob = saved();
  delete blob.profile;
  store.set(SECRET, JSON.stringify(blob));
  // The live check reads the store, so the page shows what it holds.
  assert.deepEqual((await account('GET')).body.status, { state: 'out' });
  const told = heard.length;
  assert.deepEqual((await account('POST')).body, { url: '' });
  assert.deepEqual(accountStatus(), SIGNED_IN);
  assert.deepEqual(heard.slice(told), [SIGNED_IN]);
  assert.deepEqual(saved().profile, SIGNED_IN.account);
});

for (const [way, code] of LOST_ANSWERS)
  test(`a refresh whose answer is lost (${code}) is not retried within one request`, async () => {
    // Out first, as the test before leaves the owner signed in.
    await account('DELETE');
    await signIn();
    makeDue();
    const used = saved().tokens?.refresh_token;
    const before = grants('refresh_token').length;
    const told = printed.length;
    fake[way].add('/token');
    assert.equal(await accountToken(), undefined);
    assert.ok(printed.slice(told).some((p) => p.includes(`(attempt 1): ${code}`)));
    const sent = grants('refresh_token')
      .slice(before)
      .map((g) => new URLSearchParams(g.body).get('refresh_token'));
    assert.deepEqual(sent, [used]);
    await account('DELETE');
  });

test('Sign in on a kept sign-in when New Altitude cannot say who it is signs out and leaves nothing behind', async () => {
  await signIn();
  const blob = saved();
  delete blob.profile;
  store.set(SECRET, JSON.stringify(blob));
  assert.deepEqual((await account('GET')).body.status, { state: 'out' });
  const ended = revokes();
  fake.down.add('/api/me');
  let r: Awaited<ReturnType<typeof account>>;
  try {
    r = await account('POST');
  } finally {
    fake.down.delete('/api/me');
  }
  assert.equal(r.status, 502);
  assert.deepEqual(accountStatus(), { state: 'out' });
  assert.equal(store.has(SECRET), false);
  assert.equal(revokes(), ended + 1);
});

test("a secret store that passes its check but cannot save gets the store's words and a next step", async () => {
  writeFails = new Error('Command failed: secret-tool store (keyring locked)');
  try {
    const r = await account('POST');
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "Signing in needs this computer's secret store, and it did not answer. Make sure it is unlocked, then click Sign in again."
    );
  } finally {
    writeFails = undefined;
  }
  // On a Mac the store's error names the value it was writing.
  assert.ok(!printed.some((p) => p.includes('keyring locked')));
  assert.deepEqual(accountStatus(), { state: 'out' });
});

test('a computer with no secret store gets a plain reason and nothing is sent', async () => {
  storeAnswer = { ok: false, problem: 'not installed' };
  const before = fake.seen.length;
  try {
    const r = await account('POST');
    assert.equal(r.status, 409);
    assert.match(String(r.body.message), /^Signing in needs this computer's secret store/);
  } finally {
    storeAnswer = { ok: true };
  }
  assert.equal(fake.seen.length, before);
});

test('no token, code, verifier, state or email reaches .env or the logs, and no timer stays behind', async () => {
  assert.equal(readFileSync(settings, 'utf8'), SETTINGS);
  // Every value the fake handed out or took in while the tests above ran.
  for (const s of fake.seen) {
    const form = new URLSearchParams(s.body);
    for (const key of ['code', 'code_verifier', 'refresh_token', 'token'])
      if (form.get(key)) handled.add(form.get(key)!);
  }
  const words = [...handled, 'access-', 'refresh-', MEMBER.email].filter(Boolean);
  assert.ok(words.length > 6, 'the flow handled secrets to look for');
  for (const line of printed)
    for (const word of words) assert.ok(!line.includes(word), `a log line holds ${word}`);
  assert.ok(timers() <= timersAtStart, `${timers()} timers now, ${timersAtStart} at the start`);
});
