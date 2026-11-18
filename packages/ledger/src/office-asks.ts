// Asks on the desk: raising one, refusing a repeat, and finding the twins one
// answer covers.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db.ts';
import { goalThread, type Db, type Tx } from './threads.ts';
import { fixedError } from './errors.ts';
import { runAfters } from './transition.ts';
import { transitionWork } from './work/apply.ts';
import {
  asks,
  tasks,
  type AccessRequest,
  type AskKind,
  type FolderRequest,
  type GoalDraft,
  type GoalPlan,
  type HireProposal,
  type InChat,
  type HeldCall,
  type ReplyDraft,
  type StandingRequest
} from './schema.ts';
import { switchesSaid, type Level, type OwnSwitch } from './access-words.ts';
import { type OfficeToolId } from './tools.ts';
import { sameCriteria, type GmailFilter } from './filter-words.ts';
import type { AskRow, LedgerRow } from './office.ts';
import { precedent } from './office-ledger.ts';
import { followUp } from './office-follow-ups.ts';
import { TWINS, asksNoMore, carriedOutBy, resumesWork } from './work/twins.ts';

// Asks

/**
 * Something an Odd tried to put on the owner's desk that is there already, or
 * an email that already has its reply. The tool server returns the message as
 * a tool error the Odd reads.
 */
export class AlreadyOnDesk extends Error {}

/** Two titles as the desk compares them: case and spacing ignored. */
const sameTitle = (a: string, b: string) => {
  const plain = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  return plain(a) === plain(b);
};

/**
 * Lines up an Odd's raises until this transaction ends. Each run has its own
 * tool server process, so two runs raising the same thing at once would both
 * find the desk clear; with the lock the second sees the first.
 */
async function lockDesk(tx: Tx, staffId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`desk:${staffId}`}))`);
}

/**
 * Refuses an item whose title matches an ask or task the Odd already has open.
 * The ask it `revises` does not count: that is how an Odd changes one.
 */
async function refuseRepeat(
  tx: Tx,
  staffId: string,
  title: string,
  revises?: number
): Promise<void> {
  const mine = and(eq(asks.staffId, staffId), eq(asks.status, 'open'));
  const openAsks = await tx.select({ id: asks.id, title: asks.title }).from(asks).where(mine);
  const ask = openAsks.find((a) => a.id !== revises && sameTitle(a.title, title));
  if (ask)
    throw new AlreadyOnDesk(
      `Your ask #${ask.id}, "${ask.title}", is already there. To change it, raise it again with revises: ${ask.id}. Never raise the same thing twice.`
    );
  const openTasks = await tx
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.staffId, staffId), eq(tasks.status, 'open')));
  const task = openTasks.find((t) => sameTitle(t.title, title));
  if (task)
    throw new AlreadyOnDesk(
      `Your task #${task.id}, "${task.title}", is already there. Never give the same thing twice.`
    );
}

/**
 * Whether two replies or filters go through the same Gmail account. Thread
 * and message ids are each mailbox's own, so one in another account is
 * another email.
 */
const sameMailbox = (a: { connector?: string }, b: { connector?: string }) =>
  (a.connector ?? null) === (b.connector ?? null);

/** Whether two replies answer the same email: the same account, and the same Gmail thread, or with none, the same people and subject. */
function sameEmail(a: ReplyDraft, b: ReplyDraft): boolean {
  if (!sameMailbox(a, b)) return false;
  if (a.gmailThreadId || b.gmailThreadId) return a.gmailThreadId === b.gmailThreadId;
  const people = (r: ReplyDraft) =>
    r.to
      .map((t) => t.toLowerCase().trim())
      .sort()
      .join(',');
  return people(a) === people(b) && sameTitle(a.subject, b.subject);
}

/**
 * Refuses a second reply to one email: one still open (unless this revises
 * it), or one the owner already sent or saved for the same message.
 */
