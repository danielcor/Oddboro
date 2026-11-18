// The sequence test's own record of the office (work-sequences.test.ts), and
// what every family's model of events shares, such as the rule that settles a
// thread. Each family's model is a work-<family>-model.ts beside this file.
// Pure: no database.
import type { Level } from '../src/access-words.ts';
import type { Agent } from '../src/agents.ts';
import type { AskKind, AskStatus, Outcome } from '../src/schema.ts';
import type { LiveKind } from '../src/work/events.ts';
import { OUTCOME_TITLE } from '../src/work/runs.ts';
import type { WorkRows } from '../src/work/snapshot.ts';
import type { FollowUp } from '../src/work/state.ts';
import { minutes } from './work-rows.ts';

// The test's own record of the office, from the events alone.

type Park =
  | { on: 'none' }
  | { on: 'task'; task: number }
  | { on: 'time'; at: number }
  | { on: 'window'; at: number; ask: number };
export type RunRec = {
  id: number;
  staffId: string;
  kind: LiveKind;
  threadId: number | null;
  askId: number | null;
  taskId: number | null;
  handOff: { from: string; title: string; outcome?: Outcome; answered?: boolean } | null;
  reportWhenDone: boolean;
  is: 'queued' | 'running' | 'ended';
  outcome?: Outcome;
  /** The event the run ended at. */
  doneAt?: number;
  unparked: { task: number } | { at: number } | null;
  /** The results its claim joined. */
  joined: number[];
  lines: number;
  /** The chat card it replies under, as `ask:7` or `task:3`. */
  card: string | null;
};
type ThreadRec = {
  id: number;
  title: string;
  hub: string;
  holder: string;
  status: 'open' | 'done' | 'failed' | 'stopped';
  park: Park;
  leadsJobGoing: boolean;
  /** The hand-offs this round of the work has taken. */
  used: number;
};
export type AskRec = {
  id: number;
  staffId: string;
  kind: AskKind;
  title: string;
  odd: string | null;
  held: { from: string; to: string; title: string } | null;
  status: AskStatus;
  /** The event it was decided at. */
  decidedAt?: number;
  handOffId: number | null;
  threadId: number | null;
};
export type TaskRec = {
  id: number;
  staffId: string | null;
  title: string;
  status: 'open' | 'done' | 'dropped';
  /** Dropped because its Odd left, so its answer goes to nobody. */
  withdrawn?: boolean;
  askId: number | null;
  handOffId: number | null;
  threadId: number | null;
  connectors: string[];
};
/** The owner answered in the chat of `staffId`, on the card `card`. */
export type Chat = { staffId: string; card: string };
type Poke = { staffId: string; lead: string; title: string };
/** An answer for a lead: the run that should hold the marker, or nothing when the lead left. */
export type Delivery = {
  lead: string;
  threadId: number | null;
  kind: 'resume' | 'handed_back';
  marker: string;
  leadLeft: boolean;
};
/** Where an answer is heard: on no work, on work its Odd leads, or on another's. */
export type Heard = {
  staffId: string;
  place: 'none' | 'own' | 'other';
  threadId: number | null;
  askIds: number[];
  taskIds: number[];
  marker: string;
  /** A goal's yes, whose planning run is its own write in the transaction. */
  planning: boolean;
  runs: 0 | 1;
};
type Expected = {
  refused?:
    | 'not waiting'
    | 'held'
    | 'ended'
    | 'not running'
    | 'answer refused'
    | 'answered already'
    | 'not taken';
  /** The open item a raise or a gift found already there. */
  already?: number;
  /** The first id a run this event puts gets. */
  firstNew: number;
  reports: { staffId: string; title: string }[];
  pokes: Poke[];
  ceiling?: Level;
  joined?: number[];
  /** Runs this event ends, with the outcome each gets. */
  ended: { id: number; outcome: Outcome }[];
  handedBack: { staffId: string; from: string; outcome: Outcome; threadId: number | null }[];
  wake?: { runId: number; title: string; ownRunEarlier: boolean };
  /** The work's lead has left the office. */
  leadLeft?: boolean;
  /** A run of an Odd in the office, on work whose lead is here or on no work, failed and handed nothing back. */
  failureReport?: boolean;
  delivered: Delivery[];
  heard: Heard[];
  /** The event asks stopped work, or work whose lead left, to take something new. */
  onStoppedWork?: boolean;
  /** The clock woke this parked work, so its lead should hold one queued resume there. */
  clockWake?: { threadId: number; lead: string; leadLeft: boolean };
  /** A hand-off or tell_lead that goes: the files it carries, into which work (`new` for work this change opens). */
  passes?: { threadId: number | 'new'; from: string };
  /** What a hand-off that was not refused came to. */
  handOff?: 'taken' | 'asked' | 'held';
  /** An Odd let go now (`left`), or one gone already, which changes nothing. */
  leaving?: 'left' | 'gone';
  /** The Odd brought back now. */
  broughtBack?: string;
};
/** The test's own record of the office, and what it expects of the last event. */
export type Model = {
  at: number;
  owner: string;
  odds: Map<string, { name: string; level: Level; agent: Agent; left: boolean }>;
  threads: Map<number, ThreadRec>;
  runs: Map<number, RunRec>;
  asks: AskRec[];
  tasks: Map<number, TaskRec>;
  owedSent: Set<number>;
  /** How many asks of each kind each place raised, and tasks each giver gave. */
  raised: Map<string, number>;
  /** The Odds this sequence let go, and those it brought back. */
  letGo: Set<string>;
  broughtBack: Set<string>;
  expected: Expected;
};

