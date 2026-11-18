// Random runs of two Odds keeping lessons, and of the owner keeping and
// undoing them, through `decideLesson`. After each event the system's lessons
// are checked against the test's own record of what the rules say, built from
// the events alone, never from the system's answer. LESSON_SEEDS sets how many
// runs each rule gets; a failure names its seed and the shortest events that
// still break the rule. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideLesson,
  dropped,
  GUESS_DAYS,
  LESSON_CAP,
  OPEN_LESSON,
  type LessonChange,
  type LessonCommand,
  type LessonRow
} from '../src/lesson-rules.ts';
import type { WhyReplaced } from '../src/lessons.ts';
import type { LessonHow, LessonStatus } from '../src/schema.ts';
import { explore, type Explore } from '../src/sequences.ts';

const SEEDS = Number(process.env.LESSON_SEEDS ?? 150);
const LENGTH = 40;
const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 2);

const ODDS = ['ziva', 'jamal'] as const;
type Odd = (typeof ODDS)[number];
/** Few words and places, so the same words and place come round often. */
const WORDS = ['keep reports short', 'copy sam in', 'sign off as the office'];
const PLACES = [null, 'reports', 'mail'];

type Keep = {
  kind: 'keep';
  odd: Odd;
  scope: 'me' | 'everyone';
  how: LessonHow;
  words: string;
  place: string | null;
  replaces?: number;
  why?: WhyReplaced;
};
type Event =
  | Keep
  | { kind: 'owner keeps'; id: number }
  | { kind: 'owner undoes'; id: number }
  | { kind: 'a week passes' };

/** The system: its lessons, the clock, and the refusal of the last event, if any. */
type State = { lessons: LessonRow[]; now: number; refused?: string };

/** A lesson as the test's record holds it. */
type Noted = {
  id: number;
  staffId: string | null;
  words: string;
  place: string | null;
  status: LessonStatus;
  replaces: number | null;
  at: number;
};
/** The test's record: what the rules say is true after the events so far. */
type Expected = { lessons: Noted[]; now: number; refusedForCap: boolean };

const staffIdOf = (e: Keep) => (e.scope === 'me' ? e.odd : null);

function commandOf(e: Exclude<Event, { kind: 'a week passes' }>): LessonCommand {
  if (e.kind === 'owner keeps') return { kind: 'change', id: e.id, status: 'live' };
  if (e.kind === 'owner undoes') return { kind: 'change', id: e.id, status: 'undone' };
  return {
    kind: 'keep',
    heardBy: e.odd,
    staffId: staffIdOf(e),
    how: e.how,
    text: e.words,
    quote: e.words,
    appliesTo: e.place,
    replaces: e.replaces,
    whyReplaced: e.why
  };
}

/**
 * The change applied to the test's rows as lessons.ts writes it to the
 * database: a new lesson gets the next id, a stop happens only while the
 * lesson is open, and a bring-back only while it is replaced.
 */
function written(rows: LessonRow[], c: LessonChange, now: Date): LessonRow[] {
  const next = rows.map((l) => ({ ...l }));
  const l = c.lesson;
  if ('insert' in l) next.push({ ...l.insert, id: next.length + 1, createdAt: now });
  if ('update' in l) Object.assign(next[l.update - 1], l.set);
  const stopped = c.stops ? next[c.stops - 1] : undefined;
  if (stopped && (stopped.status === 'live' || stopped.status === 'waiting'))
    stopped.status = 'replaced';
  for (const id of c.bringsBack)
    if (next[id - 1].status === 'replaced') next[id - 1].status = 'live';
  return next;
}

function step(s: State, e: Event): State {
  if (e.kind === 'a week passes')
    return { lessons: s.lessons, now: s.now + (GUESS_DAYS + 1) * DAY };
  const now = new Date(s.now);
  const decided = decideLesson({ lessons: s.lessons, heardByName: 'an Odd' }, commandOf(e), now);
  if ('refused' in decided) return { lessons: s.lessons, now: s.now, refused: decided.refused };
  return { lessons: written(s.lessons, decided.change, now), now: s.now };
}

// The record, from the rules as the owner reads them. It shares no code with
// the decider.

const isOpenNoted = (r: Expected, l: Noted) =>
  l.status === 'live' || (l.status === 'waiting' && r.now - l.at <= GUESS_DAYS * DAY);

