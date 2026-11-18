// Reports, and the desk that lists what waits on the owner.
import { proposedProjectWork } from './project-sessions.ts';
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, not, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from './db.ts';
import { type Db } from './threads.ts';
import { asks, attachments, ledger, reports, tasks, type FolderRequest } from './schema.ts';
import { awayJobs, type AwayJob } from './missed-runs.ts';
import { type OwnSwitch } from './access-words.ts';
import { type DeskItem } from './desk-answers.ts';
import type { AskRow, TaskRow, AttachmentRow, ReportRow, LedgerRow } from './office.ts';
import { ofWorkingOdd } from './office-staff.ts';
import { shownFolder } from './office-folders.ts';
import { record } from './office-ledger.ts';
import { asksNoMore } from './office-asks.ts';

// Reports

export async function addReport(
  staffId: string,
  title: string,
  body: string,
  runId?: number,
  q: Db = db
) {
  await q.insert(reports).values({ staffId, title, body });
  await record({ kind: 'report', actor: staffId, title, body, runId }, q);
}

export async function readReport(id: number): Promise<void> {
  await db.update(reports).set({ readAt: new Date() }).where(eq(reports.id, id));
}

// The desk: everything waiting on the owner

export type Desk = {
  projectWork: Awaited<ReturnType<typeof proposedProjectWork>>;
  /** The latest answers, kept apart from the items waiting on the owner. */
  recent: Pick<LedgerRow, 'id' | 'title' | 'reason'>[];
  asks: AskRow[];
  tasks: TaskRow[];
  reports: ReportRow[];
  /** What the open asks and tasks carry. */
  attachments: AttachmentRow[];
  /**
   * Each open folder ask's folder by ask id, the home written `~`
   * (`shownFolder`), which only the server can work out.
   */
  folders: Record<number, string>;
  /**
   * The open tasks given for an access ask that only connects the tool
   * (`connectOnly`): marking one done starts no work of the Odd's own.
   */
  connectOnly: number[];
  /** The jobs that skipped a run while the office was off: the While you were away card. */
  away: AwayJob[];
};

export async function desk(): Promise<Desk> {
  const later = alias(ledger, 'later');
  const [a, t, r, f, recent, projectWork] = await Promise.all([
    db
      .select()
      .from(asks)
      .where(and(eq(asks.status, 'open'), ofWorkingOdd(asks.staffId)))
      .orderBy(asc(asks.createdAt)),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'open'), or(isNull(tasks.staffId), ofWorkingOdd(tasks.staffId))))
      .orderBy(asc(tasks.createdAt)),
    // A report from an Odd that left waits unseen, and shows again if it comes back.
    db
      .select()
      .from(reports)
      .where(and(isNull(reports.readAt), ofWorkingOdd(reports.staffId)))
      .orderBy(asc(reports.createdAt)),
    db
      .select({ attachments })
      .from(attachments)
      .leftJoin(asks, eq(attachments.askId, asks.id))
      .leftJoin(tasks, eq(attachments.taskId, tasks.id))
      .where(or(eq(asks.status, 'open'), eq(tasks.status, 'open')))
      .orderBy(asc(attachments.id)),
    // One line per decision. An answer to an ask is written last, after what
    // its yes set in the same transaction (a goal set, an Odd serving it), so
    // a line with a newer one on the same ask is part of that answer.
    db
      .select({ id: ledger.id, title: ledger.title, reason: ledger.reason })
      .from(ledger)
      .where(
        and(
          eq(ledger.actor, 'owner'),
          or(eq(ledger.kind, 'decision'), isNotNull(ledger.taskId)),
          not(
            exists(
              db
                .select({ id: later.id })
                .from(later)
                .where(
                  and(
                    eq(later.askId, ledger.askId),
                    gt(later.id, ledger.id),
                    eq(later.actor, 'owner'),
                    eq(later.kind, 'decision')
                  )
                )
            )
          )
        )
      )
      .orderBy(desc(ledger.createdAt), desc(ledger.id))
      .limit(5),
    proposedProjectWork()
  ]);
  // A twin waits behind the first ask it repeats, and the owner's answer to
  // that one answers it too (`asksNoMore`, `decide`).
  const shown = a.filter((x) => !a.some((first) => first.id < x.id && asksNoMore(first, x)));
  return {
    projectWork,
    recent,
    asks: shown,
    tasks: t,
    reports: r,
    attachments: f.map((x) => x.attachments),
    folders: Object.fromEntries(
      shown.flatMap((x) => (x.folder ? [[x.id, shownFolder(x.folder.path)]] : []))
    ),
    connectOnly: await connectOnlyTasks(t),
    away: await awayJobs()
  };
}

