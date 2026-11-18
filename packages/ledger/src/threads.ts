// Threads: one piece of work an Odd chains through colleagues. Its first
// hand_off opens one with that Odd as the hub, and so does work it starts on
// its own for a goal, or a plan it raises for one (`goalThread`). Only the hub's runs hand off
// again, so it stays hub and spoke and never nests. The hub picks how it moves
// on: a colleague finishing, a time it sets (the office clock wakes it), a task
// on the owner's desk it parks on (task-parking.ts), or the owner answering something raised on it, or telling a colleague in its chat
// something about the thread (`tellLead`). The server holds the limit. From a
// chat or a job, the hub may continue a thread it leads instead of opening
// one, even a finished one, which reopens for a new round of work. A round
// takes up to `HAND_OFF_LIMIT` hand-offs; past it the owner decides whether
// the work keeps going, and a yes starts the hand-off that waited. While the plan's usage window is nearly used up, new
// hand-offs to Odds on Claude Code wait for it (`handedOff` in work/hand-offs.ts).
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL
} from 'drizzle-orm';
import { db } from './db.ts';
import { fixedError } from './errors.ts';
import { manager } from './goals.ts';
import { home } from './home.ts';
import {
  asks,
  followUps,
  goals,
  jobs,
  staff,
  staffGoals,
  tasks,
  threads,
  type Outcome,
  type ThreadStatus
} from './schema.ts';
import { flat, type DeskItem } from './desk-answers.ts';
import { heldTools, lacking, toolNames, type Tool } from './sharing.ts';
import { carryEach, type Carried, type CarriedFile } from './hand-offs.ts';
import { THREADS_DIR, workPath } from './work-paths.ts';
import { runAfters } from './transition.ts';
import { transitionWork } from './work/apply.ts';
import { decide } from './work/decide.ts';
import type { EventOf } from './work/events.ts';
import { loadWork } from './work/load.ts';

export type ThreadRow = typeof threads.$inferSelect;

/** A thread's folder, outside every Odd's own. Every run on the thread reads all of it. */
export const threadFolder = (id: number): string => home(THREADS_DIR, String(id));
/** One Odd's part of a thread's folder: the only place in it that Odd's runs write. */
export const threadPart = (id: number, staffId: string): string => join(threadFolder(id), staffId);
/**
 * What an Odd calls a thread: a goal's is "the goal", any other "the work".
 * "Thread" is the office's own word, and an Odd copies what it reads into
 * what the owner reads, so no text an Odd reads says it.
 */
export const workCalled = (t: { goalId: number | null }): 'the goal' | 'the work' =>
  t.goalId ? 'the goal' : 'the work';
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The database, or a transaction under way on it. */
export type Db = typeof db | Tx;

/** What an Odd is told when it would open a thread it may not lead (`assertMayLead`). */
export const LEADS_NONE =
  "Nothing was opened. You serve a goal and have no job of your own, so you lead no work: the goal's lead hands each piece on. Pass the owner's words to the lead with tell_lead, then tell the owner you passed them on.";

/**
 * Opens a thread outside the work core, with `hubId` as its lead, once it
 * may lead work (`assertMayLead`). A hand-off opens its new work through the work
 * core instead, after the same check.
 */
async function openThread(
  q: Db,
  t: { title: string; hubId: string; goalId?: number }
): Promise<ThreadRow> {
  await assertMayLead(q, t.hubId);
  const [opened] = await q
    .insert(threads)
    .values({ ...t, holderId: t.hubId })
    .returning();
  return opened;
}

/**
 * An Odd that serves a goal and has no job does only that goal's work, which
 * the goal's lead hands on, so it never leads a thread: this throws instead,
 * whatever tool or run got here, and the tool server returns the throw as an
 * error the Odd reads. The manager leads every goal's thread, so it is never
 * refused.
 */
export async function assertMayLead(q: Db, hubId: string): Promise<void> {
  const [serves] = await q
    .select({ id: staffGoals.goalId })
    .from(staffGoals)
    .where(eq(staffGoals.staffId, hubId))
    .limit(1);
  if (!serves) return;
  const [job] = await q.select({ id: jobs.id }).from(jobs).where(eq(jobs.staffId, hubId)).limit(1);
  if (!job && (await manager(q))?.id !== hubId) throw new Error(LEADS_NONE);
}

