// Goals: what the owner wants more of. The owner sets one, or approves one the
// Office Manager heard in chat, and the manager plans it: one ask holding the
// hires and the work staff already here take on. A staffer serves the goals it
// is linked to, sees only those, and says how each is going, as does the Odd
// leading a goal's thread, which plans it before anyone serves it.
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './db.ts';
import { fixedError } from './errors.ts';
import {
  addJob,
  fileJobs,
  refuseFileCycle,
  approveAsk,
  ask,
  editOwnJob,
  giveTask,
  ownerName,
  raiseAsk,
  record,
  roster,
  staffer,
  type AskRow,
  type StaffRow
} from './office.ts';
import {
  goalProgress,
  goals,
  jobs,
  staff,
  staffGoals,
  threads,
  type GoalDraft,
  type GoalHealth,
  type GoalPlanItem,
  type GoalStatus,
  type JobFiles
} from './schema.ts';
import { MANAGER_ROLE, goalReview } from './managers.ts';
import { HORIZONS } from './goal-words.ts';
import { goalThreads, type Db, type Tx, type GoalThread } from './threads.ts';
import { transitionWork } from './work/apply.ts';
import { GOAL_SET } from './work/asks.ts';

export type GoalRow = typeof goals.$inferSelect;
export type ProgressRow = typeof goalProgress.$inferSelect;
export type GoalView = GoalRow & {
  staff: { staffId: string; name: string; part: string }[];
  /** Newest first. */
  progress: (ProgressRow & { name: string })[];
};

const REVIEW_JOB = 'Weekly goal review';

/** A goal as written, cleaned, or why it is not one. */
export function goalDraft(v: Partial<Record<keyof GoalDraft, unknown>>): GoalDraft | string {
  const text = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  const title = text(v.title, 140);
  if (!title) return 'Say what the goal is';
  const horizon = HORIZONS.find((h) => h.id === v.horizon)?.id ?? 'ongoing';
  const due = text(v.due, 10);
  if (horizon === 'date' && !/^\d{4}-\d\d-\d\d$/.test(due)) return 'Pick the date it is for';
  return {
    title,
    why: text(v.why, 1000) || undefined,
    doneWhen: text(v.doneWhen, 1000) || undefined,
    horizon,
    due: horizon === 'date' ? due : undefined,
    area: text(v.area, 40).toLowerCase() || 'work'
  };
}

export async function goal(id: number, q: Db = db): Promise<GoalRow | undefined> {
  const [row] = await q.select().from(goals).where(eq(goals.id, id));
  return row;
}

/** Goals with who serves each and the newest progress, active first. */
async function views(rows: GoalRow[], progressPerGoal = 6): Promise<GoalView[]> {
  if (!rows.length) return [];
  const ids = rows.map((g) => g.id);
  const names = new Map((await roster()).map((s) => [s.id, s.name]));
  const links = await db.select().from(staffGoals).where(inArray(staffGoals.goalId, ids));
  const lines = await db
    .select()
    .from(goalProgress)
    .where(inArray(goalProgress.goalId, ids))
    .orderBy(desc(goalProgress.createdAt));
  const order: Record<GoalStatus, number> = { active: 0, paused: 1, met: 2, dropped: 3 };
  return rows
    .map((g) => ({
      ...g,
      staff: links
        .filter((l) => l.goalId === g.id && names.has(l.staffId))
        .map((l) => ({ staffId: l.staffId, name: names.get(l.staffId)!, part: l.part })),
      progress: lines
        .filter((p) => p.goalId === g.id)
        .slice(0, progressPerGoal)
        .map((p) => ({ ...p, name: names.get(p.staffId) ?? p.staffId }))
    }))
    .sort((a, b) => order[a.status] - order[b.status] || a.id - b.id);
}

/** Every goal, for the owner and the Office Manager. */
export async function allGoals(): Promise<GoalView[]> {
  return views(await db.select().from(goals));
}

/** A goal as the owner's Goals window shows it, with its threads, newest first. */
export type GoalWithThreads = GoalView & { threads: GoalThread[] };

/**
 * The owner's Goals window: every goal with its threads, and other work, the
 * threads for no goal that are still under way or waiting on the owner, so
 * all work in flight shows in one place.
 */
export type GoalsWindow = { goals: GoalWithThreads[]; other: GoalThread[] };

/**
 * The Goals window, for the owner only: an Odd's goals (`goalsFor`) leave the
 * threads out, so its runs never pay for them.
 */
