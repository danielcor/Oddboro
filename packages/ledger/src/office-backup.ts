// The owner's backup of their office: one file they keep, and a restore from
// it. The file is a gzipped tar (tar.ts) that opens anywhere: first a small
// manifest, then the office's own database as PGlite copied it, then the
// office's own folders. It holds everything in the office except sign-ins.
//
// Making one never stops the office: PGlite copies its folder between two
// statements (`dumpLocalDatabase`), so the copy is whole.
//
// A restore happens in two steps, because the database must be closed to
// replace it:
// 1. `stageRestore` reads the file as it arrives and unpacks it into a
//    folder of its own, checking every entry first. Nothing of the office
//    changes. A file that is not a backup, is damaged, or came from a newer
//    Oddboro is refused, and the folder goes.
// 2. The office starts again, and `applyStagedRestore` runs before PGlite
//    opens its files (local-db.ts): it copies the office as it is into
//    `backups/before-restore-<time>`, then swaps in each part from the
//    backup. Migrations then run as at any start. If the office stops
//    halfway, the next start finishes the swap.
// A restore never grants anything: access, levels and asks come back exactly
// as the backup holds them.
import { createGunzip, createGzip } from 'node:zlib';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { posix, win32 } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { OFFICE_MODEL_VAR } from './agents.ts';
import { copyAside, stampNow } from './backup.ts';
import { ENV_FILE, readEnv, writeEnv } from './env.ts';
import { home } from './home.ts';
import { END, header, padding, TarProblem, TarReader } from './tar.ts';

/** The backup's own layout. A file with a higher number came from a newer Oddboro. */
export const BACKUP_FORMAT = 1;
/** The first entry in every backup. */
export const MANIFEST = 'oddboro-backup.json';
/** The end of a backup's file name, which the page offers to open. */
export const BACKUP_EXTENSION = '.oddboro';
/** The most a backup unpacks to. An office larger than this is not one Oddboro made. */
export const BACKUP_MAX_BYTES = 16 * 1024 ** 3;

// What a backup holds and what it leaves out, in one place. Every top-level
// name in the office home is in one list or the other, and a test fails when
// the code writes a name in neither (`test/office-backup.test.ts`).
/** The database, copied by PGlite itself, never as live files. */
const DATABASE = 'db';
/** The office's own folders, copied whole, except what `LEFT_OUT_INSIDE` names. */
export const BACKED_UP = ['staff', 'threads', 'office', 'data', 'project-sessions'] as const;
/** Inside those folders: each Grok or Codex office run's own scratch folder, removed when it ends. */
const LEFT_OUT_INSIDE = ['office/runs'];
/** Everything else in the home, and why it stays out. A restore leaves each of these as it is. */
export const LEFT_OUT: Record<string, string> = {
  accounts: "each AI tool's sign-ins",
  grok: "Grok's sign-in from before accounts",
  gemini: "Gemini's own folder, which can hold its sign-in",
  mcp: "each run's tool settings, which hold that run's token and are made again for every run",
  'codex-tmp': 'scratch space for runs',
  'file-checks': 'scratch space for runs',
  backups: 'the copies this office made of itself',
  bin: "this computer's own web server",
  caddy: "this computer's own web address",
  models: 'the search model, which Setup downloads again',
  version: 'which version last opened this office',
  '.env': 'its office settings travel in the manifest; a database address or password never does',
  '.s.PGSQL.5432': "the database's socket",
  '.s.PGSQL.5432.lock': "the socket's lock",
  restore: 'a restore waiting for the office to start again',
  '.restore-': 'a restore still arriving'
};
/** The settings in .env a backup carries. Each says how the office works, never where or with what key. */
const SETTINGS = [
  'OFFICE_TIME_ZONE',
  'OFFICE_AUTH',
  'OFFICE_AGENT',
  ...Object.values(OFFICE_MODEL_VAR)
] as const;
/** A setting's value, as the office writes one: a zone, a tool, a model id. */
const SETTING_VALUE = /^[\w./+:-]{0,200}$/;

const STAGED = 'restore';
const ARRIVING = '.restore-';

export type Manifest = {
  format: number;
  /** The Oddboro version that made it, or `development`. */
  version: string;
  /** When it was made, as an ISO time. */
  madeAt: string;
  /** The newest migration the database holds: drizzle's `created_at`, a time in ms. */
  migrations: number;
  /** Which of the office's own folders it holds. */
  parts: string[];
  settings: Record<string, string>;
};

