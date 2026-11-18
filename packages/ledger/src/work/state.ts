// What a stored thread, follow-up, ask or task is doing, read as one state
// each, and written back whole. A parser either returns a state its type
// allows, or throws `RowNotParsed` naming the columns that disagree, so no
// code acts on a row it cannot read. A serializer writes every column on
// every write, so an old row that kept a stale column is put right the next
// time it is written.
//
// Pure: no database. From schema.ts it takes types and the two kind lists
// only, since a module here must never load db.ts (pure-modules.test.ts).
import { ASK_REPLACED, askReplaced } from '../desk-answers.ts';
import { fixedError } from '../errors.ts';
import { ASK_KINDS, FOLLOW_UP_KINDS } from '../schema.ts';
import type { asks, FollowUpKind, followUps, Outcome, tasks, threads } from '../schema.ts';

type ThreadRow = typeof threads.$inferSelect;
type FollowUpRow = typeof followUps.$inferSelect;
type AskRow = typeof asks.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

/**
 * A follow-up kind the office no longer starts. An older office may have
 * kept such a row, so it still parses, always as ended: nothing runs it.
 */
export const RETIRED_KINDS = ['feedback'] as const;
export type RetiredKind = (typeof RETIRED_KINDS)[number];

/** A stored row the parsers cannot read: the table, its id, and the columns at fault. */
export class RowNotParsed extends Error {
  readonly table: (typeof threads | typeof followUps | typeof asks | typeof tasks)['_']['name'];
  readonly id: number;
  /** Two columns that disagree, or one that holds a value no code knows. */
  readonly columns: readonly string[];
  constructor(table: RowNotParsed['table'], id: number, columns: readonly string[]) {
    super(
      columns.length > 1
        ? `${table} ${id}: ${columns.join(' and ')} disagree`
        : `${table} ${id}: ${columns.join('')} holds a value the office does not know`
    );
    this.name = 'RowNotParsed';
    this.table = table;
    this.id = id;
    this.columns = columns;
  }
}

const isIn = <T extends string>(list: readonly T[], value: string): value is T =>
  list.some((member) => member === value);

/** A serializer's last branch, reached only when a cast lied about a state: it throws rather than write a guess. */
function unknownState(state: never): never {
  throw fixedError('A work state outside its type reached a serializer.');
}

// Threads.

/** What wakes an open thread: nothing, a time, the usage window's reset (or the owner's yes to its ask), or a task's end. */
export type Park =
  | { on: 'none' }
  | { on: 'time'; at: Date }
  | { on: 'window'; at: Date; ask: number }
  | { on: 'task'; task: number };
export type ThreadBase = Omit<
  ThreadRow,
  'status' | 'resumeAt' | 'heldBy' | 'resumeOnTask' | 'endedAt'
>;
export type Thread = ThreadBase &
  ({ status: 'open'; park: Park } | { status: 'done' | 'failed' | 'stopped'; endedAt: Date });

function parsePark(row: ThreadRow): Park {
  const { resumeAt, heldBy, resumeOnTask } = row;
  if (resumeAt && resumeOnTask !== null)
    throw new RowNotParsed('threads', row.id, ['resume_at', 'resume_on_task']);
  if (heldBy !== null && !resumeAt)
    throw new RowNotParsed('threads', row.id, ['held_by', 'resume_at']);
  if (resumeOnTask !== null) return { on: 'task', task: resumeOnTask };
  if (heldBy !== null && resumeAt) return { on: 'window', at: resumeAt, ask: heldBy };
  if (resumeAt) return { on: 'time', at: resumeAt };
  return { on: 'none' };
}

export function parseThread(row: ThreadRow): Thread {
  const { status, resumeAt, heldBy, resumeOnTask, endedAt, ...base } = row;
  switch (status) {
    case 'open':
      if (endedAt) throw new RowNotParsed('threads', row.id, ['status', 'ended_at']);
      return { ...base, status, park: parsePark(row) };
    case 'done':
    case 'failed':
      // A hand-off on an ended thread clears `ended_at` to reopen it, and its
      // status follows only once the hand-off is written: every reader today
      // takes a thread with no end time as open.
      if (!endedAt) return { ...base, status: 'open', park: parsePark(row) };
      // An ended thread can keep the park it had (the owner's answer to a
      // hand-off past the limit left it): nothing wakes an ended thread.
      return { ...base, status, endedAt };
    case 'stopped':
      if (!endedAt) throw new RowNotParsed('threads', row.id, ['status', 'ended_at']);
      return { ...base, status, endedAt };
    default:
      throw new RowNotParsed('threads', row.id, ['status']);
  }
}

