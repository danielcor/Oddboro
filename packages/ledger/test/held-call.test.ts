// An Odd at Draft calls a tool that changes something, and the gateway holds
// the call as a `call` ask on the owner's desk. The same call held twice at
// once, as two of the Odd's tool calls in one turn can be, goes on the desk
// once: the second hears the one there. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { asks, ledger, staff } from '../src/schema.ts';
import { db } from './pglite.ts';

const { approveCall, raiseCall } = await import('../src/office.ts');

await db.insert(staff).values({
  id: 'paige',
  name: 'Paige',
  role: 'Mail clerk',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft',
  desk: 'You are Paige.'
});

test('the same call held twice at once goes on the desk once, and the second hears the one there', async () => {
  const hold = () =>
    raiseCall(
      { staffId: 'paige', run: 'k-1' },
      { connector: 'gmail', tool: 'archive', arguments: { ids: ['m1', 'm2'] } },
      'Gmail',
      { title: 'Archive two emails', why: 'They are read.' }
    );
  const both = await Promise.all([hold(), hold()]);
  const open = await db
    .select()
    .from(asks)
    .where(and(eq(asks.staffId, 'paige'), eq(asks.kind, 'call'), eq(asks.status, 'open')));
  assert.equal(open.length, 1, 'one call ask on the desk');
  assert.deepEqual(both.map((r) => r.already).sort(), [false, true]);
  assert.deepEqual(
    both.map((r) => r.ask.id),
    [open[0].id, open[0].id]
  );
});

test('a yes to a held call keeps what the call returned on the ask, and its ledger line names it', async () => {
  const { ask } = await raiseCall(
    { staffId: 'paige', run: 'k-2' },
    { connector: 'gmail', tool: 'label', arguments: { ids: ['m3'] } },
    'Gmail',
    { title: 'Label an email', why: 'It is a bill.' }
  );
  const at = new Date().toISOString();
  assert.ok(
    await approveCall(ask.id, { ...ask.call!, result: { ok: true, text: 'Labelled m3.', at } })
  );
  const [kept] = await db.select().from(asks).where(eq(asks.id, ask.id));
  assert.equal(kept.call?.result?.text, 'Labelled m3.');
  const [line] = await db
    .select()
    .from(ledger)
    .where(and(eq(ledger.askId, ask.id), eq(ledger.kind, 'decision')));
  assert.match(line.title, /^Made: /);
  assert.match(line.body ?? '', /It returned: Labelled m3\./);
});