async function refuseSecondReply(
  tx: Tx,
  staffId: string,
  reply: ReplyDraft,
  revises?: number
): Promise<void> {
  const replies = await tx
    .select()
    .from(asks)
    .where(
      and(
        eq(asks.staffId, staffId),
        eq(asks.kind, 'reply'),
        inArray(asks.status, ['open', 'approved'])
      )
    );
  const open = replies.find(
    (r) => r.status === 'open' && r.id !== revises && r.reply && sameEmail(r.reply, reply)
  );
  if (open)
    throw new AlreadyOnDesk(
      `Your reply #${open.id} to this email is already there. To change it, call propose_reply again with revises: ${open.id}.`
    );
  const done =
    reply.inReplyTo &&
    replies.find(
      (r) => r.reply?.sent && r.reply.inReplyTo === reply.inReplyTo && sameMailbox(r.reply, reply)
    );
  if (done)
    throw new AlreadyOnDesk(
      `That email already has a reply: your reply #${done.id} was ${done.reply?.sent?.action === 'draft' ? 'saved to Gmail drafts' : 'sent'}. Do not propose another.`
    );
}

/**
 * Refuses a second filter for the same mail: one still open (unless this
 * revises it), or one the owner already created from this Odd.
 */
async function refuseSecondFilter(
  tx: Tx,
  staffId: string,
  filter: GmailFilter,
  revises?: number
): Promise<void> {
  const filters = await tx
    .select()
    .from(asks)
    .where(
      and(
        eq(asks.staffId, staffId),
        eq(asks.kind, 'filter'),
        inArray(asks.status, ['open', 'approved'])
      )
    );
  const same = (r: AskRow) =>
    !!r.filter && sameMailbox(r.filter, filter) && sameCriteria(r.filter.criteria, filter.criteria);
  const open = filters.find((r) => r.status === 'open' && r.id !== revises && same(r));
  if (open)
    throw new AlreadyOnDesk(
      `Your filter #${open.id} for this mail is already there. To change it, call propose_filter again with revises: ${open.id}.`
    );
  const made = filters.find((r) => r.filter?.created && same(r));
  if (made)
    throw new AlreadyOnDesk(
      `That filter already exists: your filter #${made.id} was created in Gmail. Do not propose it again.`
    );
}

/** Where an ask's answer goes back to: its hand-off, its thread, or neither. */
const samePlace = (
  a: { handOffId?: number | null; threadId?: number | null },
  b: { handOffId?: number | null; threadId?: number | null }
) =>
  (a.handOffId ?? null) === (b.handOffId ?? null) && (a.threadId ?? null) === (b.threadId ?? null);

/**
 * Refuses a folder ask that repeats one this Odd has open for the same place:
 * the same folder, at the same level or higher (unless this revises it). One
 * from another place, such as a hand-off, is its twin instead (`asksNoMore`),
 * so the owner's answer goes back to both.
 */
async function refuseSecondFolder(
  tx: Tx,
  staffId: string,
  ask: {
    folder: FolderRequest;
    handOffId?: number;
    threadId?: number;
    revises?: number;
  }
): Promise<void> {
  const open = await tx
    .select()
    .from(asks)
    .where(and(eq(asks.staffId, staffId), eq(asks.kind, 'folder'), eq(asks.status, 'open')));
  const same = open.find(
    (r) =>
      r.id !== ask.revises &&
      !!r.folder &&
      r.folder.path === ask.folder.path &&
      (r.folder.level === 'write' || ask.folder.level === 'read') &&
      samePlace(r, ask)
  );
  if (same)
    throw new AlreadyOnDesk(
      `Your ask #${same.id} for this folder is already there. To change it, call ask_for_folder again with revises: ${same.id}.`
    );
}

/** A switch ask from the same place as an open one that covers it: the open one is the ask. */
async function refuseSecondSwitch(
  tx: Tx,
  staffId: string,
  ask: { switches: OwnSwitch[]; handOffId?: number; threadId?: number; revises?: number }
): Promise<void> {
  const open = await tx
    .select()
    .from(asks)
    .where(and(eq(asks.staffId, staffId), eq(asks.kind, 'switch'), eq(asks.status, 'open')));
  const same = open.find(
    (r) =>
      r.id !== ask.revises &&
      ask.switches.every((s) => r.switches?.includes(s)) &&
      samePlace(r, ask)
  );
  if (same)
    throw new AlreadyOnDesk(
      `Your ask #${same.id} for ${switchesSaid(same.switches ?? [])} is already there. To change it, call ask_for_switch again with revises: ${same.id}.`
    );
}

