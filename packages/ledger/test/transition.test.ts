// The transition shell: load, decide and apply in one transaction, with
// after-effects only after the commit. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ledger, staff } from '../src/schema.ts';
import type { Tx } from '../src/threads.ts';
import { db } from './pglite.ts';

const { LOCK_ORDER, lockRows, runAfters, transition } = await import('../src/transition.ts');
// The office's own handle, which is PGlite's here: a transaction opened on it
// has the type the shell takes from a caller.
const { db: officeDb } = await import('../src/db.ts');

await db.insert(staff).values({
  id: 'ada',
  name: 'Ada',
  role: 'r',
  variant: 'v',
  portrait: 'p',
  remit: 'r',
  desk: 'd',
  agent: 'claude'
});
const nameOf = async (): Promise<string> =>
  (await db.select({ name: staff.name }).from(staff).where(eq(staff.id, 'ada')))[0].name;

afterEach(async () => {
  mock.restoreAll();
  mock.timers.reset();
  await db.update(staff).set({ name: 'Ada' }).where(eq(staff.id, 'ada'));
});

/**
 * A transition that renames Ada, writing each step it reaches to `seen`, with
 * after-effects that write their names there too.
 */
function rename(seen: string[], to: string) {
  return {
    name: 'rename',
    load: async (tx: Tx) => {
      seen.push('load');
      return (await tx.select({ name: staff.name }).from(staff).where(eq(staff.id, 'ada')))[0];
    },
    decide: (work: { name: string }) => {
      seen.push(`decide ${work.name}`);
      return {
        change: to,
        after: ['first', 'second'].map((then) => ({ then, run: async () => seen.push(then) }))
      };
    },
    apply: async (tx: Tx, change: string) => {
      seen.push('apply');
      await tx.update(staff).set({ name: change }).where(eq(staff.id, 'ada'));
    }
  };
}

/** Writes 'commit' to `seen` once each of the shell's own transactions has committed. */
function markCommits(seen: string[]): void {
  const own = officeDb.transaction.bind(officeDb);
  mock.method(officeDb, 'transaction', async (...args: Parameters<typeof officeDb.transaction>) => {
    const out = await own(...args);
    seen.push('commit');
    return out;
  });
}

test('after-effects run only after the commit', async () => {
  const seen: string[] = [];
  markCommits(seen);
  const decided = await transition(rename(seen, 'Bea'));
  assert.deepEqual(seen, ['load', 'decide Ada', 'apply', 'commit', 'first', 'second']);
  assert.equal(await nameOf(), 'Bea');
  assert.ok('change' in decided);
  assert.equal(decided.change, 'Bea');
});

test("with the caller's tx, after-effects come back unrun and run only when the caller runs them after its commit", async () => {
  const seen: string[] = [];
  const decided = await officeDb.transaction(async (tx) => {
    const d = await transition(rename(seen, 'Cy'), { tx });
    seen.push('returned');
    return d;
  });
  seen.push('caller committed');
  assert.deepEqual(seen, ['load', 'decide Ada', 'apply', 'returned', 'caller committed']);
  assert.equal(await nameOf(), 'Cy');
  assert.ok('change' in decided);
  assert.deepEqual(
    decided.after.map((a) => ('then' in a ? a.then : 'record')),
    ['first', 'second']
  );
  await runAfters('rename', decided.after);
  assert.deepEqual(seen, [
    'load',
    'decide Ada',
    'apply',
    'returned',
    'caller committed',
    'first',
    'second'
  ]);
});

test("the caller's tx holds the transition's change, so its rollback takes it back", async () => {
  const seen: string[] = [];
  await assert.rejects(
    officeDb.transaction(async (tx) => {
      await transition(rename(seen, 'Dee'), { tx });
      throw new Error('the caller fails after the transition');
    }),
    /the caller fails/
  );
  assert.equal(await nameOf(), 'Ada');
  assert.deepEqual(seen, ['load', 'decide Ada', 'apply']);
});

