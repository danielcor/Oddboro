// What the run deciders make of one event on rows in memory: the cases a
// past bug or a ruling names. Pure: no database.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StaffRow } from '../src/office.ts';
import type { AccessRequest, HandOff, Step } from '../src/schema.ts';
import { GOAL_SET } from '../src/work/asks.ts';
import { decide } from '../src/work/decide.ts';
import type { Claimed, EventOf, RunEnded } from '../src/work/events.ts';
import { applyChange, type Change, type WorkRows } from '../src/work/snapshot.ts';
import {
  askRow,
  threadRow,
  type Ask,
  type FollowUp,
  type Park,
  type Thread
} from '../src/work/state.ts';
import {
  answer,
  ask,
  changed,
  minutes,
  odd,
  pokesOf,
  recordingEffects,
  reportsOf,
  rowsOf,
  run,
  T0,
  task,
  thread
} from './work-rows.ts';

const NOW = minutes(10);
const TITLE = 'Sort the invoices';

/** The runs a change starts: the follow-ups it adds to the rows. */
function started(rows: WorkRows, c: Change): FollowUp[] {
  return [...applyChange(rows, c).followUps.values()].filter((f) => !rows.followUps.has(f.id));
}

/** The owner's end to task `id`, off the chat unless `over` says so. */
const ended = (
  id: number,
  how: EventOf<'taskEnded'>['ended'],
  over: Partial<EventOf<'taskEnded'>> = {}
): EventOf<'taskEnded'> => ({
  kind: 'taskEnded',
  id,
  ended: how,
  note: null,
  inChat: false,
  ...over
});

const connectGmail: Step = {
  text: 'Sign in to Gmail',
  done: false,
  action: { kind: 'oauth', connector: 'gmail' }
};

/**
 * Ada led thread 1 and left the office, which stopped it. Rico did the work
 * she handed him, and her pick-up of his result was running when she left.
 */