export async function goalsWindow(): Promise<GoalsWindow> {
  const [rows, all] = await Promise.all([allGoals(), goalThreads()]);
  return {
    goals: rows.map((g) => ({ ...g, threads: all.filter((t) => t.goalId === g.id) })),
    other: all.filter(
      (t) => t.goalId === null && (t.stage === 'under_way' || t.stage === 'waiting_on_you')
    )
  };
}

/** The goals one staffer serves, and only those. */
export async function goalsFor(staffId: string): Promise<(GoalView & { part: string })[]> {
  const links = await db.select().from(staffGoals).where(eq(staffGoals.staffId, staffId));
  if (!links.length) return [];
  const rows = await db
    .select()
    .from(goals)
    .where(
      inArray(
        goals.id,
        links.map((l) => l.goalId)
      )
    );
  return (await views(rows)).map((g) => ({
    ...g,
    part: links.find((l) => l.goalId === g.id)!.part
  }));
}

/** The office's manager, if it has one. `q` reads it inside a transaction. */
export async function manager(q: Db = db): Promise<StaffRow | undefined> {
  const [m] = await q
    .select()
    .from(staff)
    .where(and(eq(staff.role, MANAGER_ROLE), isNull(staff.leftAt)))
    .orderBy(asc(staff.hiredAt))
    .limit(1);
  return m;
}

/**
 * Set a goal: the owner wrote it, or approved one the manager proposed. The
 * manager then plans it, and reviews every goal once a week from the first one.
 */
export async function addGoal(d: GoalDraft, source?: number | ChatGoalRequest): Promise<GoalRow> {
  return db.transaction(async (tx) => {
    const { row, planner } = await setGoal(tx, d, source);
    if (planner) {
      // Queuing a run leaves nothing for after the commit (`runQueued`).
      const went = await transitionWork(
        {
          kind: 'runQueued',
          run: { staffId: planner.id, kind: 'goal', goalId: row.id, note: null },
          opens: { title: row.title }
        },
        { tx }
      );
      if ('refused' in went) throw new Error(went.refused);
    }
    return row;
  });
}

type ChatGoalRequest = { managerId: string; requestId: string };

export class GoalRequestConflict extends Error {}

/**
 * The goal's row, its line and the manager's weekly review. `planner` is the
 * manager who plans a goal this call set, and none for a chat submission's
 * repeat, which set it already.
 */
async function setGoal(
  tx: Tx,
  d: GoalDraft,
  source?: number | ChatGoalRequest
): Promise<{ row: GoalRow; planner?: StaffRow }> {
  const chat = typeof source === 'object' ? source : undefined;
  const askId = typeof source === 'number' ? source : undefined;
  const m = await manager(tx);
  if (chat && chat.managerId !== m?.id)
    throw new GoalRequestConflict('Open the current Office Manager to set this goal.');
  const [row] = await tx
    .insert(goals)
    .values({ ...d, requestId: chat?.requestId })
    .onConflictDoNothing({ target: goals.requestId })
    .returning();
  if (!row && chat) {
    const [saved] = await tx.select().from(goals).where(eq(goals.requestId, chat.requestId));
    if (saved?.title === d.title) return { row: saved };
    throw new GoalRequestConflict('This submission already set a different goal.');
  }
  await record(
    {
      kind: 'decision',
      actor: 'owner',
      title: `Set a goal: ${d.title}`,
      body: [d.why && `Why: ${d.why}`, d.doneWhen && `Done when: ${d.doneWhen}`]
        .filter(Boolean)
        .join('\n'),
      askId
    },
    tx
  );
  if (m) await ensureReview(m, tx);
  return { row, planner: m };
}

