// The work core's database side, by seeded sequences of every event it
// takes: each decides on the loaded rows as on the whole office, and
// `applyWork` writes a change so the rows read back equal the rows
// `applyChange` gives in memory. The cases one at a time are in
// work-apply.test.ts. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pokes, reports } from '../src/schema.ts';
import { random } from '../src/sequences.ts';
import { decide } from '../src/work/decide.ts';
import type { WorkEvent } from '../src/work/events.ts';
import { applyChange, type Change, type WorkRows } from '../src/work/snapshot.ts';
import { db } from './pglite.ts';
import {
  answer,
  AWS_STEP,
  bringingBack,
  calls,
  DRIVE_STEP,
  FOLDER,
  handOffOf,
  idsOffset,
  leaving,
  minutes,
  readRows,
  readWorld,
  run,
  seedOffice,
  SLACK_POST,
  TABLE_KEYS,
  unput,
  windowPastGuard,
  type Table
} from './work-office.ts';

/** Sequences per run; `WORK_APPLY_SEEDS` runs more. Sized so the file stays well under 5 seconds. */
const SEEDS = Number(process.env.WORK_APPLY_SEEDS ?? 2);
const LENGTH = 60;

/**
 * The rows `change` leaves in memory, each new row at the id the database
 * gives it next. `applyChange` gives a new row the id after its table's
 * highest, so a stand-in row just below the serial's next id, taken out
 * after, makes each new row's id, and each id pointing at it, the real one.
 */
function applyAtSerials(rows: WorkRows, change: Change, next: Record<Table, number>): WorkRows {
  const standIn = <T>(m: Map<number, T>, id: number) => new Map(m).set(id, [...m.values()][0]);
  const after = applyChange(
    {
      ...rows,
      threads: standIn(rows.threads, next.threads - 1),
      asks: standIn(rows.asks, next.asks - 1),
      tasks: standIn(rows.tasks, next.tasks - 1),
      followUps: standIn(rows.followUps, next.followUps - 1)
    },
    change
  );
  for (const table of TABLE_KEYS) after[table].delete(next[table] - 1);
  return after;
}

/**
 * The usage windows the sequences run under, five hours long as `WINDOW_MS`
 * in office-usage.ts has them: one that began a moment after ask 8 was
 * raised, so the first hand-off it holds raises its ask, and one that began
 * before, so ask 8 holds work until the window resets mid-sequence.
 */
const WINDOWS = [
  { resetsAt: minutes(300.5), began: minutes(0.5) },
  { resetsAt: minutes(30), began: minutes(-270) }
];

/** The usage window as the whole office reads it: its ask is the last window ask raised since it began. */
function windowOf(
  w: WorkRows,
  window: { share: number; resetsAt: Date; began: Date }
): WorkRows['window'] {
  const [ask] = [...w.asks.values()]
    .filter((a) => a.kind === 'window' && a.createdAt > window.began)
    .sort((a, b) => b.id - a.id);
  return {
    share: window.share,
    resetsAt: window.resetsAt,
    ask: ask ? { id: ask.id, status: ask.status } : null
  };
}

/** Every event the work core takes now, from the rows in memory and each claim's joined results. */
function offered(w: WorkRows, joined: Map<number, number[]>): WorkEvent[] {
  const events: WorkEvent[] = [
    {
      kind: 'runQueued',
      run: { staffId: 'lia', kind: 'resume', note: 'Go on.', threadId: 2 },
      onlyWhileOpen: true
    },
    {
      kind: 'runQueued',
      run: { staffId: 'gus', kind: 'resume', note: 'Go on.', threadId: 3 },
      onlyWhileOpen: true
    },
    { kind: 'runQueued', run: { staffId: 'cal', kind: 'carry_out', note: null, askId: 2 } },
    { kind: 'runQueued', run: { staffId: 'lia', kind: 'task_done', note: null, taskId: 1 } },
    { kind: 'runQueued', run: { staffId: 'rae', kind: 'edited', note: null } },
    ...answersOffered(w),
    ...threadsOffered(w)
  ];
  for (const [id, f] of w.followUps) {
    events.push({ kind: 'runClaimed', id });
    // A restart closes only the runs it cut off, the running ones. Offered for every run, the
    // kind was refused so often that it never got through at the default seeds.
    if (f.run.is === 'running') events.push({ kind: 'staleRunsClosed', id, about: 'the work' });
    for (const outcome of ['done', 'failed', 'waiting'] as const)
      events.push({
        kind: 'runFinished',
        id,
        about: 'the work',
        ended: { outcome, result: `Ran: ${outcome}`, joined: joined.get(id) ?? [] }
      });
  }
  return events;
}

