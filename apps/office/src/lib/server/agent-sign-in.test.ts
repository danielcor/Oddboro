// Installing the office's coding tools and signing them in from the page
// (agent-sign-in.ts and routes/api/agents/[tool]), in an office under test
// (office-under-test.ts) whose stand-in `grok`, `codex` and `claude` play each
// sign-in and stand-in `npm` and `bash` each installer: what "Runs on" and
// setup's Your AI list hear of each tool on a Mac, Linux and Windows, the
// tool the office runs on and a hire that starts on it, each tool's own installer run to
// its end, one at a time, a Grok installed only in xAI's install folder found
// without a restart, Grok's and Codex's browser sign-ins in the office's own
// homes, starting over and Cancel, Sign out that never runs a tool's own
// logout, Gemini's key, kept in the stand-in secret store once Google (stood
// in for) takes it, Claude Code's sign-in on the same runner, and the one
// action each row offers. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  L,
  OFFICE_GEMINI_KEY,
  agents,
  assertKeychainUntouched,
  awayFromHome,
  bin,
  chatOf,
  folder,
  installers,
  nodeBin,
  installs,
  onPlatform,
  secretReads,
  secrets,
  withEnv
} from './office-under-test.ts';
import { onPath } from './on-path.ts';
import { offersSignOut, toolAction, type ToolAction } from '../ui/tool-action.ts';
import type { AgentTool, LaterTool } from '../../routes/api/agents/+server.ts';

const route = await import('../../routes/api/agents/[tool]/+server.ts');
const claudeRoute = await import('../../routes/api/setup/claude/+server.ts');
const { geminiKeyMissing, clearGeminiKey, setGeminiKey } = await import('./gemini.ts');
const { SLOTS } = await import('./agent-sign-in.ts');

// A test that fails or runs out of time leaves its install or sign-in running,
// and every test after it would find that tool still busy.
afterEach(() => {
  for (const slot of Object.values(SLOTS)) slot.stop('The test ended.');
});

const GROK_HOME = join(folder, 'accounts', 'grok', 'office');
const CODEX_HOME = join(folder, 'accounts', 'codex', 'office');

/** One request to the sign-in route for `tool`, as the page sends it. */
function send(method: 'POST' | 'PUT' | 'DELETE', tool: string, body?: unknown) {
  const event = {
    params: { tool },
    request: new Request(`http://office/api/agents/${tool}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  } as unknown as Parameters<typeof route.POST>[0];
  return route[method](event);
}
type Listing = { office: string; tools: AgentTool[]; later: LaterTool[] };
/** What "Runs on" and the Your AI list hear, as on `platform`. */
async function listing(platform: NodeJS.Platform = 'darwin'): Promise<Listing> {
  return onPlatform(platform, async () => {
    const res = await agents.GET({} as Parameters<typeof agents.GET>[0]);
    return (await res.json()) as Listing;
  });
}
/** The tools "Runs on" and the list hear of, as on a Mac. */
const listed = async (platform: NodeJS.Platform = 'darwin') => (await listing(platform)).tools;
/** Pick the office's tool as the page does, on `platform`. */
const pickOffice = (office: unknown, platform: NodeJS.Platform = 'darwin') =>
  onPlatform(platform, () =>
    agents.PUT({
      request: new Request('http://office/api/agents', {
        method: 'PUT',
        body: JSON.stringify({ office })
      })
    } as unknown as Parameters<typeof agents.PUT>[0])
  );
const stateOf = async (id: string) => (await listed()).find((t) => t.id === id)?.signIn;

/**
 * `check` once it gives a value, within 30 s: a stand-in installer can take
 * seconds to start on a busy machine, and a value ends the wait at once.
 */
async function waitFor<T>(check: () => T | undefined, what: string): Promise<T> {
  const until = Date.now() + 30_000;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > until) assert.fail(`still waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Line = { line?: string; url?: string; done?: boolean; ok?: boolean };
/** A streamed sign-in: the lines so far, the sign-in page's address once printed, and every line once it ends. */
function follow(res: Response) {
  const seen: Line[] = [];
  assert.ok(res.body, 'the sign-in streams nothing');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const ended = (async () => {
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return seen;
      buf += value;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        seen.push(JSON.parse(buf.slice(0, i)) as Line);
        buf = buf.slice(i + 1);
      }
    }
  })();
  return {
    ended,
    url: () => waitFor(() => seen.find((l) => l.url)?.url, 'the sign-in page'),
    /** The last two lines once it ends: why, and how. */
    end: async () => (await ended).slice(-2)
  };
}
/** Start `tool`'s sign-in from the page, as on a Mac. */
const signIn = (tool: string) =>
  onPlatform('darwin', async () => follow(await send('POST', tool, { action: 'sign-in' })));
/** What the stand-in `login` of the tool in `home` was started with, last. */
const lastLogin = (home: string) =>
  JSON.parse(
    readFileSync(join(home, 'logins.jsonl'), 'utf8').trim().split('\n').at(-1) ?? '{}'
  ) as {
    args: string[];
    home: string;
    configFirst?: boolean;
  };
const loginPid = (home: string) => Number(readFileSync(join(home, 'login.pid'), 'utf8'));
/** Whether a process is gone. */
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
};
/** The sign-in the office's Codex home starts with under test: a file with no account in it. */
const codexAsBefore = () => writeFileSync(join(CODEX_HOME, 'auth.json'), '{}');
/** A sign-in in the office's Grok home for `email`, as `grok login` keeps one. */
function grokSignedInAs(email: string): void {
  mkdirSync(GROK_HOME, { recursive: true });
  writeFileSync(
    join(GROK_HOME, 'auth.json'),
    JSON.stringify({ 'https://auth.x.ai::test': { email, expires_at: '2099-01-01T00:00:00Z' } })
  );
}
/** A route's refusal: its status and the words the owner reads. */
const refused = (status: number, message?: string) => (e: unknown) => {
  const r = e as { status?: number; body?: { message?: string } };
  return r.status === status && (message === undefined || r.body?.message === message);
};

/** Start `tool`'s install from the page, as on a Mac. */
const install = (tool: string) =>
  onPlatform('darwin', async () => follow(await send('POST', tool, { action: 'install' })));
