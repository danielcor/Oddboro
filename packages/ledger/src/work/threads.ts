// Where a thread stands as its runs move, and a new run on it, as steps a
// decider takes on its `Draft`. `settle` is the one place a thread's status
// and holder are worked out, and `stopThread` the one place a thread becomes
// stopped.
//
// Pure: every import that reaches the database is a type.
import { fixedError } from '../errors.ts';
import { chatCardOf, type HandOff, type InChat, type Outcome } from '../schema.ts';
import type { LiveKind, OwedRun } from './events.ts';
import { SERVES_NO_THREAD } from './kinds.ts';
import {
  insertedRef,
  putAll,
  type Draft,
  type Fresh,
  type Inserted,
  type WorkRows
} from './snapshot.ts';
import type { FollowUp, FollowUpBase, Thread, ThreadBase } from './state.ts';

/** A colleague's run on work a lead handed it. */
export type HandOffRow = FollowUp & { kind: 'hand_off' };
export const isHandOff = (f: FollowUp | undefined): f is HandOffRow => f?.kind === 'hand_off';

/** Whether an Odd left the office. One the rows do not hold reads as here. */
export const hasLeft = (rows: WorkRows, id: string): boolean => !!rows.staff.get(id)?.leftAt;

/**
 * What an Odd that has left hears when it raises an ask or gives a task: its
 * run may still be finishing as the owner lets it go, and nothing it raises
 * then may wait on the desk for an Odd who is gone.
 */
export const LEFT_RAISES_NOTHING =
  'You have left the office, so nothing you raise reaches the Desk.';

/** What the lead hears of work an Odd that left never started. */
export const leftBeforeStarting = (name: string): string =>
  `${name} left the office before starting this.`;

/**
 * Whether something raised on a thread is still open on the owner's desk: an
 * ask raised on it, or a task given on it or from an ask raised on it, as
 * `waitingOn` reads it.
 */
function raisedOpen(rows: WorkRows, threadId: number): boolean {
  const raised = [...rows.asks.values()].filter((a) => a.threadId === threadId);
  const raisedIds = new Set(raised.map((a) => a.id));
  return (
    raised.some((a) => a.status === 'open') ||
    [...rows.tasks.values()].some(
      (k) =>
        k.status === 'open' &&
        (k.threadId === threadId || (k.askId !== null && raisedIds.has(k.askId)))
    )
  );
}

/**
 * Where an open thread stands from its runs: open while one has yet to end,
 * while it is parked, while something raised on it is open, before any run
 * has ended, and while the last run to end ended waiting, since the owner's
 * answer to what that run raised brings the lead back. Else it ends as its
 * last run ended. Its holder has the newest run still to end, else it is the
 * lead. An ended thread stays as it ended. Puts the thread only when its
 * status or holder changes.
 */
export function settle(d: Draft, threadId: number, now: Date): void {
  const t = d.rows.threads.get(threadId);
  if (t?.status !== 'open') return;
  const runs = [...d.rows.followUps.values()].filter((f) => f.threadId === threadId);
  const pending = runs.filter((f) => f.run.is !== 'ended').sort((a, b) => b.id - a.id)[0];
  const last = runs
    .flatMap((f) => (f.run.is === 'ended' ? [{ id: f.id, ...f.run }] : []))
    .sort((a, b) => b.doneAt.getTime() - a.doneAt.getTime() || b.id - a.id)[0];
  const holderId = pending?.staffId ?? t.hubId;
  if (
    pending ||
    t.park.on !== 'none' ||
    !last ||
    last.outcome === 'waiting' ||
    raisedOpen(d.rows, threadId)
  ) {
    if (holderId !== t.holderId) putAll(d, [{ table: 'threads', row: { ...t, holderId } }]);
    return;
  }
  const { status: _, park: __, ...base } = t;
  putAll(d, [{ table: 'threads', row: { ...base, holderId, status: last.outcome, endedAt: now } }]);
}

type RunColumns = Omit<FollowUpBase, 'id' | 'createdAt'>;

/** A run to add: its Odd and kind, and any column it sets. Every other column is empty, as a new row's are. */
export function newRun(
  r: Pick<RunColumns, 'staffId'> & { kind: LiveKind } & Partial<RunColumns>,
  now: Date
): Fresh<FollowUp> {
  return {
    askId: null,
    reportId: null,
    taskId: null,
    goalId: null,
    handOff: null,
    threadId: null,
    edit: null,
    note: null,
    pickedUp: null,
    reportWhenDone: false,
    chatCard: null,
    ...r,
    createdAt: now,
    run: { is: 'queued' }
  };
}

/**
 * Adds a run, and settles the thread it works on: so a
 * thread's holder and status never fall behind its runs. A run on work this
 * change opens points at the work's ref. Returns the run's ref.
 */
export function addRun(d: Draft, run: Fresh<FollowUp>, now: Date): Inserted {
  const ref = `run ${d.ids.size}`;
  const thread = run.threadId === null ? undefined : insertedRef(d, 'threads', run.threadId);
  putAll(d, [
    { table: 'followUps', ref, insert: run, ...(thread && { points: { threadId: thread } }) }
  ]);
  if (run.threadId !== null) settle(d, run.threadId, now);
  return { ref };
}

