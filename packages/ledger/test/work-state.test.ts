// How a stored thread, follow-up, ask or task reads as one state, and how it
// is written back whole. Pure: rows in memory, no database.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASK_REPLACED } from '../src/desk-answers.ts';
import {
  askRow,
  followUpRow,
  parseAsk,
  parseFollowUp,
  parseTask,
  parseThread,
  RowNotParsed,
  taskRow,
  threadRow
} from '../src/work/state.ts';

type ThreadRow = Parameters<typeof parseThread>[0];
type FollowUpRow = Parameters<typeof parseFollowUp>[0];
type AskRow = Parameters<typeof parseAsk>[0];
type TaskRow = Parameters<typeof parseTask>[0];

const MADE = new Date('2026-11-01T09:00:00Z');
const STARTED = new Date('2026-11-01T09:05:00Z');
const ENDED = new Date('2026-11-01T09:30:00Z');
const LATER = new Date('2026-11-01T14:00:00Z');

/** A word a text column may hold though no code writes it: the case these tests read. */
const storedWord = <T extends string>(word: string): T => word as T;

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 7,
  title: 'Plan the launch',
  goalId: null,
  hubId: 'mara',
  holderId: 'mara',
  status: 'open',
  handOffsUsed: 2,
  resumeAt: null,
  heldBy: null,
  resumeOnTask: null,
  runs: ['run-1'],
  createdAt: MADE,
  endedAt: null,
  ...over
});

const followUp = (over: Partial<FollowUpRow> = {}): FollowUpRow => ({
  id: 12,
  staffId: 'theo',
  kind: 'carry_out',
  askId: 3,
  reportId: null,
  taskId: null,
  goalId: null,
  handOff: null,
  threadId: 7,
  edit: null,
  note: 'Go ahead',
  pickedUp: null,
  unparkedTask: null,
  unparkedAt: null,
  reportWhenDone: false,
  chatCard: null,
  createdAt: MADE,
  startedAt: null,
  outcome: null,
  result: null,
  doneAt: null,
  ...over
});

const ask = (over: Partial<AskRow> = {}): AskRow => ({
  id: 3,
  staffId: 'theo',
  kind: 'approval',
  title: 'Send the newsletter',
  why: 'It is Friday',
  ifApproved: 'I send it',
  access: null,
  hire: null,
  goal: null,
  plan: null,
  reply: null,
  filter: null,
  folder: null,
  call: null,
  catchUp: null,
  switches: null,
  level: null,
  officeTools: null,
  odd: null,
  standing: null,
  revises: null,
  handOffId: null,
  threadId: 7,
  held: null,
  via: null,
  status: 'open',
  reason: null,
  createdAt: MADE,
  decidedAt: null,
  ...over
});

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 5,
  staffId: 'theo',
  askId: null,
  handOffId: null,
  threadId: 7,
  via: null,
  ownerSaid: null,
  title: 'Sign in to the bank',
  why: 'I need the statements',
  steps: [{ key: 'sign-in', text: 'Sign in', done: false }],
  response: null,
  responseVersion: 0,
  status: 'open',
  note: null,
  withdrawn: false,
  createdAt: MADE,
  doneAt: null,
  ...over
});

/** The parse throws RowNotParsed naming this table, this id and these columns. */
function refuses(parse: () => unknown, table: string, id: number, columns: string[]): void {
  assert.throws(parse, (e: unknown) => {
    assert.ok(e instanceof RowNotParsed, `threw ${String(e)}, not RowNotParsed`);
    assert.deepEqual({ table: e.table, id: e.id, columns: e.columns }, { table, id, columns });
    return true;
  });
}

// Threads.

test('an open thread parses each of its four parks and writes the same row back', () => {
  const rows: [ThreadRow, unknown][] = [
    [thread(), { on: 'none' }],
    [thread({ resumeAt: LATER }), { on: 'time', at: LATER }],
    [thread({ resumeAt: LATER, heldBy: 9 }), { on: 'window', at: LATER, ask: 9 }],
    [thread({ resumeOnTask: 5 }), { on: 'task', task: 5 }]
  ];
  for (const [row, park] of rows) {
    const t = parseThread(row);
    assert.equal(t.status, 'open');
    assert.deepEqual(t.status === 'open' && t.park, park);
    assert.deepEqual(threadRow(t), row);
  }
});

