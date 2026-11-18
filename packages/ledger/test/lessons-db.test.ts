// Keeping, changing and using lessons: the office's own code on every
// migration, in an in-memory PGlite that stands in for db.ts (pglite.ts). Run
// with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import type { Transaction } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { followUps, staff, threads } from '../src/schema.ts';
// A type alone: the module itself loads below, once db.ts is this database.
import type { LessonRow } from '../src/lessons.ts';
import { db, sql } from './pglite.ts';

const L = await import('../src/lessons.ts');
const O = await import('../src/office.ts');
const H = await import('../src/hand-offs.ts');
const { HAND_OFF_LIMIT } = await import('../src/threads.ts');

await db.insert(staff).values(
  ['ziva', 'jamal'].map((id) => ({
    id,
    name: id === 'ziva' ? 'Ziva' : 'Jamal',
    role: 'r',
    variant: 'v',
    portrait: 'p',
    remit: 'r',
    desk: 'd'
  }))
);

beforeEach(async () => {
  await sql`delete from lesson_uses`;
  await sql`delete from lessons`;
  await sql`delete from ledger`;
});

type Keep = Parameters<typeof L.keepLesson>[1];
/** A lesson the owner said outright: the quote is their whole message. */
const say = (heardBy: string, text: string, more: Partial<Keep> = {}) =>
  L.keepLesson(heardBy, {
    text,
    quote: text,
    how: 'said',
    scope: 'me',
    ownerWords: { text, from: 'chat' },
    ...more
  });
/** A lesson kept, or the test fails with why it was not. */
async function kept(p: ReturnType<typeof say>): Promise<LessonRow> {
  const r = await p;
  if ('problem' in r) assert.fail(r.problem);
  return r;
}
const statusOf = async (id: number) => (await L.lesson(id))?.status;
const titles = async () =>
  (await sql<{ title: string }>`select title from ledger order by id`).map((r) => r.title);
/** Moves a lesson back in time, as if the Odd kept it this many days ago. */
const age = (id: number, days: number) =>
  sql`update lessons set created_at = now() - make_interval(days => ${days}::int) where id = ${id}`;
/** A lesson the Odd guessed, waiting for the owner's Keep. */
const guess = (heardBy: string, text: string, more: Partial<Keep> = {}) =>
  kept(say(heardBy, text, { how: 'inferred', ...more }));

test('a run that carries none of the owner words keeps no lesson', async () => {
  for (const text of [undefined, '', '  ']) {
    const ownerWords = text === undefined ? undefined : { text, from: 'chat' as const };
    const r = await say('ziva', 'keep reports to three lines', { how: 'inferred', ownerWords });
    assert.ok('problem' in r);
    assert.match(r.problem, /tell the owner in your reply/);
  }
  assert.equal((await sql`select 1 from lessons`).length, 0);
});

test('an Odd cannot replace a lesson another Odd keeps for itself', async () => {
  const z = await kept(say('ziva', 'keep reports to three lines'));
  const r = await say('jamal', 'keep reports to five lines', {
    replaces: z.id,
    whyReplaced: 'refined'
  });
  assert.ok('problem' in r);
  assert.equal(await statusOf(z.id), 'live');
});

test('a lesson for one Odd cannot replace a lesson for every Odd', async () => {
  const all = await kept(say('ziva', 'start every report with the date', { scope: 'everyone' }));
  const r = await say('jamal', 'start my reports with the time', {
    replaces: all.id,
    whyReplaced: 'refined'
  });
  assert.ok('problem' in r);
  assert.match(r.problem, /without replaces/);
  assert.equal(await statusOf(all.id), 'live');
  assert.deepEqual(
    (await L.liveLessons('ziva')).map((l) => l.id),
    [all.id]
  );
});