/** A lesson going live stops the lesson it replaces, if that one is still open. */
function stop(r: Expected, id: number | null) {
  const old = id === null ? undefined : r.lessons[id - 1];
  if (old && (old.status === 'live' || old.status === 'waiting')) old.status = 'replaced';
}

function noteKeep(r: Expected, e: Keep) {
  const staffId = staffIdOf(e);
  const named = e.replaces === undefined ? undefined : r.lessons[e.replaces - 1];
  // An Odd replaces only an open lesson it follows, and never one for every
  // Odd with one only for itself.
  if (named && (!isOpenNoted(r, named) || (named.staffId !== null && named.staffId !== e.odd)))
    return;
  if (named && named.staffId === null && staffId !== null) return;
  const held = r.lessons.filter((l) => l.staffId === staffId && isOpenNoted(r, l));
  const same = held.find((l) => l.words === e.words && l.place === e.place);
  if (same) {
    // A guess the same as a lesson there changes nothing. Said, it goes live
    // and takes the lesson it names as the one it replaces.
    if (e.how !== 'said') return;
    const replaces = named && named !== same ? named.id : same.replaces;
    if (e.why !== 'missed' && same.status === 'live' && replaces === same.replaces) return;
    same.replaces = replaces;
    same.status = 'live';
    stop(r, replaces);
    return;
  }
  // The same words for another place replace that lesson, a live one first.
  const sameWords = held.filter((l) => l.words === e.words);
  const moved = named ? undefined : (sameWords.find((l) => l.status === 'live') ?? sameWords[0]);
  const replaces = named?.id ?? moved?.id ?? null;
  if (replaces === null && held.length >= LESSON_CAP) {
    r.refusedForCap = true;
    return;
  }
  const status = e.how === 'said' ? 'live' : 'waiting';
  r.lessons.push({
    id: r.lessons.length + 1,
    staffId,
    words: e.words,
    place: e.place,
    status,
    replaces,
    at: r.now
  });
  if (status === 'live') stop(r, replaces);
}

function note(r: Expected, e: Event) {
  r.refusedForCap = false;
  if (e.kind === 'a week passes') r.now += (GUESS_DAYS + 1) * DAY;
  else if (e.kind === 'keep') noteKeep(r, e);
  else if (e.kind === 'owner keeps') {
    const kept = r.lessons[e.id - 1];
    kept.status = 'live';
    stop(r, kept.replaces);
  } else {
    // Undo brings back the lesson it replaced, unless another open lesson replaces it.
    const undone = r.lessons[e.id - 1];
    undone.status = 'undone';
    const old = undone.replaces === null ? undefined : r.lessons[undone.replaces - 1];
    const stillReplaced = r.lessons.some(
      (l) => l !== undone && l.replaces === old?.id && isOpenNoted(r, l)
    );
    if (old?.status === 'replaced' && !stillReplaced) old.status = 'live';
  }
}

function next(r: Expected): Event[] {
  const events: Event[] = [{ kind: 'a week passes' }];
  for (const odd of ODDS)
    for (const how of ['said', 'inferred'] as const) {
      for (const scope of ['me', 'everyone'] as const)
        for (const words of WORDS)
          for (const place of PLACES) events.push({ kind: 'keep', odd, scope, how, words, place });
      // Each open lesson the Odd follows, replaced by other words, or by the
      // same words after the owner had to say them again.
      for (const l of r.lessons) {
        if (!(l.status === 'live' || l.status === 'waiting')) continue;
        if (l.staffId !== null && l.staffId !== odd) continue;
        const scope = l.staffId === null ? 'everyone' : 'me';
        const other = WORDS[(WORDS.indexOf(l.words) + 1) % WORDS.length];
        const at = { kind: 'keep', odd, scope, how, place: l.place, replaces: l.id } as const;
        events.push(
          { ...at, words: other, why: 'refined' },
          { ...at, words: l.words, why: 'missed' }
        );
      }
    }
  for (const l of r.lessons) {
    if (l.status === 'waiting') events.push({ kind: 'owner keeps', id: l.id });
    if (l.status === 'live' || l.status === 'waiting')
      events.push({ kind: 'owner undoes', id: l.id });
  }
  return events;
}