/** Makes Postgres end the transaction with the error it gives a deadlock's loser. */
const deadlock = (tx: Tx) =>
  tx.execute(
    sql`do $$ begin raise exception 'deadlock detected' using errcode = 'deadlock_detected'; end $$`
  );

test('a transition Postgres ends to break a deadlock runs again from the load, and its after-effects run once, after the commit', async () => {
  const seen: string[] = [];
  markCommits(seen);
  const step = rename(seen, 'Ivy');
  let ended = false;
  const decided = await transition({
    ...step,
    apply: async (tx: Tx, change: string) => {
      await step.apply(tx, change);
      if (ended) return;
      ended = true;
      await deadlock(tx);
    }
  });
  // The second load reads Ada: the first attempt's rename rolled back.
  assert.deepEqual(seen, [
    'load',
    'decide Ada',
    'apply',
    'load',
    'decide Ada',
    'apply',
    'commit',
    'first',
    'second'
  ]);
  assert.equal(await nameOf(), 'Ivy');
  assert.ok('change' in decided);
});

test('a transition fails with its error after three deadlocks, or at once on any other error', async () => {
  const fails = async (end: (tx: Tx) => Promise<unknown>, error: RegExp) => {
    const seen: string[] = [];
    await assert.rejects(
      transition({
        ...rename(seen, 'Jo'),
        load: async (tx: Tx) => {
          seen.push('load');
          await end(tx);
          return { name: 'Ada' };
        }
      }),
      (err: Error) => error.test(String(err.cause))
    );
    return seen;
  };
  assert.deepEqual(await fails(deadlock, /deadlock detected/), ['load', 'load', 'load']);
  assert.deepEqual(await fails((tx) => tx.execute(sql`select 1 / 0`), /division by zero/), [
    'load'
  ]);
  assert.equal(await nameOf(), 'Ada');
});

test('a refusal writes nothing and runs no after-effect', async () => {
  const seen: string[] = [];
  const step = {
    ...rename(seen, 'Eve'),
    decide: () => ({ refused: 'Ada keeps her name.' })
  };
  const decided = await transition(step);
  assert.deepEqual(decided, { refused: 'Ada keeps her name.' });
  assert.deepEqual(seen, ['load']);
  assert.equal(await nameOf(), 'Ada');
});

test('a failing after-effect is reported by step and name, keeps the commit, and the later ones still run', async () => {
  const seen: string[] = [];
  const errors = mock.method(console, 'error', () => {});
  const failure = new Error('the mail server said no');
  const step = rename(seen, 'Fay');
  const decided = await transition({
    ...step,
    decide: (work: { name: string }) => {
      const d = step.decide(work);
      return {
        ...d,
        after: [
          d.after[0],
          {
            then: 'send',
            run: async () => {
              throw failure;
            }
          },
          d.after[1]
        ]
      };
    }
  });
  assert.ok('change' in decided);
  assert.deepEqual(seen, ['load', 'decide Ada', 'apply', 'first', 'second']);
  assert.equal(await nameOf(), 'Fay');
  assert.deepEqual(
    errors.mock.calls.map((c) => c.arguments),
    [['rename: the after-effect send failed:', failure]]
  );
});

test('a record after-effect writes its ledger line', async () => {
  const title = 'Renamed Ada to Gus';
  const lines = async () =>
    (await db.select({ title: ledger.title }).from(ledger).where(eq(ledger.title, title))).length;
  const decided = await transition({
    name: 'rename',
    load: async () => undefined,
    decide: () => ({
      change: 'Gus',
      after: [{ record: { kind: 'decision' as const, actor: 'ada', title } }]
    }),
    apply: async (tx: Tx, change: string) => {
      await tx.update(staff).set({ name: change }).where(eq(staff.id, 'ada'));
    }
  });
  assert.ok('change' in decided);
  assert.equal(await lines(), 1);
});

