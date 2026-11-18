// The connectors' OAuth: one refresh per sign-in at a time, against a fake
// service (`fake-new-altitude.ts`), over the office's own database in a throwaway
// folder. The secret store is a Map. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fakeNewAltitude, LOST_ANSWERS } from './fake-new-altitude.ts';

const store = new Map<string, string>();
// The real module's other exports too, such as `useShellSecrets`, which the
// office's server hooks import.
const realSecrets = await import('@oddboro/ledger/secrets');
mock.module('@oddboro/ledger/secrets', {
  namedExports: {
    ...realSecrets,
    getSecret: (connector: string, name: string) => store.get(`${connector}:${name}`),
    setSecret: (connector: string, name: string, value: string) =>
      void store.set(`${connector}:${name}`, value),
    deleteSecret: (connector: string, name: string) => store.delete(`${connector}:${name}`),
    secretStore: () => ({ ok: true })
  }
});

const folder = mkdtempSync(join(tmpdir(), 'oddboro-oauth-'));
const port = await new Promise<number>((done) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => done(p));
  });
});
// Set before the office's modules load: they read where everything is as they start.
Object.assign(process.env, {
  ODDBORO_HOME: folder,
  ODDBORO_DB_PORT: String(port),
  // A file that does not exist, so no .env reaches this office.
  ODDBORO_ENV: join(folder, 'none.env'),
  ODDBORO_LOCAL_DB: '1'
});
const fake = await fakeNewAltitude();
const { startLocalDatabase } = await import('@oddboro/ledger/local-db');
const stopDatabase = await startLocalDatabase();
const { bringUpToDate } = await import('@oddboro/ledger/upgrade');
await bringUpToDate();
const L = await import('@oddboro/ledger');
const { bearer } = await import('./oauth.ts');

after(async () => {
  await fake.close();
  await L.pg.end();
  await stopDatabase();
  rmSync(folder, { recursive: true, force: true });
});

const url = `${fake.origin}/mcp`;
await L.addConnector({
  id: 'tracker',
  name: 'Tracker',
  description: 'A hosted tool.',
  kind: 'http',
  config: { url }
});

/** What a finished sign-in to the tracker holds, with a token inside the refresh margin. */
async function signedIn(refresh: string) {
  const issuer = fake.origin;
  const metadata = await (
    await fetch(`${fake.origin}/.well-known/oauth-authorization-server`)
  ).json();
  fake.issue(refresh);
  store.set(
    'tracker:oauth',
    JSON.stringify({
      client: { client_id: 'client-1', issuer },
      discovery: {
        authorizationServerUrl: issuer,
        authorizationServerMetadata: metadata,
        // The connector's own address, so the SDK's resource check passes.
        resourceMetadata: { resource: url, authorization_servers: [issuer] }
      },
      tokens: {
        access_token: 'access-seeded',
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: 60,
        issuer
      },
      savedAt: Date.now()
    })
  );
}

/** Each refresh token the fake was sent, in order. */
const refreshesSent = () =>
  fake.seen
    .filter(
      (s) =>
        s.path === '/token' && new URLSearchParams(s.body).get('grant_type') === 'refresh_token'
    )
    .map((s) => new URLSearchParams(s.body).get('refresh_token'));

test("two runs that need a connector's token at once refresh it once", async () => {
  await signedIn('refresh-seeded');
  const tokens = await Promise.all([bearer('tracker'), bearer('tracker')]);
  assert.deepEqual(refreshesSent(), ['refresh-seeded']);
  assert.equal(fake.seen.filter((s) => s.path === '/register').length, 0);
  assert.deepEqual(tokens, ['access-1', 'access-1']);
});

for (const [way, code] of LOST_ANSWERS)
  test(`a connector's refresh whose answer is lost (${code}) is not retried within one request`, async (t) => {
    const refresh = `refresh-lost-${code}`;
    await signedIn(refresh);
    const logged = t.mock.method(console, 'error', () => {});
    fake[way].add('/token');
    assert.equal(await bearer('tracker'), undefined);
    assert.ok(
      logged.mock.calls.some((c) => String(c.arguments[0]).endsWith(`(attempt 1): ${code}`))
    );
    assert.deepEqual(
      refreshesSent().filter((r) => r === refresh),
      [refresh]
    );
  });

// Each way fetch fails before a connection exists, as when the network is not
// up yet. Node 24 puts the code on the error's cause.
for (const code of [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT'
])
  test(`a connector's refresh that never left this computer (${code}) is tried again`, async (t) => {
    const refresh = `refresh-retried-${code}`;
    await signedIn(refresh);
    const real = globalThis.fetch;
    let tries = 0;
    t.mock.method(globalThis, 'fetch', (input: string | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/token')) return real(input, init);
      if (++tries === 1) return Promise.reject(new TypeError('fetch failed', { cause: { code } }));
      return real(input, init);
    });
    assert.match((await bearer('tracker')) ?? '', /^access-/);
    assert.equal(tries, 2);
    assert.deepEqual(
      refreshesSent().filter((r) => r === refresh),
      [refresh]
    );
  });

test('a service refusal shows the next step for the reason the provider returned', async () => {
  const { load } = await import('../../routes/connect/callback/+page.server.ts');
  for (const [code, words] of [
    ['invalid_scope', 'problem in Oddboro'],
    ['invalid_scope', 'invalid_scope'],
    ['temporarily_unavailable', 'Wait a little'],
    ['new_provider_code', 'new_provider_code']
  ]) {
    const url = new URL(`http://localhost/connect/callback?error=${code}`);
    const result = await load({ url } as Parameters<typeof load>[0]);
    assert.ok(result);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes(words), result.message);
  }
});