/**
 * A run starts with each scope empty or a few lessons short of the cap, kept
 * by the same events a run sends, so runs reach the cap often.
 */
function start(rnd: () => number): { state: State; record: Expected } {
  let state: State = { lessons: [], now: START };
  const record: Expected = { lessons: [], now: START, refusedForCap: false };
  const scopes = [
    ['ziva', 'me'],
    ['jamal', 'me'],
    ['ziva', 'everyone']
  ] as const;
  for (const [odd, scope] of scopes) {
    const held = rnd() < 0.5 ? 0 : LESSON_CAP - Math.floor(rnd() * 3);
    for (let i = 0; i < held; i++) {
      const e: Keep = { kind: 'keep', odd, scope, how: 'said', words: `rule ${i}`, place: null };
      state = step(state, e);
      note(record, e);
    }
  }
  return { state, record };
}

type Rule = (s: State, r: Expected, e: Event) => string | undefined;

/** The detail of a broken rule: what the system holds against what the record says. */
const unequal = (system: unknown, record: unknown) => {
  const [a, b] = [JSON.stringify(system), JSON.stringify(record)];
  return a === b ? undefined : `the system has ${a}, the record says ${b}`;
};

const live = <L extends { status: LessonStatus }>(rows: L[]) =>
  rows.filter((l) => l.status === 'live');
/** Each words and place held by more than one live lesson in the rows. */
const twice = (rows: { words: string; place: string | null }[]) => {
  const keys = rows.map((l) => `${l.words} @ ${l.place ?? 'everywhere'}`).sort();
  return [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
};
const asNoted = (l: LessonRow) => ({ ...l, words: l.text, place: l.appliesTo });

const RULES: [string, Rule][] = [
  [
    "an Odd's keeping never leaves two live lessons with the same words for the same place in one scope",
    (s, r, e) => {
      if (e.kind !== 'keep') return undefined;
      const inScope = <L extends { staffId: string | null }>(rows: L[]) =>
        rows.filter((l) => l.staffId === staffIdOf(e));
      return unequal(twice(live(inScope(s.lessons)).map(asNoted)), twice(live(inScope(r.lessons))));
    }
  ],
  [
    'Undo brings back the lesson it replaced, unless another open lesson replaces that one',
    (s, r, e) => {
      if (e.kind !== 'owner undoes') return undefined;
      const old = r.lessons[e.id - 1].replaces;
      return unequal(
        old && { id: old, status: s.lessons[old - 1].status },
        old && { id: old, status: r.lessons[old - 1].status }
      );
    }
  ],
  [
    'a guess never changes or stops a live lesson until the owner keeps it',
    (s, r, e) => {
      if (e.kind !== 'keep' || e.how !== 'inferred') return undefined;
      const shown = (l: Omit<Noted, 'at'>) => [l.id, l.staffId, l.words, l.place, l.replaces];
      return unequal(live(s.lessons).map(asNoted).map(shown), live(r.lessons).map(shown));
    }
  ],
  [
    "an Odd's own keeping never takes a scope past LESSON_CAP open lessons",
    (s, r, e) => {
      if (e.kind !== 'keep') return undefined;
      const open = s.lessons.filter(
        (l) =>
          l.staffId === staffIdOf(e) &&
          OPEN_LESSON.includes(l.status) &&
          !dropped(l, new Date(s.now))
      );
      const noted = r.lessons.filter((l) => l.staffId === staffIdOf(e) && isOpenNoted(r, l));
      return unequal(
        { open: open.length, refusedForCap: !!s.refused?.includes(`${LESSON_CAP} lessons`) },
        { open: noted.length, refusedForCap: r.refusedForCap }
      );
    }
  ]
];

for (const [rule, broken] of RULES)
  test(rule, () => {
    const lessons: Explore<State, Event, Expected> = {
      start,
      next,
      step,
      note,
      broken: (s, r, events) => {
        const detail = broken(s, r, events[events.length - 1]);
        return detail ? [{ rule, detail }] : [];
      }
    };
    const failed = explore(lessons, { seeds: SEEDS, length: LENGTH });
    assert.equal(
      failed,
      undefined,
      failed && `seed ${failed.seed}: ${failed.detail}\n${JSON.stringify(failed.events, null, 1)}`
    );
  });