/**
 * New work, opened in this change once the entry checked its lead may lead
 * work, as `openThread` in ../threads.ts does. A goal set in the same change
 * (a `perKind` effect's ref) is pointed at, so the work takes the goal's real id.
 */
export function openThread(
  d: Draft,
  open: { title: string; hubId: string; goalId?: number | Inserted },
  runs: string[],
  now: Date
): Inserted {
  const ref = 'thread';
  const goal = open.goalId;
  putAll(d, [
    {
      table: 'threads',
      ref,
      insert: {
        title: open.title,
        goalId: goal === undefined ? null : typeof goal === 'number' ? goal : idOf(d, goal),
        hubId: open.hubId,
        holderId: open.hubId,
        handOffsUsed: 0,
        runs,
        createdAt: now,
        status: 'open',
        park: { on: 'none' }
      },
      ...(typeof goal === 'object' && { points: { goalId: goal.ref } })
    }
  ]);
  return { ref };
}

/**
 * A goal set, and its lead plans it: the goal's work opens under the lead,
 * which is the office's manager and so may always lead work, and the lead's
 * `goal` run goes on it (a goal's yes, and `addGoal`). `goal` is the goal's id, or the ref of the write
 * that sets it in this change. `chat` is the card the owner answered on: the
 * run replies under it only when it is that chat's Odd's.
 */
export function planGoal(
  d: Draft,
  o: { goal: number | Inserted; title: string; lead: string; chat?: InChat },
  now: Date
): void {
  const thread = openThread(d, { title: o.title, hubId: o.lead, goalId: o.goal }, [], now);
  const threadId = idOf(d, thread);
  const run = newRun(
    {
      staffId: o.lead,
      kind: 'goal',
      goalId: typeof o.goal === 'number' ? o.goal : idOf(d, o.goal),
      threadId,
      chatCard: chatCardOf(o.lead, o.chat) ?? null
    },
    now
  );
  // Put here rather than by `addRun`, which points only a run's thread: this one points at its goal too.
  const points = {
    threadId: thread.ref,
    ...(typeof o.goal === 'object' && { goalId: o.goal.ref })
  };
  putAll(d, [{ table: 'followUps', ref: `run ${d.ids.size}`, insert: run, points }]);
  settle(d, threadId, now);
}

/** The id this draft gave a row it inserted, or made up for a `perKind` effect, which its later steps read it by. */
export function idOf(d: Draft, row: Inserted): number {
  const id = d.ids.get(row.ref);
  if (id === undefined) throw fixedError('A change named a row it did not insert.');
  return id;
}

/**
 * Owe an Odd a run, as `followUp` does. The answer to
 * something raised on a thread works on that thread, unless its kind serves
 * none. With `onlyWhileOpen`, nothing is put once that work ended. `chat` is
 * the card the owner answered on: the run replies under it only when it is
 * that chat's Odd's.
 */
export function oweRun(
  d: Draft,
  run: OwedRun,
  o: { chat?: InChat; onlyWhileOpen?: true },
  now: Date
): void {
  const raisedOn = SERVES_NO_THREAD[run.kind]
    ? null
    : run.askId !== undefined
      ? d.rows.asks.get(run.askId)?.threadId
      : run.taskId !== undefined
        ? d.rows.tasks.get(run.taskId)?.threadId
        : null;
  const threadId = run.threadId ?? raisedOn ?? null;
  const open = threadId !== null && d.rows.threads.get(threadId)?.status === 'open';
  if (o.onlyWhileOpen && !open) return;
  addRun(
    d,
    newRun(
      {
        staffId: run.staffId,
        kind: run.kind,
        note: run.note,
        askId: run.askId ?? null,
        taskId: run.taskId ?? null,
        goalId: run.goalId ?? null,
        edit: run.edit ?? null,
        pickedUp: run.pickedUp ?? null,
        reportWhenDone: run.reportWhenDone ?? false,
        chatCard: chatCardOf(run.staffId, o.chat) ?? null,
        threadId
      },
      now
    ),
    now
  );
}

/**
 * A colleague's result goes back to the lead that handed it the work, as a
 * `handed_back` run on the work. Nothing
 * goes back to a lead that left the office, since it runs nothing: true when
 * the result went back. `answered` marks a result that is the owner's own
 * answer, which no run followed.
 */
export function handBack(
  d: Draft,
  handOff: HandOffRow,
  back: { outcome: Outcome; result: string; answered: boolean },
  now: Date
): boolean {
  const h = handOff.handOff;
  if (!h || hasLeft(d.rows, h.from)) return false;
  const carried: HandOff = {
    ...h,
    from: handOff.staffId,
    outcome: back.outcome,
    id: handOff.id,
    ...(back.answered && { answered: true })
  };
  addRun(
    d,
    newRun(
      {
        staffId: h.from,
        kind: 'handed_back',
        note: back.result,
        handOff: carried,
        threadId: handOff.threadId
      },
      now
    ),
    now
  );
  return true;
}

