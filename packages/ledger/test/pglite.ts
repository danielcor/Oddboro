// An in-memory PGlite with every migration, put in place of db.ts so the
// office's own code runs against it. A test file imports this before it loads
// any module that imports db.ts, and runs with
// `--experimental-test-module-mocks`, as `npm test -w @oddboro/ledger` does.
import { readFileSync } from 'node:fs';
import { after, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../src/schema.ts';

// The run's migrated database when global-setup.ts made one; migrate() below
// then finds nothing to apply.
const made = process.env.ODDBORO_TEST_DATABASE;
const client = await PGlite.create({
  extensions: { vector },
  ...(made && { loadDataDir: new Blob([readFileSync(`${made}.tar`)]) })
});
await client.exec('create extension if not exists vector');
export const db = drizzle(client, { schema, casing: 'snake_case' });
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });

/** A query written as a tagged template, returning its rows, as db.ts's `sql` does. */
export async function sql<Row = Record<string, unknown>>(
  parts: TemplateStringsArray,
  ...values: unknown[]
): Promise<Row[]> {
  const text = parts.reduce((query, part, i) => `${query}$${i}${part}`);
  return (await client.query<Row>(text, values)).rows;
}

mock.module(new URL('../src/db.ts', import.meta.url).href, { exports: { db, sql } });
after(() => client.close());
