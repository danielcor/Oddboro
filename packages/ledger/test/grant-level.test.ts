// A grant's level changes in place, both ways: the tool stays connected and
// signed in, nothing goes on the desk, and the Ledger says so once. Write
// needs the Draft level or higher. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { connectors, grants, ledger, staff, tasks } from '../src/schema.ts';
import { db } from './pglite.ts';

const { setGrantLevel } = await import('../src/office.ts');

const odd = (id: string, name: string, permission: 'read' | 'draft' | 'act') => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission,
  desk: `You are ${name}.`
});
await db
  .insert(staff)
  .values([odd('ada', 'Ada', 'act'), odd('bo', 'Bo', 'read'), odd('cy', 'Cy', 'draft')]);
await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, 'gmail'));
await db.insert(grants).values([
  { staffId: 'ada', connectorId: 'gmail', level: 'read' },
  { staffId: 'bo', connectorId: 'gmail', level: 'read' },
  { staffId: 'cy', connectorId: 'gmail', level: 'read' }
]);
const levelOf = async (who: string) =>
  (
    await db
      .select()
      .from(grants)
      .where(and(eq(grants.staffId, who), eq(grants.connectorId, 'gmail')))
  )[0]?.level;

test('read to write and back, in place, with one Ledger line each and nothing on the desk', async () => {
  const connectedAt = (await db.select().from(connectors).where(eq(connectors.id, 'gmail')))[0]
    .readyAt;
  await setGrantLevel('ada', 'gmail', 'act');
  assert.equal(await levelOf('ada'), 'act');
  await setGrantLevel('ada', 'gmail', 'act');
  await setGrantLevel('ada', 'gmail', 'read');
  assert.equal(await levelOf('ada'), 'read');
  const lines = (await db.select().from(ledger)).map((l) => l.title);
  assert.deepEqual(
    lines.filter((t) => t.startsWith('Ada now has')),
    ['Ada now has Gmail to read and write', 'Ada now has Gmail to read only']
  );
  assert.equal((await db.select().from(tasks)).length, 0, 'no steps, no sign-in again');
  const after = (await db.select().from(connectors).where(eq(connectors.id, 'gmail')))[0];
  assert.deepEqual(after.readyAt, connectedAt, 'still connected');
});

test('write needs the Draft level or higher', async () => {
  await assert.rejects(() => setGrantLevel('bo', 'gmail', 'act'), /holds read/);
  assert.equal(await levelOf('bo'), 'read');
  await setGrantLevel('cy', 'gmail', 'act');
  assert.equal(await levelOf('cy'), 'act', 'at Draft, each change then waits for the yes');
});
