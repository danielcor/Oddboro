// The launch contract: every AI tool, on every system it runs on, started as
// the office starts it, from an office whose own environment holds things no
// run should get. What arrives is read from what the tool's stand-in recorded
// (office-under-test.ts). A new tool fails the type check here until it has
// an Odd and a reader of its walls. Run with `npm test -w @oddboro/office`.
import {
  chatOf,
  filesOf,
  folder,
  L,
  odd,
  OFFICE_PROCESS_GIT,
  onPlatform,
  ownerHome,
  setOwn,
  withEnv,
  type Gave
} from './office-under-test.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Agent } from '@oddboro/ledger';

const { RUN_ENV_ALLOW, TOOL_SERVER_ENV, outsideToolEnv, toolServerEnv } =
  await import('./run-env-allow.ts');

/** The Odd on each tool. */
const ODDS: Record<Agent, string> = {
  claude: 'clio',
  grok: 'gale',
  codex: 'cora',
  gemini: 'gemma'
};
await L.pg`insert into staff ${L.pg(L.AGENTS.map((agent) => ({ ...odd(ODDS[agent], ODDS[agent]), agent })))}`;

/**
 * Variables the office may hold that no run gets: its own git settings, an
 * SSH agent, tokens and keys by name and by look, and two of the office's
 * own. The test office already holds DATABASE_URL, NODE_OPTIONS and each
 * tool's own keys and homes from a parent.
 */
const HOSTILE = {
  ...OFFICE_PROCESS_GIT,
  SSH_AUTH_SOCK: '/nonexistent/agent.sock',
  SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22',
  SOME_SERVICE_TOKEN: 'not-a-token',
  AWS_SECRET_ACCESS_KEY: 'not-a-key',
  CARGO_REGISTRY_TOKEN: 'not-a-token',
  ODDBORO_UNRELATED: '1',
  ODDBORO_UPDATE_TOKEN: 'not-a-token'
};
/** Where an owner behind a proxy that inspects traffic keeps its certificate, for each kind of tool. */
const CERTIFICATES = {
  NODE_EXTRA_CA_CERTS: '/nonexistent/proxy.pem',
  SSL_CERT_FILE: '/nonexistent/proxy.pem',
  SSL_CERT_DIR: '/nonexistent/certs',
  REQUESTS_CA_BUNDLE: '/nonexistent/proxy.pem',
  CURL_CA_BUNDLE: '/nonexistent/proxy.pem'
};
/** An owner behind a proxy that inspects traffic. */
const PROXIED = {
  HTTPS_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  NO_PROXY: 'localhost',
  ...CERTIFICATES
};
/** A setting of the office's own, which only the tool server gets. */
const SERVER_ONLY = { OFFICE_TIME_ZONE: 'Europe/Paris' };
/**
 * PATH and each name a run on Windows needs, written out here so a name the
 * list loses fails, and each in a case the list does not use, since Windows
 * ignores case and an office there may hold `Path`. Each keeps the office's
 * own value where it has one: on a Windows host the new spelling is the same
 * variable, and a run may not start without it. Node gives a launch on
 * Windows one spelling of each name, so on a Mac or Linux host `Path` merges
 * with the office's own `PATH`, and the other names are the ones that test
 * the case.
 */
const WINDOWS_SPELT: Record<string, string> = Object.fromEntries(
  [
    'Path',
    'SYSTEMROOT',
    'SystemDrive',
    'WINDIR',
    'UserProfile',
    'HomeDrive',
    'HomePath',
    'AppData',
    'LocalAppData',
    'PathExt',
    'COMSPEC',
    'Temp',
    'Tmp',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'UserName',
    'Processor_Architecture'
  ].map((n) => [n, process.env[n] ?? `C:\\${n}`])
);

/**
 * Two names every run gets from `runEnv` itself, whatever its tool, and one a
 * stand-in's node gives itself on a Mac however empty its environment
 * (`env -i` shows it), so it never came from the office.
 */
const EVERY_RUN = [
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  '__CF_USER_TEXT_ENCODING'
];
/** The names each tool's launch sets itself, after `runEnv`. */
const OWN: Record<Agent, readonly (string | RegExp)[]> = {
  claude: ['CLAUDE_CONFIG_DIR'],
  // Grok's launch sets a family of its own switches (`grokEnv`), and its temp folder.
  grok: [/^GROK_/, 'TMPDIR'],
  codex: ['CODEX_HOME', 'TMPDIR'],
  gemini: [
    'GEMINI_CLI_HOME',
    'GEMINI_CLI_TRUST_WORKSPACE',
    'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
    'GEMINI_SYSTEM_MD',
    'GEMINI_API_KEY'
  ]
};

/** Every value given after `flag`, which may come more than once. */
const each = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);
/** Where a tool has no kernel profile (Windows), the office's file server is its wall. */
const carriedReads = (g: Gave) => filesOf(g)?.walls.reads ?? [];

