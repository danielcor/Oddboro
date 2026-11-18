// A hand-off line reads as waiting on the owner only while the desk holds
// something of it: the office's own code on every migration, in an in-memory
// PGlite that stands in for db.ts (pglite.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { asks, followUps, staff, tasks } from '../src/schema.ts';
import { db } from './pglite.ts';

const H = await import('../src/hand-offs.ts');
const O = await import('../src/office.ts');

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
await db.insert(staff).values([odd('lead', 'Lena'), odd('paige', 'Paige')]);

type Row = typeof followUps.$inferSelect;
const byId = async (id: number): Promise<Row> =>
  (await db.select().from(followUps).where(eq(followUps.id, id)))[0];
async function runs(f: Row, outcome: 'done' | 'waiting', text: string) {
  assert.ok(await O.startFollowUp(f.id), `follow-up ${f.id} could not start`);
  await O.finishFollowUp(f, f.handOff?.title ?? 'work', outcome, text);
}
const openOnDesk = async () =>
  (await db.select().from(asks).where(eq(asks.status, 'open'))).length +
  (await db.select().from(tasks).where(eq(tasks.status, 'open'))).length;

test('a colleague step that ended waiting with nothing of it on the desk reads as done, not waiting on the owner', async () => {
  const r = await H.handOff({
    from: 'lead',
    to: 'paige',
    work: { title: 'Book the venue', brief: 'Book it.' },
    thread: { title: 'The party' }
  });
  assert.ok('id' in r);
  const h = await byId(r.id);
  // Paige ends waiting but put nothing on the desk.
  await runs(h, 'waiting', 'Waiting.');
  const [back] = await db.select().from(followUps).where(eq(followUps.kind, 'handed_back'));
  assert.ok(back, 'the waiting result goes back to the lead');
  await runs(back, 'done', 'Moved on.');
  assert.equal(await openOnDesk(), 0, 'nothing is on the desk');
  const [line] = (await H.handOffsFor('lead')).filter((l) => l.id === h.id);
  assert.equal(line.status, 'done', 'the line reads waiting on the owner with nothing on the desk');
});
