// What the work core's thread and leaving deciders make of one event, or a
// short run of them, on rows in memory: an Odd leaving and coming back, a
// hand-off, a colleague telling the lead, and the clock waking parked work.
// Each case is one a past bug or a ruling names. Pure: no database. Apart
// from work-decide.test.ts, which is near 1,000 lines with the run and
// answer cases. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Carried, CarriedFile } from '../src/hand-offs.ts';
import type { HandOff } from '../src/schema.ts';
import { clockTime } from '../src/time.ts';
import type { After } from '../src/transition.ts';
import { decide } from '../src/work/decide.ts';
import type { EventOf } from '../src/work/events.ts';
import { handOffProblem } from '../src/work/hand-offs.ts';
import { applyChange, type LedgerLine, type WorkRows } from '../src/work/snapshot.ts';
import { threadRow, type FollowUp, type Thread } from '../src/work/state.ts';
import { leftBeforeStarting } from '../src/work/threads.ts';
import {
  answer,
  ask,
  changed,
  minutes,
  odd,
  pokesOf,
  reportsOf,
  rowsOf,
  run,
  T0,
  task,
  thread
} from './work-rows.ts';

const NOW = minutes(10);
const TITLE = 'Sort the invoices';
/** What the clock's wake after a usage-window hold tells the lead, as today. */
const WINDOW_RESET =
  'The usage window has reset, so hand-offs run again. Hand on the work the office held.';

/** The queued `resume` runs of `staffId` on thread `threadId`. */
const queuedResumes = (rows: WorkRows, staffId: string, threadId: number): FollowUp[] =>
  [...rows.followUps.values()].filter(
    (f) =>
      f.staffId === staffId &&
      f.threadId === threadId &&
      f.kind === 'resume' &&
      f.run.is === 'queued'
  );

/**
 * Runs each After in order, as the shell does after the commit: a Ledger
 * line reads as its title, a closure as its name once it ran. A closure that
 * throws fails the test.
 */
async function runAfters(after: After[]): Promise<string[]> {
  const done: string[] = [];
  for (const a of after) {
    if ('record' in a) done.push(a.record.title);
    else {
      await a.run();
      done.push(a.then);
    }
  }
  return done;
}

const LEAVE_LINE: LedgerLine = {
  kind: 'decision',
  actor: 'Sam',
  title: 'Let Ada go from the office'
};

/** The owner lets `staffId` go, with a stop closure that records each Odd whose runs it stops. */
function removal(
  staffId: string,
  about: [number, string][] = []
): { e: EventOf<'oddRemoved'>; stopped: string[] } {
  const stopped: string[] = [];
  return {
    e: {
      kind: 'oddRemoved',
      staffId,
      line: LEAVE_LINE,
      about: new Map(about),
      effects: { stopRuns: (id) => stopped.push(id) }
    },
    stopped
  };
}

const BACK_LINE: LedgerLine = { kind: 'decision', actor: 'Sam', title: 'Brought Jo back' };
const broughtBack = (staffId: string): EventOf<'oddBroughtBack'> => ({
  kind: 'oddBroughtBack',
  staffId,
  line: BACK_LINE
});

test("an Odd's leaving stops its runs through the event's closure, and deciding calls none", async () => {
  const rows = rowsOf({
    staff: [odd('ada'), odd('mo', { manager: true })],
    asks: [ask(1, 'ada'), ask(2, 'mo', { kind: 'remove', odd: 'ada' })]
  });
  const { e, stopped } = removal('ada');
  const d = decide(rows, e, NOW);
  assert.ok('after' in d);
  assert.deepEqual(stopped, [], 'deciding calls no closure');
  // The stop first, then each withdrawal's line in the order the asks closed, then the leaving's own.
  assert.deepEqual(await runAfters(d.after), [
    'stopRuns',
    'Withdrawn: Ask 1',
    'Withdrawn: Ask 2',
    'Let Ada go from the office'
  ]);
  assert.deepEqual(stopped, ['ada']);

  // An Odd someone let go a moment ago: nothing to write and nothing to stop.
  const gone = applyChange(rows, changed(d));
  const again = removal('ada');
  const second = decide(gone, again.e, NOW);
  assert.deepEqual(second, { change: { put: [], outside: [], result: null }, after: [] });
});

