// Gmail filters an Odd proposes (`propose_filter`). The tool server
// (src/mcp.ts) runs in a process of its own, as the office starts one for
// each run, over the office's own database. It holds: propose_filter is
// offered only to an Odd that holds Gmail at any level, whatever tools it was
// hired with; each call raises one `filter` ask, refused when it matches no
// mail or does nothing; a second filter for the same mail is refused naming
// the open one, even from two runs at once, and so is one the owner already
// created; and only the office's Create filter approves one, with one ledger
// line. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db, sql, toolServer } from './tool-server.ts';

const { connectors, grants, staff } = await import('../src/schema.ts');
const { eq } = await import('drizzle-orm');
const { STARTER_TOOLS } = await import('../src/tools.ts');
const { approveFilter, ask, decideAsk } = await import('../src/office.ts');

const odd = (id: string, name: string, tools = STARTER_TOOLS) => ({
  id,
  name,
  role: 'Mail clerk',
  remit: 'Mail.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`,
  tools
});
await db.insert(staff).values([
  odd('paige', 'Paige'),
  odd('nora', 'Nora'),
  // Hired from a proposal that listed only some office tools.
  odd('tess', 'Tess', ['search_ledger'])
]);
await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, 'gmail'));
await db.insert(grants).values([
  { staffId: 'paige', connectorId: 'gmail', level: 'read' },
  { staffId: 'tess', connectorId: 'gmail', level: 'act' },
  { staffId: 'nora', connectorId: 'google-drive', level: 'read' }
]);

const offered = async (c: Client) =>
  (await c.listTools()).tools.find((t) => t.name === 'propose_filter');
const said = (r: Awaited<ReturnType<Client['callTool']>>) =>
  (r.content as { type: string; text: string }[])[0]?.text ?? '';
const FILTER = {
  from: 'news@shop.example.com',
  skip_inbox: true,
  add_label: 'Newsletters',
  summary: 'The shop sends a newsletter every day.',
  why: 'You never open them.'
};
/** The id in "Filter 12 is on ...". */
const idOf = (text: string) => Number(/^Filter (\d+) /.exec(text)?.[1]);

test(
  'propose_filter is offered to every Odd that holds Gmail, at any level, whatever tools it was hired with',
  // Three tool servers, which cannot be one: each reads its Odd from STAFF_ID
  // as it starts and offers only that Odd's tools. Three starts in a row hit
  // the package's 15 s limit on a loaded machine, so each gets that limit.
  { timeout: 45_000 },
  async () => {
    const t = await offered(await toolServer('paige', { RUN_KEY: 'k-paige' }));
    assert.ok(t, 'Paige reads Gmail and holds the tool');
    for (const words of [
      'One filter per call',
      'Call list_filters first',
      'what mail it matches and what it does',
      'Nothing changes in Gmail until',
      'never deletes or forwards'
    ])
      assert.ok(t.description?.includes(words), words);
    assert.equal(await offered(await toolServer('nora', { RUN_KEY: 'k-nora' })), undefined);
    assert.ok(
      await offered(await toolServer('tess', { RUN_KEY: 'k-tess' })),
      'a hire list cannot leave it out'
    );
  }
);