test("decide gets the caller's now as given", async () => {
  const given = new Date('2026-01-02T03:04:05Z');
  let got: Date | undefined;
  await transition(
    {
      ...rename([], 'Hal'),
      decide: (_work: { name: string }, now: Date) => {
        got = now;
        return { refused: 'no' };
      }
    },
    { now: given }
  );
  assert.equal(got, given);
});

test('with no now given, decide gets the time once the rows are loaded and locked', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const step = rename([], 'Ivy');
  let got: Date | undefined;
  await transition({
    ...step,
    load: async (tx: Tx) => {
      const work = await step.load(tx);
      // Waiting on another transaction's locks takes time.
      mock.timers.tick(5_000);
      return work;
    },
    decide: (_work: { name: string }, now: Date) => {
      got = now;
      return { refused: 'no' };
    }
  });
  assert.equal(got?.getTime(), 1_005_000);
});

test('a query from outside waits for a transaction to commit', async () => {
  const seen: string[] = [];
  let outside: Promise<void> | undefined;
  await db.transaction(async (tx) => {
    outside = nameOf().then((name) => {
      seen.push(`outside read ${name}`);
    });
    // Give the outside query every chance to run now, as it would on a driver
    // that did not queue it behind the open transaction.
    await new Promise((resolve) => setImmediate(resolve));
    await tx.update(staff).set({ name: 'Jo' }).where(eq(staff.id, 'ada'));
    seen.push('inside wrote Jo');
  });
  await outside;
  assert.deepEqual(seen, ['inside wrote Jo', 'outside read Jo']);
});

test('lockRows locks ids in ascending order, whatever order they come in', async () => {
  const dialect = new PgDialect({ casing: 'snake_case' });
  const ran: { sql: string; params: unknown[]; rows: unknown[] }[] = [];
  const others = ['zed', 'max'];
  await db.insert(staff).values(
    others.map((id) => ({
      id,
      name: id,
      role: 'r',
      variant: 'v',
      portrait: 'p',
      remit: 'r',
      desk: 'd',
      agent: 'claude' as const
    }))
  );
  await officeDb.transaction(async (tx) => {
    // Postgres locks rows in the order it returns them, so the rows each lock
    // query returned are the order it locked them in.
    const watched = new Proxy(tx, {
      get: (t, key) =>
        key === 'execute'
          ? async (query: Parameters<Tx['execute']>[0]) => {
              assert.ok(typeof query !== 'string');
              const out = await t.execute(query);
              // PGlite runs the office's queries here, and its result keeps
              // the rows under `rows`, where postgres-js gives a list.
              const { rows } = out as unknown as { rows: { id: string }[] };
              const { sql, params } = dialect.sqlToQuery(query.getSQL());
              ran.push({ sql, params, rows: rows.map((r) => r.id) });
              return out;
            }
          : Reflect.get(t, key)
    });
    await lockRows(watched, 'staff', ['zed', 'ada', 'max'], 'update');
    await lockRows(watched, 'staff', ['max', 'ada'], 'share');
    await lockRows(watched, 'staff', [], 'update');
  });
  await db.delete(staff).where(inArray(staff.id, others));
  assert.deepEqual(ran, [
    {
      sql: 'select id from "staff" where id in ($1, $2, $3) order by id for update',
      params: ['zed', 'ada', 'max'],
      rows: ['ada', 'max', 'zed']
    },
    {
      sql: 'select id from "staff" where id in ($1, $2) order by id for share',
      params: ['max', 'ada'],
      rows: ['ada', 'max']
    }
  ]);
});

test('lockRows reaches every table LOCK_ORDER names', async () => {
  await officeDb.transaction(async (tx) => {
    for (const table of LOCK_ORDER) {
      await lockRows(
        tx,
        table,
        [table === 'plan_limits' || table === 'staff' ? 'ada' : 1],
        'update'
      );
    }
  });
});
