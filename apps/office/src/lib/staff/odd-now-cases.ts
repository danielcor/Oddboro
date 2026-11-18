// The names and builders the tests of an Odd's live state share: the event
// sequences in odd-now.test.ts and the rendered screens in
// odd-now-fixtures.test.ts. Test code only; it runs no test itself.
import type { Desk, HandOffLine } from '@oddboro/ledger';
import type { Work } from '#lib/staff/work.ts';

export const NAMES: Record<string, string> = { ada: 'Ada', bo: 'Bo', cy: 'Cy' };
export const IDS = Object.keys(NAMES);
export const nameOf = (id: string) => NAMES[id] ?? id;
/** A colleague who has left: the page holds no state for it. */
export const GONE = 'dee';

export const JOBS = ['Morning brief', 'Inbox sweep'];
/** A catch-up run, as job-brief.ts words one: its label is not the job's name. */
export const CATCH_UP = 'Catching up 2 periods of Morning brief';
/** A new hire's hello: a run through the slot, not a chat reply. */
export const HELLO = 'Saying hello';
export const HAND_OFF_LABEL = 'Plan the trip';
/** A carry-out of the owner's yes to an ask the colleague raised on a hand-off. */
export const CARRY_OUT_LABEL = 'Book the flights';

export const work = (id: number, label: string, more: Partial<Work> = {}): Work => ({
  id,
  kind: 'job',
  label,
  detail: 'A run',
  since: '2026-11-12T09:00:00.000Z',
  queued: true,
  steps: 0,
  ...more
});

/**
 * A Desk with only the asks and tasks. oddNow reads only each one's Odd; the
 * rest of a Desk is the server's, so it is left out here.
 */
export const deskOf = (
  asks: { id: number; staffId: string }[],
  tasks: { id: number; staffId: string | null }[]
) => ({ asks, tasks }) as unknown as Desk;

/** A hand-off Ada gave Bo, as the chat lists it; only the fields the words read matter. */
export const handOff = (more: Partial<HandOffLine>): HandOffLine => ({
  id: 7,
  threadId: 1,
  at: new Date('2026-11-12T09:00:00.000Z'),
  title: HAND_OFF_LABEL,
  brief: 'Plan it',
  from: 'Ada',
  to: 'Bo',
  fromId: 'ada',
  toId: 'bo',
  gave: true,
  status: 'working',
  answered: false,
  backs: [],
  ...more
});