/** Every installer the page ran so far, as its stand-in logged it: its name and arguments, and the names in its environment. */
const installRuns = (): { args: string[]; env: string[] }[] =>
  existsSync(installs)
    ? readFileSync(installs, 'utf8')
        .split('\n')
        .slice(0, -1) // The child may still be writing the last line.
        .map((l) => JSON.parse(l) as { args: string[]; env: string[] })
    : [];
/** Every installer the page ran so far, by its name and arguments. */
const installed = (): string[][] => installRuns().map((r) => r.args);
/** `fn` on a Mac with none of the tools on PATH, only the installers' stand-ins, and an empty home. */
async function withNoTools<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const path = process.env.PATH;
  process.env.PATH = `${installers}:${nodeBin}:/usr/bin:/bin`;
  try {
    // The installers run here are the stand-ins, never the Mac's own.
    assert.equal(onPath('npm'), join(installers, 'npm'));
    assert.equal(onPath('bash'), join(installers, 'bash'));
    return await awayFromHome(fn);
  } finally {
    process.env.PATH = path;
  }
}
const toolIn = async (id: string) => (await listed()).find((t) => t.id === id);

test('the "Runs on" list says which tools the office is signed in to, with the account', async () => {
  const tools = await listed();
  assert.deepEqual(tools.find((t) => t.id === 'grok')?.signIn, {
    how: 'browser',
    installing: false,
    signedIn: false
  });
  assert.deepEqual(tools.find((t) => t.id === 'codex')?.signIn, {
    how: 'browser',
    installing: false,
    signedIn: true
  });
  // The office's own Claude Code folder, which nobody signed in under test.
  assert.deepEqual(tools.find((t) => t.id === 'claude')?.signIn, {
    how: 'browser',
    installing: false,
    signedIn: false
  });
  grokSignedInAs('owner@example.com');
  try {
    assert.deepEqual(await stateOf('grok'), {
      how: 'browser',
      installing: false,
      signedIn: true,
      account: 'owner@example.com'
    });
  } finally {
    rmSync(join(GROK_HOME, 'auth.json'), { force: true });
  }
  // Linux offers Claude Code, Grok and Codex, so their sign-ins show there.
  const linux = await listed('linux');
  assert.deepEqual(
    linux.filter((t) => t.signIn).map((t) => t.id),
    ['claude', 'grok', 'codex']
  );
});