/**
 * A goal's one thread, led by the office's manager, or with none, by whoever
 * leads the one the goal already has, else by the Odd opening it. Every piece
 * of the goal's work goes on it: the manager's planning, each plan, and every
 * hand-off for the goal, so a hire serving it joins it as a colleague and
 * never leads one of its own. An ended one is found as it is, so the goal
 * never gets a second: what lands on it opens it again, an ask or task
 * (`raisedOn` in work/threads.ts) or the lead's next hand-off, so a lookup alone, such as a
 * hand-off the office refuses, changes nothing. A stopped one opens again
 * only for a new plan (`raisedOn`); a hand-off there is refused until then.
 * Opening one counts no hand-off against its limit.
 */
export async function goalThread(q: Db, goalId: number, opener: string): Promise<number> {
  const work = await goalThreadOrNew(q, goalId, opener);
  return 'id' in work ? work.id : (await openThread(q, work.open)).id;
}

/** A goal's one thread, as `goalThread` finds it, or the one to open for it when it has none yet. */
export async function goalThreadOrNew(
  q: Db,
  goalId: number,
  opener: string
): Promise<{ id: number } | { open: { title: string; hubId: string; goalId: number } }> {
  const lead = (await manager(q))?.id;
  const [found] = await q
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.goalId, goalId), lead ? eq(threads.hubId, lead) : undefined))
    .orderBy(desc(threads.id))
    .limit(1);
  if (found) return { id: found.id };
  const [g] = await q.select({ title: goals.title }).from(goals).where(eq(goals.id, goalId));
  if (!g) throw new Error(`No goal #${goalId}`);
  return { open: { title: g.title, hubId: lead ?? opener, goalId } };
}

/**
 * Why a hub may not name this thread for an ask or task from a run on no
 * thread, or undefined when it may: as `continue_work` is checked, it must
 * lead it, and it must not have stopped.
 */
export async function notLed(t: { hubId: string; threadId: number }): Promise<string | undefined> {
  const [row] = await db
    .select({ hubId: threads.hubId, status: threads.status })
    .from(threads)
    .where(eq(threads.id, t.threadId));
  if (row?.hubId !== t.hubId)
    return `Work ${t.threadId} is not work you lead. Name one your instructions list as work you lead, or null.`;
  if (row.status === 'stopped')
    return `Work ${t.threadId} has stopped, so nothing more goes on it. Name another, or null.`;
  return undefined;
}

/**
 * A hand-off opens a thread, or goes on in one the hub leads: the thread its
 * run works on, one it names to continue from a chat or a job, or its goal's
 * (`goalThread`).
 */
export type ThreadFor = { id: number } | { title: string; goalId?: number };

// Its one home is the work core's hand-off decider, which holds the round to it.
export { HAND_OFF_LIMIT } from './work/hand-offs.ts';

/** "1 hand-off", "3 hand-offs". */
export const handOffsWord = (n: number): string => `${n} ${n === 1 ? 'hand-off' : 'hand-offs'}`;

/**
 * The hub sets when it picks the thread back up, through the work core
 * (`parked`). Undefined when it is not the hub's or has ended. The hub's own
 * time replaces a hold for the usage window and a park on a task.
 */
export async function parkThread(hubId: string, id: number, at: Date): Promise<Date | undefined> {
  const parked = await transitionWork({
    kind: 'parked',
    staffId: hubId,
    threadId: id,
    on: { at },
    // A park on a time reads only the work the Odd leads.
    worksOn: new Set()
  });
  if ('refused' in parked) return undefined;
  const r = parked.change.result;
  if (!('at' in r)) throw fixedError('A park on a time came back as a park on a task.');
  return r.at;
}

/** Threads parked until a time, for the office clock. */
export async function parkedThreads(): Promise<{ id: number; resumeAt: Date }[]> {
  const rows = await db
    .select({ id: threads.id, resumeAt: threads.resumeAt })
    .from(threads)
    .where(and(isNotNull(threads.resumeAt), isNull(threads.endedAt)));
  return rows.flatMap((r) => (r.resumeAt ? [{ id: r.id, resumeAt: r.resumeAt }] : []));
}

