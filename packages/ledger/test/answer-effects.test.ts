// What the owner hears when what their yes asked for fails once the yes is
// saved: a grant, an Odd leaving or coming back, a job's missed runs. The
// error reaches them, as the Desk shows a refusal, and the ask stays
// answered. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { asks, connectors, grants, jobs, staff, tasks, threads } from '../src/schema.ts';
import type { Tx } from '../src/threads.ts';
import { db } from './pglite.ts';

const { decideAsk, giveTask, grantAccess, raiseAsk } = await import('../src/office.ts');
const { POSTAL_ID } = await import('../src/access-words.ts');
const { BUILT_IN } = await import('../src/registry.ts');
// The office's own handle, which is PGlite's here.
const { db: officeDb } = await import('../src/db.ts');

const hireOdd = (id: string, o: { permission?: 'read' | 'act'; left?: true } = {}) =>
  db.insert(staff).values({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    role: 'Clerk',
    remit: 'Tests.',
    variant: 'a',
    portrait: 'a',
    permission: o.permission ?? 'act',
    desk: `You are ${id}.`,
    ...(o.left && { leftAt: new Date() })
  });
await hireOdd('paige');
await db.insert(connectors).values(BUILT_IN.filter((c) => c.id === POSTAL_ID));

afterEach(() => mock.restoreAll());

const statusOf = async (id: number) =>
  (await db.select({ status: asks.status }).from(asks).where(eq(asks.id, id)))[0].status;

/** Each transaction the office starts once the ask is answered throws `message`. */
function failOnceAnswered(askId: number, message: string): void {
  const own = officeDb.transaction.bind(officeDb);
  mock.method(officeDb, 'transaction', async (...args: Parameters<typeof officeDb.transaction>) => {
    if ((await statusOf(askId)) !== 'open') throw new Error(message);
    return own(...args);
  });
}

/**
 * Work parks on `taskId` as the transaction that ends it locks its tasks, as
 * a park from another transaction would land: the loader refuses the end.
 */
function parkAsItEnds(taskId: number, threadId: number): void {
  const own = officeDb.transaction.bind(officeDb);
  mock.method(officeDb, 'transaction', (fn: (tx: Tx) => Promise<unknown>, ...rest: []) =>
    own(
      async (tx) => {
        const execute = tx.execute.bind(tx);
        mock.method(tx, 'execute', async (query: SQL) => {
          const { sql, params } = new PgDialect().sqlToQuery(query);
          if (/from "tasks" .* for update$/.test(sql) && params.includes(taskId))
            await tx.update(threads).set({ resumeOnTask: taskId }).where(eq(threads.id, threadId));
          return execute(query);
        });
        return fn(tx);
      },
      ...rest
    )
  );
}

const access = async (id: string, connector: string, level: 'read' | 'act') =>
  (
    await raiseAsk(id, {
      title: `Connect ${connector} (${level})`,
      why: 'w',
      ifApproved: 'i',
      access: { connector, level }
    })
  ).ask.id;