function parkColumns(park: Park): Pick<ThreadRow, 'resumeAt' | 'heldBy' | 'resumeOnTask'> {
  switch (park.on) {
    case 'none':
      return { resumeAt: null, heldBy: null, resumeOnTask: null };
    case 'time':
      return { resumeAt: park.at, heldBy: null, resumeOnTask: null };
    case 'window':
      return { resumeAt: park.at, heldBy: park.ask, resumeOnTask: null };
    case 'task':
      return { resumeAt: null, heldBy: null, resumeOnTask: park.task };
    default:
      return unknownState(park);
  }
}

export function threadRow(t: Thread): ThreadRow {
  switch (t.status) {
    case 'open': {
      const { status, park, ...base } = t;
      return { ...base, status, endedAt: null, ...parkColumns(park) };
    }
    case 'done':
    case 'failed':
    case 'stopped': {
      const { status, endedAt, ...base } = t;
      return { ...base, status, endedAt, ...parkColumns({ on: 'none' }) };
    }
    default:
      return unknownState(t);
  }
}

// Follow-ups.

export type RunState =
  | { is: 'queued' }
  | { is: 'running'; startedAt: Date; unparked: { task: number } | { at: Date } | null }
  | {
      is: 'ended';
      outcome: Outcome;
      result: string | null;
      doneAt: Date;
      startedAt: Date | null;
    };
export type FollowUpBase = Omit<
  FollowUpRow,
  'kind' | 'startedAt' | 'unparkedTask' | 'unparkedAt' | 'outcome' | 'result' | 'doneAt'
>;
// The live kinds exclude the retired ones by type as well as by list, so the
// type holds while a retired kind is still in FOLLOW_UP_KINDS and after it goes.
export type FollowUp = FollowUpBase &
  (
    | { kind: Exclude<FollowUpKind, RetiredKind>; run: RunState }
    | { kind: RetiredKind; run: Extract<RunState, { is: 'ended' }> }
  );

function parseRun(row: FollowUpRow): RunState {
  const { startedAt, unparkedTask, unparkedAt, outcome, result, doneAt } = row;
  if (outcome !== null) {
    if (!doneAt) throw new RowNotParsed('follow_ups', row.id, ['outcome', 'done_at']);
    // A row with no start time can still have ended: an Odd's leaving fails
    // each follow-up it had yet to start. Such a row parses as ended, never as
    // queued. A joined pick-up is not one of these: it gets its start time as
    // it ends.
    return { is: 'ended', outcome, result, doneAt, startedAt };
  }
  if (doneAt) throw new RowNotParsed('follow_ups', row.id, ['outcome', 'done_at']);
  if (result !== null) throw new RowNotParsed('follow_ups', row.id, ['outcome', 'result']);
  if (!startedAt) {
    if (unparkedTask !== null)
      throw new RowNotParsed('follow_ups', row.id, ['started_at', 'unparked_task']);
    if (unparkedAt) throw new RowNotParsed('follow_ups', row.id, ['started_at', 'unparked_at']);
    return { is: 'queued' };
  }
  if (unparkedTask !== null && unparkedAt)
    throw new RowNotParsed('follow_ups', row.id, ['unparked_task', 'unparked_at']);
  const unparked =
    unparkedTask !== null ? { task: unparkedTask } : unparkedAt ? { at: unparkedAt } : null;
  return { is: 'running', startedAt, unparked };
}

export function parseFollowUp(row: FollowUpRow): FollowUp {
  const { kind, startedAt, unparkedTask, unparkedAt, outcome, result, doneAt, ...base } = row;
  // Checked before the live kinds, which may still list it.
  if (isIn(RETIRED_KINDS, kind))
    return {
      ...base,
      kind,
      // Never started or never closed, it ends as a run whose Odd left before
      // starting it does, `failed`, and at the time it was made.
      run: {
        is: 'ended',
        outcome: outcome ?? 'failed',
        result,
        doneAt: doneAt ?? row.createdAt,
        startedAt
      }
    };
  if (!isIn(FOLLOW_UP_KINDS, kind)) throw new RowNotParsed('follow_ups', row.id, ['kind']);
  return { ...base, kind, run: parseRun(row) };
}

type RunColumns = Pick<
  FollowUpRow,
  'startedAt' | 'unparkedTask' | 'unparkedAt' | 'outcome' | 'result' | 'doneAt'
>;

