// The work core's database side, case by case: the loader reads what a
// decider needs under its locks, and `applyWork` writes a change so the rows
// read back equal the rows `applyChange` gives in memory. The seeded
// sequences of every event are in work-apply-sequences.test.ts. PGlite runs
// one transaction at a time, so the lock tests here prove which rows are
// locked and in what order, not that a second transaction waits. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { desc, eq, getTableName, sql, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { asks, attachments, followUps, goals, jobs, pokes, staff, threads } from '../src/schema.ts';
import type { Tx } from '../src/threads.ts';
import { GOAL_SET } from '../src/work/asks.ts';
import { decide } from '../src/work/decide.ts';
import type { WorkEvent, WorkResults } from '../src/work/events.ts';
import { applyChange, type Change, type Put, type WorkRows } from '../src/work/snapshot.ts';
import { newRun } from '../src/work/threads.ts';
import { db } from './pglite.ts';
import {
  answer,
  AWS_STEP,
  bringingBack,
  calls,
  DRIVE_STEP,
  FOLDER,
  handOffOf,
  HELD,
  idsOffset,
  leaving,
  minutes,
  readRows,
  readWorld,
  run,
  seedOffice,
  SLACK_POST,
  T0,
  TABLES,
  unput,
  windowPastGuard
} from './work-office.ts';

const { LOCK_ORDER, transition } = await import('../src/transition.ts');
const { loadWork, queuedRows } = await import('../src/work/load.ts');
const { applyWork } = await import('../src/work/apply.ts');
const { threadPart } = await import('../src/threads.ts');
// The office's own handle, which is PGlite's here, so a transaction has the type the core takes.
const { db: officeDb } = await import('../src/db.ts');
const { networkNote } = await import('../src/office-staff.ts');
const { gaveFolder } = await import('../src/office-folders.ts');
const { MANAGER_ROLE } = await import('../src/managers.ts');

test('an Odd the owner let go is given no run, no ask and no task', async () => {
  await seedOffice();
  const before = await readRows();
  const events: WorkEvent[] = [
    { kind: 'runQueued', run: { staffId: 'gus', kind: 'edited', note: null } },
    {
      kind: 'askRaised',
      ask: { staffId: 'gus', kind: 'approval', title: 'One more', why: 'w', ifApproved: 'i' }
    },
    { kind: 'taskGiven', task: { staffId: 'gus', title: 'Sign this', why: 'w', steps: [] } }
  ];
  // Gus left before any of these. The sequences in work-apply-sequences.test.ts reach an ask
  // or a task for an Odd that left only after a leaving, which the default seeds may not draw.
  for (const e of events) {
    await run(e, minutes(1));
    assert.deepStrictEqual(await readRows(), before, `${e.kind} wrote nothing`);
  }
});

test('new rows written together point at each other and at an effect id by ref, as in memory', async () => {
  await seedOffice();
  const world = await readWorld();
  let goalId = 0;
  const change: Change = {
    put: [
      {
        table: 'threads',
        ref: 'work',
        insert: {
          hubId: 'lia',
          holderId: 'lia',
          title: 'New work',
          goalId: null,
          handOffsUsed: 0,
          runs: [],
          createdAt: T0,
          status: 'open',
          park: { on: 'none' }
        },
        points: { goalId: 'goal' }
      },
      {
        table: 'asks',
        ref: 'asked',
        insert: {
          ...[...world.asks.values()][0],
          status: 'open',
          title: 'Raised on the new work',
          threadId: null,
          handOffId: null
        },
        points: { threadId: 'work' }
      },
      {
        table: 'followUps',
        ref: 'run',
        insert: newRun({ staffId: 'lia', kind: 'resume' }, T0),
        points: { threadId: 'work', askId: 'asked', goalId: 'goal' }
      }
    ],
    outside: [
      {
        kind: 'perKind',
        effect: {
          name: 'goal',
          run: async (tx) => {
            const [g] = await tx
              .insert(goals)
              .values({ title: 'A goal' })
              .returning({ id: goals.id });
            goalId = g.id;
            return g;
          }
        }
      },
      { kind: 'attachments', staffId: 'lia', paths: ['notes/a.md'], to: { ask: 'asked' } }
    ],
    result: null
  };
  await officeDb.transaction((tx) => applyWork(tx, change));

  const expected = applyChange(world, change);
  // In memory the effect's id is made up as -1; the database gave the real one.
  for (const t of expected.threads.values()) if (t.goalId === -1) t.goalId = goalId;
  for (const f of expected.followUps.values()) if (f.goalId === -1) f.goalId = goalId;
  const rows = await readRows();
  for (const table of ['threads', 'followUps', 'asks', 'tasks'] as const)
    assert.deepStrictEqual(rows[table], expected[table], table);
  const newAsk = Math.max(...expected.asks.keys());
  const files = await db.select().from(attachments);
  assert.deepStrictEqual(
    files.map(({ staffId, path, askId, taskId }) => ({ staffId, path, askId, taskId })),
    [{ staffId: 'lia', path: 'notes/a.md', askId: newAsk, taskId: null }]
  );
});