/** Every event the answers family takes now: asks and tasks raised, and each answered every way. */
function answersOffered(w: WorkRows): WorkEvent[] {
  const ask = { why: 'w', ifApproved: 'i' };
  const events: WorkEvent[] = [
    {
      kind: 'askRaised',
      ask: { ...ask, staffId: 'cal', kind: 'call', title: 'Post it', call: SLACK_POST }
    },
    {
      kind: 'askRaised',
      ask: { ...ask, staffId: 'lia', kind: 'approval', title: 'May I send it?', threadId: 2 },
      attach: ['notes/a.md'],
      run: 'k2'
    },
    {
      kind: 'askRaised',
      ask: { ...ask, staffId: 'cal', kind: 'approval', title: 'A new version', revises: 1 }
    },
    {
      kind: 'taskGiven',
      task: { staffId: 'rae', title: 'Read this', why: 'w', steps: [], threadId: 4 },
      attach: ['notes/b.md'],
      run: 'k3'
    },
    {
      kind: 'taskGiven',
      task: { staffId: null, title: 'Connect AWS', why: 'w', steps: [AWS_STEP] },
      oneOpen: { connector: 'aws', aws: true }
    },
    {
      kind: 'taskGiven',
      task: { staffId: 'cal', title: 'Connect Drive', why: 'w', steps: [DRIVE_STEP] },
      oneOpen: { connector: 'drive' }
    },
    { kind: 'connectTasksDropped', connector: 'drive' },
    { kind: 'connectTasksDropped', connector: 'aws', staffId: 'cal' },
    { kind: 'goalStatusChanged', goalId: 1, status: 'met' }
  ];
  for (const a of w.asks.values()) {
    const given = a.folder && { done: { folder: { ...a.folder, given: FOLDER } } };
    events.push(
      answer(a.id, 'approve', given ?? {}),
      answer(a.id, 'deny'),
      answer(a.id, 'iterate')
    );
  }
  for (const id of w.tasks.keys())
    events.push(
      { kind: 'taskEnded', id, ended: 'done', note: 'Done it.', inChat: id % 2 === 0 },
      { kind: 'taskEnded', id, ended: 'dropped', note: null, inChat: false },
      { kind: 'taskEnded', id, ended: 'withdrawn', note: 'Taken off the desk.', inChat: false }
    );
  return events;
}

/**
 * Every event the threads and leaving families take now: hand-offs, the
 * owner's words passed to a lead, parks, the clock, and each Odd leaving and
 * coming back. Cal works on threads 2 and 4, which Lia leads.
 */
function threadsOffered(w: WorkRows): WorkEvent[] {
  const told = {
    said: 'Send it on Friday, please.',
    words: 'on Friday',
    reading: 'It waits for Friday.',
    exchange: '',
    files: []
  };
  const events: WorkEvent[] = [
    handOffOf({ open: { title: 'New work', hubId: 'lia' } }, { run: 'k4' }),
    // New work for a goal Cal leads, which opens though this hand-off does not go.
    handOffOf({ open: { title: 'Goal work', hubId: 'cal' } }),
    handOffOf({ id: 2 }, { to: 'rae' }),
    handOffOf({ id: 2 }, { to: 'gus' }),
    { kind: 'parked', staffId: 'lia', threadId: 2, on: { task: 1 }, worksOn: new Set() },
    { kind: 'parked', staffId: 'lia', threadId: 1, on: { task: 4 }, worksOn: new Set() },
    { kind: 'parked', staffId: 'lia', threadId: 4, on: { at: minutes(20) }, worksOn: new Set() },
    { kind: 'parked', staffId: 'cal', threadId: 9, on: { at: minutes(40) }, worksOn: new Set() }
  ];
  for (const id of w.threads.keys())
    events.push(
      handOffOf({ id }),
      { kind: 'toldLead', staffId: 'cal', threadId: id, worksOn: new Set([2, 4]), ...told },
      { kind: 'clockWoke', threadId: id }
    );
  for (const id of w.staff.keys()) events.push(leaving(id), bringingBack(id));
  return events;
}

type Written = {
  reports: { staffId: string; title: string; body: string }[];
  pokes: { staffId: string; message: string }[];
};

