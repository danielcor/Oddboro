// A hosted server that signs in through GitHub, which lets no app register
// itself (issue #64): the office signs in with New Altitude's GitHub app and
// its own scopes. GitHub and GitHub's MCP server are a stand-in on 127.0.0.1,
// which fetch reaches in their place, over the office's own database in a
// throwaway folder. The secret store is a Map. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const store = new Map<string, string>();
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

const folder = mkdtempSync(join(tmpdir(), 'oddboro-github-'));
const port = await new Promise<number>((done) => {
  const s = createNetServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => done(p));
  });
});
Object.assign(process.env, {
  ODDBORO_HOME: folder,
  ODDBORO_DB_PORT: String(port),
  ODDBORO_ENV: join(folder, 'none.env'),
  ODDBORO_LOCAL_DB: '1'
});

/** GitHub's own scopes list, as its MCP server gives it (fetched 2026-11-09). */
const GITHUB_LISTS = [
  'repo',
  'read:org',
  'read:user',
  'user:email',
  'read:packages',
  'write:packages',
  'read:project',
  'project',
  'gist',
  'notifications'
];
const ISSUER = 'https://github.com/login/oauth';
const SERVER = 'https://api.githubcopilot.com/mcp/x/repos/readonly';

/** What the stand-in saw, and the code challenge the next code was issued for. */
const seen: { method: string; path: string; body: string }[] = [];
let challenge = '';
let n = 0;
const refreshes = new Set<string>();

/** GitHub's documents as it serves them: no registration endpoint. */
const github = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method ?? '', path, body });
    const send = (status: number, value: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (path.startsWith('/.well-known/oauth-protected-resource'))
      return send(200, {
        resource: SERVER,
        authorization_servers: [ISSUER],
        scopes_supported: GITHUB_LISTS,
        bearer_methods_supported: ['header']
      });
    if (
      path.startsWith('/.well-known/oauth-authorization-server') ||
      path.startsWith('/.well-known/openid-configuration')
    )
      return send(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/access_token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256']
      });
    if (path === '/login/oauth/access_token' && req.method === 'POST') {
      // GitHub refuses with 200 and its own error codes in the body (checked
      // against github.com 2026-11-10), never a 4xx.
      const form = new URLSearchParams(body);
      if (form.get('client_id') !== 'Ov23liHSAMGGQ2kvqbkS' || form.get('client_secret') !== 'shh')
        return send(200, { error: 'incorrect_client_credentials' });
      if (form.get('grant_type') === 'authorization_code') {
        const proof = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (proof !== challenge) return send(200, { error: 'bad_verification_code' });
      } else if (!refreshes.delete(form.get('refresh_token') ?? ''))
        return send(200, {
          error: 'bad_refresh_token',
          error_description: 'The refresh token passed is incorrect or expired.'
        });
      n++;
      refreshes.add(`ghr_${n}`);
      // Inside the office's refresh margin, so the next bearer() renews it.
      return send(200, {
        access_token: `gho_${n}`,
        refresh_token: `ghr_${n}`,
        token_type: 'bearer',
        expires_in: 60,
        scope: 'repo,read:org,read:user'
      });
    }
    send(404, { error: 'not_found' });
  });
});
await new Promise<void>((done) => github.listen(0, '127.0.0.1', done));
const stand = `http://127.0.0.1:${(github.address() as { port: number }).port}`;

// GitHub and its MCP server answer from the stand-in; everything else is real.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host === 'github.com' || url.host === 'api.githubcopilot.com')
    return realFetch(`${stand}${url.pathname}${url.search}`, init);
  return realFetch(input, init);
};

const { startLocalDatabase } = await import('@oddboro/ledger/local-db');
const stopDatabase = await startLocalDatabase();
const { bringUpToDate } = await import('@oddboro/ledger/upgrade');
await bringUpToDate();
const L = await import('@oddboro/ledger');
const { bearer, finishSignIn, GITHUB_SCOPES, startSignIn } = await import('./oauth.ts');
const { hostedSignIn } = await import('./access.ts');

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((done) => github.close(() => done()));
  await L.pg.end();
  await stopDatabase();
  rmSync(folder, { recursive: true, force: true });
});

