// Jobs and runs: an Odd's schedule, its own changes to its jobs and description,
// and what the office did.
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from './db.ts';
import { fixedError } from './errors.ts';
import { isOnThread, type Db } from './threads.ts';
import {
  asks,
  jobs,
  runs,
  staff,
  tasks,
  threads,
  followUps,
  type CheckedFiles,
  type JobFiles,
  type RunTrigger,
  type MissedRuns,
  type Schedule
} from './schema.ts';
import { catchUpAsks, ON_TIME_MS, type CatchUpAsk } from './missed-runs.ts';
import { MISSED_WORDS, nextRun, runTime, zone } from './time.ts';
import { taskSaid } from './desk-answers.ts';
import type { StaffRow, JobRow, RunRow } from './office.ts';
import { ofWorkingOdd, roster, staffer } from './office-staff.ts';
import { record } from './office-ledger.ts';
import { addReport } from './office-desk.ts';
import { ownerName } from './office-usage.ts';

// Jobs

export async function jobsFor(staffId: string): Promise<(JobRow & { lastRun?: RunRow })[]> {
  const list = await db
    .select()
    .from(jobs)
    .where(eq(jobs.staffId, staffId))
    .orderBy(asc(jobs.createdAt));
  return Promise.all(
    list.map(async (j) => {
      const [lastRun] = await db
        .select()
        .from(runs)
        .where(eq(runs.jobId, j.id))
        .orderBy(desc(runs.startedAt))
        .limit(1);
      return { ...j, lastRun };
    })
  );
}

export async function addJob(
  j: {
    staffId: string;
    name: string;
    instructions: string;
    schedule: Schedule;
    report?: boolean;
    missed?: MissedRuns;
    files?: JobFiles;
  },
  q: Db = db
): Promise<JobRow> {
  if (j.files) refuseFileCycle([...(await fileJobs(q)), { ...j, id: 0, files: j.files }]);
  const [row] = await q
    .insert(jobs)
    .values({ ...j, nextRunAt: nextRun(j.schedule, new Date()) })
    .returning();
  return row;
}

/** A job as the file check sees it: what it reads and what it writes. */
export type FileJob = Pick<JobRow, 'id' | 'name' | 'staffId' | 'files'>;

/** Every job, by what it reads and writes, for `refuseFileCycle`. */
export function fileJobs(q: Db = db): Promise<FileJob[]> {
  return q
    .select({ id: jobs.id, name: jobs.name, staffId: jobs.staffId, files: jobs.files })
    .from(jobs);
}

/**
 * A ring of jobs on one thread where each reads the next one's file, as the
 * owner reads it, or nothing. A reader waits for its writer's period, so in
 * a ring every job would wait for another and none would run.
 */
export function fileCycle(list: FileJob[]): string | undefined {
  const writers = new Map(
    list.flatMap((j) => (j.files ? [[`${j.files.thread}:${j.staffId}/${j.files.output}`, j]] : []))
  );
  const writerOf = (j: FileJob) =>
    j.files?.input ? writers.get(`${j.files.thread}:${j.files.input}`) : undefined;
  for (const first of list) {
    const chain: FileJob[] = [];
    let at: FileJob | undefined = first;
    while (at?.files?.input && !chain.includes(at)) {
      chain.push(at);
      at = writerOf(at);
    }
    if (!at || !chain.includes(at)) continue;
    const ring = chain.slice(chain.indexOf(at));
    const reads = ring.map(
      (j) => `"${j.name}" reads ${j.files!.input} from "${writerOf(j)!.name}"`
    );
    return `These jobs would each wait for another's file, so none would run: ${reads.join(', ')}. Change one job's files.`;
  }
}

/** Refuse a change to jobs' files that would leave them in a ring (`fileCycle`). */
export function refuseFileCycle(after: FileJob[]): void {
  const ring = fileCycle(after);
  if (ring) throw new Error(ring);
}