/** Which of these tasks came from an access ask that only connects the tool. */
async function connectOnlyTasks(open: TaskRow[]): Promise<number[]> {
  const ids = open.flatMap((t) => (t.askId === null ? [] : [t.askId]));
  if (!ids.length) return [];
  const only = new Set(
    (await db.select({ id: asks.id, access: asks.access }).from(asks).where(inArray(asks.id, ids)))
      .filter((a) => a.access?.connectOnly)
      .map((a) => a.id)
  );
  return open.filter((t) => t.askId !== null && only.has(t.askId)).map((t) => t.id);
}

/** An ask or task an Odd has open on the owner's desk, as its prompt lists it. */
export type OnDesk = { kind: 'ask' | 'task'; id: number; title: string };

/**
 * What an Odd still has open on the owner's desk, newest first: up to `limit`
 * items, and how many more. A reply shows as "Reply to <subject>".
 */
export async function stillOnDesk(
  staffId: string,
  limit = 15
): Promise<{ items: OnDesk[]; more: number }> {
  const [a, t] = await Promise.all([
    db
      .select()
      .from(asks)
      .where(and(eq(asks.staffId, staffId), eq(asks.status, 'open'))),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.staffId, staffId), eq(tasks.status, 'open')))
  ]);
  const all = [
    ...a.map((x) => ({
      kind: 'ask' as const,
      id: x.id,
      title: x.reply ? `Reply to ${x.reply.subject}` : x.title,
      at: x.createdAt
    })),
    ...t.map((x) => ({ kind: 'task' as const, id: x.id, title: x.title, at: x.createdAt }))
  ].sort((x, y) => y.at.getTime() - x.at.getTime() || y.id - x.id);
  return {
    items: all.slice(0, limit).map(({ kind, id, title }) => ({ kind, id, title })),
    more: Math.max(0, all.length - limit)
  };
}

/** Something a staffer put on the owner's desk, as its chat shows it. */
export type Delivery = {
  kind: DeskItem;
  id: number;
  title: string;
  at: Date;
  /** open, approved, denied, revise, done, dropped, or for a report new or read. */
  status: string;
  /** A saved task response opens from its chat card, including after completion. */
  responseVersion?: number;
  folder?: FolderRequest;
  switches?: OwnSwitch[];
  why?: string;
  /** When the owner decided an ask or finished or dropped a task. */
  decidedAt?: Date | null;
  /** The owner's words on a decided ask or finished task. */
  note?: string | null;
};

/** What one staffer put on the owner's desk, newest last, with where each stands. */
export async function deliveries(staffId: string, limit = 200): Promise<Delivery[]> {
  const [a, t, r] = await Promise.all([
    db
      .select({
        id: asks.id,
        title: asks.title,
        at: asks.createdAt,
        status: asks.status,
        decidedAt: asks.decidedAt,
        note: asks.reason,
        folder: asks.folder,
        switches: asks.switches,
        why: asks.why
      })
      .from(asks)
      .where(eq(asks.staffId, staffId))
      .orderBy(desc(asks.createdAt))
      .limit(limit),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        at: tasks.createdAt,
        status: tasks.status,
        note: tasks.note,
        responseVersion: tasks.responseVersion,
        decidedAt: tasks.doneAt
      })
      .from(tasks)
      .where(eq(tasks.staffId, staffId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit),
    db
      .select({
        id: reports.id,
        title: reports.title,
        at: reports.createdAt,
        readAt: reports.readAt
      })
      .from(reports)
      .where(eq(reports.staffId, staffId))
      .orderBy(desc(reports.createdAt))
      .limit(limit)
  ]);
  return [
    ...a.map(({ folder, switches, why, ...x }) => ({
      kind: 'ask' as const,
      ...x,
      ...(folder && {
        folder: {
          ...folder,
          path: shownFolder(folder.path),
          ...(folder.given && { given: { ...folder.given, path: shownFolder(folder.given.path) } })
        },
        why
      }),
      ...(switches && { switches, why })
    })),
    ...t.map((x) => ({ kind: 'task' as const, ...x })),
    ...r.map(({ readAt, ...x }) => ({
      kind: 'report' as const,
      ...x,
      status: readAt ? 'read' : 'new'
    }))
  ]
    .sort((x, y) => x.at.getTime() - y.at.getTime())
    .slice(-limit);
}

export async function report(id: number): Promise<ReportRow | undefined> {
  const [r] = await db.select().from(reports).where(eq(reports.id, id));
  return r;
}