function leadLeftWhilePickingUp(result: Partial<HandOff>): WorkRows {
  return rowsOf({
    staff: [odd('ada', { leftAt: T0 }), odd('rico')],
    threads: [thread(1, 'ada', { status: 'stopped', endedAt: T0 })],
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
        { is: 'running', startedAt: T0, unparked: null },
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

const failed: RunEnded = { outcome: 'failed', result: 'Stopped', joined: [] };

test("a lead removed while it picks up a colleague's result leaves nothing on the desk, and the colleague pokes the owner once", () => {
  const rows = leadLeftWhilePickingUp({});
  const d = decide(rows, { kind: 'runFinished', id: 2, about: TITLE, ended: failed }, NOW);
  const c = changed(d);
  assert.deepEqual(reportsOf(c), []);
  assert.deepEqual(pokesOf(c), [
    {
      kind: 'poke',
      staffId: 'rico',
      message: `Rico finished "${TITLE}", but could not hand it back to Ada because Ada is no longer here.`
    }
  ]);
  // The Ledger gets the run's own line first, then the one for the result no lead takes.
  assert.ok('after' in d);
  assert.deepEqual(
    d.after.map((a) => ('record' in a ? a.record.title : a.then)),
    [
      `Could not pick up what a colleague finished: ${TITLE}`,
      `Finished, but Ada has left: ${TITLE}`
    ]
  );
});

test("no 'could not hand it back' poke when the result is the owner's own answer", () => {
  const rows = leadLeftWhilePickingUp({ answered: true });
  const c = changed(decide(rows, { kind: 'runFinished', id: 2, about: TITLE, ended: failed }, NOW));
  assert.deepEqual(pokesOf(c), []);
  assert.deepEqual(reportsOf(c), []);
});

test("no poke when the colleague's run ended waiting, since its item is on the desk already", () => {
  const rows = leadLeftWhilePickingUp({ outcome: 'waiting' });
  const c = changed(decide(rows, { kind: 'runFinished', id: 2, about: TITLE, ended: failed }, NOW));
  assert.deepEqual(pokesOf(c), []);
  assert.deepEqual(reportsOf(c), []);
});

test('an Odd brought back does not start work its leaving already failed', () => {
  // Jo's leaving failed this run before it started; she is back now.
  const rows = rowsOf({
    staff: [odd('jo')],
    followUps: [
      run(1, 'jo', 'task_done', {
        is: 'ended',
        outcome: 'failed',
        result: 'Jo left.',
        doneAt: T0,
        startedAt: null
      })
    ]
  });
  assert.deepEqual(decide(rows, { kind: 'runClaimed', id: 1 }, NOW), {
    refused: 'That run is not waiting to start.'
  });
});

test('a run that ended already is refused a second finish', () => {
  const rows = leadLeftWhilePickingUp({});
  const first = changed(
    decide(rows, { kind: 'runFinished', id: 2, about: TITLE, ended: failed }, NOW)
  );
  const after = applyChange(rows, first);
  assert.deepEqual(
    decide(after, { kind: 'runFinished', id: 2, about: TITLE, ended: failed }, minutes(11)),
    { refused: 'That run has ended already.' }
  );
});

/** Ada's pick-up on thread 1 lifted her park on task 2 as it started. */
function parkLifted(taskOpen: boolean): WorkRows {
  return rowsOf({
    staff: [odd('ada')],
    threads: [thread(1, 'ada')],
    tasks: [task(2, 'ada', taskOpen ? {} : { status: 'done', doneAt: minutes(5) })],
    followUps: [
      run(
        1,
        'ada',
        'resume',
        { is: 'running', startedAt: T0, unparked: { task: 2 } },
        { threadId: 1 }
      )
    ]
  });
}

test('a failed run gives back the park its claim lifted while the task is still open', () => {
  const rows = parkLifted(true);
  const after = applyChange(
    rows,
    changed(decide(rows, { kind: 'runFinished', id: 1, about: 'the work', ended: failed }, NOW))
  );
  const t = after.threads.get(1);
  assert.deepEqual(t?.status === 'open' && t.park, { on: 'task', task: 2 });
  assert.equal(after.followUps.size, 1);
});

test('a failed run that gives back a park on a task that ended wakes the work in the same change', () => {
  const rows = parkLifted(false);
  const d = decide(rows, { kind: 'runFinished', id: 1, about: 'the work', ended: failed }, NOW);
  const after = applyChange(rows, changed(d));
  const t = after.threads.get(1);
  assert.deepEqual(t?.status === 'open' && t.park, { on: 'none' });
  const woken = [...after.followUps.values()].filter((f) => f.id !== 1);
  assert.equal(woken.length, 1);
  assert.equal(woken[0].staffId, 'ada');
  assert.equal(woken[0].kind, 'resume');
  assert.equal(woken[0].threadId, 1);
  assert.equal(woken[0].run.is, 'queued');
  // Ada's task_done run for the task started as the task ended, before this wake.
  assert.match(woken[0].note ?? '', /finished "Task 2".*was set going when the task ended/);
  // No step after the commit does the wake: the only After is the Ledger line.
  assert.ok('after' in d);
  assert.deepEqual(
    d.after.map((a) => ('record' in a ? a.record.kind : a.then)),
    ['work']
  );
});

test("a lead's claim never lifts a usage-window hold, which is the office's", () => {
  const held: Thread = thread(1, 'ada', { park: { on: 'window', at: minutes(60), ask: 7 } });
  const rows = rowsOf({
    staff: [odd('ada')],
    threads: [held],
    followUps: [run(1, 'ada', 'resume', { is: 'queued' }, { threadId: 1 })]
  });
  const c = changed(decide(rows, { kind: 'runClaimed', id: 1 }, NOW));
  const claimed: Claimed = c.result;
  assert.equal(claimed.unparked, undefined);
  assert.deepEqual(applyChange(rows, c).threads.get(1), held);
});

test("a project's result owed only while its work is open puts nothing once that work ended, and is not refused", () => {
  // finishProject in project-sessions.ts skips the pick-up on ended work and
  // writes the result's report itself, outside this decider, either way.
  const rows = rowsOf({
    staff: [odd('ada')],
    threads: [thread(1, 'ada', { status: 'done', endedAt: T0 })]
  });
  const owed = { staffId: 'ada', kind: 'resume', threadId: 1, note: 'The result.' } as const;
  assert.deepEqual(decide(rows, { kind: 'runQueued', run: owed, onlyWhileOpen: true }, NOW), {
    change: { put: [], outside: [], result: null },
    after: []
  });
  // Every other source puts its run on ended work too.
  const put = changed(decide(rows, { kind: 'runQueued', run: owed }, NOW)).put;
  const added: FollowUp[] = [
    ...applyChange(rows, { put, outside: [], result: null }).followUps.values()
  ];
  assert.equal(added.length, 1);
  assert.equal(added[0].threadId, 1);
});

// The owner's answers: what each decider starts, and what it leaves to after the commit.

test("an answer's I/O is an After that calls the event's own closure, and deciding calls none", async () => {
  const another: AccessRequest = { connector: 'gmail', level: 'read', another: 'gmail' };
  const catchUp = { jobId: 3, times: ['2026-11-01T08:00:00Z'] };
  const rows = rowsOf({
    staff: [odd('ada'), odd('mo', { manager: true }), odd('rico'), odd('jo', { leftAt: T0 })],
    asks: [
      ask(1, 'ada', { kind: 'access', access: another }),
      ask(2, 'ada', { kind: 'catch_up', catchUp }),
      ask(3, 'mo', { kind: 'remove', odd: 'rico' }),
      ask(4, 'mo', { kind: 'bring_back', odd: 'jo' })
    ]
  });
  /** A yes to ask `id`: what each After is, in order, and the calls running them made. */
  async function yes(id: number, granted?: { task: boolean; connector: string }) {
    const { effects, calls } = recordingEffects(granted);
    const d = decide(rows, answer(id, 'approve', { effects }), NOW);
    assert.ok('after' in d);
    assert.deepEqual(calls, [], 'deciding calls no effect');
    const order: string[] = [];
    for (const a of d.after) {
      if ('record' in a) order.push('record');
      else {
        order.push(a.then);
        await a.run();
      }
    }
    return { order, calls };
  }

  // Another Google account, connected at once: no connect task, so the work picks up now.
  const grant = await yes(1, { task: false, connector: 'gmail-2' });
  assert.deepEqual(grant.order, ['record', 'grantAccess']);
  const approved = askRow(
    ask(1, 'ada', { kind: 'access', access: another, status: 'approved', decidedAt: NOW })
  );
  assert.deepEqual(grant.calls, [
    { name: 'grantAccess', args: ['ada', another, 1] },
    { name: 'pointAsksAtConnector', args: [[1], { ...another, connector: 'gmail-2' }] },
    { name: 'carryOutTogether', args: [[approved]] }
  ]);

  const owed = await yes(2);
  assert.deepEqual(owed.order, ['record', 'oweCatchUp']);
  const caughtUp = askRow(
    ask(2, 'ada', { kind: 'catch_up', catchUp, status: 'approved', decidedAt: NOW })
  );
  assert.deepEqual(owed.calls, [{ name: 'oweCatchUp', args: [caughtUp] }]);

  // The leaving comes after the answer's own line, so the answer went back first.
  const leave = await yes(3);
  assert.deepEqual(leave.order, ['record', 'removeOdd']);
  assert.deepEqual(leave.calls, [{ name: 'removeOdd', args: ['rico', { askId: 3 }] }]);

  const back = await yes(4);
  assert.deepEqual(back.order, ['record', 'bringBack']);
  assert.deepEqual(back.calls, [{ name: 'bringBack', args: ['jo', { askId: 4 }] }]);
});

test("a yes to an Odd's own ask to leave, raised on no work, starts no run for it", () => {
  const rows = rowsOf({
    staff: [odd('rico'), odd('mo', { manager: true })],
    asks: [
      ask(1, 'rico', { kind: 'remove', odd: 'rico' }),
      ask(2, 'mo', { kind: 'remove', odd: 'rico' })
    ]
  });
  const own = decide(rows, answer(1, 'approve'), NOW);
  assert.deepEqual(started(rows, changed(own)), []);
  assert.ok('after' in own);
  assert.deepEqual(
    own.after.map((a) => ('record' in a ? 'record' : a.then)),
    ['record', 'removeOdd']
  );
  // The manager's ask to let Rico go still tells the manager the answer.
  const ran = started(rows, changed(decide(rows, answer(2, 'approve'), NOW)));
  assert.deepEqual(
    ran.map((f) => [f.staffId, f.kind, f.askId, f.note]),
    [['mo', 'answered', 2, 'Sam approved "Ask 2".']]
  );
});

test('a no to two twin asks on no work starts one run', () => {
  const access: AccessRequest = { connector: 'gmail', level: 'read' };
  const rows = rowsOf({
    staff: [odd('ada')],
    asks: [ask(1, 'ada', { kind: 'access', access }), ask(2, 'ada', { kind: 'access', access })]
  });
  const c = changed(decide(rows, answer(1, 'deny'), NOW));
  const after = applyChange(rows, c);
  assert.deepEqual(
    [1, 2].map((id) => after.asks.get(id)?.status),
    ['denied', 'denied']
  );
  assert.deepEqual(
    started(rows, c).map((f) => [f.staffId, f.kind, f.askId]),
    [['ada', 'answered', 1]]
  );
});

test('a stopped thread holds no park: no time, no window hold and no task', () => {
  const parks: Park[] = [
    { on: 'time', at: minutes(60) },
    { on: 'window', at: minutes(60), ask: 9 },
    { on: 'task', task: 5 }
  ];
  for (const park of parks) {
    const rows = rowsOf({
      staff: [odd('ada')],
      threads: [thread(1, 'ada', { park })],
      asks: [ask(7, 'ada', { kind: 'hand_offs', threadId: 1 })]
    });
    const c = changed(decide(rows, answer(7, 'deny'), NOW));
    const t = applyChange(rows, c).threads.get(1);
    assert.ok(t, park.on);
    assert.equal(t.status, 'stopped', park.on);
    assert.equal('park' in t, false, `a ${park.on} park left on the stopped thread`);
    const row = threadRow(t);
    assert.deepEqual([row.resumeAt, row.heldBy, row.resumeOnTask], [null, null, null], park.on);
    // The lead hears the work stopped, to say where it stands.
    const ran = started(rows, c);
    assert.equal(ran.length, 1, park.on);
    assert.match(ran[0].note ?? '', /The work has stopped/);
  }
});

test("a folder yes's answer line takes the title the loader prepared", () => {
  const folder = { path: '/Volumes/Records/Taxes', level: 'read' } as const;
  const title = 'Let Theo read the folder the loader named';
  const base = rowsOf({ staff: [odd('theo')], asks: [ask(1, 'theo', { kind: 'folder', folder })] });
  const rows: WorkRows = { ...base, prepared: { folderTitle: title } };
  const yes = answer(1, 'approve', { done: { folder: { ...folder, given: folder } } });
  const d = decide(rows, yes, NOW);
  assert.ok('after' in d);
  const line = d.after[0];
  assert.ok('record' in line);
  assert.equal(line.record.title, title);
  // The work that waited on the folder picks up.
  assert.deepEqual(
    started(rows, changed(d)).map((f) => [f.staffId, f.kind, f.askId]),
    [['theo', 'carry_out', 1]]
  );
  // A folder yes with no title prepared is a loader's fault, never a line made up here.
  assert.throws(() => decide(base, yes, NOW), /ledger line not prepared/);
});

test("a switch yes's answer line carries the network words the loader prepared", () => {
  const words = 'Commands can now reach the internet.';
  const base = rowsOf({
    staff: [odd('theo')],
    asks: [ask(1, 'theo', { kind: 'switch', switches: ['commands'] })]
  });
  // The answer line reads only the Odd's name from the staff row the loader read.
  const before = { name: 'Theo' } as StaffRow;
  const rows: WorkRows = {
    ...base,
    prepared: { switches: { before, off: ['commands'], networkBody: words } }
  };
  const d = decide(rows, answer(1, 'approve'), NOW);
  assert.ok('after' in d);
  const line = d.after[0];
  assert.ok('record' in line);
  const body = line.record.body ?? '';
  assert.ok(body.startsWith(`${words} `), body);
  assert.equal(body.split(words).length, 2, 'the words appear once');
});

test('a task dropped in chat that answers back to a live thread resumes its lead with no chat card', () => {
  const rows = rowsOf({
    staff: [odd('ada')],
    threads: [thread(1, 'ada')],
    tasks: [task(2, 'ada', { threadId: 1 }), task(3, 'ada')]
  });
  const ran = started(rows, changed(decide(rows, ended(2, 'dropped', { inChat: true }), NOW)));
  assert.deepEqual(
    ran.map((f) => [f.staffId, f.kind, f.threadId, f.chatCard]),
    [['ada', 'resume', 1, null]]
  );
  // The same drop in chat on no work replies under the task's card.
  const offWork = started(rows, changed(decide(rows, ended(3, 'dropped', { inChat: true }), NOW)));
  assert.deepEqual(
    offWork.map((f) => [f.kind, f.chatCard]),
    [['answered', { kind: 'task', id: 3, title: 'Task 3' }]]
  );
});

test('a task dropped in chat that answers back to a hand-off hands back to its lead with no chat card', () => {
  const rows = rowsOf({
    staff: [odd('ada'), odd('rico')],
    threads: [thread(1, 'ada')],
    followUps: [
      run(
        1,
        'rico',
        'hand_off',
        { is: 'running', startedAt: T0, unparked: null },
        { threadId: 1, handOff: { from: 'ada', title: TITLE, brief: 'Sort them.' } }
      )
    ],
    tasks: [task(2, 'rico', { handOffId: 1, threadId: 1 })]
  });
  const ran = started(rows, changed(decide(rows, ended(2, 'dropped', { inChat: true }), NOW)));
  assert.deepEqual(
    ran.map((f) => [f.staffId, f.kind, f.threadId, f.chatCard]),
    [['ada', 'handed_back', 1, null]]
  );
});

// What the deciders hold to, call by call.

test("a yes to a held hand-off starts it, reopening done work, keeping an open thread's park, and leaving stopped work stopped", () => {
  const held = { from: 'ada', to: 'rico', title: TITLE, brief: 'Sort them.' };
  const sharing: HandOff = { from: 'ada', title: TITLE, brief: 'Sort them.' };
  // The round's count starts at the held hand-off, and Rico holds the work it opens.
  const cases: { was: Thread; is: Thread }[] = [
    {
      was: thread(1, 'ada', { status: 'done', endedAt: T0, handOffsUsed: 8 }),
      is: thread(1, 'ada', { handOffsUsed: 1, holderId: 'rico' })
    },
    {
      was: thread(1, 'ada', { park: { on: 'time', at: minutes(60) }, handOffsUsed: 8 }),
      is: thread(1, 'ada', {
        park: { on: 'time', at: minutes(60) },
        handOffsUsed: 1,
        holderId: 'rico'
      })
    },
    {
      was: thread(1, 'ada', { status: 'stopped', endedAt: T0, handOffsUsed: 8 }),
      is: thread(1, 'ada', { status: 'stopped', endedAt: T0, handOffsUsed: 1 })
    }
  ];
  for (const { was, is } of cases) {
    const base = rowsOf({
      staff: [odd('ada'), odd('rico')],
      threads: [was],
      asks: [ask(7, 'ada', { kind: 'hand_offs', threadId: 1, held })]
    });
    const rows: WorkRows = { ...base, prepared: { sharing } };
    const c = changed(decide(rows, answer(7, 'approve'), NOW));
    assert.deepEqual(applyChange(rows, c).threads.get(1), is, was.status);
    assert.deepEqual(
      started(rows, c).map((f) => [f.staffId, f.kind, f.threadId, f.handOff]),
      [['rico', 'hand_off', 1, sharing]],
      was.status
    );
    // What the hand-off carries is worked out at the yes, by the loader.
    assert.throws(() => decide(base, answer(7, 'approve'), NOW), /not prepared/);
  }
});

test('an ask or a task answered already is refused with the same words', () => {
  const rows = rowsOf({
    staff: [odd('ada')],
    asks: [ask(1, 'ada', { status: 'denied', decidedAt: T0 })],
    tasks: [task(2, 'ada', { status: 'done', doneAt: T0 })]
  });
  const refused = { refused: 'That was answered already.' };
  assert.deepEqual(decide(rows, answer(1, 'approve'), NOW), refused);
  assert.deepEqual(decide(rows, ended(2, 'dropped'), NOW), refused);
});

test('a task with a response is refused done until its latest version is saved and its required steps are done', () => {
  const rows = rowsOf({
    staff: [odd('ada')],
    tasks: [
      task(1, 'ada', { response: 'Draft', responseVersion: 0 }),
      task(2, 'ada', { response: 'Draft', responseVersion: 2 }),
      task(3, 'ada', { response: 'Draft', responseVersion: 2, steps: [connectGmail] }),
      task(4, 'ada', {
        response: 'Draft',
        responseVersion: 2,
        steps: [{ ...connectGmail, done: true }]
      })
    ]
  });
  const save = { refused: 'Review and save your response before marking this task done.' };
  const steps = { refused: 'Finish the required steps before marking this task done.' };
  assert.deepEqual(decide(rows, ended(1, 'done', { responseVersion: 0 }), NOW), save);
  assert.deepEqual(decide(rows, ended(2, 'done', { responseVersion: 1 }), NOW), save);
  assert.deepEqual(decide(rows, ended(3, 'done', { responseVersion: 2 }), NOW), steps);
  assert.equal(
    applyChange(
      rows,
      changed(decide(rows, ended(4, 'done', { responseVersion: 2 }), NOW))
    ).tasks.get(4)?.status,
    'done'
  );
  // Dropping one needs neither.
  assert.equal(
    applyChange(rows, changed(decide(rows, ended(1, 'dropped'), NOW))).tasks.get(1)?.status,
    'dropped'
  );
});

test("a connect task a connector's drop ends gets the drop's own time, and only the named Odd's go", () => {
  const rows = rowsOf({
    staff: [odd('ada'), odd('rico')],
    tasks: [task(1, 'ada', { steps: [connectGmail] }), task(2, 'rico', { steps: [connectGmail] })]
  });
  const d = decide(rows, { kind: 'connectTasksDropped', connector: 'gmail', staffId: 'ada' }, NOW);
  const after = applyChange(rows, changed(d));
  // Not the time it was given, which a parsed row could stand in with.
  assert.deepEqual(after.tasks.get(1), {
    ...task(1, 'ada', { steps: [connectGmail] }),
    status: 'dropped',
    doneAt: NOW,
    withdrawn: false
  });
  assert.equal(after.tasks.get(2)?.status, 'open');
  // It tells no one, and writes no ledger line.
  assert.deepEqual(started(rows, changed(d)), []);
  assert.ok('after' in d);
  assert.deepEqual(d.after, []);
});

// Off-work answers: the answer to something raised on no work reaches its Odd once (NEW-1715, NEW-1703).

test('a yes to a hire raised on no work wakes the Odd that proposed it, once', () => {
  const rows = rowsOf({ staff: [odd('ada')], asks: [ask(1, 'ada', { kind: 'hire' })] });
  const ran = started(rows, changed(decide(rows, answer(1, 'approve'), NOW)));
  assert.deepEqual(
    ran.map((f) => [f.staffId, f.kind, f.askId, f.note, f.chatCard]),
    [['ada', 'answered', 1, 'Sam approved "Ask 1".', null]]
  );
});

test('a no with no reason to an ask on no work wakes its Odd once, and in chat replies under its card', () => {
  const rows = rowsOf({ staff: [odd('ada')], asks: [ask(1, 'ada')] });
  const ran = started(rows, changed(decide(rows, answer(1, 'deny'), NOW)));
  assert.deepEqual(
    ran.map((f) => [f.staffId, f.kind, f.askId, f.note, f.chatCard]),
    [['ada', 'answered', 1, 'Sam said no to "Ask 1".', null]]
  );
  const inChat = started(rows, changed(decide(rows, answer(1, 'deny', { inChat: true }), NOW)));
  assert.deepEqual(
    inChat.map((f) => [f.kind, f.chatCard]),
    [['answered', { kind: 'ask', id: 1, title: 'Ask 1' }]]
  );
});

test('a no with a reason to an ask on no work starts only the run that reads why', () => {
  const rows = rowsOf({ staff: [odd('ada')], asks: [ask(1, 'ada')] });
  const ran = started(rows, changed(decide(rows, answer(1, 'deny', { reason: 'Not now' }), NOW)));
  assert.deepEqual(
    ran.map((f) => [f.staffId, f.kind, f.askId, f.note]),
    [['ada', 'denied', 1, 'Not now']]
  );
});

test('a plain standing yes off a thread reaches its Odd once', () => {
  const rows = rowsOf({
    staff: [odd('ada')],
    asks: [ask(1, 'ada', { kind: 'standing', standing: { connector: 'gmail', tools: ['send'] } })]
  });
  const ran = started(rows, changed(decide(rows, answer(1, 'approve'), NOW)));
  assert.deepEqual(
    ran.map((f) => [f.staffId, f.kind, f.askId]),
    [['ada', 'answered', 1]]
  );
});

test('dropping a task given on no work wakes the Odd that gave it once, and in chat replies under its card', () => {
  const rows = rowsOf({ staff: [odd('ada')], tasks: [task(1, 'ada')] });
  const ran = started(rows, changed(decide(rows, ended(1, 'dropped', { note: 'not now' }), NOW)));
  assert.equal(ran.length, 1);
  assert.deepEqual(
    [ran[0].staffId, ran[0].kind, ran[0].taskId, ran[0].chatCard],
    ['ada', 'answered', 1, null]
  );
  assert.match(ran[0].note ?? '', /dropped.*not now/);
  const inChat = started(rows, changed(decide(rows, ended(1, 'dropped', { inChat: true }), NOW)));
  assert.deepEqual(
    inChat.map((f) => [f.kind, f.chatCard]),
    [['answered', { kind: 'task', id: 1, title: 'Task 1' }]]
  );
});

test('no answer row when the Odd took the item off the desk, left the office, or its goal yes starts the planning run', () => {
  const rows = rowsOf({
    staff: [odd('ada'), odd('jo', { leftAt: T0 })],
    asks: [ask(1, 'ada'), ask(2, 'jo'), ask(3, 'ada', { kind: 'goal' })],
    tasks: [task(4, 'ada')]
  });
  const none = (c: Change) => assert.deepEqual(started(rows, c), []);
  none(changed(decide(rows, answer(1, 'deny', { withdrawn: 'Ada took it off the desk.' }), NOW)));
  none(changed(decide(rows, answer(2, 'deny'), NOW)));
  none(changed(decide(rows, answer(3, 'approve'), NOW)));
  none(changed(decide(rows, ended(4, 'withdrawn', { note: 'Ada took it off the desk.' }), NOW)));
});

// A goal yes plans the goal: the manager's run on the goal's new work.

/** A goal ask, and the yes's own write that sets the goal, under the name the decider points at. */
const goalAsk = (id: number, staffId: string, over: Partial<Ask> = {}) =>
  ask(id, staffId, {
    kind: 'goal',
    goal: { title: 'Run the fair', horizon: 'ongoing', area: 'work' },
    ...over
  });
const setsGoal = { perKind: [{ name: GOAL_SET, run: async () => ({ id: 7 }) }] };

test("a goal yes puts the manager's planning run on the goal's new work, both pointing at the goal the yes sets", () => {
  const rows = rowsOf({
    staff: [odd('ada'), odd('max', { manager: true })],
    asks: [goalAsk(1, 'ada')]
  });
  const c = changed(decide(rows, answer(1, 'approve', setsGoal), NOW));
  const opened = [...applyChange(rows, c).threads.values()].filter((t) => !rows.threads.has(t.id));
  assert.deepEqual(
    opened.map((t) => [t.title, t.hubId, t.status]),
    [['Run the fair', 'max', 'open']]
  );
  assert.deepEqual(
    started(rows, c).map((f) => [f.staffId, f.kind, f.threadId, f.chatCard]),
    [['max', 'goal', opened[0].id, null]]
  );
  assert.deepEqual(
    c.put.flatMap((p) => (p.points && 'goalId' in p.points ? [[p.table, p.points.goalId]] : [])),
    [
      ['threads', 'goal'],
      ['followUps', 'goal']
    ]
  );
});

test('a goal yes in chat on work its manager leads replies under the card from the planning run only', () => {
  const rows = rowsOf({
    staff: [odd('max', { manager: true })],
    threads: [thread(5, 'max')],
    asks: [goalAsk(1, 'max', { threadId: 5 })]
  });
  const c = changed(decide(rows, answer(1, 'approve', { ...setsGoal, inChat: true }), NOW));
  assert.deepEqual(
    started(rows, c).map((f) => [f.kind, f.chatCard]),
    [
      ['goal', { kind: 'ask', id: 1, title: 'Ask 1' }],
      ['resume', null]
    ]
  );
});

test("a goal the owner adds opens its work under the manager, and the manager's planning run goes on it", () => {
  const rows = rowsOf({ staff: [odd('max', { manager: true })] });
  const planning = { staffId: 'max', kind: 'goal', goalId: 7, note: null } as const;
  const c = changed(
    decide(rows, { kind: 'runQueued', run: planning, opens: { title: 'Run the fair' } }, NOW)
  );
  const opened = [...applyChange(rows, c).threads.values()];
  assert.deepEqual(
    opened.map((t) => [t.title, t.hubId, t.goalId]),
    [['Run the fair', 'max', 7]]
  );
  assert.deepEqual(
    started(rows, c).map((f) => [f.staffId, f.kind, f.goalId, f.threadId]),
    [['max', 'goal', 7, opened[0].id]]
  );
});

// Sequences a past bug named, as each decider now meets them.

test('after a lead is brought back, an answer on its work starts a pick-up instead of joining one its leaving failed', () => {
  // Ada's leaving failed her waiting pick-up and stopped the work; she is back now.
  const failedPickUp = run(
    5,
    'ada',
    'resume',
    {
      is: 'ended',
      outcome: 'failed',
      result: 'Ada left the office before starting this.',
      doneAt: T0,
      startedAt: null
    },
    { threadId: 1, note: 'Sam said no to "Ask 3".' }
  );
  const rows = rowsOf({
    staff: [odd('ada')],
    threads: [thread(1, 'ada', { status: 'stopped', endedAt: T0 })],
    followUps: [failedPickUp],
    tasks: [task(2, null, { threadId: 1 })]
  });
  const c = changed(decide(rows, ended(2, 'dropped', { note: 'no' }), NOW));
  const after = applyChange(rows, c);
  assert.deepEqual(after.followUps.get(5), failedPickUp);
  const waiting = [...after.followUps.values()].filter(
    (f) => f.staffId === 'ada' && f.threadId === 1 && f.run.is === 'queued'
  );
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].kind, 'resume');
  assert.match(waiting[0].note ?? '', /dropped/);
});

test("dropping a tool's connect tasks wakes the work parked on them in the same change, and leaves a finished task done", () => {
  const rows = rowsOf({
    staff: [odd('ada')],
    threads: [thread(1, 'ada', { park: { on: 'task', task: 2 } })],
    tasks: [
      task(2, 'ada', { steps: [connectGmail] }),
      task(3, 'ada', { steps: [connectGmail], status: 'done', doneAt: minutes(5) }),
      task(4, 'ada', {
        steps: [{ ...connectGmail, action: { kind: 'oauth', connector: 'slack' } }]
      })
    ]
  });
  const c = changed(decide(rows, { kind: 'connectTasksDropped', connector: 'gmail' }, NOW));
  const after = applyChange(rows, c);
  assert.deepEqual(
    [2, 3, 4].map((id) => after.tasks.get(id)?.status),
    ['dropped', 'done', 'open']
  );
  assert.deepEqual(after.tasks.get(3), rows.tasks.get(3));
  const t = after.threads.get(1);
  assert.deepEqual(t?.status === 'open' && t.park, { on: 'none' });
  const ran = started(rows, c);
  assert.deepEqual(
    ran.map((f) => [f.staffId, f.kind, f.threadId]),
    [['ada', 'resume', 1]]
  );
  assert.match(ran[0].note ?? '', /dropped "Task 2"/);
});

test('a held call the Odd has open already is not raised again: the open ask answers it', () => {
  const call = { connector: 'gmail', tool: 'archive', arguments: { ids: [1, 2] } };
  const rows = rowsOf({
    staff: [odd('ada')],
    asks: [
      ask(1, 'ada', {
        kind: 'call',
        call: { ...call, arguments: { ids: [1, 2] } },
        status: 'approved',
        decidedAt: T0
      }),
      ask(2, 'ada', { kind: 'call', call })
    ]
  });
  const raise = (args: Record<string, unknown>) =>
    decide(
      rows,
      {
        kind: 'askRaised',
        ask: {
          staffId: 'ada',
          kind: 'call',
          title: 'Archive',
          why: 'Tidy',
          ifApproved: 'Archived',
          call: { ...call, arguments: args }
        }
      },
      NOW
    );
  assert.deepEqual(raise({ ids: [1, 2] }), {
    change: { put: [], outside: [], result: { already: 2 } },
    after: []
  });
  // Other arguments are another call.
  const other = changed(raise({ ids: [3] }));
  assert.equal(other.result, null);
  assert.equal(applyChange(rows, other).asks.size, 3);
});

test("a second connect task for a tool with one open gives that one, the Odd's own when the task has an Odd", () => {
  const rows = rowsOf({
    staff: [odd('ada'), odd('rico')],
    tasks: [task(1, 'ada', { steps: [connectGmail] })]
  });
  const give = (staffId: string | null) =>
    decide(
      rows,
      {
        kind: 'taskGiven',
        task: { staffId, title: 'Connect Gmail', why: 'Signed out', steps: [connectGmail] },
        oneOpen: { connector: 'gmail' }
      },
      NOW
    );
  const already = { change: { put: [], outside: [], result: { already: 1 } }, after: [] };
  assert.deepEqual(give('ada'), already);
  assert.deepEqual(give(null), already);
  // Rico's own connect task is a new one.
  const ricos = changed(give('rico'));
  assert.equal(ricos.result, null);
  assert.equal(applyChange(rows, ricos).tasks.size, 2);
});

test("an AWS tool's role or Region change finds only an open task with an AWS step for that tool", () => {
  const signIn: Step = {
    text: 'Sign in',
    done: false,
    action: { kind: 'oauth', connector: 'aws-read' }
  };
  const role: Step = {
    text: 'Set the role',
    done: false,
    action: { kind: 'aws', connector: 'aws-read' }
  };
  const change = (rows: WorkRows) =>
    decide(
      rows,
      {
        kind: 'taskGiven',
        task: { staffId: null, title: 'Change the AWS role', why: 'Moved', steps: [role] },
        oneOpen: { connector: 'aws-read', aws: true }
      },
      NOW
    );
  const signInOnly = rowsOf({ staff: [], tasks: [task(1, null, { steps: [signIn] })] });
  assert.equal(changed(change(signInOnly)).result, null);
  const withRole = rowsOf({
    staff: [],
    tasks: [task(1, null, { steps: [signIn] }), task(2, null, { steps: [role] })]
  });
  assert.deepEqual(changed(change(withRole)).result, { already: 2 });
});