await L.addConnector({
  id: 'githubcopilot',
  name: 'githubcopilot.com',
  description: "GitHub's hosted MCP server, read only.",
  kind: 'http',
  config: { url: SERVER, oauth: true }
});

test("a server that signs in through GitHub uses New Altitude's GitHub app and the office's own scopes, and never registers", async () => {
  process.env.ODDBORO_GITHUB_CLIENT_SECRET = 'shh';
  store.clear();
  seen.length = 0;
  const { url } = await startSignIn('githubcopilot');
  const page = new URL(url ?? '');
  assert.equal(`${page.origin}${page.pathname}`, `${ISSUER}/authorize`);
  assert.equal(page.searchParams.get('client_id'), 'Ov23liHSAMGGQ2kvqbkS');
  assert.equal(page.searchParams.get('scope'), 'repo read:org read:user');
  assert.equal(GITHUB_SCOPES, 'repo read:org read:user');
  assert.equal(page.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(page.searchParams.get('redirect_uri'), `${L.OFFICE_URL}/connect/callback`);
  assert.ok(!seen.some((s) => s.method === 'POST' && s.path !== '/login/oauth/access_token'));

  challenge = page.searchParams.get('code_challenge') ?? '';
  assert.equal(await finishSignIn(page.searchParams.get('state') ?? '', 'code-1'), 'githubcopilot');
  const kept = store.get('githubcopilot:oauth') ?? '';
  assert.equal(
    (JSON.parse(kept) as { tokens: { access_token: string } }).tokens.access_token,
    'gho_1'
  );
  // The app's secret comes from the build, never the secret store.
  assert.ok(!kept.includes('shh'), kept);

  // The token runs out within the margin, so a run's bearer renews it with the app.
  assert.equal(await bearer('githubcopilot'), 'gho_2');
  const renewal = new URLSearchParams(seen.at(-1)?.body);
  assert.equal(renewal.get('grant_type'), 'refresh_token');
  assert.equal(renewal.get('client_id'), 'Ov23liHSAMGGQ2kvqbkS');
});

test('a renewal GitHub refuses with a 200 is logged with its reason and forgets the dead sign-in', async () => {
  // GitHub no longer takes the stored refresh token.
  refreshes.clear();
  const logged: string[] = [];
  const log = mock.method(console, 'error', (line: unknown) => void logged.push(String(line)));
  try {
    assert.equal(await bearer('githubcopilot'), undefined);
  } finally {
    log.mock.restore();
  }
  assert.ok(
    logged.some((l) =>
      l.includes(
        'GitHub refused the token request: bad_refresh_token: The refresh token passed is incorrect or expired.'
      )
    ),
    logged.join('\n')
  );
  assert.ok(logged.some((l) => l.includes("githubcopilot's sign-in did not renew")));
  // The dead tokens are gone, so the office shows the tool as needing a sign-in.
  const kept = JSON.parse(store.get('githubcopilot:oauth') ?? '{}') as { tokens?: unknown };
  assert.equal(kept.tokens, undefined);
  // And the next run asks GitHub nothing.
  seen.length = 0;
  assert.equal(await bearer('githubcopilot'), undefined);
  assert.ok(!seen.some((s) => s.path === '/login/oauth/access_token'));
});

test("a build without the GitHub app's secret says so on Sign in, never that the server offers no sign-in", async () => {
  delete process.env.ODDBORO_GITHUB_CLIENT_SECRET;
  store.clear();
  await assert.rejects(hostedSignIn('githubcopilot'), {
    message:
      'This copy of Oddboro was built without its GitHub sign-in. Update Oddboro, or in development set ODDBORO_GITHUB_CLIENT_SECRET in .env.'
  });
});