test('a change that cannot be written leaves nothing behind, its effect included', async () => {
  await seedOffice();
  const before = await readRows();
  const change: Change = {
    put: [
      { table: 'threads', row: { ...before.threads.get(2)!, title: 'Renamed' } },
      {
        table: 'followUps',
        ref: 'run',
        insert: newRun({ staffId: 'lia', kind: 'resume' }, T0),
        points: { askId: 'no such ref' }
      }
    ],
    outside: [
      {
        kind: 'perKind',
        effect: {
          name: 'goal',
          run: async (tx) => {
            await tx.insert(goals).values({ title: 'A goal' });
          }
        }
      }
    ],
    result: null
  };
  await assert.rejects(
    officeDb.transaction((tx) => applyWork(tx, change)),
    /points at a ref no earlier put made/
  );
  assert.deepStrictEqual(await readRows(), before);
  assert.deepStrictEqual(await db.select().from(goals), []);
});

test('an Odd that leaves has its jobs off and its waiting pokes cancelled, and coming back turns the same jobs on', async () => {
  await seedOffice();
  const schedule = { every: 'day', at: '09:00' } as const;
  const job = { staffId: 'lia', instructions: 'i', schedule };
  await db.insert(jobs).values([
    { ...job, name: 'On' },
    { ...job, name: 'Off already', enabled: false }
  ]);
  await db.insert(pokes).values({ staffId: 'lia', at: minutes(30), message: 'Later.' });
  const at = minutes(1);
  const apply = (outside: Change['outside']) =>
    officeDb.transaction((tx) => applyWork(tx, { put: [], outside, result: null }));

  await apply([
    { kind: 'leave', staffId: 'lia', at },
    { kind: 'cancelPokes', staffId: 'lia' }
  ]);
  const [left] = await db.select().from(staff).where(eq(staff.id, 'lia'));
  assert.deepStrictEqual(
    { leftAt: left.leftAt, jobsOff: left.jobsOff },
    { leftAt: at, jobsOff: [1] }
  );
  assert.deepStrictEqual(
    (await db.select().from(jobs).orderBy(jobs.id)).map((j) => j.enabled),
    [false, false]
  );
  assert.deepStrictEqual(
    (await db.select().from(pokes)).map((p) => p.status),
    ['cancelled']
  );

  await apply([{ kind: 'comeBack', staffId: 'lia' }]);
  const [back] = await db.select().from(staff).where(eq(staff.id, 'lia'));
  assert.deepStrictEqual(
    { leftAt: back.leftAt, jobsOff: back.jobsOff },
    { leftAt: null, jobsOff: null }
  );
  const after = await db.select().from(jobs).orderBy(jobs.id);
  assert.deepStrictEqual(
    after.map((j) => j.enabled),
    [true, false]
  );
  assert.ok(after[0].nextRunAt, 'the job turned back on has its next run');
});

