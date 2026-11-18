// Lessons: anything the owner says or fixes once, every Odd it covers acts on
// from then on. An Odd keeps one when it hears a correction; the office loads
// the live ones into every run, and the owner sees, edits or takes back each.
// An Odd also reads the owner's edits to its files for one (`learnFromEdit`).
import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  or,
  sql,
  type SQL
} from 'drizzle-orm';
import { db } from './db.ts';
import {
  decideLesson,
  dropped,
  OPEN_LESSON,
  onlyIn,
  plain,
  type LessonChange,
  type LessonCommand,
  type LessonRow,
  type LessonWork
} from './lesson-rules.ts';
import { anyStaffer } from './office.ts';
import {
  attachments,
  followUps,
  lessonUses,
  lessons,
  type FileEdit,
  type FollowUpKind,
  type LessonHow,
  type LessonStatus
} from './schema.ts';
import type { Tx } from './threads.ts';
import { transitionWork } from './work/apply.ts';
import { transition } from './transition.ts';

export { GUESS_DAYS, LESSON_CAP, type LessonRow } from './lesson-rules.ts';
/** How often a lesson changed one Odd's work. */
export type LessonUse = Pick<typeof lessonUses.$inferSelect, 'uses' | 'lastUsedAt'>;
/** How a lesson reads: its status, or `dropped` for a guess the owner did not keep in time. */
export type LessonState = LessonStatus | 'dropped';
/** A lesson as one Odd follows it, with that Odd's own uses. */
export type TaughtLesson = Omit<LessonRow, 'status'> & { status: LessonState } & LessonUse;
/** A lesson as the owner sees it in an Odd's chat. */
export type LessonLine = Pick<
  TaughtLesson,
  'id' | 'text' | 'quote' | 'appliesTo' | 'how' | 'status' | 'staffId' | 'missed'
>;
/** Who a lesson is for: the Odd that heard it, or every Odd. */
export type LessonScope = 'me' | 'everyone';
/**
 * The owner's words a run carries, and where they came from: their chat
 * message, their note on an ask or a task, or their version of a file they
 * edited. The office sets them, never the Odd.
 */
export type OwnerWords = { text: string; from: 'chat' | 'note' | 'edit' };
/**
 * Why a new lesson replaces an old one: `missed` when the owner had to say
 * again what the old one covered, `refined` when they changed what they want.
 */
export const WHY_REPLACED = ['missed', 'refined'] as const;
export type WhyReplaced = (typeof WHY_REPLACED)[number];

/** An Odd says a lesson changed its work this many times, then stops saying so. */
export const CITE_FIRST = 3;
/** A quote this short could be found in almost anything the owner wrote. */
export const QUOTE_MIN_WORDS = 3;
/** Where a lesson applies is a few plain words, like "reports" or "family plans". */
export const APPLIES_TO_MAX = 60;

/**
 * A live lesson as a run's prompt lists it, kept on `day`. The office fills
 * in `{owner}` with the owner's name, as it does for the whole prompt.
 */
export const lessonLine = (
  l: Pick<LessonRow, 'id' | 'staffId' | 'text' | 'appliesTo' | 'quote'>,
  day: string
) =>
  `- #${l.id}, ${day}, ${l.staffId ? 'for you' : 'for every Odd'}: ${l.text}${onlyIn(l)} ({owner}: "${l.quote}")`;

/** Where a lesson applies as stored: trimmed, and null for everywhere. */
const place = (appliesTo: string | null | undefined) => appliesTo?.trim() || null;

/** How much of each version of an edited file the Odd reading the edit sees. */
export const EDIT_CHARS = 8000;
/** Context kept before the first change, so the Odd sees where it falls. */
const EDIT_LEAD = 500;

/** Both versions of an edited file as the Odd reading the edit sees them. */
export type EditShown = { from: number; before: string; now: string };

/**
 * Both versions cut to EDIT_CHARS, from a little before the first change, so
 * an edit far down a long file still shows. `from` is where both start.
 */
export function editShown(before: string, now: string): EditShown {
  let same = 0;
  while (same < before.length && before[same] === now[same]) same++;
  const from = Math.max(0, same - EDIT_LEAD);
  return {
    from,
    before: before.slice(from, from + EDIT_CHARS),
    now: now.slice(from, from + EDIT_CHARS)
  };
}

