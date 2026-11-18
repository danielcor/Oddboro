// A follow-up run from start to end: queued, claimed, finished, or closed
// after a restart cut it off. Each decider mirrors the database code it
// replaces, named on each, and takes every fact from the loaded rows, so no
// caller passes a flag such as "this work stopped".
//
// Pure: every import that reaches the database is a type.
import { flat } from '../desk-answers.ts';
import { fixedError } from '../errors.ts';
import type { Unparked } from '../office-follow-ups.ts';
import type { FollowUpKind, Outcome } from '../schema.ts';
import type { TaskEnded } from '../task-parking.ts';
import type { After, Decided } from '../transition.ts';
import { ownRunOf, wakeParked } from './answers.ts';
import type { Claimed, EventOf, LiveKind, RunEnded } from './events.ts';
import { runCeiling, runsAtDraft, SERVES_NO_THREAD } from './kinds.ts';
import { changeOf, draft, putAll, type Change, type WorkRows } from './snapshot.ts';
import type { FollowUp, RunState, Task } from './state.ts';
import {
  handBack,
  hasLeft,
  isHandOff,
  oweRun,
  planGoal,
  settle,
  type HandOffRow
} from './threads.ts';

/**
 * The ledger title of each follow-up as it ends, before what it was about. The
 * owner reads these in the Ledger window, so none names a thread or a hand-off.
 */
export const OUTCOME_TITLE: Record<FollowUpKind, Record<Outcome, string>> = {
  carry_out: { done: 'Did', failed: 'Failed', waiting: 'Waiting on {owner} for' },
  rework: { done: 'Reworked', failed: 'Could not rework', waiting: 'Reworked' },
  denied: {
    done: 'Took in the no on',
    failed: 'Could not take in the no on',
    waiting: 'Waiting on {owner} after the no on'
  },
  task_done: {
    done: 'Picked up after',
    failed: 'Could not pick up after',
    waiting: 'Waiting on {owner} after'
  },
  first_day: {
    done: 'First day',
    failed: 'First day stalled',
    waiting: 'First day, waiting on {owner}'
  },
  goal: {
    done: 'Planned the goal',
    failed: 'Could not plan the goal',
    waiting: 'Brought {owner} the plan for the goal'
  },
  hand_off: {
    done: 'Did work a colleague handed over',
    failed: 'Could not do work a colleague handed over',
    waiting: 'Waiting on {owner} for work a colleague handed over'
  },
  handed_back: {
    done: 'Picked up what a colleague finished',
    failed: 'Could not pick up what a colleague finished',
    waiting: 'Waiting on {owner} after a colleague finished'
  },
  resume: {
    done: 'Picked back up',
    failed: 'Could not pick back up',
    waiting: 'Waiting on {owner} after picking back up'
  },
  answered: {
    done: 'Acted on your answer to',
    failed: 'Could not act on your answer to',
    waiting: 'Waiting on {owner} after your answer to'
  },
  edited: {
    done: "Read {owner}'s edit to",
    failed: "Could not read {owner}'s edit to",
    waiting: 'Waiting on {owner} after their edit to'
  }
};

/** The result of a run a restart cut off. */
export const CUT_OFF_RESULT =
  'The office restarted while this was running, so it may be half done. Check it, then ask the Odd to finish it.';

/**
 * What the Ledger names work when no title is left for it, such as an ask
 * since removed, or a first day. The owner reads it after each kind's
 * `OUTCOME_TITLE`, so it names no thread and no number (test/owner-tables.test.ts).
 */
export const CUT_OFF_WORK: Record<FollowUpKind, string> = {
  carry_out: 'an ask',
  rework: 'an ask',
  denied: 'an ask',
  task_done: 'a task',
  first_day: 'getting started',
  goal: 'a goal',
  hand_off: 'the work',
  handed_back: 'the work',
  resume: 'the work',
  answered: 'your answer',
  edited: 'a file'
};

/** A follow-up of a kind the office still starts, running or not; run-registry's `LiveRun` is a process that is running. */
export type LiveFollowUp = Extract<FollowUp, { kind: LiveKind }>;
/** The park a lead's claim lifted, which a failed run gives back. */
type Lifted = Extract<RunState, { is: 'running' }>['unparked'];

/** A run not yet ended. A retired kind's row is always ended, so such a run is of a live kind. */
const notEnded = (f: FollowUp | undefined): f is LiveFollowUp => !!f && f.run.is !== 'ended';

