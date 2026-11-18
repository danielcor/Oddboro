// Due times, completed runs and old files survive retries without duplicate work,
// and a reader job's input is its writer's run for the reader's own period.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db, sql } from './pglite.ts';
import { staff } from '../src/schema.ts';
import { nextRun, runTime } from '../src/time.ts';
import type { JobRow, RunRow } from '../src/office.ts';

const O = await import('../src/office.ts');
await db.insert(staff).values({
  id: 'writer',
  name: 'Writer',
  role: 'Editor',
  remit: 'Prepare an edition.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft',
  desk: 'Prepare the edition.'
});

test('two edits to the same job description keep one change and its history', async () => {
  const was = (await O.staffer('writer'))!.desk;
  const edits = ['Prepare the morning edition.', 'Prepare the evening edition.'];
  const outcomes = await Promise.allSettled(
    edits.map((text) => O.setDescription('writer', text, { owner: true, was }))
  );
  const saved = (await O.staffer('writer'))!.desk;
  assert.ok(edits.includes(saved));
  assert.deepEqual(outcomes[edits.indexOf(saved)], { status: 'fulfilled', value: true });
  const other = outcomes.find((r) => r.status === 'rejected');
  assert.match(String(other?.reason), /changed since you opened it/);
  const history =
    await sql`select body from ledger where title = 'Edited Writer''s job description'`;
  assert.deepEqual(
    history.map((row) => row.body),
    [`Before:\n${was}\n\nAfter:\n${saved}`]
  );
});

test('two clocks claim one due time and a repeated finish keeps one result', async () => {
  const job = await O.addJob({
    staffId: 'writer',
    name: 'Edition',
    instructions: 'Write it.',
    schedule: { every: 'minutes', n: 15 },
    report: true
  });
  await O.setNextRun(job.id, new Date(Date.now() - 1000));
  const due = (await O.job(job.id))!;
  const claims = (
    await Promise.all([O.claimScheduledRun(due, new Date()), O.claimScheduledRun(due, new Date())])
  ).filter((r) => !!r);
  assert.equal(claims.length, 1);
  await O.finishRun(claims[0], due, true, 'The first result.');
  await O.finishRun(claims[0], due, false, 'A late failure.');
  const [saved] = await sql<{
    status: string;
    summary: string;
  }>`select status, summary from runs where id = ${claims[0].id}`;
  assert.equal(saved.status, 'done');
  assert.equal(saved.summary, 'The first result.');
  const reports =
    await sql`select id from reports where title = 'Edition' and body = 'The first result.'`;
  assert.equal(reports.length, 1);
  assert.equal((await sql`select id from ledger where run_id = ${claims[0].id}`).length, 1);
});

test('an edited job cannot be claimed from an older clock view', async () => {
  const job = await O.addJob({
    staffId: 'writer',
    name: 'Wire',
    instructions: 'Write it.',
    schedule: { every: 'minutes', n: 15 }
  });
  await O.setNextRun(job.id, new Date(Date.now() - 1000));
  const due = (await O.job(job.id))!;
  await sql`update jobs set instructions = 'Changed by owner', changed_at = changed_at + interval '1 second' where id = ${job.id}`;
  assert.equal(await O.claimScheduledRun(due, new Date()), undefined);
  assert.equal((await O.job(job.id))!.instructions, 'Changed by owner');
  assert.equal((await sql`select id from runs where job_id = ${job.id}`).length, 0);
});

