// In a chat, a goal's work goes to the goal's lead, never onto the owner's desk
// or into a thread of its own from a colleague. The chat's instructions say so
// (`threadsOnBrief`); this is the backstop in code. An Odd on a goal's thread
// that has no job and leads no goal does only goals' work it does not lead,
// so each tool `placed` checks in mcp-desk.ts (the ones that raise an ask or a
// task, and hand_off when it would open a thread; that comment says why the
// rest are outside) is refused in its chat and pointed to tell_lead. An Odd
// with a job of its own is told the rule and trusted with it. Opening a
// thread has its own check where it happens (`assertMayLead`).
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db } from './db.ts';
import { jobs, threads } from './schema.ts';
import { nextIsLeads, type ThreadOn } from './threads.ts';

/** A chat that offers tell_lead refuses every ask or task: `leads` are the goals' leads, by name. */
export type GoalWork = { leads: string[] };

/**
 * The rule for an Odd whose chat lists `on` (`threadsOn`): refused when a
 * goal's thread is among them and it has no job and leads no goal, else
 * undefined.
 */
export async function goalWork(staffId: string, on: ThreadOn[]): Promise<GoalWork | undefined> {
  const goalThreads = on.filter((t) => t.goalId !== null);
  if (!goalThreads.length) return undefined;
  const [[job], [leads]] = await Promise.all([
    db.select({ id: jobs.id }).from(jobs).where(eq(jobs.staffId, staffId)).limit(1),
    db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(eq(threads.hubId, staffId), isNotNull(threads.goalId), ne(threads.status, 'stopped'))
      )
      .limit(1)
  ]);
  if (job || leads) return undefined;
  return { leads: [...new Set(goalThreads.map((t) => t.lead))] };
}

/** What the Odd is told when a goal's work comes to a tool `placed` checks (mcp-desk.ts). */
export function goalWorkRefused(w: GoalWork, owner: string): string {
  const lead = w.leads.join(' or ');
  return [
    `A goal's work goes to its lead, ${lead}, who hands each piece on.`,
    `Pass ${owner}'s words to ${lead} with tell_lead, then tell ${owner} you passed them on. ${nextIsLeads(lead)}`
  ].join(' ');
}
