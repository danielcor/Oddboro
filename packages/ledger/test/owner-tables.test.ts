// Every table of words the owner reads from the ledger, entry by entry, so a
// new entry that names a thread, a hand-off or an id fails here, and the title
// the Ledger gives work a restart cut off. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from './pglite.ts';
import { ownerWords } from './owner-words.ts';

const { CUT_OFF_WORK, OUTCOME_TITLE, closeStaleFollowUps, workTitle } =
  await import('../src/office.ts');
const { HEALTH_WORDS, STATUS_WORDS } = await import('../src/goal-words.ts');
const { answerLeadNow } = await import('./answer-lead.ts');
const { asks, followUps, goals, ledger, staff, tasks, threads } = await import('../src/schema.ts');

test('no ledger title of a finished run names a thread or a hand-off', () => {
  for (const byOutcome of Object.values(OUTCOME_TITLE)) ownerWords(...Object.values(byOutcome));
});

test("no word for a goal's status or health names a thread or a hand-off", () => {
  ownerWords(...Object.values(STATUS_WORDS), ...Object.values(HEALTH_WORDS));
});

test('no name for work a restart cut off names a thread, a hand-off or a number', () => {
  for (const words of Object.values(CUT_OFF_WORK)) {
    ownerWords(words);
    assert.doesNotMatch(words, /\d/);
  }
});

test("a lead's pick-up a restart cut off is named in the Ledger by its goal, or its work's title, never as a thread", async () => {
  await db.insert(staff).values({
    id: 'lead',
    name: 'Lena',
    role: 'Tester',
    remit: 'Tests.',
    variant: 'a',
    portrait: 'a',
    permission: 'draft',
    desk: 'You are Lena.'
  });
  const [goal] = await db.insert(goals).values({ title: 'Open the bakery' }).returning();
  const made = await db
    .insert(threads)
    .values([
      // A goal's thread keeps the title it opened with, so a renamed goal shows the difference.
      { title: 'Old bakery name', goalId: goal.id, hubId: 'lead', holderId: 'lead' },
      { title: 'Bake the bread', hubId: 'lead', holderId: 'lead' }
    ])
    .returning();
  for (const t of made) await answerLeadNow(t.id, 'The owner said: more salt.');
  await db.update(followUps).set({ startedAt: new Date() }).where(eq(followUps.kind, 'resume'));

  await closeStaleFollowUps();
  const titles = (await db.select({ title: ledger.title }).from(ledger)).map((r) => r.title);
  assert.deepEqual(titles.sort(), [
    'Could not pick back up: Bake the bread',
    'Could not pick back up: Open the bakery'
  ]);
  ownerWords(...titles);
});

test('work a follow-up was about is named by the title of its ask, task or goal', async () => {
  await db.insert(staff).values({
    id: 'namer',
    name: 'Nia',
    role: 'Tester',
    remit: 'Tests.',
    variant: 'a',
    portrait: 'a',
    permission: 'draft',
    desk: 'You are Nia.'
  });
  const [a] = await db
    .insert(asks)
    .values({ staffId: 'namer', title: 'Book the van', why: 'Why.', ifApproved: 'Then.' })
    .returning();
  const [t] = await db
    .insert(tasks)
    .values({ staffId: 'namer', title: 'Sign the lease', why: 'Why.', steps: [] })
    .returning();
  const [g] = await db.insert(goals).values({ title: 'Grow the list' }).returning();
  const made = await db
    .insert(followUps)
    .values([
      { staffId: 'namer', kind: 'carry_out', askId: a.id },
      { staffId: 'namer', kind: 'task_done', taskId: t.id },
      { staffId: 'namer', kind: 'goal', goalId: g.id },
      { staffId: 'namer', kind: 'first_day' }
    ])
    .returning();
  assert.deepEqual(await Promise.all(made.map((f) => workTitle(f))), [
    'Book the van',
    'Sign the lease',
    'Grow the list',
    'getting started'
  ]);
});