export const fresh = (firstNew: number): Expected => ({
  firstNew,
  reports: [],
  pokes: [],
  ended: [],
  handedBack: [],
  delivered: [],
  heard: []
});

export const cardOf = (f: FollowUp) => (f.chatCard ? `${f.chatCard.kind}:${f.chatCard.id}` : null);
export const parkOf = (p: Park | { on: 'time' | 'window'; at: Date; ask?: number }): Park =>
  p.on === 'none' || p.on === 'task'
    ? p
    : p.on === 'time'
      ? { on: 'time', at: +p.at }
      : { on: 'window', at: +p.at, ask: p.ask! };

export function recordOf(rows: WorkRows): Model {
  const runs = new Map<number, RunRec>();
  for (const f of rows.followUps.values()) {
    const r = f.run;
    runs.set(f.id, {
      id: f.id,
      staffId: f.staffId,
      // The office holds no row of a retired kind.
      kind: f.kind as LiveKind,
      threadId: f.threadId,
      askId: f.askId,
      taskId: f.taskId,
      handOff: f.handOff,
      reportWhenDone: f.reportWhenDone,
      is: r.is,
      ...(r.is === 'ended' && { outcome: r.outcome, doneAt: 0 }),
      unparked:
        r.is !== 'running' || !r.unparked
          ? null
          : 'task' in r.unparked
            ? r.unparked
            : { at: r.unparked.at.getTime() },
      joined: [],
      lines: 0,
      card: cardOf(f)
    });
  }
  return {
    at: 0,
    owner: rows.owner,
    odds: new Map(
      [...rows.staff.values()].map((o) => [
        o.id,
        { name: o.name, level: o.level, agent: o.agent, left: !!o.leftAt }
      ])
    ),
    threads: new Map(
      [...rows.threads.values()].map((t) => [
        t.id,
        {
          id: t.id,
          title: t.title,
          hub: t.hubId,
          holder: t.holderId,
          status: t.status,
          park: t.status !== 'open' ? { on: 'none' } : parkOf(t.park),
          leadsJobGoing: t.runs.some((k) => rows.runsGoing.has(k)),
          used: t.handOffsUsed
        }
      ])
    ),
    runs,
    asks: [...rows.asks.values()].map((a) => ({
      id: a.id,
      staffId: a.staffId,
      kind: a.kind,
      title: a.title,
      odd: a.odd,
      held: a.held,
      status: a.status,
      ...(a.status !== 'open' && { decidedAt: 0 }),
      handOffId: a.handOffId,
      threadId: a.threadId
    })),
    tasks: new Map(
      [...rows.tasks.values()].map((k) => [
        k.id,
        {
          id: k.id,
          staffId: k.staffId,
          title: k.title,
          status: k.status,
          askId: k.askId,
          handOffId: k.handOffId,
          threadId: k.threadId,
          connectors: k.steps.flatMap((s) =>
            s.action && 'connector' in s.action ? [s.action.connector] : []
          )
        }
      ])
    ),
    owedSent: new Set(),
    raised: new Map(),
    letGo: new Set(),
    broughtBack: new Set(),
    expected: fresh(0)
  };
}