/**
 * Owe an Odd a run: a source's run, as `followUp` puts it, or a goal's
 * planning run on the goal's new work, as `addGoal` does. An Odd that has
 * left is owed nothing, as `onlyWhileOpen` puts nothing on ended work: its
 * leaving failed every run it had, and no later one may wait for it.
 */
export function runQueued(
  rows: WorkRows,
  e: EventOf<'runQueued'>,
  now: Date
): Decided<Change<null>> {
  const d = draft(rows);
  const { run, opens } = e;
  if (hasLeft(rows, run.staffId)) return { change: changeOf(d, null), after: [] };
  if (!opens) oweRun(d, run, e, now);
  else if (run.kind === 'goal' && run.goalId !== undefined)
    planGoal(d, { goal: run.goalId, title: opens.title, lead: run.staffId, chat: e.chat }, now);
  else throw fixedError("Only a goal's planning run opens new work.");
  return { change: changeOf(d, null), after: [] };
}

/**
 * The `hand_off` a run's work serves, as `servesHandOff` finds it: its own,
 * or the one the ask or task it answers was raised in. A lead's pick-up
 * serves none: its asks are its own.
 */
function servesHandOff(rows: WorkRows, f: LiveFollowUp): HandOffRow | undefined {
  if (isHandOff(f)) return f;
  if (SERVES_NO_THREAD[f.kind]) return undefined;
  const link =
    f.askId !== null
      ? rows.asks.get(f.askId)?.handOffId
      : f.taskId !== null
        ? rows.tasks.get(f.taskId)?.handOffId
        : null;
  const origin = link ? rows.followUps.get(link) : undefined;
  return isHandOff(origin) ? origin : undefined;
}

/**
 * Whether the owner already answered everything a hand-off put on the desk,
 * as `answeredAll` reads it: it raised an ask or a task, and none of it is
 * still open. A tool's connect task belongs to the access ask it came from.
 */
function answeredAll(rows: WorkRows, handOffId: number): boolean {
  const raised = [...rows.asks.values()].filter((a) => a.handOffId === handOffId);
  const raisedIds = new Set(raised.map((a) => a.id));
  const given = [...rows.tasks.values()].filter(
    (k) => k.handOffId === handOffId || (k.askId !== null && raisedIds.has(k.askId))
  );
  const all = [...raised, ...given];
  return all.length > 0 && all.every((r) => r.status !== 'open');
}

/**
 * Claim a queued run, as `startFollowUp` does. An Odd runs once at a time on
 * a thread (`waitsOnOwnRun`): any run but a hand-off waits while a run of the
 * same Odd there has yet to end, and a lead's waits while a run that put work
 * on its thread goes. A lead's claim ends its park on a task or a time, never
 * a usage-window hold, which is the office's, and the run keeps the wait it
 * lifted so a failure gives it back. A lead's pick-up of a result takes with
 * it the lead's other results there still queued (`resultsToJoin`): they stay
 * queued until this run ends them, so a restart that cuts it off leaves them
 * for the next pick-up.
 */
export function runClaimed(
  rows: WorkRows,
  e: EventOf<'runClaimed'>,
  now: Date
): Decided<Change<Claimed>> {
  const f = rows.followUps.get(e.id);
  if (!notEnded(f) || f.run.is !== 'queued')
    return { refused: 'That run is not waiting to start.' };
  const odd = rows.staff.get(f.staffId);
  if (!odd) throw fixedError('A run was claimed with its Odd not loaded.');
  const t = f.threadId === null ? undefined : rows.threads.get(f.threadId);
  if (f.kind !== 'hand_off' && t) {
    const ownRun = [...rows.followUps.values()].some(
      (g) => g.staffId === f.staffId && g.threadId === t.id && g.run.is === 'running'
    );
    const leadsGoing = t.hubId === f.staffId && t.runs.some((k) => rows.runsGoing.has(k));
    if (ownRun || leadsGoing) return { refused: 'Its Odd still runs on that work.' };
  }
  const park = t?.status === 'open' && t.hubId === f.staffId ? t.park : undefined;
  const lifted: Lifted =
    park?.on === 'task' ? { task: park.task } : park?.on === 'time' ? { at: park.at } : null;
  const run: LiveFollowUp = { ...f, run: { is: 'running', startedAt: now, unparked: lifted } };
  const d = draft(rows);
  putAll(d, [{ table: 'followUps', row: run }]);
  if (t?.status === 'open' && lifted)
    putAll(d, [{ table: 'threads', row: { ...t, park: { on: 'none' } } }]);
  const task = lifted && 'task' in lifted ? rows.tasks.get(lifted.task) : undefined;
  const unparked: Unparked | undefined = task
    ? { task: task.title }
    : lifted && 'at' in lifted
      ? { at: lifted.at }
      : undefined;
  const joined =
    f.kind === 'handed_back' && t
      ? [...rows.followUps.values()]
          .filter(
            (g) =>
              g.id !== f.id &&
              g.staffId === f.staffId &&
              g.threadId === t.id &&
              g.kind === 'handed_back' &&
              g.run.is === 'queued'
          )
          .sort((a, b) => a.id - b.id)
      : [];
  const ask = f.askId === null ? undefined : rows.asks.get(f.askId);
  const ceiling = runCeiling(
    odd.level,
    runsAtDraft({
      kind: f.kind,
      serves: !!servesHandOff(rows, f),
      carriesApproval: f.kind === 'carry_out' && ask?.kind === 'approval',
      actsOnHandOffs: odd.actsOnHandOffs
    })
  );
  return {
    change: changeOf(d, { run, ...(unparked && { unparked }), joined, ceiling }),
    after: []
  };
}

