// The same task from its chat card and its editor, through the route each uses.
// A stand-in Odd reads back what the office gave its task_done run.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { chat, followThrough, L, type Gave } from './office-under-test.ts';

const route = await import('../../routes/api/tasks/[id]/+server.ts');
const post = async (id: number, body: unknown) =>
  route.POST({
    params: { id: String(id) },
    request: new Request('http://office', { method: 'POST', body: JSON.stringify(body) })
  } as Parameters<typeof route.POST>[0]);

test('a response to a shared list stays on its task through a correction, a failed finish and a retry', async () => {
  const [thread] = await L.pg<{ id: number }[]>`insert into threads (title, hub_id, holder_id)
    values ('Plan the picnic', 'lead', 'lead') returning id`;
  const path = `threads/${thread.id}/paige/list.md`;
  const file = L.home(path);
  mkdirSync(dirname(file), { recursive: true });
  const list = 'Pack plates.\nPack cups.\n';
  writeFileSync(file, list);
  const { id, steps } = await L.giveTask('lead', {
    title: 'Review the picnic list',
    why: 'Tell us what to pack.',
    steps: ['Pick a day', 'Pick a place', 'Read the list', 'Edit it', 'Share it'].map(
      (text, i) => ({ text, done: i < 2 })
    ),
    threadId: thread.id,
    via: 'paige',
    attach: [path]
  });
  const finish = (version?: number) => post(id, { op: 'finish', version });
  const save = (version: number, response: string) =>
    post(id, { op: 'response', version, response });
  await assert.rejects(post(id, { op: 'start-response', from: path.replace('list', 'other') }), {
    status: 400
  });
  const start = await post(id, { op: 'start-response', from: path });
  assert.deepEqual(await start.json(), { response: list, responseVersion: 0 });
  await assert.rejects(finish(0), { status: 409 });
  await assert.rejects(save(0, ' '), { status: 400 });
  assert.equal((await L.task(id))?.responseVersion, 0);

  const first = list + 'Bring water.\n';
  assert.equal((await (await save(0, first)).json()).responseVersion, 1);
  const corrected = first.replace('cups', 'bowls for {owner}');
  const [a, b] = await Promise.all([save(1, corrected), save(1, corrected)]);
  for (const reply of [a, b]) assert.equal((await reply.json()).responseVersion, 2);
  await assert.rejects(save(1, 'Use the older copy'), { status: 409 });
  await assert.rejects(finish(1), { status: 409 });
  await assert.rejects(finish(), { status: 409 });

  // The completion and ledger entry must roll back if the follow-up cannot be queued.
  await L.pg`alter table follow_ups add constraint hold_task_run check (kind <> 'task_done') not valid`;
  try {
    await assert.rejects(finish(2));
    const pending = await L.task(id);
    assert.equal(pending?.status, 'open');
    assert.equal(pending.response, corrected);
    assert.equal(pending.responseVersion, 2);
    assert.deepEqual(pending.steps, steps);
    assert.equal((await L.pg`select id from ledger where task_id = ${id}`).length, 0);
  } finally {
    await L.pg`alter table follow_ups drop constraint hold_task_run`;
  }
  await Promise.all([finish(2), finish(2)]);
  await assert.rejects(save(2, 'Too late'), { status: 409 });
  const entry = await route.GET({ params: { id: String(id) } } as Parameters<typeof route.GET>[0]);
  assert.deepEqual(await entry.json(), { response: corrected, responseVersion: 2 });
  const task = await L.task(id);
  assert.equal(task?.status, 'done');
  assert.deepEqual(task?.steps, steps);
  assert.equal(task?.via, 'paige');
  assert.deepEqual(await L.taskFiles(id), [path]);
  assert.equal(readFileSync(file, 'utf8'), list);
  const records = await L.pg`select actor from ledger where task_id = ${id}`;
  assert.equal(records.length, 1);
  assert.equal(records[0].actor, 'owner');
  let reply = '';
  await chat(
    'lead',
    'Which list did I save?',
    (e) => {
      if (e.type === 'done') reply = e.text;
    },
    { kind: 'task', id }
  );
  const about = JSON.parse(reply.slice(0, reply.lastIndexOf('\nOutcome:'))) as Gave;
  assert.ok(about.message.endsWith(corrected));

  const queued = (await L.followUpsToDo()).filter((f) => f.task?.id === id);
  assert.equal(queued.length, 1);
  const claim = await L.startFollowUp(queued[0].id);
  assert.ok(claim);
  const run = await followThrough(claim, undefined, queued[0].task);
  assert.equal(run.outcome, 'done', run.text);
  const { message, system } = JSON.parse(run.text) as Gave;
  assert.ok(
    message.endsWith(corrected),
    'the Odd must get the exact saved words, including the final newline'
  );
  assert.ok(system.includes(`Reference files: ${file}`));
});

test('a task can require a response and a choice without any file', async () => {
  const t = await L.giveTask('lead', {
    title: 'Choose the flowers',
    why: 'For the table.',
    steps: [
      { text: 'Choose a vase', done: false, action: { kind: 'choice', options: ['Tall', 'Short'] } }
    ],
    response: ''
  });
  await assert.rejects(post(t.id, { op: 'finish' }), { status: 409 });
  await post(t.id, { op: 'response', response: 'Daisies', version: 0 });
  await assert.rejects(post(t.id, { op: 'finish', version: 1 }), { status: 409 });
  assert.equal((await L.task(t.id))?.status, 'open');
  await post(t.id, { op: 'choose', index: 0, answer: 'Tall' });
  await post(t.id, { op: 'finish', version: 1 });
  assert.equal((await L.task(t.id))?.response, 'Daisies');
});