test('withdrawing asks as an Odd leaves or comes back calls no ask effect: every After but the stop is a Ledger line', async () => {
  // Asks whose yes does I/O: a grant, a catch-up, a leaving and a return.
  const rows = rowsOf({
    staff: [odd('ada'), odd('mo', { manager: true }), odd('jo', { leftAt: T0 })],
    asks: [
      ask(1, 'ada', { kind: 'access', access: { connector: 'gmail', level: 'read' } }),
      ask(2, 'ada', { kind: 'catch_up', catchUp: { jobId: 3, times: ['2026-11-01T08:00:00Z'] } }),
      ask(3, 'mo', { kind: 'remove', odd: 'ada' }),
      ask(4, 'mo', { kind: 'bring_back', odd: 'jo' }),
      ask(5, 'mo', { kind: 'bring_back', odd: 'jo' })
    ]
  });
  const leaving = decide(rows, removal('ada').e, NOW);
  assert.ok('after' in leaving);
  assert.deepEqual(
    leaving.after.flatMap((a) => ('then' in a ? [a.then] : [])),
    ['stopRuns']
  );
  await runAfters(leaving.after);

  const back = decide(rows, broughtBack('jo'), NOW);
  assert.ok('after' in back);
  assert.deepEqual(
    back.after.filter((a) => 'then' in a),
    []
  );
  await runAfters(back.after);
});

test("an Odd's leaving withdraws its asks and those about it, drops its tasks and fails its queued runs, leaving nothing open for it", () => {
  const giveBack: HandOff = { from: 'rico', title: TITLE, brief: 'Sort them.' };
  const rows = rowsOf({
    staff: [odd('ada'), odd('mo', { manager: true }), odd('rico')],
    threads: [thread(1, 'ada'), thread(2, 'rico')],
    asks: [
      ask(1, 'ada'),
      ask(2, 'mo', { kind: 'remove', odd: 'ada' }),
      ask(3, 'ada', { status: 'approved', decidedAt: T0 }),
      ask(4, 'rico')
    ],
    tasks: [task(1, 'ada'), task(2, 'ada', { status: 'done', doneAt: T0 }), task(3, 'rico')],
    followUps: [
      run(5, 'ada', 'resume', { is: 'queued' }, { threadId: 1 }),
      // Failed by an earlier leaving: ended, so never failed twice.
      run(
        6,
        'ada',
        'carry_out',
        { is: 'ended', outcome: 'failed', result: 'Gone', doneAt: T0, startedAt: null },
        { askId: 3 }
      ),
      // Work Rico handed her, yet to start: it fails back to Rico.
      run(7, 'ada', 'hand_off', { is: 'queued' }, { threadId: 2, handOff: giveBack }),
      // Going now: the stop closure ends it, and its own finish lands after.
      run(8, 'ada', 'first_day', { is: 'running', startedAt: T0, unparked: null })
    ]
  });
  const c = changed(decide(rows, removal('ada', [[5, TITLE]]).e, NOW));
  assert.deepEqual(c.outside.slice(0, 2), [
    { kind: 'leave', staffId: 'ada', at: NOW },
    { kind: 'cancelPokes', staffId: 'ada' }
  ]);
  const after = applyChange(rows, c);

  assert.deepEqual(after.asks.get(1), {
    ...rows.asks.get(1),
    status: 'denied',
    decidedAt: NOW,
    reason: 'Ada left the office, so this will not go ahead.'
  });
  assert.deepEqual(after.asks.get(2), {
    ...rows.asks.get(2),
    status: 'denied',
    decidedAt: NOW,
    reason: 'Ada left the office already.'
  });
  assert.deepEqual(after.asks.get(3), rows.asks.get(3));
  assert.deepEqual(after.asks.get(4), rows.asks.get(4));

  assert.deepEqual(after.tasks.get(1), {
    ...rows.tasks.get(1),
    status: 'dropped',
    doneAt: NOW,
    withdrawn: true,
    note: 'Ada left the office, so this will not go ahead.'
  });
  assert.deepEqual(after.tasks.get(2), rows.tasks.get(2));
  assert.deepEqual(after.tasks.get(3), rows.tasks.get(3));

  const failedRun = {
    is: 'ended',
    outcome: 'failed',
    result: 'Ada left the office before starting this.',
    doneAt: NOW,
    startedAt: null
  };
  assert.deepEqual(after.followUps.get(5)?.run, failedRun);
  assert.deepEqual(after.followUps.get(7)?.run, failedRun);
  for (const [id, why] of [
    [6, 'a run an earlier leaving failed is not written again'],
    [8, 'a run going now is left to the stop closure']
  ] as const)
    assert.ok(!c.put.some((p) => p.table === 'followUps' && 'row' in p && p.row.id === id), why);
  // Rico hears its hand-off failed, in a pick-up on its own work.
  const back = [...after.followUps.values()].filter((f) => !rows.followUps.has(f.id));
  assert.deepEqual(
    back.map((f) => [f.staffId, f.kind, f.threadId, f.run.is]),
    [['rico', 'handed_back', 2, 'queued']]
  );
  // Work she led reports nothing, and the hand-off goes back to its lead, not the desk.
  assert.deepEqual(reportsOf(c), []);

  // Nothing open is left for her: no ask of hers or about her, no task, no run to start.
  assert.deepEqual(
    [...after.asks.values()].filter(
      (a) => a.status === 'open' && (a.staffId === 'ada' || a.odd === 'ada')
    ),
    []
  );
  assert.deepEqual(
    [...after.tasks.values()].filter((t) => t.status === 'open' && t.staffId === 'ada'),
    []
  );
  assert.deepEqual(
    [...after.followUps.values()].filter((f) => f.staffId === 'ada' && f.run.is === 'queued'),
    []
  );
});

