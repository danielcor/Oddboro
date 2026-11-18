// An event through the shell, and writing its decided change: the one place
// the work core writes the office's rows. A thread, run, ask or task is
// written whole through its serializer in state.ts, so no write leaves a
// stale column behind, and a row's id fields that name a new row, or an
// effect's id, are filled in by ref. The decider's own guess at a new row's
// id never reaches the database: another transaction may have taken that id
// first.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { fixedError } from '../errors.ts';
import { carryFiles } from '../hand-offs.ts';
import { record } from '../office-ledger.ts';
import { mediaTypeOf } from '../office-tasks.ts';
import {
  asks,
  attachments,
  followUps,
  jobs,
  pokes,
  reports,
  staff,
  tasks,
  threads
} from '../schema.ts';
import type { Tx } from '../threads.ts';
import { nextRun } from '../time.ts';
import { transition, type Decided } from '../transition.ts';
import { decide } from './decide.ts';
import type { EventOf, LiveKind, WorkEvent, WorkResults } from './events.ts';
import { loadWork } from './load.ts';
import type { Change, Inserted, Outside, Put } from './snapshot.ts';
import {
  askRow,
  followUpRow,
  RETIRED_KINDS,
  taskRow,
  threadRow,
  type FollowUp,
  type RetiredKind
} from './state.ts';

/**
 * One work event through the shell: its rows loaded and locked, its decider,
 * and the change written, in one transaction. With the caller's own `tx` the
 * caller owns the commit, and runs the after-effects once it commits, as
 * `transition` says. Every entry function that hands an event to the core
 * goes through here. A change that went through comes with `real`, the ids
 * of the rows it wrote, which the entry gives its caller in place of the
 * refs in the change's result.
 */
export async function transitionWork<K extends WorkEvent['kind']>(
  e: EventOf<K>,
  o: { tx?: Tx; now?: Date } = {}
): Promise<{ refused: string } | (Changed<WorkResults[K]> & { real: RealId })> {
  let real: RealId | undefined;
  const decided = await transition(
    {
      name: e.kind,
      load: (tx) => loadWork(tx, e),
      decide: (rows, now) => decide(rows, e, now),
      apply: async (tx, change) => {
        real = await applyWork(tx, change);
      }
    },
    o
  );
  if (!('change' in decided)) return decided;
  if (!real) throw fixedError('A change went through that was never written.');
  return { ...decided, real };
}

/** A decided change, with what follows it. */
type Changed<R> = Extract<Decided<Change<R>>, { change: unknown }>;

/** The id each `ref` in a change stands for: a new row's, or the one a `perKind` effect returned. */
type Ids = Map<string, number | string>;

/** The real id of a row a change names: one it inserted, by its ref, or one already there. */
type RealId = (row: number | Inserted) => number;

/**
 * Write a change inside the transition's transaction. The `perKind` effects
 * run first, in order, since a put may point at the id one returns; then the
 * puts, in order; then the other writes outside the four tables, in order,
 * since attachments point at a new ask or task. Any throw rolls all of it
 * back, a hand-off's files that cannot be carried included. Gives the real
 * ids of the rows the change names, which an entry gives its caller in place
 * of the refs in the change's result.
 */
export async function applyWork(tx: Tx, change: Change): Promise<RealId> {
  const ids: Ids = new Map();
  for (const o of change.outside) {
    if (o.kind !== 'perKind') continue;
    // An effect gets the transaction only. Anything else it needs, such as
    // the ask it answers, it closes over where its entry function made it.
    const made = await o.effect.run(tx);
    if (made) keep(ids, o.effect.name, made.id);
  }
  for (const p of change.put) await put(tx, p, ids);
  const real: RealId = (row) => (typeof row === 'number' ? row : idOf(ids, row.ref));
  for (const o of change.outside) await outside(tx, o, real);
  return real;
}

function keep(ids: Ids, ref: string, id: number | string): void {
  if (ids.has(ref)) throw fixedError('Two rows in one change share a ref.');
  ids.set(ref, id);
}

function idOf(ids: Ids, ref: string): number {
  const id = ids.get(ref);
  if (id === undefined) throw fixedError('A row in a change points at a ref no earlier put made.');
  if (typeof id !== 'number')
    throw fixedError('A row in a change points at an id that is not a row.');
  return id;
}

async function put(tx: Tx, p: Put, ids: Ids): Promise<void> {
  switch (p.table) {
    case 'threads': {
      if ('row' in p)
        return updated(
          await tx
            .update(threads)
            .set(pointed(columns(threadRow(p.row)), p.points, ids))
            .where(eq(threads.id, p.row.id))
            .returning({ id: threads.id })
        );
      const values = pointed(columns(threadRow({ ...p.insert, id: 0 })), p.points, ids);
      const [row] = await tx.insert(threads).values(values).returning({ id: threads.id });
      return keep(ids, p.ref, row.id);
    }
    case 'followUps': {
      if ('row' in p)
        return updated(
          await tx
            .update(followUps)
            .set(pointed(liveColumns(p.row), p.points, ids))
            .where(eq(followUps.id, p.row.id))
            .returning({ id: followUps.id })
        );
      const values = pointed(liveColumns({ ...p.insert, id: 0 }), p.points, ids);
      const [row] = await tx.insert(followUps).values(values).returning({ id: followUps.id });
      return keep(ids, p.ref, row.id);
    }
    case 'asks': {
      if ('row' in p)
        return updated(
          await tx
            .update(asks)
            .set(pointed(columns(askRow(p.row)), p.points, ids))
            .where(eq(asks.id, p.row.id))
            .returning({ id: asks.id })
        );
      const values = pointed(columns(askRow({ ...p.insert, id: 0 })), p.points, ids);
      const [row] = await tx.insert(asks).values(values).returning({ id: asks.id });
      return keep(ids, p.ref, row.id);
    }
    case 'tasks': {
      if ('row' in p)
        return updated(
          await tx
            .update(tasks)
            .set(pointed(columns(taskRow(p.row)), p.points, ids))
            .where(eq(tasks.id, p.row.id))
            .returning({ id: tasks.id })
        );
      const values = pointed(columns(taskRow({ ...p.insert, id: 0 })), p.points, ids);
      const [row] = await tx.insert(tasks).values(values).returning({ id: tasks.id });
      return keep(ids, p.ref, row.id);
    }
    default:
      return unknownMember(p);
  }
}