/** A failing yes: the ask it raises, made ready to fail, and what the owner is told. */
const FAILING: { name: string; raise: () => Promise<number>; told: string }[] = [
  {
    name: 'a grant to an Odd whose level the owner lowered while the ask waited',
    raise: async () => {
      const id = await access('paige', 'gmail', 'act');
      await db.update(staff).set({ permission: 'read' }).where(eq(staff.id, 'paige'));
      return id;
    },
    told: 'Paige holds read, so it cannot be given act'
  },
  {
    name: "a second Odd's physical mail grant before the office's mailbox is chosen",
    raise: async () => {
      await hireOdd('ana');
      await hireOdd('ben');
      await grantAccess('ana', { connector: POSTAL_ID, level: 'read' });
      return access('ben', POSTAL_ID, 'read');
    },
    told: 'Choose the office mailbox before granting another Odd access.'
  },
  {
    name: 'letting an Odd go while work parks on a task it gave',
    raise: async () => {
      await hireOdd('cy');
      const given = await giveTask('cy', { title: 'Sign the form', why: 'w', steps: ['Sign'] });
      const [led] = await db
        .insert(threads)
        .values({ title: 'Other work', hubId: 'paige', holderId: 'paige' })
        .returning({ id: threads.id });
      const id = (
        await raiseAsk('paige', {
          kind: 'remove',
          odd: 'cy',
          title: 'Let Cy go',
          why: 'w',
          ifApproved: 'i'
        })
      ).ask.id;
      parkAsItEnds(given.id, led.id);
      return id;
    },
    told: 'Work was parked on the task as it ended. Try again in a moment.'
  },
  {
    name: 'bringing an Odd back',
    raise: async () => {
      await hireOdd('dee', { left: true });
      const id = (
        await raiseAsk('paige', {
          kind: 'bring_back',
          odd: 'dee',
          title: 'Bring Dee back',
          why: 'w',
          ifApproved: 'i'
        })
      ).ask.id;
      failOnceAnswered(id, 'The office could not bring Dee back.');
      return id;
    },
    told: 'The office could not bring Dee back.'
  },
  {
    name: "owing a job's missed runs",
    raise: async () => {
      const [j] = await db
        .insert(jobs)
        .values({
          staffId: 'paige',
          name: 'Count the cakes',
          instructions: 'Count them.',
          schedule: { every: 'day', at: '09:00' },
          missed: 'record'
        })
        .returning({ id: jobs.id });
      // The office's own ask, as askToCatchUp raises it.
      const [a] = await db
        .insert(asks)
        .values({
          staffId: 'paige',
          kind: 'catch_up',
          title: 'Fill 1 missed period?',
          why: 'w',
          ifApproved: 'i',
          catchUp: { jobId: j.id, times: ['2026-11-01T14:00:00.000Z'] }
        })
        .returning({ id: asks.id });
      failOnceAnswered(a.id, 'The office could not owe the missed run.');
      return a.id;
    },
    told: 'The office could not owe the missed run.'
  }
];

test('a yes whose work fails once it is saved tells the owner why, and the ask stays approved', async () => {
  for (const { name, raise, told } of FAILING) {
    const id = await raise();
    const logged = mock.method(console, 'error', () => {});
    await assert.rejects(decideAsk(id, 'approve', null), { message: told }, name);
    mock.restoreAll();
    assert.equal(logged.mock.callCount(), 0, `${name}: the failure was only logged`);
    assert.equal(await statusOf(id), 'approved', name);
  }
});

test('a yes whose grant goes through answers ok, and leaves the connect task on the desk', async () => {
  await hireOdd('eve');
  const id = await access('eve', 'gmail', 'read');
  assert.equal(await decideAsk(id, 'approve', null), true);
  assert.equal(await statusOf(id), 'approved');
  const given = await db.select().from(tasks).where(eq(tasks.askId, id));
  assert.deepEqual(
    given.map((t) => [t.title, t.status]),
    [['Connect Gmail for Eve', 'open']]
  );
});

test('a grant to an Odd that left after the yes opens no connect task, and the owner hears it left', async () => {
  await hireOdd('fay');
  // Fay is the only Odd given physical mail, so her grant needs no mailbox chosen first.
  await db.delete(grants).where(eq(grants.connectorId, POSTAL_ID));
  const id = await access('fay', POSTAL_ID, 'read');
  // Fay leaves as the grant is saved, after the grant found her still working.
  const own = officeDb.transaction.bind(officeDb);
  let left = false;
  mock.method(officeDb, 'transaction', async (...args: Parameters<typeof officeDb.transaction>) => {
    if (!left && (await statusOf(id)) === 'approved') {
      left = true;
      await db.update(staff).set({ leftAt: new Date() }).where(eq(staff.id, 'fay'));
    }
    return own(...args);
  });
  await assert.rejects(decideAsk(id, 'approve', null), {
    message: 'Fay left the office, so there is nothing to connect.'
  });
  assert.ok(left, 'Fay never left');
  assert.equal(await statusOf(id), 'approved');
  assert.deepEqual(await db.select().from(tasks).where(eq(tasks.staffId, 'fay')), []);
});
