// One office on the in-memory database, for the tests of the work core's
// database side (work-apply.test.ts and work-apply-sequences.test.ts): its
// rows, the events those tests send, and the shell that sends each through
// the core's own loader and writer. Importing it puts PGlite in place of the
// office's database.
import { sql } from 'drizzle-orm';
import type { Level } from '../src/access-words.ts';
import type { Decision } from '../src/office-asks.ts';
import {
  asks,
  followUps,
  owner,
  planLimits,
  staff,
  tasks,
  threads,
  type HandOff,
  type Step
} from '../src/schema.ts';
import type { Tx } from '../src/threads.ts';
import type { After, Decided } from '../src/transition.ts';
import { decide } from '../src/work/decide.ts';
import type { AskEffects, EventOf, LeaveEffects, WorkEvent } from '../src/work/events.ts';
import type { Change, Odd, WorkRows } from '../src/work/snapshot.ts';
import { parseAsk, parseFollowUp, parseTask, parseThread } from '../src/work/state.ts';
import { db } from './pglite.ts';

const { transition } = await import('../src/transition.ts');
const { loadWork } = await import('../src/work/load.ts');
const { applyWork } = await import('../src/work/apply.ts');
// The office's own handle, which is PGlite's here, so a transaction has the type the core takes.
const { db: officeDb } = await import('../src/db.ts');

export const T0 = new Date('2026-11-12T09:00:00Z');
export const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const OWNER = 'Sam';

const ODDS: Odd[] = [
  { id: 'lia', name: 'Lia', level: 'act', leftAt: null },
  { id: 'cal', name: 'Cal', level: 'draft', leftAt: null },
  { id: 'rae', name: 'Rae', level: 'read', leftAt: null },
  { id: 'gus', name: 'Gus', level: 'act', leftAt: minutes(-60) },
  { id: 'kit', name: 'Kit', level: 'read', leftAt: null }
].map((o) => ({
  ...o,
  level: o.level as Level,
  actsOnHandOffs: false,
  agent: 'claude',
  manager: false
}));

const handOff = (from: string, more: Partial<HandOff> = {}): HandOff => ({
  from,
  title: `Work from ${from}`,
  brief: 'Do it.',
  ...more
});

/**
 * One office with a run in each state the runs family decides: queued and
 * running pick-ups, a colleague's hand-off with an open ask on it, a result
 * from one that left, a thread parked on an open task, a running pick-up
 * whose lifted task ended meanwhile, work whose lead left, and work that
 * nothing names but its lead.
 */