test("a lead's leaving stops every thread it leads, done and failed too, and the stop clears the whole park", () => {
  const rows = rowsOf({
    staff: [odd('ada'), odd('mo', { manager: true }), odd('rico')],
    threads: [
      thread(1, 'ada', { park: { on: 'time', at: minutes(60) } }),
      thread(2, 'ada', { park: { on: 'task', task: 3 } }),
      thread(3, 'ada', { park: { on: 'window', at: minutes(60), ask: 9 } }),
      thread(4, 'ada', { status: 'done', endedAt: T0 }),
      thread(5, 'ada', { status: 'failed', endedAt: T0 }),
      thread(6, 'ada', { status: 'stopped', endedAt: T0 }),
      thread(7, 'rico', { park: { on: 'time', at: minutes(60) } })
    ],
    asks: [ask(9, 'mo', { kind: 'window' })],
    tasks: [task(3, null)]
  });
  const c = changed(decide(rows, removal('ada').e, NOW));
  const after = applyChange(rows, c);
  for (const id of [1, 2, 3, 4, 5]) {
    const row = threadRow(after.threads.get(id) as Thread);
    assert.deepEqual(
      [row.status, row.endedAt, row.resumeAt, row.heldBy, row.resumeOnTask],
      ['stopped', NOW, null, null, null],
      `thread ${id}`
    );
  }
  assert.ok(
    !c.put.some((p) => p.table === 'threads' && 'row' in p && p.row.id === 6),
    'work stopped already is not written again'
  );
  assert.deepEqual(after.threads.get(7), rows.threads.get(7));
  // As today, the stop leaves the usage window's ask on the desk until the owner or the reset.
  assert.equal(after.asks.get(9)?.status, 'open');
});

/**
 * Ada leads thread 1. Rico finished the work she handed him, and her pick-up
 * of his result has yet to start when she leaves.
 */
function pickUpQueued(result: Partial<HandOff>): WorkRows {
  return rowsOf({
    staff: [odd('ada'), odd('rico')],
    threads: [thread(1, 'ada')],
    followUps: [
      run(
        1,
        'rico',
        'hand_off',
        { is: 'ended', outcome: 'done', result: 'Sorted', doneAt: T0, startedAt: T0 },
        { threadId: 1, handOff: { from: 'ada', title: TITLE, brief: 'Sort them.' } }
      ),
      run(
        2,
        'ada',
        'handed_back',
        { is: 'queued' },
        {
          threadId: 1,
          handOff: {
            from: 'rico',
            title: TITLE,
            brief: 'Sort them.',
            outcome: 'done',
            id: 1,
            ...result
          }
        }
      )
    ]
  });
}

test("a lead's leaving fails its queued pick-up of a colleague's result with no report, and the colleague pokes the owner once", async () => {
  const rows = pickUpQueued({});
  const d = decide(rows, removal('ada', [[2, TITLE]]).e, NOW);
  const c = changed(d);
  assert.deepEqual(reportsOf(c), []);
  assert.deepEqual(pokesOf(c), [
    {
      kind: 'poke',
      staffId: 'rico',
      message: `Rico finished "${TITLE}", but could not hand it back to Ada because Ada is no longer here.`
    }
  ]);
  assert.ok('after' in d);
  // The stop, the run's own line, the one for the result no lead takes, then the leaving's.
  assert.deepEqual(await runAfters(d.after), [
    'stopRuns',
    `Could not pick up what a colleague finished: ${TITLE}`,
    `Finished, but Ada has left: ${TITLE}`,
    'Let Ada go from the office'
  ]);
});