export async function updateJob(
  id: number,
  patch: Partial<
    Pick<JobRow, 'name' | 'instructions' | 'schedule' | 'enabled' | 'report' | 'missed' | 'files'>
  >,
  expectedFiles?: JobFiles,
  q: Db = db
): Promise<void> {
  if (patch.files)
    refuseFileCycle(
      (await fileJobs(q)).map((j) =>
        j.id === id ? { ...j, name: patch.name ?? j.name, files: patch.files! } : j
      )
    );
  const schedule = patch.schedule ?? (patch.enabled ? (await job(id, q))?.schedule : undefined);
  const rows = await q
    .update(jobs)
    .set({
      ...patch,
      changedAt: new Date(),
      ...(schedule ? { nextRunAt: nextRun(schedule, new Date()) } : {})
    })
    .where(and(eq(jobs.id, id), expectedFiles ? eq(jobs.files, expectedFiles) : undefined))
    .returning({ id: jobs.id });
  if (!rows.length) throw new Error('This job changed. Reopen it to see its files.');
}

/** A staffer changes one of its own jobs, carrying out a change the owner approved. */
/**
 * The owner's go-ahead for a staffer to change itself: their own words in a chat,
 * which the office hands the staffer's tools, or an ask the owner approved.
 */
export type GoAhead = { said: string } | { askId: number };

/** In a chat, the owner's words go in the ledger as their decision, beside the change. */
async function recordGoAhead(who: StaffRow, go: GoAhead, what: string, q: Db = db): Promise<void> {
  if ('said' in go)
    await record(
      {
        kind: 'decision',
        actor: 'owner',
        title: `Asked ${who.name} in chat: ${what}`,
        body: go.said
      },
      q
    );
}

export async function editOwnJob(
  staffId: string,
  name: string,
  patch: Partial<
    Pick<JobRow, 'name' | 'instructions' | 'schedule' | 'report' | 'missed' | 'files'>
  >,
  go: GoAhead,
  q: Db = db
): Promise<JobRow | undefined> {
  const who = await staffer(staffId, q);
  const [j, other] = await q
    .select()
    .from(jobs)
    .where(and(eq(jobs.staffId, staffId), eq(jobs.name, name)))
    .limit(2);
  if (other) throw new Error('Two jobs have that name. Rename one on the Odd’s card first.');
  if (!who || !j) return undefined;
  if (patch.files && !(await isOnThread(staffId, patch.files.thread, q)))
    throw new Error('This Odd has no assignment on that work.');
  await updateJob(j.id, patch, undefined, q);
  await recordGoAhead(who, go, `change its job "${name}"`, q);
  await record(
    {
      kind: 'work',
      actor: staffId,
      title: `Changed its job: ${patch.name ?? name}`,
      body: [
        patch.name && `Former name: ${name}`,
        patch.files && `Scheduled files: ${JSON.stringify(patch.files)}`,
        patch.instructions && `Steps:\n${patch.instructions}`,
        patch.schedule && `Schedule: ${JSON.stringify(patch.schedule)}`,
        patch.report !== undefined &&
          `Reports to ${await ownerName(q)}: ${patch.report ? 'yes' : 'no'}`,
        patch.missed && `Missed runs: ${MISSED_WORDS[patch.missed]}`
      ]
        .filter(Boolean)
        .join('\n\n'),
      askId: 'askId' in go ? go.askId : undefined
    },
    q
  );
  return job(j.id, q);
}

/**
 * A job description save that stopped because the text changed since the
 * editor read it. `current` is the text there now, so the editor can start
 * again from it.
 */
export class DescriptionChanged extends Error {
  readonly current: string;
  constructor(message: string, current: string) {
    super(message);
    this.current = current;
  }
}

/**
 * Rewrite a staffer's job description, the text every run starts from. The owner
 * does it from the card, or the staffer does with their go-ahead. `was` is the
 * text the editor started from: the owner's when they opened it, the staffer's
 * when its run began. If it changed since, the save stops with
 * `DescriptionChanged` instead of overwriting someone else's edit. The ledger
 * keeps the old and new versions.
 */
