// The same ask and task routes serve chat and the Desk in this throwaway office.
// An answer given on a card in an Odd's chat brings the run it starts back
// there as the Odd's reply under that card; one given on the Desk does not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatAnswer } from '../ui/task-steps.ts';
import { L, followThrough, refusal } from './office-under-test.ts';

const goalRoute = await import('../../routes/api/goals/+server.ts');
const asks = await import('../../routes/api/asks/[id]/+server.ts');
const tasks = await import('../../routes/api/tasks/[id]/+server.ts');
const { chatLog } = await import('./staff.ts');
const { endFollowUp } = await import('./follow-ups.ts');

/** Run the follow-up the owner's answer on `on` started, and end it as the office does. */
async function runFollowUp(on: { ask?: number; task?: number }) {
  const waiting = (await L.followUpsToDo()).filter(
    (f) => (on.ask && f.ask?.id === on.ask) || (on.task && f.task?.id === on.task)
  );
  assert.equal(waiting.length, 1);
  const w = waiting[0];
  const f = await L.startFollowUp(w.id);
  assert.ok(f, 'the follow-up did not start');
  const r = await followThrough(f, w.ask, w.task, w.goal);
  await endFollowUp(f, await L.workTitle(f), r.outcome, r.text, r.joined);
  return { f, r };
}

/** The Odd's lines in its chat that answer a card. */
const answersIn = async (id: string) =>
  (await chatLog(id)).filter((l) => l.from === 'staff' && l.told && l.re);

const post = async <E>(
  route: (event: E) => ReturnType<typeof asks.POST>,
  id: number,
  body: unknown
) =>
  route({
    params: { id: String(id) },
    request: new Request('http://office', { method: 'POST', body: JSON.stringify(body) })
  } as E);

const propose = async (title: string, revises?: number) =>
  (
    await L.raiseAsk('lead', {
      kind: 'goal',
      revises,
      title,
      why: 'The owner asked about this.',
      ifApproved: 'Plan it.',
      goal: { title, area: 'work', horizon: 'quarter' }
    })
  ).ask;

test('one proposal sets one goal, even from two open cards or on a repeated click', async () => {
  await L.pg`update staff set role = ${L.MANAGER_ROLE} where id = 'lead'`;
  const a = await propose('Map the orchard');
  const b = await propose('Map the garden');
  const decide = () => post(asks.POST, b.id, { decision: 'approve' });
  const both = await Promise.allSettled([decide(), decide()]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await refusal(decide())).status, 409);
  const goals = await L.allGoals();
  assert.deepEqual(
    goals.map((g) => g.title),
    [b.title]
  );
  const planning =
    await L.pg`select * from follow_ups where kind = 'goal' and goal_id = ${goals[0].id}`;
  assert.equal(planning.length, 1);
  const desk = await L.desk();
  assert.ok(desk.asks.some((r) => r.id === a.id));
  assert.ok(!desk.asks.some((r) => r.id === b.id));
  // Setting it is one decision, so the Desk lists it once, not the goal set again.
  assert.deepEqual(
    desk.recent.filter((r) => r.title.includes(b.title)).map((r) => r.title),
    [`Approved: ${b.title}`]
  );
  const chat = await chatLog('lead');
  assert.equal(
    chat.find((l) => l.item?.kind === 'ask' && l.item.id === b.id)?.item?.status,
    'approved'
  );
});

test('approving a replaced card never accepts its replacement', async () => {
  const a = await propose('Survey the paths');
  const replacement = await propose('Survey just the north path', a.id);
  assert.equal((await refusal(post(asks.POST, a.id, { decision: 'approve' }))).status, 409);
  assert.equal((await L.ask(replacement.id))?.status, 'open');
  assert.ok(
    !(await L.allGoals()).some((g) => g.title === a.title || g.title === replacement.title)
  );
});