/** Why a file could not be restored, in the one sentence the owner sees. */
export class BackupRefused extends Error {}
const NOT_A_BACKUP = 'This file is not an Oddboro backup.';
const DAMAGED = 'This backup is damaged, so nothing was restored.';
const NEWER = 'This backup was made by a newer version of Oddboro. Update Oddboro first.';
const TOO_BIG = 'This backup is larger than Oddboro restores.';

const currentVersion = () => process.env.ODDBORO_VERSION || 'development';

/** The file name a backup made now gets, such as `Oddboro backup 2026-11-14.oddboro`. */
export const backupName = (day: string): string => `Oddboro backup ${day}${BACKUP_EXTENSION}`;

// ---------------------------------------------------------------------------
// Making one

/** Every folder and file under `part` of the home, as paths inside the home. Links and anything else are left out. */
function* walk(part: string): Generator<{ path: string; kind: 'file' | 'dir' }> {
  const at = home(part);
  const stat = lstatSync(at, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || LEFT_OUT_INSIDE.includes(part)) return;
  yield { path: part, kind: 'dir' };
  for (const d of readdirSync(at, { withFileTypes: true })) {
    const path = `${part}/${d.name}`;
    if (d.isDirectory()) yield* walk(path);
    else if (d.isFile()) yield { path, kind: 'file' };
  }
}

/** A file's bytes as they are when it opens, in pieces. One that shrinks meanwhile ends in zeros. */
function* fileBytes(path: string): Generator<Buffer> {
  const fd = openSync(home(path), 'r');
  try {
    const size = fstatSync(fd).size;
    yield header({ path, kind: 'file', size });
    const piece = Buffer.alloc(1024 * 1024);
    let done = 0;
    while (done < size) {
      const got = readSync(fd, piece, 0, Math.min(piece.length, size - done), done);
      if (!got) {
        yield Buffer.alloc(size - done);
        break;
      }
      yield Buffer.from(piece.subarray(0, got));
      done += got;
    }
    yield padding(size);
  } finally {
    closeSync(fd);
  }
}

/** The database's own tar, from PGlite, entry by entry under `db/`. */
function databaseEntries(dump: Buffer): Buffer[] {
  const out: Buffer[] = [header({ path: DATABASE, kind: 'dir' })];
  let file: { size: number; parts: Buffer[] } | undefined;
  const flush = () => {
    if (!file) return;
    out.push(...file.parts, padding(file.size));
    file = undefined;
  };
  const reader = new TarReader({
    entry(e) {
      flush();
      const path = `${DATABASE}/${e.path.replace(/^\.?\/+/, '')}`;
      if (path === `${DATABASE}/`) return;
      out.push(header({ ...e, path }));
      if (e.kind === 'file') file = { size: e.size, parts: [] };
    },
    data: (chunk) => file!.parts.push(chunk)
  });
  reader.push(dump);
  reader.finish();
  flush();
  return out;
}

/**
 * The backup, gzipped, as a stream. `dump` is PGlite's tar of the database
 * (`dumpLocalDatabase`) and `migrations` the newest migration it holds.
 */
export function backupStream(dump: Buffer, migrations: number): Readable {
  const env = readEnv();
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    version: currentVersion(),
    madeAt: new Date().toISOString(),
    migrations,
    parts: BACKED_UP.filter((p) => lstatSync(home(p), { throwIfNoEntry: false })?.isDirectory()),
    settings: Object.fromEntries(
      SETTINGS.flatMap((k) => (env[k] && SETTING_VALUE.test(env[k]) ? [[k, env[k]]] : []))
    )
  };
  const db = databaseEntries(dump);
  function* bytes(): Generator<Buffer> {
    const json = Buffer.from(JSON.stringify(manifest, null, 2));
    yield header({ path: MANIFEST, kind: 'file', size: json.length });
    yield json;
    yield padding(json.length);
    yield* db;
    for (const part of BACKED_UP)
      for (const e of walk(part))
        if (e.kind === 'dir') yield header(e);
        else yield* fileBytes(e.path);
    yield END;
  }
  return Readable.from(bytes(), { objectMode: false }).pipe(createGzip());
}

// ---------------------------------------------------------------------------
// Checking and staging one

/** The newest migration this build knows, as drizzle records it. */
function newestMigration(): number {
  const folder = fileURLToPath(new URL('../migrations', import.meta.url));
  return Math.max(
    0,
    ...readMigrationFiles({ migrationsFolder: folder }).map((m) => m.folderMillis)
  );
}