/** The manager's weekly review, made once even when two goals arrive together. */
async function ensureReview(m: StaffRow, tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('weekly-goal-review'))`);
  const [has] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.staffId, m.id), eq(jobs.name, REVIEW_JOB)));
  if (has) return;
  await addJob(
    {
      staffId: m.id,
      name: REVIEW_JOB,
      instructions: goalReview(await ownerName(tx)),
      schedule: { every: 'week', day: 'Fri', at: '16:00' }
    },
    tx
  );
}

/** The owner changes a goal: its words, when it is for, or where it stands. */
export async function updateGoal(
  id: number,
  patch: Partial<GoalDraft> & { status?: GoalStatus },
  by: { owner: true } | { staffId: string; askId?: number }
): Promise<GoalRow | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(goals)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(goals.id, id))
      .returning();
    if (!row) return undefined;
    const what = patch.status
      ? `${patch.status === 'active' ? 'Picked up' : `Marked ${patch.status}`}: ${row.title}`
      : `Changed the goal: ${row.title}`;
    await record(
      {
        kind: 'owner' in by ? 'decision' : 'work',
        actor: 'owner' in by ? 'owner' : by.staffId,
        title: what,
        body: JSON.stringify(patch),
        askId: 'askId' in by ? by.askId : undefined
      },
      tx
    );
    if (patch.status) {
      // A status change leaves nothing for after the commit (`goalStatusChanged`).
      const went = await transitionWork(
        { kind: 'goalStatusChanged', goalId: id, status: patch.status },
        { tx }
      );
      if ('refused' in went) throw new Error(went.refused);
    }
    return row;
  });
}

/**
 * Link a staffer to a goal, with its part in it. A staffer sees only goals it
 * serves. `askId` is the ask whose yes did it, so the Desk lists that yes once.
 */
export async function serveGoal(
  staffId: string,
  goalId: number,
  part: string,
  q: Db = db,
  askId?: number
): Promise<void> {
  const who = await staffer(staffId, q);
  const g = await goal(goalId, q);
  if (!who || !g) throw fixedError('No such Odd or goal');
  const words = part.trim().slice(0, 400);
  if (!words) throw new Error(`Say what ${who.name} does for it`);
  await q
    .insert(staffGoals)
    .values({ staffId, goalId, part: words })
    .onConflictDoUpdate({ target: [staffGoals.staffId, staffGoals.goalId], set: { part: words } });
  await record(
    {
      kind: 'decision',
      actor: 'owner',
      title: `${who.name} serves the goal: ${g.title}`,
      body: words,
      askId
    },
    q
  );
}

/**
 * The owner hired from a proposed hire. The hire serves the goal it was
 * proposed for in the transaction that approves the ask, since the answer
 * wakes the goal's lead to hand the hire its first piece. If linking fails,
 * the ask stays open and nobody is woken. `note` goes back with the answer,
 * as when the owner added a persona in place of the proposed Odd.
 */
export async function approveHire(
  askId: number,
  staffId: string,
  note: string | null = null
): Promise<void> {
  const approved = await approveAsk(askId, note, {
    perKind: [
      {
        name: 'serve goal',
        run: async (tx) => {
          const a = await ask(askId, tx);
          if (a?.kind !== 'hire') throw new Error('That is not a proposed hire');
          if (a.hire?.goal) await serveGoal(staffId, a.hire.goal.id, a.hire.goal.part, tx, askId);
        }
      }
    ]
  });
  if (!approved) throw new Error('That proposal is no longer open');
}

export async function stopServing(staffId: string, goalId: number): Promise<void> {
  const [who, g] = await Promise.all([staffer(staffId), goal(goalId)]);
  const gone = await db
    .delete(staffGoals)
    .where(and(eq(staffGoals.staffId, staffId), eq(staffGoals.goalId, goalId)))
    .returning();
  if (gone.length && who && g)
    await record({
      kind: 'decision',
      actor: 'owner',
      title: `${who.name} no longer serves the goal: ${g.title}`
    });
}

/**
 * A staffer's word on a goal it serves, or on one whose thread it leads. The
 * lead plans the goal before anyone serves it, so it logs from the start.
 */
export async function logProgress(
  staffId: string,
  goalId: number,
  health: GoalHealth,
  note: string
): Promise<ProgressRow | string> {
  const [[link], [lead]] = await Promise.all([
    db
      .select({ id: staffGoals.goalId })
      .from(staffGoals)
      .where(and(eq(staffGoals.staffId, staffId), eq(staffGoals.goalId, goalId))),
    db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.hubId, staffId), eq(threads.goalId, goalId)))
      .limit(1)
  ]);
  if (!link && !lead)
    return `You neither serve goal #${goalId} nor lead its thread. my_goals lists the goals you serve.`;
  const [row] = await db
    .insert(goalProgress)
    .values({ goalId, staffId, health, note: note.trim().slice(0, 500) })
    .returning();
  return row;
}

/**
 * A goal ask approved: the goal is set, and the manager plans it. Approved
 * on its card in the manager's chat (`inChat`), the planning run replies there.
 */
export async function approveGoal(
  askId: number,
  reason: string | null,
  inChat = false
): Promise<GoalRow> {
  const a = await ask(askId);
  if (a?.kind !== 'goal' || !a.goal || a.status !== 'open')
    throw fixedError('That goal is no longer open');
  const draft = a.goal;
  let set: GoalRow | undefined;
  // The yes's decider plans the goal this sets, pointing at it by `GOAL_SET`.
  const approved = await approveAsk(askId, reason, {
    perKind: [
      {
        name: GOAL_SET,
        run: async (tx) => {
          set = (await setGoal(tx, draft, askId)).row;
          return { id: set.id };
        }
      }
    ],
    inChat
  });
  // A `set` from a run Postgres ended to break a deadlock rolled back, and the
  // next run may find the ask answered already.
  if (!approved || !set) throw fixedError('That goal is no longer open');
  return set;
}