/** How often a sequence met the case each rule is about; a rule never met proves nothing. */
export const met = new Map<string, number>();
export const meet = (c: string) => met.set(c, (met.get(c) ?? 0) + 1);

/** The title the owner reads for a run that ended so. */
export const titleOf = (r: Model, kind: LiveKind, outcome: Outcome, about: string) =>
  `${OUTCOME_TITLE[kind][outcome].replace('{owner}', r.owner)}: ${about}`;

export const left = (r: Model, id: string) => !!r.odds.get(id)?.left;

/**
 * The plan's usage window as the loader reads it for a hand-off, new or held:
 * past the guard until it resets at minute `resetsAt`, with the office's ask 4.
 */
export const WINDOW = { share: 0.9, resetsAt: 10, ask: 4 } as const;
/** The guard past which hand-offs to an Odd on Claude Code wait, as the plan's rule says. */
const GUARD = 0.85;

/**
 * Whether a hand-off to `to` waits for the usage window now: to an Odd on
 * Claude Code, past the guard, before the reset, and with no yes to the
 * window's ask. A new hand-off and a held one the owner says yes to both ask.
 */
export function windowHolds(r: Model, to: string): boolean {
  return (
    r.odds.get(to)?.agent === 'claude' &&
    +minutes(WINDOW.resetsAt) > +minutes(r.at) &&
    WINDOW.share >= GUARD &&
    askOf(r, WINDOW.ask)?.status !== 'approved'
  );
}

/** Work the usage window holds: open, and parked until the reset under the window's ask. */
export function holdForWindow(t: ThreadRec): void {
  t.status = 'open';
  t.park = { on: 'window', at: +minutes(WINDOW.resetsAt), ask: WINDOW.ask };
}
export const askOf = (r: Model, id: number | null) =>
  id === null ? undefined : r.asks.find((a) => a.id === id);

/** Something raised on the thread is still open: an ask, or a task given on it or from an ask raised on it. */
function raisedOpen(r: Model, threadId: number): boolean {
  const raised = r.asks.filter((a) => a.threadId === threadId);
  return (
    raised.some((a) => a.status === 'open') ||
    [...r.tasks.values()].some(
      (k) =>
        k.status === 'open' && (k.threadId === threadId || raised.some((a) => a.id === k.askId))
    )
  );
}

/** Today's rule for where a thread stands, run on the threads an event touches, as today's code does. */
export function settle(r: Model, threadId: number | null): void {
  const t = threadId === null ? undefined : r.threads.get(threadId);
  if (t?.status !== 'open') return;
  const on = [...r.runs.values()].filter((f) => f.threadId === t.id);
  const pending = on.filter((f) => f.is !== 'ended').sort((a, b) => b.id - a.id)[0];
  const last = on
    .filter((f) => f.is === 'ended')
    .sort((a, b) => b.doneAt! - a.doneAt! || b.id - a.id)[0];
  t.holder = pending?.staffId ?? t.hub;
  if (pending || t.park.on !== 'none' || !last || raisedOpen(r, t.id)) return;
  if (last.outcome === 'waiting') {
    meet('a thread kept open only because its last run ended waiting');
    return;
  }
  meet('a thread ended');
  t.status = last.outcome!;
}

export function insert(r: Model, f: Omit<RunRec, 'id'>): number {
  const id = Math.max(...r.runs.keys()) + 1;
  r.runs.set(id, { ...f, id });
  settle(r, f.threadId);
  return id;
}

export const newRun = (f: Pick<RunRec, 'staffId' | 'kind' | 'threadId'> & Partial<RunRec>) => ({
  askId: null,
  taskId: null,
  handOff: null,
  reportWhenDone: false,
  is: 'queued' as const,
  unparked: null,
  joined: [],
  lines: 0,
  card: null,
  ...f
});

export const show = (v: unknown) => JSON.stringify(v);