test("signing in to Grok from the page runs its browser sign-in in the office's Grok home, hands the page its sign-in address, and the list says signed in once it finishes", async () => {
  try {
    const s = await signIn('grok');
    const url = await s.url();
    assert.match(url, /^https:\/\/auth\.x\.ai\//);
    assert.deepEqual(await stateOf('grok'), {
      how: 'browser',
      installing: false,
      signedIn: false,
      waiting: { url }
    });
    assert.deepEqual(lastLogin(GROK_HOME), {
      args: ['login', '--oauth', '--leader-socket', join(GROK_HOME, 'leader.sock')],
      home: GROK_HOME
    });
    writeFileSync(join(GROK_HOME, 'login.go'), '');
    assert.deepEqual((await s.ended).at(-1), { done: true, ok: true });
    assert.deepEqual(await stateOf('grok'), {
      how: 'browser',
      installing: false,
      signedIn: true,
      account: 'owner@example.com'
    });
  } finally {
    rmSync(join(GROK_HOME, 'auth.json'), { force: true });
  }
});

test("signing in to Codex keeps the sign-in as a file in the office's Codex home and shows the account from it", async () => {
  rmSync(join(CODEX_HOME, 'auth.json'));
  // The sign-in writes the home's config first, or Codex would keep its sign-in in the keychain.
  rmSync(join(CODEX_HOME, 'config.toml'), { force: true });
  try {
    const s = await signIn('codex');
    const url = await s.url();
    // Its own callback server on http://localhost comes first, and is not the page.
    assert.match(url, /^https:\/\/auth\.openai\.com\//);
    const login = lastLogin(CODEX_HOME);
    assert.equal(login.home, CODEX_HOME);
    assert.ok(login.configFirst, 'the sign-in started before the home had its config.toml');
    const store = login.args.indexOf('cli_auth_credentials_store="file"');
    assert.ok(store > 0 && login.args[store - 1] === '-c', login.args.join(' '));
    writeFileSync(join(CODEX_HOME, 'login.go'), '');
    assert.deepEqual((await s.ended).at(-1), { done: true, ok: true });
    assert.deepEqual(await stateOf('codex'), {
      how: 'browser',
      installing: false,
      signedIn: true,
      account: 'owner@example.com'
    });
  } finally {
    codexAsBefore();
  }
});

test('a second sign-in starts the first over, and Cancel stops a waiting one and its command', async () => {
  const first = await signIn('grok');
  await first.url();
  const firstPid = loginPid(GROK_HOME);
  const second = await signIn('grok');
  assert.deepEqual(await first.end(), [{ line: 'Started over.' }, { done: true, ok: false }]);
  await second.url();
  const secondPid = loginPid(GROK_HOME);
  assert.notEqual(secondPid, firstPid);
  assert.deepEqual(await (await send('DELETE', 'grok')).json(), { stopped: true });
  assert.deepEqual(await second.end(), [{ line: 'Cancelled.' }, { done: true, ok: false }]);
  for (const pid of [firstPid, secondPid])
    await waitFor(() => gone(pid) || undefined, `sign-in ${pid} to stop`);
  assert.deepEqual(await (await send('DELETE', 'grok')).json(), { stopped: false });
  assert.equal((await stateOf('grok'))?.waiting, undefined);
});

test("signing out removes only the office home's sign-in and never runs a tool's own logout", async () => {
  grokSignedInAs('owner@example.com');
  try {
    for (const [tool, home] of [
      ['grok', GROK_HOME],
      ['codex', CODEX_HOME]
    ] as const) {
      assert.ok(existsSync(join(home, 'auth.json')), `${tool} starts signed in`);
      const res = await onPlatform('darwin', () => send('POST', tool, { action: 'sign-out' }));
      assert.equal(((await res.json()) as { signedIn: boolean }).signedIn, false, tool);
      assert.equal((await stateOf(tool))?.signedIn, false, tool);
      assert.ok(!existsSync(join(home, 'auth.json')), `${tool}'s sign-in is still there`);
      assert.ok(!existsSync(join(home, 'logouts.log')), `${tool}'s own logout ran`);
    }
    // A sign-in still waiting stops first.
    const waiting = await signIn('grok');
    await waiting.url();
    await onPlatform('darwin', () => send('POST', 'grok', { action: 'sign-out' }));
    assert.deepEqual(await waiting.end(), [{ line: 'Signed out.' }, { done: true, ok: false }]);
    assert.ok(!existsSync(join(GROK_HOME, 'logouts.log')), "grok's own logout ran");
  } finally {
    rmSync(join(GROK_HOME, 'auth.json'), { force: true });
    codexAsBefore();
  }
});

test('Gemini stays off the list and its sign-in until its list names this system, then shows with no other change', async () => {
  assert.ok(!L.AGENT_PLATFORMS.gemini.runs.includes('darwin'));
  assert.equal(
    (await listed()).find((t) => t.id === 'gemini'),
    undefined
  );
  await assert.rejects(
    onPlatform('darwin', () => send('POST', 'gemini', { action: 'sign-out' })),
    refused(404)
  );
  await assert.rejects(
    onPlatform('darwin', () => send('PUT', 'gemini', { key: OFFICE_GEMINI_KEY })),
    refused(404)
  );
  const before = L.AGENT_PLATFORMS.gemini.runs;
  L.AGENT_PLATFORMS.gemini.runs = ['darwin'];
  try {
    assert.deepEqual(await stateOf('gemini'), {
      how: 'key',
      installing: false,
      signedIn: true
    });
  } finally {
    L.AGENT_PLATFORMS.gemini.runs = before;
  }
});

test('a Gemini key from the page is tried once with Google, then kept in the keychain for the next run; a key that fails is not kept', async () => {
  const GOOD = 'good-gemini-key-for-tests-0001';
  const asked: { url: string; key: string | null }[] = [];
  let down = false;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), key: new Headers(init?.headers).get('x-goog-api-key') });
    if (down) throw new TypeError('fetch failed');
    return new Response('{}', {
      status: [GOOD, OFFICE_GEMINI_KEY].includes(asked.at(-1)?.key ?? '') ? 200 : 403
    });
  };
  const before = L.AGENT_PLATFORMS.gemini.runs;
  L.AGENT_PLATFORMS.gemini.runs = ['darwin'];
  const put = (key: string) => onPlatform('darwin', () => send('PUT', 'gemini', { key }));
  try {
    await assert.rejects(
      put('has a space'),
      refused(400, 'That does not look like a Gemini API key.')
    );
    assert.equal(asked.length, 0, 'a key of the wrong shape went to Google');
    await assert.rejects(
      put('bad-gemini-key-for-tests-0001'),
      refused(400, 'That key did not work. Check it in Google AI Studio.')
    );
    assert.equal(secrets.get('gemini:API_KEY'), OFFICE_GEMINI_KEY);
    down = true;
    await assert.rejects(
      put(GOOD),
      refused(
        400,
        'The office could not reach Google to try the key. Check the connection, then try again.'
      )
    );
    assert.equal(secrets.get('gemini:API_KEY'), OFFICE_GEMINI_KEY);
    down = false;
    const kept = await put(` ${GOOD}\n`);
    assert.equal(((await kept.json()) as { signedIn: boolean }).signedIn, true);
    assert.equal(secrets.get('gemini:API_KEY'), GOOD);
    assert.ok(asked.at(-1)?.url.startsWith('https://generativelanguage.googleapis.com/'));
    assert.equal(asked.at(-1)?.key, GOOD);
    await onPlatform('darwin', () => send('POST', 'gemini', { action: 'sign-out' }));
    assert.ok(!secrets.has('gemini:API_KEY'), "Gemini's key is still in the keychain");
    assert.equal((await stateOf('gemini'))?.signedIn, false);
    assert.equal(
      geminiKeyMissing(),
      "Gemini has no API key in this office. Add one on this Odd's Settings tab, under Model."
    );
    await assert.rejects(
      onPlatform('darwin', () => send('POST', 'gemini', { action: 'sign-in' })),
      refused(400, 'Gemini takes an API key.')
    );
  } finally {
    await setGeminiKey(OFFICE_GEMINI_KEY);
    globalThis.fetch = fetch;
    L.AGENT_PLATFORMS.gemini.runs = before;
  }
});

test("the keychain is read once however many times Gemini's state is asked, with a key or without", async () => {
  const before = L.AGENT_PLATFORMS.gemini.runs;
  L.AGENT_PLATFORMS.gemini.runs = ['darwin'];
  const reads = () => secretReads.filter((n) => n === 'gemini:API_KEY').length;
  /** Reads of the key across three loads of the list and one run's check, from cold. */
  const readsFromCold = async (signedIn: boolean) => {
    const from = reads();
    for (let i = 0; i < 3; i++) assert.equal((await stateOf('gemini'))?.signedIn, signedIn);
    assert.equal(geminiKeyMissing() === undefined, signedIn);
    return reads() - from;
  };
  try {
    // Cold, as after a restart: Sign out asks the keychain again next time.
    clearGeminiKey();
    assert.equal(await readsFromCold(false), 1);
    clearGeminiKey();
    secrets.set('gemini:API_KEY', OFFICE_GEMINI_KEY);
    assert.equal(await readsFromCold(true), 1);
  } finally {
    L.AGENT_PLATFORMS.gemini.runs = before;
    secrets.set('gemini:API_KEY', OFFICE_GEMINI_KEY);
  }
});