/**
 * The time a thread was parked until has come: the hub picks it up, through
 * the work core (`clockWoke`), which wakes it once however many wakes come.
 * A thread the usage window held is told the window reset.
 */
export async function wakeThread(id: number): Promise<void> {
  await transitionWork({ kind: 'clockWoke', threadId: id });
}

export async function thread(id: number): Promise<ThreadRow | undefined> {
  const [row] = await db.select().from(threads).where(eq(threads.id, id));
  return row;
}

/** How many of an Odd's latest threads its list shows, and how many with no goal a chat tells the story of. */
export const LATEST_WORK = 5;

/** A thread among a hub's latest, as its instructions list it off a thread. */
export type RecentThread = { id: number; title: string; stage: ThreadStage; goal?: string };

/**
 * A hub's latest threads, newest first, so it can tell more of the same work
 * from new work. Not those in `told`, whose whole story the run is told
 * already (`ledStories`).
 */
export async function recentThreads(
  hubId: string,
  o: { limit?: number; told?: number[] } = {}
): Promise<RecentThread[]> {
  const rows = await db
    .select({ id: threads.id, title: threads.title, status: threads.status, goal: goals.title })
    .from(threads)
    .leftJoin(goals, eq(threads.goalId, goals.id))
    .where(
      and(eq(threads.hubId, hubId), o.told?.length ? notInArray(threads.id, o.told) : undefined)
    )
    .orderBy(desc(threads.id))
    .limit(o.limit ?? LATEST_WORK);
  if (!rows.length) return [];
  const waiting = await waitingOn(
    db,
    rows.map((r) => r.id)
  );
  return rows.map(({ status, ...r }) => ({
    ...r,
    stage: stageOf(status, waitingFor(waiting, r.id)),
    goal: r.goal ?? undefined
  }));
}

/** Where a thread stands, as an Odd's list or its lead's brief says it, and whether it can be continued. */
export const LISTED: Record<ThreadStage, string> = {
  under_way: 'under way',
  waiting_on_you: 'waiting on {owner}',
  done: 'finished',
  failed: 'could not finish',
  stopped: 'it has stopped, so it cannot be continued'
};

/**
 * The section of a hub's instructions that lists its latest threads, in a run
 * on no thread, such as a chat or a job: one of these may be the work {owner}
 * asks for more of. Empty when it leads none.
 */
export function recentThreadsBrief(rows: RecentThread[]): string {
  if (!rows.length) return '';
  return [
    '',
    '## Work you lead',
    '',
    'Your latest work, newest first:',
    '',
    ...rows.map(
      (t) =>
        `- Work ${t.id}: ${t.title} (${LISTED[t.stage]}${t.goal ? `, for the goal "${t.goal}"` : ''}).`
    ),
    '',
    `When {owner} asks for more of the same work as one of these, such as a fix, an addition or its next part, continue it: hand_off with continue_work set to its number. It keeps that work's folder, files and history, so your colleague can read what was done, and finished work reopens. Start new work only when none of these is about it.`,
    ''
  ].join('\n');
}

/** A thread an Odd works on and does not lead, as its chat lists it. */
export type ThreadOn = {
  id: number;
  title: string;
  stage: ThreadStage;
  lead: string;
  goalId: number | null;
};

/**
 * The threads an Odd works on: those it was handed work on, and those of a
 * goal it serves, since a goal's one thread is where all its work goes, even
 * before the lead hands that Odd a piece. Never one it leads.
 */
export const worksOn = (staffId: string) =>
  and(
    ne(threads.hubId, staffId),
    or(
      inArray(
        threads.id,
        db
          .select({ id: followUps.threadId })
          .from(followUps)
          .where(and(eq(followUps.staffId, staffId), eq(followUps.kind, 'hand_off')))
      ),
      inArray(
        threads.goalId,
        db.select({ id: staffGoals.goalId }).from(staffGoals).where(eq(staffGoals.staffId, staffId))
      )
    )
  );

