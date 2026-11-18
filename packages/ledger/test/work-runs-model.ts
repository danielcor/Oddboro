// The sequence test's model of runs (work-sequences.test.ts): what queueing,
// claiming and finishing a run do, from the events alone. Pure: no database.
import type { Outcome } from '../src/schema.ts';
import type { LiveKind, WorkEvent } from '../src/work/events.ts';
import { SERVES_NO_THREAD } from '../src/work/kinds.ts';
import { ranOwn, wake } from './work-answers-model.ts';
import {
  askOf,
  insert,
  left,
  meet,
  newRun,
  settle,
  titleOf,
  type Model,
  type RunRec
} from './work-model.ts';

/** Events offered once each: the runs an entry function may owe, and a goal's change of status. */
export const OWED: WorkEvent[] = [
  // A project's result, which starts nothing once its work ended.
  {
    kind: 'runQueued',
    run: { staffId: 'ada', kind: 'resume', threadId: 2, note: 'A project result came back.' },
    onlyWhileOpen: true
  },
  // Works on the thread ask 2 was raised on.
  { kind: 'runQueued', run: { staffId: 'rico', kind: 'carry_out', askId: 2, note: null } },
  {
    kind: 'runQueued',
    run: { staffId: 'tess', kind: 'edited', note: null, edit: { path: 'notes.md', before: '' } }
  },
  // Decides nothing: a goal's status tells its Odds nothing yet.
  { kind: 'goalStatusChanged', goalId: 1, status: 'paused' }
];

/** The kinds a run of which acts at Draft at most, written out here so a change to the code's list shows. */
const DRAFT_KINDS: ReadonlySet<LiveKind> = new Set([
  'hand_off',
  'handed_back',
  'resume',
  'answered',
  'denied',
  'edited'
]);

/** The hand-off a run's work serves: its own, or the one the ask or task it follows was raised in. */
function servedHandOff(r: Model, f: RunRec): RunRec | undefined {
  if (f.kind === 'hand_off') return f;
  if (SERVES_NO_THREAD[f.kind]) return undefined;
  const link =
    f.askId !== null
      ? askOf(r, f.askId)?.handOffId
      : f.taskId !== null
        ? r.tasks.get(f.taskId)?.handOffId
        : null;
  const origin = link == null ? undefined : r.runs.get(link);
  return origin?.kind === 'hand_off' ? origin : undefined;
}

/** The owner answered everything the hand-off raised: it raised an ask or a task, and none is open. */
function answeredAll(r: Model, handOffId: number): boolean {
  const raised = r.asks.filter((a) => a.handOffId === handOffId);
  const tasks = [...r.tasks.values()].filter(
    (k) => k.handOffId === handOffId || raised.some((a) => a.id === k.askId)
  );
  const all = [...raised, ...tasks];
  return all.length > 0 && all.every((a) => a.status !== 'open');
}

export function queue(r: Model, e: Extract<WorkEvent, { kind: 'runQueued' }>): void {
  r.owedSent.add(OWED.indexOf(e));
  const o = e.run;
  // An Odd that left is owed nothing (nothing stays open for an Odd that left): its leaving failed every run it had.
  if (left(r, o.staffId)) {
    meet('a run owed to an Odd that left');
    return;
  }
  const raisedOn = o.askId === undefined ? null : (askOf(r, o.askId)?.threadId ?? null);
  const threadId = o.threadId ?? (SERVES_NO_THREAD[o.kind] ? null : raisedOn);
  const open = threadId !== null && r.threads.get(threadId)?.status === 'open';
  if (e.onlyWhileOpen && !open) return;
  insert(
    r,
    newRun({
      staffId: o.staffId,
      kind: o.kind,
      threadId,
      askId: o.askId ?? null,
      lines: o.note === null ? 0 : 1
    })
  );
}

export function claim(r: Model, id: number): void {
  const x = r.expected;
  const f = r.runs.get(id)!;
  if (f.is !== 'queued') {
    x.refused = 'not waiting';
    meet('a claim of a run not waiting to start');
    return;
  }
  const t = f.threadId === null ? undefined : r.threads.get(f.threadId);
  if (f.kind !== 'hand_off' && t) {
    const ownRun = [...r.runs.values()].some(
      (g) => g.staffId === f.staffId && g.threadId === t.id && g.is === 'running'
    );
    const jobGoing = t.hub === f.staffId && t.leadsJobGoing;
    if (ownRun) meet('a claim held while its Odd runs on that work');
    if (jobGoing) meet("a lead's claim held while its job runs on that work");
    if (ownRun || jobGoing) {
      x.refused = 'held';
      return;
    }
  }
  f.is = 'running';
  f.unparked = null;
  // A lead's claim lifts a park on a task or a time, never the usage window's hold.
  if (
    t?.status === 'open' &&
    t.hub === f.staffId &&
    (t.park.on === 'task' || t.park.on === 'time')
  ) {
    f.unparked = t.park.on === 'task' ? { task: t.park.task } : { at: t.park.at };
    t.park = { on: 'none' };
  }
  f.joined =
    f.kind === 'handed_back' && t
      ? [...r.runs.values()]
          .filter(
            (g) =>
              g.id !== f.id &&
              g.staffId === f.staffId &&
              g.threadId === t.id &&
              g.kind === 'handed_back' &&
              g.is === 'queued'
          )
          .map((g) => g.id)
          .sort((a, b) => a - b)
      : [];
  if (f.joined.length > 0) meet('a claim joining results');
  x.joined = f.joined;
  const level = r.odds.get(f.staffId)!.level;
  x.ceiling = level === 'read' ? 'read' : DRAFT_KINDS.has(f.kind) ? 'draft' : level;
  meet(`a claim at ${x.ceiling} by an Odd at ${level}`);
}