/** The reports and pokes written after the given ids. */
async function writtenAfter(last: { report: number; poke: number }): Promise<Written> {
  const r = await db.select().from(reports).orderBy(reports.id);
  const p = await db.select().from(pokes).orderBy(pokes.id);
  return {
    reports: r
      .filter((x) => x.id > last.report)
      .map(({ staffId, title, body }) => ({ staffId, title, body })),
    pokes: p.filter((x) => x.id > last.poke).map(({ staffId, message }) => ({ staffId, message }))
  };
}

function outsideOf(change: Change): Written {
  return {
    reports: change.outside.flatMap((o) =>
      o.kind === 'report' ? [{ staffId: o.staffId, title: o.title, body: o.body }] : []
    ),
    pokes: change.outside.flatMap((o) =>
      o.kind === 'poke' ? [{ staffId: o.staffId, message: o.message }] : []
    )
  };
}

/** A kind each event kind is named in, so a kind added to `WorkEvent` fails the type check here until the sequences run it. */
const KINDS = Object.keys({
  runQueued: 0,
  runClaimed: 0,
  runFinished: 0,
  staleRunsClosed: 0,
  askRaised: 0,
  askDecided: 0,
  taskGiven: 0,
  taskEnded: 0,
  connectTasksDropped: 0,
  goalStatusChanged: 0,
  parked: 0,
  clockWoke: 0,
  oddRemoved: 0,
  oddBroughtBack: 0,
  handedOff: 0,
  toldLead: 0
} satisfies Record<WorkEvent['kind'], 0>);

test('every work event decides on the loaded rows as on the whole office, and writes the rows applyChange gives', async () => {
  let events = 0;
  let changes = 0;
  const changedBy = new Set<string>();
  for (let seed = 0; seed < SEEDS; seed++) {
    const rnd = random(seed);
    await seedOffice();
    const window = WINDOWS[seed % WINDOWS.length];
    await windowPastGuard(window.resetsAt);
    let world = await readWorld();
    const joined = new Map<number, number[]>();
    let last = { report: 0, poke: 0 };
    for (let n = 1; n <= LENGTH; n++) {
      // Each kind as likely as any other, so a kind with few events still runs at the default seeds.
      const choices = offered(world, joined);
      const kinds = [...new Set(choices.map((c) => c.kind))];
      const kind = kinds[Math.floor(rnd() * kinds.length)];
      const ofKind = choices.filter((c) => c.kind === kind);
      const e = ofKind[Math.floor(rnd() * ofKind.length)];
      const at = `seed ${seed}, event ${n}: ${JSON.stringify(e)}`;
      const now = minutes(n);
      const next = await idsOffset(world);
      const { got, loaded } = await run(e, now);
      // What an answer reads that takes I/O comes from the loader alone; the prepare test in
      // work-apply.test.ts checks it.
      const whole = {
        ...world,
        window: windowOf(world, { ...window, share: 0.9 }),
        prepared: loaded.prepared
      };
      const expected = decide(whole, e, now);
      assert.deepStrictEqual(
        unput(got),
        unput(expected),
        `the loaded rows decide as the whole office does, ${at}`
      );
      events++;
      if (!('change' in expected && 'change' in got)) continue;
      changes++;
      changedBy.add(e.kind);
      const before = world;
      world = applyAtSerials(before, expected.change, next);
      assert.deepStrictEqual(
        applyAtSerials(before, got.change, next),
        world,
        `the loaded rows' puts leave the office as the whole office's do, ${at}`
      );
      if (e.kind === 'runClaimed' && 'change' in got)
        joined.set(
          e.id,
          (got.change.result as { joined: { id: number }[] }).joined.map((g) => g.id)
        );
      const rows = await readRows();
      for (const table of TABLE_KEYS)
        assert.deepStrictEqual(rows[table], world[table], `${table} read back as in memory, ${at}`);
      const written = await writtenAfter(last);
      assert.deepStrictEqual(written, outsideOf(expected.change), `reports and pokes, ${at}`);
      last = {
        report: last.report + written.reports.length,
        poke: last.poke + written.pokes.length
      };
    }
  }
  // A kind that never got through would check nothing of its loader or its writes.
  assert.deepStrictEqual(
    [...changedBy].sort(),
    KINDS.toSorted(),
    `${changes} of ${events} events changed rows`
  );
  assert.deepStrictEqual(calls, [], 'no decider ran an effect while deciding');
});