test('a run that failed before it started, or of a retired kind, is not queued', async () => {
  await seedOffice();
  // The column's type lists only the live kinds, so a retired row goes in as plain SQL.
  await db.execute(
    sql`insert into follow_ups (staff_id, kind, created_at) values ('lia', 'feedback', now())`
  );
  const queued = await db.select({ id: followUps.id }).from(followUps).where(queuedRows);
  const world = await readWorld();
  const expected = [...world.followUps.values()]
    .filter((f) => f.run.is === 'queued')
    .map((f) => ({ id: f.id }));
  assert.deepStrictEqual(queued, expected);
  // The office holds both kinds of row the test is about.
  const failed = world.followUps.get(14)?.run;
  assert.ok(failed?.is === 'ended' && failed.startedAt === null);
  assert.ok([...world.followUps.values()].some((f) => f.kind === 'feedback'));
});

/** Each lock a loader takes, by table, in order, with its mode and ids. */
type Lock = { table: string; mode: string; ids: string[] };

/**
 * Load an event's rows in a transaction of their own, with every row lock the
 * loader took, and its trail: each table it read (`read:asks`), each row lock
 * (`lock:asks`) and each tool's connect lock (`connect:drive`), in the order
 * it took them, so a test can see that a read came after the lock that guards it.
 */
async function loadLocked(
  e: WorkEvent
): Promise<{ rows: WorkRows; locks: Lock[]; trail: string[] }> {
  const dialect = new PgDialect();
  const locks: Lock[] = [];
  const trail: string[] = [];
  const rows = await officeDb.transaction(async (tx) => {
    const execute = tx.execute.bind(tx);
    mock.method(tx, 'execute', (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      const lock = /from "(\w+)" .* for (update|share)$/.exec(text);
      if (lock) {
        locks.push({ table: lock[1], mode: lock[2], ids: params.map(String) });
        trail.push(`lock:${lock[1]}`);
      }
      // A tool's connect lock is keyed by its one parameter, `connect:<tool>`.
      if (text.includes('pg_advisory_xact_lock')) trail.push(...params.map(String));
      return execute(query);
    });
    const select = tx.select.bind(tx);
    mock.method(tx, 'select', (...args: Parameters<typeof select>) => {
      const builder = select(...args);
      const from = builder.from.bind(builder);
      mock.method(builder, 'from', (table: PgTable) => {
        trail.push(`read:${getTableName(table)}`);
        return from(table);
      });
      return builder;
    });
    return loadWork(tx, e);
  });
  return { rows, locks, trail };
}

const WRITES_HERE = new Set<WorkEvent['kind']>([
  'handedOff',
  'toldLead',
  'parked',
  'clockWoke',
  'oddRemoved',
  'oddBroughtBack'
]);

