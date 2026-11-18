// What each kind of run an Odd makes is told, held word for word in
// prompts.test.ts.snapshot beside this file: a chat, a chat with an outside
// tool held back by the level, the Office Manager's chat, a hire's hello, a
// job, one follow-up of each kind, and a hand-off to an Odd the owner lets act
// on its own on work from colleagues. A change to what Odds are told fails
// here until it is accepted with `npm run prompts:accept -w @oddboro/office`,
// so review reads it line by line. The cases share one database, so a new
// case goes at the end, where it moves no id in the cases before it. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, snapshot, test } from 'node:test';
import type { FollowUpKind } from '@oddboro/ledger';
import { setZone } from '@oddboro/ledger/time';
import {
  chatOf,
  folder,
  followThrough,
  gave,
  gaveIn,
  history,
  L,
  onPlatform,
  plain,
  startedBy,
  type Gave
} from './office-under-test.ts';

// After the office under test set its home, as the office's own imports are.
const { firstDay, runJob } = await import('./staff.ts');

// Each prompt line is a line of the file, so a changed line shows as one.
snapshot.setDefaultSnapshotSerializers([(s: unknown) => s]);
// The time every prompt says it is. Date alone, so timers still fire.
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T02:41:00Z') });
setZone('America/New_York');
// Before any hire or run: the Office Manager's job description takes it at hire.
await L.setOwnerName('Nora');

/** The run's system prompt, then its message, as one text. */
const told = (g: Gave): string =>
  // `plain` puts stand-ins for this machine's paths and each run's ids.
  plain([`${g.system}\n\n<message>\n\n${g.message}`])[0];

/**
 * What the follow-up `id` was given when it ran, started as follow-ups.ts
 * starts one. Not `runOf`, which passes only the ask, so a goal or task
 * follow-up would run without its goal or task.
 */
async function dueRun(id: number): Promise<Gave> {
  const due = (await L.followUpsToDo()).find((d) => d.id === id);
  assert.ok(due, `follow-up ${id} is not due`);
  const f = await L.startFollowUp(id);
  assert.ok(f, `follow-up ${id} could not start`);
  const r = await followThrough(f, due.ask, due.task, due.goal);
  assert.equal(r.outcome, 'done', r.text);
  return JSON.parse(r.text) as Gave;
}

/** An ask from Paige, as a run raises one. */
const askFromPaige = async (title: string) =>
  (
    await L.raiseAsk('paige', {
      title,
      why: 'The team asked for it.',
      ifApproved: 'Paige books it.'
    })
  ).ask.id;

/** The one follow-up of `kind` for `staffId` on `thread`. */
async function onThread(staffId: string, kind: FollowUpKind, thread: number): Promise<number> {
  const [row] = await L.pg<{ id: number }[]>`
    select id from follow_ups
    where staff_id = ${staffId} and kind = ${kind} and thread_id = ${thread}`;
  assert.ok(row, `${staffId} has no ${kind} on thread ${thread}`);
  return row.id;
}

let manager = '';

test("an Odd's chat is told exactly what its snapshot holds", (t) =>
  onPlatform('linux', async () => {
    t.assert.snapshot(told(await chatOf('paige', 'What is on today?')));
  }));

test('a chat whose outside tool waits on a higher level is told exactly what its snapshot holds', (t) =>
  onPlatform('linux', async () => {
    await L.addConnector({
      id: 'notes',
      name: 'Notes',
      description: 'Notes for tests.',
      kind: 'http',
      config: { url: 'http://127.0.0.1:9/mcp' },
      readTools: ['read_note'],
      tools: ['read_note', 'write_note'],
      readyAt: new Date()
    });
    await L.pg`update staff set permission = 'read' where id = 'cleo'`;
    await L.pg`insert into grants (staff_id, connector_id, level) values ('cleo', 'notes', 'act')`;
    t.assert.snapshot(told(await chatOf('cleo', 'Can you write a note?')));
  }));

test("the Office Manager's chat is told exactly what its snapshot holds", (t) =>
  onPlatform('linux', async () => {
    manager = (await L.hireManager({ preset: 'marshall' })).id;
    t.assert.snapshot(told(await chatOf(manager, 'How is the office?')));
  }));

test("a new hire's hello is told exactly what its snapshot holds", (t) =>
  onPlatform('linux', async () => {
    // Sam has no job and serves no goal, so the hello starts nothing more.
    await firstDay('sam');
    t.assert.snapshot(told(gaveIn(history('sam').at(-1)!.text)));
  }));