const versionParts = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
/** True when `a` is a release version after `b`. Development builds compare as neither. */
export function laterVersion(a: string, b: string): boolean {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return false;
  const at = x.findIndex((n, i) => n !== y[i]);
  return at >= 0 && x[at] > y[at];
}

function readManifest(bytes: Buffer): Manifest {
  let m: Partial<Manifest>;
  try {
    m = JSON.parse(bytes.toString('utf8')) as Partial<Manifest>;
  } catch {
    throw new BackupRefused(DAMAGED);
  }
  if (
    !Number.isInteger(m.format) ||
    typeof m.version !== 'string' ||
    typeof m.madeAt !== 'string' ||
    typeof m.migrations !== 'number' ||
    typeof m.settings !== 'object' ||
    !m.settings ||
    !Array.isArray(m.parts) ||
    !m.parts.every((p) => (BACKED_UP as readonly unknown[]).includes(p))
  )
    throw new BackupRefused(NOT_A_BACKUP);
  if (m.format! > BACKUP_FORMAT || laterVersion(m.version, currentVersion()))
    throw new BackupRefused(NEWER);
  if (m.migrations > newestMigration()) throw new BackupRefused(NEWER);
  return m as Manifest;
}

/**
 * The path an entry lays down, inside the backup's own folder, or why not.
 * Only the manifest, the database and the office's own folders, by plain
 * relative paths: no `..`, no full path on any system, no backslash.
 */
function safePath(path: string, kind: 'file' | 'dir'): string {
  const parts = path.split('/');
  if (
    !path ||
    /[\\\0]/.test(path) ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    parts.some((p) => p === '' || p === '.' || p === '..')
  )
    throw new BackupRefused(NOT_A_BACKUP);
  if (path === MANIFEST && kind === 'file') return path;
  const top = parts[0];
  if (top !== DATABASE && !(BACKED_UP as readonly string[]).includes(top))
    throw new BackupRefused(NOT_A_BACKUP);
  if (LEFT_OUT_INSIDE.some((p) => path === p || path.startsWith(`${p}/`)))
    throw new BackupRefused(NOT_A_BACKUP);
  return path;
}

let staging = false;

/**
 * Read a backup as it arrives and unpack it into `<home>/restore`, checking
 * everything first. Nothing of the office changes; the office applies it
 * when it next starts (`applyStagedRestore`). Throws `BackupRefused` with the
 * sentence to show, and leaves no trace, for a file that is not a backup, is
 * damaged or is too new.
 */