export async function seedOffice(): Promise<void> {
  await db.execute(
    sql`truncate staff, threads, follow_ups, asks, tasks, reports, pokes, goals, attachments, jobs, ledger, owner, plan_limits restart identity cascade`
  );
  await db.insert(owner).values({ name: OWNER });
  await db.insert(staff).values(
    ODDS.map((o) => ({
      id: o.id,
      name: o.name,
      role: 'r',
      variant: 'v',
      portrait: 'p',
      remit: 'r',
      desk: 'd',
      agent: o.agent,
      permission: o.level,
      leftAt: o.leftAt
    }))
  );
  const task = { why: 'w', steps: [], createdAt: T0 };
  // 1: open, the park of thread 1. 2: done while run 2 ran, which lifted it.
  await db.insert(tasks).values([
    { ...task, staffId: 'lia', title: 'Sign the form' },
    { ...task, staffId: 'lia', title: 'Read the draft', status: 'done', doneAt: minutes(-5) }
  ]);
  const thread = (hubId: string, title: string) => ({
    hubId,
    holderId: hubId,
    title,
    createdAt: T0
  });
  await db
    .insert(threads)
    .values([
      { ...thread('lia', 'Parked work'), resumeOnTask: 1 },
      { ...thread('lia', 'Results coming back') },
      { ...thread('gus', 'Work its lead left'), status: 'stopped', endedAt: minutes(-60) },
      { ...thread('lia', 'Colleagues at work') },
      { ...thread('lia', 'A run goes here'), runs: ['k1'] },
      { ...thread('lia', 'Parked on the ended task'), resumeOnTask: 2 }
    ]);
  // Asks before runs, which point at them; an ask names its hand-off with no key.
  const ask = { why: 'w', ifApproved: 'i', createdAt: T0, threadId: 4 };
  await db.insert(asks).values([
    { ...ask, staffId: 'cal', title: 'May I?', handOffId: 6 },
    {
      ...ask,
      staffId: 'cal',
      title: 'Approved one',
      handOffId: 8,
      status: 'approved',
      decidedAt: minutes(-2)
    }
  ]);
  const run = { createdAt: T0 };
  const started = { startedAt: minutes(-10) };
  await db.insert(followUps).values([
    { ...run, staffId: 'lia', kind: 'resume', threadId: 1 },
    {
      ...run,
      ...started,
      staffId: 'lia',
      kind: 'handed_back',
      threadId: 2,
      unparkedTask: 2,
      handOff: handOff('cal', { outcome: 'done', id: 3 })
    },
    {
      ...run,
      ...started,
      staffId: 'cal',
      kind: 'hand_off',
      threadId: 2,
      handOff: handOff('lia'),
      outcome: 'done',
      result: 'Done.',
      doneAt: minutes(-20)
    },
    {
      ...run,
      staffId: 'lia',
      kind: 'handed_back',
      threadId: 2,
      handOff: handOff('rae', { outcome: 'done' })
    },
    {
      ...run,
      staffId: 'lia',
      kind: 'handed_back',
      threadId: 2,
      handOff: handOff('cal', { outcome: 'failed' })
    },
    { ...run, ...started, staffId: 'cal', kind: 'hand_off', threadId: 4, handOff: handOff('lia') },
    { ...run, staffId: 'rae', kind: 'hand_off', threadId: 4, handOff: handOff('lia') },
    { ...run, staffId: 'cal', kind: 'hand_off', threadId: 4, handOff: handOff('lia') },
    { ...run, staffId: 'cal', kind: 'carry_out', threadId: 4, askId: 2 },
    {
      ...run,
      ...started,
      staffId: 'gus',
      kind: 'handed_back',
      threadId: 3,
      handOff: handOff('cal', { outcome: 'done' })
    },
    { ...run, ...started, staffId: 'rae', kind: 'hand_off', threadId: 3, handOff: handOff('gus') },
    { ...run, staffId: 'lia', kind: 'resume', threadId: 5 },
    { ...run, staffId: 'cal', kind: 'answered', reportWhenDone: true },
    {
      ...run,
      staffId: 'rae',
      kind: 'task_done',
      taskId: 2,
      outcome: 'failed',
      result: 'Rae left.',
      doneAt: minutes(-30)
    }
  ]);
  await seedAnswers();
  // 10: no run, ask or task names it, so only the search for the work an Odd leads finds it.
  await db
    .insert(threads)
    .values({ hubId: 'kit', holderId: 'kit', title: 'Kit alone', createdAt: T0 });
}

export const FOLDER = { path: '/srv/plans', level: 'read' } as const;
export const SLACK_POST = { connector: 'slack', tool: 'post', arguments: { text: 'Hello.' } };
export const HELD = { from: 'lia', to: 'rae', title: 'Check the figures', brief: 'Check them.' };
export const DRIVE_STEP: Step = {
  text: 'Sign in',
  done: false,
  action: { kind: 'oauth', connector: 'drive' }
};
export const AWS_STEP: Step = {
  text: 'Add the keys',
  done: false,
  action: { kind: 'aws', connector: 'aws' }
};

/**
 * What the owner has to answer, beside the runs: an access ask and its twin
 * off any work, a folder, a switch, a held hand-off, the usage window's ask
 * holding work, a held call, an ask of an Odd that left, an answered
 * access ask with its twin whose connect task has work parked on it, and an
 * ask to bring back the Odd that left.
 */
