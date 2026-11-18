// An Odd's live state, derived once from what the page holds, and the words
// each screen shows for it. Every screen that says what an Odd is doing reads
// it from here, so the floor tag, the card, the info page, the rail and the
// Jobs tab cannot disagree. Pure, and safe in the browser.
import type { AskRow, Desk, HandOffLine } from '@oddboro/ledger';
import { ACTIVITY_LABEL, type Activity, type StaffProfile } from '#lib/staff/roster.ts';
import { threadTag, type HeldThread } from '#lib/staff/thread-tags.ts';
import type { Work } from '#lib/staff/work.ts';

/** What the page holds about the office, as the server sends it. */
export type Snapshot = {
  ids: string[];
  /** Each Odd's runs going and queued, in the order they joined: run-state.ts `inProgress()`. */
  inProgress: Record<string, Work[]>;
  /** Each Odd's follow-ups yet to start, as `/api/office` sends them. */
  toStart: Record<string, Work[]>;
  /** The Odds with a chat reply to the owner going. A new hire's hello is a run, not a reply. */
  chatting: string[];
  /** oddNow reads only each ask's and task's Odd; the card and the chat read the rest. */
  desk: Desk;
  /** Every Odd in the office, as the card and the chat take them. */
  staff: StaffProfile[];
  /** Each Odd's unread messages for the owner. */
  messages: Record<string, unknown>;
  threads: HeldThread[];
  /** Where the floor put each Odd. */
  activity: Record<string, Activity>;
  nameOf: (id: string) => string;
};

/**
 * What an Odd shows: one state, the first that holds in this order. A reply
 * the owner waits for comes before the Odd's background runs.
 */
export type Show =
  | { is: 'message' }
  | { is: 'waitingOnYou' }
  | { is: 'holding'; text: string }
  | { is: 'leading'; text: string; waitsOn?: string }
  | { is: 'chatting' }
  | { is: 'running' }
  | { is: 'queued'; activity: Activity }
  | { is: 'free'; activity: Activity };

/**
 * An Odd's live state. `runs` and `queued` hold its work whatever it shows,
 * so the work list, the rail count and the Jobs tab keep a run that goes
 * while the Odd holds a thread or waits on the owner.
 */
export type OddNow = {
  show: Show;
  /** Its runs going. */
  runs: Work[];
  /** Its runs waiting for a slot, then its follow-ups yet to start. */
  queued: Work[];
};

/** A free Odd at its desk. "Working" would claim work it is not doing. */
export const FREE_AT_WORK = 'At their desk';
/** An Odd replying to the owner in chat. */
export const CHATTING = 'Replying to you';

/** The states in which an Odd waits on the owner: it goes to the door, and the rail rings it. */
const WAITS_ON_OWNER: Record<Show['is'], boolean> = {
  message: true,
  waitingOnYou: true,
  holding: false,
  leading: false,
  chatting: false,
  running: false,
  queued: false,
  free: false
};

export function oddNow(s: Snapshot): Record<string, OddNow> {
  const asked = new Set<string | null>([
    ...s.desk.asks.map((a) => a.staffId),
    ...s.desk.tasks.map((t) => t.staffId),
    ...Object.keys(s.messages)
  ]);
  const chatting = new Set(s.chatting);
  return Object.fromEntries(
    s.ids.map((id) => {
      const work = s.inProgress[id] ?? [];
      const runs = work.filter((w) => !w.queued);
      const queued = [...work.filter((w) => w.queued), ...(s.toStart[id] ?? [])];
      const show = ((): Show => {
        if (s.messages[id]) return { is: 'message' };
        if (asked.has(id)) return { is: 'waitingOnYou' };
        const tag = threadTag({
          id,
          threads: s.threads,
          working: runs.length > 0,
          nameOf: s.nameOf
        });
        // threadTag words a thread the Odd holds before one it leads.
        if (tag && s.threads.some((t) => t.holderId === id))
          return { is: 'holding', text: tag.text };
        if (tag) return { is: 'leading', ...tag };
        if (chatting.has(id)) return { is: 'chatting' };
        if (runs.length > 0) return { is: 'running' };
        const activity = s.activity[id];
        return queued.length > 0 ? { is: 'queued', activity } : { is: 'free', activity };
      })();
      return [id, { show, runs, queued }];
    })
  );
}

/** The first run going, with " +N more" for the rest; undefined with none going. Queued work is not counted. */
export function runWords(n: OddNow): string | undefined {
  const [first, ...more] = n.runs;
  if (!first) return undefined;
  return more.length > 0 ? `${first.label} +${more.length} more` : first.label;
}

/**
 * Whether the card's tabs reload: only when a run starts or ends. A tool
 * step, a queued run or a chat reply leaves every Odd's run words as they
 * were, so it reloads nothing.
 */
export function runsChanged(
  before: Record<string, OddNow>,
  after: Record<string, OddNow>
): boolean {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].some((id) => wordsOf(before[id]) !== wordsOf(after[id]));
}

const wordsOf = (n: OddNow | undefined): string | undefined => n && runWords(n);

/** The card line and the info page's line: what the Odd is doing, in words. */
export function lineWords(n: OddNow): string {
  const show = n.show;
  switch (show.is) {
    case 'message':
      return 'Has a message for you';
    case 'waitingOnYou':
      return ACTIVITY_LABEL.wait;
    case 'holding':
    case 'leading':
      return show.text;
    case 'chatting':
      return CHATTING;
    case 'running':
      // A running Odd has a run going, so it has words.
      return runWords(n) ?? '';
    case 'queued':
      // Queued work is not under way, so the Odd reads as where it stands, "Working" included.
      return ACTIVITY_LABEL[show.activity];
    case 'free':
      return show.activity === 'work' ? FREE_AT_WORK : ACTIVITY_LABEL[show.activity];
    default:
      return show satisfies never;
  }
}

