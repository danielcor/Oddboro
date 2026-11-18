// What an install needs, checked one thing at a time: this computer, Claude Code,
// the database, ledger search and the optional helpers. `npm run setup` walks the owner
// through these, and the office's Setup window shows them again. Nothing here
// imports db.ts, so it runs before there is a database to connect to.
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import postgres from 'postgres';
import {
  LINUX,
  MAC,
  WINDOWS,
  claudeCommand,
  currentPlatform,
  currentSystem,
  probe,
  serviceInstalled
} from './platform.ts';
import { modelProblem, modelReady } from './embed.ts';
import { isDownloading, modelOnDisk, MODEL_MB, RUNS_HERE } from './search-model.ts';
import { secretStore } from './secrets.ts';
import { computerWord } from './system-words.ts';

export type Check = {
  id: string;
  name: string;
  /** ok: ready. missing: the office cannot run without it. optional: works without, with less. */
  state: 'ok' | 'missing' | 'optional';
  /** What was found, in a few words. */
  found: string;
  /** What to do about it, when it is not ok. */
  fix?: string;
  /** A download in MB that fixes it, which Setup offers as a button. */
  download?: number;
};

/** Whether a command ran cleanly, and all it printed. */
async function run(cmd: string, args: string[], timeout = 8000) {
  const r = await probe(cmd, args, { timeout });
  switch (r.status) {
    case 'ok':
      return { ok: true, out: `${r.out}${r.err}`.trim() };
    case 'failed':
      return { ok: false, out: `${r.out}${r.err}`.trim() };
    case 'missing':
    case 'timeout':
      return { ok: false, out: '' };
    default: {
      const missed: never = r;
      throw new Error(`${cmd} came back as ${JSON.stringify(missed)}`);
    }
  }
}

/**
 * The system the office runs on. It keeps its id "mac" because the setup card
 * and older installs look for that id.
 */
export async function checkMac(): Promise<Check> {
  if (MAC) {
    const v = await run('sw_vers', ['-productVersion']);
    return { id: 'mac', name: 'macOS', state: 'ok', found: `macOS ${v.out || 'found'}` };
  }
  if (LINUX) {
    let name = 'Linux';
    try {
      name = /^PRETTY_NAME="?([^"\n]+)/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? name;
    } catch {
      // No os-release: plain Linux is enough.
    }
    return { id: 'mac', name: 'Linux', state: 'ok', found: name };
  }
  if (WINDOWS)
    // Build 22000 and later is Windows 11.
    return {
      id: 'mac',
      name: 'Windows',
      state: 'ok',
      found: `Windows ${Number(release().split('.')[2]) >= 22000 ? '11' : '10'}`
    };
  return {
    id: 'mac',
    name: 'System',
    state: 'missing',
    found: `This is ${currentPlatform()}`,
    fix: 'Oddboro runs on a Mac, Linux or Windows.'
  };
}

/**
 * The secret store that holds the keys and sign-ins the owner connects: the
 * Keychain on a Mac, the desktop keyring on Linux, the Credential Manager on
 * Windows.
 */
export function checkKeyring(): Check {
  const r = secretStore();
  if (r.ok)
    return {
      id: 'keyring',
      name: 'Keyring',
      state: 'ok',
      found: MAC
        ? 'The Mac keychain'
        : WINDOWS
          ? 'The Windows Credential Manager'
          : 'The desktop keyring, through secret-tool'
    };
  return {
    id: 'keyring',
    name: 'Keyring',
    state: 'optional',
    found:
      LINUX && r.problem === 'not installed' ? 'secret-tool not installed' : `Keyring ${r.problem}`,
    fix: LINUX
      ? 'Install libsecret (it brings secret-tool) and run a keyring that speaks the Secret Service, such as GNOME Keyring, KWallet or KeePassXC. Until then, tools that need a key cannot connect.'
      : 'Until the secret store answers, tools that need a key cannot connect.'
  };
}

export function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 24
    ? { id: 'node', name: 'Node', state: 'ok', found: `Node ${process.versions.node}` }
    : {
        id: 'node',
        name: 'Node',
        state: 'missing',
        found: `Node ${process.versions.node}`,
        fix: 'Install Node 24 or later from nodejs.org, then run setup again.'
      };
}