/** The threads `staffId` works on (`worksOn`), as a park or tell_lead reads them before the work core decides. */
export async function worksOnIds(q: Db, staffId: string): Promise<Set<number>> {
  const rows = await q.select({ id: threads.id }).from(threads).where(worksOn(staffId));
  return new Set(rows.map((r) => r.id));
}

/** A thread `staffId` leads or works on (`worksOn`), so reads all of its folder. */
const onThread = (staffId: string) => or(eq(threads.hubId, staffId), worksOn(staffId));

/** Whether `staffId` leads thread `id` or works on it. */
export async function isOnThread(staffId: string, id: number, q: Db = db): Promise<boolean> {
  const [row] = await q
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, id), onThread(staffId)));
  return !!row;
}

/**
 * The titles, by id, of those of `ids` that `staffId` leads or works on now,
 * by the test `workFile` uses, so a file Storage lists is one that opens.
 */
export async function workTitles(staffId: string, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: threads.id, title: threads.title })
    .from(threads)
    .where(and(inArray(threads.id, ids), onThread(staffId)));
  return new Map(rows.map((r) => [r.id, r.title]));
}

/**
 * The real path of the file `path` names in a thread's folder (`workPath`),
 * or undefined when it names none `staffId` may read: a thread it does not
 * lead or work on now, a path through a link anywhere inside the office's
 * folder of threads, or anything but a file. Whose part of the folder holds it
 * does not matter, since everyone on a thread reads all of its folder.
 */
export async function workFile(staffId: string, path: string): Promise<string | undefined> {
  const named = workPath(path);
  if (!named || !(await isOnThread(staffId, named.thread))) return undefined;
  try {
    // Its real path is where its name says only when no step on the way is a link.
    const file = join(realpathSync(home(THREADS_DIR)), String(named.thread), named.inside);
    return realpathSync(file) === file && statSync(file).isFile() ? file : undefined;
  } catch {
    // Nothing there, or a folder the office may not read: it names no file.
    return undefined;
  }
}

/**
 * The threads an Odd works on and does not lead, newest first: every goal's,
 * and the latest `limit` others. A goal's thread is never cut by the limit,
 * since its chat's tell_lead and the goal work backstop (`goalWork`) read
 * this list, however many errands it was handed since.
 */
export async function threadsOn(staffId: string, limit = LATEST_WORK): Promise<ThreadOn[]> {
  const on = (kind: SQL) =>
    db
      .select({
        id: threads.id,
        title: threads.title,
        status: threads.status,
        lead: staff.name,
        goalId: threads.goalId
      })
      .from(threads)
      .innerJoin(staff, eq(threads.hubId, staff.id))
      .where(and(worksOn(staffId), kind))
      .orderBy(desc(threads.id));
  const [forGoals, others] = await Promise.all([
    on(isNotNull(threads.goalId)),
    on(isNull(threads.goalId)).limit(limit)
  ]);
  const rows = [...forGoals, ...others].sort((a, b) => b.id - a.id);
  if (!rows.length) return [];
  const waiting = await waitingOn(
    db,
    rows.map((r) => r.id)
  );
  return rows.map(({ status, ...r }) => ({
    ...r,
    stage: stageOf(status, waitingFor(waiting, r.id))
  }));
}

/**
 * What a colleague says of what comes next: nothing, since only the lead
 * picks the next step and who takes it.
 */
export const nextIsLeads = (lead: string): string =>
  `Say what you did. Do not say what happens next or who does it: ${lead} decides.`;

/**
 * What a colleague passes to a lead and what it keeps in chat. A lead once
 * read an answer to a colleague's own question as the owner's ruling on the
 * work, so the tool and the chat's instructions say this in the same words.
 */
export const PASS_ONLY_WORK =
  'Only pass on what asks for work or changes it. When they are only clarifying something you asked, such as which file they mean, work it out in chat and pass nothing on.';

/**
 * The section of a colleague's chat instructions that lists the threads it
 * works on and does not lead, so what {owner} says there about one reaches
 * its lead (`tellLead`). Empty when it is on none.
 */