test('every loader locks in the one table order each row its decider reads, and for update each it writes', async () => {
  await seedOffice();
  // A grant's connect task: its steps name their tools, not in sorted order, and no open task answers it.
  const grantTask: WorkEvent = {
    kind: 'taskGiven',
    task: {
      staffId: 'cal',
      askId: 3,
      title: 'Connect Drive and AWS',
      why: 'w',
      steps: [DRIVE_STEP, AWS_STEP]
    }
  };
  const oneOpenTask: WorkEvent = {
    kind: 'taskGiven',
    task: { staffId: 'cal', title: 'Connect Drive', why: 'w', steps: [DRIVE_STEP] },
    oneOpen: { connector: 'drive' }
  };
  const dropped: WorkEvent = { kind: 'connectTasksDropped', connector: 'drive' };
  // The tools whose connect tasks each loader locks, sorted, so two transactions take them in
  // one order. Every other loader locks none.
  const connects = new Map<WorkEvent, string[]>([
    [grantTask, ['connect:aws', 'connect:drive']],
    [oneOpenTask, ['connect:drive']],
    [dropped, ['connect:drive']]
  ]);
  const events: WorkEvent[] = [
    {
      kind: 'runQueued',
      // An ask on work with asks, and a task: this one locks every table it can.
      run: { staffId: 'cal', kind: 'carry_out', note: null, askId: 2, taskId: 1, threadId: 1 }
    },
    { kind: 'runClaimed', id: 1 },
    {
      kind: 'runFinished',
      id: 2,
      about: 'the work',
      ended: { outcome: 'failed', result: 'r', joined: [4, 5] }
    },
    { kind: 'staleRunsClosed', id: 6, about: 'the work' },
    {
      kind: 'askRaised',
      ask: {
        staffId: 'cal',
        kind: 'call',
        title: 'Post it',
        why: 'w',
        ifApproved: 'i',
        call: { ...SLACK_POST, tool: 'edit' },
        revises: 9,
        threadId: 4
      }
    },
    answer(3, 'approve'),
    answer(3, 'deny'),
    answer(5, 'approve', { done: { folder: { ...FOLDER, given: FOLDER } } }),
    answer(6, 'approve'),
    answer(7, 'approve'),
    answer(7, 'deny'),
    answer(8, 'approve'),
    answer(10, 'deny'),
    {
      kind: 'taskGiven',
      task: { staffId: 'rae', title: 'Read this', why: 'w', steps: [], threadId: 4 }
    },
    oneOpenTask,
    grantTask,
    { kind: 'taskEnded', id: 3, ended: 'done', note: null, inChat: false },
    { kind: 'taskEnded', id: 4, ended: 'withdrawn', note: 'Gone.', inChat: false },
    dropped,
    { kind: 'goalStatusChanged', goalId: 1, status: 'met' },
    {
      kind: 'handedOff',
      from: 'lia',
      to: 'cal',
      work: { title: 'Check it', brief: 'Check.' },
      thread: { id: 2 },
      carry: []
    },
    {
      kind: 'toldLead',
      staffId: 'cal',
      threadId: 4,
      said: 'Send it on Friday.',
      words: 'on Friday',
      reading: 'It waits for Friday.',
      exchange: '',
      worksOn: new Set([4]),
      files: []
    },
    { kind: 'parked', staffId: 'lia', threadId: 2, on: { task: 1 }, worksOn: new Set() },
    { kind: 'parked', staffId: 'lia', threadId: 2, on: { at: minutes(30) }, worksOn: new Set() },
    // Thread 7, which the window's ask 8 holds, due: it wakes, and the ask waits for the clock's reset.
    { kind: 'clockWoke', threadId: 7 },
    leaving('cal'),
    // Ask 13 is another ask to bring Gus back, which the bring-back withdraws.
    bringingBack('gus')
  ];
  await db
    .update(threads)
    .set({ resumeAt: minutes(-1) })
    .where(eq(threads.id, 7));
  const every = new Set<string>();
  for (const e of events) {
    const { rows, locks, trail } = await loadLocked(e);
    const at = `${e.kind} ${JSON.stringify(e)} locked ${locks.map((l) => `${l.table} ${l.mode} ${l.ids.join(',')}`).join('; ')}`;
    const order = locks.map((l) => LOCK_ORDER.indexOf(l.table as (typeof LOCK_ORDER)[number]));
    for (const l of locks) every.add(l.table);
    // Only a hand-off, new or a held one's yes, holds work for the window, under the
    // plan's lock. So each, and the window ask's yes that frees that work, takes it first.
    const windowYes =
      e.kind === 'askDecided' && e.decision === 'approve' && rows.asks.get(e.id)?.kind === 'window';
    if (e.kind === 'handedOff' || rows.window || windowYes)
      assert.equal(locks[0]?.table, 'plan_limits', at);
    // The yes reads the work the ask holds only under the plan's lock, so a hand-off the
    // window holds at the same moment is either among it or waits for the yes.
    if (windowYes) {
      const plan = trail.indexOf('lock:plan_limits');
      assert.ok(
        plan !== -1 && plan < trail.indexOf('read:threads'),
        `the held work was read before the plan's lock: ${trail.join(' ')}`
      );
    }
    assert.deepStrictEqual(
      trail.filter((s) => s.startsWith('connect:')),
      connects.get(e) ?? [],
      `connect locks: ${at}`
    );
    assert.ok(!order.includes(-1), at);
    assert.deepStrictEqual(
      order,
      order.toSorted((a, b) => a - b),
      at
    );
    const locked = (table: string, mode?: string) =>
      new Set(locks.flatMap((l) => (l.table === table && (!mode || l.mode === mode) ? l.ids : [])));
    for (const [key, table] of Object.entries(TABLES)) {
      const held = locked(table);
      for (const id of rows[key as keyof typeof TABLES].keys())
        assert.ok(held.has(String(id)), `${table} ${id} was read unlocked: ${at}`);
    }
    const decided = decide(rows, e, minutes(1));
    // Each of these writes here, so its update locks are checked against real writes.
    if (WRITES_HERE.has(e.kind))
      assert.ok('change' in decided && decided.change.put.length, `writes nothing: ${at}`);
    const written = 'change' in decided ? decided.change.put.filter((p) => 'row' in p) : [];
    for (const p of written as Extract<Put, { row: unknown }>[])
      assert.ok(
        locked(TABLES[p.table], 'update').has(String(p.row.id)),
        `${p.table} ${p.row.id} was written without its update lock: ${at}`
      );
    // The Odd a leaving or a bring-back writes.
    for (const o of 'change' in decided ? decided.change.outside : [])
      if (o.kind === 'leave' || o.kind === 'comeBack')
        assert.ok(locked('staff', 'update').has(o.staffId), `staff ${o.staffId}: ${at}`);
    // The Odd a switch yes changes with the claim.
    const turned = rows.prepared.switches?.before.id;
    if (turned) assert.ok(locked('staff', 'update').has(turned), `staff ${turned}: ${at}`);
  }
  // Each table a decider reads was locked, the plan's row by a hand-off and the clock among them.
  assert.deepStrictEqual([...every].sort(), LOCK_ORDER.toSorted());
});