test('a plan applies the ticked part of an owner-created goal', async () => {
  const g = await L.addGoal({ title: 'Plan a field day', horizon: 'quarter', area: 'work' });
  const { ask } = await L.raiseAsk('lead', {
    kind: 'plan',
    title: 'Field day assignments',
    why: 'One Odd maps the site.',
    ifApproved: 'Assign the work.',
    plan: {
      goalId: g.id,
      items: [
        { kind: 'assign', staff: 'paige', part: 'Map the route.' },
        { kind: 'assign', staff: 'cleo', part: 'Mark the turn.' }
      ]
    }
  });
  await post(asks.POST, ask.id, { decision: 'approve', picks: [1] });
  const saved = (await L.allGoals()).find((row) => row.id === g.id);
  assert.deepEqual(
    saved?.staff.map((s) => s.staffId),
    ['cleo']
  );
  const reason = (await L.ask(ask.id))?.reason;
  assert.match(reason ?? '', /Approved: Cleo: Mark the turn/);
  assert.match(reason ?? '', /Left out: Paige: Map the route/);
  // One line for the plan's yes, not another for Cleo serving the goal.
  const recent = (await L.desk()).recent;
  assert.deepEqual(
    recent.filter((row) => row.reason === reason).map((row) => row.title),
    ['Approved: Field day assignments']
  );
  assert.ok(!recent.some((row) => row.title.includes('serves the goal')));
  assert.ok(
    (await chatLog('lead')).some((line) => line.item?.id === ask.id && line.item.note === reason)
  );
});

test('finishing with a written answer commits one note and gives it to one follow-up', async () => {
  const question = await L.giveTask('paige', {
    title: 'When should the map be ready?',
    why: 'Set the deadline.',
    steps: ['Give a date.']
  });
  const note = 'Friday, before the first tour.';
  const finish = () => post(tasks.POST, question.id, { op: 'finish', done: true, note });
  const both = await Promise.allSettled([finish(), finish()]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await refusal(finish())).status, 409);
  const desk = await L.desk();
  assert.ok(!desk.tasks.some((row) => row.id === question.id));
  assert.ok(desk.recent.some((row) => row.reason === note));
  const shown = (await chatLog('paige')).find(
    (l) => l.item?.kind === 'task' && l.item.id === question.id
  );
  assert.equal(shown?.item?.status, 'done');
  assert.equal(shown?.item?.note, note);
  const waiting = (await L.followUpsToDo()).filter((f) => f.task?.id === question.id);
  assert.equal(waiting.length, 1);
  const f = await L.startFollowUp(waiting[0].id);
  assert.equal(f?.kind, 'task_done');
  assert.equal(f?.note, note);
  const result = await followThrough(f!, undefined, waiting[0].task);
  assert.equal(result.outcome, 'done', result.text);
  assert.ok(JSON.parse(result.text).system.includes(note));
});

test('a failed follow-up leaves the question on the Desk to answer again', async () => {
  const q = await L.giveTask('paige', {
    title: 'Which trail should we map?',
    why: 'Pick the route.',
    steps: ['Name the trail.']
  });
  // Fail just this pickup, after the task and its ledger entry have been written.
  await L.pg`alter table follow_ups add constraint refuse_test_pickup check (note <> 'Ridge trail')`;
  try {
    await assert.rejects(post(tasks.POST, q.id, { op: 'finish', note: 'Ridge trail' }));
    assert.equal((await L.task(q.id))?.status, 'open');
    assert.equal((await L.pg`select id from ledger where task_id = ${q.id}`).length, 0);
  } finally {
    await L.pg`alter table follow_ups drop constraint refuse_test_pickup`;
  }
  await post(tasks.POST, q.id, { op: 'finish', note: 'Ridge trail' });
  assert.equal((await L.pg`select id from follow_ups where task_id = ${q.id}`).length, 1);
});

