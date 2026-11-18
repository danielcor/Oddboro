// The rows a decision reads, and the change it makes, as data. A loader reads
// `WorkRows` under its locks; a decider returns a `Change`; `applyChange`
// gives the rows that change leaves in memory, which a decider reads between
// its own steps (`Draft`) and the tests read between events.
//
// Pure: the imports below that reach the database are types only.
import type { Level, OwnSwitch } from '../access-words.ts';
import type { Agent } from '../agents.ts';
import { fixedError } from '../errors.ts';
import type { CarriedFile } from '../hand-offs.ts';
import type { record } from '../office-ledger.ts';
import type { StaffRow } from '../office.ts';
import type { AskStatus, HandOff } from '../schema.ts';
import type { Tx } from '../threads.ts';
import type { Ask, FollowUp, Task, Thread } from './state.ts';

export type Odd = {
  id: string;
  name: string;
  leftAt: Date | null;
  level: Level;
  /** The owner lets it act on its own on work from colleagues (`staff.actsOnHandOffs`). */
  actsOnHandOffs: boolean;
  agent: Agent;
  manager: boolean;
};

/** Facts a decider needs that take I/O to learn, which the loader works out under the same locks as the rows. */
export type Prepared = {
  /**
   * A switch yes: the Odd's staff row as the loader read it, the asked
   * switches still off in it, and the answer line's network words, which read
   * the platform and the office's network hold.
   */
  switches?: { before: StaffRow; off: OwnSwitch[]; networkBody: string | undefined };
  /** The hand-off `handOn` starts, as `sharing()` gives it for the Odds on the thread. */
  sharing?: HandOff;
  /** A folder yes's answer line, which reads the file system to show the path. */
  folderTitle?: string;
  /**
   * A level or office tool yes, for an Odd still here: the Settings tab's
   * line for the change, empty when it changes nothing, and `also`, the
   * owner's choice for work from colleagues that a raise to Act stores
   * (`settingGranted`).
   */
  setting?: { title?: string; also?: string };
};

/** The loaded rows, as states. Named so, since the office's `Work` is a run's item. */
export type WorkRows = {
  staff: Map<string, Odd>;
  threads: Map<number, Thread>;
  followUps: Map<number, FollowUp>;
  asks: Map<number, Ask>;
  tasks: Map<number, Task>;
  window: {
    share: number;
    resetsAt: Date | null;
    ask: { id: number; status: AskStatus } | null;
  } | null;
  /** The keys of the runs going now, which only the office's memory holds. */
  runsGoing: ReadonlySet<string>;
  /** The owner's name, for answer lines and report titles. */
  owner: string;
  prepared: Prepared;
};

type Tables = { threads: Thread; followUps: FollowUp; asks: Ask; tasks: Task };
/** The id fields a new row may take from another new row in the same change. `heldBy` is a window park's ask. */
type Links = {
  threads: 'goalId' | 'heldBy';
  followUps: 'threadId' | 'askId' | 'taskId' | 'goalId';
  asks: 'threadId' | 'handOffId';
  tasks: 'threadId' | 'askId' | 'handOffId';
};
/** A row before it has an id. Distributes over a state union, which a plain `Omit` would flatten. */
export type Fresh<T> = T extends unknown ? Omit<T, 'id'> : never;

/**
 * A row: every column `base` holds, then each one `named` gives a value. A
 * column `named` leaves undefined keeps its value in `base`, as an insert
 * that leaves a column out gets its default, or an update leaves it as it was.
 */
export function filled<E extends object, N extends object>(base: E, named: N): E & N {
  const given = Object.entries(named).filter(([, v]) => v !== undefined);
  // `given` is `named` without its undefined columns, which `base` fills.
  return { ...base, ...Object.fromEntries(given) } as E & N;
}

/**
 * One row written whole: an existing row's new state, or a new row. A new
 * row has a `ref`, its name in this change. `points` names, per id field, the
 * `ref` of a new row or a `perKind` effect whose id that field takes, so rows
 * written together can point at each other before any has an id. An existing
 * row may point too, as work already open does at the window ask that holds it.
 */
export type Put = {
  [T in keyof Tables]:
    | { table: T; row: Tables[T]; points?: Partial<Record<Links[T], string>> }
    | {
        table: T;
        ref: string;
        insert: Fresh<Tables[T]>;
        points?: Partial<Record<Links[T], string>>;
      };
}[keyof Tables];

/** A row this change inserts, by its `ref`: the apply gives it its id. */
export type Inserted = { ref: string };

/** A line for the Ledger, as `record` takes it. */
export type LedgerLine = Parameters<typeof record>[0];

/**
 * An in-transaction write outside the four tables that an entry function
 * supplies, as setting a goal on its yes is. It may run more than once: a
 * transition Postgres ends to break a deadlock runs again from the load, so
 * `run` keeps nothing from an earlier run, such as rows it collected.
 */