test("Claude Code's sign-in from Setup still streams through the same runner, says it is waiting, and can be cancelled", async () => {
  const s = follow(
    await claudeRoute.POST({
      request: new Request('http://office/api/setup/claude', {
        method: 'POST',
        body: JSON.stringify({ action: 'sign-in' })
      })
    } as unknown as Parameters<typeof claudeRoute.POST>[0])
  );
  assert.match(await s.url(), /^https:\/\/claude\.ai\//);
  const settings = await claudeRoute.GET({} as Parameters<typeof claudeRoute.GET>[0]);
  assert.equal(((await settings.json()) as { signingIn: boolean }).signingIn, true);
  const stopped = await claudeRoute.DELETE({} as Parameters<typeof claudeRoute.DELETE>[0]);
  assert.deepEqual(await stopped.json(), { stopped: true });
  assert.deepEqual(await s.end(), [{ line: 'Cancelled.' }, { done: true, ok: false }]);
});

test("every grok the office starts outside a run names the office's own leader socket, and a run names none", async () => {
  const leader = ['--leader-socket', join(GROK_HOME, 'leader.sock')];
  const s = await signIn('grok');
  await s.url();
  assert.deepEqual(lastLogin(GROK_HOME).args.slice(-2), leader);
  await send('DELETE', 'grok');
  await s.ended;
  // A sign-in that could run out within a chat's time is renewed first, outside the sandbox.
  const signedIn = (inMs: number) =>
    JSON.stringify({
      'https://auth.x.ai::test': { expires_at: new Date(Date.now() + inMs).toISOString() }
    });
  writeFileSync(join(GROK_HOME, 'auth.json'), signedIn(12 * 60_000));
  writeFileSync(join(GROK_HOME, 'renewed.json'), signedIn(6 * 60 * 60_000));
  try {
    const run = await chatOf('gus');
    assert.deepEqual(JSON.parse(readFileSync(join(GROK_HOME, 'models-args.json'), 'utf8')), [
      'models',
      ...leader
    ]);
    assert.ok(!run.args.includes('--leader-socket'), run.args.join(' '));
  } finally {
    for (const f of ['auth.json', 'renewed.json', 'models.log', 'models-args.json'])
      rmSync(join(GROK_HOME, f), { force: true });
  }
});

test('Your AI lists every tool once on a Mac, Linux and Windows: the ones this system offers to pick, the rest greyed with why', async () => {
  const ids = (l: Listing) => [...l.tools.map((t) => t.id), ...l.later.map((t) => t.id)].sort();
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const l = await listing(platform);
    assert.deepEqual(ids(l), [...L.AGENTS].sort(), platform);
    assert.equal(l.office, 'claude', platform);
  }
  const mac = await listing('darwin');
  assert.deepEqual(
    mac.tools.map((t) => t.id),
    ['claude', 'grok', 'codex']
  );
  assert.deepEqual(mac.later, [
    { id: 'gemini', name: 'Gemini', why: 'Coming soon. We are still testing it.' }
  ]);
  for (const platform of ['linux', 'win32'] as const) {
    const l = await listing(platform);
    assert.deepEqual(
      l.tools.map((t) => t.id),
      ['claude', 'grok', 'codex'],
      platform
    );
    assert.deepEqual(
      l.later.map((t) => [t.id, t.why]),
      [['gemini', 'Coming soon. We are still testing it.']],
      platform
    );
  }
  // A tool offered on a Mac alone is greyed elsewhere with why.
  const grokRuns = L.AGENT_PLATFORMS.grok.runs;
  L.AGENT_PLATFORMS.grok.runs = ['darwin'];
  try {
    const l = await listing('linux');
    assert.deepEqual(
      l.tools.map((t) => t.id),
      ['claude', 'codex']
    );
    assert.deepEqual(
      l.later.map((t) => [t.id, t.why]),
      [
        ['grok', 'Mac only for now.'],
        ['gemini', 'Coming soon. We are still testing it.']
      ]
    );
  } finally {
    L.AGENT_PLATFORMS.grok.runs = grokRuns;
  }
  // Gemini moves from greyed to offered once its list names this system, with no other change.
  const before = L.AGENT_PLATFORMS.gemini.runs;
  L.AGENT_PLATFORMS.gemini.runs = ['darwin'];
  try {
    const l = await listing('darwin');
    assert.deepEqual(
      l.tools.map((t) => t.id),
      ['claude', 'grok', 'codex', 'gemini']
    );
    assert.deepEqual(l.later, []);
  } finally {
    L.AGENT_PLATFORMS.gemini.runs = before;
  }
});

test('each listed tool says how it takes Run commands on that system, so the hire drawer names that switch only where the owner can move it', async () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const { tools } = await listing(platform);
    for (const t of tools)
      assert.deepEqual(t.commandsHow, L.commandsHow(t.id, platform), `${t.id} on ${platform}`);
  }
  const stateOn = async (id: string, platform: NodeJS.Platform) =>
    (await listed(platform)).find((t) => t.id === id)?.commandsHow.state;
  assert.equal(await stateOn('claude', 'darwin'), 'switch');
  assert.equal(await stateOn('claude', 'linux'), 'never');
  // Codex follows the switch on a Mac and Linux, and never on Windows.
  assert.equal(await stateOn('codex', 'darwin'), 'switch');
  assert.equal(await stateOn('codex', 'linux'), 'switch');
  assert.equal(await stateOn('codex', 'win32'), 'never');
});

test('the office runs on the tool picked at setup, only one this system offers, and a hire with no tool starts on it', async () => {
  const before = process.env.OFFICE_AGENT;
  const envFile = join(folder, 'none.env');
  const hadEnv = existsSync(envFile) ? readFileSync(envFile) : undefined;
  try {
    const picked = await pickOffice('grok');
    assert.deepEqual(await picked.json(), { office: 'grok' });
    assert.equal((await listing('darwin')).office, 'grok');
    assert.match(readFileSync(envFile, 'utf8'), /^OFFICE_AGENT=grok$/m);
    const hired = await L.hire({
      name: 'Ida',
      role: 'Tester',
      remit: 'Test work.',
      desk: 'You are Ida.',
      room: 'workspace',
      permission: 'draft',
      sprite: 'staff',
      variant: 'a',
      portrait: 'a'
    } as Parameters<typeof L.hire>[0]);
    assert.equal(hired.agent, 'grok');
    // Gemini is offered nowhere yet.
    for (const [office, platform] of [
      ['gemini', 'darwin'],
      ['gemini', 'linux'],
      ['gemini', 'win32'],
      ['nonsense', 'darwin']
    ] as const)
      await assert.rejects(pickOffice(office, platform), (e: { status?: number }) => {
        assert.equal(e.status, 400, `${office} on ${platform}`);
        return true;
      });
    assert.equal((await listing('linux')).office, 'grok');
    // An office moved to a system that does not offer its tool runs on Claude Code.
    const grokRuns = L.AGENT_PLATFORMS.grok.runs;
    L.AGENT_PLATFORMS.grok.runs = ['darwin'];
    try {
      assert.equal((await listing('linux')).office, 'claude');
    } finally {
      L.AGENT_PLATFORMS.grok.runs = grokRuns;
    }
  } finally {
    if (before === undefined) delete process.env.OFFICE_AGENT;
    else process.env.OFFICE_AGENT = before;
    if (hadEnv) writeFileSync(envFile, hadEnv);
    else rmSync(envFile, { force: true });
  }
});