test("a lead's leaving pokes for no result that is the owner's own answer, or that still waits on the desk", () => {
  for (const result of [{ answered: true }, { outcome: 'waiting' as const }]) {
    const c = changed(decide(pickUpQueued(result), removal('ada', [[2, TITLE]]).e, NOW));
    assert.deepEqual(pokesOf(c), [], JSON.stringify(result));
    assert.deepEqual(reportsOf(c), [], JSON.stringify(result));
  }
});

test('an Odd let go, brought back and let go again never fails a run twice, and the run its first leaving failed never starts', () => {
  const rows = rowsOf({
    staff: [odd('ada')],
    threads: [thread(1, 'ada')],
    followUps: [
      run(5, 'ada', 'resume', { is: 'queued' }, { threadId: 1 }),
      run(6, 'ada', 'task_done', { is: 'queued' }, { taskId: 2 })
    ]
  });
  const gone = applyChange(rows, changed(decide(rows, removal('ada').e, NOW)));
  const back = applyChange(gone, changed(decide(gone, broughtBack('ada'), minutes(20))));
  assert.equal(back.staff.get('ada')?.leftAt, null);
  for (const id of [5, 6]) {
    assert.equal(back.followUps.get(id)?.run.is, 'ended', `run ${id}`);
    assert.ok('refused' in decide(back, { kind: 'runClaimed', id }, minutes(21)), `run ${id}`);
  }
  const second = changed(decide(back, removal('ada').e, minutes(30)));
  assert.deepEqual(
    second.put.filter((p) => p.table === 'followUps'),
    [],
    'the second leaving fails nothing its first failed'
  );
});

test("after a lead is brought back, the owner's answer on its work starts a pick-up instead of joining the one its leaving failed", () => {
  const rows = rowsOf({
    staff: [odd('ada')],
    threads: [thread(1, 'ada')],
    // The office's own task on her work, which her leaving leaves on the desk.
    tasks: [task(7, null, { threadId: 1 })],
    followUps: [run(5, 'ada', 'resume', { is: 'queued' }, { threadId: 1, note: 'An answer' })]
  });
  const gone = applyChange(rows, changed(decide(rows, removal('ada').e, NOW)));
  const back = applyChange(gone, changed(decide(gone, broughtBack('ada'), minutes(20))));
  const done: EventOf<'taskEnded'> = {
    kind: 'taskEnded',
    id: 7,
    ended: 'dropped',
    note: 'no',
    inChat: false
  };
  const answered = applyChange(back, changed(decide(back, done, minutes(30))));
  assert.deepEqual(answered.followUps.get(5), back.followUps.get(5), 'the failed run stays failed');
  assert.equal(queuedResumes(answered, 'ada', 1).length, 1);
});

test('bringing an Odd back withdraws the other open asks to bring it back, and leaves an ask to let it go open', async () => {
  const rows = rowsOf({
    staff: [odd('jo', { leftAt: T0 }), odd('kai', { leftAt: T0 }), odd('mo', { manager: true })],
    asks: [
      ask(4, 'mo', { kind: 'bring_back', odd: 'jo' }),
      ask(5, 'mo', { kind: 'bring_back', odd: 'jo' }),
      ask(6, 'mo', { kind: 'remove', odd: 'jo' }),
      ask(7, 'mo', { kind: 'bring_back', odd: 'kai' }),
      ask(8, 'jo', { status: 'denied', decidedAt: T0 })
    ]
  });
  const d = decide(rows, broughtBack('jo'), NOW);
  const c = changed(d);
  assert.deepEqual(c.outside, [{ kind: 'comeBack', staffId: 'jo' }]);
  const after = applyChange(rows, c);
  assert.equal(after.staff.get('jo')?.leftAt, null);
  for (const id of [4, 5])
    assert.deepEqual(after.asks.get(id), {
      ...rows.asks.get(id),
      status: 'denied',
      decidedAt: NOW,
      reason: 'Jo is back in the office already.'
    });
  // What it had open when it left stays closed, and a withdrawal starts no run.
  for (const id of [6, 7, 8]) assert.deepEqual(after.asks.get(id), rows.asks.get(id));
  assert.equal(after.followUps.size, 0);
  assert.ok('after' in d);
  assert.deepEqual(await runAfters(d.after), [
    'Withdrawn: Ask 4',
    'Withdrawn: Ask 5',
    'Brought Jo back'
  ]);

  // An Odd the rows do not hold: nothing to write.
  assert.deepEqual(decide(rows, broughtBack('zed'), NOW), {
    change: { put: [], outside: [], result: null },
    after: []
  });
});