async function seedAnswers(): Promise<void> {
  const ask = { why: 'w', ifApproved: 'i', createdAt: T0 };
  const gmail = { connector: 'gmail', level: 'read' } as const;
  const drive = { connector: 'drive', level: 'read' } as const;
  const decided = { status: 'approved', decidedAt: minutes(-3) } as const;
  // 3 to 13. Thread 7 is the window's hold and 8 the held hand-off's work, put in below.
  await db.insert(asks).values([
    { ...ask, staffId: 'cal', kind: 'access', title: 'Gmail', access: gmail, threadId: 2 },
    { ...ask, staffId: 'cal', kind: 'access', title: 'Gmail again', access: gmail },
    { ...ask, staffId: 'rae', kind: 'folder', title: 'The plans', folder: FOLDER },
    {
      ...ask,
      staffId: 'cal',
      kind: 'switch',
      title: 'Commands',
      switches: ['commands', 'web'],
      threadId: 4
    },
    { ...ask, staffId: 'lia', kind: 'hand_offs', title: 'One more', threadId: 8, held: HELD },
    { ...ask, staffId: 'lia', kind: 'window', title: 'Carry on?' },
    { ...ask, staffId: 'cal', kind: 'call', title: 'Post it', call: SLACK_POST },
    { ...ask, staffId: 'gus', title: 'Before I went' },
    { ...ask, ...decided, staffId: 'cal', kind: 'access', title: 'Drive', access: drive },
    {
      ...ask,
      ...decided,
      staffId: 'cal',
      kind: 'access',
      title: 'Drive too',
      access: drive,
      threadId: 4
    },
    { ...ask, staffId: 'lia', kind: 'bring_back', odd: 'gus', title: 'Bring Gus back?' }
  ]);
  const task = { why: 'w', createdAt: T0 };
  // 3: the connect task of ask 11; 4: on work; 5: the office's own.
  await db.insert(tasks).values([
    { ...task, staffId: 'cal', askId: 11, title: 'Connect Drive', steps: [DRIVE_STEP] },
    { ...task, staffId: 'rae', title: 'Look it over', steps: [], threadId: 2 },
    { ...task, staffId: null, title: 'Connect AWS', steps: [AWS_STEP] }
  ]);
  const thread = (hubId: string, title: string) => ({
    hubId,
    holderId: hubId,
    title,
    createdAt: T0
  });
  await db
    .insert(threads)
    .values([
      { ...thread('lia', 'Held for the window'), resumeAt: minutes(120), heldBy: 8 },
      { ...thread('lia', 'A hand-off waits on a yes') },
      { ...thread('cal', 'Parked on a connect task'), resumeOnTask: 3 }
    ]);
}

/** The four tables a change puts rows in, by their names in the database. */
export const TABLES = {
  threads: 'threads',
  asks: 'asks',
  tasks: 'tasks',
  followUps: 'follow_ups'
} as const;
export type Table = keyof typeof TABLES;
export const TABLE_KEYS = Object.keys(TABLES) as Table[];

/** Every row of the four tables, as states. */
export async function readRows(): Promise<Pick<WorkRows, Table>> {
  const byId = <T extends { id: number }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  return {
    threads: byId((await db.select().from(threads)).map(parseThread)),
    followUps: byId((await db.select().from(followUps)).map(parseFollowUp)),
    asks: byId((await db.select().from(asks)).map(parseAsk)),
    tasks: byId((await db.select().from(tasks)).map(parseTask))
  };
}

/** The whole office in memory, as a loader that read everything would give it. */
export async function readWorld(): Promise<WorkRows> {
  return {
    ...(await readRows()),
    staff: new Map(ODDS.map((o) => [o.id, o])),
    window: null,
    runsGoing: new Set(),
    owner: OWNER,
    prepared: {}
  };
}

/**
 * Moves each table's serial into a band of its own, past the ids a decider
 * guesses for new rows (the next after the highest it loaded), so a guessed
 * id written anywhere, or an id taken from the wrong table, shows. Gives the
 * id each table's next row gets.
 */
export async function idsOffset(rows: Pick<WorkRows, Table>): Promise<Record<Table, number>> {
  const next = { threads: 0, asks: 0, tasks: 0, followUps: 0 };
  for (const [i, table] of TABLE_KEYS.entries()) {
    // One change inserts far fewer than 100 rows into a table, so no guess reaches the serial.
    const last = Math.max((i + 1) * 1_000_000, ...rows[table].keys()) + 100;
    await db.execute(sql`select setval(pg_get_serial_sequence(${TABLES[table]}, 'id'), ${last})`);
    next[table] = last + 1;
  }
  return next;
}

/** The real ids `applyWork` gives for the rows a written change names. */
type RealId = Awaited<ReturnType<typeof applyWork>>;

/**
 * One event through the shell, on the office's database, with the core's own
 * loader and writer, the rows it loaded, and the real ids of a change it wrote.
 * Its own copy of `transitionWork`, which gives the ids but not the rows it loaded.
 */
