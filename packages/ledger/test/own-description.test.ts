// An Odd rewrites its own job description with `edit_my_description`. A save
// from the text its run began with stops if the owner saved a newer one since,
// so the Odd never overwrites the owner's edit. The tool runs in the tool
// server's own process, as the office starts one for each run. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db, sql, toolServer } from './tool-server.ts';

const { staff } = await import('../src/schema.ts');
const { setDescription, staffer } = await import('../src/office.ts');

const START = 'You are Wren. You sort the mail.';
const chat = { OWNER_SAID: 'Wren, add that you file receipts too.' };

beforeEach(async () => {
  await sql`delete from ledger`;
  await sql`delete from staff`;
  await db.insert(staff).values({
    id: 'wren',
    name: 'Wren',
    role: 'Mail Clerk',
    remit: 'Tests.',
    variant: 'a',
    portrait: 'a',
    tools: ['edit_my_description'],
    desk: START
  });
});

async function edit(c: Client, description: string) {
  const r = await c.callTool({ name: 'edit_my_description', arguments: { description } });
  return { text: (r.content as { text: string }[])[0]?.text ?? '', error: r.isError === true };
}
const desk = async () => (await staffer('wren'))!.desk;

test("an Odd's edit after the owner saved a newer text is refused, and the owner's text stays", async () => {
  const c = await toolServer('wren', { RUN_KEY: 'k-1', ...chat });
  const owners = 'You are Wren. You sort the mail and keep the post room tidy.';
  await setDescription('wren', owners, { owner: true, was: START });

  const r = await edit(c, `${START} You file receipts too.`);
  assert.equal(r.error, true, r.text);
  assert.match(r.text, /changed since this run began/);
  assert.ok(r.text.includes(owners), r.text);
  assert.equal(await desk(), owners);
  const kept = await sql`select title from ledger where title = 'Rewrote its job description'`;
  assert.equal(kept.length, 0);

  // The retry on the text it was shown goes through.
  const retry = `${owners} You file receipts too.`;
  const again = await edit(c, retry);
  assert.equal(again.error, false, again.text);
  assert.match(again.text, /is changed/);
  assert.equal(await desk(), retry);
});

test('two edits by the Odd in one run both go through', async () => {
  const c = await toolServer('wren', { RUN_KEY: 'k-2', ...chat });
  const first = `${START} You file receipts too.`;
  const second = `${first} You answer the phone.`;
  assert.equal((await edit(c, first)).error, false);
  assert.equal(await desk(), first);
  const r = await edit(c, second);
  assert.equal(r.error, false, r.text);
  assert.equal(await desk(), second);
});
