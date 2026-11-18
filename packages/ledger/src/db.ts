// One connection pool per process. The office app, the staff tool server and
// the scripts all reach Postgres through this file. DATABASE_URL comes from the
// environment, or from the repo's .env, which fills in anything not already set.
// With neither, the office keeps its own database (local-db.ts), which the
// office server starts and everything else reaches over a local socket.
// ODDBORO_ENV names another .env, to try an office out beside the real one.
// A .env this process may not read is skipped: Grok's sandbox shows the file
// to the staff tool server but refuses to open it, and loading it then threw
// before the server offered a tool (seen 2026-11-05). The office passes that
// server what it needs from .env instead (`access` in the office's staff.ts).
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ENV_FILE as ENV } from './env.ts';
import { DATABASE_PORT, home } from './home.ts';
import { currentPlatform } from './platform.ts';
import * as schema from './schema.ts';

try {
  if (existsSync(ENV)) process.loadEnvFile(ENV);
} catch {
  // Unreadable here, as inside Grok's sandbox: the environment carries what is needed.
}

export const LOCAL_DATABASE_DIR = home('db');
/**
 * Where the office's own database listens. On a Mac and Linux it is a socket
 * in the office home, which only the owner's account may open
 * (`makeHomePrivate`), so no other account reaches it and no port is open.
 * The name is Postgres's own, so a URL's `host=<folder>` finds it, in psql and
 * here (`openPool`).
 * Windows keeps 127.0.0.1 on LOCAL_DATABASE_PORT, which ODDBORO_DB_PORT moves.
 * There Node listens on a path only as a named pipe, which no psql reaches,
 * whose name any account may take first, and which only Windows can test.
 * Any account on a Windows computer can still reach that port.
 */
export const LOCAL_DATABASE_SOCKET =
  currentPlatform() === 'win32' ? undefined : resolve(home('.s.PGSQL.5432'));
export const LOCAL_DATABASE_PORT = DATABASE_PORT;
/**
 * True when the office keeps its own database rather than one .env names. It
 * goes in the environment too, so a second load of this file, or a process
 * this one starts, reads the same answer after DATABASE_URL is filled in. The
 * office's own database is always found from where the office lives, so a
 * URL an older version passed on, with its old port, never pins it.
 */
export const LOCAL = !process.env.DATABASE_URL || process.env.ODDBORO_LOCAL_DB === '1';
export const DATABASE_URL = !LOCAL
  ? process.env.DATABASE_URL!
  : LOCAL_DATABASE_SOCKET
    ? `postgres://postgres:postgres@localhost/postgres?host=${encodeURIComponent(dirname(LOCAL_DATABASE_SOCKET))}`
    : `postgres://postgres:postgres@127.0.0.1:${LOCAL_DATABASE_PORT}/postgres`;
process.env.DATABASE_URL = DATABASE_URL;
if (LOCAL) process.env.ODDBORO_LOCAL_DB = '1';

/**
 * A connection pool on `url`. postgres.js reaches a socket only through its
 * `host` option, never through a URL's `host=<folder>` as psql reads it, so a
 * folder there moves to the option. Any other URL goes as it is.
 */
export function openPool(url: string, options: postgres.Options<{}> = {}) {
  const u = URL.parse(url);
  const folder = u?.searchParams.get('host');
  if (!u || !folder?.startsWith('/')) return postgres(url, options);
  u.searchParams.delete('host');
  return postgres(u.href, { ...options, host: folder });
}

// One pool per process, even when Vite reloads this file in development: a
// new pool on every reload, with the old ones still open, used up every
// connection the office's own database takes.
const g = globalThis as unknown as { oddboroSql?: ReturnType<typeof postgres> };
export const sql = (g.oddboroSql ??= openPool(DATABASE_URL, { max: 5, onnotice: () => {} }));
export const db = drizzle(sql, { schema, casing: 'snake_case' });