export function threadsOnBrief(rows: ThreadOn[]): string {
  if (!rows.length) return '';
  return [
    '',
    '## Work you are on',
    '',
    'You work on these, and another Odd leads each one. Newest first:',
    '',
    ...rows.map((t) => `- Work ${t.id}: ${t.title}, led by ${t.lead} (${LISTED[t.stage]}).`),
    '',
    `You may answer {owner}'s questions about this work and talk it through. ${PASS_ONLY_WORK} When they ask for work on one of these, such as a fix, a change or a next step, pass their words to its lead with tell_lead, then tell {owner} you passed it to the lead, who decides the next step. Never do that work here, and never raise an ask or give {owner} a task about it: its lead hands each piece on. ${nextIsLeads('its lead')}`,
    ''
  ].join('\n');
}

/**
 * What a lead reads of the colleague's own line in a chat's last exchange
 * when the lead lacks a tool the colleague holds: `left out`, since that line
 * may quote the tool's contents, as a hand-off's `kept` warns (`sharing.ts`),
 * or `quoted` in full. The owner ruled `left out` on 2026-11-09, and this one
 * value is where another answer goes. Remove it, keeping the `left out` path,
 * once the pull request that added it merges with that ruling unchanged.
 */
const REPLY_A_LEAD_LACKS: 'left out' | 'quoted' = 'left out';

/**
 * The chat's last exchange as the lead reads it, on one line. The office puts
 * each chat line on a line of its own, the colleague's last (`lastExchange` in
 * the office's `chat-preface.ts`), so that line alone is the colleague's
 * words. With `lacks` (tools the colleague holds and the lead lacks) and
 * `left out`, the note says that line was left out and why, in its place.
 */
export function exchangeForLead(
  exchange: string,
  name: string,
  lacks: Tool[],
  reply: typeof REPLY_A_LEAD_LACKS
): string {
  const lines = exchange.split('\n').map(flat).filter(Boolean);
  const own = lines.pop();
  if (!own) return '';
  const left = `One line ${name} said in that chat is left out, since ${name} has ${toolNames(lacks.map((t) => t.name))} and you do not.`;
  return [...lines, lacks.length && reply === 'left out' ? left : own].join(' ');
}

/**
 * The owner told a colleague in chat something about a thread it works on and
 * does not lead: their words go to the thread's lead, which picks the thread
 * back up with them, through the work core (`toldLead`). `said` is the
 * owner's whole message, set by the office, and `words` the part about this
 * thread, which must be in it, so only the owner's own words reach the lead as
 * theirs. `reading` is what the colleague understood them to mean, which goes
 * labelled as the colleague's, since a lead cannot judge a clarifying "no"
 * from the bare word. `exchange` is the last two lines of that chat, as the
 * office set them (`exchangeForLead`). `files` are every file the owner
 * attached to that message, as the tool server checked them: each that can
 * land is copied into the colleague's part of the work (`carryEach`), and the
 * note lists where each landed, or why it did not come. A file that does not
 * come never stops the words.
 *
 * One transaction locks the thread, its lead and the teller first, so a stop
 * or a removal landing meanwhile waits for the note. What the event carries
 * (the teller's name, the lead's tools, the work the teller is on) is read
 * after, and the core decides on the rows it locked: once with nothing
 * copied, so a refusal copies no file and writes nothing, then again with
 * what the copy gave, which writes the note.
 */
export async function tellLead(t: {
  staffId: string;
  threadId: number;
  said: string;
  words: string;
  reading: string;
  exchange?: string;
  files?: { carry: CarriedFile[]; unfit: { named: string; why: string }[] };
}): Promise<{ lead: string; files?: Carried[] } | { problem: string }> {
  const told = await db.transaction(async (tx) => {
    const toLoad: EventOf<'toldLead'> = {
      kind: 'toldLead',
      staffId: t.staffId,
      threadId: t.threadId,
      said: t.said,
      words: t.words,
      reading: t.reading,
      // Read below, under the locks: the loader reads only the thread and the teller.
      exchange: '',
      worksOn: new Set(),
      files: []
    };
    const rows = await loadWork(tx, toLoad);
    const lead = rows.threads.get(t.threadId)?.hubId;
    const name = rows.staff.get(t.staffId)?.name ?? t.staffId;
    const lacks =
      t.exchange && lead ? lacking(await heldTools([lead, t.staffId], tx), lead, [t.staffId]) : [];
    const e: EventOf<'toldLead'> = {
      ...toLoad,
      exchange: exchangeForLead(t.exchange ?? '', name, lacks, REPLY_A_LEAD_LACKS),
      worksOn: await worksOnIds(tx, t.staffId)
    };
    // No refusal reads the files, so this one is the one the note would get.
    const first = decide(rows, e, new Date());
    if ('refused' in first) return first;
    const files: Carried[] = [
      ...carryEach(t.threadId, t.staffId, t.files?.carry ?? []),
      ...(t.files?.unfit ?? [])
    ];
    return transitionWork({ ...e, files }, { tx });
  });
  if ('refused' in told) return { problem: told.refused };
  await runAfters('toldLead', told.after);
  return told.change.result;
}