test("one explicit manager chat submission sets the owner's goal and starts planning once", async () => {
  const request = {
    managerId: 'lead',
    requestId: '12345678-1234-4234-8123-456712345678',
    title: 'Measure the north field'
  };
  const set = (body: unknown) => post(goalRoute.POST, 0, body).then((r) => r.json());
  const [one, two] = await Promise.all([set(request), set(request)]);
  assert.equal(one.id, two.id);
  assert.equal(one.title, request.title);
  assert.ok(
    (await L.desk()).recent.some((entry) => entry.title === `Set a goal: ${request.title}`)
  );
  assert.equal((await set(request)).id, one.id);
  assert.equal(
    (await L.pg`select id from follow_ups where goal_id = ${one.id} and kind = 'goal'`).length,
    1
  );
  assert.equal(
    (await L.pg`select id from ledger where title = ${'Set a goal: ' + request.title}`).length,
    1
  );
  assert.ok((await chatLog('lead')).some((l) => l.thread?.line.title === request.title));
  await assert.rejects(set({ ...request, title: 'Measure another field' }), { status: 409 });
  await assert.rejects(set({ ...request, managerId: 'paige' }), { status: 409 });
  await assert.rejects(set({ ...request, title: 'a'.repeat(141) }), { status: 400 });
  const manual = await set({ title: 'Count the fruit', horizon: 'year', area: 'garden' });
  assert.equal(manual.horizon, 'year');
  assert.equal(manual.requestId, null);
});

test('the Desk lists each decision and answer once', async () => {
  const back = await propose('Weed the beds');
  await post(asks.POST, back.id, { decision: 'iterate', reason: 'Just the front beds.' });
  const set = await propose('Plant the bulbs');
  await post(asks.POST, set.id, { decision: 'approve' });
  const chore = await L.giveTask('paige', {
    title: 'Buy the bulbs',
    why: 'They go in this week.',
    steps: ['Buy them.']
  });
  await post(tasks.POST, chore.id, { op: 'finish', done: true, note: 'Bought forty.' });
  const recent = (await L.desk()).recent.map((r) => r.title);
  assert.deepEqual(recent.slice(0, 3), [
    `Done by ${await L.ownerName()}: Buy the bulbs`,
    'Approved: Plant the bulbs',
    'Sent back: Weed the beds'
  ]);
});

test("a task answered in chat's response editor gets the Odd's reply there, under the task, once", async () => {
  const q = await L.giveTask('paige', {
    title: 'What hour does your studio day start?',
    why: 'To set the reminders.',
    steps: []
  });
  // A plain question has no response yet: the chat opens its editor empty.
  assert.equal(q.response, null);
  assert.deepEqual(chatAnswer(q, false), { steps: [] });
  const words = '9 AM, Monday to Friday.\nNot {owner} holidays.';
  // As Save and finish does: save the words at the version opened, then finish with it, from the chat.
  const saved = await post(tasks.POST, q.id, { op: 'response', version: 0, response: words });
  assert.deepEqual(await saved.json(), { response: words, responseVersion: 1 });
  await post(tasks.POST, q.id, { op: 'finish', done: true, version: 1, chat: true });
  assert.equal((await L.task(q.id))?.status, 'done');
  // The saved words are the answer the Desk lists.
  assert.equal((await L.desk()).recent.find((d) => d.title.endsWith(q.title))?.reason, words);
  const before = (await answersIn('paige')).length;
  const { f, r } = await runFollowUp({ task: q.id });
  assert.deepEqual(f.chatCard, { kind: 'task', id: q.id, title: q.title });
  assert.equal(r.outcome, 'done', r.text);
  assert.ok((JSON.parse(r.text) as { message: string }).message.endsWith(words));
  const lines = await answersIn('paige');
  assert.equal(lines.length, before + 1);
  const line = lines.at(-1)!;
  assert.deepEqual(line.re, { kind: 'task', id: q.id, title: q.title });
  assert.equal(line.text, r.text);
  assert.equal(line.runFailed, undefined);
  // The Ledger keeps its line as before.
  assert.equal(
    (await L.pg`select id from ledger where title like ${'%' + q.title} and actor = 'paige'`)
      .length,
    1
  );
  // Ending it again writes nothing more.
  await endFollowUp(f, q.title, 'done', 'Again.');
  assert.equal((await answersIn('paige')).length, before + 1);
});

