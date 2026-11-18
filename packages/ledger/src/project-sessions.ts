// The owner connects a native conversation and can give one Odd access to it.
// Claims, revocations and replies serialize on the same session row. All of it
// sits behind Advanced mode, which the owner turns on in Setup: the native tools
// run with the owner's permissions, outside Oddboro's limits.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from './threads.ts';
import { db } from './db.ts';
import { ADVANCED_CONSENT } from './access-words.ts';
import { fixedError } from './errors.ts';
import { record } from './office.ts';
import { transitionWork } from './work/apply.ts';
import {
  owner,
  projectRequests,
  projectSessions,
  reports,
  staff,
  type ProjectRequestState
} from './schema.ts';

/** Waiting project work: none of it has reached the native tool yet. */
const WAITING: ProjectRequestState[] = ['proposed', 'queued', 'authorized'];

/** Whether the owner turned on Advanced mode. Off, the default, means no project sessions at all. */
export async function advancedMode(q: Db = db): Promise<boolean> {
  const [row] = await q.select({ at: owner.advancedAt }).from(owner).where(eq(owner.id, 'owner'));
  return !!row?.at;
}

/**
 * Turn Advanced mode on, after the owner's yes to `ADVANCED_CONSENT`, or off.
 * Each change is a ledger line with its date. Turning it off takes every Odd
 * off every session and stops the work still waiting. Work already in the
 * native tool keeps running there.
 */
export async function setAdvancedMode(on: boolean): Promise<void> {
  const changed = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(owner).where(eq(owner.id, 'owner')).for('update');
    if (!row) throw fixedError('Finish the welcome first.');
    if (!!row.advancedAt === on) return false;
    await tx
      .update(owner)
      .set({ advancedAt: on ? new Date() : null })
      .where(eq(owner.id, 'owner'));
    if (!on) {
      // Sessions first: a request being written holds its session row, so
      // the cancel below sees it once that request commits.
      await tx.update(projectSessions).set({ staffId: null, sendsUnasked: null });
      await tx
        .update(projectRequests)
        .set({ state: 'stopped', answer: 'Advanced mode was turned off before delivery.' })
        .where(inArray(projectRequests.state, WAITING));
    }
    return true;
  });
  // The ledger line embeds its text first, which can take a while: outside the transaction.
  if (changed)
    await record(
      on
        ? {
            kind: 'decision',
            actor: 'owner',
            title: 'Turned on advanced mode',
            body: ADVANCED_CONSENT
          }
        : {
            kind: 'decision',
            actor: 'owner',
            title: 'Turned off advanced mode',
            body: 'Every Odd lost its project sessions, and project work still waiting was stopped.'
          }
    );
}

export type ProjectSession = typeof projectSessions.$inferSelect;
export type ProjectRequest = typeof projectRequests.$inferSelect;
export type ProjectAgent = ProjectSession['agent'];
export const projectConnections = (staffId?: string) =>
  db
    .select()
    .from(projectSessions)
    .where(staffId ? eq(projectSessions.staffId, staffId) : undefined)
    .orderBy(desc(projectSessions.createdAt));
export async function connection(id: string) {
  return (await db.select().from(projectSessions).where(eq(projectSessions.id, id)))[0];
}
export async function connectProject(
  agent: ProjectAgent,
  nativeId: string,
  folder: string,
  title: string
) {
  const [session] = await db
    .insert(projectSessions)
    .values({ id: randomUUID(), agent, nativeId, folder, title })
    .onConflictDoNothing()
    .returning();
  if (session) return session;
  const [existing] = await db
    .select()
    .from(projectSessions)
    .where(and(eq(projectSessions.agent, agent), eq(projectSessions.nativeId, nativeId)));
  if (!existing || existing.folder !== folder)
    throw new Error('This conversation belongs to a different project.');
  return existing;
}
export async function shareProject(id: string, staffId: string | null) {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.id, id))
      .for('update');
    if (!previous) throw new Error('Session not found.');
    if (previous.staffId === staffId) return;
    if (previous.staffId)
      await tx
        .update(projectRequests)
        .set({ state: 'stopped', answer: 'The owner removed access before delivery.' })
        .where(
          and(
            eq(projectRequests.sessionId, id),
            eq(projectRequests.staffId, previous.staffId),
            inArray(projectRequests.state, WAITING)
          )
        );
    // A new Odd never inherits the last one's leave to send without asking.
    await tx
      .update(projectSessions)
      .set({ staffId, sendsUnasked: null })
      .where(eq(projectSessions.id, id));
  });
}

