// The rules for keeping, changing and undoing lessons, decided from the
// lessons alone. lessons.ts loads the lessons a command can touch, under the
// locks of their scopes, asks `decideLesson`, and writes what it says, all in
// one transaction (`transition`). Nothing here reads the database or the
// clock, so a test can drive every rule without either.
//
// Types only from modules that load db.ts, so this file stays pure
// (test/pure-modules.test.ts).
import type { LessonScope, WhyReplaced } from './lessons.ts';
import type { LessonHow, LessonStatus, lessons } from './schema.ts';
import type { After, Decided } from './transition.ts';

export type LessonRow = typeof lessons.$inferSelect;
/** A lesson as the decider writes it new: every field but the ones the database sets. */
type NewLesson = Omit<LessonRow, 'id' | 'createdAt'>;
/** The fields a change to a lesson may set. */
type LessonEdit = Partial<
  Pick<
    LessonRow,
    'text' | 'quote' | 'how' | 'appliesTo' | 'staffId' | 'replaces' | 'status' | 'missed'
  >
>;

/**
 * Live and waiting lessons an Odd may keep in one scope, so a run's prompt
 * stays short. A dropped guess does not count.
 */
export const LESSON_CAP = 25;
/** Days a guess waits for the owner's Keep before it drops. */
export const GUESS_DAYS = 7;
/** An open lesson: live in every run, or a guess waiting for the owner's Keep. */
export const OPEN_LESSON: readonly LessonStatus[] = ['live', 'waiting'];

/**
 * A guess the owner did not keep within GUESS_DAYS. It is worked out as the
 * lesson is read, so nothing runs on a timer to drop it, and Keep after all
 * still makes it live.
 */
export const dropped = (l: Pick<LessonRow, 'status' | 'createdAt'>, now: Date) =>
  l.status === 'waiting' && now.getTime() - l.createdAt.getTime() > GUESS_DAYS * 86_400_000;

/** What `plain` trims from both ends, once every run of whitespace is one space. */
const END_MARKS = ' .,!?;:';

/**
 * Words compared without case, spacing, quote marks or end punctuation. The
 * ends are trimmed with index loops: a regex anchored at the end retries at
 * every position, so a long run of marks costs time squared in its length.
 */
export const plain = (s: string) => {
  const c = s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/\s+/g, ' ');
  let start = 0;
  let end = c.length;
  while (start < end && END_MARKS.includes(c.charAt(start))) start++;
  while (end > start && END_MARKS.includes(c.charAt(end - 1))) end--;
  return c.slice(start, end);
};

/** Where a lesson applies, as its lines say it: nothing when it applies everywhere. */
export const onlyIn = (l: Pick<LessonRow, 'appliesTo'>) =>
  l.appliesTo ? ` (only in: ${l.appliesTo})` : '';

/** An Odd keeps a lesson it heard, once keepLesson has checked the owner's words. */
type KeepLesson = {
  kind: 'keep';
  heardBy: string;
  /** Who it is for: `heardBy`, or null for every Odd. */
  staffId: string | null;
  how: LessonHow;
  text: string;
  quote: string;
  /** Where it applies as stored, null for everywhere. */
  appliesTo: string | null;
  replaces?: number;
  whyReplaced?: WhyReplaced;
};

/** The owner changes a lesson: Keep, Undo, its words, its place or who it is for. */
type ChangeLesson = {
  kind: 'change';
  id: number;
  text?: string;
  /** Where it applies as stored, null for everywhere; left out, it stays. */
  appliesTo?: string | null;
  scope?: LessonScope;
  status?: Extract<LessonStatus, 'live' | 'undone'>;
};

export type LessonCommand = KeepLesson | ChangeLesson;

/** What a lesson command is decided on. */
export type LessonWork = {
  /** The open lessons of the scopes the command touches, and the lessons it names. */
  lessons: LessonRow[];
  /** The name of the Odd that heard the lesson, for the ledger. */
  heardByName: string;
};

/** What a lesson command writes. */
export type LessonChange = {
  /** The lesson the command answers with: a new one, one changed, or one left as it is. */
  lesson: { insert: NewLesson } | { update: number; set: LessonEdit } | { same: LessonRow };
  /** The lesson a lesson going live replaces, which stops while it is open. */
  stops: number | null;
  /** Lessons let go of, each live again while it is still replaced. */
  bringsBack: number[];
};

/** What the office does with a lesson command, decided from the lessons alone. */
export function decideLesson(
  work: LessonWork,
  command: LessonCommand,
  now: Date
): Decided<LessonChange> {
  switch (command.kind) {
    case 'keep':
      return keep(work, command, now);
    case 'change':
      return change(work, command, now);
    default: {
      const unknown: never = command;
      return unknown;
    }
  }
}

const isOpen = (l: LessonRow, now: Date) => OPEN_LESSON.includes(l.status) && !dropped(l, now);

const unchanged = (l: LessonRow): Decided<LessonChange> => ({
  change: { lesson: { same: l }, stops: null, bringsBack: [] },
  after: []
});

const forWhom = (l: Pick<LessonRow, 'staffId'>, work: LessonWork) =>
  l.staffId ? work.heardByName : 'every Odd';

/** The ledger keeps the owner's words, and how many times they had to give them. */
const taught = (l: NewLesson, work: LessonWork): After => ({
  record: {
    kind: 'decision',
    actor: 'owner',
    title: `Taught ${forWhom(l, work)}${l.missed ? `, told ${l.missed + 1} times now` : ''}: ${l.text}${onlyIn(l)}`,
    reason: l.quote
  }
});

/**
 * An Odd keeps a lesson. Only a `said` lesson changes one already there: a
 * guess with the same words and place returns that lesson as it is, and a new
 * guess replaces its lesson only once the owner keeps it, so nothing the Odd
 * inferred changes what the owner already taught.
 */