export type PerKindInTx = {
  /** Names it in an error, and is the `ref` a put may point at. */
  name: string;
  run: (tx: Tx) => Promise<{ id: string | number } | void>;
};

/** A write inside the transaction outside the four tables, as named data. */
export type Outside =
  | { kind: 'report'; staffId: string; title: string; body: string }
  | { kind: 'poke'; staffId: string; message: string }
  | { kind: 'cancelPokes'; staffId: string }
  /** The Odd leaves at `at`, its jobs off, as a removal does. */
  | { kind: 'leave'; staffId: string; at: Date }
  | { kind: 'comeBack'; staffId: string }
  /** Into `from`'s part of the work, which may be a thread this change opens. */
  | { kind: 'carryFiles'; threadId: number | Inserted; from: string; files: CarriedFile[] }
  /** Only where the line is written inside the transaction today. */
  | { kind: 'record'; line: LedgerLine }
  /** The files an Odd attached, inserted with the new ask or task they point at (its put's `ref`). */
  | {
      kind: 'attachments';
      staffId: string;
      paths: string[];
      to: { ask: string } | { task: string };
    }
  | { kind: 'perKind'; effect: PerKindInTx };

export type Change<R = unknown> = {
  /** Applied in order: a later put of a row wins. */
  put: Put[];
  outside: Outside[];
  /** What the entry function returns to its caller. */
  result: R;
};

/**
 * The rows a change leaves, in memory. Each `perKind` effect gets a made-up
 * id, -1 for the first and -2 for the next, since none runs here, and no
 * made-up id can equal a real row's. A new row gets the next id after its
 * table's highest, as a serial column gives it.
 */
export function applyChange(rows: WorkRows, change: Change): WorkRows {
  const ids = madeUpIds(change.outside);
  const next = copy(rows);
  for (const o of change.outside) {
    const odd = 'staffId' in o ? next.staff.get(o.staffId) : undefined;
    if (o.kind === 'leave' && odd) next.staff.set(odd.id, { ...odd, leftAt: o.at });
    if (o.kind === 'comeBack' && odd) next.staff.set(odd.id, { ...odd, leftAt: null });
  }
  for (const p of change.put) putOne(next, p, ids);
  return next;
}

function madeUpIds(outside: readonly Outside[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const o of outside) if (o.kind === 'perKind') ids.set(o.effect.name, -(ids.size + 1));
  return ids;
}

function copy(rows: WorkRows): WorkRows {
  return {
    ...rows,
    staff: new Map(rows.staff),
    threads: new Map(rows.threads),
    followUps: new Map(rows.followUps),
    asks: new Map(rows.asks),
    tasks: new Map(rows.tasks)
  };
}

/** Writes one put into `rows`, which it owns, and keeps a new row's id under its `ref`. */
function putOne(rows: WorkRows, p: Put, ids: Map<string, number>): number {
  const map = rows[p.table] as Map<number, Tables[typeof p.table]>;
  if ('row' in p) {
    map.set(p.row.id, pointed({ ...p.row }, p.points, ids));
    return p.row.id;
  }
  if (ids.has(p.ref)) throw fixedError('Two rows in one change share a ref.');
  const id = Math.max(0, ...map.keys()) + 1;
  // A new row's state is its insert with the id it got and each id it points at.
  map.set(id, pointed({ ...p.insert, id } as Tables[typeof p.table], p.points, ids));
  ids.set(p.ref, id);
  return id;
}

/** `row`, which the caller owns, with each id field `points` names set to the id its ref got. */
function pointed<R extends Tables[keyof Tables]>(
  row: R,
  points: Partial<Record<string, string>> | undefined,
  ids: Map<string, number>
): R {
  for (const [field, ref] of Object.entries(points ?? {})) {
    const to = ref === undefined ? undefined : ids.get(ref);
    if (to === undefined)
      throw fixedError('A row in a change points at a ref no earlier put made.');
    pointAt(row, field, to);
  }
  return row;
}

/** Sets one id field a new row points with. A window park keeps its ask in the park, not a column. */
function pointAt(row: Tables[keyof Tables], field: string, id: number): void {
  if (field === 'heldBy') {
    if ('park' in row && row.park.on === 'window') row.park = { ...row.park, ask: id };
    return;
  }
  Reflect.set(row, field, id);
}

/**
 * A change being decided, step by step. Each step reads `rows`, the loaded
 * rows as the puts so far leave them, so a helper sees what the steps before
 * it wrote. A later put of a row this change inserts folds into that insert,
 * so the change writes each new row once. Its `perKind` effects are fixed
 * when the draft starts, so a put can point at one's ref from the first step;
 * `foldIn` adds other outside writes.
 */