/** Words alone: no case, quote marks or punctuation, one space between. */
const wordsOf = (s: string) =>
  plain(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Whether `quote` is the owner's own words: at least QUOTE_MIN_WORDS whole
 * words, found in that order in what they said this run.
 */
export function heardIn(quote: string, words: string | undefined): boolean {
  const q = wordsOf(quote);
  return (
    !!words && q.split(' ').length >= QUOTE_MIN_WORDS && ` ${wordsOf(words)} `.includes(` ${q} `)
  );
}

/**
 * A lesson that replaces another says why, and only one that replaces says
 * why, so the Odd has to choose whether it missed the old one.
 */
export function replacingProblem(a: {
  replaces?: number;
  whyReplaced?: WhyReplaced;
}): string | undefined {
  if (a.replaces && !a.whyReplaced)
    return `Say why it replaces lesson #${a.replaces}: why_replaced is missed or refined.`;
  if (!a.replaces && a.whyReplaced)
    return 'Pass replaces with the id of the lesson this one replaces.';
}

/**
 * How a lesson is kept, and who it is for. It is `said` only when the Odd says
 * so and the quote is in the owner's words this run carried; anything else
 * waits as `inferred`. Words from an edit make only a guess, for the Odd that
 * read it, whatever the Odd asked: the owner changed a file and stated no
 * rule, so what the change means is the Odd's reading until they keep it.
 */
export function keptAs(
  heardBy: string,
  a: { how: LessonHow; scope: LessonScope; quote: string; ownerWords?: OwnerWords }
): { how: LessonHow; staffId: string | null } {
  const edit = a.ownerWords?.from === 'edit';
  return {
    how: !edit && a.how === 'said' && heardIn(a.quote, a.ownerWords?.text) ? 'said' : 'inferred',
    staffId: !edit && a.scope === 'everyone' ? null : heardBy
  };
}

/**
 * Whether a follow-up's `note` is the owner's own words, which a lesson may
 * quote (`OWNER_NOTE`). A hand-off's note is the colleague's brief, a
 * hand-back's is the colleague's result, and a hub's pick-up joins the
 * office's lines around each answer.
 */
export const NOTE_IS_OWNERS: Record<FollowUpKind, boolean> = {
  carry_out: true,
  rework: true,
  denied: true,
  task_done: true,
  goal: true,
  first_day: true,
  hand_off: false,
  handed_back: false,
  resume: false,
  // An answer's note joins the office's lines around each answer, as a pick-up's does.
  answered: false,
  // An edit's words go as OWNER_EDIT, which makes only guesses.
  edited: false
};

/** The owner's note a follow-up run carries as `OWNER_NOTE`, when the note is theirs. */
export const ownerNoteOf = (f: { kind: FollowUpKind; note: string | null }) =>
  NOTE_IS_OWNERS[f.kind] ? (f.note ?? undefined) : undefined;

const followedBy = (staffId: string) => or(eq(lessons.staffId, staffId), isNull(lessons.staffId));

/** The lessons a run follows: live, for this Odd or every Odd, newest first. */
export async function liveLessons(staffId: string): Promise<LessonRow[]> {
  return db
    .select()
    .from(lessons)
    .where(and(followedBy(staffId), eq(lessons.status, 'live')))
    .orderBy(desc(lessons.createdAt));
}

/**
 * Every lesson for this Odd or every Odd, whatever its status, newest first,
 * with this Odd's uses. That includes every lesson it heard, which is always
 * for it or for everyone. A guess past GUESS_DAYS reads as `dropped`.
 */
export async function lessonsOf(staffId: string): Promise<TaughtLesson[]> {
  const rows = await db
    .select({
      ...getTableColumns(lessons),
      uses: sql<number>`coalesce(${lessonUses.uses}, 0)`.mapWith(Number),
      lastUsedAt: lessonUses.lastUsedAt
    })
    .from(lessons)
    .leftJoin(lessonUses, and(eq(lessonUses.lessonId, lessons.id), eq(lessonUses.staffId, staffId)))
    .where(followedBy(staffId))
    .orderBy(desc(lessons.createdAt));
  const now = new Date();
  return rows.map((l) => (dropped(l, now) ? { ...l, status: 'dropped' as const } : l));
}

/** A lesson in the Lessons window: how often it changed each Odd's work, and in all. */
export type LibraryLesson = LessonRow & LessonUse & { usesBy: Record<string, LessonUse> };

/**
 * Everything the office knows about the owner, for the Lessons window: every
 * open lesson, for one Odd or every Odd, guesses waiting for their Keep first,
 * each group newest first, with each Odd's uses and the total. A guess past
 * GUESS_DAYS, an undone lesson and a replaced one are left out.
 */
export async function libraryLessons(): Promise<LibraryLesson[]> {
  const [rows, uses] = await Promise.all([
    db
      .select()
      .from(lessons)
      .where(inArray(lessons.status, OPEN_LESSON))
      .orderBy(desc(lessons.createdAt)),
    db.select().from(lessonUses)
  ]);
  return openGuessesFirst(rows).map((l) => {
    const mine = uses.filter((u) => u.lessonId === l.id);
    const last = mine.map((u) => u.lastUsedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    return {
      ...l,
      uses: mine.reduce((n, u) => n + u.uses, 0),
      lastUsedAt: last ? new Date(last) : null,
      usesBy: Object.fromEntries(
        mine.map((u) => [u.staffId, { uses: u.uses, lastUsedAt: u.lastUsedAt }])
      )
    };
  });
}

/** How far the page has been told: the newest lesson kept and the newest use. */
export type LessonMark = { kept: number; used: Date | null };
/** A lesson an Odd kept (the Odd that heard it), or an Odd's use of one. */
export type LessonNews = { kind: 'kept' | 'used'; staff: string; lesson: number };

/** Where the news starts as the office starts, so a restart tells nothing again. */
export async function lessonMark(): Promise<LessonMark> {
  const [[k], [u]] = await Promise.all([
    db.select({ kept: max(lessons.id) }).from(lessons),
    db.select({ used: max(lessonUses.lastUsedAt) }).from(lessonUses)
  ]);
  return { kept: k?.kept ?? 0, used: u?.used ?? null };
}

/**
 * Each lesson row and each use newer than `mark`, and the mark after them.
 * The owner's changes (Keep, Undo, an edit) write no new row and no use, so
 * they are never news. Uses one Odd makes of one lesson between two reads
 * share one row, so they are one piece of news.
 */
export async function lessonNewsSince(
  mark: LessonMark
): Promise<{ news: LessonNews[]; mark: LessonMark }> {
  const [kept, used] = await Promise.all([
    db
      .select({ id: lessons.id, heardBy: lessons.heardBy })
      .from(lessons)
      .where(gt(lessons.id, mark.kept))
      .orderBy(lessons.id),
    db
      .select()
      .from(lessonUses)
      .where(mark.used ? gt(lessonUses.lastUsedAt, mark.used) : isNotNull(lessonUses.lastUsedAt))
      .orderBy(lessonUses.lastUsedAt)
  ]);
  return {
    news: [
      ...kept.map((l) => ({ kind: 'kept' as const, staff: l.heardBy, lesson: l.id })),
      ...used.map((u) => ({ kind: 'used' as const, staff: u.staffId, lesson: u.lessonId }))
    ],
    mark: {
      kept: kept.at(-1)?.id ?? mark.kept,
      used: used.at(-1)?.lastUsedAt ?? mark.used
    }
  };
}

/**
 * The lessons a list shows, from rows newest first: live ones and guesses
 * waiting for the owner's Keep, guesses first. A dropped guess is left out.
 */
export function openGuessesFirst<T extends { status: LessonState; createdAt: Date }>(
  rows: T[]
): T[] {
  const now = new Date();
  return (
    rows
      .filter(
        (l) =>
          l.status !== 'dropped' &&
          OPEN_LESSON.includes(l.status) &&
          !dropped({ status: l.status, createdAt: l.createdAt }, now)
      )
      // Stable, so each group stays newest first.
      .sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting'))
  );
}

/** How many guesses wait for the owner's Keep on each Odd's Lessons tab: its own and every Odd's. */
export async function guessesWaiting(staffIds: string[]): Promise<Record<string, number>> {
  const now = new Date();
  const waiting = (
    await db
      .select({ staffId: lessons.staffId, status: lessons.status, createdAt: lessons.createdAt })
      .from(lessons)
      .where(eq(lessons.status, 'waiting'))
  ).filter((l) => !dropped(l, now));
  return Object.fromEntries(
    staffIds.map((id) => [id, waiting.filter((l) => !l.staffId || l.staffId === id).length])
  );
}

export async function lesson(id: number): Promise<LessonRow | undefined> {
  const [row] = await db.select().from(lessons).where(eq(lessons.id, id));
  return row;
}

/**
 * Locks both scopes a lesson the Odd `heardBy` heard can sit in: its own and
 * every Odd's. One lesson command can write both, as when Undo on a lesson
 * for every Odd brings back the Odd's own lesson it replaced, so every lesson
 * command takes both, sorted, and two commands take them in one order. These
 * are locks per scope, outside LOCK_ORDER's table order: no lesson command
 * takes a table row lock or nests inside another transition, so they cannot
 * deadlock against one that does.
 */
async function lockScopes(tx: Tx, heardBy: string): Promise<void> {
  for (const scope of [heardBy, 'everyone'].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lessons:${scope}`}))`);
}

/**
 * Runs one lesson command through `transition`: under the locks of the scopes
 * of the Odd that heard the lesson, it loads their open lessons and the ones
 * the command names (`named`), oldest first, decides, and writes. Returns the
 * lesson the command answers with, or why it was refused.
 */
async function runLesson(
  command: LessonCommand,
  heardByOf: (tx: Tx) => Promise<string | undefined>,
  named: SQL | undefined
): Promise<LessonRow | { refused: string }> {
  const written: { lesson?: LessonRow } = {};
  const decided = await transition({
    name: command.kind === 'keep' ? 'keepLesson' : 'changeLesson',
    load: async (tx): Promise<LessonWork> => {
      const heardBy = await heardByOf(tx);
      if (!heardBy) return { lessons: [], heardByName: '' };
      await lockScopes(tx, heardBy);
      return {
        lessons: await tx
          .select()
          .from(lessons)
          .where(or(and(followedBy(heardBy), inArray(lessons.status, OPEN_LESSON)), named))
          .orderBy(lessons.id),
        heardByName: (await anyStaffer(heardBy, tx))?.name ?? heardBy
      };
    },
    decide: (work, now) => decideLesson(work, command, now),
    apply: async (tx, change) => {
      written.lesson = await writeLesson(tx, change);
    }
  });
  if ('refused' in decided) return decided;
  // apply sets it, and the shell runs apply whenever the decider did not refuse.
  return written.lesson as LessonRow;
}

/** Writes a decided lesson change, and returns the lesson it answers with. */
async function writeLesson(tx: Tx, c: LessonChange): Promise<LessonRow> {
  const l = c.lesson;
  const [row] =
    'insert' in l
      ? await tx.insert(lessons).values(l.insert).returning()
      : 'update' in l
        ? await tx.update(lessons).set(l.set).where(eq(lessons.id, l.update)).returning()
        : [l.same];
  if (c.stops)
    await tx
      .update(lessons)
      .set({ status: 'replaced' })
      .where(and(eq(lessons.id, c.stops), inArray(lessons.status, OPEN_LESSON)));
  for (const id of c.bringsBack)
    await tx
      .update(lessons)
      .set({ status: 'live' })
      .where(and(eq(lessons.id, id), eq(lessons.status, 'replaced')));
  return row;
}

/**
 * An Odd keeps a lesson it heard. It is `said` only when the quote is in the
 * owner's words this run carried; otherwise it waits for the owner's Keep.
 * A run with none of their words keeps nothing: waiting lessons count toward
 * the cap, so guesses from an email or a page could crowd out the owner's own.
 * Only a `said` lesson changes one already there (`decideLesson`).
 * Returns the lesson, or why it was not kept.
 */
export async function keepLesson(
  heardBy: string,
  a: {
    text: string;
    quote: string;
    how: LessonHow;
    scope: LessonScope;
    /** Where it applies, in a few plain words; left out, it applies everywhere. */
    appliesTo?: string;
    replaces?: number;
    /** Given exactly when `replaces` is. */
    whyReplaced?: WhyReplaced;
    /** The owner's words this run carries. */
    ownerWords: OwnerWords | undefined;
  }
): Promise<LessonRow | { problem: string }> {
  if (!a.ownerWords?.text.trim())
    return {
      problem:
        "Lessons come only from the owner's own words in a chat, a note or an edit, and this run carries none, so tell the owner in your reply instead."
    };
  // The chat shows the quote as the owner's words, so one read from an edit
  // has to be in the file as they saved it.
  if (a.ownerWords.from === 'edit' && !heardIn(a.quote, a.ownerWords.text))
    return {
      problem: `Quote ${QUOTE_MIN_WORDS} or more words in a row from the file as it is now, or keep nothing.`
    };
  const problem = replacingProblem(a);
  if (problem) return { problem };
  const { how, staffId } = keptAs(heardBy, a);
  const kept = await runLesson(
    {
      kind: 'keep',
      heardBy,
      staffId,
      how,
      text: a.text.trim(),
      quote: a.quote.trim(),
      appliesTo: place(a.appliesTo),
      replaces: a.replaces,
      whyReplaced: a.whyReplaced
    },
    async () => heardBy,
    // The lesson it replaces may be for another Odd, which the decider refuses.
    a.replaces ? eq(lessons.id, a.replaces) : undefined
  );
  return 'refused' in kept ? { problem: kept.refused } : kept;
}

/**
 * The owner changes a lesson: Keep one that waits, Undo one, reword it, say
 * where it applies (null or empty for everywhere), or widen or narrow who it
 * is for. Returns the lesson as it stands.
 */
export async function changeLesson(
  id: number,
  patch: {
    text?: string;
    appliesTo?: string | null;
    scope?: LessonScope;
    status?: Extract<LessonStatus, 'live' | 'undone'>;
  }
): Promise<LessonRow | undefined> {
  const changed = await runLesson(
    {
      kind: 'change',
      id,
      text: patch.text?.trim() || undefined,
      appliesTo: patch.appliesTo === undefined ? undefined : place(patch.appliesTo),
      scope: patch.scope,
      status: patch.status
    },
    // Who heard a lesson never changes, so it is safe to read before the locks.
    async (tx) =>
      (await tx.select({ heardBy: lessons.heardBy }).from(lessons).where(eq(lessons.id, id)))[0]
        ?.heardBy,
    // The lesson and the one it replaces, which is no longer open.
    or(
      eq(lessons.id, id),
      eq(lessons.id, sql`(select ${lessons.replaces} from ${lessons} where ${lessons.id} = ${id})`)
    )
  );
  return 'refused' in changed ? undefined : changed;
}

/** An Odd says a live lesson it follows changed its work. Returns it with that Odd's count. */
export async function usedLesson(id: number, staffId: string): Promise<TaughtLesson | undefined> {
  const [l] = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.id, id), eq(lessons.status, 'live'), followedBy(staffId)));
  if (!l) return undefined;
  const now = new Date();
  const [use] = await db
    .insert(lessonUses)
    .values({ staffId, lessonId: id, uses: 1, lastUsedAt: now })
    .onConflictDoUpdate({
      target: [lessonUses.staffId, lessonUses.lessonId],
      set: { uses: sql`${lessonUses.uses} + 1`, lastUsedAt: now }
    })
    .returning();
  return { ...l, uses: use.uses, lastUsedAt: use.lastUsedAt };
}