function keep(work: LessonWork, a: KeepLesson, now: Date): Decided<LessonChange> {
  const missedIt = a.whyReplaced === 'missed';
  let missed = 0;
  if (a.replaces) {
    const old = work.lessons.find((l) => l.id === a.replaces);
    if (!old || !isOpen(old, now) || (old.staffId && old.staffId !== a.heardBy))
      return { refused: `Lesson #${a.replaces} is not one of your current lessons.` };
    // Replacing it would stop it for every other Odd too.
    if (!old.staffId && a.staffId)
      return {
        refused: `Lesson #${a.replaces} is for every Odd, so a lesson only for you cannot replace it. Keep yours without replaces: the newer lesson wins for you.`
      };
    if (missedIt) missed = old.missed + 1;
  }
  const held = work.lessons.filter((l) => l.staffId === a.staffId && isOpen(l, now));
  const sameWords = held.filter((l) => plain(l.text) === plain(a.text));
  const same = sameWords.find((l) => plain(l.appliesTo ?? '') === plain(a.appliesTo ?? ''));
  if (same) {
    if (a.how !== 'said') return unchanged(same);
    const replaces = a.replaces && a.replaces !== same.id ? a.replaces : same.replaces;
    const nowSaid = same.status === 'waiting';
    if (!missedIt && !nowSaid && replaces === same.replaces) return unchanged(same);
    const set: LessonEdit = {
      replaces,
      // The quote that was heard is what makes it `said`, so it replaces the guessed one.
      ...(nowSaid ? { how: a.how, status: 'live', quote: a.quote } : {}),
      ...(missedIt ? { missed: same.missed + 1 } : {})
    };
    const row = { ...same, ...set };
    // Said, so it is live now, whether it was before or waited as a guess.
    return {
      change: { lesson: { update: same.id, set }, stops: row.replaces, bringsBack: [] },
      after: [taught(row, work)]
    };
  }
  // The same words for another place are another lesson, which replaces the
  // open one with those words (a live one first) as it goes live: at once when
  // said, on the owner's Keep when a guess. So narrowing or moving a lesson
  // leaves one place, not both.
  const moved = a.replaces
    ? undefined
    : (sameWords.find((l) => l.status === 'live') ?? sameWords[0]);
  const replacing = a.replaces ?? moved?.id ?? null;
  if (held.length >= LESSON_CAP && !replacing)
    return {
      refused: `${a.staffId ? 'You hold' : 'The office holds'} ${LESSON_CAP} lessons already. Pass replaces with the id of the one this covers, and why_replaced.`
    };
  const lesson: NewLesson = {
    staffId: a.staffId,
    heardBy: a.heardBy,
    text: a.text,
    quote: a.quote,
    appliesTo: a.appliesTo,
    how: a.how,
    status: a.how === 'said' ? 'live' : 'waiting',
    replaces: replacing,
    missed
  };
  if (lesson.status !== 'live')
    return { change: { lesson: { insert: lesson }, stops: null, bringsBack: [] }, after: [] };
  return {
    change: { lesson: { insert: lesson }, stops: replacing, bringsBack: [] },
    after: [taught(lesson, work)]
  };
}

/**
 * The owner changes a lesson. Their own changes are not capped. A lesson that
 * stops replacing another (Undo, or narrowed to one Odd) brings back the one
 * it replaced, while no other open lesson replaces that one.
 */
function change(work: LessonWork, p: ChangeLesson, now: Date): Decided<LessonChange> {
  const was = work.lessons.find((l) => l.id === p.id);
  if (!was) return { refused: `Lesson #${p.id} is not in the office.` };
  // A lesson for one Odd never replaces a lesson for every Odd, so narrowing
  // one lets go of the office-wide lesson it replaced.
  const old =
    p.scope === 'me' && was.replaces ? work.lessons.find((l) => l.id === was.replaces) : undefined;
  const letGo = old && !old.staffId ? old.id : undefined;
  const set: LessonEdit = {
    // The owner typed the new text, so it is their words now.
    ...(p.text ? { text: p.text, quote: p.text, how: 'said' } : {}),
    ...(p.appliesTo !== undefined ? { appliesTo: p.appliesTo } : {}),
    ...(p.scope ? { staffId: p.scope === 'everyone' ? null : was.heardBy } : {}),
    ...(letGo ? { replaces: null } : {}),
    ...(p.status ? { status: p.status } : {})
  };
  const row = { ...was, ...set };
  const goesLive = p.status === 'live' && was.status !== 'live';
  const after: After[] = [];
  if (goesLive) after.push(taught(row, work));
  else if (p.status === 'undone' && was.status === 'live')
    after.push({
      record: {
        kind: 'decision',
        actor: 'owner',
        title: `Took back a lesson for ${forWhom(was, work)}: ${was.text}`
      }
    });
  const undoneReplacing = p.status === 'undone' && was.replaces;
  const letsGo = [letGo, undoneReplacing ? was.replaces : undefined].filter(
    (id): id is number => !!id
  );
  const bringsBack = letsGo.filter(
    (id) => !work.lessons.some((l) => l.replaces === id && l.id !== p.id && isOpen(l, now))
  );
  if (!undoneReplacing && row.status === 'live' && (p.text || p.appliesTo !== undefined || p.scope))
    after.push({
      record: {
        kind: 'decision',
        actor: 'owner',
        title: `Changed a lesson, now for ${forWhom(row, work)}: ${row.text}${onlyIn(row)}`,
        reason: was.text === row.text ? null : `Was: ${was.text}`
      }
    });
  return {
    change: { lesson: { update: p.id, set }, stops: goesLive ? row.replaces : null, bringsBack },
    after
  };
}
