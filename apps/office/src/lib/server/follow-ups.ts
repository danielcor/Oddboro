// Work a staffer owes once the owner answers it: carry out an approved ask, rework
// one the owner sent back, take in the reason for a no, act on the owner's answer
// to something it raised, pick up the work that waited on a task the owner just
// finished, plan a goal they set, get a new hire with a job started on its first
// day, or read the owner's edit to an Odd's file for a lesson. Work one Odd hands another runs the
// same way, and so does its result going back (hand-offs.ts in the ledger), and
// so does a thread's hub picking it back up (threads.ts).
// This listens for changes to follow-ups and starts any nobody has started yet. Nothing polls:
// a change to the table, or any run ending, is the only thing that looks.
// It also lists those yet to start, for the In progress section. A run the
// owner's answer on a chat card started replies in that chat as it ends (`endFollowUp`).
import {
  anyStaffer,
  closeStaleFollowUps,
  CUT_OFF_RESULT,
  finishFollowUp,
  followUpsToDo,
  followUpsToStart,
  startFollowUp,
  workTitle,
  type FollowUpRow,
  type Outcome
} from '@oddboro/ledger';
import { followUpDetail, type Work } from '../staff/work.ts';
import { bus, listen, type OfficeEvent } from './events.ts';
import { readEditAgain } from './files.ts';
import { answerInChat, followThrough, RUN_ENDED } from './staff.ts';
import { held } from './update.ts';

const g = globalThis as unknown as { followUps?: boolean };

async function look(): Promise<void> {
  // An update is about to install. Nothing new starts; the next start looks again.
  if (held()) return;
  for (const { id, ask, task, goal } of await followUpsToDo()) {
    // The claim is in the database, so two looks never start the same one. It
    // returns the row as claimed, with any answer that joined it since the list.
    const f = await startFollowUp(id);
    if (!f) continue;
    // The same name a restart gives it, so one piece of work has one name.
    const about = await workTitle(f);
    void followThrough(f, ask, task, goal)
      .then(async (r) => {
        await endFollowUp(f, about, r.outcome, r.text, r.joined);
        // A save while an edited run ran joined it, so once it ends, any change
        // since it read the file is one more edit to read.
        if (f.edit && r.saw !== undefined) await readEditAgain(f.staffId, f.edit.path, r.saw);
      })
      .catch((e: unknown) => {
        // When finishing itself failed, the second call finds the outcome
        // already written and does nothing, so the log is all that tells.
        console.error(`Follow-up ${f.id} (${about}) failed:`, e);
        return endFollowUp(f, about, 'failed', e instanceof Error ? e.message : String(e));
      });
  }
}

/**
 * Record how a follow-up ended (`finishFollowUp`), once. When the owner's
 * answer on a card in its Odd's chat started it, its reply goes in that chat
 * too, under the card; the Ledger keeps its line either way.
 */
export async function endFollowUp(
  f: FollowUpRow,
  about: string,
  outcome: Outcome,
  text: string,
  joined?: number[]
): Promise<void> {
  if (!(await finishFollowUp(f, about, outcome, text, { joined }))) return;
  if (f.chatCard) answerInChat(f.staffId, f.chatCard, outcome, text);
}

/**
 * Each Odd's follow-ups yet to start, as In progress lists them beside its
 * runs (`inProgress` in staff.ts): what each is about, by the one name the
 * Ledger gives it (`workTitle`), and what it will do. Most wait for the Odd's
 * run on the same work to end, such as a pick-up after a task the owner
 * finished while the chat that gave it still goes. The page reads them with
 * the office (`/api/office`), again on each change to `follow_ups`.
 */
export async function followUpsWaiting(): Promise<Record<string, Work[]>> {
  const out: Record<string, Work[]> = {};
  for (const f of await followUpsToStart()) {
    const from = f.handOff?.from;
    const colleague = from && ((await anyStaffer(from))?.name ?? from);
    (out[f.staffId] ??= []).push({
      id: -f.id,
      kind: 'follow-up',
      label: await workTitle(f),
      detail: followUpDetail(f.kind, { ask: f.askId ?? undefined, colleague }),
      since: f.createdAt.toISOString(),
      queued: true,
      toStart: true,
      steps: 0,
      ...(f.askId ? { askId: f.askId } : {})
    });
  }
  return out;
}

/** Start once per process. */
export function startFollowUps(): void {
  if (g.followUps) return;
  g.followUps = true;
  listen();
  bus.on('event', (e: OfficeEvent) => {
    if (e.type === 'change' && e.table === 'follow_ups') void look();
  });
  bus.on(RUN_ENDED, () => void look());
  // A run a restart cut off says so in the chat it was answering, as a failed run does.
  void closeStaleFollowUps()
    .then((closed) => {
      for (const f of closed)
        if (f.chatCard) answerInChat(f.staffId, f.chatCard, 'failed', CUT_OFF_RESULT);
    })
    .then(look);
}