test('a lesson for every Odd can replace a lesson for every Odd', async () => {
  const all = await kept(say('ziva', 'start every report with the date', { scope: 'everyone' }));
  const next = await kept(
    say('jamal', 'start every report with the time', {
      scope: 'everyone',
      replaces: all.id,
      whyReplaced: 'refined'
    })
  );
  assert.equal(next.status, 'live');
  assert.equal(await statusOf(all.id), 'replaced');
});

test('an Odd holding the cap must replace a lesson to keep another', async () => {
  const held: LessonRow[] = [];
  for (let i = 0; i < L.LESSON_CAP; i++)
    held.push(await kept(say('ziva', `rule number ${i} applies`)));
  const over = await say('ziva', 'one rule too many');
  assert.ok('problem' in over);
  const swap = await kept(
    say('ziva', 'one rule too many', { replaces: held[0].id, whyReplaced: 'refined' })
  );
  assert.equal(swap.status, 'live');
});

/** Whether this session holds the advisory lock `pg_advisory_xact_lock(hashtext($1))` takes. */
const LOCK_HELD = `select exists (select 1 from pg_locks where locktype = 'advisory' and granted
  and objsubid = 1 and ((classid::bigint << 32) | objid::bigint) = hashtext($1)::bigint) as held`;

/**
 * Each statement on the lessons table that `run` sends, and whether it ran
 * inside a transaction holding the advisory lock `lock`, read from pg_locks
 * just before the statement. It watches the PGlite client under drizzle, so
 * the office's own code runs unchanged.
 */