/** Ada leads thread 1, parked as `park` says, with a resume of hers on it queued when `queued` is given. */
function parkedRows(park: Thread & { status: 'open' }, queued?: string | null): WorkRows {
  return rowsOf({
    staff: [odd('ada'), odd('mo', { manager: true })],
    threads: [park, thread(2, 'ada')],
    asks: [ask(9, 'mo', { kind: 'window' })],
    followUps: [
      ...(queued === undefined
        ? []
        : [run(5, 'ada', 'resume', { is: 'queued' }, { threadId: 1, note: queued })]),
      // A queued resume on her other work, which this wake leaves alone.
      run(6, 'ada', 'resume', { is: 'queued' }, { threadId: 2, note: 'Other work' })
    ]
  });
}
const wake: EventOf<'clockWoke'> = { kind: 'clockWoke', threadId: 1 };
const timePark = thread(1, 'ada', { park: { on: 'time', at: NOW } }) as Thread & { status: 'open' };
const windowPark = thread(1, 'ada', {
  park: { on: 'window', at: NOW, ask: 9 }
}) as Thread & { status: 'open' };

test("a parked thread's wake while a resume for that lead and thread is already queued leaves exactly one queued resume", () => {
  for (const park of [timePark, windowPark]) {
    const rows = parkedRows(park, 'Rico finished');
    const after = applyChange(rows, changed(decide(rows, wake, NOW)));
    assert.equal(queuedResumes(after, 'ada', 1).length, 1, park.park.on);
    assert.equal(after.followUps.size, rows.followUps.size, park.park.on);
    assert.deepEqual(after.threads.get(1), { ...park, park: { on: 'none' } }, park.park.on);
    assert.deepEqual(after.followUps.get(6), rows.followUps.get(6), park.park.on);
  }
  // A time park adds no line to the queued resume.
  const rows = parkedRows(timePark, 'Rico finished');
  assert.deepEqual(applyChange(rows, changed(decide(rows, wake, NOW))).followUps, rows.followUps);
});

test("the clock's wake after a window hold keeps the reset note on the joined resume, and starts one with it when none waits", () => {
  const joined = parkedRows(windowPark, 'Rico finished');
  const onJoined = applyChange(joined, changed(decide(joined, wake, NOW)));
  assert.deepEqual(onJoined.followUps.get(5), {
    ...joined.followUps.get(5),
    note: `Rico finished\n${WINDOW_RESET}`
  });

  const empty = parkedRows(windowPark, null);
  const onEmpty = applyChange(empty, changed(decide(empty, wake, NOW)));
  assert.equal(onEmpty.followUps.get(5)?.note, WINDOW_RESET);

  const none = parkedRows(windowPark);
  const fresh = queuedResumes(applyChange(none, changed(decide(none, wake, NOW))), 'ada', 1);
  assert.deepEqual(
    fresh.map((f) => f.note),
    [WINDOW_RESET]
  );
  // After a time park the new pick-up has no note.
  const timed = parkedRows(timePark);
  assert.deepEqual(
    queuedResumes(applyChange(timed, changed(decide(timed, wake, NOW))), 'ada', 1).map(
      (f) => f.note
    ),
    [null]
  );
});

test("the clock's wake leaves the window's unanswered ask on the desk, for the clock to take off at the reset, and wakes nothing not due", () => {
  const rows = parkedRows(windowPark);
  const woke = applyChange(rows, changed(decide(rows, wake, NOW)));
  assert.deepEqual(woke.asks.get(9), rows.asks.get(9));
  assert.deepEqual(woke.threads.get(1), { ...windowPark, park: { on: 'none' } });

  const early = decide(rows, wake, minutes(9));
  assert.deepEqual(early, { change: { put: [], outside: [], result: null }, after: [] });
});

const notesFile: CarriedFile = {
  real: 'attachments/notes.md',
  name: 'notes.md',
  named: 'notes.md'
};