test('a task finished on the Desk adds no line to the chat', async () => {
  const q = await L.giveTask('paige', {
    title: 'Which day suits the tour?',
    why: 'To book it.',
    steps: ['Name a day.']
  });
  await post(tasks.POST, q.id, { op: 'finish', done: true, note: 'Thursday.' });
  const before = (await answersIn('paige')).length;
  const { f } = await runFollowUp({ task: q.id });
  assert.equal(f.chatCard, null);
  assert.equal((await answersIn('paige')).length, before);
});

test('a proposal sent back in chat gets the reworked reply in chat', async () => {
  const a = await propose('Plant the hedge');
  await post(asks.POST, a.id, {
    decision: 'iterate',
    reason: 'Only the north side.',
    chat: true
  });
  const { f, r } = await runFollowUp({ ask: a.id });
  assert.equal(f.kind, 'rework');
  const line = (await answersIn('lead')).at(-1);
  assert.deepEqual(line?.re, { kind: 'ask', id: a.id, title: a.title });
  assert.equal(line?.text, r.text);
});

test('a no with no reason in chat to an ask on no work, or a task dropped in chat on no work, wakes its Odd once with the answer, replying under the card', async () => {
  const { ask } = await L.raiseAsk('paige', {
    title: 'Book the hall for Friday',
    why: 'For the meeting.',
    ifApproved: 'Book it.'
  });
  await post(asks.POST, ask.id, { decision: 'deny', chat: true });
  const before = (await answersIn('paige')).length;
  const { f, r } = await runFollowUp({ ask: ask.id });
  assert.equal(f.kind, 'answered');
  assert.deepEqual(f.chatCard, { kind: 'ask', id: ask.id, title: ask.title });
  const lines = await answersIn('paige');
  assert.equal(lines.length, before + 1);
  assert.deepEqual(lines.at(-1)?.re, { kind: 'ask', id: ask.id, title: ask.title });
  assert.equal(lines.at(-1)?.text, r.text);

  const q = await L.giveTask('paige', { title: 'Order the chairs', why: 'w', steps: [] });
  await post(tasks.POST, q.id, { op: 'finish', done: false, note: 'Not now.', chat: true });
  const card = { kind: 'task', id: q.id, title: q.title };
  const dropped = await runFollowUp({ task: q.id });
  assert.equal(dropped.f.kind, 'answered');
  assert.deepEqual(dropped.f.chatCard, card);
  const after = await answersIn('paige');
  assert.equal(after.length, lines.length + 1);
  assert.deepEqual(after.at(-1)?.re, card);
  assert.equal(after.at(-1)?.text, dropped.r.text);
});

test('a failed run on a chat answer says so in one line under the card', async () => {
  const q = await L.giveTask('paige', { title: 'Which room is quiet?', why: 'w', steps: [] });
  await post(tasks.POST, q.id, { op: 'finish', done: true, note: 'The back room.', chat: true });
  const waiting = (await L.followUpsToDo()).find((w) => w.task?.id === q.id);
  const f = await L.startFollowUp(waiting!.id);
  await endFollowUp(f!, q.title, 'failed', 'Claude Code is signed out.\nTry again later.');
  const line = (await answersIn('paige')).at(-1);
  assert.equal(line?.re?.id, q.id);
  assert.equal(line?.runFailed, true);
  assert.equal(line?.failed, undefined);
  assert.equal(line?.text, 'Could not finish this: Claude Code is signed out. Try again later.');
});