/**
 * Let the Odd this session is shared with send work into it without the
 * owner's Take over and send, or (`null`) take that back. Only an Odd at Act
 * uses it; every other assignment still waits for the owner.
 */
export async function letSendUnasked(id: string, staffId: string | null) {
  await db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.id, id))
      .for('update');
    if (!s) throw new Error('Session not found.');
    if (staffId && s.staffId !== staffId)
      throw new Error('Choose this Odd under Odd allowed to send work first.');
    await tx
      .update(projectSessions)
      .set({ sendsUnasked: staffId })
      .where(eq(projectSessions.id, id));
  });
}

/** Whether an Odd's assignment may go without the owner's yes: Act, and named on the session. */
const sendsUnasked = (s: ProjectSession, odd: { id: string; permission: string }) =>
  odd.permission === 'act' && s.sendsUnasked === odd.id;
/** What a session's work is doing, for its dot in the Projects list. */
export type ProjectStatus = 'waiting' | 'working' | 'done' | 'idle';

/** Every session with its status: waiting for the owner, working, its last work done, or idle. */
export async function projectOverview() {
  const [sessions, open, last] = await Promise.all([
    projectConnections(),
    db
      .select({ sessionId: projectRequests.sessionId, state: projectRequests.state })
      .from(projectRequests)
      .where(
        inArray(projectRequests.state, ['proposed', 'failed', 'uncertain', 'sending', 'working'])
      ),
    db
      .selectDistinctOn([projectRequests.sessionId], {
        sessionId: projectRequests.sessionId,
        state: projectRequests.state
      })
      .from(projectRequests)
      .orderBy(projectRequests.sessionId, desc(projectRequests.createdAt))
  ]);
  return sessions.map((s) => {
    const states = open.filter((r) => r.sessionId === s.id).map((r) => r.state);
    const status: ProjectStatus = states.some(
      (x) => x === 'proposed' || x === 'failed' || x === 'uncertain'
    )
      ? 'waiting'
      : states.length
        ? 'working'
        : last.find((r) => r.sessionId === s.id)?.state === 'done'
          ? 'done'
          : 'idle';
    return { ...s, status };
  });
}
export const projectWork = (id: string) =>
  db
    .select()
    .from(projectRequests)
    .where(eq(projectRequests.sessionId, id))
    .orderBy(desc(projectRequests.createdAt))
    .limit(100);

export async function requestProject(input: {
  id: string;
  sessionId: string;
  prompt: string;
  file?: string;
  staffId?: string;
  threadId?: number;
  draft?: boolean;
}) {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.id, input.sessionId))
      .for('update');
    if (!(await advancedMode(tx)))
      throw fixedError('Advanced mode is off. Turn it on in Setup to use project sessions.');
    if (!s || (input.staffId && s.staffId !== input.staffId))
      throw new Error('This session has not been shared with you.');
    let state: ProjectRequestState = 'queued';
    if (input.staffId) {
      const [odd] = await tx.select().from(staff).where(eq(staff.id, input.staffId));
      if (!odd || odd.leftAt || odd.permission === 'read')
        throw new Error('Sending work needs Draft or Act access.');
      // The native tool runs as the owner, so an Odd's work waits for their
      // yes, whatever its level, unless they let it send to this session.
      if (input.draft || !sendsUnasked(s, odd)) state = 'proposed';
    }
    const [previous] = await tx
      .select()
      .from(projectRequests)
      .where(eq(projectRequests.id, input.id));
    if (previous) {
      if (
        previous.sessionId !== s.id ||
        previous.staffId !== (input.staffId ?? null) ||
        previous.prompt !== input.prompt ||
        previous.file !== (input.file ?? null) ||
        previous.threadId !== (input.threadId ?? null)
      )
        throw new Error('That request ID already belongs to different work.');
      return previous;
    }
    const [row] = await tx
      .insert(projectRequests)
      .values({
        id: input.id,
        sessionId: s.id,
        prompt: input.prompt,
        file: input.file,
        staffId: input.staffId,
        threadId: input.threadId,
        state
      })
      .returning();
    return row;
  });
}