test("a reader's input is its writer's run for the reader's period, wait, skip or problem", async () => {
  const daily = { every: 'day', at: '07:00' } as const;
  const d1 = nextRun(daily, new Date('2026-11-02T00:00:00Z'));
  const d2 = nextRun(daily, d1);
  const d3 = nextRun(daily, d2);
  const added = await O.addJob({
    staffId: 'writer',
    name: 'Morning wire',
    instructions: 'Write it.',
    schedule: daily,
    files: { thread: 7, output: 'wire.md' }
  });
  const writer = { ...added, nextRunAt: d3 };
  const reader = await O.addJob({
    staffId: 'writer',
    name: 'Morning edition',
    instructions: 'Read it.',
    schedule: daily,
    files: { thread: 7, input: 'writer/wire.md', output: 'edition.md' }
  });
  const run = (id: number, periods: Date[], status = 'done', sha256?: string): RunRow => ({
    id,
    jobId: writer.id,
    staffId: 'writer',
    status: status as RunRow['status'],
    trigger: 'schedule',
    summary: null,
    checkedFiles: {
      periods: periods.map((p) => p.toISOString()),
      output: 'writer/wire.md',
      ...(sha256 ? { sha256 } : {})
    },
    startedAt: new Date(writer.changedAt.getTime() + id),
    finishedAt: new Date(writer.changedAt.getTime() + id + 1)
  });
  const input = (w: JobRow, runs: RunRow[], at: Date, busy?: (id: number) => boolean) =>
    O.scheduledInput(reader, [reader, w], runs, at, busy);
  const twoDays = [run(1, [d1], 'done', 'same'), run(2, [d2], 'done', 'same')];

  // The same bytes two days running: each period takes its own run.
  assert.deepEqual(input(writer, twoDays, d2), { run: 2, sha256: 'same' });
  assert.deepEqual(input(writer, twoDays, new Date(d2.getTime() - 3_600_000)), {
    run: 1,
    sha256: 'same'
  });

  // A later catch-up of older periods wrote the file now on disk: it wins over
  // an earlier run for a newer period.
  assert.deepEqual(
    input(writer, [run(1, [d2], 'done', 'first'), run(2, [d1], 'done', 'caught up')], d2),
    { run: 2, sha256: 'caught up' }
  );

  // The writer still owes the period: due, owed, running or starting.
  const waits = (w: JobRow, runs: RunRow[], busy?: (id: number) => boolean) =>
    assert.ok('wait' in input(w, runs, d2, busy)!, JSON.stringify(input(w, runs, d2, busy)));
  waits({ ...writer, nextRunAt: d2 }, twoDays.slice(0, 1));
  waits({ ...writer, owed: [d2.toISOString()] }, twoDays.slice(0, 1));
  waits(writer, [...twoDays.slice(0, 1), run(3, [d2], 'running')]);
  waits(writer, twoDays.slice(0, 1), (id) => id === writer.id);
  // A run for a later period does not hold back this one.
  assert.deepEqual(input(writer, [...twoDays, run(3, [d3], 'running')], d2), {
    run: 2,
    sha256: 'same'
  });

  // The writer skipped the period, or has written none yet: the reader skips.
  assert.deepEqual(input({ ...writer, skippedAt: d2 }, twoDays.slice(0, 1), d2), {
    skip: `"Morning wire" skipped its run for ${runTime(d2)}, so "Morning edition" skips this period too.`,
    away: true
  });
  assert.deepEqual(input(writer, twoDays.slice(0, 1), d2), {
    skip: `"Morning wire" did not run for ${runTime(d2)}, so "Morning edition" skips this period too.`,
    away: true
  });
  assert.deepEqual(input(writer, [], d2), {
    skip: 'Waiting for "Morning wire" to write writer/wire.md for the first time.',
    away: false
  });

  // The writer's missed periods wait for the owner's answer: wait; after a no: skip.
  const asked = (open: boolean) => [{ times: [d2.toISOString()], open }];
  const busyNot = () => false;
  assert.ok(
    'wait' in
      O.scheduledInput(reader, [reader, writer], twoDays.slice(0, 1), d2, busyNot, asked(true))!
  );
  assert.deepEqual(
    O.scheduledInput(reader, [reader, writer], twoDays.slice(0, 1), d2, busyNot, asked(false)),
    {
      skip: 'You said no to filling "Morning wire"\'s missed periods, so "Morning edition" skips this period too.',
      away: true
    }
  );
  // An answered ask for periods the writer has since run for changes nothing.
  assert.deepEqual(O.scheduledInput(reader, [reader, writer], twoDays, d2, busyNot, asked(false)), {
    run: 2,
    sha256: 'same'
  });

  // The writer ran for the period and left no checked file: the reader's run fails.
  for (const left of [run(2, [d2], 'failed'), run(2, [d2], 'done')])
    assert.match(
      (input(writer, [twoDays[0], left], d2) as { problem: string }).problem,
      /"Morning wire" ran for .* and left no checked writer\/wire.md/
    );
  // A run from before the writer's last change counts for nothing.
  assert.ok(
    'skip' in
      input({ ...writer, changedAt: new Date(writer.changedAt.getTime() + 10) }, twoDays, d2)!
  );
  assert.match(
    (input({ ...writer, enabled: false }, twoDays, d2) as { problem: string }).problem,
    /paused/
  );
});

test('jobs whose files would each wait for another, in a ring, are refused', async () => {
  const daily = { every: 'day', at: '08:00' } as const;
  const add = (name: string, input: string | undefined, output: string, thread = 9) =>
    O.addJob({
      staffId: 'writer',
      name,
      instructions: 'Do it.',
      schedule: daily,
      files: { thread, output, ...(input ? { input } : {}) }
    });
  const a = await add('Ring A', 'writer/c.md', 'a.md');
  await add('Ring B', 'writer/a.md', 'b.md');
  await assert.rejects(
    () => add('Ring C', 'writer/b.md', 'c.md'),
    (e: Error) =>
      /would each wait for another's file/.test(e.message) &&
      [
        '"Ring A" reads writer/c.md from "Ring C"',
        '"Ring B" reads writer/a.md from "Ring A"',
        '"Ring C" reads writer/b.md from "Ring B"'
      ].every((s) => e.message.includes(s))
  );
  // The same files on another piece of work make no ring.
  await add('Ring C elsewhere', 'writer/b.md', 'c.md', 10);
  // Changing a job's files into a ring, or to read its own file, is refused too.
  await assert.rejects(
    () => O.updateJob(a.id, { files: { thread: 9, input: 'writer/b.md', output: 'a.md' } }),
    /"Ring A" reads writer\/b.md from "Ring B", "Ring B" reads writer\/a.md from "Ring A"/
  );
  await assert.rejects(
    () => add('Reads itself', 'writer/self.md', 'self.md'),
    /"Reads itself" reads writer\/self.md from "Reads itself"/
  );
  assert.equal((await O.job(a.id))!.files?.input, 'writer/c.md');
});