test('a task that work parks on while it ends refuses the end, so the parked work is never left waiting', async () => {
  await seedOffice();
  await assert.rejects(
    officeDb.transaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      // A park that lands between the thread locks and the task's, as one from another transaction would.
      mock.method(tx, 'execute', async (query: SQL) => {
        if (/from "tasks" .* for update$/.test(new PgDialect().sqlToQuery(query).sql))
          await tx.update(threads).set({ resumeOnTask: 4 }).where(eq(threads.id, 5));
        return execute(query);
      });
      await loadWork(tx, { kind: 'taskEnded', id: 4, ended: 'done', note: null, inChat: false });
    }),
    /parked on the task as it ended/
  );
});

test('a yes to a switch, a folder or a held hand-off is decided on what the loader prepares under its locks', async () => {
  await seedOffice();
  const prepared = async (e: WorkEvent) =>
    (await officeDb.transaction((tx) => loadWork(tx, e))).prepared;
  const turned = (await prepared(answer(6, 'approve'))).switches;
  assert.ok(turned, 'a switch yes has its switches');
  const { before, off, networkBody } = turned;
  assert.deepStrictEqual(
    { id: before.id, commands: before.commands, web: before.web, off },
    { id: 'cal', commands: false, web: false, off: ['commands', 'web'] }
  );
  assert.equal(networkBody, networkNote(before, { ...before, commands: true, web: true }).body);
  assert.deepStrictEqual(
    await prepared(answer(5, 'approve', { done: { folder: { ...FOLDER, given: FOLDER } } })),
    { folderTitle: gaveFolder('Rae', FOLDER.path, FOLDER.level) }
  );
  assert.deepStrictEqual(await prepared(answer(7, 'approve')), {
    sharing: { from: 'lia', title: HELD.title, brief: HELD.brief }
  });
  for (const no of [answer(6, 'deny'), answer(5, 'iterate'), answer(7, 'deny')])
    assert.deepStrictEqual(await prepared(no), {}, 'a no or a send-back prepares nothing');
});

test('an answer and a leaving run their effects after the commit, never while they are decided', async () => {
  /** The calls one event makes, in order, with when it was decided and committed. */
  const callsOf = async (e: WorkEvent): Promise<string[]> => {
    await seedOffice();
    calls.length = 0;
    const commit = officeDb.transaction.bind(officeDb);
    mock.method(officeDb, 'transaction', async (inTx: Parameters<typeof commit>[0]) => {
      const done = await commit(inTx);
      calls.push('committed');
      return done;
    });
    try {
      await transition(
        {
          name: e.kind,
          load: (q: Tx) => loadWork(q, e),
          decide: (rows: WorkRows, at: Date) => {
            calls.push('deciding');
            const d = decide(rows, e, at);
            calls.push('decided');
            return d;
          },
          // A transition's `apply` gives nothing back, and this test reads no real ids.
          apply: async (q: Tx, c: Change) => {
            await applyWork(q, c);
          }
        },
        { now: minutes(1) }
      );
    } finally {
      mock.restoreAll();
    }
    const made = [...calls];
    calls.length = 0;
    return made;
  };
  // The twin off any work is answered with it, and carried out with it.
  assert.deepStrictEqual(await callsOf(answer(3, 'approve')), [
    'deciding',
    'decided',
    'committed',
    'grantAccess cal',
    'carryOutTogether 3 4'
  ]);
  // The office stops a run of the Odd only once its leaving is in the database.
  assert.deepStrictEqual(await callsOf(leaving('cal')), [
    'deciding',
    'decided',
    'committed',
    'stopRuns cal'
  ]);
});