async function lessonStatements(
  t: TestContext,
  lock: string,
  run: () => Promise<unknown>
): Promise<{ text: string; locked: boolean }[]> {
  const seen: { text: string; locked: boolean }[] = [];
  const onLessons = (text: string) => /\b(from|into|update)\s+"lessons"/i.test(text);
  const client = db.$client;
  const query = client.query.bind(client);
  const transaction = client.transaction.bind(client);
  t.mock.method(client, 'query', (...args: Parameters<typeof client.query>) => {
    if (onLessons(args[0])) seen.push({ text: args[0], locked: false });
    return query(...args);
  });
  t.mock.method(client, 'transaction', (fn: (tx: Transaction) => Promise<unknown>) =>
    transaction((tx) =>
      fn(
        new Proxy(tx, {
          get(target, key) {
            if (key === 'query')
              return async (...args: Parameters<Transaction['query']>) => {
                if (onLessons(args[0])) {
                  const [{ held }] = (await target.query<{ held: boolean }>(LOCK_HELD, [lock]))
                    .rows;
                  seen.push({ text: args[0], locked: held });
                }
                return target.query(...args);
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        })
      )
    )
  );
  await run();
  return seen;
}

// PGlite cannot show this race itself: it is one Postgres session, it runs one
// transaction at a time (a second waits for the first to commit), and an
// advisory lock re-enters in the session that holds it. So the test checks
// what stops the race on a Postgres with many sessions: the open count and the
// insert run inside one transaction while the office's advisory lock is held,
// which Postgres turns into one keep at a time per scope.
test('two Odds keeping lessons for the office at the same moment never take it past the cap', async (t) => {
  for (let i = 1; i < L.LESSON_CAP; i++)
    await kept(say('ziva', `office rule number ${i} applies`, { scope: 'everyone' }));
  let answers: Awaited<ReturnType<typeof say>>[] = [];
  const statements = await lessonStatements(t, 'lessons:everyone', async () => {
    answers = await Promise.all([
      say('ziva', 'one office rule from ziva', { scope: 'everyone' }),
      say('jamal', 'one office rule from jamal', { scope: 'everyone' })
    ]);
  });
  // Both keeps read the open lessons, and one writes.
  assert.equal(statements.filter((s) => /^select/i.test(s.text)).length, 2);
  assert.equal(statements.filter((s) => /^insert/i.test(s.text)).length, 1);
  assert.deepEqual(
    statements.filter((s) => !s.locked).map((s) => s.text),
    []
  );
  // The lock ends with each keep's transaction. One held past it, as a session
  // lock is, would shut every later keep on another session out of the scope.
  const {
    rows: [after]
  } = await db.$client.query<{ held: boolean }>(LOCK_HELD, ['lessons:everyone']);
  assert.equal(after.held, false);
  const [{ open }] = await sql<{ open: number }>`
    select count(*)::int as open from lessons
    where staff_id is null and status in ('live', 'waiting')`;
  assert.equal(open, L.LESSON_CAP);
  assert.equal(
    answers.filter((a) => 'problem' in a && a.problem.includes(`${L.LESSON_CAP} lessons`)).length,
    1
  );
});

test('a waiting lesson goes live when the owner then says it outright', async () => {
  const w = await kept(
    L.keepLesson('jamal', {
      text: 'keep hellos short',
      quote: 'way too long',
      how: 'inferred',
      scope: 'me',
      ownerWords: { text: 'your hello was way too long', from: 'chat' }
    })
  );
  assert.equal(w.status, 'waiting');
  const again = await kept(
    L.keepLesson('jamal', {
      text: 'Keep hellos short.',
      quote: 'keep hellos short',
      how: 'said',
      scope: 'me',
      ownerWords: { text: 'yes, keep hellos short from now on', from: 'chat' }
    })
  );
  assert.equal(again.id, w.id);
  assert.equal(again.status, 'live');
  assert.equal(again.how, 'said');
  assert.equal(again.quote, 'keep hellos short');
  assert.deepEqual(await titles(), ['Taught Jamal: keep hellos short']);
});

test('the same lesson kept again after a miss counts the miss, records it and stays live', async () => {
  const a = await kept(say('jamal', 'keep what you write short'));
  const again = await kept(
    say('jamal', 'keep what you write short', { replaces: a.id, whyReplaced: 'missed' })
  );
  assert.equal(again.id, a.id);
  assert.equal(again.missed, 1);
  assert.equal(again.replaces, null);
  assert.equal(await statusOf(a.id), 'live');
  assert.deepEqual(await titles(), [
    'Taught Jamal: keep what you write short',
    'Taught Jamal, told 2 times now: keep what you write short'
  ]);
});

test('the same lesson kept again stops the other lesson it replaces', async () => {
  const sam = await kept(say('ziva', 'always copy sam in'));
  const other = await kept(say('ziva', 'copy whoever asked'));
  await kept(say('ziva', 'always copy sam in', { replaces: other.id, whyReplaced: 'missed' }));
  assert.equal(await statusOf(other.id), 'replaced');
  assert.equal(await statusOf(sam.id), 'live');
});

test('Keep on a waiting lesson makes it live and stops the one it replaces', async () => {
  const a = await kept(say('ziva', 'keep reports to three lines'));
  const b = await kept(
    say('ziva', 'keep reports to five lines', {
      how: 'inferred',
      replaces: a.id,
      whyReplaced: 'refined'
    })
  );
  assert.equal(b.status, 'waiting');
  assert.equal(await statusOf(a.id), 'live');
  assert.equal((await L.changeLesson(b.id, { status: 'live' }))?.status, 'live');
  assert.equal(await statusOf(a.id), 'replaced');
});

test('Undo on a lesson brings back the lesson it replaced', async () => {
  const a = await kept(say('ziva', 'keep reports to three lines'));
  const b = await kept(
    say('ziva', 'keep reports to five lines', { replaces: a.id, whyReplaced: 'refined' })
  );
  assert.equal(await statusOf(a.id), 'replaced');
  await L.changeLesson(b.id, { status: 'undone' });
  assert.equal(await statusOf(a.id), 'live');
});

test('Undo leaves the replaced lesson alone while another open lesson replaces it', async () => {
  const a = await kept(say('ziva', 'keep reports to three lines'));
  const b = await kept(
    say('ziva', 'keep reports to five lines', {
      how: 'inferred',
      replaces: a.id,
      whyReplaced: 'refined'
    })
  );
  await kept(say('ziva', 'keep reports to four lines', { replaces: a.id, whyReplaced: 'refined' }));
  await L.changeLesson(b.id, { status: 'undone' });
  assert.equal(await statusOf(a.id), 'replaced');
});

test('narrowing a lesson to one Odd brings back the lesson for every Odd it replaced', async () => {
  const all = await kept(say('ziva', 'start every report with the date', { scope: 'everyone' }));
  const next = await kept(
    say('jamal', 'start every report with the time', {
      scope: 'everyone',
      replaces: all.id,
      whyReplaced: 'refined'
    })
  );
  assert.equal(await statusOf(all.id), 'replaced');
  const narrowed = await L.changeLesson(next.id, { scope: 'me' });
  assert.equal(narrowed?.staffId, 'jamal');
  assert.equal(narrowed?.replaces, null);
  assert.equal(await statusOf(all.id), 'live');
  assert.deepEqual(
    (await L.liveLessons('ziva')).map((l) => l.id),
    [all.id]
  );
});

test('rewording a lesson makes the new text its quote, as the owner typed it', async () => {
  const w = await kept(
    L.keepLesson('ziva', {
      text: 'keep reports short',
      quote: 'that report was far too long',
      how: 'inferred',
      scope: 'me',
      ownerWords: { text: 'that report was far too long', from: 'chat' }
    })
  );
  const edited = await L.changeLesson(w.id, { text: ' Keep reports to three lines. ' });
  assert.equal(edited?.text, 'Keep reports to three lines.');
  assert.equal(edited?.quote, 'Keep reports to three lines.');
  assert.equal(edited?.how, 'said');
});

test('where a lesson applies is kept trimmed', async () => {
  const l = await kept(say('ziva', 'start with the date', { appliesTo: '  reports ' }));
  assert.equal(l.appliesTo, 'reports');
});

test('a lesson whose place is left empty applies everywhere', async () => {
  const l = await kept(say('ziva', 'start with the date', { appliesTo: '  ' }));
  assert.equal(l.appliesTo, null);
});

test('the same words for one place replace the lesson for everywhere', async () => {
  const all = await kept(say('ziva', 'start with the date'));
  const reports = await kept(
    say('ziva', 'start with the date', {
      appliesTo: 'reports',
      replaces: all.id,
      whyReplaced: 'refined'
    })
  );
  assert.notEqual(reports.id, all.id);
  assert.equal(reports.appliesTo, 'reports');
  assert.equal(await statusOf(all.id), 'replaced');
});

test('the same words said for one place replace the open lesson for everywhere, unasked', async () => {
  const all = await kept(say('ziva', 'start with the date'));
  const reports = await kept(say('ziva', 'start with the date', { appliesTo: 'reports' }));
  assert.equal(reports.replaces, all.id);
  assert.equal(await statusOf(all.id), 'replaced');
  assert.deepEqual(
    (await L.liveLessons('ziva')).map((l) => l.appliesTo),
    ['reports']
  );
});

test('a guess with the same words for one place replaces the open lesson only once kept', async () => {
  const all = await kept(say('ziva', 'start with the date'));
  const g = await guess('ziva', 'start with the date', { appliesTo: 'reports' });
  assert.equal(g.replaces, all.id);
  assert.equal(await statusOf(all.id), 'live');
  await L.changeLesson(g.id, { status: 'live' });
  assert.equal(await statusOf(all.id), 'replaced');
});

test('a guess with the same words leaves the live lesson as it is: it replaces nothing and counts no miss', async () => {
  const a = await kept(say('ziva', 'keep reports to three lines'));
  const b = await kept(say('ziva', 'always copy sam in'));
  const fromEdit = { text: 'keep reports to three lines', from: 'edit' as const };
  for (const more of [
    { ownerWords: fromEdit, replaces: b.id, whyReplaced: 'refined' as const },
    { ownerWords: fromEdit, replaces: a.id, whyReplaced: 'missed' as const },
    { how: 'inferred' as const, replaces: b.id, whyReplaced: 'missed' as const }
  ]) {
    const r = await kept(say('ziva', 'keep reports to three lines', more));
    assert.deepEqual(r, a);
  }
  assert.equal(await statusOf(b.id), 'live');
  assert.equal((await L.lesson(a.id))?.missed, 0);
  assert.deepEqual(await titles(), [
    'Taught Ziva: keep reports to three lines',
    'Taught Ziva: always copy sam in'
  ]);
});

test('the owner sets and clears where a lesson applies, and its quote stays', async () => {
  const l = await kept(say('ziva', 'start with the date'));
  const narrowed = await L.changeLesson(l.id, { appliesTo: ' reports ' });
  assert.equal(narrowed?.appliesTo, 'reports');
  assert.equal(narrowed?.quote, 'start with the date');
  const everywhere = await L.changeLesson(l.id, { appliesTo: null });
  assert.equal(everywhere?.appliesTo, null);
  assert.equal(everywhere?.quote, 'start with the date');
  await L.changeLesson(l.id, { appliesTo: 'reports' });
  assert.equal((await L.changeLesson(l.id, { appliesTo: '' }))?.appliesTo, null);
});

test('a guess not kept within GUESS_DAYS stops counting toward the cap', async () => {
  const g = await guess('ziva', 'maybe keep reports short');
  for (let i = 1; i < L.LESSON_CAP; i++) await kept(say('ziva', `rule number ${i} applies`));
  assert.ok('problem' in (await say('ziva', 'one rule too many')));
  await age(g.id, L.GUESS_DAYS + 1);
  assert.equal((await kept(say('ziva', 'one rule too many'))).status, 'live');
});

test('the count of guesses waiting ignores one not kept within GUESS_DAYS', async () => {
  const mine = await guess('ziva', 'maybe keep reports short');
  await guess('jamal', 'maybe start reports with the date', { scope: 'everyone' });
  await kept(say('ziva', 'keep reports to three lines'));
  assert.deepEqual(await L.guessesWaiting(['ziva', 'jamal']), { ziva: 2, jamal: 1 });
  await age(mine.id, L.GUESS_DAYS + 1);
  assert.deepEqual(await L.guessesWaiting(['ziva', 'jamal']), { ziva: 1, jamal: 1 });
});

test('a guess not kept within GUESS_DAYS reads as dropped, and Keep after all makes it live', async () => {
  const g = await guess('ziva', 'maybe keep reports short');
  await age(g.id, L.GUESS_DAYS - 1);
  assert.equal((await L.lessonsOf('ziva'))[0].status, 'waiting');
  await age(g.id, L.GUESS_DAYS + 1);
  assert.equal((await L.lessonsOf('ziva'))[0].status, 'dropped');
  assert.equal((await L.changeLesson(g.id, { status: 'live' }))?.status, 'live');
  assert.deepEqual(await titles(), ['Taught Ziva: maybe keep reports short']);
});

test('the Lessons window lists every open lesson, for one Odd or every Odd, guesses first, and nothing else', async () => {
  // The guess is older, so only the guesses-first order puts it ahead.
  const waiting = await guess('jamal', 'maybe tell me only what needs me', { scope: 'everyone' });
  const live = await kept(
    say('ziva', 'check with me before anything goes out', { scope: 'everyone' })
  );
  const old = await guess('ziva', 'maybe write to me in the mornings', { scope: 'everyone' });
  await age(old.id, L.GUESS_DAYS + 1);
  const undone = await kept(say('jamal', 'send me everything you do', { scope: 'everyone' }));
  await L.changeLesson(undone.id, { status: 'undone' });
  const own = await kept(say('ziva', 'keep my reports to three lines'));
  const ownGuess = await guess('jamal', 'maybe keep my drafts short');
  assert.deepEqual(
    (await L.libraryLessons()).map((l) => l.id),
    [ownGuess.id, waiting.id, own.id, live.id]
  );
});

test('the Lessons window counts each Odd its own uses of a lesson, and every Odd together', async () => {
  const all = await kept(say('ziva', 'start every report with the date', { scope: 'everyone' }));
  const unused = await kept(say('jamal', 'keep my drafts to one page'));
  await L.usedLesson(all.id, 'jamal');
  await L.usedLesson(all.id, 'jamal');
  const z = await L.usedLesson(all.id, 'ziva');
  const listed = await L.libraryLessons();
  const byId = (id: number) =>
    listed.find((l) => l.id === id) ?? assert.fail(`#${id} is not listed`);
  const a = byId(all.id);
  const u = byId(unused.id);
  assert.deepEqual(
    { uses: u.uses, lastUsedAt: u.lastUsedAt, usesBy: u.usesBy },
    {
      uses: 0,
      lastUsedAt: null,
      usesBy: {}
    }
  );
  assert.equal(a.uses, 3);
  assert.deepEqual(Object.keys(a.usesBy).sort(), ['jamal', 'ziva']);
  assert.equal(a.usesBy.jamal.uses, 2);
  assert.equal(a.usesBy.ziva.uses, 1);
  // The total's last use is the newest of any Odd's: Ziva's, made last.
  assert.deepEqual(a.lastUsedAt, z?.lastUsedAt);
  assert.ok(
    a.usesBy.jamal.lastUsedAt && z?.lastUsedAt && a.usesBy.jamal.lastUsedAt <= z.lastUsedAt
  );
});

test('lesson news starts from the newest lesson and use, so a start tells nothing again', async () => {
  const l = await kept(say('ziva', 'start every report with the date', { scope: 'everyone' }));
  await L.usedLesson(l.id, 'jamal');
  const mark = await L.lessonMark();
  assert.deepEqual((await L.lessonNewsSince(mark)).news, []);
});

test('a new lesson is one piece of kept news, for the Odd that heard it', async () => {
  const mark = await L.lessonMark();
  const l = await kept(say('ziva', 'start every report with the date', { scope: 'everyone' }));
  const told = await L.lessonNewsSince(mark);
  assert.deepEqual(told.news, [{ kind: 'kept', staff: 'ziva', lesson: l.id }]);
  assert.deepEqual((await L.lessonNewsSince(told.mark)).news, []);
});

test('a new use is one piece of used news, for the Odd that used it', async () => {
  const l = await kept(say('ziva', 'start every report with the date', { scope: 'everyone' }));
  await L.usedLesson(l.id, 'ziva');
  const mark = await L.lessonMark();
  // A later millisecond than the first use, as two runs' uses always are.
  await new Promise((r) => setTimeout(r, 5));
  await L.usedLesson(l.id, 'jamal');
  const told = await L.lessonNewsSince(mark);
  assert.deepEqual(told.news, [{ kind: 'used', staff: 'jamal', lesson: l.id }]);
  assert.deepEqual((await L.lessonNewsSince(told.mark)).news, []);
});

test("the owner's edit, Keep and Undo are no news", async () => {
  const l = await kept(say('ziva', 'start every report with the date'));
  const g = await guess('ziva', 'maybe keep reports short');
  const mark = await L.lessonMark();
  await L.changeLesson(l.id, { text: 'start every report with the day', appliesTo: 'reports' });
  await L.changeLesson(g.id, { status: 'live' });
  await L.changeLesson(l.id, { status: 'undone' });
  assert.deepEqual((await L.lessonNewsSince(mark)).news, []);
});

test('a guess not kept within GUESS_DAYS cannot be replaced', async () => {
  const g = await guess('ziva', 'maybe keep reports short');
  await age(g.id, L.GUESS_DAYS + 1);
  const r = await say('ziva', 'keep reports to three lines', {
    replaces: g.id,
    whyReplaced: 'refined'
  });
  assert.ok('problem' in r);
  assert.match(r.problem, /not one of your current lessons/);
});

test('Undo brings back the replaced lesson when the only other lesson replacing it is a dropped guess', async () => {
  const a = await kept(say('ziva', 'keep reports to three lines'));
  const b = await guess('ziva', 'keep reports to five lines', {
    replaces: a.id,
    whyReplaced: 'refined'
  });
  const c = await kept(
    say('ziva', 'keep reports to four lines', { replaces: a.id, whyReplaced: 'refined' })
  );
  assert.equal(await statusOf(a.id), 'replaced');
  await age(b.id, L.GUESS_DAYS + 1);
  await L.changeLesson(c.id, { status: 'undone' });
  assert.equal(await statusOf(a.id), 'live');
});

test('an Odd cannot use a lesson another Odd keeps for itself', async () => {
  const z = await kept(say('ziva', 'keep reports to three lines'));
  assert.equal(await L.usedLesson(z.id, 'jamal'), undefined);
  assert.equal((await sql`select 1 from lesson_uses`).length, 0);
});

test('an Odd cannot use a lesson that waits for the owner to keep it', async () => {
  const w = await kept(say('ziva', 'keep reports to three lines', { how: 'inferred' }));
  assert.equal(w.status, 'waiting');
  assert.equal(await L.usedLesson(w.id, 'ziva'), undefined);
  assert.equal((await sql`select 1 from lesson_uses`).length, 0);
});

test('each Odd counts its own uses of a lesson for every Odd', async () => {
  const all = await kept(say('ziva', 'start every report with the date', { scope: 'everyone' }));
  for (let i = 0; i < L.CITE_FIRST; i++) await L.usedLesson(all.id, 'jamal');
  assert.equal((await L.usedLesson(all.id, 'ziva'))?.uses, 1);
  assert.equal((await L.lessonsOf('jamal'))[0].uses, L.CITE_FIRST);
  assert.equal((await L.lessonsOf('ziva'))[0].uses, 1);
});

test('a no with a reason on a hand-off goes back once, and the run that reads it hands nothing back', async () => {
  const given = await H.handOff({
    from: 'ziva',
    to: 'jamal',
    work: { title: 'Book the venue', brief: 'Find a venue for the launch.' },
    thread: { title: 'The launch' }
  });
  if ('problem' in given) assert.fail(given.problem);
  if ('asked' in given) assert.fail('The first hand-off of a round waits on the owner');
  const { ask } = await O.raiseAsk('jamal', {
    title: 'Email the venue',
    why: 'To hold the date',
    ifApproved: 'I send one email',
    handOffId: given.id,
    threadId: given.thread
  });
  await O.decideAsk(ask.id, 'deny', 'Never email a venue before I have seen the price');
  const handedBack = async () =>
    (await db.select().from(followUps)).filter(
      (f) => f.kind === 'handed_back' && f.handOff?.id === given.id
    );
  const backs = await handedBack();
  assert.equal(backs.length, 1);
  assert.equal(backs[0]?.handOff?.outcome, 'failed');
  const [denied] = (await db.select().from(followUps)).filter(
    (f) => f.kind === 'denied' && f.askId === ask.id
  );
  if (!denied) assert.fail('A no with a reason starts no denied run');
  assert.equal(denied.threadId, null);
  await O.finishFollowUp(denied, ask.title, 'done', 'Took in the no.');
  assert.equal((await handedBack()).length, 1);
});

test('a no with a reason to more hand-offs stops the thread, and the run that reads it joins no thread', async () => {
  const [launch] = await db
    .insert(threads)
    .values({
      title: 'The big launch',
      hubId: 'ziva',
      holderId: 'ziva',
      handOffsUsed: HAND_OFF_LIMIT
    })
    .returning();
  const big = await H.handOff({
    from: 'ziva',
    to: 'jamal',
    work: { title: 'Plan the launch', brief: 'Every step of the launch.' },
    thread: { id: launch.id }
  });
  if (!('asked' in big)) assert.fail('A hand-off past the limit goes ahead without the owner');
  await O.decideAsk(big.asked, 'deny', 'Never plan more than ten calls without asking me first');
  const [thread] = await db.select().from(threads).where(eq(threads.id, big.thread));
  assert.equal(thread?.status, 'stopped');
  const runs = await db.select().from(followUps).where(eq(followUps.askId, big.asked));
  assert.deepEqual(
    runs.map((f) => [f.kind, f.staffId, f.threadId]),
    [
      ['resume', 'ziva', launch.id],
      ['denied', 'ziva', null]
    ]
  );
});

test("an edit's words make a guess for the Odd that read it, even when it asks for said and everyone", async () => {
  const r = await kept(
    say('ziva', 'keep reports to three lines', {
      scope: 'everyone',
      ownerWords: { text: 'keep reports to three lines', from: 'edit' }
    })
  );
  assert.equal(r.how, 'inferred');
  assert.equal(r.status, 'waiting');
  assert.equal(r.staffId, 'ziva');
  assert.deepEqual(await L.lessonsOf('jamal'), []);
});

const edits = () => db.select().from(followUps).where(eq(followUps.kind, 'edited'));

test('a quote from an edit has to be words from the file as the owner saved it', async () => {
  const r = await say('ziva', 'keep reports to three lines', {
    ownerWords: { text: 'Weekly report. Sales up.', from: 'edit' }
  });
  assert.ok('problem' in r);
  assert.match(r.problem, /from the file as it is now/);
  assert.equal((await sql`select 1 from lessons`).length, 0);
});

test('a save while the edit run for that file has not finished starts no second one', async () => {
  await sql`delete from follow_ups where kind = 'edited'`;
  const path = 'notes/plan.md';
  assert.equal(await L.learnFromEdit('ziva', { path, before: 'mine' }, 'theirs'), true);
  assert.equal(await L.learnFromEdit('ziva', { path, before: 'theirs' }, 'theirs, again'), false);
  const [first, ...more] = await edits();
  assert.deepEqual(more, []);
  // The run keeps the Odd's version, and reads the owner's newest when it starts.
  assert.deepEqual(first?.edit, { path, before: 'mine' });
  // Under way, a save still joins it: the office reads the file again once it ends.
  assert.ok(await O.startFollowUp(first.id));
  assert.equal(await L.learnFromEdit('ziva', { path, before: 'theirs, again' }, 'third'), false);
  assert.equal((await edits()).length, 1);
  // Once it ended, the version it read starts one more.
  await O.finishFollowUp(first, path, 'done', 'Kept nothing.');
  assert.equal(await L.learnFromEdit('ziva', { path, before: 'theirs, again' }, 'third'), true);
  const [, next] = await edits();
  assert.deepEqual(next?.edit, { path, before: 'theirs, again' });
});

test('a save that changed nothing starts no edit run', async () => {
  await sql`delete from follow_ups where kind = 'edited'`;
  assert.equal(await L.learnFromEdit('ziva', { path: 'a.md', before: 'same' }, 'same'), false);
  assert.deepEqual(await edits(), []);
});

test("a save of a task's attached file starts no edit run", async () => {
  await sql`delete from follow_ups where kind = 'edited'`;
  await O.giveTask('ziva', {
    title: 'Fill in the intake',
    why: 'To hire well',
    steps: ['Answer the questions'],
    attach: ['notes/intake.md']
  });
  const intake = { path: 'notes/intake.md', before: 'Q: budget?' };
  assert.equal(await L.learnFromEdit('ziva', intake, 'Q: budget? A: 500'), false);
  assert.deepEqual(await edits(), []);
});
