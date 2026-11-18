// Granting a tool says whether it put a task on the owner's desk: a tool not
// connected yet needs the connect steps, and one already connected needs
// none, so the Services tab never points the owner at a task that is not
// there (issue #32). The office's own code on every migration, in an
// in-memory PGlite that stands in for db.ts (pglite.ts). Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { connectors, staff, tasks } from '../src/schema.ts';
import { db } from './pglite.ts';

const { grantAccess } = await import('../src/office.ts');

const odd = (id: string, name: string) => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`
});
await db.insert(staff).values([odd('cole', 'Cole'), odd('paige', 'Paige')]);
await db.insert(connectors).values({
  id: 'brain',
  name: 'Brain',
  description: 'A hosted memory.',
  kind: 'http',
  config: { url: 'https://brain.example/mcp', headers: ['x-brain-key'] }
});

const tasksFor = (staffId: string) => db.select().from(tasks).where(eq(tasks.staffId, staffId));

test('a tool not connected yet puts its connect steps on the desk', async () => {
  assert.deepEqual(await grantAccess('cole', { connector: 'brain', level: 'read' }), {
    task: true,
    connector: 'brain'
  });
  const [t] = await tasksFor('cole');
  assert.equal(t.title, 'Connect Brain for Cole');
});

test('a tool already connected puts nothing on the desk', async () => {
  await db
    .update(connectors)
    .set({ tools: ['search'], readTools: ['search'], readyAt: new Date() })
    .where(eq(connectors.id, 'brain'));
  assert.deepEqual(await grantAccess('paige', { connector: 'brain', level: 'read' }), {
    task: false,
    connector: 'brain'
  });
  assert.equal((await tasksFor('paige')).length, 0);
});