export type Draft = {
  readonly loaded: WorkRows;
  rows: WorkRows;
  put: Put[];
  readonly outside: Outside[];
  readonly ids: Map<string, number>;
};

export function draft(rows: WorkRows, outside: Outside[] = []): Draft {
  return { loaded: rows, rows, put: [], outside, ids: madeUpIds(outside) };
}

export function putAll(d: Draft, puts: readonly Put[]): void {
  const rows = copy(d.rows);
  for (const p of puts) {
    const inserted = 'row' in p ? insertOf(d, p.table, p.row.id) : undefined;
    if (inserted && 'row' in p) {
      // Its points stay, with any this put adds; the row's own id fields hold the same ids they give.
      const { id: _, ...insert } = p.row;
      const points =
        inserted.put.points || p.points ? { ...inserted.put.points, ...p.points } : undefined;
      d.put[inserted.at] = { ...inserted.put, insert, ...(points && { points }) } as Put;
      putOne(rows, p, d.ids);
      continue;
    }
    const kept = 'row' in p ? pointsKept(d, p) : p;
    putOne(rows, kept, d.ids);
    d.put.push(kept);
  }
  d.rows = rows;
}

/**
 * `p` with the points the last put of the same loaded row made, each whose
 * field still holds the id its ref got: so a later step that writes the row
 * again, such as a settle, still points at the row this change inserts.
 */
function pointsKept(d: Draft, p: Extract<Put, { row: unknown }>): Put {
  const last = [...d.put]
    .reverse()
    .find((q) => 'row' in q && q.table === p.table && q.row.id === p.row.id);
  const kept = Object.entries(last?.points ?? {}).filter(
    ([field, ref]) =>
      ref !== undefined && !(p.points && field in p.points) && idAt(p.row, field) === d.ids.get(ref)
  );
  if (!kept.length) return p;
  // The same put, pointing as the one before it did.
  return { ...p, points: { ...Object.fromEntries(kept), ...p.points } } as Put;
}

/** The id one field of a row holds, as `pointAt` sets it. */
function idAt(row: Tables[keyof Tables], field: string): unknown {
  if (field === 'heldBy')
    return 'park' in row && row.park.on === 'window' ? row.park.ask : undefined;
  return Reflect.get(row, field);
}

/** The insert in this draft that gave row `id` of `table` its id, if one did. */
function insertOf(
  d: Draft,
  table: keyof Tables,
  id: number
): { at: number; put: Extract<Put, { ref: string }> } | undefined {
  if (d.loaded[table].has(id)) return undefined;
  const at = d.put.findIndex((q) => 'ref' in q && q.table === table && d.ids.get(q.ref) === id);
  return at < 0 ? undefined : { at, put: d.put[at] as Extract<Put, { ref: string }> };
}

/**
 * The `ref` of the row this draft inserted into `table` as `id`, if it did.
 * A row that takes that id points at the ref: `id` is only the draft's
 * guess, and the database gives the row its own.
 */
export const insertedRef = (d: Draft, table: keyof Tables, id: number): string | undefined =>
  insertOf(d, table, id)?.put.ref;

/**
 * Puts the change another decider made of `d.rows` into `d`, so one event
 * makes several decisions in order, each by its own family's decider. Each
 * ref the change names becomes `<tag> <ref>`, so two folded changes never
 * share one. A `perKind` effect cannot fold in: the ids made up for them are
 * fixed when the draft starts.
 */
export function foldIn(d: Draft, change: Change, tag: string): void {
  const named = new Set(change.put.flatMap((p) => ('ref' in p ? [p.ref] : [])));
  const renamed = (ref: string) => (named.has(ref) ? `${tag} ${ref}` : ref);
  for (const o of change.outside) {
    if (o.kind === 'perKind')
      throw fixedError('A change with writes of its own cannot fold into another.');
    d.outside.push(
      o.kind === 'attachments'
        ? { ...o, to: 'ask' in o.to ? { ask: renamed(o.to.ask) } : { task: renamed(o.to.task) } }
        : o.kind === 'carryFiles' && typeof o.threadId === 'object'
          ? { ...o, threadId: { ref: renamed(o.threadId.ref) } }
          : o
    );
  }
  putAll(
    d,
    change.put.map((p): Put => {
      const points = p.points
        ? Object.fromEntries(Object.entries(p.points).map(([field, ref]) => [field, renamed(ref)]))
        : undefined;
      // The same put under its new names: only `ref` and `points` change.
      return { ...p, ...('ref' in p && { ref: renamed(p.ref) }), ...(points && { points }) } as Put;
    })
  );
}

/** The finished change. */
export function changeOf<R>(d: Draft, result: R): Change<R> {
  return { put: d.put, outside: d.outside, result };
}