/** Something a thread put on the owner's desk that is still open. */
export type ThreadWaiting = { kind: Exclude<DeskItem, 'report'>; id: number; title: string };

/** A hub's run on its thread that was not a pick-up: woken at a time, or by the owner's answer. */
export type ThreadRun = { at: Date; outcome?: Outcome; text?: string };

/** One thread, as the hub's chat shows it on its card. */
export type ThreadLine = {
  id: number;
  at: Date;
  title: string;
  hub: string;
  holder: string;
  stage: ThreadStage;
  resumeAt?: Date;
  /** Parked until the usage window resets, not at a time the hub set. */
  held: boolean;
  /** The title of the task whose end wakes it. */
  parkedOn?: string;
  waiting: ThreadWaiting[];
  runs: ThreadRun[];
};

/**
 * The thread a task is on: its own, else the thread of the ask it came from,
 * since a tool's connect task belongs to the access ask it came from.
 */
export function taskThread(
  task: { threadId: number | null; askId: number | null },
  threadAsks: { id: number; threadId: number | null }[]
): number | undefined {
  return task.threadId ?? threadAsks.find((a) => a.id === task.askId)?.threadId ?? undefined;
}

/**
 * What each of these threads raised that is still open on the owner's desk,
 * oldest first across asks and tasks, so the first one for a thread is the
 * same item wherever it is named, on the thread's card or in the Goals window.
 * On a tie an ask comes before a task.
 */
export async function waitingOn(
  q: Db,
  ids: number[]
): Promise<(ThreadWaiting & { threadId: number | undefined })[]> {
  const threadAsks = await q
    .select({
      id: asks.id,
      title: asks.title,
      threadId: asks.threadId,
      status: asks.status,
      at: asks.createdAt
    })
    .from(asks)
    .where(inArray(asks.threadId, ids))
    .orderBy(asc(asks.createdAt), asc(asks.id));
  const openTasks = await q
    .select({
      id: tasks.id,
      title: tasks.title,
      threadId: tasks.threadId,
      askId: tasks.askId,
      at: tasks.createdAt
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'open'),
        or(
          inArray(tasks.threadId, ids),
          threadAsks.length
            ? inArray(
                tasks.askId,
                threadAsks.map((a) => a.id)
              )
            : sql`false`
        )
      )
    )
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
  return [
    ...threadAsks
      .filter((a) => a.status === 'open')
      .map((a) => ({
        kind: 'ask' as const,
        id: a.id,
        title: a.title,
        threadId: a.threadId ?? undefined,
        at: a.at
      })),
    ...openTasks.map((k) => ({
      kind: 'task' as const,
      id: k.id,
      title: k.title,
      threadId: taskThread(k, threadAsks),
      at: k.at
    }))
  ]
    .sort((x, y) => x.at.getTime() - y.at.getTime())
    .map(({ at: _, ...w }) => w);
}

/** One thread's part of `waitingOn`, still oldest first. */
export const waitingFor = (
  all: Awaited<ReturnType<typeof waitingOn>>,
  id: number
): ThreadWaiting[] => all.filter((w) => w.threadId === id).map(({ threadId: _, ...w }) => w);