test('each call raises one filter ask in plain words, and one that matches nothing or does nothing is refused', async () => {
  const c = await toolServer('paige', { RUN_KEY: 'k-one' });
  const r = await c.callTool({ name: 'propose_filter', arguments: FILTER });
  assert.notEqual(r.isError, true, said(r));
  assert.match(said(r), /Nothing changes in Gmail until they create it/);
  const a = await ask(idOf(said(r)));
  assert.equal(a?.kind, 'filter');
  assert.equal(
    a?.title,
    'Gmail filter: mail from news@shop.example.com will skip the inbox and get the label "Newsletters"'
  );
  assert.deepEqual(a?.filter, {
    criteria: { from: 'news@shop.example.com' },
    action: { skipInbox: true, addLabel: 'Newsletters' },
    summary: 'The shop sends a newsletter every day.',
    connector: 'gmail'
  });
  const none = await c.callTool({
    name: 'propose_filter',
    arguments: { ...FILTER, from: '  ', subject: 'Weekly' }
  });
  assert.notEqual(none.isError, true, 'a blank field is left out, the rest stands');
  const matchesAll = await c.callTool({
    name: 'propose_filter',
    arguments: { skip_inbox: true, summary: 's', why: 'w' }
  });
  assert.equal(matchesAll.isError, true);
  assert.match(said(matchesAll), /Say which mail it matches/);
  const doesNothing = await c.callTool({
    name: 'propose_filter',
    arguments: { from: 'a@example.com', summary: 's', why: 'w' }
  });
  assert.equal(doesNothing.isError, true);
  assert.match(said(doesNothing), /Say what it does/);
  const trash = await c.callTool({
    name: 'propose_filter',
    arguments: { ...FILTER, from: 'b@example.com', trash: true }
  });
  assert.equal(trash.isError, true, 'no trash, delete or forward');
});

test('a second filter for the same mail is refused naming the open one; revises replaces it; and a created one closes it', async () => {
  const c = await toolServer('paige', { RUN_KEY: 'k-twice' });
  const mail = { ...FILTER, from: 'deals@store.example.com' };
  const first = idOf(said(await c.callTool({ name: 'propose_filter', arguments: mail })));
  // The same mail, written another way, is the same filter.
  const again = await c.callTool({
    name: 'propose_filter',
    arguments: { ...mail, from: ' Deals@Store.example.com ', mark_read: true }
  });
  assert.equal(again.isError, true, said(again));
  assert.equal(
    said(again),
    `Nothing went on the owner's desk. Your filter #${first} for this mail is already there. To change it, call propose_filter again with revises: ${first}.`
  );
  const revised = await c.callTool({
    name: 'propose_filter',
    arguments: { ...mail, star: true, revises: first }
  });
  assert.notEqual(revised.isError, true, said(revised));
  const second = idOf(said(revised));
  assert.equal((await ask(first))?.status, 'revise');
  await assert.rejects(decideAsk(second, 'approve', null), /Create the filter/);
  const a = (await ask(second))!;
  const made = {
    ...a.filter!,
    action: { skipInbox: true, addLabel: 'Deals' },
    matching: 40,
    created: { at: '2026-11-07T10:00:00.000Z', gmailId: 'f1', tidied: 40 }
  };
  assert.equal(await approveFilter(second, made), true);
  assert.deepEqual((await ask(second))?.filter, made, "the owner's version is kept");
  const lines = await sql<{ title: string }[]>`select title from ledger where ask_id = ${second}`;
  assert.deepEqual(
    lines.map((l) => l.title),
    [
      'Created a Gmail filter: mail from deals@store.example.com will skip the inbox and get the label "Deals", and tidied 40 emails'
    ]
  );
  assert.deepEqual(
    [...(await sql`select kind from follow_ups where ask_id = ${second}`)],
    [{ kind: 'answered' }],
    'no run carries a filter out: the Odd, on no work, hears it was made, once'
  );
  const late = await c.callTool({ name: 'propose_filter', arguments: mail });
  assert.equal(late.isError, true, said(late));
  assert.equal(
    said(late),
    `Nothing went on the owner's desk. That filter already exists: your filter #${second} was created in Gmail. Do not propose it again.`
  );
});

test('two runs proposing a filter for the same mail at once leave one on the desk', async () => {
  const [one, two] = await Promise.all([
    toolServer('paige', { RUN_KEY: 'k-race-1' }),
    toolServer('paige', { RUN_KEY: 'k-race-2' })
  ]);
  const mail = { ...FILTER, from: 'race@example.com' };
  const results = await Promise.all(
    [one, two, one, two].map((c) => c.callTool({ name: 'propose_filter', arguments: mail }))
  );
  assert.equal(results.filter((r) => r.isError !== true).length, 1, results.map(said).join('\n'));
  const rows = await sql`
    select id from asks where staff_id = 'paige' and filter->'criteria'->>'from' = 'race@example.com'`;
  assert.equal(rows.length, 1);
});