/** Ada leads thread 1 and Rico is on Claude Code; the window is past its guard when `window` says so. */
function handOffRows(window: WorkRows['window'] = null): WorkRows {
  const rows = rowsOf({
    staff: [odd('ada'), odd('rico'), odd('mo', { manager: true })],
    threads: [thread(1, 'ada')]
  });
  return {
    ...rows,
    window,
    prepared: { sharing: { from: 'ada', title: TITLE, brief: 'Sort them.' } }
  };
}
const handOff = (
  thread: EventOf<'handedOff'>['thread'],
  over: Partial<EventOf<'handedOff'>> = {}
): EventOf<'handedOff'> => ({
  kind: 'handedOff',
  from: 'ada',
  to: 'rico',
  work: { title: TITLE, brief: 'Sort them.' },
  thread,
  run: 'key-1',
  carry: [notesFile],
  ...over
});
const RESETS = minutes(70);

test("existing work held on a new window ask points heldBy at that ask's ref, not an id the draft made up", () => {
  // Rico holds the work, so the settle after the hold writes it again, and that write must point too.
  const rows: WorkRows = {
    ...handOffRows({ share: 0.9, resetsAt: RESETS, ask: null }),
    threads: new Map([[1, thread(1, 'ada', { holderId: 'rico' })]])
  };
  const c = changed(decide(rows, handOff({ id: 1 }), NOW));
  assert.deepEqual(c.result, { held: { window: 1, share: 0.9, at: clockTime(RESETS, NOW) } });
  // The new ask goes in first, filed under the manager, and every write that holds the work points at it.
  const askAt = c.put.findIndex((p) => p.table === 'asks' && 'ref' in p);
  assert.ok(askAt >= 0);
  const newAsk = c.put[askAt];
  assert.ok('ref' in newAsk && newAsk.table === 'asks');
  assert.equal(newAsk.ref, 'window ask');
  assert.deepEqual([newAsk.insert.kind, newAsk.insert.staffId], ['window', 'mo']);
  // The run's key goes on the work first, before the hold; each write from the hold on points.
  const holds = c.put.flatMap((p, at) =>
    p.table === 'threads' && 'row' in p && p.row.status === 'open' && p.row.park.on === 'window'
      ? [{ p, at }]
      : []
  );
  assert.equal(holds.length, 2, 'the hold, and the settle after it');
  for (const { p, at } of holds) {
    assert.ok(at > askAt, 'the ask goes in before the work that points at it');
    assert.deepEqual(p.points, { heldBy: 'window ask' });
  }
  // The held hand-off carries nothing and starts no run.
  assert.deepEqual(c.outside, []);
  assert.ok(!c.put.some((p) => p.table === 'followUps'));
  const after = applyChange(rows, c);
  const held = after.threads.get(1);
  assert.ok(held?.status === 'open' && held.park.on === 'window');
  assert.equal(held.park.at, RESETS);
  assert.equal(after.asks.get(held.park.ask)?.kind, 'window');

  // With this window's ask open already, the hold names it and raises none.
  const asked = handOffRows({ share: 0.9, resetsAt: RESETS, ask: { id: 9, status: 'open' } });
  const c2 = changed(decide(asked, handOff({ id: 1 }), NOW));
  assert.ok(!c2.put.some((p) => p.table === 'asks'));
  assert.ok(c2.put.every((p) => p.points === undefined));
  const held2 = applyChange(asked, c2).threads.get(1);
  assert.deepEqual(held2?.status === 'open' && held2.park, { on: 'window', at: RESETS, ask: 9 });
});