/**
 * Every column but the id, which an update never changes and an insert
 * leaves to the database. A new row is serialized with a stand-in id of 0,
 * dropped here, since a serializer takes a whole state.
 */
function columns<R extends { id: number }>(row: R): Omit<R, 'id'> {
  const { id: _, ...rest } = row;
  return rest;
}

/**
 * A run's columns. Nothing writes a run of a retired kind: such a row parses
 * as ended, and no decider changes an ended run, so one here is a bug.
 */
function liveColumns(f: FollowUp): Omit<ReturnType<typeof followUpRow>, 'id' | 'kind'> & {
  kind: LiveKind;
} {
  const { kind, ...rest } = columns(followUpRow(f));
  if (isRetired(kind))
    throw fixedError('A change wrote a run of a kind the office no longer starts.');
  return { ...rest, kind };
}

/** A run's kind the office no longer starts: a row of one has always ended. */
const isRetired = (kind: FollowUp['kind']): kind is RetiredKind =>
  RETIRED_KINDS.some((r) => r === kind);

/** A row's id fields set from the refs `points` names. Each field is a column. */
function pointed<R extends object>(
  values: R,
  points: Partial<Record<string, string>> | undefined,
  ids: Ids
): R {
  const out = { ...values };
  for (const [field, ref] of Object.entries(points ?? {}))
    if (ref !== undefined) Reflect.set(out, field, idOf(ids, ref));
  return out;
}

/** An existing row's write found its row: the loader locked it, so a miss is a bug, and rolls back. */
function updated(rows: unknown[]): void {
  if (rows.length !== 1) throw fixedError('A change wrote a row that is not there.');
}

async function outside(tx: Tx, o: Outside, real: RealId): Promise<void> {
  switch (o.kind) {
    case 'perKind':
      // Run before the puts, in `applyWork`.
      return;
    case 'report':
      await tx.insert(reports).values({ staffId: o.staffId, title: o.title, body: o.body });
      return;
    case 'poke':
      // Sent now, as `poke_owner` would send it: the change carries no time.
      await tx.insert(pokes).values({ staffId: o.staffId, at: new Date(), message: o.message });
      return;
    case 'cancelPokes':
      await tx
        .update(pokes)
        .set({ status: 'cancelled' })
        .where(and(eq(pokes.staffId, o.staffId), eq(pokes.status, 'waiting')));
      return;
    case 'leave': {
      // Its jobs on turn off and are kept, so a bring-back turns the same ones on.
      const off = await tx
        .update(jobs)
        .set({ enabled: false, nextRunAt: null })
        .where(and(eq(jobs.staffId, o.staffId), eq(jobs.enabled, true)))
        .returning({ id: jobs.id });
      return updated(
        await tx
          .update(staff)
          .set({ leftAt: o.at, jobsOff: off.map((j) => j.id) })
          .where(and(eq(staff.id, o.staffId), isNull(staff.leftAt)))
          .returning({ id: staff.id })
      );
    }
    case 'comeBack': {
      const [was] = await tx
        .select({ jobsOff: staff.jobsOff })
        .from(staff)
        .where(eq(staff.id, o.staffId));
      if (!was) throw fixedError('A change brought back an Odd that is not there.');
      await tx.update(staff).set({ leftAt: null, jobsOff: null }).where(eq(staff.id, o.staffId));
      const off = was.jobsOff?.length
        ? await tx
            .select()
            .from(jobs)
            .where(and(eq(jobs.staffId, o.staffId), inArray(jobs.id, was.jobsOff)))
        : [];
      // Each from now, as the jobs' first run after the Odd came back.
      const now = new Date();
      for (const j of off)
        await tx
          .update(jobs)
          .set({ enabled: true, nextRunAt: nextRun(j.schedule, now) })
          .where(eq(jobs.id, j.id));
      return;
    }
    case 'carryFiles':
      // Inside the transaction, so a copy refused or failing rolls the change
      // back, and its error, the refusal's words, reaches the entry.
      carryFiles(real(o.threadId), o.from, o.files);
      return;
    case 'record':
      await record(o.line, tx);
      return;
    case 'attachments': {
      const to =
        'ask' in o.to ? { askId: real({ ref: o.to.ask }) } : { taskId: real({ ref: o.to.task }) };
      if (o.paths.length)
        await tx.insert(attachments).values(
          o.paths.map((path) => ({
            staffId: o.staffId,
            path,
            mediaType: mediaTypeOf(path),
            ...to
          }))
        );
      return;
    }
    default:
      return unknownMember(o);
  }
}

/** Reached only when a cast lied about a change: it throws rather than write a guess. */
function unknownMember(member: never): never {
  throw fixedError('A change member outside its type reached applyWork.');
}