export async function setDescription(
  staffId: string,
  text: string,
  by: ({ owner: true } | { go: GoAhead }) & { was: string }
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Read the version this save will replace, even if another edit is finishing.
    const [who] = await tx
      .select()
      .from(staff)
      .where(and(eq(staff.id, staffId), isNull(staff.leftAt)))
      .for('update');
    if (!who) throw fixedError('No such Odd');
    const desk = text.trim();
    if (!desk) throw fixedError('A job description cannot be empty');
    if (by.was.trim() !== who.desk.trim())
      throw new DescriptionChanged(
        `${who.name}'s job description changed since you opened it. Reopen it to see.`,
        who.desk
      );
    if (desk === who.desk.trim()) return false;
    await tx.update(staff).set({ desk }).where(eq(staff.id, staffId));
    if ('go' in by) await recordGoAhead(who, by.go, 'rewrite its job description', tx);
    await record(
      {
        kind: 'work',
        actor: 'owner' in by ? 'owner' : staffId,
        title:
          'owner' in by ? `Edited ${who.name}'s job description` : 'Rewrote its job description',
        body: `Before:\n${who.desk}\n\nAfter:\n${desk}`,
        askId: 'go' in by && 'askId' in by.go ? by.go.askId : undefined
      },
      tx
    );
    return true;
  });
}

/** Remove a job that never ran. One that ran stays, paused, so its runs keep their record. */
export async function deleteJob(id: number): Promise<void> {
  const [ran] = await db.select({ id: runs.id }).from(runs).where(eq(runs.jobId, id)).limit(1);
  if (ran) throw fixedError('This job has run before, so it stays paused to keep its record.');
  await db.delete(jobs).where(eq(jobs.id, id));
}

export async function enabledJobs(): Promise<JobRow[]> {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.enabled, true), ofWorkingOdd(jobs.staffId)));
}

export async function job(id: number, q: Db = db): Promise<JobRow | undefined> {
  const [row] = await q.select().from(jobs).where(eq(jobs.id, id));
  return row;
}

export async function setNextRun(id: number, at: Date): Promise<void> {
  await db.update(jobs).set({ nextRunAt: at }).where(eq(jobs.id, id));
}

/** Claim this due time once, even if two looks by the clock overlapped. The run is for that time. */
export async function claimScheduledRun(j: JobRow, now: Date): Promise<RunRow | undefined> {
  const dueAt = j.nextRunAt;
  if (!dueAt || dueAt > now) return undefined;
  return db.transaction(async (tx) => {
    const [due] = await tx
      .update(jobs)
      .set({ nextRunAt: nextRun(j.schedule, now) })
      .where(
        and(
          eq(jobs.id, j.id),
          eq(jobs.enabled, true),
          eq(jobs.nextRunAt, dueAt),
          eq(sql`date_trunc('milliseconds', ${jobs.changedAt})`, j.changedAt.toISOString())
        )
      )
      .returning({ id: jobs.id });
    if (due) return startRun(j, 'schedule', [dueAt], tx);
  });
}

/**
 * Where a reader job's input stands for the period `at`. The reader takes the
 * file its writer's last run for a period at or before `at` wrote, by the
 * run, never by whether the file changed: the same bytes as last period are
 * as good as new ones. The answer is one of:
 * - `run` and `sha256`: that run wrote the file, and the reader gets those bytes.
 * - `wait`: the writer still owes that period (running, due, or caught up later).
 * - `skip`: the writer skipped that period, or has not written a first one.
 *   `away` puts the reader's skip on the desk's While you were away card.
 * - `problem`: the writer ran for that period and left no checked file, or
 *   the job's files are not set up. The reader's run fails with it.
 * `busy` says the writer runs now, before its run is in the ledger.
 * `asked` are the writer's catch_up asks: an open one's times are owed until
 * the owner answers, and a refused one's were skipped.
 */
export type ScheduledInput =
  | { run: number; sha256: string }
  | { wait: string }
  | { skip: string; away: boolean }
  | { problem: string };

