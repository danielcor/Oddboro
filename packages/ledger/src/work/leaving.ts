// An Odd leaving the office, and being brought back: the deciders behind
// `removeOdd` and `bringBack` in ../leaving.ts. Each makes every decision on
// the work it closes through that work's own decider, folded into its one
// change (`foldIn`).
//
// Pure: every import that reaches the database is a type.
import { fixedError } from '../errors.ts';
import type { After, Decided } from '../transition.ts';
import { askDecided } from './asks.ts';
import type { AskEffects, EventOf, LiveKind } from './events.ts';
import { CUT_OFF_WORK, runFinished } from './runs.ts';
import {
  applyChange,
  changeOf,
  draft,
  foldIn,
  type Change,
  type Draft,
  type Outside,
  type WorkRows
} from './snapshot.ts';
import type { FollowUp } from './state.ts';
import { taskEnded } from './tasks.ts';
import { leftBeforeStarting, stopThread } from './threads.ts';

/** A run yet to start. Only a live kind's run can be: a retired kind's row is always ended. */
const queued = (f: FollowUp): f is Extract<FollowUp, { kind: LiveKind }> => f.run.is === 'queued';

/** A withdrawal is a no, and a no does no I/O: an effect called here is a bug, so it throws. */
const noIo = (): never => {
  throw fixedError('A withdrawn ask does no I/O.');
};
const NO_ASK_EFFECTS: AskEffects = {
  grantAccess: noIo,
  pointAsksAtConnector: noIo,
  carryOutTogether: noIo,
  oweCatchUp: noIo,
  removeOdd: noIo,
  bringBack: noIo
};

/** An open ask closed as a no, with `line` going back where it came from, as `withdrawAsk` in office-decide.ts does. */
function withdrawal(id: number, line: string): EventOf<'askDecided'> {
  return {
    kind: 'askDecided',
    id,
    decision: 'deny',
    reason: line,
    inChat: false,
    withdrawn: line,
    perKind: [],
    effects: NO_ASK_EFFECTS
  };
}

/**
 * A draft whose rows already show `outside` written, so every step after it
 * reads the Odd gone or back, as today's steps run after that write commits.
 */
function draftAfter(rows: WorkRows, outside: Outside[]): Draft {
  return draft(applyChange(rows, { put: [], outside, result: null }), outside);
}

/**
 * One decision of another family's decider, folded into `d` under `tag`,
 * and what follows its commit. A refusal folds nothing: each step here
 * closes open work, and the only refusal left is work an earlier step of
 * this change closed already, such as an ask answered as another's twin.
 */
function step(d: Draft, decided: Decided<Change>, tag: string): After[] {
  if ('refused' in decided) return [];
  foldIn(d, decided.change, tag);
  return decided.after;
}

/**
 * The owner lets an Odd go, for `removeOdd`. It leaves the floor with its
 * jobs off and its waiting pokes cancelled, and every thread it leads stops,
 * waiting on nothing. Then, in that order, each open ask it raised or that
 * is about it is withdrawn, each open task it gave is dropped as withdrawn,
 * and each of its runs yet to start fails, through the runs' own end, which
 * tells a colleague's result's owner when no lead is left to take it. Every
 * step reads the Odd as gone. One that is gone already leaves nothing to do.
 */
export function oddRemoved(
  rows: WorkRows,
  e: EventOf<'oddRemoved'>,
  now: Date
): Decided<Change<null>> {
  const { staffId } = e;
  const odd = rows.staff.get(staffId);
  // Someone else let it go a moment ago.
  if (!odd || odd.leftAt) return { change: changeOf(draft(rows), null), after: [] };
  const d = draftAfter(rows, [
    { kind: 'leave', staffId, at: now },
    { kind: 'cancelPokes', staffId }
  ]);
  const byId = <T extends { id: number }>(xs: Iterable<T>, keep: (x: T) => boolean): T[] =>
    [...xs].filter(keep).sort((a, b) => a.id - b.id);

  // Done and failed work stops too, so nothing it led opens again.
  for (const t of byId(
    d.rows.threads.values(),
    (t) => t.hubId === staffId && t.status !== 'stopped'
  ))
    stopThread(d, t.id, now);

  const after: After[] = [];
  const line = `${odd.name} left the office, so this will not go ahead.`;
  // Its own asks, and any other ask about it, such as the manager's to let it go.
  for (const a of byId(
    d.rows.asks.values(),
    (a) => a.status === 'open' && (a.staffId === staffId || a.odd === staffId)
  )) {
    const said = a.staffId === staffId ? line : `${odd.name} left the office already.`;
    after.push(...step(d, askDecided(d.rows, withdrawal(a.id, said), now), `ask ${a.id}`));
  }
  for (const t of byId(d.rows.tasks.values(), (t) => t.status === 'open' && t.staffId === staffId))
    after.push(
      ...step(
        d,
        taskEnded(
          d.rows,
          { kind: 'taskEnded', id: t.id, ended: 'withdrawn', note: line, inChat: false },
          now
        ),
        `task ${t.id}`
      )
    );
  // Last, so a run the steps above queued for it fails too. Only one yet to
  // start: one an earlier leaving failed has ended, and never fails twice.
  for (const f of byId(d.rows.followUps.values(), (f) => f.staffId === staffId).filter(queued))
    after.push(
      ...step(
        d,
        runFinished(
          d.rows,
          {
            kind: 'runFinished',
            id: f.id,
            about: e.about.get(f.id) ?? CUT_OFF_WORK[f.kind],
            ended: {
              outcome: 'failed',
              result: leftBeforeStarting(odd.name),
              joined: []
            }
          },
          now
        ),
        `run ${f.id}`
      )
    );

  const stopRuns = e.effects.stopRuns;
  return {
    change: changeOf(d, null),
    after: [{ then: 'stopRuns', run: async () => stopRuns(staffId) }, ...after, { record: e.line }]
  };
}

/**
 * The owner brings an Odd back as it was, for `bringBack`: on the floor,
 * with the jobs that were on when it left turned on again from now. Every
 * other open ask to bring it back is withdrawn, since nothing is left for it
 * to do. What it had open when it left stays closed. This does not check
 * that the Odd had left, so a second bring-back racing the first writes
 * again.
 */
export function oddBroughtBack(
  rows: WorkRows,
  e: EventOf<'oddBroughtBack'>,
  now: Date
): Decided<Change<null>> {
  const { staffId } = e;
  const odd = rows.staff.get(staffId);
  if (!odd) return { change: changeOf(draft(rows), null), after: [] };
  const d = draftAfter(rows, [{ kind: 'comeBack', staffId }]);
  const line = `${odd.name} is back in the office already.`;
  const twins = [...d.rows.asks.values()]
    .filter((a) => a.status === 'open' && a.odd === staffId && a.kind === 'bring_back')
    .sort((a, b) => a.id - b.id);
  const after = twins.flatMap((a) =>
    step(d, askDecided(d.rows, withdrawal(a.id, line), now), `ask ${a.id}`)
  );
  return { change: changeOf(d, null), after: [...after, { record: e.line }] };
}