export function finish(
  r: Model,
  id: number,
  outcome: Outcome,
  joinedIds: number[],
  about: string
): void {
  const x = r.expected;
  const f = r.runs.get(id)!;
  if (f.is === 'ended') {
    x.refused = 'ended';
    meet('a second finish');
    return;
  }
  const wasRunning = f.is === 'running';
  const t = f.threadId === null ? undefined : r.threads.get(f.threadId);
  const origin = servedHandOff(r, f);
  const lead = origin ? origin.handOff!.from : t?.hub;
  const goesBack =
    !!origin?.handOff &&
    (outcome !== 'waiting' || (f.kind === 'hand_off' && !answeredAll(r, origin.id)));
  x.leadLeft = lead !== undefined && left(r, lead);
  const wouldReport = outcome === 'failed' ? !goesBack : outcome === 'done' && f.reportWhenDone;
  if (x.leadLeft && wouldReport) meet('a report held back because the lead left');
  if (!x.leadLeft && wouldReport)
    x.reports.push({
      staffId: f.staffId,
      title: titleOf(r, f.kind, outcome, about)
    });
  x.failureReport = outcome === 'failed' && !goesBack && !left(r, f.staffId) && !x.leadLeft;
  if (x.failureReport) meet('a failure no lead hears of');
  if (outcome === 'waiting' && origin) {
    if (f.kind !== 'hand_off') meet('a run serving a hand-off ends waiting');
    else if (goesBack)
      meet(
        r.asks.some((a) => a.handOffId === origin.id)
          ? 'a hand-off ends waiting with something raised still open'
          : 'a hand-off that raised nothing ends waiting'
      );
    else meet('a hand-off ends waiting with everything raised answered');
  }

  const ending = joinedIds
    .map((j) => r.runs.get(j)!)
    .filter((g) => g.staffId === f.staffId && g.kind === 'handed_back' && g.is === 'queued');
  if (ending.length > 0) meet('a finish ending joined results');

  if (goesBack && left(r, origin!.handOff!.from) && outcome !== 'waiting')
    x.pokes.push({
      staffId: f.staffId,
      lead: r.odds.get(origin!.handOff!.from)!.name,
      title: origin!.handOff!.title
    });
  if (t?.hub === f.staffId && left(r, f.staffId))
    for (const g of [f, ...ending]) {
      const h = g.handOff;
      if (g.kind !== 'handed_back' || !h?.outcome || h.outcome === 'waiting' || h.answered)
        continue;
      x.pokes.push({ staffId: h.from, lead: r.odds.get(f.staffId)!.name, title: h.title });
    }
  if (x.pokes.length > 0) meet('a colleague pokes the owner for a lead that left');

  for (const g of [f, ...ending]) {
    g.is = 'ended';
    g.outcome = outcome;
    g.doneAt = r.at;
    x.ended.push({ id: g.id, outcome });
  }

  const lifted = outcome === 'failed' && wasRunning ? f.unparked : null;
  const givesBack = !!lifted && t?.status === 'open' && t.park.on === 'none';
  if (givesBack && lifted)
    t!.park = 'task' in lifted ? { on: 'task', ...lifted } : { on: 'time', ...lifted };

  const wentBack = goesBack && !left(r, origin!.handOff!.from);
  if (wentBack) {
    const h = {
      staffId: origin!.handOff!.from,
      from: f.staffId,
      outcome,
      threadId: origin!.threadId
    };
    x.handedBack.push(h);
    meet('a result handed back to its lead');
    insert(
      r,
      newRun({
        staffId: h.staffId,
        kind: 'handed_back',
        threadId: h.threadId,
        handOff: { from: f.staffId, title: origin!.handOff!.title, outcome },
        lines: 1
      })
    );
  } else settle(r, f.threadId);

  const k = givesBack && lifted && 'task' in lifted ? r.tasks.get(lifted.task) : undefined;
  if (k && k.status !== 'open') {
    meet('a park given back on a task that ended');
    // The task's own run, if its end started one, was set going before this wake.
    wake(r, k.id, ranOwn(r, k));
  }
}