test('an ended thread parses with its end time and writes the same row back', () => {
  for (const status of ['done', 'failed', 'stopped'] as const) {
    const row = thread({ status, endedAt: ENDED });
    const t = parseThread(row);
    assert.deepEqual(
      { status: t.status, endedAt: 'endedAt' in t && t.endedAt },
      { status, endedAt: ENDED }
    );
    assert.deepEqual(threadRow(t), row);
  }
});

test('an ended thread with its park still set parses as ended with no park, and is written back with the park cleared', () => {
  const row = thread({ status: 'done', endedAt: ENDED, resumeAt: LATER, heldBy: 9 });
  const t = parseThread(row);
  assert.equal(t.status, 'done');
  assert.ok(!('park' in t));
  assert.deepEqual(threadRow(t), { ...row, resumeAt: null, heldBy: null });
  const onTask = parseThread(thread({ status: 'stopped', endedAt: ENDED, resumeOnTask: 5 }));
  assert.equal(threadRow(onTask).resumeOnTask, null);
});

test('a done or failed thread a hand-off reopened, its end time cleared, parses as open with its park', () => {
  for (const status of ['done', 'failed'] as const) {
    const t = parseThread(thread({ status, resumeAt: LATER, heldBy: 9 }));
    assert.deepEqual(t.status === 'open' && t.park, { on: 'window', at: LATER, ask: 9 });
    assert.deepEqual(threadRow(t), thread({ resumeAt: LATER, heldBy: 9 }));
  }
});

test('a thread parked on both a time and a task is not parsed', () => {
  refuses(() => parseThread(thread({ resumeAt: LATER, resumeOnTask: 5 })), 'threads', 7, [
    'resume_at',
    'resume_on_task'
  ]);
});

test('a thread held by a window ask with no time is not parsed', () => {
  refuses(() => parseThread(thread({ heldBy: 9 })), 'threads', 7, ['held_by', 'resume_at']);
});

test('an open thread with an end time, or a stopped one without, is not parsed', () => {
  refuses(() => parseThread(thread({ endedAt: ENDED })), 'threads', 7, ['status', 'ended_at']);
  refuses(() => parseThread(thread({ status: 'stopped' })), 'threads', 7, ['status', 'ended_at']);
});

test('a thread whose status no code knows is not parsed', () => {
  refuses(() => parseThread(thread({ status: storedWord('paused') })), 'threads', 7, ['status']);
});

// Follow-ups.

test('a follow-up parses as queued, running or ended and writes the same row back', () => {
  const rows: [FollowUpRow, unknown][] = [
    [followUp(), { is: 'queued' }],
    [followUp({ startedAt: STARTED }), { is: 'running', startedAt: STARTED, unparked: null }],
    [
      followUp({ startedAt: STARTED, unparkedTask: 5 }),
      { is: 'running', startedAt: STARTED, unparked: { task: 5 } }
    ],
    [
      followUp({ startedAt: STARTED, unparkedAt: LATER }),
      { is: 'running', startedAt: STARTED, unparked: { at: LATER } }
    ],
    [
      followUp({ startedAt: STARTED, outcome: 'done', result: 'Sent it', doneAt: ENDED }),
      { is: 'ended', outcome: 'done', result: 'Sent it', doneAt: ENDED, startedAt: STARTED }
    ]
  ];
  for (const [row, run] of rows) {
    const f = parseFollowUp(row);
    assert.deepEqual(f.run, run);
    assert.deepEqual(followUpRow(f), row);
  }
});

test('a follow-up with an outcome and no start parses as ended, never queued', () => {
  const row = followUp({ outcome: 'failed', result: 'Theo left first.', doneAt: ENDED });
  const f = parseFollowUp(row);
  assert.deepEqual(f.run, {
    is: 'ended',
    outcome: 'failed',
    result: 'Theo left first.',
    doneAt: ENDED,
    startedAt: null
  });
  assert.deepEqual(followUpRow(f), row);
});

test('an ended follow-up keeps no unpark, and is written back with it cleared', () => {
  const row = followUp({
    startedAt: STARTED,
    unparkedTask: 5,
    outcome: 'failed',
    result: 'Stopped',
    doneAt: ENDED
  });
  const f = parseFollowUp(row);
  assert.equal(f.run.is, 'ended');
  assert.deepEqual(followUpRow(f), { ...row, unparkedTask: null });
});