test('a hand-off on new work names the work, its run and its carried files by Inserted refs, and its run points at the work by ref', () => {
  const rows = handOffRows();
  const taken = changed(decide(rows, handOff({ open: { title: TITLE, hubId: 'ada' } }), NOW));
  assert.deepEqual(taken.result, { id: { ref: 'run 1' }, thread: { ref: 'thread' }, left: 7 });
  // The draft's id for the new work is a guess the database does not keep, so the run points at its ref.
  const runPut = taken.put.find((p) => p.table === 'followUps');
  assert.deepEqual(runPut && 'ref' in runPut && runPut.points, { threadId: 'thread' });
  assert.deepEqual(taken.outside, [
    { kind: 'carryFiles', threadId: { ref: 'thread' }, from: 'ada', files: [notesFile] }
  ]);
  const after = applyChange(rows, taken);
  const opened = [...after.threads.values()].find((t) => !rows.threads.has(t.id));
  assert.ok(opened);
  assert.deepEqual([opened.hubId, opened.runs, opened.handOffsUsed], ['ada', ['key-1'], 1]);
  const started = [...after.followUps.values()].filter((f) => !rows.followUps.has(f.id));
  assert.deepEqual(
    started.map((f) => [f.staffId, f.kind, f.threadId]),
    [['rico', 'hand_off', opened.id]]
  );

  // A goal's new work under its manager opens though the hand-off does not go: no run, no files.
  const goal = { open: { title: TITLE, hubId: 'mo', goalId: 3 } };
  const notLed = changed(decide(rows, handOff(goal), NOW));
  assert.deepEqual(notLed.result, { held: { notLed: { ref: 'thread' } } });
  assert.deepEqual(notLed.outside, []);
  assert.deepEqual(
    notLed.put.map((p) => p.table),
    ['threads']
  );

  // New work the window holds: its problem names it by ref, and its insert points at the new ask.
  const full = handOffRows({ share: 0.9, resetsAt: RESETS, ask: null });
  const held = changed(decide(full, handOff({ open: { title: TITLE, hubId: 'ada' } }), NOW));
  assert.deepEqual(held.result, {
    held: { window: { ref: 'thread' }, share: 0.9, at: clockTime(RESETS, NOW) }
  });
  const insert = held.put.find((p) => p.table === 'threads' && 'ref' in p);
  assert.deepEqual(insert?.points, { heldBy: 'window ask' });
  assert.deepEqual(held.outside, []);
});

test('a yes to a hand-off held for a colleague who left since starts no run for them, and the lead hears once that it never went', () => {
  const rows: WorkRows = {
    ...rowsOf({
      staff: [odd('ada'), odd('rico', { leftAt: T0 })],
      threads: [thread(1, 'ada', { handOffsUsed: 8 })],
      asks: [
        ask(7, 'ada', {
          kind: 'hand_offs',
          threadId: 1,
          held: { from: 'ada', to: 'rico', title: TITLE, brief: 'Sort them.' }
        })
      ]
    }),
    prepared: { sharing: { from: 'ada', title: TITLE, brief: 'Sort them.' } }
  };
  const after = applyChange(rows, changed(decide(rows, answer(7, 'approve'), NOW)));
  const added = [...after.followUps.values()].filter((f) => !rows.followUps.has(f.id));
  assert.deepEqual(
    added.map((f) => [f.staffId, f.threadId]),
    [['ada', 1]],
    "one run, the lead's, and none for Rico"
  );
  const gone = leftBeforeStarting('Rico');
  assert.equal((added[0].note ?? '').split(gone).length - 1, 1, `once in: ${added[0].note}`);
});

test('handOffProblem words a hand-off that did not go on work it does not lead, or that the usage window holds', () => {
  assert.equal(
    handOffProblem({ notLed: 12 }),
    'Work 12 is not work you lead. Hand off on work you lead, or start new work.'
  );
  assert.equal(
    handOffProblem({ window: 12, share: 0.904, at: '2:00 pm' }),
    "The office holds new hand-offs: the Claude plan's usage window is at 90%. Work 12 picks back up when the window resets at 2:00 pm, or sooner if the owner lets hand-offs run. Say so, and finish this run."
  );
});

/** Ada leads thread 1, and Rico works on it. */
const tellRows = (over: { ada?: Date; queued?: string } = {}): WorkRows =>
  rowsOf({
    staff: [odd('ada', { leftAt: over.ada ?? null }), odd('rico')],
    threads: [thread(1, 'ada')],
    followUps:
      over.queued === undefined
        ? []
        : [run(5, 'ada', 'resume', { is: 'queued' }, { threadId: 1, note: over.queued })]
  });
const landed: Carried = { named: 'notes.md', at: 'threads/1/rico/notes.md' };
const notCome: Carried = { named: 'big.mov', why: 'the office cannot open it' };
const tell = (files: EventOf<'toldLead'>['files']): EventOf<'toldLead'> => ({
  kind: 'toldLead',
  staffId: 'rico',
  threadId: 1,
  said: 'Please send it Friday, thanks',
  words: 'send it Friday',
  reading: 'Sam wants it sent on Friday.',
  exchange: 'Last in that chat: Sam asked about the invoices.',
  worksOn: new Set([1]),
  files
});
const TOLD =
  "Rico passed you what Sam told them in chat about this work. You decide what comes of it and hand on any work it needs; Rico does nothing more with it. Sam's words: send it Friday Rico's own reading, which is not Sam's words: Sam wants it sent on Friday. Last in that chat: Sam asked about the invoices.";