/**
 * How a task that ended during a run reads to the work that run gives the
 * park back to: taken off the desk by the office or its Odd, dropped by the
 * owner, or done. Read from the row, not from whether its Odd is gone: one
 * brought back since has no mark of leaving.
 */
function endedAs(t: Task): TaskEnded {
  return t.status === 'done'
    ? 'done'
    : t.status === 'dropped' && t.withdrawn
      ? 'withdrawn'
      : 'dropped';
}

/**
 * A colleague's result that no lead takes, since the lead that handed it the
 * work left the office (`hasLeft`): nothing picks the work up. The owner
 * ruled that nothing goes on the desk for it. The colleague, the last Odd on
 * the work, pokes the owner now, and the Ledger keeps a line. What the
 * colleague did stays in the work's folder.
 */
type Unreturned = {
  colleague: { id: string; name: string };
  lead: string;
  title: string;
  outcome: Exclude<Outcome, 'waiting'>;
};

/** The poke and the Ledger line for a colleague's result no lead takes. */
function unreturned(u: Unreturned): { poke: string; line: After } {
  const did = u.outcome === 'done' ? 'finished' : 'could not finish';
  const yet = u.outcome === 'done' ? 'but' : 'and';
  return {
    poke: `${u.colleague.name} ${did} "${u.title}", ${yet} could not hand it back to ${u.lead} because ${u.lead} is no longer here.`,
    line: {
      record: {
        kind: 'work',
        actor: u.colleague.id,
        title: `${u.outcome === 'done' ? 'Finished' : 'Could not finish'}, but ${u.lead} has left: ${u.title}`,
        body: `${u.colleague.name} ${did} "${u.title}", but ${u.lead} has left the office, so nothing picks the work up. What ${u.colleague.name} did stays in the work's folder.`
      }
    }
  };
}

/**
 * Record how a run ended, once, as `finishFollowUp` does. Every outcome goes
 * in the Ledger. The owner's desk gets a failure no lead is woken for, and a
 * success only when the owner asked for one; nothing when the work's lead
 * left the office, since the owner let it go and the work stopped with it
 * (NEW-1862). Work that serves a hand-off goes back to the lead that handed
 * it: the hand-off's own run however it ended, a later run once it ended
 * done or failed. With that lead gone, the colleague pokes the owner
 * instead, and so does the colleague of each result a departed lead's own
 * pick-up ends unread (NEW-1863). A failed lead's run gives back the park
 * its claim lifted, and when that task ended meanwhile, the wake that end
 * would have given happens in this same change, so the work is never left
 * parked on a task that is over.
 */
export function runFinished(
  rows: WorkRows,
  e: EventOf<'runFinished'>,
  now: Date
): Decided<Change<null>> {
  const f = rows.followUps.get(e.id);
  if (!notEnded(f)) return { refused: 'That run has ended already.' };
  return finish(rows, f, e.about, e.ended, now);
}

/** A run a restart cut off fails rather than run twice, as `closeStaleFollowUps` closes it. */
export function staleRunsClosed(
  rows: WorkRows,
  e: EventOf<'staleRunsClosed'>,
  now: Date
): Decided<Change<null>> {
  const f = rows.followUps.get(e.id);
  if (!notEnded(f) || f.run.is !== 'running') return { refused: 'That run is not running.' };
  return finish(rows, f, e.about, { outcome: 'failed', result: CUT_OFF_RESULT, joined: [] }, now);
}