/** Claude Code, signed in to a Claude plan or given an API key. Staff runs use it. */
export async function checkClaude(): Promise<Check> {
  const claude = (args: string[]) => {
    const [cmd, before] = claudeCommand();
    return run(cmd, [...before, ...args]);
  };
  const version = await claude(['--version']);
  if (!version.ok)
    return {
      id: 'claude',
      name: 'Claude Code',
      state: 'missing',
      found: 'Not installed',
      fix: WINDOWS
        ? 'Install it from PowerShell: `irm https://claude.ai/install.ps1 | iex`. Then run `claude` once and sign in.'
        : 'Install it: `npm install -g @anthropic-ai/claude-code`. Then run `claude` once and sign in.'
    };
  const status = await claude(['auth', 'status']);
  let signedIn = false;
  let method = '';
  try {
    const s = JSON.parse(status.out) as { loggedIn?: boolean; authMethod?: string };
    signedIn = !!s.loggedIn;
    method = s.authMethod ?? '';
  } catch {
    // An older Claude Code without `auth status`: an API key still works.
  }
  const v = version.out.split(' ')[0];
  // Staff run on the owner's API key, from the keychain, when the owner chose one.
  if (process.env.OFFICE_AUTH === 'key')
    return { id: 'claude', name: 'Claude Code', state: 'ok', found: `${v}, with your API key` };
  if (signedIn)
    return {
      id: 'claude',
      name: 'Claude Code',
      state: 'ok',
      found: `${v}, signed in${method === 'claude.ai' ? ' with a Claude plan' : method ? ` (${method})` : ''}`
    };
  return {
    id: 'claude',
    name: 'Claude Code',
    state: 'missing',
    found: `${v}, not signed in`,
    fix: 'Run `claude auth login` and sign in with your Claude plan, or give the office an API key.'
  };
}

/**
 * Ledger search by meaning: the search model, which the owner downloads from
 * Setup and the office runs itself (search-model.ts, embed.ts). Without it the
 * ledger is searched by its words.
 */
export async function checkSearch(): Promise<Check> {
  const name = 'Ledger search';
  const here = `this ${computerWord(currentSystem())}`;
  if (!RUNS_HERE)
    return {
      id: 'search',
      name,
      state: 'optional',
      found: 'Searches by words',
      fix: `The search model does not run on ${here}, so the ledger is searched by its words.`
    };
  if (isDownloading())
    return { id: 'search', name, state: 'optional', found: 'Downloading the search model' };
  // Loading it is the only way to know it runs. The office loads it once.
  const ready = modelOnDisk() && (await modelReady());
  if (modelOnDisk() && !ready)
    return {
      id: 'search',
      name,
      state: 'optional',
      found: 'Downloaded, but it would not start',
      fix: 'The ledger is searched by its words. The office log says why.'
    };
  if (ready) return { id: 'search', name, state: 'ok', found: `Searches by meaning, on ${here}` };
  return {
    id: 'search',
    name,
    state: 'optional',
    found:
      modelProblem() === 'mismatch'
        ? 'The model did not match its checksum, so the office removed it'
        : 'Searches by words',
    fix: `Download the search model in the office's Setup (about ${MODEL_MB} MB) to search by meaning. It runs on ${here}, and nothing you search leaves it.`,
    download: MODEL_MB
  };
}

/** uv, which runs the tools that come from PyPI. */
export async function checkUv(): Promise<Check> {
  const v = await run('uvx', ['--version']);
  return v.ok
    ? { id: 'uv', name: 'uv', state: 'ok', found: v.out.split('\n')[0] }
    : {
        id: 'uv',
        name: 'uv',
        state: 'optional',
        found: 'Not installed',
        fix: MAC
          ? 'Install it with `brew install uv` to connect tools that come from PyPI.'
          : 'Install uv (docs.astral.sh/uv) to connect tools that come from PyPI.'
      };
}

/** Docker, which runs the office's own Postgres when it is not hosted. */
export async function checkDocker(): Promise<Check> {
  if (!(await run('docker', ['--version'])).ok)
    return {
      id: 'docker',
      name: 'Docker',
      state: 'optional',
      found: 'Not installed',
      fix: `Only needed to run Postgres on this ${computerWord(currentSystem())}. Install Docker Desktop, or use hosted Postgres.`
    };
  const info = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  return info.ok
    ? { id: 'docker', name: 'Docker', state: 'ok', found: `Running, ${info.out}` }
    : {
        id: 'docker',
        name: 'Docker',
        state: 'optional',
        found: 'Installed, not running',
        fix: `Open Docker Desktop. Only needed to run Postgres on this ${computerWord(currentSystem())}.`
      };
}

/** The login service that keeps the office running with no terminal open. */
export async function checkService(): Promise<Check> {
  return (await serviceInstalled('com.oddboro.office'))
    ? { id: 'service', name: 'Login service', state: 'ok', found: 'The office starts at login' }
    : {
        id: 'service',
        name: 'Login service',
        state: 'optional',
        found: 'Not installed',
        fix: 'Run `npm run service:install -w apps/office` to keep the office running at login. Until then, `npm run dev`.'
      };
}

/** Where a connection string points, without its password. */
export function describeUrl(url: string): { host: string; local: boolean; pooled: boolean } {
  try {
    const u = new URL(url);
    const local = ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
    // Transaction poolers drop LISTEN, which live updates need: Neon's
    // "-pooler" hosts and Supabase's port 6543.
    const pooled = /-pooler\./.test(u.hostname) || u.port === '6543';
    return { host: u.port ? `${u.hostname}:${u.port}` : u.hostname, local, pooled };
  } catch {
    return { host: '', local: false, pooled: false };
  }
}

export type DatabaseReport = {
  checks: Check[];
  /** The URL that worked, with sslmode added when the server wanted it. */
  url?: string;
  /** The database already holds an office. */
  hasOffice: boolean;
};