test("a follow-up's chat card survives parse and write", () => {
  const chatCard = { kind: 'ask' as const, id: 3, title: 'Send the newsletter' };
  const f = parseFollowUp(followUp({ chatCard }));
  assert.deepEqual(f.chatCard, chatCard);
  // A live kind, so any run may follow; a retired one only ever reads as ended.
  assert.ok(f.kind === 'carry_out');
  const started = followUpRow({ ...f, run: { is: 'running', startedAt: STARTED, unparked: null } });
  assert.deepEqual(started.chatCard, chatCard);
  assert.deepEqual(started, followUp({ chatCard, startedAt: STARTED }));
});

test('a legacy feedback row parses as an ended follow-up', () => {
  // Never started or closed: it ends failed, at the time it was made.
  const waiting = parseFollowUp(followUp({ kind: storedWord('feedback') }));
  assert.equal(waiting.kind, 'feedback');
  assert.deepEqual(waiting.run, {
    is: 'ended',
    outcome: 'failed',
    result: null,
    doneAt: MADE,
    startedAt: null
  });
  // Started but never closed: still ended, never running.
  const started = parseFollowUp(followUp({ kind: storedWord('feedback'), startedAt: STARTED }));
  assert.deepEqual(started.run, {
    is: 'ended',
    outcome: 'failed',
    result: null,
    doneAt: MADE,
    startedAt: STARTED
  });
  // Closed: its own outcome, result and times.
  const closed = followUp({
    kind: storedWord('feedback'),
    startedAt: STARTED,
    outcome: 'done',
    result: 'Read it',
    doneAt: ENDED
  });
  const f = parseFollowUp(closed);
  assert.deepEqual(f.run, {
    is: 'ended',
    outcome: 'done',
    result: 'Read it',
    doneAt: ENDED,
    startedAt: STARTED
  });
  assert.deepEqual(followUpRow(f), closed);
});

test('a follow-up whose outcome and end time disagree is not parsed', () => {
  refuses(
    () => parseFollowUp(followUp({ startedAt: STARTED, outcome: 'done' })),
    'follow_ups',
    12,
    ['outcome', 'done_at']
  );
  refuses(() => parseFollowUp(followUp({ startedAt: STARTED, doneAt: ENDED })), 'follow_ups', 12, [
    'outcome',
    'done_at'
  ]);
});

test('a follow-up with a result and no outcome is not parsed', () => {
  refuses(
    () => parseFollowUp(followUp({ startedAt: STARTED, result: 'Sent it' })),
    'follow_ups',
    12,
    ['outcome', 'result']
  );
});

test('a follow-up that never started but ended a park is not parsed', () => {
  refuses(() => parseFollowUp(followUp({ unparkedTask: 5 })), 'follow_ups', 12, [
    'started_at',
    'unparked_task'
  ]);
  refuses(() => parseFollowUp(followUp({ unparkedAt: LATER })), 'follow_ups', 12, [
    'started_at',
    'unparked_at'
  ]);
});

test('a running follow-up that ended both a task park and a time park is not parsed', () => {
  refuses(
    () => parseFollowUp(followUp({ startedAt: STARTED, unparkedTask: 5, unparkedAt: LATER })),
    'follow_ups',
    12,
    ['unparked_task', 'unparked_at']
  );
});

test('a follow-up whose kind no code knows is not parsed', () => {
  refuses(() => parseFollowUp(followUp({ kind: storedWord('report') })), 'follow_ups', 12, [
    'kind'
  ]);
});

// Asks.

test('an ask parses open, approved, denied or sent back and writes the same row back', () => {
  const rows: [AskRow, unknown][] = [
    [ask(), { status: 'open' }],
    [ask({ status: 'approved', decidedAt: ENDED }), { status: 'approved', decidedAt: ENDED }],
    [
      ask({ status: 'denied', reason: 'Not this week', decidedAt: ENDED }),
      { status: 'denied', decidedAt: ENDED }
    ],
    [
      ask({ status: 'revise', reason: 'Shorter', decidedAt: ENDED }),
      { status: 'revise', decidedAt: ENDED, replaced: false }
    ]
  ];
  for (const [row, state] of rows) {
    const a = parseAsk(row);
    const { status } = a;
    assert.deepEqual(
      {
        status,
        ...('decidedAt' in a ? { decidedAt: a.decidedAt } : {}),
        ...('replaced' in a ? { replaced: a.replaced } : {})
      },
      state
    );
    assert.deepEqual(askRow(a), row);
  }
});

