// Follow-up runs: adding, claiming, finishing and naming them, and holding one
// while its Odd still runs on the thread.
import { runsGoing } from './run-registry.ts';
import {
  and,
  arrayOverlaps,
  asc,
  eq,
  exists,
  isNotNull,
  isNull,
  ne,
  not,
  or,
  sql,
  type SQL
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from './db.ts';
import type { Db } from './threads.ts';
import { tasks, threads, followUps, goals, type InChat, type Outcome } from './schema.ts';
import type { AskRow, TaskRow } from './office.ts';
import { ofWorkingOdd } from './office-staff.ts';
import { ask } from './office-asks.ts';
import { task } from './office-tasks.ts';
import { transitionWork } from './work/apply.ts';
import type { LiveKind } from './work/events.ts';
import { queuedRows } from './work/load.ts';
import { CUT_OFF_RESULT, CUT_OFF_WORK, OUTCOME_TITLE } from './work/runs.ts';
import { followUpRow } from './work/state.ts';

/** The run words live with the run's deciders; kept here too for this file's importers. */
export { CUT_OFF_RESULT, CUT_OFF_WORK, OUTCOME_TITLE };

// Follow-ups: work a staffer owes once the owner answers it or finishes a task it
// gave them. The office starts each one as soon as it is written.

export type FollowUpRow = typeof followUps.$inferSelect;

async function followUp(
  staffId: string,
  kind: LiveKind,
  f: {
    askId?: number;
    taskId?: number;
    note: string | null;
    pickedUp?: string[];
    reportWhenDone?: boolean;
    /** The owner answered in a chat: a run in that Odd's chat replies there too. */
    chat?: InChat;
  },
  q: Db = db
): Promise<void> {
  const { chat, ...run } = f;
  // A caller's transaction owns the commit: the run goes in with the rest of its writes.
  await transitionWork(
    { kind: 'runQueued', run: { staffId, kind, ...run }, ...(chat && { chat }) },
    'rollback' in q ? { tx: q } : {}
  );
}

/**
 * A new hire's first day: right after it says hello, a hire with a job starts
 * its work. Its result goes on the owner's desk, so they see the first piece
 * of work. A hire with no job gets none (`firstDay` in the office decides): one
 * that serves a goal gets its first piece from the goal's lead, on the goal's
 * thread, and any other runs only when handed work.
 */
export async function startFirstDay(staffId: string): Promise<void> {
  await transitionWork({
    kind: 'runQueued',
    run: { staffId, kind: 'first_day', note: null, reportWhenDone: true }
  });
}

/**
 * Follow-ups ready to start, by id, with the ask, task, goal or thread
 * each is about. Not the rows: a run takes its row from the claim
 * (`startFollowUp`), with any answer that joined it since this list.
 */
export async function followUpsToDo(): Promise<
  {
    id: number;
    ask?: AskRow;
    task?: TaskRow;
    goal?: typeof goals.$inferSelect;
  }[]
> {
  const rows = await db
    .select()
    .from(followUps)
    .where(and(queuedRows, not(waitsOnOwnRun()), ofWorkingOdd(followUps.staffId)))
    .orderBy(asc(followUps.createdAt));
  return Promise.all(
    rows.map(async (f) => {
      const a = f.askId ? await ask(f.askId) : undefined;
      // The owner's answer to a plan, or to a hire it proposed, is about the plan's goal.
      const goalId = f.goalId ?? a?.plan?.goalId ?? a?.hire?.goal?.id;
      return {
        id: f.id,
        ask: a,
        task: f.taskId
          ? (await db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]
          : undefined,
        goal: goalId ? (await db.select().from(goals).where(eq(goals.id, goalId)))[0] : undefined
      };
    })
  );
}

/**
 * Follow-ups of Odds still in the office that have yet to start, oldest
 * first. One waits while a run of its Odd on the same work goes
 * (`waitsOnOwnRun`), such as the chat that gave the owner the task it picks
 * up after; any other starts at the office's next look. The office lists them
 * under In progress, so work the owner's answer started shows while it waits.
 */
export async function followUpsToStart(): Promise<FollowUpRow[]> {
  return db
    .select()
    .from(followUps)
    .where(and(queuedRows, ofWorkingOdd(followUps.staffId)))
    .orderBy(asc(followUps.createdAt), asc(followUps.id));
}

/**
 * An Odd runs once at a time on a thread: a follow-up on one waits while a run
 * of the same Odd there has yet to end. So a hub never picks its thread up
 * twice at once, and a colleague's run on the owner's answer starts only once
 * the run that raised it ended. Answers that come meanwhile join the waiting
 * `resume` (`answerLead`), and results the waiting `handed_back`
 * (`resultsToJoin`); the run ending starts it. A hand-off is new work, not a
 * pick-up, so several may run side by side, even for one colleague. A run on
 * no thread, such as a chat, a job or a follow-up like a carry-out, counts on
 * each thread it put work on, a hand-off held or not or a goal's plan
 * (`threads.runs`, `keepRun` in work/hand-offs.ts), while its key is in `runsGoing`.
 */
function waitsOnOwnRun(): SQL {
  const busy = alias(followUps, 'busy');
  const ownRun = db
    .select({ id: busy.id })
    .from(busy)
    .where(
      and(
        eq(busy.staffId, followUps.staffId),
        eq(busy.threadId, followUps.threadId),
        isNotNull(busy.startedAt),
        isNull(busy.outcome)
      )
    );
  // With no run going there is no key to look for, and drizzle refuses an empty list.
  const held = runsGoing.size
    ? or(
        exists(ownRun),
        exists(
          db
            .select({ id: threads.id })
            .from(threads)
            .where(
              and(
                eq(threads.id, followUps.threadId),
                eq(threads.hubId, followUps.staffId),
                arrayOverlaps(threads.runs, [...runsGoing.keys()])
              )
            )
        )
      )
    : exists(ownRun);
  // Bracketed, since callers negate it.
  return sql`(${ne(followUps.kind, 'hand_off')} and (${held}))`;
}

/** The wait a lead's run ended as it started: the task's title, or the time it was parked until. */
export type Unparked = { task: string } | { at: Date };

/**
 * Claim a follow-up (`runClaimed`), and return it as claimed: an answer that
 * joined it after it was listed is in its note (`answerLead`). Undefined
 * when it already started or ended, such as one its Odd's leaving failed, or
 * it waits on a run of its Odd's own (`waitsOnOwnRun`).
 *
 * A thread stays parked only while no run of its lead's on it has started
 * since it parked, so the claim of one ends the park, and returns the wait it
 * ended for the run's brief (`unparked`). Without it, work a hand-back or the
 * owner's words picked up stayed parked on a task that might never end, and
 * that task's end woke the finished work again. A colleague's run leaves the
 * lead's park alone, and so does a usage-window hold, which is the office's.
 * The claimed row keeps the task or time it lifted (`unparkedTask`,
 * `unparkedAt`), so a run that then fails gives that wait back (`finishFollowUp`).
 */
export async function startFollowUp(
  id: number
): Promise<(FollowUpRow & { unparked?: Unparked }) | undefined> {
  const decided = await transitionWork({ kind: 'runClaimed', id });
  if (!('change' in decided)) return undefined;
  const { run, unparked } = decided.change.result;
  return { ...followUpRow(run), kind: run.kind, ...(unparked && { unparked }) };
}

/**
 * Record how a follow-up ended, once (`runFinished`). `joined` are the
 * results this run picked up with its own (`resultsToJoin`): they end with
 * it. True when this call wrote the outcome, false when one was written
 * already.
 */
export async function finishFollowUp(
  f: FollowUpRow,
  about: string,
  outcome: Outcome,
  result: string,
  o: { joined?: number[] } = {}
): Promise<boolean> {
  const decided = await transitionWork({
    kind: 'runFinished',
    id: f.id,
    about,
    ended: { outcome, result, joined: o.joined ?? [] }
  });
  return 'change' in decided;
}

/**
 * Follow-ups a restart cut off mid-run. They fail rather than run twice.
 * Returns those this closed, so the office can say so where each began.
 */
export async function closeStaleFollowUps(): Promise<FollowUpRow[]> {
  const stale = await db
    .select()
    .from(followUps)
    .where(and(isNotNull(followUps.startedAt), isNull(followUps.outcome)));
  const closed: FollowUpRow[] = [];
  for (const f of stale) {
    const decided = await transitionWork({
      kind: 'staleRunsClosed',
      id: f.id,
      about: await workTitle(f)
    });
    if ('change' in decided) closed.push(f);
  }
  return closed;
}

/**
 * What the Ledger names the work a follow-up was about, whether it finished or
 * a restart cut it off: its ask's, hand-off's, file's, task's or goal's
 * title. A lead picking a thread back up names its goal, or the
 * thread's own title when it serves none, never the thread itself. With no
 * title left, its kind's plain words (`CUT_OFF_WORK`).
 */
export async function workTitle(f: FollowUpRow): Promise<string> {
  return (await titleOf(f)) ?? CUT_OFF_WORK[f.kind];
}

async function titleOf(f: FollowUpRow): Promise<string | undefined> {
  if (f.askId) return (await ask(f.askId))?.title;
  if (f.handOff) return f.handOff.title;
  if (f.edit) return f.edit.path;
  if (f.taskId) return (await task(f.taskId))?.title;
  if (f.goalId)
    return (await db.select({ title: goals.title }).from(goals).where(eq(goals.id, f.goalId)))[0]
      ?.title;
  if (f.kind === 'resume' && f.threadId) {
    const [t] = await db
      .select({ goal: goals.title, title: threads.title })
      .from(threads)
      .leftJoin(goals, eq(goals.id, threads.goalId))
      .where(eq(threads.id, f.threadId));
    return t?.goal ?? t?.title;
  }
  return undefined;
}

export { followUp };