export function scheduledInput(
  j: JobRow,
  jobs: JobRow[],
  writerRuns: RunRow[],
  at: Date,
  busy: (jobId: number) => boolean = () => false,
  asked: CatchUpAsk[] = []
): ScheduledInput | undefined {
  if (!j.files?.input) return undefined;
  const input = j.files.input;
  const writers = jobs.filter(
    (w) => w.files?.thread === j.files?.thread && `${w.staffId}/${w.files?.output}` === input
  );
  if (writers.length !== 1 || writers[0].id === j.id)
    return { problem: `Assign one other scheduled job to write ${input}.` };
  const w = writers[0];
  if (!w.enabled)
    return { problem: `"${w.name}" is paused, so nothing writes ${input}. Turn it back on.` };
  const ran = writerRuns.filter(
    (r) => r.jobId === w.id && r.startedAt >= w.changedAt && r.checkedFiles?.periods.length
  );
  if (
    busy(w.id) ||
    ran.some(
      (r) => r.status === 'running' && r.checkedFiles!.periods.some((p) => new Date(p) <= at)
    ) ||
    (w.nextRunAt && w.nextRunAt <= at) ||
    w.owed?.some((t) => new Date(t) <= at)
  )
    return { wait: `Waiting for "${w.name}" to write ${input} for this period.` };
  // The writer's last run for a period at or before `at` wrote the bytes on
  // disk, even when an earlier run was for a newer period, as a catch-up of
  // older periods after a normal cycle is. `newest` is the newest period at
  // or before `at` that any run was for: the writer covered up to there.
  let best: RunRow | undefined;
  let newest: Date | undefined;
  for (const r of ran)
    for (const p of r.checkedFiles!.periods) {
      const period = new Date(p);
      if (period > at) continue;
      if (!best || r.id > best.id) best = r;
      if (!newest || period > newest) newest = period;
    }
  // A missed time the writer's catch_up ask names, newer than that period.
  const askedFor = (open: boolean) =>
    asked.some(
      (a) =>
        a.open === open &&
        a.times.some((t) => new Date(t) <= at && (!newest || new Date(t) > newest))
    );
  if (askedFor(true))
    return {
      wait: `Waiting for your answer on filling "${w.name}"'s missed periods, then for its ${input}.`
    };
  if (askedFor(false))
    return {
      skip: `You said no to filling "${w.name}"'s missed periods, so "${j.name}" skips this period too.`,
      away: true
    };
  const skipped = w.skippedAt && w.skippedAt <= at && (!newest || w.skippedAt > newest);
  if (skipped)
    return {
      skip: `"${w.name}" skipped its run for ${runTime(w.skippedAt!)}, so "${j.name}" skips this period too.`,
      away: true
    };
  if (!best || !newest)
    return { skip: `Waiting for "${w.name}" to write ${input} for the first time.`, away: false };
  // A time the writer's schedule had after that period, and before `at`, that
  // it neither ran nor owes: it skipped it, or its missed periods wait for the
  // owner's yes. A schedule in minutes counts from when each run started, so
  // give it the clock's on-time margin.
  const after = nextRun(w.schedule, newest).getTime();
  if (after + (w.schedule.every === 'minutes' ? ON_TIME_MS : 0) <= at.getTime())
    return {
      skip: `"${w.name}" did not run for ${runTime(new Date(after))}, so "${j.name}" skips this period too.`,
      away: true
    };
  const sha256 = best.status === 'done' ? best.checkedFiles!.sha256 : undefined;
  if (!sha256)
    return {
      problem: `"${w.name}" ran for ${runTime(new Date(best.checkedFiles!.periods.filter((p) => new Date(p) <= at).at(-1)!))} and left no checked ${input}. Check its last result before "${j.name}" runs again.`
    };
  return { run: best.id, sha256 };
}

/** The newest runs of a file job since it last changed, newest first: what each was for and left. */
export function fileRuns(j: JobRow, limit = 50): Promise<RunRow[]> {
  return db
    .select()
    .from(runs)
    .where(
      and(eq(runs.jobId, j.id), isNotNull(runs.checkedFiles), gte(runs.startedAt, j.changedAt))
    )
    .orderBy(desc(runs.id))
    .limit(limit);
}

/** The job that writes this reader's input, among the jobs that are on. */
export function writerOf(j: JobRow, on: JobRow[]): JobRow | undefined {
  const input = j.files?.input;
  if (!input) return undefined;
  return on.find(
    (w) =>
      w.id !== j.id &&
      w.files?.thread === j.files?.thread &&
      `${w.staffId}/${w.files?.output}` === input
  );
}

/** Where a reader's input stands for the period `at` (`scheduledInput`), from the ledger. */
export async function inputFor(
  j: JobRow,
  at: Date,
  busy?: (jobId: number) => boolean
): Promise<ScheduledInput | undefined> {
  if (!j.files?.input) return undefined;
  const on = await enabledJobs();
  const w = writerOf(j, on);
  return scheduledInput(
    j,
    [j, ...on.filter((o) => o.id !== j.id)],
    w ? await fileRuns(w) : [],
    at,
    busy,
    w ? await catchUpAsks(w.id) : []
  );
}

