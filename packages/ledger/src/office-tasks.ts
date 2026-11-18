// Tasks an Odd gives the owner, from giving one to finishing it.
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from './db.ts';
import { fixedError } from './errors.ts';
import type { Db, Tx } from './threads.ts';
import { attachments, tasks, type Step } from './schema.ts';
import type { TaskRow } from './office.ts';
import { lockDesk, refuseRepeat } from './office-asks.ts';
import { runAfters } from './transition.ts';
import { ANSWERED_ALREADY } from './work/answers.ts';
import { transitionWork } from './work/apply.ts';

// Tasks for the owner

export async function giveTask(
  staffId: string | null,
  t: {
    title: string;
    why: string;
    steps: (string | Step)[];
    response?: string;
    attach?: string[];
    /** Given while working on this hand-off: the owner's answer goes back to it. */
    handOffId?: number;
    /** Given on this thread: the owner's answer moves it on. */
    threadId?: number;
    /** The key of the run giving it, which its thread keeps, as `raiseAsk` says. */
    run?: string;
    /** The colleague whose handed-back work the lead gave this from (`VIA`). */
    via?: string;
    /** In a chat, the owner's message (`OWNER_SAID`), which the run that picks it up reads. */
    ownerSaid?: string;
    /** The office gives it in the Odd's name (a plan's steps), so it may repeat a title. */
    byOffice?: true;
  },
  q: Db = db
): Promise<TaskRow> {
  const steps = t.steps.map((s) => (typeof s === 'string' ? { text: s, done: false } : s));
  const { title, why, response, handOffId, threadId, via, ownerSaid, attach, run } = t;
  const give = async (tx: Tx) => {
    // An Odd's own task may not repeat an item it already has on the desk.
    if (staffId && !t.byOffice) {
      await lockDesk(tx, staffId);
      await refuseRepeat(tx, staffId, title);
    }
    const went = await transitionWork(
      {
        kind: 'taskGiven',
        task: { staffId, title, why, steps, response, handOffId, threadId, via, ownerSaid },
        attach,
        run
      },
      { tx }
    );
    if ('refused' in went) return went;
    const row = await task(went.real({ ref: 'task' }), tx);
    if (!row) throw fixedError('A task was given that is not there.');
    return { row, after: went.after };
  };
  // A caller's transaction owns the commit, and giving a task leaves nothing for after it
  // (`taskGiven`). Nothing here could run an after-effect once that commits, so one fails
  // the caller's transaction rather than be lost.
  const inCallers = 'rollback' in q;
  const given = inCallers ? await give(q) : await db.transaction(give);
  if ('refused' in given) throw new Error(given.refused);
  if (inCallers && given.after.length)
    throw fixedError(
      "Giving a task left work for after it, which a caller's transaction cannot run."
    );
  if (!inCallers) await runAfters('taskGiven', given.after);
  return given.row;
}

/** The files a task carries, as paths inside its staffer's folder or names in a thread's folder (`workPath`). */
export async function taskFiles(taskId: number): Promise<string[]> {
  const rows = await db
    .select({ path: attachments.path })
    .from(attachments)
    .where(eq(attachments.taskId, taskId))
    .orderBy(asc(attachments.id));
  return rows.map((r) => r.path);
}

const MEDIA: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml'
};

/** The media type of an attachment, from its extension. */
export function mediaTypeOf(path: string): string {
  return MEDIA[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export async function task(id: number, q: Db = db): Promise<TaskRow | undefined> {
  const [row] = await q.select().from(tasks).where(eq(tasks.id, id));
  return row;
}

/** Tick a step, or every step sharing its key, and record an answer if the step asked for one. */
export async function tickStep(id: number, index: number, answer?: string): Promise<void> {
  const t = await task(id);
  const step = t?.steps[index];
  if (!t || !step) return;
  const steps = t.steps.map((s, i) =>
    i === index || (step.key && s.key === step.key)
      ? { ...s, done: true, ...(i === index && answer !== undefined ? { answer } : {}) }
      : s
  );
  await db.update(tasks).set({ steps }).where(eq(tasks.id, id));
}

/** Undo a step, and any step sharing its key, so the owner can do it again. Its answer goes too. */
export async function untickStep(id: number, index: number): Promise<void> {
  const t = await task(id);
  const step = t?.steps[index];
  if (!t || !step) return;
  const steps = t.steps.map((s, i) => {
    if (i !== index && !(step.key && s.key === step.key)) return s;
    const { answer: _, ...rest } = s;
    return { ...rest, done: false };
  });
  await db.update(tasks).set({ steps }).where(eq(tasks.id, id));
}

/** Tick every step whose key matches, across open tasks. Used when a sign-in lands. */
export async function tickKey(key: string): Promise<void> {
  const open = await db.select().from(tasks).where(eq(tasks.status, 'open'));
  for (const t of open)
    if (t.steps.some((s) => s.key === key && !s.done))
      await db
        .update(tasks)
        .set({ steps: t.steps.map((s) => (s.key === key ? { ...s, done: true } : s)) })
        .where(eq(tasks.id, t.id));
}

export class TaskResponseConflict extends Error {}

/**
 * Start from a file attached to the task, or save the owner's edit to the
 * version they opened. A task with no response yet takes its first at version 0.
 */
export async function saveTaskResponse(id: number, version: number | 'start', text: string) {
  const start = version === 'start';
  const next = start ? 0 : version + 1;
  const [saved] = await db
    .update(tasks)
    .set({ response: text, responseVersion: next })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.status, 'open'),
        start ? isNull(tasks.response) : eq(tasks.responseVersion, version)
      )
    )
    .returning();
  if (saved) return saved;
  const t = await task(id);
  if (!t || t.status !== 'open') throw new TaskResponseConflict('This task is closed.');
  // A retry after a lost reply returns the same version. Opening a response never resets it.
  if (t.response !== null && (start || (t.responseVersion === next && t.response === text)))
    return t;
  throw new TaskResponseConflict(
    'The response changed. Review the saved words before saving again.'
  );
}

/**
 * The owner finished or dropped a task. False when it had ended already,
 * unless this is a retry of the Done that ended it, with the same saved
 * response, after its reply was lost.
 */
export async function finishTask(
  id: number,
  done: boolean,
  note: string | null,
  o: { inChat?: boolean; responseVersion?: number } = {}
): Promise<boolean> {
  const { inChat = false, responseVersion } = o;
  const ended = await transitionWork({
    kind: 'taskEnded',
    id,
    ended: done ? 'done' : 'dropped',
    note,
    inChat,
    responseVersion
  });
  if (!('refused' in ended)) return true;
  // Any other refusal wrote nothing: the response or the steps are not ready.
  if (ended.refused !== ANSWERED_ALREADY) throw new TaskResponseConflict(ended.refused);
  if (!done || !responseVersion) return false;
  const t = await task(id);
  return t?.status === 'done' && t.responseVersion === responseVersion;
}

export async function tasksFrom(staffId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.staffId, staffId))
    .orderBy(desc(tasks.createdAt))
    .limit(30);
}