test('a goal or plan approved in chat marks the run it starts to reply there', async () => {
  const g = await propose('Mend the fence');
  await post(asks.POST, g.id, { decision: 'approve', chat: true });
  const [goal] = (await L.allGoals()).filter((row) => row.title === g.title);
  const [planning] = await L.pg<{ chat_card: unknown }[]>`
    select chat_card from follow_ups where kind = 'goal' and goal_id = ${goal.id}`;
  assert.deepEqual(planning.chat_card, { kind: 'ask', id: g.id, title: g.title });
  const { ask: plan } = await L.raiseAsk('lead', {
    kind: 'plan',
    title: 'Fence assignments',
    why: 'One Odd mends it.',
    ifApproved: 'Assign the work.',
    plan: { goalId: goal.id, items: [{ kind: 'assign', staff: 'cleo', part: 'Mend the gate.' }] }
  });
  await post(asks.POST, plan.id, { decision: 'approve', picks: [0], chat: true });
  const [resume] = await L.pg<{ chat_card: unknown }[]>`
    select chat_card from follow_ups
    where staff_id = 'lead' and kind = 'resume' and ask_id = ${plan.id}`;
  assert.deepEqual(resume?.chat_card, { kind: 'ask', id: plan.id, title: plan.title });
});

test('a choice task finishes in chat with the tapped choice', async () => {
  const q = await L.giveTask('cleo', {
    title: 'Should these emails reach you?',
    why: 'They keep coming.',
    steps: [
      { text: 'Choose one.', done: false, action: { kind: 'choice', options: ['Yes', 'No'] } }
    ]
  });
  const how = chatAnswer(q, false);
  assert.deepEqual(how, { steps: [], choice: { index: 0, options: ['Yes', 'No'] } });
  // As the chat's tap does: the choice, then the finish, from the chat.
  await post(tasks.POST, q.id, { op: 'choose', index: how!.choice!.index, answer: 'No' });
  await post(tasks.POST, q.id, { op: 'finish', done: true, note: '', chat: true });
  const done = await L.task(q.id);
  assert.equal(done?.status, 'done');
  assert.equal(done?.steps[0].answer, 'No');
  // The Desk's recent answers show the tapped choice, as a typed answer shows its words.
  const line = (await L.desk()).recent.find((d) => d.title.endsWith(q.title));
  assert.equal(line?.reason, 'No');
  const { f, r } = await runFollowUp({ task: q.id });
  assert.deepEqual(f.chatCard, { kind: 'task', id: q.id, title: q.title });
  assert.ok(JSON.parse(r.text).system.includes('with: No'));
  assert.equal((await answersIn('cleo')).at(-1)?.re?.id, q.id);
});

test('a task with an attachment or a sign-in step stays on the Desk', async () => {
  const q = await L.giveTask('cleo', {
    title: 'Fill in the intake',
    why: 'w',
    steps: [],
    attach: ['intake.md']
  });
  // As the chat reads it: the Desk's attachments name the task.
  const attached = (await L.desk()).attachments.some((f) => f.taskId === q.id);
  assert.equal(attached, true);
  assert.equal(chatAnswer(q, attached), undefined);
  const signIn = await L.giveTask('cleo', {
    title: 'Sign in to the calendar',
    why: 'w',
    steps: [
      {
        text: 'Click Sign in.',
        done: false,
        key: 'oauth:gcal',
        action: { kind: 'oauth', connector: 'gcal' }
      }
    ]
  });
  assert.equal(chatAnswer(signIn, false), undefined);
});

test('a yes to access whose grant fails tells the owner why, as the Desk shows a refusal, and the ask reads approved', async () => {
  const { ask } = await L.raiseAsk('sam', {
    title: 'Connect Gmail to send',
    why: 'To send the invoices.',
    ifApproved: 'Send them.',
    access: { connector: 'gmail', level: 'act' }
  });
  // The owner lowers Sam to Read while the ask waits on the Desk.
  await L.pg`update staff set permission = 'read' where id = 'sam'`;
  try {
    assert.deepEqual(await refusal(post(asks.POST, ask.id, { decision: 'approve' })), {
      status: 400,
      message: 'Sam holds read, so it cannot be given act'
    });
    assert.equal((await L.ask(ask.id))?.status, 'approved');
  } finally {
    await L.pg`update staff set permission = 'act' where id = 'sam'`;
  }
});
