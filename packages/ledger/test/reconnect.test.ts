// A reconnect puts the Odd's steps for a new key on the desk only when the
// tool takes a key. A tool that signs in has no key box, so key steps there
// would send the owner looking for one that is not there. The office's own
// code on every migration, in an in-memory PGlite that stands in for db.ts
// (pglite.ts). Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { connectors, staff, tasks, threads } from '../src/schema.ts';
import { db, sql } from './pglite.ts';

const { finishTask, grantAccess, reconnectTask, revoke } = await import('../src/office.ts');
const { parkOnTask } = await import('../src/task-parking.ts');

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
const ready = { tools: ['search'], readTools: ['search'], readyAt: new Date() };
await db.insert(connectors).values([
  {
    id: 'brain',
    name: 'Brain',
    description: 'A hosted memory that takes a key.',
    kind: 'http',
    config: { url: 'https://brain.example/mcp', headers: ['x-brain-key'] },
    ...ready
  },
  {
    id: 'notes',
    name: 'Notes',
    description: 'A hosted notes app that signs in.',
    kind: 'http',
    config: { url: 'https://notes.example/mcp', oauth: true },
    ...ready
  }
]);
for (const connector of ['brain', 'notes']) await grantAccess('cole', { connector, level: 'read' });

const GET_KEY = ['Open your credential tracker.', 'Copy the MCP Access Key.'];

test('a tool that takes a key gets the key steps, then its key box', async () => {
  const r = await reconnectTask('cole', 'brain', 'It turns down the key.', GET_KEY);
  assert.ok('task' in r);
  assert.equal(r.keptOut, false);
  const texts = r.task.steps.map((s) => s.text);
  assert.deepEqual(texts.slice(0, 2), GET_KEY);
  assert.ok(r.task.steps.some((s) => s.action?.kind === 'secret'));
});

test('a tool that signs in leaves the key steps out, and says so', async () => {
  const r = await reconnectTask('cole', 'notes', 'The sign-in ran out.', GET_KEY);
  assert.ok('task' in r);
  assert.equal(r.keptOut, true);
  const texts = r.task.steps.map((s) => s.text);
  for (const step of GET_KEY) assert.ok(!texts.includes(step));
  assert.ok(!r.task.steps.some((s) => s.action?.kind === 'secret'));
  assert.ok(r.task.steps.some((s) => s.action?.kind === 'oauth'));
});

/** The open tasks with a step that connects this tool. */
const openConnecting = async (connector: string) =>
  (await db.select().from(tasks).where(eq(tasks.status, 'open'))).filter((t) =>
    t.steps.some((s) => s.action && 'connector' in s.action && s.action.connector === connector)
  );

/**
 * A tool that takes nothing from the secret store and is not connected yet,
 * so a grant gives a connect task and a revoke of its last grant removes no
 * secret from this computer's store.
 */
async function aTool(id: string): Promise<void> {
  await db.insert(connectors).values({
    id,
    name: id,
    description: 'A local tool not connected yet.',
    kind: 'stdio',
    config: {}
  });
}

test('two reconnects for the same tool at once give one open task', async () => {
  await db.insert(connectors).values({
    id: 'vault',
    name: 'Vault',
    description: 'A hosted vault that takes a key.',
    kind: 'http',
    config: { url: 'https://vault.example/mcp', headers: ['x-vault-key'] },
    ...ready
  });
  await grantAccess('cole', { connector: 'vault', level: 'read' });
  assert.deepEqual(await openConnecting('vault'), [], 'a connected tool starts with no task');
  const both = await Promise.all([
    reconnectTask('cole', 'vault', 'It turns down the key.', GET_KEY),
    reconnectTask('cole', 'vault', 'It turns down the key.', GET_KEY)
  ]);
  const open = await openConnecting('vault');
  assert.equal(open.length, 1);
  const got = both.map((r) => {
    assert.ok('task' in r);
    return { id: r.task.id, already: r.already };
  });
  assert.deepEqual(
    got.map((r) => r.id),
    [open[0].id, open[0].id]
  );
  assert.deepEqual(got.map((r) => r.already).sort(), [false, true]);
});

test("dropping a connector's tasks never turns a task the owner finished into dropped, and each dropped task gets the drop's own time", async () => {
  await aTool('pad');
  // Each round lets the owner's Done start a few more promise turns later,
  // so some round lands it between a drop reading the open tasks and
  // writing them (measured: round 11 does, against a drop outside a
  // transaction). One drop in one transaction is safe at every turn.
  for (let round = 0; round < 20; round++) {
    await grantAccess('cole', { connector: 'pad', level: 'read' });
    // A second grant, as a second Give on the Settings tab makes, puts a
    // second connect task on the desk, which the owner leaves alone.
    await grantAccess('cole', { connector: 'pad', level: 'read' });
    const mine = await openConnecting('pad');
    assert.equal(mine.length, 2, `round ${round}`);
    const [finished, left] = mine;
    const before = new Date();
    const [, done] = await Promise.all([
      revoke('cole', 'pad'),
      (async () => {
        for (let i = 0; i < round * 4; i++) await Promise.resolve();
        return finishTask(finished.id, true, null);
      })()
    ]);
    const rows = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [finished.id, left.id]));
    const status = Object.fromEntries(rows.map((t) => [t.id, t.status]));
    if (done) assert.equal(status[finished.id], 'done', `round ${round}`);
    const dropped = rows.filter((t) => t.status === 'dropped');
    assert.ok(
      dropped.some((t) => t.id === left.id),
      `round ${round}: the task left alone drops`
    );
    for (const t of dropped)
      assert.ok(
        t.doneAt !== null && t.doneAt.getTime() >= before.getTime(),
        `round ${round}: task ${t.id} dropped at ${t.doneAt?.toISOString()}`
      );
  }
});

test('a connector drop whose wake fails drops nothing, and leaves the work parked on an open task', async () => {
  await aTool('slate');
  await grantAccess('cole', { connector: 'slate', level: 'read' });
  const [k] = await openConnecting('slate');
  assert.ok(k);
  const [work] = await db
    .insert(threads)
    .values({ title: 'Sort the slate', hubId: 'cole', holderId: 'cole' })
    .returning({ id: threads.id });
  const parked = await parkOnTask('cole', work.id, k.id);
  assert.ok('title' in parked, JSON.stringify(parked));
  // The wake fails: any write that lifts a park on a task.
  await sql`create function fail_wake() returns trigger language plpgsql as $$ begin raise exception 'the wake failed'; end $$`;
  await sql`create trigger fail_wake before update of resume_on_task on threads for each row when (old.resume_on_task is not null and new.resume_on_task is null) execute function fail_wake()`;
  try {
    // The database's words come back as the query error's cause.
    await assert.rejects(revoke('cole', 'slate'), (err: Error) =>
      /the wake failed/.test(String(err.cause ?? err))
    );
  } finally {
    await sql`drop trigger fail_wake on threads`;
    await sql`drop function fail_wake()`;
  }
  const [task] = await db.select().from(tasks).where(eq(tasks.id, k.id));
  assert.equal(task.status, 'open', 'the drop rolled back with its wake');
  const stillParked = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, work.id), eq(threads.resumeOnTask, k.id)));
  assert.equal(stillParked.length, 1);
});
