// A copy of the office's own database before a new version of the app opens
// it, so a migration that goes wrong never costs the owner their office. The
// app passes its version as ODDBORO_VERSION; `<home>/version` holds the one
// that last started. When they differ, `<home>/db` is copied to
// `<home>/backups/pre-<version>-<time>/db` before PGlite opens it, and only
// the 3 newest of those copies stay. Development (no ODDBORO_VERSION) never
// copies.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { home } from './home.ts';

const KEEP = 3;
const NAME = /^pre-.+-(\d{8}T\d{6}Z)$/;

/** Copy the database aside when this is a new version's first start. Returns the copy's folder, if it made one. */
export function backUpForNewVersion(version = process.env.ODDBORO_VERSION): string | undefined {
  if (!version) return undefined;
  const file = home('version');
  const last = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (last === version) return undefined;
  let made: string | undefined;
  if (existsSync(home('db'))) {
    made = copyAside(`pre-${version}-${stampNow()}`, ['db']);
    prune();
  }
  // A first start on a new Mac has no office folder yet.
  mkdirSync(home(), { recursive: true });
  writeFileSync(file, `${version}\n`);
  // The app's log keeps this line. After the shell's "installed X over Y", no
  // "first start of X" means the update opened the old version again (#40).
  console.log(
    `office: first start of ${version}${last ? ` after ${last}` : ''}${made ? `, backed up to ${made}` : ''}`
  );
  return made;
}

/** The time now as a folder name takes it: `20261114T230102Z`. */
export const stampNow = (): string =>
  new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

/**
 * Copy `parts` of the office home (those that exist) into `<home>/backups/<name>`,
 * whole or not at all: into a `.copying-` folder first, renamed once every
 * part is in. Returns the copy's folder. Restoring a backup uses it too
 * (office-backup.ts).
 */
export function copyAside(name: string, parts: string[]): string {
  const dir = home('backups');
  const made = join(dir, name);
  mkdirSync(dir, { recursive: true });
  // A copy a force-quit or crash cut off is never a backup, and only one
  // office opens this home at a time, so clear any before copying again.
  for (const n of readdirSync(dir))
    if (n.startsWith('.copying-')) rmSync(join(dir, n), { recursive: true, force: true });
  const copying = mkdtempSync(join(dir, '.copying-'));
  try {
    for (const part of parts)
      if (existsSync(home(part)))
        cpSync(home(part), join(copying, part), { recursive: true, verbatimSymlinks: true });
    renameSync(copying, made);
  } catch (error) {
    rmSync(copying, { recursive: true, force: true });
    throw error;
  }
  return made;
}

/** Keep the newest copies made before an update. Every other backup is left alone. */
function prune(): void {
  const dir = home('backups');
  const copies = readdirSync(dir)
    .map((name) => ({ name, stamp: NAME.exec(name)?.[1] }))
    .filter((c): c is { name: string; stamp: string } => !!c.stamp)
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
  for (const c of copies.slice(KEEP)) rmSync(join(dir, c.name), { recursive: true, force: true });
}
