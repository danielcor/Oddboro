// The office clock when its look at what is due fails, and when a window ask's
// withdrawal at the reset fails, in an office under test (office-under-test.ts):
// the jobs table is renamed away for one look, and a trigger refuses each
// change to the asks table, so each database call fails as a real one does.
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { L } from './office-under-test.ts';

const { startClock } = await import('./jobs.ts');

/**
 * One turn of the event loop while `setTimeout` is mocked. The database
 * client opens a connection on a zero-delay timer, so each turn fires those.
 */
async function turn(): Promise<void> {
  if (mocked) mock.timers.tick(0);
  await new Promise((r) => setImmediate(r));
}
let mocked = false;

/** Waits until `fn` holds, a turn at a time. */
async function until(fn: () => Promise<boolean>, turns = 20_000): Promise<void> {
  for (let i = 0; i < turns && !(await fn()); i++) await turn();
  assert.ok(await fn(), 'it never happened');
}

/** How each run of the job ended so far, and what started it. */
type RunRow = { status: string; trigger: string };
const runsOf = (id: number) =>
  L.pg<RunRow[]>`select status, trigger from runs where job_id = ${id}`;

test('a look whose database read fails is logged, and the clock looks again 30 seconds later and starts the job that is due', async () => {
  const job = await L.addJob({
    staffId: 'sam',
    name: 'Count the chairs',
    instructions: 'Do it.',
    schedule: { every: 'day', at: '09:00' }
  });
  await L.setNextRun(job.id, new Date(Date.now() - 1_000));
  // Let the changes above reach the event bus before the clock listens.
  await new Promise((r) => setTimeout(r, 200));
  const logged: string[] = [];
  mock.method(console, 'error', (...args: unknown[]) => void logged.push(String(args[0])));
  const failedLook = () => logged.filter((l) => l.includes('could not look at what is due'));
  await L.pg`alter table jobs rename to jobs_away`;
  mock.timers.enable({ apis: ['setTimeout'] });
  mocked = true;
  const stop = startClock();
  try {
    await until(async () => failedLook().length > 0);
    const failures = failedLook().length;
    assert.match(failedLook()[0], /looks again in 30 seconds/);
    await L.pg`alter table jobs_away rename to jobs`;

    mock.timers.tick(29_000);
    for (let i = 0; i < 200; i++) await turn();
    assert.equal((await runsOf(job.id)).length, 0);

    mock.timers.tick(1_000);
    mock.timers.reset();
    mocked = false;
    await until(async () => (await runsOf(job.id)).some((r) => r.status !== 'running'));
    assert.deepEqual(
      (await runsOf(job.id)).map((r) => r.trigger),
      ['schedule']
    );
    assert.equal(failedLook().length, failures);
  } finally {
    stop();
    mock.timers.reset();
    mocked = false;
    mock.restoreAll();
  }
});

test("a window ask nobody answered leaves the desk at its window's reset with one line in the ledger, and a withdrawal that fails is logged and made at the clock's next look", async () => {
  await L.setPlanLimits({ fiveHour: 0.9, fiveHourResetsAt: new Date(Date.now() + 3_600_000) });
  const held = await L.handOff({
    from: 'lead',
    to: 'paige',
    work: { title: 'Tune gravity', brief: 'Tune it.' },
    thread: { title: 'Build a moon' }
  });
  assert.ok('problem' in held, 'the window holds the hand-off');
  const [ask] = await L.pg<{ id: number; title: string }[]>`
    select id, title from asks where kind = 'window' and status = 'open'`;
  // The work it held stopped, which clears the hold, so only the ask waits for the reset.
  await L.pg`update threads set held_by = null, resume_at = null`;
  await L.setPlanLimits({ fiveHourResetsAt: new Date(Date.now() - 1_000) });
  const statusOf = async () => (await L.pg`select status from asks where id = ${ask.id}`)[0].status;
  await new Promise((r) => setTimeout(r, 200));
  const logged: string[] = [];
  mock.method(console, 'error', (...args: unknown[]) => void logged.push(String(args[0])));
  const failed = () => logged.filter((l) => l.includes(`window ask ${ask.id} did not leave`));
  await L.pg`create function refuse_asks() returns trigger language plpgsql as
    $$ begin raise exception 'The asks table refuses changes in this test.'; end $$`;
  await L.pg`create trigger refuse_asks before update on asks for each row execute function refuse_asks()`;
  let stop = startClock();
  try {
    await until(async () => failed().length > 0);
    assert.equal(await statusOf(), 'open');

    stop();
    await L.pg`drop trigger refuse_asks on asks`;
    stop = startClock();
    await until(async () => (await statusOf()) !== 'open');
    assert.equal(await statusOf(), 'denied');
    assert.deepEqual(
      [...(await L.pg`select actor, title, reason from ledger where ask_id = ${ask.id}`)],
      [{ actor: 'office', title: `Withdrawn: ${ask.title}`, reason: L.WINDOW_ASK_LAPSED }]
    );
  } finally {
    stop();
    await L.pg`drop trigger if exists refuse_asks on asks`;
    await L.pg`drop function if exists refuse_asks`;
    mock.restoreAll();
  }
});