test('each tool state offers exactly one action, and a signed-in tool still offers Sign in again', () => {
  const tool = (installed: boolean, signIn?: AgentTool['signIn']): AgentTool => ({
    id: 'grok',
    name: 'Grok',
    installed,
    commandsHow: L.commandsHow('grok', 'darwin'),
    ...(signIn ? { signIn } : {})
  });
  const browser = { how: 'browser', installing: false } as const;
  const key = { how: 'key', installing: false } as const;
  const cases: [string, AgentTool | undefined, ToolAction][] = [
    ['a tool this computer does not offer', undefined, 'none'],
    [
      'Claude Code, signed in on its own card',
      {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        commandsHow: L.commandsHow('claude', 'darwin')
      },
      'none'
    ],
    ['not installed', tool(false, { ...browser, signedIn: false }), 'install'],
    ['installing', tool(false, { ...browser, installing: true, signedIn: false }), 'installing'],
    [
      'installing once its command is there and a sign-in file reads as signed in',
      tool(true, { ...browser, installing: true, signedIn: true }),
      'installing'
    ],
    ['a key tool not installed', tool(false, { ...key, signedIn: false }), 'install'],
    ['signed out', tool(true, { ...browser, signedIn: false }), 'sign-in'],
    [
      'waiting on its page',
      tool(true, { ...browser, signedIn: false, waiting: { url: 'https://auth.x.ai/' } }),
      'cancel'
    ],
    [
      'waiting before its page shows',
      tool(true, { ...browser, signedIn: false, waiting: {} }),
      'cancel'
    ],
    [
      'signed in',
      tool(true, { ...browser, signedIn: true, account: 'owner@example.com' }),
      'sign-in-again'
    ],
    ['a key tool with no key', tool(true, { ...key, signedIn: false }), 'key'],
    ['a key tool with its key', tool(true, { ...key, signedIn: true }), 'key']
  ];
  for (const [state, t, action] of cases) assert.equal(toolAction(t), action, state);
});

test('Sign out shows only beside an installed tool signed in, and never while it installs', () => {
  const grok = (installed: boolean, installing: boolean): AgentTool => ({
    id: 'grok',
    name: 'Grok',
    installed,
    commandsHow: L.commandsHow('grok', 'darwin'),
    signIn: { how: 'browser', installing, signedIn: true }
  });
  assert.equal(offersSignOut(grok(true, false)), true);
  // The office under test's Codex home holds a sign-in file before Codex is there.
  assert.equal(offersSignOut(grok(false, false)), false);
  assert.equal(offersSignOut(grok(false, true)), false);
  assert.equal(offersSignOut(grok(true, true)), false);
});

test("Install runs each tool's own installer to its end, one at a time, with no Grok or xAI setting of the office's, and nothing else about that tool starts or stops while it runs", async () => {
  // Grok settings in the office's environment, which would send xAI's installer
  // elsewhere, and an xAI one, which no installer gets either.
  const officeSettings = ['GROK_BIN_DIR', 'GROK_DEPLOYMENT_KEY', 'XAI_API_KEY_FOR_TEST'];
  for (const k of officeSettings) process.env[k] = 'from-the-office';
  try {
    await withNoTools(async () => {
      const from = installed().length;
      const codex = await install('codex');
      await waitFor(() => installed()[from], 'the Codex installer');
      assert.deepEqual(installed()[from], ['npm', 'install', '-g', '@openai/codex']);
      const t = await toolIn('codex');
      assert.equal(t?.signIn?.installing, true);
      assert.equal(toolAction(t), 'installing');
      for (const [method, body] of [
        ['POST', { action: 'install' }],
        ['POST', { action: 'sign-in' }],
        ['POST', { action: 'sign-out' }],
        ['DELETE', undefined]
      ] as const)
        await assert.rejects(
          onPlatform('darwin', () => send(method, 'codex', body)),
          refused(409, 'Codex is still installing.'),
          `${method} ${JSON.stringify(body)}`
        );
      assert.ok(
        existsSync(join(CODEX_HOME, 'auth.json')),
        'a refused Sign out removed the sign-in'
      );
      // Another tool's install is its own: Grok's runs xAI's script as its usage line says.
      const grok = await install('grok');
      await waitFor(() => installed()[from + 1], 'the Grok installer');
      assert.deepEqual(installed()[from + 1], [
        'bash',
        '-c',
        'curl -fsSL https://x.ai/cli/install.sh | bash'
      ]);
      writeFileSync(join(folder, 'npm.go'), '');
      assert.deepEqual(await codex.end(), [{ line: 'Installing.' }, { done: true, ok: true }]);
      assert.equal((await toolIn('codex'))?.signIn?.installing, false);
      assert.equal((await toolIn('grok'))?.signIn?.installing, true);
      writeFileSync(join(folder, 'bash.go'), '');
      assert.deepEqual((await grok.ended).at(-1), { done: true, ok: true });
      assert.equal((await toolIn('grok'))?.signIn?.installing, false);
    });
  } finally {
    for (const k of officeSettings) delete process.env[k];
  }
  // Neither installer got them, while each got the office's PATH.
  for (const run of installRuns().slice(-2)) {
    assert.ok(run.env.includes('PATH'), run.args.join(' '));
    for (const k of officeSettings) assert.ok(!run.env.includes(k), `${run.args[0]} got ${k}`);
  }
});