function runColumns(run: RunState): RunColumns {
  const notEnded = { outcome: null, result: null, doneAt: null };
  switch (run.is) {
    case 'queued':
      return { startedAt: null, unparkedTask: null, unparkedAt: null, ...notEnded };
    case 'running': {
      const u = run.unparked;
      return {
        startedAt: run.startedAt,
        unparkedTask: u && 'task' in u ? u.task : null,
        unparkedAt: u && 'at' in u ? u.at : null,
        ...notEnded
      };
    }
    case 'ended':
      // The unpark only lets a failed run give its wait back as it ends; once
      // ended, nothing reads it.
      return {
        startedAt: run.startedAt,
        unparkedTask: null,
        unparkedAt: null,
        outcome: run.outcome,
        result: run.result,
        doneAt: run.doneAt
      };
    default:
      return unknownState(run);
  }
}

/** The whole row, its kind typed as the follow-up holds it, since a retired kind can outlive the column's own type. */
export function followUpRow(f: FollowUp): Omit<FollowUpRow, 'kind'> & { kind: FollowUp['kind'] } {
  const { kind, run, ...base } = f;
  return { ...base, kind, ...runColumns(run) };
}

// Asks.

export type AskState =
  | { status: 'open' }
  | { status: 'approved' | 'denied'; decidedAt: Date }
  | { status: 'revise'; decidedAt: Date; replaced: boolean };
export type AskBase = Omit<AskRow, 'status' | 'decidedAt'>;
export type Ask = AskBase & AskState;

export function parseAsk(row: AskRow): Ask {
  const { status, decidedAt, ...base } = row;
  if (!isIn(ASK_KINDS, row.kind)) throw new RowNotParsed('asks', row.id, ['kind']);
  const decidedAtDisagrees = () => new RowNotParsed('asks', row.id, ['status', 'decided_at']);
  switch (status) {
    case 'open':
      if (decidedAt) throw decidedAtDisagrees();
      return { ...base, status };
    case 'approved':
    case 'denied':
      if (!decidedAt) throw decidedAtDisagrees();
      return { ...base, status, decidedAt };
    case 'revise':
      if (!decidedAt) throw decidedAtDisagrees();
      return { ...base, status, decidedAt, replaced: askReplaced(row) };
    default:
      throw new RowNotParsed('asks', row.id, ['status']);
  }
}

export function askRow(a: Ask): AskRow {
  switch (a.status) {
    case 'open': {
      const { status, ...base } = a;
      return { ...base, status, decidedAt: null };
    }
    case 'approved':
    case 'denied': {
      const { status, decidedAt, ...base } = a;
      return { ...base, status, decidedAt };
    }
    case 'revise': {
      // A replaced ask is known by its reason, the office's words, so the
      // reason follows `replaced`.
      const { status, decidedAt, replaced, ...base } = a;
      return { ...base, status, decidedAt, reason: replaced ? ASK_REPLACED : base.reason };
    }
    default:
      return unknownState(a);
  }
}

// Tasks.

export type TaskState =
  | { status: 'open' }
  | { status: 'done'; doneAt: Date }
  | { status: 'dropped'; doneAt: Date; withdrawn: boolean };
/** Carries the owner's saved words and their version, so a write that ends the task keeps them. */
export type TaskBase = Omit<TaskRow, 'status' | 'doneAt' | 'withdrawn'>;
export type Task = TaskBase & TaskState;

export function parseTask(row: TaskRow): Task {
  const { status, doneAt, withdrawn, ...base } = row;
  if (withdrawn && status !== 'dropped')
    throw new RowNotParsed('tasks', row.id, ['status', 'withdrawn']);
  switch (status) {
    case 'open':
      if (doneAt) throw new RowNotParsed('tasks', row.id, ['status', 'done_at']);
      return { ...base, status };
    case 'done':
      if (!doneAt) throw new RowNotParsed('tasks', row.id, ['status', 'done_at']);
      return { ...base, status, doneAt };
    case 'dropped':
      // Dropping a connect task kept no end time; the time it was given
      // stands in, and the next write keeps that time.
      return { ...base, status, doneAt: doneAt ?? row.createdAt, withdrawn };
    default:
      throw new RowNotParsed('tasks', row.id, ['status']);
  }
}

export function taskRow(t: Task): TaskRow {
  switch (t.status) {
    case 'open': {
      const { status, ...base } = t;
      return { ...base, status, doneAt: null, withdrawn: false };
    }
    case 'done': {
      const { status, doneAt, ...base } = t;
      return { ...base, status, doneAt, withdrawn: false };
    }
    case 'dropped': {
      const { status, doneAt, withdrawn, ...base } = t;
      return { ...base, status, doneAt, withdrawn };
    }
    default:
      return unknownState(t);
  }
}
