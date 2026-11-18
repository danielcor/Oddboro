// A lead's run that ends a park is told the wait ended, whatever kind of run it
// is, in an office under test (office-under-test.ts): the claim ends the park
// (`startFollowUp` in the ledger), and `followThrough` says so in every brief.
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { L, runOf } from './office-under-test.ts';

/** Work `lead` handed `paige`, its result back and waiting for the lead's pick-up. */
async function handedBack(title: string): Promise<{ thread: number; back: number }> {
  const h = await L.handOff({
    from: 'lead',
    to: 'paige',
    work: { title, brief: 'Do it.' },
    thread: { title: `Work on ${title}` }
  });
  assert.ok('id' in h, JSON.stringify(h));
  const f = await L.startFollowUp(h.id);
  assert.ok(f, `${title} could not start`);
  await L.finishFollowUp(f, title, 'done', 'Did it.');
  const [back] = await L.pg<{ id: number }[]>`
    select id from follow_ups where kind = 'handed_back' and thread_id = ${h.thread}`;
  return { thread: h.thread, back: back.id };
}

test('a hand-back that picks up work parked on a task is told the wait ended, and not that it is still parked', async () => {
  const { thread, back } = await handedBack('Draw the flyer');
  const sign = await L.giveTask('lead', { title: 'Sign the flyer', why: 'w', steps: ['Sign it'] });
  await L.pg`update threads set resume_on_task = ${sign.id} where id = ${thread}`;
  const run = await runOf(back);
  assert.match(
    run.system,
    /This work was parked until .+ finished or dropped "Sign the flyer"\. That wait ended as this run started, so nothing brings you back for it now\. If the work still needs to wait, park it again with resume_at\./
  );
  assert.doesNotMatch(run.system, /It is parked until/);
});

test("the owner's words that pick up work parked on a time tell the lead's run the wait ended", async () => {
  const { thread, back } = await handedBack('Draw the menu');
  // The lead's pick-up parks the work on a time as it goes, as resume_at does.
  const f = await L.startFollowUp(back);
  assert.ok(f);
  assert.ok(await L.parkThread('lead', thread, new Date(Date.now() + 3_600_000)));
  await L.finishFollowUp(f, 'Draw the menu', 'done', 'Parked it till later.');
  const said = 'Go ahead now.';
  const told = await L.tellLead({
    staffId: 'paige',
    threadId: thread,
    said,
    words: said,
    reading: 'Sam wants it now.'
  });
  assert.ok('lead' in told, JSON.stringify(told));
  const [pickUp] = await L.pg<{ id: number }[]>`
    select id from follow_ups where kind = 'resume' and thread_id = ${thread} and started_at is null`;
  const run = await runOf(pickUp.id);
  assert.match(run.system, /This work was parked until \S.+\. That wait ended as this run started/);
  assert.doesNotMatch(run.system, /It picks back up at/);
});

test('a run that ended no park is told of no wait', async () => {
  const { back } = await handedBack('Draw the poster');
  assert.doesNotMatch((await runOf(back)).system, /That wait ended/);
});