/** The next unsent assignment, also read while checking the native receiver. */
export async function nextProjectRequest(id: string, q: Db = db) {
  const [row] = await q
    .select()
    .from(projectRequests)
    .where(
      and(
        eq(projectRequests.sessionId, id),
        inArray(projectRequests.state, ['queued', 'authorized'])
      )
    )
    .orderBy(asc(projectRequests.createdAt), asc(projectRequests.id))
    .limit(1);
  return row;
}

/** A claim is durable before the prompt leaves, and reads the owner's current grants. */
export async function claimProject(id: string) {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.id, id))
      .for('update');
    if (!s || !(await advancedMode(tx))) return;
    const busy = await tx
      .select({ id: projectRequests.id })
      .from(projectRequests)
      .where(
        and(
          eq(projectRequests.sessionId, id),
          inArray(projectRequests.state, ['sending', 'working', 'uncertain'])
        )
      )
      .limit(1);
    if (busy.length) return;
    const next = await nextProjectRequest(id, tx);
    if (!next) return;
    if (next.staffId) {
      const [odd] = await tx.select().from(staff).where(eq(staff.id, next.staffId)).for('share');
      if (next.staffId !== s.staffId || !odd || odd.leftAt || odd.permission === 'read') {
        await tx
          .update(projectRequests)
          .set({ state: 'stopped', answer: 'Access was removed before delivery.' })
          .where(eq(projectRequests.id, next.id));
        return;
      }
      if (next.state !== 'authorized' && !sendsUnasked(s, odd)) {
        await tx
          .update(projectRequests)
          .set({ state: 'proposed' })
          .where(eq(projectRequests.id, next.id));
        return;
      }
    }
    const [row] = await tx
      .update(projectRequests)
      .set({ state: 'sending' })
      .where(eq(projectRequests.id, next.id))
      .returning();
    return row;
  });
}
export async function changeProjectRequest(
  id: string,
  sessionId: string,
  from: ProjectRequestState[],
  state: ProjectRequestState,
  detail: { turn?: string; answer?: string } = {}
) {
  const [row] = await db
    .update(projectRequests)
    .set({ state, ...detail })
    .where(
      and(
        eq(projectRequests.id, id),
        eq(projectRequests.sessionId, sessionId),
        inArray(projectRequests.state, from)
      )
    )
    .returning();
  return row;
}
/** Posting the result and creating its Desk/chat delivery succeed together, even on a repeated callback. */
export async function finishProject(id: string, sessionId: string, answer: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(projectRequests)
      .set({ state: 'done', answer })
      .where(
        and(
          eq(projectRequests.id, id),
          eq(projectRequests.sessionId, sessionId),
          inArray(projectRequests.state, ['sending', 'working', 'uncertain'])
        )
      )
      .returning();
    if (row?.staffId) {
      const [session] = await tx
        .select()
        .from(projectSessions)
        .where(eq(projectSessions.id, sessionId));
      if (row.threadId) {
        // Queuing a run leaves nothing for after the commit (`runQueued`).
        const went = await transitionWork(
          {
            kind: 'runQueued',
            run: {
              staffId: row.staffId,
              kind: 'resume',
              threadId: row.threadId,
              note: `Result from ${session.title} for your assignment "${row.prompt}":\n${answer}`
            },
            onlyWhileOpen: true
          },
          { tx }
        );
        if ('refused' in went) throw new Error(went.refused);
      }
      await tx.insert(reports).values({
        staffId: row.staffId,
        title: 'Project session: ' + session.title,
        body:
          row.prompt + '\n\n' + answer + (row.threadId ? '\n\nOffice work #' + row.threadId : '')
      });
    }
    return row;
  });
}

/** History shown in the window is paged separately from the active delivery. */
export async function activeProjectRequest(id: string) {
  const [row] = await db
    .select()
    .from(projectRequests)
    .where(
      and(
        eq(projectRequests.sessionId, id),
        inArray(projectRequests.state, ['sending', 'working', 'uncertain'])
      )
    )
    .limit(1);
  return row;
}

export const proposedProjectWork = () =>
  db
    .select({
      id: projectRequests.id,
      sessionId: projectSessions.id,
      title: projectSessions.title,
      prompt: projectRequests.prompt,
      staffId: projectRequests.staffId,
      at: projectRequests.createdAt
    })
    .from(projectRequests)
    .innerJoin(projectSessions, eq(projectRequests.sessionId, projectSessions.id))
    .where(eq(projectRequests.state, 'proposed'))
    .orderBy(asc(projectRequests.createdAt));