function finish(
  rows: WorkRows,
  f: LiveFollowUp,
  about: string,
  ended: RunEnded,
  now: Date
): Decided<Change<null>> {
  const { outcome, result } = ended;
  const nameOf = (id: string) => rows.staff.get(id)?.name ?? id;
  const title = `${OUTCOME_TITLE[f.kind][outcome].replace('{owner}', rows.owner)}: ${about}`;
  const origin = servesHandOff(rows, f);
  const thread = f.threadId === null ? undefined : rows.threads.get(f.threadId);
  // The lead the work answers to: the one that handed it, else the thread's.
  const lead = origin ? origin.handOff?.from : thread?.hubId;
  const back =
    !!origin?.handOff &&
    (outcome !== 'waiting' || (f.kind === 'hand_off' && !answeredAll(rows, origin.id)));
  const reported =
    !(lead && hasLeft(rows, lead)) &&
    (outcome === 'failed' ? !back : outcome === 'done' && f.reportWhenDone);
  // The joined results end with this run, as if each had run in it.
  const joined = ended.joined.flatMap((id) => {
    const g = rows.followUps.get(id);
    return g?.staffId === f.staffId && g.kind === 'handed_back' && g.run.is === 'queued' ? [g] : [];
  });

  const lost: Unreturned[] = [];
  if (back && origin.handOff && hasLeft(rows, origin.handOff.from) && outcome !== 'waiting')
    lost.push({
      colleague: { id: f.staffId, name: nameOf(f.staffId) },
      lead: nameOf(origin.handOff.from),
      title: flat(origin.handOff.title),
      outcome
    });
  // A departed lead's pick-up of a colleague's result: that colleague tells
  // the owner, unless the result is the owner's own answer, or it waited on
  // the owner, whose item is on the desk already.
  const leftOwnWork = thread?.hubId === f.staffId && hasLeft(rows, f.staffId);
  for (const g of leftOwnWork ? [f, ...joined] : []) {
    const h = g.handOff;
    if (g.kind !== 'handed_back' || !h?.outcome || h.outcome === 'waiting' || h.answered) continue;
    lost.push({
      colleague: { id: h.from, name: nameOf(h.from) },
      lead: nameOf(f.staffId),
      title: flat(h.title),
      outcome: h.outcome
    });
  }

  const d = draft(rows, [
    ...(reported ? [{ kind: 'report', staffId: f.staffId, title, body: result } as const] : []),
    ...lost.map(
      (u) => ({ kind: 'poke', staffId: u.colleague.id, message: unreturned(u).poke }) as const
    )
  ]);
  const startedAt = f.run.is === 'running' ? f.run.startedAt : null;
  putAll(d, [
    {
      table: 'followUps',
      row: { ...f, run: { is: 'ended', outcome, result, doneAt: now, startedAt } }
    },
    ...joined.map(
      (g) =>
        ({
          table: 'followUps',
          row: { ...g, run: { is: 'ended', outcome, result, doneAt: now, startedAt: now } }
        }) as const
    )
  ]);

  // A lead's run that ended a park failed: the wait comes back, unless the
  // run parked the work again or the work ended.
  const lifted: Lifted = outcome === 'failed' && f.run.is === 'running' ? f.run.unparked : null;
  const giveBack =
    lifted && thread?.status === 'open' && thread.park.on === 'none' ? thread : undefined;
  if (giveBack && lifted)
    putAll(d, [
      {
        table: 'threads',
        row: {
          ...giveBack,
          park: 'task' in lifted ? { on: 'task', task: lifted.task } : { on: 'time', at: lifted.at }
        }
      }
    ]);

  // The result going back moves the work on; with none, the outcome may end it.
  const wentBack = back && handBack(d, origin, { outcome, result, answered: false }, now);
  if (!wentBack && thread) settle(d, thread.id, now);

  // The task ended during the run: the work wakes now, told that the task's
  // own run was set going back when the task ended and carries its own part.
  const task = giveBack && lifted && 'task' in lifted ? rows.tasks.get(lifted.task) : undefined;
  if (task && task.status !== 'open') {
    const own = ownRunOf(d.rows, task);
    wakeParked(
      d,
      task,
      { ended: endedAs(task), ...(own && { ownRun: { ...own, earlier: true } }) },
      now
    );
  }

  return {
    change: changeOf(d, null),
    after: [
      {
        record: {
          kind: 'work',
          actor: f.staffId,
          title,
          body: result,
          ...(f.askId !== null && { askId: f.askId })
        }
      },
      ...lost.map((u) => unreturned(u).line)
    ]
  };
}