export async function stageRestore(body: AsyncIterable<Uint8Array>): Promise<Manifest> {
  if (staging) throw new BackupRefused('A restore is already on its way. Wait for it to finish.');
  staging = true;
  for (const n of readdirSync(home()))
    if (n.startsWith(ARRIVING)) rmSync(home(n), { recursive: true, force: true });
  const into = mkdtempSync(home(ARRIVING));
  let fd: number | undefined;
  let left = 0;
  let manifest: Manifest | undefined;
  let manifestBytes: Buffer[] | undefined;
  let first = true;
  let total = 0;
  const close = () => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
  };
  const endManifest = () => {
    if (manifestBytes) manifest = readManifest(Buffer.concat(manifestBytes));
    manifestBytes = undefined;
  };
  const reader = new TarReader({
    entry(e) {
      close();
      endManifest();
      const path = safePath(e.path, e.kind);
      if (first !== (path === MANIFEST)) throw new BackupRefused(NOT_A_BACKUP);
      first = false;
      total += e.size;
      if (total > BACKUP_MAX_BYTES) throw new BackupRefused(TOO_BIG);
      const to = posix.join(into, path);
      if (path === MANIFEST) {
        if (e.size > 64 * 1024) throw new BackupRefused(NOT_A_BACKUP);
        manifestBytes = [];
        left = e.size;
        if (!left) endManifest();
        return;
      }
      if (e.kind === 'dir') return void mkdirSync(to, { recursive: true, mode: 0o700 });
      mkdirSync(posix.dirname(to), { recursive: true, mode: 0o700 });
      // `wx`: a second entry for the same file is no backup the office wrote.
      fd = openSync(to, 'wx', 0o600);
      left = e.size;
      if (!left) close();
    },
    data(chunk) {
      left -= chunk.length;
      if (manifestBytes) {
        manifestBytes.push(Buffer.from(chunk));
        if (!left) endManifest();
        return;
      }
      writeSync(fd!, chunk);
      if (!left) close();
    }
  });
  let seen = 0;
  try {
    await pipeline(
      Readable.from(body),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          // Gzip's own mark, before anything is unpacked.
          if (!seen && (chunk[0] !== 0x1f || (chunk.length > 1 && chunk[1] !== 0x8b)))
            throw new BackupRefused(NOT_A_BACKUP);
          seen += chunk.length;
          if (seen > BACKUP_MAX_BYTES) throw new BackupRefused(TOO_BIG);
          yield chunk;
        }
      },
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          try {
            reader.push(chunk);
            done();
          } catch (e) {
            done(e as Error);
          }
        }
      })
    );
    reader.finish();
    endManifest();
    if (!manifest || !existsSync(posix.join(into, DATABASE, 'PG_VERSION')))
      throw new BackupRefused(seen ? NOT_A_BACKUP : DAMAGED);
    // Then, and only then, is it ready for the next start: the manifest marks it so.
    writeFileSync(posix.join(into, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
    rmSync(home(STAGED), { recursive: true, force: true });
    renameSync(into, home(STAGED));
    return manifest;
  } catch (e) {
    close();
    rmSync(into, { recursive: true, force: true });
    if (e instanceof BackupRefused) throw e;
    if (e instanceof TarProblem)
      throw new BackupRefused(e.kind === 'damaged' ? DAMAGED : NOT_A_BACKUP);
    const code = (e as NodeJS.ErrnoException).code ?? '';
    // zlib's errors: a cut-off or garbled file.
    if (code.startsWith('Z_')) throw new BackupRefused(DAMAGED);
    // Two entries for one path, or a file where a folder goes: never a backup the office wrote.
    if (['EEXIST', 'ENOTDIR', 'EISDIR'].includes(code)) throw new BackupRefused(NOT_A_BACKUP);
    throw e;
  } finally {
    staging = false;
  }
}

// ---------------------------------------------------------------------------
// Applying one, as the office starts

type Restored = { madeAt: string; savedAside: string };
// On globalThis, so the page's routes see what the start did even when Vite loads this module again.
const g = globalThis as unknown as { oddboroRestored?: Restored };
/** The restore this start applied, for the page's one line about it, until the owner closes it. */
export const lastRestore = (): Restored | undefined => g.oddboroRestored;
export const forgetRestore = (): void => void (g.oddboroRestored = undefined);

/**
 * Before PGlite opens: when a restore is staged, save the office as it is
 * into `backups/before-restore-<time>`, then put the backup's parts in place
 * of the office's and its settings in .env. Returns the saved copy's folder.
 */
export function applyStagedRestore(): string | undefined {
  const staged = home(STAGED);
  if (!existsSync(posix.join(staged, MANIFEST))) return undefined;
  const manifest = JSON.parse(readFileSync(posix.join(staged, MANIFEST), 'utf8')) as Manifest;
  const parts = [DATABASE, ...BACKED_UP];
  // The office as it is, whole, before anything changes, with the .env it ran on.
  const saved = copyAside(`before-restore-${stampNow()}`, parts);
  if (existsSync(ENV_FILE))
    writeFileSync(posix.join(saved, '.env'), readFileSync(ENV_FILE), { mode: 0o600 });
  for (const part of parts) {
    const from = posix.join(staged, part);
    // A part already moved in by a start that stopped halfway stays.
    if (!existsSync(from) && moved(manifest, part)) continue;
    rmSync(home(part), { recursive: true, force: true });
    if (existsSync(from)) renameSync(from, home(part));
  }
  const settings: Record<string, string> = {};
  for (const k of SETTINGS) {
    const v = manifest.settings[k];
    settings[k] = typeof v === 'string' && SETTING_VALUE.test(v) ? v : '';
    if (settings[k]) process.env[k] = settings[k];
    else delete process.env[k];
  }
  writeEnv(settings);
  rmSync(staged, { recursive: true, force: true });
  g.oddboroRestored = { madeAt: manifest.madeAt, savedAside: saved };
  console.log(
    `office: restored the backup made ${manifest.madeAt}; the office before it is in ${saved}`
  );
  return saved;
}

/** Whether the backup held `part`: the manifest lists what it carries. */
const moved = (m: Manifest, part: string) => part === DATABASE || m.parts.includes(part);