/** A standing ask for tools an open one already covers: the open one is the ask. */
async function refuseSecondStanding(
  tx: Tx,
  staffId: string,
  want: StandingRequest,
  revises?: number
): Promise<void> {
  const open = await tx
    .select()
    .from(asks)
    .where(and(eq(asks.staffId, staffId), eq(asks.kind, 'standing'), eq(asks.status, 'open')));
  const same = open.find(
    (r) =>
      r.id !== revises &&
      r.standing?.connector === want.connector &&
      want.tools.every((t) => r.standing!.tools.includes(t))
  );
  if (same)
    throw new AlreadyOnDesk(
      `Your ask #${same.id} to use ${(same.standing?.tools ?? []).join(', ')} without asking is already there.`
    );
}

export async function raiseAsk(
  staffId: string,
  a: {
    title: string;
    why: string;
    ifApproved: string;
    access?: AccessRequest;
    hire?: HireProposal;
    goal?: GoalDraft;
    plan?: GoalPlan;
    /** A reply ask's email (`propose_reply`). */
    reply?: ReplyDraft;
    /** A filter ask's Gmail filter (`propose_filter`). */
    filter?: GmailFilter;
    /** A folder ask's folder (`ask_for_folder`). */
    folder?: FolderRequest;
    /** A switch ask's switches (`ask_for_switch`). */
    switches?: OwnSwitch[];
    /** A level ask's level (`ask_for_level`). */
    level?: Level;
    /** An office_tool ask's office tools (`ask_for_office_tool`). */
    officeTools?: OfficeToolId[];
    /** A call ask's held call, from the gateway (`holdCall` in the office's gateway.ts). */
    call?: HeldCall;
    /** A remove or bring_back ask's Odd (leaving.ts). */
    odd?: string;
    /** A standing ask's tools (`ask_for_standing_yes`, standing.ts). */
    standing?: StandingRequest;
    /** Every kind but these says so; `approval`, `access` and `hire` follow from access or hire, and the office raises `hand_offs`, `window` and `catch_up` itself. */
    kind?: Exclude<AskKind, 'approval' | 'access' | 'hire' | 'hand_offs' | 'window' | 'catch_up'>;
    revises?: number;
    /** The colleague whose handed-back work the lead raised this from (`VIA`). */
    via?: string;
    /** Raised while working on this hand-off: the owner's answer goes back to it. */
    handOffId?: number;
    /** Raised on this thread: the owner's answer moves it on. A plan ignores it. */
    threadId?: number;
    /** Files that go with it: paths in the staffer's folder, or names in a thread's folder (`workPath`). */
    attach?: string[];
    /**
     * The key of the run raising it (`runsGoing`), which its thread keeps: a
     * plan's, or a lead's that named a thread from a run on none. A run on the
     * thread passes none, since its own follow-up already holds the hub.
     */
    run?: string;
  },
  q: Db = db
): Promise<{ ask: AskRow; precedent: LedgerRow[]; already: boolean }> {
  const { attach, run, ...fields } = a;
  const kind = a.kind ?? (a.access ? 'access' : a.hire ? 'hire' : 'approval');
  const raise = async (tx: Tx) => {
    // An Odd's own ask may not repeat one on the desk, a reply may not
    // answer an email twice, and a filter may not file the same mail twice.
    // A folder, switch or standing ask may not repeat one from the same place. Access,
    // level and office tool asks have twins instead (`asksNoMore`), and the rest are the office's
    // own or checked where they are made. The office raises `hand_offs`,
    // `window` and `catch_up` asks itself, never through here. A new kind fails the type
    // check here until it says which.
    switch (kind) {
      case 'approval':
      case 'goal':
      case 'remove':
      case 'bring_back':
        await lockDesk(tx, staffId);
        await refuseRepeat(tx, staffId, a.title, a.revises);
        break;
      case 'reply':
        if (!a.reply) break;
        await lockDesk(tx, staffId);
        await refuseSecondReply(tx, staffId, a.reply, a.revises);
        break;
      case 'filter':
        if (!a.filter) break;
        await lockDesk(tx, staffId);
        await refuseSecondFilter(tx, staffId, a.filter, a.revises);
        break;
      case 'folder':
        if (!a.folder) break;
        await lockDesk(tx, staffId);
        await refuseSecondFolder(tx, staffId, { ...a, folder: a.folder });
        break;
      case 'switch':
        if (!a.switches) break;
        await lockDesk(tx, staffId);
        await refuseSecondSwitch(tx, staffId, { ...a, switches: a.switches });
        break;
      case 'standing':
        if (!a.standing) break;
        await lockDesk(tx, staffId);
        await refuseSecondStanding(tx, staffId, a.standing, a.revises);
        break;
      case 'call':
        // A held call the core finds open already, under this lock, so two at once raise one.
        if (a.call) await lockDesk(tx, staffId);
        break;
      case 'access':
      case 'level':
      case 'office_tool':
      case 'hire':
      case 'plan':
        break;
      default:
        kind satisfies never;
    }
    // A plan goes on its goal's one thread, whatever run raised it: a chat,
    // the weekly review, or the goal's own planning run. So approving it
    // always brings the goal's lead back there to lead the work.
    const on = a.plan
      ? { handOffId: undefined, threadId: await goalThread(tx, a.plan.goalId, staffId) }
      : {};
    const went = await transitionWork(
      { kind: 'askRaised', ask: { staffId, ...fields, kind, ...on }, attach, run },
      { tx }
    );
    if ('refused' in went) return went;
    const already = went.change.result?.already;
    const row = await ask(already ?? went.real({ ref: 'ask' }), tx);
    if (!row) throw fixedError('An ask was raised that is not there.');
    return { row, already: already !== undefined, after: went.after };
  };
  // A caller's transaction owns the commit: the ask goes in with the rest of
  // its writes, and raising one leaves nothing for after it (`askRaised`).
  // Nothing here could run an after-effect once that commits, so one fails
  // the caller's transaction rather than be lost.
  const inCallers = 'rollback' in q;
  const raised = inCallers ? await raise(q) : await db.transaction(raise);
  if ('refused' in raised) throw new Error(raised.refused);
  if (inCallers && raised.after.length)
    throw fixedError(
      "Raising an ask left work for after it, which a caller's transaction cannot run."
    );
  if (!inCallers) await runAfters('askRaised', raised.after);
  const { row, already } = raised;
  // A repeat of a held call is the one there, whose precedent the Odd already
  // had. One the office raises in its own transaction, as a plan's hires, no
  // Odd reads, and its precedent is read outside that transaction.
  return {
    ask: row,
    precedent: already || inCallers ? [] : await precedent(`${a.title}\n${a.why}`),
    already
  };
}

