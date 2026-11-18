// What must hold after every path a test drives: one goal is one thread, and
// an Odd that serves a goal and has no job leads none (`assertMayLead`). The
// manager leads every goal's thread, so it is never counted. A test file
// passes the `sql` of whichever database it runs on, and checks this after
// each test, so a path that breaks it fails wherever it is.
import assert from 'node:assert/strict';

/**
 * A tagged-template query, as `db.ts` and `pglite.ts` each export one. Its
 * values are `never` so both fit; the one value passed is a string either takes.
 */
type Sql = (parts: TemplateStringsArray, ...values: never[]) => PromiseLike<unknown[]>;

/** Fails when a goal has a second thread, or a goal-only Odd leads a thread. */
export async function oneThreadPerGoal(sql: Sql, managerRole: string): Promise<void> {
  const twice = await sql`
    select goal_id from threads where goal_id is not null group by goal_id having count(*) > 1`;
  assert.deepEqual([...twice], [], 'a goal has one thread');
  const hubs = await sql`
    select distinct t.hub_id from threads t
    join staff s on s.id = t.hub_id
    where exists (select 1 from staff_goals g where g.staff_id = t.hub_id)
      and not exists (select 1 from jobs j where j.staff_id = t.hub_id)
      and s.role <> ${managerRole as never}`;
  assert.deepEqual([...hubs], [], 'an Odd that serves a goal and has no job leads no thread');
}