export function latestScheduledRuns(ids: number[], checked = false): Promise<RunRow[]> {
  return db
    .selectDistinctOn([runs.jobId])
    .from(runs)
    .where(
      and(
        inArray(runs.jobId, ids),
        eq(runs.trigger, 'schedule'),
        checked ? sql`${runs.checkedFiles}->>'sha256' is not null` : undefined
      )
    )
    .orderBy(runs.jobId, desc(runs.id));
}

/**
 * A job's run starts, for the scheduled `times` (Run now's is now). A file
 * job's run keeps them in `checked_files` from the start, so a run that never
 * finishes still shows which period it left without a file.
 */
export async function startRun(
  j: JobRow,
  trigger: RunTrigger,
  times: Date[] = [new Date()],
  q: Db = db
): Promise<RunRow> {
  const [row] = await q
    .insert(runs)
    .values({
      jobId: j.id,
      staffId: j.staffId,
      trigger,
      checkedFiles: j.files
        ? { periods: times.map((t) => t.toISOString()), output: `${j.staffId}/${j.files.output}` }
        : null
    })
    .returning();
  return row;
}

export async function finishRun(
  r: RunRow,
  j: JobRow,
  ok: boolean,
  summary: string,
  checked?: Omit<CheckedFiles, 'periods'>
): Promise<void> {
  // The periods stay as the run started; the check adds what it wrote.
  const checkedFiles = r.checkedFiles && checked ? { ...r.checkedFiles, ...checked } : undefined;
  await db.transaction(async (tx) => {
    const [finished] = await tx
      .update(runs)
      .set({ status: ok ? 'done' : 'failed', summary, checkedFiles, finishedAt: new Date() })
      .where(and(eq(runs.id, r.id), eq(runs.status, 'running')))
      .returning({ id: runs.id });
    if (!finished) return;
    // A repeated block stays in the run history. Put the repair on the desk once.
    if (j.files && !ok && r.trigger === 'schedule') {
      const [prior] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.jobId, j.id), eq(runs.trigger, 'schedule'), lt(runs.id, r.id)))
        .orderBy(desc(runs.id))
        .limit(1);
      if (prior?.status !== 'failed' || prior.summary !== summary) {
        await addReport(j.staffId, `Blocked: ${j.name}`, summary, r.id, tx);
        return;
      }
    }
    if (ok && j.report) await addReport(j.staffId, j.name, summary, r.id, tx);
    else
      await record(
        {
          kind: 'work',
          actor: j.staffId,
          title: `${ok ? 'Ran' : 'Failed'}: ${j.name}${r.trigger === 'manual' ? ` (started by ${await ownerName(tx)})` : ''}`,
          body: summary,
          runId: r.id
        },
        tx
      );
  });
}

/** Runs that a restart left marked running. */
export async function closeStaleRuns(): Promise<void> {
  await db
    .update(runs)
    .set({
      status: 'failed',
      summary: 'The office stopped while this ran.',
      finishedAt: new Date()
    })
    .where(eq(runs.status, 'running'));
}