/** Where a thread stands, as a goal lists it. */
export type ThreadStage = 'under_way' | 'waiting_on_you' | 'done' | 'failed' | 'stopped';
/** A thread's stage when nothing it raised is still open on the owner's desk. */
const STAGE: Record<ThreadStatus, ThreadStage> = {
  open: 'under_way',
  // The owner said no to more hand-offs on it.
  stopped: 'stopped',
  done: 'done',
  failed: 'failed'
};
/**
 * Where a thread stands for the owner: waiting on them while anything it
 * raised is still open on the desk, whatever its status, else as its status
 * says. The one place "waiting on the owner" is worked out: it is read from
 * the desk, never stored, so it cannot fall behind an answer.
 */
export const stageOf = (status: ThreadStatus, waiting: ThreadWaiting[]): ThreadStage =>
  waiting.length ? 'waiting_on_you' : STAGE[status];

/** The title of the task each of these threads is parked on, by thread. */
export async function parkedTitles(
  rows: Pick<ThreadRow, 'id' | 'resumeOnTask'>[]
): Promise<Map<number, string>> {
  const parked = rows.filter((t) => t.resumeOnTask !== null).map((t) => t.id);
  if (!parked.length) return new Map();
  const found = await db
    .select({ id: threads.id, title: tasks.title })
    .from(threads)
    .innerJoin(tasks, eq(threads.resumeOnTask, tasks.id))
    .where(inArray(threads.id, parked));
  return new Map(found.map((f) => [f.id, f.title]));
}

/**
 * A thread as the Goals window lists it, under its goal or in other work.
 * `hubId` leads it, `holderId` has it now, and `waiting` is what it raised
 * that is still open on the owner's desk, oldest first.
 */
export type GoalThread = {
  id: number;
  title: string;
  goalId: number | null;
  hubId: string;
  holderId: string;
  stage: ThreadStage;
  resumeAt?: Date;
  /** Parked until the usage window resets, not at a time the hub set. */
  held: boolean;
  /** The title of the task whose end wakes it. */
  parkedOn?: string;
  waiting: ThreadWaiting[];
};

/**
 * Every thread, newest first, with its stage: waiting on the owner while
 * anything it raised is still open on the desk, whatever its status, else as
 * its status says. A thread stays here once it ends, so its goal lists it to
 * the end, and a reopened one is still one row.
 */
export async function goalThreads(): Promise<GoalThread[]> {
  const rows = await db.select().from(threads).orderBy(desc(threads.id));
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const waiting = await waitingOn(db, ids);
  const titles = await parkedTitles(rows);
  return rows.map((t) => {
    const its = waitingFor(waiting, t.id);
    return {
      id: t.id,
      title: t.title,
      goalId: t.goalId,
      hubId: t.hubId,
      holderId: t.holderId,
      stage: stageOf(t.status, its),
      resumeAt: t.resumeAt ?? undefined,
      held: t.heldBy !== null,
      parkedOn: titles.get(t.id),
      waiting: its
    };
  });
}

/** Every thread a staffer leads, oldest first. */
export async function threadsFor(hubId: string, limit = 50): Promise<ThreadLine[]> {
  const rows = await db
    .select()
    .from(threads)
    .where(eq(threads.hubId, hubId))
    .orderBy(desc(threads.createdAt))
    .limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const people = await db.select({ id: staff.id, name: staff.name }).from(staff);
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const waiting = await waitingOn(db, ids);
  const titles = await parkedTitles(rows);
  const runs = await db
    .select()
    .from(followUps)
    .where(
      and(
        inArray(followUps.threadId, ids),
        eq(followUps.staffId, hubId),
        sql`${followUps.kind} <> 'handed_back'`
      )
    )
    .orderBy(asc(followUps.id));
  return rows.reverse().map((t) => ({
    id: t.id,
    at: t.createdAt,
    title: t.title,
    hub: name(t.hubId),
    holder: name(t.holderId),
    stage: stageOf(t.status, waitingFor(waiting, t.id)),
    resumeAt: t.resumeAt ?? undefined,
    held: t.heldBy !== null,
    parkedOn: titles.get(t.id),
    waiting: waitingFor(waiting, t.id),
    runs: runs
      .filter((f) => f.threadId === t.id)
      .map((f) => ({
        at: f.doneAt ?? f.createdAt,
        outcome: f.outcome ?? undefined,
        text: f.result ?? undefined
      }))
  }));
}
