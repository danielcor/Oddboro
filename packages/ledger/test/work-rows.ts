// Rows in memory for the work core's pure tests (work-decide.test.ts,
// work-decide-threads.test.ts and work-sequences.test.ts), and what those
// tests read off a change. Each builder fills every column, so a test names
// only what it is about. Imports types and pure modules only: no database.
import assert from 'node:assert/strict';
import type { Decision } from '../src/office-asks.ts';
import type { AskEffects, EventOf, LiveKind } from '../src/work/events.ts';
import type { Change, Odd, WorkRows } from '../src/work/snapshot.ts';
import type { Ask, FollowUp, RunState, Task, Thread } from '../src/work/state.ts';

/** The time the rows were made; each event in a test comes later. */
export const T0 = new Date('2026-11-01T09:00:00Z');
export const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

export const odd = (id: string, over: Partial<Odd> = {}): Odd => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  leftAt: null,
  level: 'act',
  actsOnHandOffs: false,
  agent: 'claude',
  manager: false,
  ...over
});

/** An open thread with no park; `over` may end it or park it. */
export const thread = (id: number, hubId: string, over: Partial<Thread> = {}): Thread =>
  ({
    id,
    title: `Work ${id}`,
    goalId: null,
    hubId,
    holderId: hubId,
    handOffsUsed: 0,
    runs: [],
    createdAt: T0,
    status: 'open',
    park: { on: 'none' },
    ...over
  }) as Thread;

export const run = (
  id: number,
  staffId: string,
  kind: LiveKind,
  state: RunState,
  over: Partial<Omit<FollowUp, 'id' | 'staffId' | 'kind' | 'run'>> = {}
): FollowUp => ({
  id,
  staffId,
  kind,
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
  createdAt: T0,
  ...over,
  run: state
});

export const ask = (id: number, staffId: string, over: Partial<Ask> = {}): Ask =>
  ({
    id,
    staffId,
    kind: 'approval',
    title: `Ask ${id}`,
    why: 'It is needed',
    ifApproved: 'I do it',
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
    odd: null,
    standing: null,
    revises: null,
    handOffId: null,
    threadId: null,
    held: null,
    via: null,
    reason: null,
    createdAt: T0,
    status: 'open',
    ...over
  }) as Ask;

export const task = (id: number, staffId: string | null, over: Partial<Task> = {}): Task =>
  ({
    id,
    staffId,
    askId: null,
    handOffId: null,
    threadId: null,
    via: null,
    ownerSaid: null,
    title: `Task ${id}`,
    why: 'It is needed',
    steps: [],
    response: null,
    responseVersion: 0,
    note: null,
    createdAt: T0,
    status: 'open',
    ...over
  }) as Task;

/** The loaded rows, keyed by id, as a loader gives them. */
export function rowsOf(o: {
  staff: Odd[];
  threads?: Thread[];
  followUps?: FollowUp[];
  asks?: Ask[];
  tasks?: Task[];
  runsGoing?: string[];
}): WorkRows {
  return {
    staff: new Map(o.staff.map((s) => [s.id, s])),
    threads: new Map((o.threads ?? []).map((t) => [t.id, t])),
    followUps: new Map((o.followUps ?? []).map((f) => [f.id, f])),
    asks: new Map((o.asks ?? []).map((a) => [a.id, a])),
    tasks: new Map((o.tasks ?? []).map((k) => [k.id, k])),
    window: null,
    runsGoing: new Set(o.runsGoing),
    owner: 'Sam',
    prepared: {}
  };
}

/** One call an answer's after-commit I/O made: which effect, and what it was given. */
export type EffectCall = { name: keyof AskEffects; args: unknown[] };

/**
 * Fakes for an answer's after-commit I/O that record each call, in order.
 * `granted` is what the grant's fake returns: whether it made a connect task,
 * and the connector it named.
 */
export function recordingEffects(granted = { task: true, connector: 'gmail' }): {
  effects: AskEffects;
  calls: EffectCall[];
} {
  const calls: EffectCall[] = [];
  const effects: AskEffects = {
    grantAccess: async (...args) => {
      calls.push({ name: 'grantAccess', args });
      return granted;
    },
    pointAsksAtConnector: async (...args) => {
      calls.push({ name: 'pointAsksAtConnector', args });
    },
    carryOutTogether: async (...args) => {
      calls.push({ name: 'carryOutTogether', args });
    },
    oweCatchUp: async (...args) => {
      calls.push({ name: 'oweCatchUp', args });
    },
    removeOdd: async (...args) => {
      calls.push({ name: 'removeOdd', args });
      return undefined;
    },
    bringBack: async (...args) => {
      calls.push({ name: 'bringBack', args });
      return undefined;
    }
  };
  return { effects, calls };
}

/** A change the decider made, failing the test on a refusal. */
export function changed<R>(d: { refused: string } | { change: Change<R> }): Change<R> {
  if ('refused' in d) assert.fail(`refused: ${d.refused}`);
  return d.change;
}

export const pokesOf = (c: Change) => c.outside.flatMap((o) => (o.kind === 'poke' ? [o] : []));
export const reportsOf = (c: Change) => c.outside.flatMap((o) => (o.kind === 'report' ? [o] : []));

/** The owner's answer to ask `id`, with nothing the entry adds and fakes that record each call. */
export const answer = (
  id: number,
  decision: Decision,
  over: Partial<EventOf<'askDecided'>> = {}
): EventOf<'askDecided'> => ({
  kind: 'askDecided',
  id,
  decision,
  reason: null,
  inChat: false,
  perKind: [],
  effects: recordingEffects().effects,
  ...over
});