test('the usage window ask goes under the earliest hired manager, whatever their names', async () => {
  await seedOffice();
  const manager = { role: MANAGER_ROLE, variant: 'v', portrait: 'p', remit: 'r', desk: 'd' };
  // Zed was hired first, and sorts after Amy by name.
  await db.insert(staff).values([
    { ...manager, id: 'zed', name: 'Zed', hiredAt: minutes(-100) },
    { ...manager, id: 'amy', name: 'Amy', hiredAt: minutes(-10) }
  ]);
  await windowPastGuard();
  const { got } = await run(handOffOf({ id: 2 }), minutes(1));
  assert.ok('change' in got, 'the hand-off is held, and its change commits');
  const [asked] = await db.select().from(asks).orderBy(desc(asks.id)).limit(1);
  assert.deepStrictEqual(
    { kind: asked.kind, staffId: asked.staffId },
    { kind: 'window', staffId: 'zed' }
  );
});

/** A file outside the office for a hand-off to carry. */
function fileToCarry(): { real: string; name: string; named: string } {
  const real = join(mkdtempSync(join(tmpdir(), 'oddboro-carry-')), 'notes.md');
  writeFileSync(real, 'Notes.');
  return { real, name: 'notes.md', named: 'notes.md' };
}

test('a hand-off the usage window holds on work already open points the work at the new window ask', async () => {
  await seedOffice();
  await idsOffset(await readRows());
  const { resetsAt } = await windowPastGuard();
  const { got } = await run(handOffOf({ id: 2 }), minutes(1));
  assert.ok('change' in got, 'the hand-off is held, and its change commits');
  const [asked] = await db.select().from(asks).orderBy(desc(asks.id)).limit(1);
  assert.ok(asked.kind === 'window' && asked.id > 200, `ask ${asked.id} is the new window ask`);
  const [t] = await db.select().from(threads).where(eq(threads.id, 2));
  assert.deepStrictEqual(
    { heldBy: t.heldBy, resumeAt: t.resumeAt },
    { heldBy: asked.id, resumeAt: resetsAt }
  );
});

test('a hand-off that opens new work copies its files into that work by its real number', async () => {
  await seedOffice();
  await idsOffset(await readRows());
  const file = fileToCarry();
  const { got } = await run(
    handOffOf({ open: { title: 'New work', hubId: 'lia' } }, { carry: [file] }),
    minutes(1)
  );
  assert.ok('change' in got);
  const [made] = await db.select().from(threads).orderBy(desc(threads.id)).limit(1);
  assert.ok(made.id > 100, `work ${made.id} is the new work`);
  assert.ok(existsSync(join(threadPart(made.id, 'lia'), file.name)), 'the file is in the new work');
});

test("a taken hand-off's result names the real run and work, never the decider's guesses", async () => {
  await seedOffice();
  await idsOffset(await readRows());
  const { got, real } = await run(
    handOffOf({ open: { title: 'New work', hubId: 'lia' } }),
    minutes(1)
  );
  assert.ok('change' in got && real);
  const result = got.change.result as WorkResults['handedOff'];
  assert.ok('id' in result, 'the hand-off was taken');
  const [run1] = await db.select().from(followUps).orderBy(desc(followUps.id)).limit(1);
  assert.deepStrictEqual(
    { id: real(result.id), thread: real(result.thread), kind: run1.kind },
    { id: run1.id, thread: run1.threadId, kind: 'hand_off' }
  );
  assert.ok(run1.id > 300 && (run1.threadId ?? 0) > 100, 'both are new rows past the offset');
});