test("the Office Manager's daily report job is told exactly what its snapshot holds", (t) =>
  onPlatform('linux', async () => {
    const [job] = (await L.jobsFor(manager)).filter((j) => j.name === 'Daily office report');
    assert.ok(job, 'the Office Manager has no daily report');
    t.assert.snapshot(told(gaveIn((await runJob(job)).text)));
  }));

/**
 * One follow-up of each kind, made as the office makes it: each returns the
 * follow-up's id. A new kind fails the type check until it has a case here.
 */
const FOLLOW_UPS: Record<FollowUpKind, () => Promise<number>> = {
  carry_out: async () => {
    const id = await askFromPaige('Book the room for Friday');
    await L.decideAsk(id, 'approve', 'Friday is fine.');
    return startedBy(id, 'carry_out');
  },
  rework: async () => {
    const id = await askFromPaige('Order lunch for the team');
    await L.decideAsk(id, 'iterate', 'Make it for twelve, not ten.');
    return startedBy(id, 'rework');
  },
  denied: async () => {
    const id = await askFromPaige('Move the meeting to Monday');
    await L.decideAsk(id, 'deny', 'Monday is full.');
    return startedBy(id, 'denied');
  },
  task_done: async () => {
    const t = await L.giveTask('paige', {
      title: 'Choose a day for the party',
      why: 'The room needs booking.',
      steps: ['Pick a date']
    });
    await L.finishTask(t.id, true, 'Friday works.');
    const [f] = await L.pg<{ id: number }[]>`
      select id from follow_ups where task_id = ${t.id} and kind = 'task_done'`;
    return f.id;
  },
  goal: async () => {
    const [g] = await L.pg<{ id: number }[]>`
      insert into goals (title) values ('Plant the orchard') returning id`;
    const [f] = await L.pg<{ id: number }[]>`
      insert into follow_ups (staff_id, kind, goal_id) values (${manager}, 'goal', ${g.id})
      returning id`;
    return f.id;
  },
  first_day: async () => {
    const [f] = await L.pg<{ id: number }[]>`
      insert into follow_ups (staff_id, kind) values ('sam', 'first_day') returning id`;
    return f.id;
  },
  hand_off: async () => (await gave('lead', 'paige', { title: 'Count the chairs' })).id,
  handed_back: async () => {
    const h = await gave('lead', 'cleo', { title: 'Count the tables' });
    const f = await L.startFollowUp(h.id);
    assert.ok(f, "Cleo's hand-off could not start");
    await L.finishFollowUp(f, 'Count the tables', 'done', 'Twelve tables.');
    return onThread('lead', 'handed_back', h.thread);
  },
  resume: async () => {
    const h = await gave('lead', 'sam', { title: 'Count the lamps' });
    // The owner's no to an ask the lead raised there wakes it with their words.
    const { ask } = await L.raiseAsk('lead', {
      title: 'Count only the floor lamps',
      why: 'They are the ones on the list.',
      ifApproved: 'Sam counts the floor lamps.',
      threadId: h.thread
    });
    await L.decideAsk(ask.id, 'deny', 'Count the desk lamps too.');
    return onThread('lead', 'resume', h.thread);
  },
  answered: async () => {
    // A no with no words to an ask on no work wakes its Odd once with the answer.
    const id = await askFromPaige('Book the hall for Friday');
    await L.decideAsk(id, 'deny', null);
    return startedBy(id, 'answered');
  },
  edited: async () => {
    const notes = join(folder, 'staff', 'cleo', 'notes');
    mkdirSync(notes, { recursive: true });
    const after = 'Lunch at noon.\nThe party on Friday.';
    writeFileSync(join(notes, 'plan.md'), after);
    assert.ok(
      await L.learnFromEdit(
        'cleo',
        { path: 'notes/plan.md', before: 'The party on Friday.' },
        after
      )
    );
    const [f] = await L.pg<{ id: number }[]>`
      select id from follow_ups where staff_id = 'cleo' and kind = 'edited' and outcome is null`;
    return f.id;
  }
};

for (const kind of L.FOLLOW_UP_KINDS)
  test(`a ${kind} follow-up is told exactly what its snapshot holds`, (t) =>
    onPlatform('linux', async () => {
      t.assert.snapshot(told(await dueRun(await FOLLOW_UPS[kind]())));
    }));

test("a hand-off to an Odd at Act that acts on its own on colleagues' work is told exactly what its snapshot holds", (t) =>
  onPlatform('linux', async () => {
    await L.pg`update staff set permission = 'act', acts_on_hand_offs = true where id = 'paige'`;
    const h = await gave('lead', 'paige', { title: 'Count the cups' });
    t.assert.snapshot(told(await dueRun(h.id)));
  }));