test("an install that fails says the installer's last line and leaves the tool on Install", async () => {
  writeFileSync(join(folder, 'npm.fail'), '');
  try {
    await withNoTools(async () => {
      const codex = await install('codex');
      assert.deepEqual(await codex.end(), [
        { line: 'npm error: could not install' },
        { done: true, ok: false }
      ]);
      const t = await toolIn('codex');
      assert.equal(t?.installed, false);
      assert.equal(toolAction(t), 'install');
    });
  } finally {
    rmSync(join(folder, 'npm.fail'));
  }
});

test('Install with no npm on PATH says to install Node.js, never a spawn error, and runs nothing', async () => {
  const path = process.env.PATH;
  // Node alone, the way the app runs on a Mac whose npm comes from nvm set up in ~/.zshrc.
  process.env.PATH = nodeBin;
  try {
    assert.equal(onPath('npm'), undefined);
    const from = installed().length;
    await awayFromHome(async () => {
      await assert.rejects(
        onPlatform('darwin', () => send('POST', 'codex', { action: 'install' })),
        refused(
          400,
          'Codex installs with npm, which comes with Node.js, and the office cannot find npm on this Mac. Install Node.js from nodejs.org, then quit and reopen Oddboro.'
        )
      );
      const t = await toolIn('codex');
      assert.equal(t?.signIn?.installing, false);
      assert.equal(toolAction(t), 'install');
      // Claude Code's install in Setup takes npm too, off Windows.
      await assert.rejects(
        onPlatform('linux', () =>
          claudeRoute.POST({
            request: new Request('http://office/api/setup/claude', {
              method: 'POST',
              body: JSON.stringify({ action: 'install' })
            })
          } as unknown as Parameters<typeof claudeRoute.POST>[0])
        ),
        refused(
          400,
          'Claude Code installs with npm, which comes with Node.js, and the office cannot find npm on this computer. Install Node.js from nodejs.org, then quit and reopen Oddboro.'
        )
      );
    });
    assert.equal(installed().length, from, 'an installer ran');
  } finally {
    process.env.PATH = path;
  }
});

test("a Grok installed from the page only into xAI's install folder is offered, signs in, renews and runs without restarting the office", async () => {
  await withNoTools(async (home) => {
    assert.equal((await toolIn('grok'))?.installed, false);
    const grok = await install('grok');
    // xAI's installer links grok in before it ends: still Installing, with nothing to press.
    const own = join(home, '.grok', 'bin', 'grok');
    mkdirSync(dirname(own), { recursive: true });
    copyFileSync(join(bin, 'grok'), own);
    chmodSync(own, 0o755);
    const during = await toolIn('grok');
    assert.equal(during?.installed, true);
    assert.equal(toolAction(during), 'installing');
    writeFileSync(join(folder, 'bash.go'), '');
    assert.deepEqual((await grok.ended).at(-1), { done: true, ok: true });
    assert.equal(toolAction(await toolIn('grok')), 'sign-in');
    // The sign-in starts the grok in that folder, since none is on PATH.
    const s = await signIn('grok');
    await s.url();
    assert.equal(lastLogin(GROK_HOME).home, GROK_HOME);
    await send('DELETE', 'grok');
    await s.ended;
    // So do the renewal before a run and the run itself.
    const signedIn = (inMs: number) =>
      JSON.stringify({
        'https://auth.x.ai::test': { expires_at: new Date(Date.now() + inMs).toISOString() }
      });
    writeFileSync(join(GROK_HOME, 'auth.json'), signedIn(12 * 60_000));
    writeFileSync(join(GROK_HOME, 'renewed.json'), signedIn(6 * 60 * 60_000));
    try {
      const run = await chatOf('gus');
      assert.ok(existsSync(join(GROK_HOME, 'models-args.json')), 'the renewal did not run');
      assert.ok(run.args.includes('--prompt-file'), run.args.join(' '));
    } finally {
      for (const f of ['auth.json', 'renewed.json', 'models.log', 'models-args.json'])
        rmSync(join(GROK_HOME, f), { force: true });
    }
  });
});

test("a file in xAI's install folder that cannot run is not an installed Grok", async () => {
  await withNoTools(async (home) => {
    const own = join(home, '.grok', 'bin', 'grok');
    mkdirSync(dirname(own), { recursive: true });
    copyFileSync(join(bin, 'grok'), own);
    chmodSync(own, 0o644);
    const t = await toolIn('grok');
    assert.equal(t?.installed, false);
    assert.equal(toolAction(t), 'install');
  });
});

test('a sign-in for a tool the office cannot find says to install it, never a spawn error', async () => {
  await withNoTools(async () => {
    await assert.rejects(
      onPlatform('darwin', () => send('POST', 'grok', { action: 'sign-in' })),
      refused(400, 'Grok is not on this Mac. Install it first.')
    );
    assert.equal((await toolIn('grok'))?.signIn?.waiting, undefined, 'a sign-in started');
  });
});

test('Gemini cannot be installed while its list does not name this system', async () => {
  assert.ok(!L.AGENT_PLATFORMS.gemini.runs.includes('darwin'));
  const from = installed().length;
  await assert.rejects(
    onPlatform('darwin', () => send('POST', 'gemini', { action: 'install' })),
    refused(404)
  );
  assert.equal(installed().length, from, 'an installer ran');
});

test('no test reached the keychain', () => {
  assertKeychainUntouched();
});

