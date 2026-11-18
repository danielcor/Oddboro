// A changed Claude Code agent file loaded on an Odd the owner already has:
// Save keeps its instructions, then asks for its servers at read as a hire
// does, never for one the Odd holds or asked for, and never for the Office
// Manager. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { L, odd, refusal, request } from './office-under-test.ts';

await L.pg`insert into staff ${L.pg([odd('ivo', 'Ivo')])}`;

const ROUTE = '/api/staff/[id]/description';
const desk = async (id: string) => (await L.staffer(id))!.desk;
const save = async (id: string, text: string, servers: unknown, was?: string) =>
  request(ROUTE, 'PUT', {
    params: { id },
    body: { text, was: was ?? (await desk(id)), servers }
  });
const preview = async (id: string, servers: unknown) =>
  (await (await request(ROUTE, 'POST', { params: { id }, body: { servers } })).json()) as {
    asks: { name: string }[];
    listed: { name: string; why: string }[];
  };
const openAccess = async (id: string) =>
  (await L.asksFor(id))
    .filter((a) => a.kind === 'access' && a.status === 'open')
    .map((a) => [a.access?.connector, a.access?.level, a.title])
    .sort();

const FILE = [
  { name: 'notes', url: 'https://mcp.notes.dev/mcp' },
  { name: 'files', command: 'npx' },
  { name: 'mystery' }
];

test('saving a changed file asks for its https server at read, after the save, and never for a command or an unknown name', async () => {
  assert.deepEqual(await preview('ivo', FILE), {
    asks: [{ name: 'notes', connector: 'https://mcp.notes.dev/mcp', label: 'mcp.notes.dev' }],
    listed: [
      { name: 'files', why: 'runs a command here' },
      { name: 'mystery', why: 'not one of the office tools' }
    ]
  });
  const before = await L.grantsFor('ivo');
  assert.equal((await save('ivo', 'You are Ivo, from a file.', FILE)).status, 200);
  assert.equal(await desk('ivo'), 'You are Ivo, from a file.');
  assert.ok(
    (
      await L.pg`select 1 from ledger where title = 'Edited Ivo''s job description' and actor = 'owner'`
    ).length === 1,
    'the owner made the save'
  );
  assert.deepEqual(await openAccess('ivo'), [
    ['mcp-notes-dev-mcp', 'read', 'Connect notes.dev (read)']
  ]);
  // Nothing connects until the owner says yes.
  assert.deepEqual(await L.grantsFor('ivo'), before);
});

test('the same file again asks nothing twice, and a new server or one already held is sorted for this Odd', async () => {
  const held = (await L.ensureConnector('https://mcp.held.dev/mcp')).connector!;
  await L.pg`insert into grants (staff_id, connector_id, level) values ('ivo', ${held.id}, 'read')`;
  const next = [
    ...FILE,
    { name: 'held', url: 'https://mcp.held.dev/mcp' },
    { name: 'wiki', url: 'https://mcp.wiki.dev/mcp' }
  ];
  assert.deepEqual(
    (await preview('ivo', next)).asks.map((a) => a.name),
    ['wiki']
  );
  assert.equal((await save('ivo', 'You are Ivo, from the file again.', next)).status, 200);
  assert.deepEqual(await openAccess('ivo'), [
    ['mcp-notes-dev-mcp', 'read', 'Connect notes.dev (read)'],
    ['mcp-wiki-dev-mcp', 'read', 'Connect wiki.dev (read)']
  ]);
});

test('a save refused as stale keeps the text and asks for nothing', async () => {
  const asked = await openAccess('ivo');
  const kept = await desk('ivo');
  const r = await refusal(
    save('ivo', 'You are Ivo, stale.', [{ name: 'late', url: 'https://mcp.late.dev/mcp' }], 'old')
  );
  assert.equal(r.status, 409);
  assert.equal(await desk('ivo'), kept);
  assert.deepEqual(await openAccess('ivo'), asked);
});

test("the Office Manager takes no agent file's servers", async () => {
  const manager = await L.hireManager({ preset: L.MANAGERS[0].id });
  const r = await refusal(
    request(ROUTE, 'POST', { params: { id: manager.id }, body: { servers: FILE } })
  );
  assert.equal(r.status, 400);
  assert.equal((await save(manager.id, 'You run the floor, edited.', FILE)).status, 200);
  assert.deepEqual(await openAccess(manager.id), []);
});