/**
 * Everything the office needs from a Postgres: it connects, it is 15 or
 * later, it has pgvector, LISTEN and NOTIFY reach back (the page's live
 * updates ride on them), and it answers fast enough to feel local.
 */
export async function checkDatabase(url: string): Promise<DatabaseReport> {
  const where = describeUrl(url);
  const fail = (found: string, fix: string): DatabaseReport => ({
    checks: [{ id: 'database', name: 'Postgres', state: 'missing', found, fix }],
    hasOffice: false
  });
  if (!/^postgres(ql)?:\/\//.test(url) || !where.host)
    return fail(
      'That is not a Postgres connection string',
      'Paste one that starts with postgres:// or postgresql://, from your provider’s Connect page.'
    );

  // A hosted server usually wants TLS. Try as given, then with sslmode=require.
  const tries = [url];
  if (!where.local && !/[?&]sslmode=/.test(url))
    tries.push(`${url}${url.includes('?') ? '&' : '?'}sslmode=require`);
  let sql: postgres.Sql | undefined;
  let used = url;
  let lastError = '';
  for (const t of tries) {
    const s = postgres(t, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      await s`select 1`;
      sql = s;
      used = t;
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await s.end({ timeout: 1 }).catch(() => {});
    }
  }
  if (!sql)
    return fail(
      `Could not connect to ${where.host}: ${lastError}`,
      /password|auth/i.test(lastError)
        ? 'Check the user and password in the connection string.'
        : `Check the host and port, and that the database accepts connections from this ${computerWord(currentSystem())}.`
    );

  const checks: Check[] = [];
  try {
    const [{ server_version_num: num, server_version: ver }] = await sql<
      { server_version_num: string; server_version: string }[]
    >`select current_setting('server_version_num') as server_version_num, current_setting('server_version') as server_version`;
    const major = Math.floor(Number(num) / 10000);
    checks.push(
      major >= 15
        ? {
            id: 'database',
            name: 'Postgres',
            state: 'ok',
            found: `Postgres ${ver.split(' ')[0]} at ${where.host}${where.local ? '' : ', hosted'}`
          }
        : {
            id: 'database',
            name: 'Postgres',
            state: 'missing',
            found: `Postgres ${ver} at ${where.host}`,
            fix: 'The office needs Postgres 15 or later.'
          }
    );

    const [vector] = await sql<
      { installed: string | null }[]
    >`select installed_version as installed from pg_available_extensions where name = 'vector'`;
    if (!vector)
      checks.push({
        id: 'pgvector',
        name: 'pgvector',
        state: 'missing',
        found: 'Not available on this server',
        fix: 'Pick a provider with pgvector: Neon, Supabase, Amazon RDS and most others have it.'
      });
    else {
      let installed = !!vector.installed;
      if (!installed)
        installed = await sql`create extension if not exists vector`.then(
          () => true,
          () => false
        );
      checks.push(
        installed
          ? { id: 'pgvector', name: 'pgvector', state: 'ok', found: 'Ready' }
          : {
              id: 'pgvector',
              name: 'pgvector',
              state: 'missing',
              found: 'Available, but this user cannot turn it on',
              fix: 'Turn it on in your provider’s dashboard (Extensions: vector), or run `create extension vector` as the owner of the database.'
            }
      );
    }

    // Live updates: listen, notify, and wait for it to come back.
    const heard = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 4000);
      sql!
        .listen('oddboro_setup', () => {
          clearTimeout(timer);
          done(true);
        })
        .then(() => sql!`select pg_notify('oddboro_setup', 'ping')`)
        .catch(() => {
          clearTimeout(timer);
          done(false);
        });
    });
    checks.push(
      heard
        ? { id: 'notify', name: 'Live updates', state: 'ok', found: 'LISTEN and NOTIFY work' }
        : {
            id: 'notify',
            name: 'Live updates',
            state: 'missing',
            found: where.pooled
              ? 'This is a pooled connection, which drops LISTEN'
              : 'NOTIFY did not come back',
            fix: 'Use the direct connection string, not the pooled one. On Neon, turn off “Connection pooling” (no -pooler in the host). On Supabase, use the session pooler or the direct connection on port 5432.'
          }
    );

    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await sql`select 1`;
      times.push(performance.now() - t);
    }
    const ms = Math.round(times.sort((a, b) => a - b)[2]);
    checks.push(
      ms <= 120
        ? { id: 'latency', name: 'Speed', state: 'ok', found: `${ms} ms a query` }
        : {
            id: 'latency',
            name: 'Speed',
            state: 'optional',
            found: `${ms} ms a query`,
            fix: 'The office works, but pages will feel slow. Pick a region near you.'
          }
    );

    const [office] = await sql<
      { exists: boolean }[]
    >`select to_regclass('public.ledger') is not null as exists`;
    return { checks, url: used, hasOffice: office.exists };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

/** Every check that needs no database, in the order setup shows them. */
export async function checkMachine(): Promise<Check[]> {
  return Promise.all([
    checkMac(),
    checkNode(),
    checkClaude(),
    checkDocker(),
    checkSearch(),
    checkUv(),
    checkService(),
    checkKeyring()
  ]);
}
