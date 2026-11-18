// The rows a work decider reads, loaded and locked inside its transaction.
// An event names the rows it starts from; the loader adds every row its
// decider can reach from them, takes the locks in `LOCK_ORDER`, and reads
// the rows again under those locks, so the decider judges what it holds.
import { and, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { fixedError } from '../errors.ts';
import { manager } from '../goals.ts';
import type { StaffRow } from '../office.ts';
import { gaveFolder, switchesOff } from '../office-folders.ts';
import { networkNote, settingGranted } from '../office-staff.ts';
import { ownerName, PLAN_ROW, windowBegan } from '../office-usage.ts';
import { runsGoing } from '../run-registry.ts';
import { asks, followUps, planLimits, staff, tasks, threads, type HandOff } from '../schema.ts';
import { sharing } from '../sharing.ts';
import type { Tx } from '../threads.ts';
import { lockRows } from '../transition.ts';
import { effectsOf } from './answers.ts';
import type { EventOf, WorkEvent } from './events.ts';
import type { Odd, Prepared, WorkRows } from './snapshot.ts';
import {
  parseAsk,
  parseFollowUp,
  parseTask,
  parseThread,
  RETIRED_KINDS,
  type Ask
} from './state.ts';
import { connects } from './tasks.ts';
import { TWINNED } from './twins.ts';

/**
 * The one SQL test for a follow-up waiting to start. A row with an outcome
 * has ended even with no start time, as when its Odd left before starting it,
 * and a retired kind never starts.
 */
export const queuedRows: SQL = and(
  isNull(followUps.startedAt),
  isNull(followUps.outcome),
  // The column's type lists the live kinds only, so the test reads it as plain SQL.
  notInArray(sql`${followUps.kind}`, [...RETIRED_KINDS])
) as SQL; // `and` is undefined only when given no conditions.

/**
 * The rows an event starts from, by table. The decider reads each one and
 * the work each ask, task and run is on. It reads the rows in `only` alone,
 * not the work they are on. It may write rows of the tables in `update`,
 * which are locked for update instead of share. `ends` are the tasks it may
 * end, whose parked work it wakes. `window` is the usage window as read under
 * the plan's lock, with the id of its ask, and `everyOdd` reads every Odd's
 * name, past the Odds locked.
 */
type Seeds = {
  followUps?: number[];
  threads?: number[];
  asks?: number[];
  tasks?: number[];
  staff?: string[];
  only?: { asks?: number[]; tasks?: number[]; followUps?: number[] };
  update?: ('staff' | 'asks' | 'tasks')[];
  ends?: number[];
  window?: { share: number; resetsAt: Date | null; ask: number | undefined };
  everyOdd?: true;
};

const one = <T>(id: T | null | undefined): T[] => (id == null ? [] : [id]);

/**
 * A kind of event added to `WorkEvent` fails the type check here until it
 * names its rows. Each reads what it needs to name them before any lock but
 * the plan's, which comes first in `LOCK_ORDER`. Only a hand-off, new or a
 * held one's yes, holds work for the usage window, and it does so under that
 * lock. So a seed that reads the window or what it holds takes the lock
 * first, and its read sees every hold: a hand-off, a held one's yes, and the
 * window ask's yes, which frees the work it holds. A leaving locks its Odd's
 * row before its reads, for the same reason (`oddRemoved`).
 */
const SEEDS: {
  [K in WorkEvent['kind']]: (tx: Tx, e: EventOf<K>) => Seeds | Promise<Seeds>;
} = {
  runQueued: (_, { run }) => ({
    staff: [run.staffId],
    threads: one(run.threadId),
    asks: one(run.askId),
    tasks: one(run.taskId)
  }),
  runClaimed: (_, e) => ({ followUps: [e.id] }),
  runFinished: (_, e) => ({ followUps: [e.id, ...e.ended.joined] }),
  staleRunsClosed: (_, e) => ({ followUps: [e.id] }),
  askRaised: async (tx, { ask }) => ({
    staff: [ask.staffId],
    threads: one(ask.threadId),
    only: {
      asks: [
        ...one(ask.revises),
        // The Odd's open calls, which a repeat of one finds.
        ...(ask.kind === 'call'
          ? await idsOf(
              tx,
              asks,
              and(eq(asks.staffId, ask.staffId), eq(asks.kind, 'call'), eq(asks.status, 'open'))
            )
          : [])
      ]
    },
    update: ['asks']
  }),
  askDecided: async (tx, e) => {
    const [a] = await tx.select().from(asks).where(eq(asks.id, e.id));
    if (!a) return {};
    const yes = e.decision === 'approve';
    // A yes that starts a held hand-off asks the usage window first, as a new hand-off does.
    const startsHeld = effectsOf(a.kind, e.decision).includes('start_held');
    // The window ask's yes frees the work it holds, read below.
    const freesHeld = yes && a.kind === 'window';
    if (startsHeld || freesHeld) await lockRows(tx, 'plan_limits', [PLAN_ROW], 'update');
    const window = startsHeld ? await windowNow(tx) : undefined;
    // The Odd's open asks of a twinned kind, which a yes or a no answers too.
    const twins =
      TWINNED.includes(a.kind) && e.decision !== 'iterate'
        ? await idsOf(
            tx,
            asks,
            and(eq(asks.staffId, a.staffId), eq(asks.kind, a.kind), eq(asks.status, 'open'))
          )
        : [];
    const held = freesHeld
      ? await tx.select({ id: threads.id }).from(threads).where(eq(threads.heldBy, a.id))
      : [];
    return {
      asks: [a.id, ...twins],
      threads: held.map((t) => t.id),
      // The Odd hears the answer unless it left, and a held hand-off names its
      // colleague. A goal's yes is planned by the manager, whom no row names.
      staff: [
        a.staffId,
        ...one(a.held?.to),
        ...(yes && a.kind === 'goal' ? one((await manager(tx))?.id) : [])
      ],
      // A switch or folder yes changes the Odd's own row with the claim.
      update: yes && (a.kind === 'switch' || a.kind === 'folder') ? ['staff', 'asks'] : ['asks'],
      only: {
        // The window's ask, when the answer asks the window.
        asks: startsHeld ? one(window?.ask) : [],
        // The answer on no work joins this run, if one waits.
        followUps: await waitingAnswer(tx, a.staffId)
      },
      // The window, and every Odd, which a new window ask names, as for a hand-off.
      ...(startsHeld && { window, everyOdd: true as const })
    };
  },
  taskGiven: async (tx, { task, oneOpen }) => {
    // Each tool the task connects, and the one an open task may answer it for,
    // sorted so two gives take them in one order.
    const tools = task.steps.flatMap((s) =>
      s.action && 'connector' in s.action ? [s.action.connector] : []
    );
    for (const c of new Set([...(oneOpen ? [oneOpen.connector] : []), ...tools].sort()))
      await lockConnector(tx, c);
    return {
      staff: one(task.staffId),
      threads: one(task.threadId),
      // The open tasks, the Odd's own when it has one, an open connect task among them answering this one.
      only: { tasks: oneOpen ? await openTaskIds(tx, task.staffId ?? undefined) : [] }
    };
  },
  taskEnded: async (tx, e) => {
    const [t] = await tx.select().from(tasks).where(eq(tasks.id, e.id));
    if (!t) return {};
    const [from] = t.askId === null ? [] : await tx.select().from(asks).where(eq(asks.id, t.askId));
    return {
      tasks: [t.id],
      asks: from ? await settledTogether(tx, from) : [],
      staff: one(t.staffId),
      // A drop's answer on no work joins this run of the Odd that gave it, if one waits.
      only: { followUps: t.staffId ? await waitingAnswer(tx, t.staffId) : [] },
      update: ['tasks'],
      ends: [t.id]
    };
  },
  connectTasksDropped: async (tx, e) => {
    await lockConnector(tx, e.connector);
    // Only the tool's own tasks, so a park on any other open task cannot fail the drop.
    const open = await tx
      .select({ id: tasks.id, steps: tasks.steps })
      .from(tasks)
      .where(openTasksOf(e.staffId));
    const stale = open.filter((t) => connects(t, e.connector)).map((t) => t.id);
    return { only: { tasks: stale }, update: ['tasks'], ends: stale };
  },
  goalStatusChanged: () => ({}),
  handedOff: async (tx, e) => {
    await lockRows(tx, 'plan_limits', [PLAN_ROW], 'update');
    const window = await windowNow(tx);
    return {
      threads: 'id' in e.thread ? [e.thread.id] : [],
      staff: [e.from, e.to],
      // This window's ask, which a hold points at, unless the owner let hand-offs run.
      only: { asks: one(window?.ask) },
      window,
      // A new window ask names the Odds on the plan, and goes under the manager.
      everyOdd: true
    };
  },
  toldLead: (_, e) => ({ threads: [e.threadId], staff: [e.staffId] }),
  parked: (_, e) => ({ threads: [e.threadId], tasks: 'task' in e.on ? [e.on.task] : [] }),
  clockWoke: (_, { threadId }) => ({ threads: [threadId] }),
  oddRemoved: async (tx, { staffId }) => {
    // Its row first, before the reads below. A raise, a task or a run for it
    // takes that row for share, so none commits between these reads and the
    // leaving and stays open for an Odd that left. It is the only Odd the
    // leaving writes, so every other Odd it reaches is locked for share.
    await lockRows(tx, 'staff', [staffId], 'update');
    // Its own asks, and any other ask about it.
    const open = await tx
      .select({ id: asks.id })
      .from(asks)
      .where(and(eq(asks.status, 'open'), or(eq(asks.staffId, staffId), eq(asks.odd, staffId))));
    const given = await openTaskIds(tx, staffId);
    return {
      // A withdrawal's line goes to each thread's lead, whose row comes with its
      // thread. A withdrawal is a no, which never starts a held hand-off, so its
      // colleague is not read.
      staff: [staffId],
      threads: await idsOf(
        tx,
        threads,
        and(eq(threads.hubId, staffId), ne(threads.status, 'stopped'))
      ),
      asks: open.map((a) => a.id),
      tasks: given,
      followUps: await idsOf(tx, followUps, and(eq(followUps.staffId, staffId), queuedRows)),
      update: ['asks', 'tasks'],
      ends: given
    };
  },
  oddBroughtBack: async (tx, { staffId }) => ({
    // Each other open ask to bring it back is withdrawn. A withdrawal's line
    // goes only to the ask's thread lead or hand-off, whose rows come with the
    // ask, so the Odd that raised it is not read.
    staff: [staffId],
    asks: await idsOf(
      tx,
      asks,
      and(eq(asks.status, 'open'), eq(asks.odd, staffId), eq(asks.kind, 'bring_back'))
    ),
    update: ['staff', 'asks']
  })
};

/**
 * The usage window as the last run reported it, and this window's ask, the
 * last one raised since the window began. Read under the plan's lock.
 */
async function windowNow(tx: Tx): Promise<Seeds['window']> {
  const [w] = await tx.select().from(planLimits).where(eq(planLimits.id, PLAN_ROW));
  if (!w) return undefined;
  const resets = w.fiveHourResetsAt;
  const [asked] = resets
    ? await tx
        .select({ id: asks.id })
        .from(asks)
        .where(and(eq(asks.kind, 'window'), gt(asks.createdAt, windowBegan(resets))))
        .orderBy(desc(asks.id))
        .limit(1)
    : [];
  return { share: w.fiveHour, resetsAt: resets, ask: asked?.id };
}

/**
 * Load and lock what the event's decider reads. Each thread the event can
 * touch comes with everything on it: its runs, and what was raised on it,
 * since a thread's status is worked out from all of them.
 */
export async function loadWork(tx: Tx, e: WorkEvent): Promise<WorkRows> {
  // TypeScript cannot tie the entry it looks up to this event's own kind, but
  // `SEEDS` pairs each kind with its own, so the one found by `e.kind` takes `e`.
  const seeds = await (SEEDS[e.kind] as (tx: Tx, e: WorkEvent) => Seeds | Promise<Seeds>)(tx, e);
  const reach = await reachOf(tx, seeds);
  const mode = (table: 'staff' | 'asks' | 'tasks') =>
    seeds.update?.includes(table) ? 'update' : 'share';

  await lockRows(tx, 'staff', [...reach.staff], mode('staff'));
  await lockRows(tx, 'threads', [...reach.threads], 'update');
  const threadIds = [...reach.threads];
  const threadRows = await tx.select().from(threads).where(inArray(threads.id, threadIds));

  const askIds = await idsOf(
    tx,
    asks,
    or(
      inArray(asks.id, [...reach.asks, ...(seeds.only?.asks ?? [])]),
      inArray(asks.threadId, threadIds),
      inArray(asks.handOffId, [...reach.handOffs])
    )
  );
  await lockRows(tx, 'asks', askIds, mode('asks'));

  const parkedOn = threadRows.flatMap((t) => one(t.resumeOnTask));
  const taskIds = await idsOf(
    tx,
    tasks,
    or(
      inArray(tasks.id, [...reach.tasks, ...(seeds.only?.tasks ?? []), ...parkedOn]),
      inArray(tasks.threadId, threadIds),
      inArray(tasks.askId, askIds),
      inArray(tasks.handOffId, [...reach.handOffs])
    )
  );
  await lockRows(tx, 'tasks', taskIds, mode('tasks'));
  // A park locks its task first (`parkOnTask`), so none comes once the task
  // is locked; one that came since the threads were locked is not in them.
  const late = (await parkedIds(tx, seeds.ends ?? [])).filter((id) => !reach.threads.has(id));
  if (late.length)
    throw fixedError('Work was parked on the task as it ended. Try again in a moment.');

  const followUpIds = await idsOf(
    tx,
    followUps,
    or(
      inArray(followUps.id, [
        ...(seeds.followUps ?? []),
        ...(seeds.only?.followUps ?? []),
        ...reach.handOffs
      ]),
      inArray(followUps.threadId, threadIds)
    )
  );
  await lockRows(tx, 'follow_ups', followUpIds, 'update');

  const rows = {
    threads: threadRows.map(parseThread),
    asks: (await tx.select().from(asks).where(inArray(asks.id, askIds))).map(parseAsk),
    tasks: (await tx.select().from(tasks).where(inArray(tasks.id, taskIds))).map(parseTask),
    followUps: (await tx.select().from(followUps).where(inArray(followUps.id, followUpIds))).map(
      parseFollowUp
    )
  };
  // Every Odd the rows name, for names and whether it left. Only those known
  // before the threads were locked are locked: one first seen on a thread's
  // rows is read for its name, and `LOCK_ORDER` puts staff before threads.
  const named = new Set([
    ...reach.staff,
    ...rows.threads.map((t) => t.hubId),
    ...rows.followUps.flatMap((f) => [f.staffId, ...(f.handOff ? [f.handOff.from] : [])])
  ]);
  const odds = await tx
    .select()
    .from(staff)
    .where(seeds.everyOdd ? undefined : inArray(staff.id, [...named]));
  // The office's one manager, though another Odd may hold the role too.
  const boss = (await manager(tx))?.id;
  const asked = e.kind === 'askDecided' ? rows.asks.find((a) => a.id === e.id) : undefined;
  const windowAsk = rows.asks.find((a) => a.id === seeds.window?.ask);

  return {
    staff: new Map(odds.map((s): [string, Odd] => [s.id, oddOf(s, boss)])),
    threads: new Map(rows.threads.map((t) => [t.id, t])),
    followUps: new Map(rows.followUps.map((f) => [f.id, f])),
    asks: new Map(rows.asks.map((a) => [a.id, a])),
    tasks: new Map(rows.tasks.map((k) => [k.id, k])),
    // Only a hand-off, new or held, reads the usage window.
    window: seeds.window
      ? {
          share: seeds.window.share,
          resetsAt: seeds.window.resetsAt,
          ask: windowAsk ? { id: windowAsk.id, status: windowAsk.status } : null
        }
      : null,
    runsGoing: new Set(runsGoing.keys()),
    owner: await ownerName(tx),
    prepared:
      e.kind === 'askDecided' && asked
        ? await prepareYes(
            tx,
            e,
            asked,
            odds.find((s) => s.id === asked.staffId)
          )
        : e.kind === 'handedOff'
          ? { sharing: await handOffSharing(tx, e) }
          : {}
  };
}

/**
 * What a hand-off carries if it is taken, from access as it is now. New work
 * has no colleague on it yet: no thread has id 0, so `sharing` finds none.
 */
function handOffSharing(tx: Tx, e: EventOf<'handedOff'>): Promise<HandOff> {
  const { title, brief, files } = e.work;
  const threadId = 'id' in e.thread ? e.thread.id : 0;
  return sharing(tx, { from: e.from, to: e.to, title, brief, files, threadId });
}

/**
 * What an owner's yes reads that takes I/O, worked out under the locks: the
 * switches a switch yes turns on and the network words they open, a level or
 * office tool yes's ledger words, as the Settings tab writes them, a folder
 * yes's ledger title, which shows the folder's real path, and what a held
 * hand-off carries, from access as it is at the yes. `odd` is the Odd's row
 * as the loader read it, before the claim changes it.
 */
async function prepareYes(
  tx: Tx,
  e: EventOf<'askDecided'>,
  ask: Ask,
  odd: StaffRow | undefined
): Promise<Prepared> {
  if (e.decision !== 'approve' || ask.status !== 'open') return {};
  if (ask.kind === 'switch' && odd) {
    const off = switchesOff(odd, ask.switches ?? []);
    const after = { ...odd };
    for (const s of off) after[s] = true;
    return { switches: { before: odd, off, networkBody: networkNote(odd, after).body } };
  }
  if (effectsOf(ask.kind, 'approve').includes('grant_setting') && odd)
    return { setting: settingGranted(odd, ask, e.actsOnHandOffs) };
  // The claim writes the event's folder onto the ask, in place of the one asked for.
  const given = (e.done?.folder ?? ask.folder)?.given;
  if (ask.kind === 'folder' && given)
    return { folderTitle: gaveFolder(odd?.name ?? ask.staffId, given.path, given.level) };
  if (effectsOf(ask.kind, 'approve').includes('start_held') && ask.held && ask.threadId) {
    // Only what the lead chose: an ask held by an earlier build also stored
    // what it carried then, which access may have changed since.
    const { from, to, title, brief, files } = ask.held;
    return {
      sharing: await sharing(tx, { from, to, title, brief, files, threadId: ask.threadId })
    };
  }
  return {};
}

/** An Odd as the deciders read it. `boss` is the office's manager's id. */
function oddOf(s: typeof staff.$inferSelect, boss: string | undefined): Odd {
  return {
    id: s.id,
    name: s.name,
    leftAt: s.leftAt,
    level: s.permission,
    actsOnHandOffs: s.actsOnHandOffs,
    agent: s.agent,
    manager: s.id === boss
  };
}

type Reach = {
  threads: Set<number>;
  staff: Set<string>;
  asks: Set<number>;
  tasks: Set<number>;
  /** The event's own `hand_off` runs, and those that the asks and tasks reached serve. */
  handOffs: Set<number>;
};

/**
 * Which threads and Odds the event can touch, read before any lock. It
 * follows only links a row keeps for life (a run's Odd, thread, ask and
 * task, what an ask or task was raised on), so the locks taken from it still
 * cover the rows once locked. The one link that can change is a park: a
 * thread parked on the task a run lifted, which that run's failure wakes, or
 * on a task the event ends. A thread that parks on a lifted task after this
 * read is left for the task's own end; one on a task the event ends is
 * caught under the task's lock.
 */
async function reachOf(tx: Tx, seeds: Seeds): Promise<Reach> {
  const runs = await tx
    .select()
    .from(followUps)
    .where(inArray(followUps.id, seeds.followUps ?? []));
  const lifted = runs.flatMap((f) => one(f.unparkedTask));
  const taskIds = [...(seeds.tasks ?? []), ...runs.flatMap((f) => one(f.taskId)), ...lifted];
  const taskRows = await tx.select().from(tasks).where(inArray(tasks.id, taskIds));
  const askIds = [
    ...(seeds.asks ?? []),
    ...runs.flatMap((f) => one(f.askId)),
    ...taskRows.flatMap((k) => one(k.askId))
  ];
  const askRows = await tx.select().from(asks).where(inArray(asks.id, askIds));
  // A hand-off run reaches its own asks and tasks by `handOffId`, which a
  // row raised with no thread gives no other way in.
  const handOffs = [
    ...runs.filter((f) => f.kind === 'hand_off').map((f) => f.id),
    ...[...askRows, ...taskRows].flatMap((r) => one(r.handOffId))
  ];
  const origins = await tx.select().from(followUps).where(inArray(followUps.id, handOffs));
  const threadIds = new Set([
    ...(seeds.threads ?? []),
    ...[...runs, ...askRows, ...taskRows, ...origins].flatMap((r) => one(r.threadId)),
    ...(await parkedIds(tx, [...lifted, ...(seeds.ends ?? [])]))
  ]);
  const hubs = await tx
    .select({ hubId: threads.hubId })
    .from(threads)
    .where(inArray(threads.id, [...threadIds]));
  return {
    threads: threadIds,
    staff: new Set([
      ...(seeds.staff ?? []),
      ...[...runs, ...origins].flatMap((f) => [f.staffId, ...(f.handOff ? [f.handOff.from] : [])]),
      ...hubs.map((t) => t.hubId)
    ]),
    asks: new Set(askIds),
    tasks: new Set(taskIds),
    handOffs: new Set(handOffs)
  };
}

/** The ids of a table's rows that `where` picks. */
async function idsOf(
  tx: Tx,
  table: typeof threads | typeof asks | typeof tasks | typeof followUps,
  where: SQL | undefined
): Promise<number[]> {
  const rows: { id: number }[] = await tx.select({ id: table.id }).from(table).where(where);
  return rows.map((r) => r.id);
}

/**
 * The Odd's `answered` run on no work still waiting to start, which an answer
 * to something it raised on no work joins (`offWorkAnswer`).
 */
const waitingAnswer = (tx: Tx, staffId: string): Promise<number[]> =>
  idsOf(
    tx,
    followUps,
    and(
      eq(followUps.staffId, staffId),
      eq(followUps.kind, 'answered'),
      isNull(followUps.threadId),
      queuedRows
    )
  );

/** The threads parked on any of the tasks. */
async function parkedIds(tx: Tx, taskIds: number[]): Promise<number[]> {
  const rows = await tx
    .select({ id: threads.id })
    .from(threads)
    .where(inArray(threads.resumeOnTask, taskIds));
  return rows.map((t) => t.id);
}

/** The open tasks, only this Odd's when one is named. */
const openTasksOf = (staffId: string | undefined): SQL | undefined =>
  and(eq(tasks.status, 'open'), staffId === undefined ? undefined : eq(tasks.staffId, staffId));

/** Their ids. */
const openTaskIds = (tx: Tx, staffId: string | undefined): Promise<number[]> =>
  idsOf(tx, tasks, openTasksOf(staffId));

/**
 * One transaction at a time on a tool's connect tasks, the first statement
 * of each seed that reads them, before any row lock, as `lockDesk` is. Under
 * READ COMMITTED, two gives could each find no open connect task and each
 * insert one, and a drop could miss a task given after its read and leave it open.
 */
const lockConnector = (tx: Tx, connector: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`connect:${connector}`}))`);

/**
 * The asks the owner's one answer settled with `from`: of a twinned kind,
 * the same Odd and kind, decided the same way at the same moment. The
 * decider picks the same tool or folder among them (`answeredWith`).
 */
async function settledTogether(tx: Tx, from: typeof asks.$inferSelect): Promise<number[]> {
  const at = from.decidedAt?.getTime();
  if (!TWINNED.includes(from.kind) || from.status === 'open' || at === undefined) return [];
  const rows = await tx
    .select({ id: asks.id, decidedAt: asks.decidedAt })
    .from(asks)
    .where(
      and(eq(asks.staffId, from.staffId), eq(asks.kind, from.kind), eq(asks.status, from.status))
    );
  // The moment is compared in milliseconds, as the decider compares it.
  return rows.filter((r) => r.decidedAt?.getTime() === at).map((r) => r.id);
}