test('a hand-off whose files cannot be carried writes no row, and its caller gets the reason', async () => {
  await seedOffice();
  const before = await readRows();
  const gone = {
    real: join(tmpdir(), 'oddboro-no-such-file.md'),
    name: 'notes.md',
    named: 'notes.md'
  };
  await assert.rejects(run(handOffOf({ id: 2 }, { carry: [gone] }), minutes(1)), {
    message:
      'The office cannot open notes.md to copy it. Make it readable, or leave it out, and call hand_off again.'
  });
  assert.deepStrictEqual(await readRows(), before);
});

test('a held hand-off yes to a colleague that left decides as on the whole office, and starts no run for it', async () => {
  // Thread 8 has no run, so the yes reaches Rae only through the colleague its ask holds.
  await seedOffice();
  await db
    .update(staff)
    .set({ leftAt: minutes(-5) })
    .where(eq(staff.id, 'rae'));
  const world = await readWorld();
  const rae = world.staff.get('rae');
  assert.ok(rae);
  world.staff.set('rae', { ...rae, leftAt: minutes(-5) });
  const e = answer(7, 'approve');
  const { got, loaded } = await run(e, minutes(1));
  const expected = decide({ ...world, prepared: loaded.prepared }, e, minutes(1));
  assert.deepStrictEqual(unput(got), unput(expected));
  assert.ok('change' in got && 'change' in expected);
  assert.deepStrictEqual(
    applyChange(world, got.change).followUps,
    applyChange(world, expected.change).followUps
  );
});

test('the clock waking one of two threads the window ask holds wakes only that one, and leaves the ask on the desk', async () => {
  await seedOffice();
  await db
    .update(threads)
    .set({ resumeAt: minutes(-1) })
    .where(eq(threads.id, 7));
  await db
    .update(threads)
    .set({ resumeAt: minutes(30), heldBy: 8 })
    .where(eq(threads.id, 2));
  const world = await readWorld();
  const e: WorkEvent = { kind: 'clockWoke', threadId: 7 };
  const { got } = await run(e, minutes(1));
  assert.deepStrictEqual(unput(got), unput(decide(world, e, minutes(1))));
  const [a] = await db.select().from(asks).where(eq(asks.id, 8));
  assert.equal(a.status, 'open');
  const [other] = await db.select().from(threads).where(eq(threads.id, 2));
  assert.equal(other.heldBy, 8, 'thread 2 is not due, so it stays held');
});

test("a goal yes loads the office's manager, whom no row names, so the manager plans the goal its own write set", async () => {
  await seedOffice();
  await db.insert(staff).values({
    id: 'max',
    name: 'Max',
    role: MANAGER_ROLE,
    variant: 'v',
    portrait: 'p',
    remit: 'r',
    desk: 'd'
  });
  const draft = { title: 'Sell more bread', horizon: 'quarter' as const, area: 'work' };
  const [raised] = await db
    .insert(asks)
    .values({
      staffId: 'cal',
      kind: 'goal',
      title: draft.title,
      why: 'w',
      ifApproved: 'i',
      goal: draft
    })
    .returning();
  let set = 0;
  const { got } = await run(
    answer(raised.id, 'approve', {
      perKind: [
        {
          name: GOAL_SET,
          run: async (tx) => {
            [{ id: set }] = await tx.insert(goals).values({ title: draft.title }).returning();
            return { id: set };
          }
        }
      ]
    }),
    minutes(1)
  );
  assert.ok('change' in got, 'the yes commits');
  const planning = await db.select().from(followUps).where(eq(followUps.kind, 'goal'));
  assert.deepStrictEqual(
    planning.map((f) => ({ staffId: f.staffId, goalId: f.goalId })),
    [{ staffId: 'max', goalId: set }]
  );
  const [work] = await db
    .select()
    .from(threads)
    .where(eq(threads.id, planning[0].threadId ?? 0));
  assert.deepStrictEqual(
    { hubId: work?.hubId, goalId: work?.goalId },
    { hubId: 'max', goalId: set }
  );
});