export async function ask(id: number, q: Db = db): Promise<AskRow | undefined> {
  const [row] = await q.select().from(asks).where(eq(asks.id, id));
  return row;
}

export async function asksFor(staffId: string): Promise<AskRow[]> {
  return db
    .select()
    .from(asks)
    .where(eq(asks.staffId, staffId))
    .orderBy(desc(asks.createdAt))
    .limit(30);
}

export const DECISIONS = ['approve', 'deny', 'iterate'] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * The other asks of `a`'s kind the owner's one answer settled with it: the
 * same Odd and the same thing wanted (`TWINS`), decided in the same moment,
 * whichever of them the owner saw.
 */
export async function answeredWith(a: AskRow, q: Db = db): Promise<AskRow[]> {
  const twin = TWINS[a.kind];
  if (!twin || !a.decidedAt) return [];
  const rows = await q
    .select()
    .from(asks)
    .where(
      and(eq(asks.staffId, a.staffId), eq(asks.kind, a.kind), eq(asks.decidedAt, a.decidedAt))
    );
  return rows.filter((r) => r.id !== a.id && r.status === a.status && twin.same(a, r));
}

/**
 * Start the carry-outs for asks one answer settled (`carriedOutBy`).
 * `pickedUp` is the work parked on the connect task that just ended, which
 * picks up in its own run (`finishTask`). `chat` goes only to the run of the
 * ask the owner answered in chat, never a twin's.
 */
async function carryOutTogether(
  together: AskRow[],
  pickedUp?: string[],
  q: Db = db,
  chat?: InChat
): Promise<void> {
  for (const a of carriedOutBy(together))
    await followUp(
      a.staffId,
      'carry_out',
      { askId: a.id, note: null, pickedUp, ...(chat?.card.id === a.id && { chat }) },
      q
    );
}

/**
 * The twins the carry-out of `a` stands for: answered with it, starting no
 * run of their own. Only the first run told of them does their work, so it
 * is done once.
 */
export async function standsFor(a: AskRow): Promise<AskRow[]> {
  const together = [a, ...(await answeredWith(a))];
  const runs = carriedOutBy(together);
  if (runs[0]?.id !== a.id) return [];
  return together.filter((x) => resumesWork(x) && !runs.some((r) => r.id === x.id));
}

export { lockDesk, refuseRepeat, TWINS, asksNoMore, carryOutTogether };