test("telling the lead writes today's note from what the entry's copy gave, naming a file it could not copy as not come, and copies nothing itself", () => {
  const rows = tellRows();
  const both = changed(decide(rows, tell([landed, notCome]), NOW));
  assert.deepEqual(both.result, { lead: 'Ada', files: [landed, notCome] });
  assert.deepEqual(both.outside, []);
  assert.deepEqual(
    queuedResumes(applyChange(rows, both), 'ada', 1).map((f) => f.note),
    [
      `${TOLD} Sam attached a file to that message, now in this work: notes.md at threads/1/rico/notes.md. One file Sam attached did not come: big.mov, since the office cannot open it.`
    ]
  );

  // No file landed: the words still go.
  const none = changed(decide(rows, tell([notCome]), NOW));
  assert.deepEqual(none.outside, []);
  assert.deepEqual(none.result, { lead: 'Ada', files: [notCome] });
  assert.deepEqual(
    queuedResumes(applyChange(rows, none), 'ada', 1).map((f) => f.note),
    [`${TOLD} One file Sam attached did not come: big.mov, since the office cannot open it.`]
  );

  // With no files the result names none, and a pick-up still queued takes the words as one more line.
  const queued = tellRows({ queued: 'Rico finished' });
  const joined = changed(decide(queued, tell([]), NOW));
  assert.deepEqual(joined.result, { lead: 'Ada' });
  const after = applyChange(queued, joined);
  assert.equal(after.followUps.size, 1);
  assert.equal(after.followUps.get(5)?.note, `Rico finished\n${TOLD}`);
});

test("a tell that lands after its lead left is refused, so the words are passed only where the lead's pick-up holds them", () => {
  // Told first: the pick-up holds the words, and the leaving fails it with a line naming the work.
  const rows = tellRows();
  const told = applyChange(rows, changed(decide(rows, tell([]), NOW)));
  const [pickUp] = queuedResumes(told, 'ada', 1);
  const left = applyChange(told, changed(decide(told, removal('ada').e, minutes(11))));
  assert.equal(left.followUps.get(pickUp.id)?.run.is, 'ended');

  // Left first: the leaving stopped the work, so the tell is refused and no pick-up holds the words.
  const gone = applyChange(rows, changed(decide(rows, removal('ada').e, NOW)));
  assert.deepEqual(decide(gone, tell([]), minutes(11)), {
    refused: 'Work 1 has stopped, so nothing more runs on it. Tell Sam so.'
  });
});

test('an Odd that left hands nothing on, and a tell to a lead that left reaches nobody, though the work is still open', () => {
  // Driven: her leaving stops her work, so a hand-off landing as she left is refused first by her leaving.
  const rows = handOffRows();
  const gone = applyChange(rows, changed(decide(rows, removal('ada').e, NOW)));
  assert.deepEqual(decide(gone, handOff({ id: 1 }), minutes(11)), {
    refused: 'You left the office, so you hand nothing on.'
  });
  assert.deepEqual(decide(gone, handOff({ open: { title: TITLE, hubId: 'ada' } }), minutes(11)), {
    refused: 'You left the office, so you hand nothing on.'
  });
  // By hand: no event leaves a departed lead's work open, so these rows are the decider's own guard.
  assert.deepEqual(decide(tellRows({ ada: T0 }), tell([]), NOW), {
    refused: 'Ada left the office, so work 1 has no lead to tell. Tell Sam so.'
  });
});

test('stopped work refuses a hand-off and a tell', () => {
  const stopped = (rows: WorkRows): WorkRows => ({
    ...rows,
    threads: new Map([[1, thread(1, 'ada', { status: 'stopped', endedAt: T0 })]])
  });
  assert.deepEqual(decide(stopped(handOffRows()), handOff({ id: 1 }), NOW), {
    refused: 'Work 1 has ended (stopped). Nothing more runs on it. Tell the owner so.'
  });
  assert.deepEqual(decide(stopped(tellRows()), tell([]), NOW), {
    refused: 'Work 1 has stopped, so nothing more runs on it. Tell Sam so.'
  });
});
