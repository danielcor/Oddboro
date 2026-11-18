// The office clock. It keeps one timer, set for the soonest due job, poke,
// parked thread or window ask, and resets it whenever the jobs, pokes or
// threads table changes. A thread's hub parks it until a time (resume_at); the
// clock starts the hub's pick-up then. The usage window's ask leaves the desk
// at the window's reset if nobody answered it; it is raised with the hold it
// puts on a thread, so the threads table's change sets the timer for it.
// Every job run is told the scheduled time it is for (job-brief.ts). A job
// on time runs at once. One whose time passed while the Mac slept is settled
// by its kind (`dueNow` in the ledger's missed-runs.ts): a `latest` job
// catches up once if less than half a period passed since its
// newest missed time, else skips to its next time and waits on the desk's
// While you were away card; a `record` job owes a run for every missed
// period, or, past FILL_WITHOUT_ASKING of them, asks the owner first. Owed
// runs (`jobs.owed`) start one after another, never together, so waking
// after a week away is no burst. A poke that late is marked missed (see
// deliverPoke); a thread that late wakes then. While an update is about to
// install (`held()` in update.ts) it starts no scheduled job: a due one waits
// and runs once the app is back.
//
// A reader job (one whose files name an input) needs its writer's file for
// the period it runs for (`inputFor` in the ledger). While its writer still
// owes that period, the reader waits: it owes its own time instead, and gets
// in line again when the writer's run ends. When the writer skipped that
// period, the reader skips it too, and joins the While you were away card.
// While the writer's catch_up ask waits for the owner, the reader waits too;
// a no makes it skip, and the asks table's change makes it look again.
import {
  askToCatchUp,
  claimScheduledRun,
  clearAway,
  closeStaleRuns,
  dueNow,
  enabledJobs,
  finishRun,
  inputFor,
  job as jobById,
  nextRun,
  owe,
  parkedThreads,
  setNextRun,
  skip,
  skipOwed,
  startRun,
  takeOwed,
  waitingPokes,
  wakeThread,
  WINDOW_ASK_LAPSED,
  windowAsksDue,
  withdrawAsk,
  type JobRow,
  type RunTrigger
} from '@oddboro/ledger';
import { bus, listen, type OfficeEvent } from './events.ts';
import { deliverPoke, runJob } from './staff.ts';
import { held } from './update.ts';

// macOS stops timers while it sleeps, so the clock never waits longer than
// this before checking the time again. Each check is one comparison per job.
const LONGEST_WAIT_MS = 10 * 60_000;
/** After a look that failed, as when the database did not answer, the clock looks again this soon. */
const RETRY_MS = 30_000;

const g = globalThis as unknown as {
  jobClock?: {
    started?: true;
    timer?: ReturnType<typeof setTimeout>;
    line?: Promise<void>;
    revision?: number;
    stop?: () => void;
  };
};
const running = new Set<number>();
/** Jobs whose owed run waits in the line, so a second look adds none. */
const inLine = new Set<number>();
/** Jobs whose owed times the line is taking, for their readers to wait on. */
const taking = new Set<number>();