test('an ask the Odd replaced with a new version parses as sent back and replaced', () => {
  const row = ask({ status: 'revise', reason: ASK_REPLACED, decidedAt: ENDED });
  const a = parseAsk(row);
  assert.ok(a.status === 'revise' && a.replaced);
  assert.deepEqual(askRow(a), row);
});

test("an open ask written back as replaced takes the office's reason", () => {
  const a = parseAsk(ask());
  const written = askRow({ ...a, status: 'revise', decidedAt: ENDED, replaced: true });
  assert.deepEqual(written, ask({ status: 'revise', reason: ASK_REPLACED, decidedAt: ENDED }));
});

test('an ask whose status and decision time disagree is not parsed', () => {
  refuses(() => parseAsk(ask({ decidedAt: ENDED })), 'asks', 3, ['status', 'decided_at']);
  for (const status of ['approved', 'denied', 'revise'] as const)
    refuses(() => parseAsk(ask({ status })), 'asks', 3, ['status', 'decided_at']);
});

test('an ask whose kind or status no code knows is not parsed', () => {
  refuses(() => parseAsk(ask({ kind: storedWord('lunch') })), 'asks', 3, ['kind']);
  refuses(() => parseAsk(ask({ status: storedWord('held'), decidedAt: ENDED })), 'asks', 3, [
    'status'
  ]);
});

// Tasks.

test('a task parses open, done or dropped and writes the same row back', () => {
  const rows: [TaskRow, unknown][] = [
    [task(), { status: 'open' }],
    [task({ status: 'done', doneAt: ENDED }), { status: 'done', doneAt: ENDED }],
    [
      task({ status: 'dropped', doneAt: ENDED }),
      { status: 'dropped', doneAt: ENDED, withdrawn: false }
    ],
    [
      task({ status: 'dropped', withdrawn: true, doneAt: ENDED }),
      { status: 'dropped', doneAt: ENDED, withdrawn: true }
    ]
  ];
  for (const [row, state] of rows) {
    const t = parseTask(row);
    const { status } = t;
    assert.deepEqual(
      {
        status,
        ...('doneAt' in t ? { doneAt: t.doneAt } : {}),
        ...('withdrawn' in t ? { withdrawn: t.withdrawn } : {})
      },
      state
    );
    assert.deepEqual(taskRow(t), row);
  }
});

test("a task's saved response and its version survive parse and write", () => {
  const saved = { response: 'Account ending 4410', responseVersion: 3 };
  for (const row of [
    task(saved),
    task({ ...saved, status: 'done', doneAt: ENDED }),
    task({ ...saved, status: 'dropped', doneAt: ENDED, withdrawn: true })
  ]) {
    const t = parseTask(row);
    assert.deepEqual({ response: t.response, responseVersion: t.responseVersion }, saved);
    assert.deepEqual(taskRow(t), row, `a ${row.status} task`);
  }
});

test('a task dropped with no end time parses as ended when it was made', () => {
  const t = parseTask(task({ status: 'dropped' }));
  assert.ok(t.status === 'dropped');
  assert.equal(t.doneAt, MADE);
  assert.deepEqual(taskRow(t), task({ status: 'dropped', doneAt: MADE }));
});

test('a task whose status and end time disagree is not parsed', () => {
  refuses(() => parseTask(task({ doneAt: ENDED })), 'tasks', 5, ['status', 'done_at']);
  refuses(() => parseTask(task({ status: 'done' })), 'tasks', 5, ['status', 'done_at']);
});

test('a withdrawn task that is not dropped is not parsed', () => {
  refuses(() => parseTask(task({ withdrawn: true })), 'tasks', 5, ['status', 'withdrawn']);
  refuses(() => parseTask(task({ status: 'done', withdrawn: true, doneAt: ENDED })), 'tasks', 5, [
    'status',
    'withdrawn'
  ]);
});

test('a task whose status no code knows is not parsed', () => {
  refuses(() => parseTask(task({ status: storedWord('snoozed') })), 'tasks', 5, ['status']);
});
