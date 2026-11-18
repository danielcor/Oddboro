// An Odd leaving the office, and coming back. Leaving is soft: the row and all
// its history stay, and `staff.left_at` takes it off the floor. Every lookup of
// a working Odd (`staffer`, `roster`) skips it, so it runs nothing, gets no
// hand-off and shows nowhere. Bringing it back clears the mark, and it returns
// as it was: its job description, tools, folders, lessons, files and chat.
// Each is one change through the work core (`oddRemoved`, `oddBroughtBack` in
// work/leaving.ts), so it happens whole or not at all.
import { and, eq } from 'drizzle-orm';
import { db } from './db.ts';
import { lookSignature } from '@oddboro/sprites/look';
import { followUps, jobs, type AskKind } from './schema.ts';
import { anyStaffer, roster, staffer, workTitle } from './office.ts';
import { MANAGER_ROLE } from './managers.ts';
import { transitionWork } from './work/apply.ts';
import { queuedRows } from './work/load.ts';

/** What the owner's yes to letting an Odd go does, on the ask. */
export const leavesLine = (name: string): string =>
  `${name} leaves the office at once: off the floor, its jobs off, and anything it has open on your desk withdrawn. Its history stays, and your ${MANAGER_ROLE} can bring it back.`;

/** Who let the Odd go or brought it back: the owner's yes to an ask, or the owner from its card. */
export type LeaveBy = { askId?: number };

/**
 * Why the owner's yes to a remove or bring_back ask cannot be carried out now,
 * or undefined when it can. The tools check the same before they raise one.
 */
export async function leavingRefused(
  kind: Extract<AskKind, 'remove' | 'bring_back'>,
  odd: string | null
): Promise<string | undefined> {
  const who = odd ? await anyStaffer(odd) : undefined;
  if (!who) return 'No Odd by that name ever worked here.';
  if (kind === 'remove') {
    if (who.leftAt) return `${who.name} already left the office.`;
    if (who.role === MANAGER_ROLE)
      return `${who.name} is the ${MANAGER_ROLE}, and every office keeps one.`;
    return undefined;
  }
  if (!who.leftAt) return `${who.name} still works here.`;
  const twin = who.look && (await lookTwin(who.id, lookSignature(who.look)));
  if (twin)
    return `${twin} looks exactly like ${who.name} now. Redraw ${twin}'s look first, then bring ${who.name} back.`;
  return undefined;
}

/** A working Odd hired since with the same look, by name. */
async function lookTwin(id: string, sig: string): Promise<string | undefined> {
  return (await roster()).find((p) => p.id !== id && p.look && lookSignature(p.look) === sig)?.name;
}

/**
 * Callbacks the office registers to stop an Odd's runs the moment it leaves.
 * The ledger cannot reach a run; the office's process holds them.
 */
const onLeave = new Set<(id: string) => void>();
export function whenOddLeaves(fn: (id: string) => void): () => void {
  onLeave.add(fn);
  return () => onLeave.delete(fn);
}

/**
 * Let an Odd go. In one change it leaves the floor, its jobs turn off (and
 * are remembered, to turn on again if it comes back), its waiting pokes are
 * cancelled, and every thread it leads stops, waiting on nothing. Its open
 * work closes in the same change: each open ask is withdrawn and each open
 * task dropped, with the line going back to whoever waits on it, and each
 * run it has yet to start fails, so a lead that handed it work hears at
 * once. Once that is saved, any run going now stops. Returns the refusal,
 * or undefined once it left.
 */
export async function removeOdd(
  id: string,
  by: LeaveBy = {}
): Promise<{ refused: string } | undefined> {
  const refused = await leavingRefused('remove', id);
  if (refused) return { refused };
  const who = (await staffer(id))!;
  const on = await db.$count(jobs, and(eq(jobs.staffId, id), eq(jobs.enabled, true)));
  const waiting = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.staffId, id), queuedRows));
  const about = new Map<number, string>();
  for (const f of waiting) about.set(f.id, await workTitle(f));
  const went = await transitionWork({
    kind: 'oddRemoved',
    staffId: id,
    line: {
      kind: 'hire',
      actor: 'owner',
      title: `Let ${who.name} go from the office`,
      body: `${who.name}, ${who.role}, is off the floor and runs nothing.${on ? ` ${jobsWord(on)} off.` : ''} Its history stays, and the ${MANAGER_ROLE} can bring it back.`,
      askId: by.askId
    },
    about,
    effects: {
      stopRuns: (staffId) => {
        for (const stop of onLeave) stop(staffId);
      }
    }
  });
  return 'refused' in went ? went : undefined;
}

const jobsWord = (n: number) => (n === 1 ? 'Its job is' : `Its ${n} jobs are`);

/**
 * Bring back an Odd that left, as it was: back on the floor, with the jobs that
 * were on when it left turned on again from now. What it had open when it left
 * stays closed. Returns the refusal, or undefined once it is back.
 */
export async function bringBack(
  id: string,
  by: LeaveBy = {}
): Promise<{ refused: string } | undefined> {
  const refused = await leavingRefused('bring_back', id);
  if (refused) return { refused };
  const who = (await anyStaffer(id))!;
  const went = await transitionWork({
    kind: 'oddBroughtBack',
    staffId: id,
    line: {
      kind: 'hire',
      actor: 'owner',
      title: `Brought ${who.name} back to the office`,
      body: `${who.name}, ${who.role}, is back as it was.${who.jobsOff?.length ? ` ${jobsWord(who.jobsOff.length)} on again.` : ''}`,
      askId: by.askId
    }
  });
  return 'refused' in went ? went : undefined;
}