async function plan(): Promise<void> {
  const clock = g.jobClock;
  if (!clock?.started) return;
  const revision = (clock.revision = (clock.revision ?? 0) + 1);
  const now = new Date();
  let soonest = now.getTime() + LONGEST_WAIT_MS;
  try {
    for (const next of await lookAtJobs(now)) soonest = Math.min(soonest, next);
    for (const p of await waitingPokes()) {
      if (p.at <= now) void deliverPoke(p);
      else soonest = Math.min(soonest, p.at.getTime());
    }
    for (const t of await parkedThreads()) {
      // A failed wake leaves the time set, so the clock's next look tries again.
      if (t.resumeAt <= now)
        void wakeThread(t.id).catch((e: unknown) =>
          console.error(`Thread ${t.id} did not wake:`, e)
        );
      else soonest = Math.min(soonest, t.resumeAt.getTime());
    }
    for (const a of await windowAsksDue()) {
      // A failed withdrawal leaves the ask open, so the clock's next look tries again.
      if (a.at <= now)
        void withdrawAsk(a.id, WINDOW_ASK_LAPSED).catch((e: unknown) =>
          console.error(`The window ask ${a.id} did not leave the desk:`, e)
        );
      else soonest = Math.min(soonest, a.at.getTime());
    }
  } catch (e) {
    // Unhandled, the rejection would end the office, or leave no timer set so
    // no job ran again until a restart. What is due is unknown, so the clock
    // looks again soon, by its one timer.
    console.error(
      `The office clock could not look at what is due, so it looks again in ${RETRY_MS / 1000} seconds:`,
      e
    );
    soonest = Date.now() + RETRY_MS;
  }
  if (g.jobClock !== clock || clock.revision !== revision) return;
  clearTimeout(clock.timer);
  clock.timer = setTimeout(() => void plan(), Math.max(1000, soonest - Date.now()));
}

/**
 * The clock's look at the jobs at `now`: each one due starts or is settled,
 * and each owed run gets in line. Returns when each other job runs next, for
 * the timer.
 */
export async function lookAtJobs(now: Date): Promise<number[]> {
  const later: number[] = [];
  for (const j of await enabledJobs()) {
    if (j.owed?.length) getInLine(j.id);
    if (!j.nextRunAt) await setNextRun(j.id, nextRun(j.schedule, now));
    else if (j.nextRunAt > now) later.push(j.nextRunAt.getTime());
    else if (!held(now)) await settle(j, j.nextRunAt, now);
  }
  return later;
}

/**
 * A due job: on time it runs now; late, its kind says what happens
 * (`dueNow`). A reader on time first looks at its writer (`readerTurn`).
 */
async function settle(j: JobRow, was: Date, now: Date): Promise<void> {
  if (running.has(j.id)) return;
  const due = dueNow(j, was, now);
  const next = nextRun(j.schedule, now);
  if (due.do === 'run') {
    const turn = await readerTurn(j, was);
    if (turn.do === 'run') void start(j, 'schedule');
    else if (turn.do === 'skip') await skip(j, was, turn.away ? was : undefined, next);
    else if (await owe(j, was, [was], next)) getInLine(j.id);
  } else if (due.do === 'skip') await skip(j, was, due.at, next);
  else if (due.do === 'ask') await askToCatchUp(j, was, due.times, next);
  else if (await owe(j, was, due.times, next)) getInLine(j.id);
  // A writer that skipped or asked first ran nothing: its waiting readers look again.
  await readersGetInLine(j);
}

type Turn = { do: 'run' } | { do: 'wait' } | { do: 'skip'; away: boolean };

/**
 * What a reader does for the period `at`: run, wait for its writer, or skip
 * along with it. Any other job, and a reader whose input has a problem, runs:
 * the run itself fails with the problem.
 */
async function readerTurn(j: JobRow, at: Date): Promise<Turn> {
  const input = await inputFor(j, at, (id) => running.has(id) || taking.has(id));
  if (input && 'wait' in input) return { do: 'wait' };
  if (input && 'skip' in input) return { do: 'skip', away: input.away };
  return { do: 'run' };
}

/** Readers of this job's file that owe a run get in line, to look at it again. */
async function readersGetInLine(w: JobRow): Promise<void> {
  if (!w.files) return;
  const output = `${w.staffId}/${w.files.output}`;
  for (const r of await enabledJobs())
    if (r.owed?.length && r.files?.thread === w.files.thread && r.files.input === output)
      getInLine(r.id);
}

/** Every reader that owes a run gets in line, to look at its writer again. */
export async function readersLookAgain(): Promise<void> {
  for (const r of await enabledJobs()) if (r.owed?.length && r.files?.input) getInLine(r.id);
}