/** "Fri, Oct 30, 7:00 AM": the office's own clock, so a schedule reads as written. */
const pt = (d: Date | string | null) =>
  d
    ? new Date(d).toLocaleString('en-US', {
        timeZone: zone(),
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : null;

/** What the whole office did since a time: Marshall's daily report reads this. */
export async function officeActivity(since: Date) {
  const [people, ranJobs, openAsks, decided, openTasks, doneTasks, follow] = await Promise.all([
    roster(),
    db
      .select({
        staff: runs.staffId,
        job: jobs.name,
        status: runs.status,
        trigger: runs.trigger,
        summary: runs.summary,
        checkedFiles: runs.checkedFiles,
        at: runs.startedAt
      })
      .from(runs)
      .innerJoin(jobs, eq(runs.jobId, jobs.id))
      .where(gte(runs.startedAt, since))
      .orderBy(asc(runs.startedAt)),
    db.select().from(asks).where(eq(asks.status, 'open')),
    db.select().from(asks).where(gte(asks.decidedAt, since)),
    db.select().from(tasks).where(eq(tasks.status, 'open')),
    db.select().from(tasks).where(gte(tasks.doneAt, since)),
    db
      .select({
        staff: followUps.staffId,
        kind: followUps.kind,
        ask: asks.title,
        task: tasks.title,
        handOff: followUps.handOff,
        thread: threads.title,
        outcome: followUps.outcome,
        at: followUps.createdAt
      })
      .from(followUps)
      .leftJoin(asks, eq(followUps.askId, asks.id))
      .leftJoin(tasks, eq(followUps.taskId, tasks.id))
      .leftJoin(threads, eq(followUps.threadId, threads.id))
      .where(gte(followUps.createdAt, since))
  ]);
  const allJobs = await db.select().from(jobs).where(eq(jobs.enabled, true));
  const fileJobs = allJobs.filter((j) => j.files).map((j) => j.id);
  const [latest, verified] = fileJobs.length
    ? await Promise.all([latestScheduledRuns(fileJobs), latestScheduledRuns(fileJobs, true)])
    : [[], []];
  const now = new Date();
  // Each reader's input for a run now, by the period its writer last ran for.
  const inputs = new Map(
    await Promise.all(
      allJobs
        .filter((j) => j.files?.input)
        .map(async (j) => {
          const w = writerOf(j, allJobs);
          const [ran, asked] = w ? await Promise.all([fileRuns(w), catchUpAsks(w.id)]) : [[], []];
          return [j.id, scheduledInput(j, allJobs, ran, now, undefined, asked)] as const;
        })
    )
  );
  return {
    since: pt(since),
    now: pt(new Date()),
    staff: people.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      jobs: allJobs
        .filter((j) => j.staffId === p.id)
        .map((j) => {
          const base = { name: j.name, schedule: j.schedule, next: pt(j.nextRunAt) };
          if (!j.files) return { ...base, state: 'configured', lastVerified: null };
          const last = latest.find((r) => r.jobId === j.id && r.startedAt >= j.changedAt);
          const checked = verified.find((r) => r.jobId === j.id && r.startedAt >= j.changedAt);
          const source = inputs.get(j.id);
          const waiting =
            source && ('wait' in source ? source.wait : 'skip' in source && source.skip);
          const repair =
            last?.status === 'failed'
              ? last.summary
              : source && 'problem' in source
                ? source.problem
                : undefined;
          const current =
            !!last?.checkedFiles?.sha256 &&
            j.nextRunAt &&
            j.nextRunAt > now &&
            (!source || ('run' in source && source.run === last.checkedFiles.inputRun));
          return {
            ...base,
            state: repair ? 'blocked' : current ? 'verified files' : 'configured',
            ...(repair ? { repair } : waiting ? { waiting } : {}),
            lastVerified: checked ? { at: pt(checked.finishedAt), ...checked.checkedFiles } : null
          };
        }),
      runs: ranJobs
        .filter((r) => r.staff === p.id)
        .map((r) => ({
          job: r.job,
          status: r.status,
          // 'manual' means the owner pressed Run now; only 'schedule' runs follow the timer.
          trigger: r.trigger,
          at: pt(r.at),
          checkedFiles: r.checkedFiles,
          summary: r.summary?.slice(0, 600)
        }))
    })),
    asks: {
      open: openAsks.map((a) => ({ from: a.staffId, title: a.title, since: pt(a.createdAt) })),
      decided: decided.map((a) => ({
        from: a.staffId,
        title: a.title,
        status: a.status,
        reason: a.reason
      }))
    },
    // Work owed after the owner answered: carrying out an approved ask, reworking one
    // the owner sent back, or picking up after a task they finished. A hand_off is
    // work a colleague handed this staffer, handed_back is the colleague's result
    // coming home, and resume is a thread's hub picking it back up. A null outcome
    // is still to do.
    followUps: follow.map((f) => ({
      from: f.staff,
      kind: f.kind,
      about: f.ask ?? f.task ?? f.handOff?.title ?? f.thread,
      ...(f.handOff ? { colleague: f.handOff.from } : {}),
      outcome: f.outcome,
      at: pt(f.at)
    })),
    tasksForOwner: {
      open: openTasks.map((t) => ({ from: t.staffId, title: t.title, since: pt(t.createdAt) })),
      done: doneTasks.map((t) => {
        const said = taskSaid(t);
        return {
          from: t.staffId,
          title: t.title,
          status: t.status,
          ...(said ? { answer: said } : {})
        };
      })
    }
  };
}
