// Once per `npm test` run, before any test file: a database with every
// migration, as a folder and as PGlite's own dump of it. tool-server.ts copies
// the folder into its office and pglite.ts loads the dump, so a file opens a
// copy instead of making a database (initdb) and migrating it: 3.4 s a file
// on a PC, about twice that on GitHub's Mac runner, where that cost alone
// held the suite near its 10-minute limit (NEW-1874). Its path reaches every
// test file in ODDBORO_TEST_DATABASE; a file run on its own makes its own.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const folder = mkdtempSync(join(tmpdir(), 'oddboro-test-database-'));

export async function globalSetup(): Promise<void> {
  const dir = join(folder, 'db');
  const client = await PGlite.create(dir, { extensions: { vector } });
  await client.exec('create extension if not exists vector');
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url))
  });
  const dump = await client.dumpDataDir('none');
  await client.close();
  writeFileSync(`${dir}.tar`, Buffer.from(await dump.arrayBuffer()));
  process.env.ODDBORO_TEST_DATABASE = dir;
}

export function globalTeardown(): void {
  rmSync(folder, { recursive: true, force: true });
}
