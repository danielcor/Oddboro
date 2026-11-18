// What an Odd put on the owner's desk, as its chat lists it: the office's own
// code on every migration, in an in-memory PGlite that stands in for db.ts
// (pglite.ts). Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staff } from '../src/schema.ts';
import { db } from './pglite.ts';

const { decideAsk, deliveries, finishTask, giveTask, raiseAsk } = await import('../src/office.ts');

await db.insert(staff).values({
  id: 'cole',
  name: 'Cole',
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft',
  desk: 'You are Cole.'
});

test('each ask says when the owner decided it, so a resumed chat hears of decisions since', async () => {
  const open = await raiseAsk('cole', { title: 'Book the band', why: 'w', ifApproved: 'i' });
  const decided = await raiseAsk('cole', { title: 'Book the hall', why: 'w', ifApproved: 'i' });
  await decideAsk(decided.ask.id, 'approve', null);
  const asks = (await deliveries('cole')).filter((d) => d.kind === 'ask');
  const at = (id: number) => asks.find((d) => d.id === id)?.decidedAt;
  assert.ok(at(decided.ask.id) instanceof Date, 'a decided ask lost when it was decided');
  assert.equal(at(open.ask.id), null);
});

test('each finished task says when it was finished, so a resumed chat hears of it', async () => {
  const open = await giveTask('cole', { title: 'Sign the form', why: 'w', steps: ['Sign'] });
  const done = await giveTask('cole', { title: 'Post the form', why: 'w', steps: ['Post'] });
  await finishTask(done.id, true, null);
  const tasks = (await deliveries('cole')).filter((d) => d.kind === 'task');
  const at = (id: number) => tasks.find((d) => d.id === id)?.decidedAt;
  assert.ok(at(done.id) instanceof Date, 'a finished task lost when it was finished');
  assert.equal(at(open.id), null);
});