export async function run(
  e: WorkEvent,
  now: Date
): Promise<{ got: Decided<Change>; loaded: WorkRows; real: RealId | undefined }> {
  let loaded: WorkRows | undefined;
  let real: RealId | undefined;
  const got = await officeDb.transaction((tx) =>
    transition(
      {
        name: e.kind,
        load: async (q: Tx) => (loaded = await loadWork(q, e)),
        decide: (rows: WorkRows, at: Date) => decide(rows, e, at),
        apply: async (q: Tx, c: Change) => {
          real = await applyWork(q, c);
        }
      },
      // The shell hands the after-effects back unrun: work-apply.test.ts's effects test runs them.
      { tx, now }
    )
  );
  if (!loaded) throw new Error('The shell decided without loading.');
  return { got, loaded, real };
}

/** An after-effect that runs a closure, by its name: a closure made in each decide is a new function. */
const named = (d: Decided<Change>) =>
  'change' in d
    ? { ...d, after: d.after.map((a: After) => ('record' in a ? a : { then: a.then })) }
    : d;

/**
 * A decision with its puts left out, for a test that compares the puts by
 * the rows they leave: a decider guesses a new row's id from the
 * rows it read, so the loaded rows and the whole office guess apart, and a
 * row pointing at a new one holds that guess until the apply writes the
 * real id.
 */
export const unput = (d: Decided<Change>) => {
  const n = named(d);
  return 'change' in n ? { ...n, change: { ...n.change, put: [] } } : n;
};

/** Each call an answer's effects make, by name. No decider may make one: the shell runs them after the commit. */
export const calls: string[] = [];
const fakes: AskEffects = {
  grantAccess: async (staffId) => {
    calls.push(`grantAccess ${staffId}`);
    return { task: false, connector: 'gmail' };
  },
  pointAsksAtConnector: async (ids) => void calls.push(`pointAsksAtConnector ${ids.join(' ')}`),
  carryOutTogether: async (together) =>
    void calls.push(`carryOutTogether ${together.map((a) => a.id).join(' ')}`),
  oweCatchUp: async (a) => void calls.push(`oweCatchUp ${a.id}`),
  removeOdd: async (id) => void calls.push(`removeOdd ${id}`),
  bringBack: async (id) => void calls.push(`bringBack ${id}`)
};
/** A leaving's call after its commit, recorded with the answers' calls. */
const leaveFakes: LeaveEffects = { stopRuns: (id) => void calls.push(`stopRuns ${id}`) };

/** The owner lets an Odd go, as the staff route's Remove sends it. */
export const leaving = (staffId: string): EventOf<'oddRemoved'> => ({
  kind: 'oddRemoved',
  staffId,
  line: { kind: 'hire', actor: 'owner', title: `Let ${staffId} go`, body: `${staffId} left.` },
  about: new Map(),
  effects: leaveFakes
});

/** The owner's yes to bringing an Odd back. */
export const bringingBack = (staffId: string): EventOf<'oddBroughtBack'> => ({
  kind: 'oddBroughtBack',
  staffId,
  line: { kind: 'hire', actor: 'owner', title: `Brought ${staffId} back`, body: 'Back.' }
});

/** The owner's answer to an ask, as the desk sends it. */
export const answer = (
  id: number,
  decision: Decision,
  more: Partial<EventOf<'askDecided'>> = {}
): WorkEvent => ({
  kind: 'askDecided',
  id,
  decision,
  reason: decision === 'approve' ? null : 'Because.',
  inChat: id % 2 === 0,
  perKind: [],
  effects: fakes,
  ...more
});

/** The usage window past its guard, by default resetting long after ask 8 was raised, so no ask of this window is on the desk yet. */
export async function windowPastGuard(
  resetsAt = minutes(400)
): Promise<{ share: number; resetsAt: Date }> {
  const share = 0.9;
  await db
    .insert(planLimits)
    .values({ fiveHour: share, fiveHourResetsAt: resetsAt, sevenDay: 0.1 });
  return { share, resetsAt };
}

/** A hand-off from Lia, on work it leads or on new work it opens. */
export const handOffOf = (
  thread: EventOf<'handedOff'>['thread'],
  more: Partial<EventOf<'handedOff'>> = {}
): EventOf<'handedOff'> => ({
  kind: 'handedOff',
  from: 'lia',
  to: 'cal',
  work: { title: 'Check it', brief: 'Check.' },
  thread,
  carry: [],
  ...more
});