/** The floor tag and the rail's status: where the Odd is headed while it walks, else its line. */
export function tagWords(n: OddNow, heading?: string): string {
  return heading ? `→ ${heading}` : lineWords(n);
}

/**
 * Where the floor sends the Odd: to the door while it waits on the owner,
 * to its job's place while a run goes or while it waits on a colleague, and
 * nowhere new otherwise. A run going counts in every state below the door.
 */
export function floorMode(n: OddNow, jobActivity: Activity): Activity | undefined {
  if (WAITS_ON_OWNER[n.show.is]) return 'wait';
  if (n.runs.length > 0) return jobActivity;
  return n.show.is === 'leading' && n.show.waitsOn ? jobActivity : undefined;
}

/**
 * Whether the Jobs tab shows the job as Running: a run going has the job's
 * name as its label. A catch-up run's label names its periods too, so it
 * does not.
 */
export function jobRunning(n: OddNow, job: string): boolean {
  return n.runs.some((w) => w.label === job);
}

/** The work list: runs going, then queued runs, then follow-ups yet to start. */
export function workItems(n: OddNow): Work[] {
  return [...n.runs, ...n.queued];
}

/** The rail's count: every run going or queued, and every follow-up yet to start. */
export function railCount(n: OddNow): number {
  return n.runs.length + n.queued.length;
}

/** Whether the rail rings the Odd: it waits on the owner. */
export function railRing(n: OddNow): boolean {
  return WAITS_ON_OWNER[n.show.is];
}

/**
 * Every word a hand-off line can say, `to` being the colleague and `from` the
 * Odd that handed it on. One home, so a change of wording is one edit.
 */
export const HAND_OFF_WORDS = {
  // Back on it: the owner answered what an earlier step put on the desk.
  backOnIt: (to: string) => `${to} is back on it`,
  onIt: (to: string) => `${to} is on it`,
  // An earlier step came back, so the colleague has started; its next run has not begun.
  gettingBackToIt: (to: string) => `${to} is getting back to it`,
  notStarted: (to: string) => `${to} has not started yet`,
  answered: 'You answered',
  ended: {
    done: (to: string) => `${to} finished`,
    failed: (to: string) => `${to} could not finish`,
    waiting: (to: string) => `${to} is waiting on you`
  },
  takingOver: (ended: string, from: string) => `${ended} · ${from} is taking it from here`,
  waitingOnYou: 'Waiting on you',
  pickUpFailed: (from: string) => `${from} could not pick it up`,
  done: 'Done'
} as const;

/**
 * Where a hand-off stands, in words, and whether the owner has to act. The
 * colleague is on it only while a run serving the hand-off goes, which the
 * live state says; the row's status is as of the chat's last load.
 */
export function handOffWords(h: HandOffLine, onIt: boolean): { text: string; yours: boolean } {
  const W = HAND_OFF_WORDS;
  if (h.status === 'queued' || h.status === 'working') {
    const back = h.backs.length > 0;
    if (onIt) return { text: back ? W.backOnIt(h.to) : W.onIt(h.to), yours: false };
    return { text: back ? W.gettingBackToIt(h.to) : W.notStarted(h.to), yours: false };
  }
  // A denial or a dropped task is the owner's answer, not the colleague failing.
  const ended = h.answered ? W.answered : W.ended[h.status](h.to);
  const next = h.backs.at(-1)?.pickUp.status;
  if (!next || next === 'queued' || next === 'working')
    return { text: W.takingOver(ended, h.from), yours: h.status === 'waiting' };
  // Something of it on the desk outranks how the pick-up went: it still needs the
  // owner. A pick-up that ended waiting does not: that outcome never changes once
  // the run ends, and the thread's card reads the desk for what it still raised.
  if (h.status === 'waiting') return { text: W.waitingOnYou, yours: true };
  if (next === 'failed') return { text: W.pickUpFailed(h.from), yours: false };
  return { text: h.status === 'done' && next === 'done' ? W.done : ended, yours: false };
}

/**
 * A hand-off line in the chat, read from its colleague's state: on it while a
 * run serving the hand-off goes, its own or the carry-out of the owner's yes
 * to what it asked. A colleague who has left has no state, so it is on nothing.
 */
export function handOffProgress(
  h: HandOffLine,
  nowOf: ReaderProps['nowOf']
): { text: string; yours: boolean } {
  const onIt = nowOf(h.toId)?.runs.some((w) => w.handOffId === h.id) ?? false;
  return handOffWords(h, onIt);
}

/** What the page passes each screen that shows an Odd's state. */
export type ReaderProps = {
  /** This Odd's state. */
  now: OddNow;
  /** Any Odd's state, by id. Undefined for one the page does not hold, such as a colleague who has left. */
  nowOf: (id: string) => OddNow | undefined;
  desk: Desk;
  staff: StaffProfile[];
  onplan: (hires: AskRow[]) => void;
};

/** Any Odd's state by id, from a map of every Odd's; undefined for one the map does not hold. */
export const nowIn =
  (all: Record<string, OddNow>) =>
  (id: string): OddNow | undefined =>
    Object.hasOwn(all, id) ? all[id] : undefined;

/** The props for one Odd's screens, from the page's map of every Odd's state. */
export function readerProps(
  s: Snapshot,
  all: Record<string, OddNow>,
  id: string,
  onplan: (hires: AskRow[]) => void
): ReaderProps {
  return {
    now: all[id],
    nowOf: nowIn(all),
    desk: s.desk,
    staff: s.staff,
    onplan
  };
}
