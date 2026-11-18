// New Altitude personas in the office, end to end against a fake New Altitude
// (`fake-new-altitude.ts`) that lists the made-up persona `pat`: the account's
// wider sign-in, each persona's own sign-in through the shared callback, the
// sync, and sign-out. Routes run through the server's real `handle`, over the
// office's own database in a throwaway folder. The secret store is a Map, as
// in account.test.ts: the system's own would refuse every grant on a Mac with
// no Keychain prompt to answer. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import type { RequestEvent } from '@sveltejs/kit';
import { HIRE_DEFAULTS } from '@oddboro/ledger/grantable';
import { fakeNewAltitude, MEMBER, PAT } from './fake-new-altitude.ts';

const ACCOUNT = 'new-altitude-account:oauth';
const store = new Map<string, string>();
/** Secrets whose delete the store refuses, as a locked keyring does; `deleteSecret` answers false. */
const undeletable = new Set<string>();
/** Secrets whose write the store refuses; `setSecret` throws, as a failed system call does. */
const unwritable = new Set<string>();
// The real module's other exports too, such as `useShellSecrets`, which the
// office's server hooks import.
const realSecrets = await import('@oddboro/ledger/secrets');
mock.module('@oddboro/ledger/secrets', {
  namedExports: {
    ...realSecrets,
    getSecret: (connector: string, name: string) => store.get(`${connector}:${name}`),
    setSecret: (connector: string, name: string, value: string) => {
      if (unwritable.has(`${connector}:${name}`)) throw new Error('the store refused the write');
      store.set(`${connector}:${name}`, value);
    },
    deleteSecret: (connector: string, name: string) =>
      !undeletable.has(`${connector}:${name}`) && store.delete(`${connector}:${name}`),
    secretStore: () => ({ ok: true })
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

const folder = mkdtempSync(join(tmpdir(), 'oddboro-persona-'));
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
const { installGrantedPersonas, syncPersonas } = await import('./persona.ts');
const { offeredSection } = await import('./persona-offered.ts');
const { history } = await import('./staff.ts');
const { bus } = await import('./events.ts');
const accountRoute = await import('../../routes/api/account/+server.ts');
const personasRoute = await import('../../routes/api/personas/+server.ts');
const personaRoute = await import('../../routes/api/personas/[slug]/+server.ts');
const onboardingRoute = await import('../../routes/api/onboarding/+server.ts');
const callback = await import('../../routes/account/callback/+page.server.ts');
const hooks = await import('../../hooks.server.ts');
const { PAGE, sender } = await import('./diagnostics-harness.ts');
const send = sender(hooks.handle);

type Heard = { type: string; slug?: string; joined?: string; problem?: string };
const heard: Heard[] = [];
bus.on('event', (e: Heard) => void (e.type === 'persona' && heard.push(e)));

after(async () => {
  await fake.close();
  await L.pg.end();
  await stopDatabase();
  rmSync(folder, { recursive: true, force: true });
});

type Handler = (event: RequestEvent) => Response | Promise<Response>;
/** A request through `handle`, as the owner's page sends it: its status and answer. */
async function call(
  route: string,
  handler: Handler,
  how: {
    method?: 'GET' | 'POST' | 'DELETE';
    slug?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const method = how.method ?? 'GET';
  let body: Record<string, unknown> = {};
  const r = await send({
    route,
    method,
    path: how.slug ? route.replace('[slug]', how.slug) : route,
    headers:
      how.headers ?? (method === 'GET' ? {} : { ...PAGE, 'content-type': 'application/json' }),
    body: how.body === undefined ? undefined : JSON.stringify(how.body),
    resolve: async (e) => {
      try {
        const res = await handler({ ...e, params: how.slug ? { slug: how.slug } : {} });
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
const account = (method: 'GET' | 'POST' | 'DELETE') =>
  call('/api/account', accountRoute[method] as Handler, { method });
const offers = (headers?: Record<string, string>) =>
  call('/api/personas', personasRoute.GET as Handler, { headers });
const persona = (method: 'POST' | 'DELETE', slug: string) =>
  call('/api/personas/[slug]', personaRoute[method] as Handler, { method, slug });

type Loaded = { ok: boolean; title: string; message: string };
async function callbackPage(query: string): Promise<Loaded> {
  const url = new URL(`http://127.0.0.1:4517/account/callback?${query}`);
  return (await callback.load({ url } as unknown as Parameters<typeof callback.load>[0])) as Loaded;
}

// Every secret value the flow handled, for the log check.
const handled = new Set<string>();
/** New Altitude's sign-in page, then the browser landing on the callback. */
async function finish(url: string): Promise<Loaded> {
  const res = await fetch(url, { redirect: 'manual' });
  const back = new URL(res.headers.get('location') ?? '').searchParams;
  handled.add(back.get('code') ?? '');
  handled.add(back.get('state') ?? '');
  return callbackPage(back.toString());
}

/** A whole account sign-in: Sign in, New Altitude's page, the callback. */
async function signIn(): Promise<void> {
  const { body } = await account('POST');
  assert.equal((await finish(String(body.url))).title, 'Signed in');
}

/** A whole persona sign-in from Add or Reconnect: its page URL, then the callback. */
async function grant(slug: string): Promise<URL> {
  const { status, body } = await persona('POST', slug);
  assert.equal(status, 200, JSON.stringify(body));
  const url = new URL(String(body.url));
  assert.equal((await finish(url.toString())).title, 'Connected');
  return url;
}

type Blob = {
  tokens?: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
  savedAt?: number;
};
const saved = (key: string) => JSON.parse(store.get(key) ?? '{}') as Blob;
/** Make the account's access token due, as if it were saved long ago. */
function makeDue() {
  const blob = saved(ACCOUNT);
  blob.savedAt = Date.now() - (blob.tokens?.expires_in ?? 0) * 1000;
  store.set(ACCOUNT, JSON.stringify(blob));
}
const personaSecrets = () => [...store.keys()].filter((k) => k.startsWith('new-altitude-persona-'));
/** The personas whose sign-in the store holds, by slug. */
const signedIn = () =>
  personaSecrets()
    .map((k) => k.slice('new-altitude-persona-'.length, -':oauth'.length))
    .sort();
/** The kept list of persona sign-ins, as the store holds it. */
const KEPT = 'new-altitude-personas:granted';
const kept = () => (JSON.parse(store.get(KEPT) ?? '[]') as string[]).sort();
const seenAt = (path: string) => fake.seen.filter((s) => s.path === path);
const revoked = () => seenAt('/revoke').map((s) => new URLSearchParams(s.body).get('token'));
const odd = (slug: string) => L.personaOdd(slug);

/** A second persona New Altitude lists, drawn apart from `pat` so both can work here. */
const QUINN = (() => {
  const q = structuredClone(PAT) as {
    slug: string;
    odd: {
      name: string;
      look: { hair: string; colours: Record<string, string> };
      parts: { name: string; px: string }[];
    };
  };
  q.slug = 'quinn';
  q.odd.name = 'Quinn';
  q.odd.parts[0].name = 'quinn-short-tuft';
  q.odd.parts[0].px = q.odd.parts[0].px.replace('hair-pat-short-tuft', 'hair-quinn-short-tuft');
  q.odd.look.hair = 'quinn-short-tuft';
  q.odd.look.colours.top = 'navy';
  return q;
})();

/** A persona New Altitude lists whose package the office refuses: its part's drawing is named for Quinn's part. */
const BROKEN = (() => {
  const b = structuredClone(QUINN);
  b.slug = 'broken';
  b.odd.name = 'Bram';
  b.odd.parts[0].name = 'broken-short-tuft';
  return b;
})();
const NOT_OFFERED = 'New Altitude does not offer this persona to your account.';

test('signing in asks for profile and personas, and a profile-only grant still refreshes', async () => {
  const { body } = await account('POST');
  assert.equal(new URL(String(body.url)).searchParams.get('scope'), 'profile personas');
  assert.equal((await finish(String(body.url))).title, 'Signed in');
  assert.equal(saved(ACCOUNT).tokens?.scope, 'profile personas');

  // A sign-in made before the office asked for personas.
  fake.issueGrant('access-profile', 'refresh-profile', 'profile');
  const blob = saved(ACCOUNT);
  blob.tokens = {
    ...blob.tokens!,
    access_token: 'access-profile',
    refresh_token: 'refresh-profile',
    scope: 'profile'
  };
  store.set(ACCOUNT, JSON.stringify(blob));
  makeDue();
  const refreshes = () =>
    seenAt('/token').filter(
      (s) => new URLSearchParams(s.body).get('grant_type') === 'refresh_token'
    );
  const before = refreshes().length;
  assert.ok(await accountToken());
  const sent = refreshes().slice(before);
  assert.equal(sent.length, 1);
  assert.equal(new URLSearchParams(sent[0].body).has('scope'), false);
  assert.equal(accountStatus().state, 'in');
  assert.equal(saved(ACCOUNT).tokens?.scope, 'profile');
});

test('an account signed in without personas is asked to sign in again, and signing in again asks for personas', async () => {
  const listings = seenAt('/api/personas/odds').length;
  assert.deepEqual((await offers()).body, { state: 'rescope' });
  assert.equal(seenAt('/api/personas/odds').length, listings);

  assert.equal((await account('DELETE')).status, 200);
  const { body } = await account('POST');
  assert.equal(new URL(String(body.url)).searchParams.get('scope'), 'profile personas');
  assert.equal((await finish(String(body.url))).title, 'Signed in');

  fake.refused.set('/api/personas/odds', 401);
  try {
    assert.deepEqual((await offers()).body, { state: 'refused' });
  } finally {
    fake.refused.delete('/api/personas/odds');
  }
});

test('Add on a persona New Altitude does not offer, as a stale card asks, gets 404 and no sign-in', async () => {
  const r = await persona('POST', 'nobody');
  assert.equal(r.status, 404);
  assert.equal(r.body.message, NOT_OFFERED);
  assert.equal(store.has('new-altitude-persona-nobody:oauth'), false);
});

test('a persona granted before the office opens joins right after the manager', async () => {
  assert.equal(await L.welcomed(), false);
  // One whose package the office refuses, so its install fails, then `pat`.
  fake.odds = [PAT, BROKEN];
  await grant('broken');
  const brokenRefresh = saved('new-altitude-persona-broken:oauth').tokens?.refresh_token;
  const url = await grant('pat');
  assert.equal(url.searchParams.get('resource'), `${fake.origin}/pat/stream`);
  assert.equal(await odd('pat'), undefined, 'nobody joins before the office opens');

  const told = heard.length;
  const r = await call('/api/onboarding', onboardingRoute.POST as Handler, {
    method: 'POST',
    body: { name: 'Ada', zone: 'UTC', manager: { preset: 'marshall' } }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    (await L.roster()).map((s) => s.name),
    ['Marshall', 'Pat']
  );
  const pat = await odd('pat');
  assert.ok(pat);
  assert.deepEqual(
    { permission: pat.permission, tools: pat.tools },
    HIRE_DEFAULTS.persona,
    'a persona starts at its own level and tools'
  );
  assert.deepEqual(
    history(pat.id).map((m) => m.text),
    ["Hi Ada, I'm Pat. Ask me what I think of anything."]
  );
  const after = heard.slice(told);
  // The refused install ends its sign-in, which no Odd holds for sign-out to end.
  assert.equal(after.find((e) => e.slug === 'broken')?.joined, 'no');
  assert.match(after.find((e) => e.slug === 'broken')?.problem ?? '', /broken-short-tuft/);
  assert.equal(store.has('new-altitude-persona-broken:oauth'), false);
  assert.ok(revoked().includes(brokenRefresh!));
  assert.deepEqual(
    after.find((e) => e.slug === 'pat'),
    {
      type: 'persona',
      slug: 'pat',
      joined: 'installed'
    }
  );
});

test('adding a persona runs its own grant for its door, and the callback finishes it', async () => {
  // The office is open (the test before), and New Altitude offers a second persona.
  fake.odds = [PAT, QUINN];
  const told = heard.length;
  const url = await grant('quinn');
  assert.equal(url.searchParams.get('resource'), `${fake.origin}/quinn/stream`);
  assert.equal(url.searchParams.get('scope'), 'stream');
  const kept = saved('new-altitude-persona-quinn:oauth');
  assert.ok(kept.tokens?.access_token);
  assert.equal(kept.tokens?.scope, 'stream');
  assert.deepEqual(
    heard.slice(told).map((e) => e.joined),
    ['granted', 'installed']
  );
  assert.ok(await odd('quinn'));

  // Disconnect ends its sign-in and makes it quiet; Reconnect lifts that.
  const refresh = kept.tokens?.refresh_token;
  assert.equal((await persona('DELETE', 'quinn')).status, 200);
  assert.ok(revoked().includes(refresh!));
  assert.equal(store.has('new-altitude-persona-quinn:oauth'), false);
  assert.equal((await odd('quinn'))?.package?.quiet, 'grant');
  await grant('quinn');
  assert.equal((await odd('quinn'))?.package?.quiet, undefined);
});

test('sync at start lifts quiet when New Altitude lists the persona again, and an unreachable New Altitude changes nothing', async () => {
  const pat = (await odd('pat'))!;
  await L.setQuiet(pat.id, 'access');
  assert.equal((await syncPersonas()).state, 'ok');
  assert.equal((await odd('pat'))?.package?.quiet, undefined);

  // No longer listed: quiet for access.
  fake.odds = [QUINN];
  await syncPersonas();
  assert.equal((await odd('pat'))?.package?.quiet, 'access');

  fake.odds = [PAT, QUINN];
  fake.down.add('/api/personas/odds');
  try {
    assert.deepEqual(await syncPersonas(), { state: 'unreachable' });
  } finally {
    fake.down.delete('/api/personas/odds');
  }
  assert.equal((await odd('pat'))?.package?.quiet, 'access');
  await syncPersonas();
  assert.equal((await odd('pat'))?.package?.quiet, undefined);

  // A quiet for its own sign-in is the owner's to lift: the list neither replaces nor lifts it.
  await L.setQuiet(pat.id, 'grant');
  fake.odds = [QUINN];
  await syncPersonas();
  assert.equal((await odd('pat'))?.package?.quiet, 'grant');
  fake.odds = [PAT, QUINN];
  await syncPersonas();
  assert.equal((await odd('pat'))?.package?.quiet, 'grant');
  await L.setQuiet(pat.id, undefined);
});

test('a page from another site cannot make the office read the list of personas', async () => {
  const listings = () => seenAt('/api/personas/odds').length;
  const before = listings();
  const r = await offers({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(listings(), before);
  // The office's own page, and a client that says nothing, still read it.
  assert.equal((await offers(PAGE)).status, 200);
  assert.equal((await offers()).status, 200);
  assert.equal(listings(), before + 2);
});

test("signing out ends every persona's sign-in and makes each persona Odd quiet", async () => {
  const held = [ACCOUNT, ...personaSecrets()].map((k) => saved(k).tokens?.refresh_token);
  assert.equal(held.length, 3, 'the account, pat and quinn');
  const before = revoked().length;
  assert.equal((await account('DELETE')).status, 200);
  assert.deepEqual(revoked().slice(before).sort(), held.sort());
  assert.deepEqual(personaSecrets(), []);
  for (const slug of ['pat', 'quinn'])
    assert.equal((await odd(slug))?.package?.quiet, 'signed-out', slug);
});

test("an account sign-in New Altitude cannot name signs out and ends every persona's sign-in", async () => {
  await signIn();
  await grant('pat');
  assert.equal((await odd('pat'))?.package?.quiet, undefined);
  const refresh = saved('new-altitude-persona-pat:oauth').tokens?.refresh_token;
  // New Altitude refused a refresh: the account shows Sign in again; pat's sign-in stays.
  fake.refuseNextRefresh = { error: 'invalid_grant' };
  makeDue();
  assert.equal(await accountToken(), undefined);
  assert.equal(accountStatus().state, 'expired');
  assert.deepEqual(personaSecrets(), ['new-altitude-persona-pat:oauth']);
  // New Altitude still answers discovery, but a persona's sign-in waits for the account's.
  const added = await persona('POST', 'quinn');
  assert.equal(added.status, 409);
  assert.equal(added.body.message, 'Sign in to New Altitude first.');

  const { body } = await account('POST');
  fake.refused.set('/api/me', 401);
  try {
    const page = await finish(String(body.url));
    assert.equal(page.ok, false);
    assert.equal(page.message, 'New Altitude did not say who signed in. Try Sign in again.');
  } finally {
    fake.refused.delete('/api/me');
  }
  assert.equal(accountStatus().state, 'out');
  assert.deepEqual(personaSecrets(), []);
  assert.ok(revoked().includes(refresh!));
  assert.equal((await odd('pat'))?.package?.quiet, 'signed-out');
});

test("a new account sign-in makes the account's older page old and leaves a persona's sign-in in flight good", async () => {
  await signIn();
  // Add pressed: pat's sign-in page is open, not finished.
  const added = await persona('POST', 'pat');
  assert.equal(added.status, 200, JSON.stringify(added.body));
  // Then New Altitude refuses the account's refresh, and the owner signs in again, twice.
  fake.refuseNextRefresh = { error: 'invalid_grant' };
  makeDue();
  assert.equal(await accountToken(), undefined);
  const older = (await account('POST')).body.url;
  const newer = (await account('POST')).body.url;

  assert.equal(
    (await finish(String(older))).message,
    'This sign-in link is old. Start it again from Oddboro.'
  );
  assert.equal((await finish(String(newer))).title, 'Signed in');
  assert.equal((await finish(String(added.body.url))).title, 'Connected');
  assert.equal((await odd('pat'))?.package?.quiet, undefined);
});

test("only a persona's newest sign-in page finishes, and an older one leaves the sign-in it holds alone", async () => {
  const PAT_GRANT = 'new-altitude-persona-pat:oauth';
  const OLD = 'This sign-in link is old. Start it again from Oddboro.';
  const twoPages = async () => {
    assert.equal((await persona('DELETE', 'pat')).status, 200);
    // Add pressed twice: a blocked pop-up, then the waiting link.
    return [(await persona('POST', 'pat')).body.url, (await persona('POST', 'pat')).body.url];
  };

  // Quinn's page, opened between Pat's two, stays good: each persona's pages are its own.
  assert.equal((await persona('DELETE', 'pat')).status, 200);
  assert.equal((await persona('DELETE', 'quinn')).status, 200);
  let older = (await persona('POST', 'pat')).body.url;
  const quinn = (await persona('POST', 'quinn')).body.url;
  let newer = (await persona('POST', 'pat')).body.url;
  assert.equal((await finish(String(quinn))).title, 'Connected');
  assert.equal((await finish(String(newer))).title, 'Connected');
  const held = saved(PAT_GRANT).tokens?.access_token;
  assert.equal((await finish(String(older))).message, OLD);
  assert.equal(saved(PAT_GRANT).tokens?.access_token, held);
  assert.equal((await odd('pat'))?.package?.quiet, undefined);

  [older, newer] = await twoPages();
  assert.equal((await finish(String(older))).message, OLD);
  assert.equal((await finish(String(newer))).title, 'Connected');

  // A page that arrives while the sign-in holds: another office on this computer finished one.
  [, newer] = await twoPages();
  const blob = saved(PAT_GRANT);
  blob.tokens = { access_token: 'access-other-office', refresh_token: 'refresh-other-office' };
  store.set(PAT_GRANT, JSON.stringify(blob));
  assert.equal((await finish(String(newer))).message, OLD);
  assert.equal(saved(PAT_GRANT).tokens?.access_token, 'access-other-office');

  // A persona's page that fails says where to start again, and logs as the persona's.
  const { body } = await persona('DELETE', 'pat').then(() => persona('POST', 'pat'));
  fake.refused.set('/token', 500);
  try {
    assert.equal(
      (await finish(String(body.url))).message,
      'New Altitude did not finish the sign-in. Press Add or Reconnect in Oddboro again.'
    );
  } finally {
    fake.refused.delete('/token');
  }
  assert.ok(printed.at(-1)?.startsWith('[persona]'), printed.at(-1));
  await grant('pat');
});

test('Add while the sign-in holds tokens opens no page: a refresh that works needs none, and one New Altitude does not answer says so', async () => {
  const PAT_GRANT = 'new-altitude-persona-pat:oauth';
  const fine = await persona('POST', 'pat');
  assert.equal(fine.status, 200);
  assert.equal(fine.body.url, '');

  // The SDK keeps the tokens through a 5xx refresh and would go on to a page that cannot finish.
  fake.refuseNextRefresh = { error: 'server_error' };
  const held = saved(PAT_GRANT).tokens?.refresh_token;
  const r = await persona('POST', 'pat');
  assert.equal(r.status, 502);
  assert.equal(r.body.message, 'New Altitude did not answer. Try again in a minute.');
  assert.equal(saved(PAT_GRANT).tokens?.refresh_token, held);
  // Once New Altitude answers, Add works again.
  assert.equal((await persona('POST', 'pat')).body.url, '');
});

test('the kept list names each persona whose sign-in the store holds, and no other', async () => {
  assert.deepEqual(kept(), ['pat', 'quinn']);
  assert.deepEqual(kept(), signedIn());

  // A delete the store refuses keeps the name, so a later Disconnect or sign-out tries again.
  const QUINN_GRANT = 'new-altitude-persona-quinn:oauth';
  undeletable.add(QUINN_GRANT);
  try {
    assert.equal((await persona('DELETE', 'quinn')).status, 200);
  } finally {
    undeletable.delete(QUINN_GRANT);
  }
  assert.deepEqual(kept(), ['pat', 'quinn']);
  assert.deepEqual(kept(), signedIn());
  assert.equal((await persona('DELETE', 'quinn')).status, 200);
  assert.deepEqual(kept(), ['pat']);
  assert.deepEqual(kept(), signedIn());

  // A page opened and never finished leaves a sign-in in the store, so the list names it.
  assert.equal((await persona('POST', 'quinn')).status, 200);
  assert.deepEqual(kept(), ['pat', 'quinn']);
  assert.deepEqual(kept(), signedIn());

  // Sign-out ends them all and leaves no list behind.
  assert.equal((await account('DELETE')).status, 200);
  assert.deepEqual(personaSecrets(), []);
  assert.equal(store.has(KEPT), false);
  await signIn();
  await grant('pat');
});

test('a kept sign-in for a persona with no Odd hires nobody until Add, and ends at sign-out either way', async () => {
  // The store holds sign-ins for Rae and Sam from another office on this
  // computer, or from before a reset. New Altitude lists Rae and has stopped listing Sam.
  const rae = structuredClone(QUINN);
  rae.slug = 'rae';
  rae.odd.name = 'Rae';
  rae.odd.parts[0].name = 'rae-short-tuft';
  rae.odd.parts[0].px = rae.odd.parts[0].px.replace('hair-quinn-short-tuft', 'hair-rae-short-tuft');
  rae.odd.look.hair = 'rae-short-tuft';
  fake.odds = [PAT, QUINN, rae];
  // Each made from Pat's sign-in, with its own tokens and its own door.
  const pat = store.get('new-altitude-persona-pat:oauth')!;
  for (const slug of ['rae', 'sam']) {
    fake.issueGrant(`access-${slug}`, `refresh-${slug}`, 'stream');
    const blob = JSON.parse(pat.replaceAll('/pat/', `/${slug}/`)) as Blob;
    blob.tokens = { access_token: `access-${slug}`, refresh_token: `refresh-${slug}` };
    store.set(`new-altitude-persona-${slug}:oauth`, JSON.stringify(blob));
  }
  // The earlier run's writes named them in the kept list.
  store.set(KEPT, JSON.stringify([...kept(), 'rae', 'sam']));

  // A sign-in is not the owner's yes: Rae's card still offers Add, and Open hires nobody.
  const listed = (await offers()).body.offers as { slug: string; joined: string }[];
  assert.equal(listed.find((o) => o.slug === 'rae')?.joined, 'no');
  assert.equal(
    listed.find((o) => o.slug === 'sam'),
    undefined
  );
  await installGrantedPersonas();
  assert.equal(await odd('rae'), undefined);
  assert.equal(await odd('sam'), undefined);
  // Add uses the kept sign-in, so no page opens, and Rae joins the open office.
  assert.equal((await persona('POST', 'rae')).body.url, '');
  assert.ok(await odd('rae'));
  assert.equal(await odd('sam'), undefined);
  const held = [ACCOUNT, ...personaSecrets()].map((k) => saved(k).tokens?.refresh_token);
  assert.equal(held.length, 4, 'the account, pat, rae and sam');
  const before = revoked().length;
  assert.equal((await account('DELETE')).status, 200);
  assert.deepEqual(personaSecrets(), []);
  assert.equal(store.has(KEPT), false);
  // One revoke for each sign-in, Sam's too.
  assert.deepEqual(revoked().slice(before).sort(), held.sort());
});

test('a store that refuses to write the kept list still lets sign-out end every sign-in, and the next sign-out clears the list', async () => {
  await signIn();
  await grant('pat');
  await grant('quinn');
  assert.deepEqual(kept(), ['pat', 'quinn']);
  const held = [ACCOUNT, ...personaSecrets()].map((k) => saved(k).tokens?.refresh_token);
  assert.equal(held.length, 3, 'the account, pat and quinn');
  const before = revoked().length;
  const logged = printed.length;
  unwritable.add(KEPT);
  try {
    assert.equal((await account('DELETE')).status, 200);
  } finally {
    unwritable.delete(KEPT);
  }
  assert.equal(accountStatus().state, 'out');
  assert.deepEqual(personaSecrets(), []);
  assert.deepEqual(revoked().slice(before).sort(), held.sort());
  for (const slug of ['pat', 'quinn'])
    assert.ok(
      printed.slice(logged).some((l) => l.startsWith('[persona]') && l.includes(`names ${slug}`)),
      slug
    );
  // The list still names both, so the next sign-out tries them again.
  assert.deepEqual(kept(), ['pat', 'quinn']);
  assert.equal((await account('DELETE')).status, 200);
  assert.equal(store.has(KEPT), false);
});

/** A persona like Quinn under its own slug, name and hair part, so it can work here too. */
function another(slug: string, name: string) {
  const p = structuredClone(QUINN) as typeof QUINN & { displayName: string };
  p.slug = slug;
  p.displayName = `${name} Example`;
  p.odd.name = name;
  p.odd.parts[0].name = `${slug}-short-tuft`;
  p.odd.parts[0].px = p.odd.parts[0].px.replace('hair-quinn-short-tuft', `hair-${slug}-short-tuft`);
  p.odd.look.hair = `${slug}-short-tuft`;
  return p;
}

test("a persona added from a hire ask's window answers that ask once it joins, and only then", async () => {
  await signIn();
  fake.odds = [PAT, QUINN, another('tess', 'Tess'), another('uma', 'Uma')];
  const manager = (await L.roster())[0].id;
  const propose = async (name: string) =>
    (
      await L.raiseAsk(manager, {
        title: `Hire ${name}, ${name} Example Persona`,
        why: 'For their view.',
        ifApproved: 'The hire window opens with this filled in.',
        hire: {
          name,
          role: `${name} Example Persona`,
          permission: 'read',
          remit: 'Gives a view.',
          jobDescriptionFile: 'notes/jd.md'
        }
      })
    ).ask.id;
  const addFrom = (slug: string, askId: number) =>
    call('/api/personas/[slug]', personaRoute.POST as Handler, {
      method: 'POST',
      slug,
      body: { askId }
    });
  const status = async (id: number) => (await L.ask(id))?.status;

  // Add on Tess's proposal, and the owner leaves the sign-in page unfinished.
  const forTess = await propose('Tess');
  assert.equal((await addFrom('tess', forTess)).status, 200);
  assert.equal(await odd('tess'), undefined);
  assert.equal(await status(forTess), 'open');
  // Tess joins later from Setup's Add, which names no ask: the proposal stays open.
  await grant('tess');
  assert.ok(await odd('tess'));
  assert.equal(await status(forTess), 'open');

  // Add on Uma's proposal, and the sign-in finishes: her join answers it.
  const forUma = await propose('Uma');
  const { body } = await addFrom('uma', forUma);
  assert.equal((await finish(String(body.url))).title, 'Connected');
  assert.ok(await odd('uma'));
  const answered = await L.ask(forUma);
  assert.equal(answered?.status, 'approved');
  assert.equal(
    answered?.reason,
    "Ada added Uma Example's New Altitude persona instead of a new Odd."
  );

  // An Odd that can propose a hire hears who is on offer from the last read,
  // and who works here already. Signing out takes the list away.
  const here = new Set(['pat', 'quinn', 'tess', 'uma']);
  assert.match(offeredSection(new Set(['pat'])), /persona_slug/);
  assert.match(offeredSection(new Set(['pat'])), /Uma Example \(uma\)/);
  assert.doesNotMatch(offeredSection(here), /persona_slug/);
  assert.match(offeredSection(here), /Already working here as personas: Pat Example/);
  assert.equal((await account('DELETE')).status, 200);
  assert.equal(offeredSection(new Set()), '');
});

test('no token, code, state or verifier reaches .env or the logs', async () => {
  assert.equal(readFileSync(settings, 'utf8'), SETTINGS);
  for (const s of fake.seen) {
    const form = new URLSearchParams(s.body);
    for (const key of ['code', 'code_verifier', 'refresh_token', 'token'])
      if (form.get(key)) handled.add(form.get(key)!);
  }
  const words = [...handled, 'access-', 'refresh-', MEMBER.email].filter(Boolean);
  assert.ok(words.length > 10, 'the flow handled secrets to look for');
  for (const line of printed)
    for (const word of words) assert.ok(!line.includes(word), `a log line holds ${word}`);
});