/** A plan item in words, with the Odd's name, never its id. */
const itemLabel = (names: Map<string, string>) => (i: GoalPlanItem) =>
  i.kind === 'hire'
    ? `hire ${i.hire.name}, ${i.hire.role}`
    : `${names.get(i.staff) ?? i.staff}: ${i.part}`;

/**
 * A plan ask approved, with the parts the owner ticked. Staff already here take
 * on their part and their jobs, each hire becomes a hire ask on the plan's
 * thread, which the page opens in the hire window, and the owner's own steps
 * a task on their desk, all in the transaction that approves the ask, so a
 * part that fails leaves the whole plan open. The answer that brings the
 * plan's Odd back to the goal's thread to lead the work commits with them, so
 * its run finds all of it, the hire asks it waits on among them. Hiring one
 * of the plan's hires answers its ask, and that brings the Odd back there
 * again. Approved on its card in the Odd's chat (`inChat`), that pick-up
 * replies there.
 */
export async function approvePlan(
  askId: number,
  picks: number[],
  reason: string | null,
  inChat = false
): Promise<{ hires: AskRow[] }> {
  const a = await ask(askId);
  if (a?.kind !== 'plan' || !a.plan || a.status !== 'open')
    throw fixedError('That plan is no longer open');
  const g = await goal(a.plan.goalId);
  if (!g) throw fixedError('The goal this plan is for is gone');
  const { plan } = a;
  const picked = plan.items.filter((_, i) => picks.includes(i));
  if (!picked.length) throw fixedError('Tick at least one part of the plan, or deny it');
  const left = plan.items.filter((_, i) => !picks.includes(i));
  const label = itemLabel(new Map((await roster()).map((s) => [s.id, s.name])));
  const note = [
    reason,
    `Approved: ${picked.map(label).join('; ')}`,
    left.length && `Left out: ${left.map(label).join('; ')}.`
  ]
    .filter(Boolean)
    .join('\n');

  const files = (f?: Omit<JobFiles, 'thread'>) => {
    if (!f) return undefined;
    if (!a.threadId) throw new Error('This plan has no work folder.');
    return { ...f, thread: a.threadId };
  };
  // Refuse the whole plan, before any part of it, if its files make a ring.
  let after = await fileJobs();
  picked.forEach((item, i) => {
    if (item.kind !== 'assign') return;
    if (item.job?.files)
      after.push({
        id: -1 - i,
        name: item.job.name,
        staffId: item.staff,
        files: files(item.job.files)!
      });
    const edit = item.editJob;
    if (edit?.files)
      after = after.map((j) =>
        j.staffId === item.staff && j.name === edit.name
          ? { ...j, name: edit.newName ?? j.name, files: files(edit.files)! }
          : j
      );
  });
  refuseFileCycle(after);
  const hires: AskRow[] = [];
  const approved = await approveAsk(askId, note, {
    perKind: [
      {
        name: 'plan',
        run: async (tx) => {
          // A run Postgres ended to break a deadlock rolled its hire asks back.
          hires.length = 0;
          for (const item of picked)
            if (item.kind === 'assign') await serveGoal(item.staff, g.id, item.part, tx, askId);
          for (const item of picked) {
            if (item.kind === 'assign') {
              if (item.job)
                await addJob(
                  { staffId: item.staff, ...item.job, files: files(item.job.files) },
                  tx
                );
              if (item.editJob)
                await editOwnJob(
                  item.staff,
                  item.editJob.name,
                  {
                    name: item.editJob.newName,
                    instructions: item.editJob.instructions,
                    schedule: item.editJob.schedule,
                    missed: item.editJob.missed,
                    files: files(item.editJob.files)
                  },
                  { askId },
                  tx
                );
            } else {
              const { ask: h } = await raiseAsk(
                a.staffId,
                {
                  title: `Hire ${item.hire.name}, ${item.hire.role}`,
                  why: `For the goal "${g.title}": ${item.part}`,
                  ifApproved: 'The hire window opens with this filled in. You hire from there.',
                  hire: { ...item.hire, goal: { id: g.id, part: item.part } },
                  threadId: a.threadId ?? undefined
                },
                tx
              );
              hires.push(h);
            }
          }
          if (plan.ownerSteps?.length)
            await giveTask(
              a.staffId,
              {
                title: `For "${g.title}": yours to do`,
                why: 'The part of the plan only you can do.',
                steps: plan.ownerSteps,
                byOffice: true
              },
              tx
            );
        }
      }
    ],
    inChat
  });
  if (!approved) throw fixedError('That plan is no longer open');
  return { hires };
}