/**
 * The owner saved an edit to an Odd's file: start one `edited` run for the
 * Odd to read it for a lesson. `before` is the file just before the save.
 * A save while a run for that file has not finished starts nothing: one yet
 * to start keeps the earlier `before` and reads the newest version when it
 * starts, and once one under way ends, the office calls this again with the
 * version it read, so a save made meanwhile starts one more. A file on a task
 * is a form the owner filled in, not a correction, and an unchanged file says
 * nothing, and neither does a save to a file of an Odd that left. Returns
 * whether it started one.
 */
export async function learnFromEdit(
  staffId: string,
  edit: FileEdit,
  after: string
): Promise<boolean> {
  if (edit.before === after) return false;
  const [onTask] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.staffId, staffId),
        eq(attachments.path, edit.path),
        isNotNull(attachments.taskId)
      )
    );
  if (onTask) return false;
  const [unfinished] = await db
    .select({ id: followUps.id })
    .from(followUps)
    .where(
      and(
        eq(followUps.staffId, staffId),
        eq(followUps.kind, 'edited'),
        isNull(followUps.outcome),
        sql`${followUps.edit}->>'path' = ${edit.path}`
      )
    );
  if (unfinished) return false;
  // The decider owes an Odd that left nothing, and puts no row then.
  const went = await transitionWork({
    kind: 'runQueued',
    run: { staffId, kind: 'edited', edit, note: null }
  });
  return 'change' in went && went.change.put.length > 0;
}