test("an office run on Codex or Grok goes through the tool's own sandboxed launch with no MCP, no shell and no file tool, sends its pictures, and leaves nothing behind", async () => {
  const { runAsOffice } = await import('./office-run.ts');
  const picture = { mediaType: 'image/png', data: Buffer.from('a picture').toString('base64') };
  const ask = () =>
    runAsOffice('Draw a desk for {owner}.', {
      system: 'You draw for {owner}.',
      kind: 'look',
      timeoutMs: 60_000,
      effort: 'low',
      images: [picture]
    });
  const gaveOf = (text: string) =>
    JSON.parse(text.slice(0, text.lastIndexOf('\nOutcome:'))) as Record<string, unknown>;
  const runs = join(folder, 'office', 'runs');

  const codex = await withEnv({ OFFICE_AGENT: 'codex' }, ask);
  assert.ok(codex.ok, codex.text);
  const c = gaveOf(codex.text) as {
    args: string[];
    pictures: boolean[];
    servers: object;
    permissions: { network: { enabled: boolean } };
    message: string;
    system: string;
  };
  assert.deepEqual(c.pictures, [true]);
  assert.ok(c.args.includes('model_reasoning_effort="low"'), c.args.join(' '));
  assert.deepEqual(c.servers, {});
  // No shell: the pictures come with the message, and there is nothing else to read.
  assert.ok(c.args.includes('features.shell_tool=false'), c.args.join(' '));
  assert.ok(c.args.includes('features.unified_exec=false'), c.args.join(' '));
  assert.equal(c.permissions.network.enabled, false);
  assert.ok(!c.message.includes('{owner}') && c.message.startsWith('Draw a desk for '));
  assert.ok(!c.system.includes('{owner}'));
  assert.deepEqual(readdirSync(runs), []);

  const signedIn = { expires_at: new Date(Date.now() + 86_400_000).toISOString() };
  writeFileSync(
    join(GROK_HOME, 'auth.json'),
    JSON.stringify({ 'https://auth.x.ai::test': signedIn })
  );
  try {
    const grok = await withEnv({ OFFICE_AGENT: 'grok' }, ask);
    assert.ok(grok.ok, grok.text);
    const g = gaveOf(grok.text) as {
      args: string[];
      prompt: { type: string; data?: string; mimeType?: string; text?: string }[];
      env?: unknown;
    };
    // With a picture, the message goes as content blocks, in a .json file and never on the command line.
    const file = g.args[g.args.indexOf('--prompt-file') + 1];
    assert.ok(file.endsWith('.prompt.json'), file);
    assert.ok(
      !g.args.some((a) => a.includes(picture.data)),
      'the picture went on the command line'
    );
    // No file tool, never Grok's whole set, so it answers from the message, at the effort asked.
    // Grok has no "no tools", so todo_write, which touches no file, stands in.
    assert.equal(g.args[g.args.indexOf('--tools') + 1], 'todo_write');
    assert.ok(g.args.includes('--reasoning-effort=low'), g.args.join(' '));
    assert.deepEqual(g.prompt[0], { type: 'image', data: picture.data, mimeType: 'image/png' });
    assert.match(String(g.prompt[1].text), /^Draw a desk for /);
    assert.equal(g.env, undefined);
    assert.deepEqual(readdirSync(runs), []);
  } finally {
    rmSync(join(GROK_HOME, 'auth.json'), { force: true });
  }

  // A sign-in that ran out and cannot renew refuses the run, pointing to setup, not to an Odd's Settings tab.
  const ended = { expires_at: new Date(Date.now() - 60_000).toISOString() };
  writeFileSync(join(GROK_HOME, 'auth.json'), JSON.stringify({ 'https://auth.x.ai::test': ended }));
  try {
    const refused = await withEnv({ OFFICE_AGENT: 'grok' }, ask);
    assert.equal(refused.ok, false);
    assert.match(refused.text, /in Setup, under Your AI/);
    assert.deepEqual(readdirSync(runs), []);
  } finally {
    for (const f of ['auth.json', 'models.log', 'models-args.json'])
      rmSync(join(GROK_HOME, f), { force: true });
  }
});

test('versions compare by their numbers, so 1.0.9 is older than 1.0.62 and 2.1.318 is not older than itself', () => {
  assert.equal(L.olderThan('0.149.1', '0.166.0'), true);
  assert.equal(L.olderThan('1.0.9', '1.0.62'), true);
  assert.equal(L.olderThan('2.1.99', '2.1.318'), true);
  assert.equal(L.olderThan('2.1.318', '2.1.318'), false);
  assert.equal(L.olderThan('1.0.70', '1.0.62'), false);
  assert.equal(L.olderThan('1.0', '1.0.0'), false);
});

test('a tool older than the office runs shows Update, its runs are refused saying where to update, and Update runs its updater', async () => {
  const versions = join(folder, 'versions');
  mkdirSync(versions, { recursive: true });
  // The office reads a version again only when the tool's file changes, as an update changes it.
  const touch = () =>
    utimesSync(join(bin, 'codex'), new Date(), new Date(Date.now() + 1000 * Math.random()));
  writeFileSync(join(versions, 'codex'), '0.149.1');
  touch();
  try {
    const codex = await toolIn('codex');
    assert.equal(codex?.version, '0.149.1');
    assert.equal(codex?.tooOld, L.MIN_VERSIONS.codex);
    assert.equal(toolAction(codex), 'update');

    const { runAsOffice } = await import('./office-run.ts');
    const run = await withEnv({ OFFICE_AGENT: 'codex' }, () =>
      runAsOffice('Hello.', { system: 'Say hello.', kind: 'look', timeoutMs: 60_000 })
    );
    assert.deepEqual(run, {
      ok: false,
      text: 'Codex 0.149.1 is older than this office runs (0.166.0 or newer). Update it in Setup, under Your AI.'
    });

    const from = installed().length;
    const update = await onPlatform('darwin', async () =>
      follow(await send('POST', 'codex', { action: 'update' }))
    );
    await waitFor(() => installed()[from], 'the Codex update');
    assert.deepEqual(installed()[from], ['npm', 'install', '-g', '@openai/codex@latest']);
    // The stand-in npm ends once told to.
    writeFileSync(join(folder, 'npm.go'), '');
    await update.end();
  } finally {
    rmSync(versions, { recursive: true, force: true });
    touch();
  }
  // At the oldest the office runs, nothing to update.
  const after = await toolIn('codex');
  assert.equal(after?.version, '0.166.0');
  assert.equal(after?.tooOld, undefined);
  assert.notEqual(toolAction(after), 'update');
});