/**
 * Put a job's owed run in the office's one line: it starts once every run
 * ahead of it ended. When its turn comes during an update's hold, or while the
 * job runs already, its times stay owed for the clock's next look.
 */
function getInLine(id: number): void {
  if (inLine.has(id)) return;
  inLine.add(id);
  const clock = (g.jobClock ??= {});
  clock.line = (clock.line ?? Promise.resolve())
    .then(async () => {
      if (held(new Date()) || running.has(id)) return;
      const j = await jobById(id);
      if (!j?.enabled) return;
      // A reader goes by its newest owed period. Waiting leaves its times
      // owed; its writer's run ending brings it back.
      const newest = j.owed?.at(-1);
      if (j.files?.input && newest) {
        const turn = await readerTurn(j, new Date(newest));
        if (turn.do === 'wait') return;
        if (turn.do === 'skip') return skipOwed(id, new Date(newest), turn.away);
      }
      // Taken times are in no ledger row until the run starts: say it is busy.
      taking.add(id);
      try {
        const owed = await takeOwed(id);
        if (owed.length) await start(j, 'schedule', owed);
      } finally {
        taking.delete(id);
      }
    })
    .catch((e: unknown) => console.error(`Job ${id} did not catch up:`, e))
    .finally(() => inLine.delete(id));
}

/** Resolves once the line is empty, with any reader a run put back in it. For tests. */
export async function lineDone(): Promise<void> {
  let line: Promise<void> | undefined;
  do await (line = g.jobClock?.line);
  while (line !== g.jobClock?.line);
}

/**
 * Run a job. A run on time is for its scheduled time, and moves the schedule
 * on first, so a slow run never runs twice. A catch-up is for the `owed`
 * times, and its job moved on when they were owed. A manual one (Run now) is
 * for now, and leaves the schedule where it was.
 */
export async function start(j: JobRow, trigger: RunTrigger, owed?: Date[]): Promise<void> {
  if (running.has(j.id)) return;
  running.add(j.id);
  try {
    const now = new Date();
    const onTime = trigger === 'schedule' && !owed;
    const times = owed ?? [onTime && j.nextRunAt ? j.nextRunAt : now];
    // On time, the run claims its due time and moves the job on in one step,
    // so two looks at once start it once.
    const run = onTime ? await claimScheduledRun(j, now) : await startRun(j, trigger, times);
    if (!run) return;
    const r = await runJob(j, trigger, times).catch((e: unknown) => ({
      ok: false,
      text: e instanceof Error ? e.message : String(e),
      checked: undefined
    }));
    await finishRun(run, j, r.ok, r.text, r.checked);
  } finally {
    running.delete(j.id);
    // Readers waiting on this job's file look again.
    await readersGetInLine(j).catch((e: unknown) => console.error(`Job ${j.id}'s readers:`, e));
  }
}

/** Run now. It also takes the job off the desk's While you were away card. */
export async function runNow(id: number): Promise<void> {
  const j = await jobById(id);
  if (!j) return;
  await clearAway(id);
  void start(j, 'manual');
}

/** Start the clock once per process. */
export function startClock(): () => void {
  if (g.jobClock?.stop) return g.jobClock.stop;
  const changed = (e: OfficeEvent) => {
    if (e.type !== 'change') return;
    if (['jobs', 'pokes', 'threads'].includes(e.table)) void plan();
    // A no to a writer's catch_up ask changes no job: its waiting readers look again.
    else if (e.table === 'asks')
      void readersLookAgain().catch((e: unknown) => console.error('Readers did not look:', e));
  };
  const stop = () => {
    clearTimeout(g.jobClock?.timer);
    bus.off('event', changed);
    delete g.jobClock;
  };
  g.jobClock = { ...g.jobClock, started: true, stop, revision: 0 };
  listen();
  bus.on('event', changed);
  void closeStaleRuns()
    .catch((e: unknown) => console.error('Runs the office stopped mid-way stay marked running:', e))
    .then(plan);
  return stop;
}