/** The columns every state of a thread shares. */
function baseOf(t: Thread): ThreadBase {
  if (t.status === 'open') {
    const { status: _, park: __, ...base } = t;
    return base;
  }
  const { status: _, endedAt: __, ...base } = t;
  return base;
}

/**
 * Done or failed work a lead may continue, which opens again for it. Not
 * stopped work: the owner said no to more of it, and only a new plan opens a
 * goal's stopped thread (`raisedOn`).
 */
const REOPENS: readonly Thread['status'][] = ['done', 'failed'];

/** An ended thread opened again for a new round of work: no park, and no hand-off counted yet. */
const reopened = (t: Thread): Thread => ({
  ...baseOf(t),
  handOffsUsed: 0,
  status: 'open',
  park: { on: 'none' }
});

/**
 * An ask raised or a task given on a thread keeps it waiting until the owner
 * answers. The thread keeps
 * the key of the run that raised it, only when that run is its lead's, so the
 * answer cannot start the lead there while that run still goes. Finished work
 * opens again for it; a stopped one stays stopped, but for a new plan, which
 * asks the owner afresh. Then the thread settles.
 */
export function raisedOn(
  d: Draft,
  threadId: number,
  o: { run?: string; by: string | null; plan: boolean },
  now: Date
): void {
  const t = d.rows.threads.get(threadId);
  if (!t) return;
  const runs =
    o.run && o.by !== null && t.hubId === o.by
      ? [...t.runs.filter((k) => k !== o.run), o.run]
      : t.runs;
  const opens = o.plan ? [...REOPENS, 'stopped'] : REOPENS;
  const next = opens.includes(t.status) ? reopened(t) : t;
  if (next !== t || runs !== t.runs) putAll(d, [{ table: 'threads', row: { ...next, runs } }]);
  settle(d, threadId, now);
}

/**
 * The owner stopped the work: it ends `stopped`, and nothing more runs on it.
 * The one place a thread becomes stopped. An ended thread holds no park, so
 * no time, window hold or task outlives the stop, and a new plan that opens
 * a stopped goal's thread again finds it waiting on nothing.
 */
export function stopThread(d: Draft, threadId: number, now: Date): void {
  const t = d.rows.threads.get(threadId);
  if (!t) return;
  putAll(d, [{ table: 'threads', row: { ...baseOf(t), status: 'stopped', endedAt: now } }]);
}

/**
 * One hand-off taken on a thread, `used` the count of its round so far with
 * this one: the `hand_off` run of `to`, carrying what `sharing()` gave for it.
 * An open thread keeps its park; done or failed work opens again with none.
 * A stopped thread stays stopped. Returns the run's ref.
 */
export function handOn(
  d: Draft,
  h: { threadId: number; to: string; handOff: HandOff; used: number },
  now: Date
): Inserted {
  const t = d.rows.threads.get(h.threadId);
  if (!t) throw fixedError('A hand-off was taken on work the rows do not hold.');
  const next = REOPENS.includes(t.status) ? reopened(t) : t;
  putAll(d, [{ table: 'threads', row: { ...next, handOffsUsed: h.used } }]);
  return addRun(
    d,
    newRun(
      { staffId: h.to, kind: 'hand_off', note: null, handOff: h.handOff, threadId: h.threadId },
      now
    ),
    now
  );
}

/**
 * The usage window holds a hand-off on a thread: the thread parks until the
 * window resets, held by the window's ask, which may be new in this change. Its
 * park replaces any other. Finished work opens again for a new round, with no
 * hand-off counted. Then the thread settles.
 */
export function holdForWindow(
  d: Draft,
  h: { threadId: number; at: Date; ask: number | Inserted },
  now: Date
): void {
  const t = d.rows.threads.get(h.threadId);
  if (!t) throw fixedError('A hand-off was held on work the rows do not hold.');
  const ask = typeof h.ask === 'number' ? h.ask : d.ids.get(h.ask.ref);
  if (ask === undefined) throw fixedError('A hand-off was held by an ask no earlier put made.');
  const handOffsUsed = t.status === 'open' ? t.handOffsUsed : 0;
  putAll(d, [
    {
      table: 'threads',
      row: { ...baseOf(t), handOffsUsed, status: 'open', park: { on: 'window', at: h.at, ask } },
      // A new ask's id is known only to the apply, so the thread points at its ref.
      ...(typeof h.ask === 'object' && { points: { heldBy: h.ask.ref } })
    }
  ]);
  settle(d, h.threadId, now);
}

const heldBy = (t: Thread | undefined, askId: number): t is Thread & { status: 'open' } =>
  t?.status === 'open' && t.park.on === 'window' && t.park.ask === askId;

/** The usage window's hold lifts: each named open thread `askId` holds is parked on nothing. */
export function freeFromWindow(d: Draft, askId: number, threadIds: readonly number[]): void {
  const held = threadIds.flatMap((id) => {
    const t = d.rows.threads.get(id);
    return heldBy(t, askId) ? [t] : [];
  });
  putAll(
    d,
    held.map((t) => ({ table: 'threads', row: { ...t, park: { on: 'none' } } }) as const)
  );
}