/** Each tool's walls, read from its own shape: the folders a run may read, and whether it reaches the network. */
const WALLS: Record<Agent, (gave: Gave) => { reads: string[]; network: boolean }> = {
  claude: (g) => {
    // Its rules and sandbox come in the file `--settings` names, as the stand-in
    // read it; the sandbox is `claudeSandbox`'s JSON, typed here only as far as it is read.
    assert.ok(g.claudeSettings, 'a Claude Code run passed no settings');
    const sandbox = g.claudeSettings.sandbox as
      { network?: { allowedDomains?: string[] } } | undefined;
    return {
      // Its Read allow rules, and the folders it works in besides its own.
      reads: [
        ...g.claudeSettings.permissions.allow
          .filter((a) => a.startsWith('Read(/'))
          .map((a) => a.slice('Read(/'.length, -'/**)'.length)),
        ...each(g.args, '--add-dir')
      ],
      network:
        each(g.args, '--tools')[0]
          .split(',')
          .some((t) => t.startsWith('Web')) || !!sandbox?.network?.allowedDomains?.length
    };
  },
  grok: (g) => ({
    reads: g.args.includes('--sandbox')
      ? [...(g.profile ?? '').matchAll(/^read_(?:only|write) = (\[.*\])$/gm)].flatMap(
          (m) => JSON.parse(m[1]) as string[]
        )
      : carriedReads(g),
    network: g.grokEnv?.GROK_WEB_FETCH !== '0'
  }),
  codex: (g) => ({
    reads: g.permissions
      ? Object.entries(g.permissions.filesystem)
          .filter(([, how]) => how === 'read' || how === 'write')
          .map(([path]) => path)
      : carriedReads(g),
    network: !!g.permissions?.network.enabled || g.args.includes('web_search="live"')
  }),
  gemini: (g) => ({
    reads: each(g.args, '--include-directories'),
    network: (g.policy ?? '').includes('google_web_search')
  })
};

/** Whether `name` is listed in `names`, as the office matches on `platform`. */
const listed = (name: string, names: readonly (string | RegExp)[], platform: NodeJS.Platform) =>
  names.some((n) =>
    typeof n === 'string'
      ? platform === 'win32'
        ? n.toLowerCase() === name.toLowerCase()
        : n === name
      : n.test(name)
  );

/**
 * One chat with each tool on each system it runs on, from the hostile office,
 * with a read folder, any `stored` folders besides, and web off.
 */
async function eachLaunch(
  check: (gave: Gave, agent: Agent, platform: NodeJS.Platform) => void,
  stored: string[] = []
): Promise<number> {
  const read = join(folder, 'contract-read');
  mkdirSync(read, { recursive: true });
  const folders = [read, ...stored].map((path) => ({ path, write: false }));
  let launches = 0;
  for (const agent of L.AGENTS) {
    await setOwn(ODDS[agent], { web: false, folders });
    for (const platform of L.AGENT_PLATFORMS[agent].runs) {
      const gave = await withEnv({ ...HOSTILE, ...PROXIED, ...SERVER_ONLY, ...WINDOWS_SPELT }, () =>
        onPlatform(platform, () => chatOf(ODDS[agent]))
      );
      check(gave, agent, platform);
      launches++;
    }
  }
  return launches;
}

test("every AI tool, on every system it runs on, launches with only the allowed environment, the read grant, web off and the tool server's variables by name", async () => {
  const launches = await eachLaunch((gave, agent, platform) => {
    const at = `${agent} on ${platform}`;
    const allowed = [
      ...RUN_ENV_ALLOW.all,
      ...(platform === 'darwin' || platform === 'linux' || platform === 'win32'
        ? RUN_ENV_ALLOW[platform]
        : []),
      ...RUN_ENV_ALLOW.tool[agent],
      ...EVERY_RUN,
      ...OWN[agent]
    ];
    const strays = gave.envNames.filter((n) => !listed(n, allowed, platform));
    assert.deepEqual(strays, [], `${at} got variables no list names`);
    for (const n of [...Object.keys(HOSTILE), ...Object.keys(SERVER_ONLY)])
      assert.ok(!gave.envNames.includes(n), `${at} got ${n}`);
    const walls = WALLS[agent](gave);
    assert.ok(walls.reads.includes(join(folder, 'contract-read')), `${at} lost its read folder`);
    assert.equal(walls.network, false, `${at} reached the network with web off`);
    for (const k of TOOL_SERVER_ENV)
      if (process.env[k] || k in SERVER_ONLY)
        assert.ok(k in gave.env, `${at}: the tool server's entry lacks ${k}`);
  });
  // Every tool on every system it runs on: a tool or system that stopped
  // launching would otherwise pass unseen.
  assert.equal(
    launches,
    L.AGENTS.reduce((n, a) => n + L.AGENT_PLATFORMS[a].runs.length, 0)
  );
  assert.ok(launches > 0, 'no tool runs anywhere: nothing was checked');
});