test("the staff tool server offers its tools though it may not read .env, as inside Grok's sandbox, and a Grok run hands it the office's settings", async () => {
  // Grok's sandbox shows .env to the server but refuses to open it; a file it may not read stands in.
  const locked = join(folder, 'locked.env');
  writeFileSync(locked, 'OFFICE_TIME_ZONE=Europe/Paris\n');
  chmodSync(locked, 0o000);
  try {
    const { spawn } = await import('node:child_process');
    const server = spawn(process.execPath, [L.STAFF_SERVER], {
      env: { ...process.env, ODDBORO_ENV: locked, STAFF_ID: 'gus' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    server.stderr.on('data', (d) => (err += d));
    const tools = new Promise<string[]>((done, fail) => {
      server.stdout.on('data', (d) => {
        out += d;
        for (let i = out.indexOf('\n'); i >= 0; i = out.indexOf('\n')) {
          const m = JSON.parse(out.slice(0, i)) as {
            id?: number;
            result?: { tools: { name: string }[] };
          };
          out = out.slice(i + 1);
          if (m.id === 2) done(m.result?.tools.map((t) => t.name) ?? []);
        }
      });
      server.on('close', (code) => fail(new Error(`The server stopped (exit ${code}): ${err}`)));
    });
    const send = (m: object) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      }
    });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    try {
      assert.ok((await tools).includes('search_ledger'));
    } finally {
      server.kill();
    }
  } finally {
    chmodSync(locked, 0o600);
    rmSync(locked, { force: true });
  }
  // A Grok run's agent file sets the office's settings on the server itself.
  const gave = await withEnv({ OFFICE_TIME_ZONE: 'Europe/Paris' }, () => chatOf('gus'));
  assert.equal(gave.env.OFFICE_TIME_ZONE, 'Europe/Paris');
});

test('only Claude Code on Opus or Codex on Sol or Astra draws a look; on any other a hire builds one from parts, with a portrait from the same parts, that the hire takes', async () => {
  const { drawsLooks } = await import('@oddboro/ledger/agents');
  for (const [agent, model, draws] of [
    ['claude', undefined, true],
    ['claude', 'opus', true],
    ['claude', 'claude-fable-5-2', true],
    ['claude', 'claude-fable-5-1', true],
    ['claude', 'sonnet', false],
    ['codex', undefined, true],
    ['codex', 'gpt-6.1-sol', true],
    ['codex', 'gpt-6-astra', true],
    ['codex', 'gpt-6-luna', false],
    ['grok', undefined, false],
    ['gemini', undefined, false]
  ] as const)
    assert.equal(drawsLooks(agent, model), draws, `${agent} on ${model}`);

  const looks = await import('../../routes/api/looks/+server.ts');
  const parts = await import('../../routes/api/looks/parts/+server.ts');
  const list = await import('../../routes/api/me/parts/+server.ts');
  const post = <R extends { POST: (e: never) => unknown }>(r: R, body: unknown) =>
    r.POST({
      request: new Request('http://office/api', { method: 'POST', body: JSON.stringify(body) })
    } as never) as Promise<Response>;

  await withEnv({ OFFICE_AGENT: 'grok' }, async () => {
    assert.equal(((await listing()) as Listing & { drawsLooks: boolean }).drawsLooks, false);
    await assert.rejects(post(looks, { description: 'Red hair', name: 'Ida' }), (e: object) => {
      assert.match(String((e as { body?: { message?: string } }).body?.message), /from parts/);
      return true;
    });
    const p = (await (await list.GET({} as never)).json()) as {
      hair: string[];
      top: string[];
      bottom: string[];
      colours: Record<string, { name: string }[]>;
    };
    const look = {
      hair: p.hair[0],
      top: p.top[0],
      bottom: p.bottom[0],
      colours: {
        hair: p.colours.hair[0].name,
        skin: p.colours.skin[0].name,
        top: p.colours.cloth[0].name,
        bottom: p.colours.cloth[1].name,
        shoes: p.colours.shoes[0].name
      }
    };
    const built = (await (await post(parts, { look })).json()) as {
      look: object;
      portraitPx: string;
      newParts: unknown[];
      portrait: string;
      sheet: string;
      problems: string[];
    };
    assert.deepEqual(built.problems, []);
    assert.deepEqual(built.newParts, []);
    // A face shape is a part like the rest, and a look may leave it out.
    assert.deepEqual((p as unknown as { face: string[] }).face.sort(), ['soft', 'strong']);
    for (const face of ['soft', 'strong']) {
      const f = (await (await post(parts, { look: { ...look, face } })).json()) as {
        problems: string[];
      };
      assert.deepEqual(f.problems, [], face);
    }
    await assert.rejects(post(parts, { look: { ...look, face: 'no-such-face' } }), (e: object) => {
      assert.equal((e as { status?: number }).status, 400);
      return true;
    });
    assert.match(built.portrait, /^data:image\/png;base64,/);
    assert.match(built.sheet, /^data:image\/png;base64,/);
    // The hire's own check takes it as it takes a drawn look.
    const { drawnFrom, problemsWith } = await import('./looks.ts');
    assert.deepEqual(await problemsWith(drawnFrom(built)!), []);
    await assert.rejects(post(parts, { look: { ...look, hair: 'no-such-hair' } }), (e: object) => {
      assert.equal((e as { status?: number }).status, 400);
      return true;
    });
  });
  await withEnv({ OFFICE_AGENT: 'codex' }, async () =>
    assert.equal(((await listing()) as Listing & { drawsLooks: boolean }).drawsLooks, true)
  );
});

test('an office run stops when its signal does, as a drawing left for parts', async () => {
  const { runAsOffice } = await import('./office-run.ts');
  const runs = join(folder, 'office', 'runs');
  const stopped = new AbortController();
  stopped.abort();
  const run = await withEnv({ OFFICE_AGENT: 'codex' }, () =>
    runAsOffice('Draw a desk.', {
      system: 'You draw.',
      kind: 'look',
      timeoutMs: 60_000,
      signal: stopped.signal
    })
  );
  assert.deepEqual(run, { ok: false, text: 'Stopped.' });
  assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], []);
});

test('an office run on a tool that is not installed says so, not that it is not signed in', async () => {
  const { runAsOffice } = await import('./office-run.ts');
  const path = process.env.PATH;
  process.env.PATH = nodeBin;
  try {
    const run = await withEnv({ OFFICE_AGENT: 'codex' }, () =>
      runAsOffice('Draw a desk.', { system: 'You draw.', kind: 'office', timeoutMs: 60_000 })
    );
    assert.deepEqual(run, {
      ok: false,
      text: 'Codex is not installed. Install it in Setup, under Your AI.'
    });
  } finally {
    process.env.PATH = path;
  }
});
