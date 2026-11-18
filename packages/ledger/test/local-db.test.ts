// Where the office's own database listens on a Mac and Linux: a socket in the
// office home, which only the owner's account may open, and no port. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const WINDOWS = process.platform === 'win32';
const folder = mkdtempSync(join(tmpdir(), 'oddboro-local-db-'));
after(() => rmSync(folder, { recursive: true, force: true }));
const free = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });
const reaches = (to: { path: string } | { port: number; host: string }) =>
  new Promise<string>((done) => {
    const s = connect(to, () => {
      s.destroy();
      done('connected');
    });
    s.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'));
  });

/** Start the office's own database in a process of its own, with `home` as the office home. */
function startIn(home: string, port: number) {
  const script = `
    const { startLocalDatabase } = await import(${JSON.stringify(new URL('../src/local-db.ts', import.meta.url).href)});
    const stop = await startLocalDatabase();
    await stop();
  `;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ODDBORO_HOME: home,
    ODDBORO_DB_PORT: String(port),
    ODDBORO_ENV: join(home, 'none.env'),
    ODDBORO_LOCAL_DB: '1'
  };
  delete env.DATABASE_URL;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8'
  });
}

test(
  'the office database listens on a socket in the office home, and on no port',
  { skip: WINDOWS && 'Windows keeps a port on 127.0.0.1' },
  async () => {
    const home = join(folder, 'office');
    mkdirSync(home);
    const port = await free();
    Object.assign(process.env, {
      ODDBORO_HOME: home,
      ODDBORO_DB_PORT: String(port),
      ODDBORO_ENV: join(home, 'none.env'),
      // An address an older version passed on: the office's own database never takes it.
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
      ODDBORO_LOCAL_DB: '1'
    });
    const { startLocalDatabase } = await import('../src/local-db.ts');
    const stop = await startLocalDatabase();
    const { sql, DATABASE_URL, LOCAL_DATABASE_SOCKET } = await import('../src/db.ts');
    try {
      assert.equal(LOCAL_DATABASE_SOCKET, join(home, '.s.PGSQL.5432'));
      assert.ok(statSync(LOCAL_DATABASE_SOCKET).isSocket());
      assert.equal(
        DATABASE_URL,
        `postgres://postgres:postgres@localhost/postgres?host=${encodeURIComponent(home)}`
      );
      assert.equal(process.env.DATABASE_URL, DATABASE_URL);
      const [row] = await sql`select 1 as one`;
      assert.equal(row.one, 1);
      // No port at all: a server listening on one shows as TCPServerWrap.
      const handles = process.getActiveResourcesInfo();
      assert.ok(!handles.includes('TCPServerWrap'), handles.join(', '));
      assert.equal(await reaches({ port, host: '127.0.0.1' }), 'ECONNREFUSED');
    } finally {
      await sql.end();
      await stop();
    }
  }
);

test(
  "an office does not start on a home another office is running from, and clears a crashed office's socket",
  { skip: WINDOWS && 'Windows keeps a port on 127.0.0.1' },
  async () => {
    const home = join(folder, 'shared');
    mkdirSync(home);
    const socket = join(home, '.s.PGSQL.5432');
    const other: Server = await new Promise((done) => {
      const s = createServer((c) => c.end()).listen(socket, () => done(s));
    });
    const refused = startIn(home, await free());
    await new Promise((done) => other.close(done));
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Another office is already running from /);

    // What a crash leaves: a socket file nothing answers on.
    writeFileSync(socket, '');
    const started = startIn(home, await free());
    assert.equal(started.status, 0, started.stderr);
  }
);

test(
  'a home too deep for a socket stops the office with a plain reason',
  { skip: WINDOWS && 'Windows keeps a port on 127.0.0.1' },
  async () => {
    const home = join(folder, 'x'.repeat(120));
    const r = startIn(home, await free());
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr,
      /The office's database socket would be .* bytes\. This system takes at most/
    );
  }
);
