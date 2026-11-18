// Twin asks: which open asks one answer covers, and which of the asks one
// answer settled start a run. Pure, so a decider can read it without the
// database.
import { levelAtMost } from '../access-words.ts';
import type { AskRow } from '../office.ts';
import type { AskKind } from '../schema.ts';

/** How two open asks of one kind, from one Odd, are twins (`asksNoMore`). */
type Twin = {
  /** `later` asks for nothing `first` does not. */
  noMore: (first: AskRow, later: AskRow) => boolean;
  /** Both want the same thing, whatever the level, whichever was answered. */
  same: (a: AskRow, b: AskRow) => boolean;
};

/**
 * Whether `wide` holds every item `narrow` asks for: one switch or office
 * tool ask asking for no more than another. `noMore` and `same` both read it,
 * so which asks one answer settles and which of them stand for each other
 * cannot disagree.
 */
function holdsAll(wide: readonly string[] | null, narrow: readonly string[] | null): boolean {
  return (narrow ?? []).every((x) => wide?.includes(x));
}

/**
 * Which kinds of ask have twins, and how: an outside tool, a folder,
 * switches, a level and office tools. Two runs of one Odd can each find one
 * missing at once, and each raises its own ask. Every other kind is null: an
 * Odd's own words may not repeat (`raiseAsk`), and the office raises its own
 * once. A new kind fails the type check here until it says which.
 */
export const TWINS = {
  access: {
    // Asks for another Google account of one product are the same tool.
    noMore: (first, later) =>
      !!first.access &&
      !!later.access &&
      first.access.another === later.access.another &&
      (!!first.access.another || first.access.connector === later.access.connector) &&
      levelAtMost(later.access.level, first.access.level),
    same: (a, b) => a.access?.connector === b.access?.connector
  },
  folder: {
    noMore: (first, later) =>
      !!first.folder &&
      !!later.folder &&
      first.folder.path === later.folder.path &&
      (first.folder.level === 'write' || later.folder.level === 'read'),
    same: (a, b) => a.folder?.path === b.folder?.path
  },
  switch: {
    noMore: (first, later) => holdsAll(first.switches, later.switches),
    same: (a, b) => holdsAll(a.switches, b.switches) || holdsAll(b.switches, a.switches)
  },
  level: {
    noMore: (first, later) =>
      !!first.level && !!later.level && levelAtMost(later.level, first.level),
    same: () => true
  },
  office_tool: {
    noMore: (first, later) => holdsAll(first.officeTools, later.officeTools),
    same: (a, b) => holdsAll(a.officeTools, b.officeTools) || holdsAll(b.officeTools, a.officeTools)
  },
  approval: null,
  hire: null,
  goal: null,
  plan: null,
  hand_offs: null,
  window: null,
  reply: null,
  filter: null,
  call: null,
  remove: null,
  bring_back: null,
  catch_up: null,
  standing: null
} satisfies Record<AskKind, Twin | null>;

/** The kinds of ask that have twins (`TWINS`). */
export const TWINNED = (Object.keys(TWINS) as AskKind[]).filter((k) => TWINS[k] !== null);

/**
 * Whether `later` asks for nothing `first` does not: the same Odd, the same
 * kind, and nothing more of it (`TWINS`), such as the same tool or folder at
 * the same level or lower. A hire's first day and its lead's first hand-off
 * can each raise one at once. The owner sees the first alone (`desk`), and
 * their answer to it answers the twin too (`decide`), each back where it came
 * from.
 */
export function asksNoMore(first: AskRow, later: AskRow): boolean {
  if (first.id === later.id || first.staffId !== later.staffId || first.kind !== later.kind)
    return false;
  return TWINS[first.kind]?.noMore(first, later) ?? false;
}

/** Whether two asks of one kind want the same thing, whatever the level (`TWINS`). */
export const sameWanted = (a: AskRow, b: AskRow): boolean =>
  a.kind === b.kind && (TWINS[a.kind]?.same(a, b) ?? false);

/** A connection requested for later grants access without starting a second copy of the work. */
export const resumesWork = (ask: Pick<AskRow, 'access'>) => !ask.access?.connectOnly;

/**
 * Which of the asks one answer settled start a `carry_out`: one for each place
 * a result must go back to, never one per ask. A hand-off's twin comes first,
 * then a thread's; a twin on neither starts a run only when no other does.
 * Two runs of one Odd once each did the same work after one answer, and the
 * owner got every email reply twice.
 */
export function carriedOutBy(together: AskRow[]): AskRow[] {
  const rank = (a: AskRow) => (a.handOffId ? 0 : a.threadId ? 1 : 2);
  const places = new Set<string>();
  const runs: AskRow[] = [];
  for (const a of together.filter(resumesWork).sort((x, y) => rank(x) - rank(y) || x.id - y.id)) {
    const place = a.handOffId
      ? `hand-off ${a.handOffId}`
      : a.threadId
        ? `thread ${a.threadId}`
        : '';
    if (places.has(place) || (place === '' && runs.length)) continue;
    places.add(place);
    runs.push(a);
  }
  return runs;
}