test("an owner's proxy and certificate settings reach every run", async () => {
  await eachLaunch((gave, agent, platform) => {
    // On Windows HTTPS_PROXY and https_proxy are one variable, and a launch
    // there keeps one spelling of it.
    for (const n of Object.keys(PROXIED))
      assert.ok(listed(n, gave.envNames, platform), `${agent} on ${platform} lost ${n}`);
  });
});

test("an owner's certificate settings reach the server of an outside tool the gateway starts", () =>
  withEnv(CERTIFICATES, () => {
    const env = outsideToolEnv();
    for (const [name, value] of Object.entries(CERTIFICATES)) assert.equal(env[name], value, name);
  }));

test("an owner's certificate settings reach the office's tool server by name, whatever its AI tool passes on", async () => {
  await eachLaunch((gave, agent, platform) => {
    for (const name of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const)
      assert.equal(gave.env[name], CERTIFICATES[name], `${agent} on ${platform} lost ${name}`);
  });
});

test('where the shell keeps the secrets the tool server is told the office has them, and otherwise it is told nothing', () =>
  withEnv({ ODDBORO_SECRETS: 'shell' }, () => {
    assert.equal(toolServerEnv().ODDBORO_SECRETS, 'office');
    for (const other of ['office', 'keychain']) {
      process.env.ODDBORO_SECRETS = other;
      assert.ok(!('ODDBORO_SECRETS' in toolServerEnv()), other);
    }
    delete process.env.ODDBORO_SECRETS;
    assert.ok(!('ODDBORO_SECRETS' in toolServerEnv()), 'unset');
  }));

test('on Windows, PATH and every name its list holds reach each run, whatever their case', async () => {
  let launches = 0;
  await eachLaunch((gave, agent, platform) => {
    if (platform !== 'win32') return;
    for (const n of Object.keys(WINDOWS_SPELT))
      assert.ok(listed(n, gave.envNames, platform), `${agent} on win32 lost ${n}`);
    launches++;
  });
  assert.ok(launches > 0, 'no tool runs on Windows: nothing was checked');
});

test("a secret store, or the office's accounts folder, stored as a folder never reaches any run, in any case the disk ignores", () =>
  ownerHome(async (home) => {
    for (const s of ['.ssh', '.docker']) mkdirSync(join(home, s));
    const accounts = L.accountsHome();
    mkdirSync(join(accounts, 'claude'), { recursive: true });
    // Stored straight to the table, as a folder given before a rule named
    // its store was, which the folder check no longer sees: each store, one
    // inside the accounts folder, and the office's home, which holds it.
    const stored = [
      ...['.ssh', '.SSH', '.docker'].map((s) => join(home, s)),
      accounts,
      join(accounts, 'claude'),
      folder
    ];
    const real = (p: string) => (existsSync(p) ? realpathSync.native(p) : p);
    const stores = ['.ssh', '.docker'].map((s) => real(join(home, s)));
    // A run reads its own account's folder (Grok's temp folder sits there),
    // so for the accounts folder only the stored folders themselves count.
    const grants = new Set(stored.map(real));
    const given: string[] = [];
    const launches = await eachLaunch((gave, agent, platform) => {
      const reads = WALLS[agent](gave).reads.map(real);
      assert.ok(
        reads.includes(real(join(folder, 'contract-read'))),
        `${agent} lost its read folder`
      );
      for (const r of new Set(reads))
        if (grants.has(r) || stores.some((s) => r === s || r.startsWith(s + '/')))
          given.push(`${agent} on ${platform}: ${r}`);
    }, stored);
    assert.deepEqual(given, [], 'a run was given a secret store');
    assert.ok(launches > 0, 'no tool runs anywhere: nothing was checked');
  }));

test("a Linux browser's or keyring's folder stored as a folder never reaches any run, nor does the ~/.local that holds the keyrings", () =>
  ownerHome(async (home) => {
    const keyrings = join(home, '.local', 'share', 'keyrings');
    mkdirSync(keyrings, { recursive: true });
    writeFileSync(join(keyrings, 'login.keyring'), '');
    const browsers = [
      join(home, 'snap', 'firefox'),
      join(home, '.var', 'app', 'org.mozilla.firefox')
    ];
    for (const b of browsers) mkdirSync(b, { recursive: true });
    const real = (p: string) => (existsSync(p) ? realpathSync.native(p) : p);
    const stores = [keyrings, ...browsers].map(real);
    // Stored straight to the table, as folders given before their stores were
    // listed: each store, and ~/.local, which holds the keyrings.
    const stored = [...stores, real(join(home, '.local'))];
    const given: string[] = [];
    const launches = await eachLaunch((gave, agent, platform) => {
      for (const r of new Set(WALLS[agent](gave).reads.map(real)))
        if (stores.some((s) => L.within(r, s) || L.within(s, r)))
          given.push(`${agent} on ${platform}: ${r}`);
    }, stored);
    assert.deepEqual(given, [], 'a run was given a Linux secret store');
    assert.ok(launches > 0, 'no tool runs anywhere: nothing was checked');
  }));
