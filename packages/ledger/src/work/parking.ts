// Parked work: a lead parks its work until a time or until a task ends, and
// the office clock wakes work whose time came. Each decider mirrors the
// database code it replaces, named on each, and takes every fact from the
// loaded rows.
//
// Pure: every import that reaches the database is a type.
import { flat, SAID_AS } from '../desk-answers.ts';
import type { Decided } from '../transition.ts';
import { answerLead } from './answers.ts';
import type { EventOf } from './events.ts';
import { changeOf, draft, putAll, type Change, type WorkRows } from './snapshot.ts';

/** What a held thread's lead is told when the clock wakes it at the reset. */
export const WINDOW_RESET =
  'The usage window has reset, so hand-offs run again. Hand on the work the office held.';

/**
 * The lead parks its work until a time, as `parkThread` in ../threads.ts
 * does, or until a task on the owner's desk ends, as `parkOnTask` in
 * ../task-parking.ts does. A park replaces the one before it, so work waits
 * on one thing. Another Odd's task on work this Odd is not on reads as no
 * task at all, so a park gives away nothing about it.
 */
export function parked(
  rows: WorkRows,
  e: EventOf<'parked'>
): Decided<Change<{ at: Date } | { title: string }>> {
  const notLed = { refused: `Work ${e.threadId} has ended, or is not work you lead.` };
  const t = rows.threads.get(e.threadId);
  const led = t?.status === 'open' && t.hubId === e.staffId ? t : undefined;
  const d = draft(rows);
  if ('at' in e.on) {
    if (!led) return notLed;
    putAll(d, [{ table: 'threads', row: { ...led, park: { on: 'time', at: e.on.at } } }]);
    return { change: changeOf(d, { at: e.on.at }), after: [] };
  }
  const taskId = e.on.task;
  const task = rows.tasks.get(taskId);
  // The task's work: its own, else the work of the ask it came from (`taskThread`).
  const on =
    task && (task.threadId ?? (task.askId !== null ? rows.asks.get(task.askId)?.threadId : null));
  const onItsWork =
    on !== undefined &&
    on !== null &&
    (rows.threads.get(on)?.hubId === e.staffId || e.worksOn.has(on));
  if (!task || (task.staffId !== e.staffId && !onItsWork))
    return { refused: `There is no task ${taskId}.` };
  if (task.status !== 'open')
    return { refused: `Already ${SAID_AS[task.status]}: do it now, in this run.` };
  // A connect-only ask's yes starts no run on its work (`resumesWork`), so the
  // task's end would bring nothing back: the work waits on it instead.
  const connectOnly = task.askId !== null && !!rows.asks.get(task.askId)?.access?.connectOnly;
  if (on === e.threadId && !connectOnly)
    return {
      refused:
        'That task is on this work, so the answer to it already brings you back. Finish this run with "Outcome: waiting".'
    };
  if (!led) return notLed;
  putAll(d, [{ table: 'threads', row: { ...led, park: { on: 'task', task: taskId } } }]);
  return { change: changeOf(d, { title: flat(task.title) }), after: [] };
}

/**
 * The time a thread was parked until has come, as `wakeThread` in
 * ../threads.ts does: the park lifts and its lead picks the work up, joining
 * a pick-up of its there still queued, so the work wakes once. Work the
 * usage window held is told the window reset. The window's ask leaves the
 * desk by the office clock at the reset (`windowAsksDue` in
 * ../office-usage.ts), not here, since work it held may have stopped first.
 * Work that is not due, or ended, wakes for nothing.
 */
export function clockWoke(
  rows: WorkRows,
  e: EventOf<'clockWoke'>,
  now: Date
): Decided<Change<null>> {
  const d = draft(rows);
  const t = rows.threads.get(e.threadId);
  const open = t?.status === 'open' ? t : undefined;
  const park = open?.park;
  if (!open || !park || (park.on !== 'time' && park.on !== 'window') || park.at > now)
    return { change: changeOf(d, null), after: [] };
  putAll(d, [{ table: 'threads', row: { ...open, park: { on: 'none' } } }]);
  answerLead(d, open.id, park.on === 'window' ? WINDOW_RESET : null, {}, now);
  return { change: changeOf(d, null), after: [] };
}
