// What a follow-up run is told, kind by kind. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASK_KINDS,
  FOLLOW_UP_KINDS,
  type AskKind,
  type AskRow,
  type FollowUpKind,
  type FollowUpRow,
  type GoalRow,
  type TaskRow
} from '@oddboro/ledger';
import { OWNER_ANSWERS } from '@oddboro/ledger/desk-answers';
import { followUpBrief } from './follow-up-brief.ts';

// Only the fields a brief reads are filled in; the rest of each row stays out.
const followUp = (kind: FollowUpKind) => ({ kind, note: 'Their words' }) as FollowUpRow;
const ask = {
  id: 7,
  kind: 'approval',
  status: 'approved',
  title: 'Send it',
  why: 'Because',
  ifApproved: 'It goes'
} as AskRow;
const task = {
  row: { id: 4, title: 'Sign in', why: 'Needed', steps: [] } as unknown as TaskRow,
  files: []
};
const goal = {
  id: 2,
  title: 'More clients',
  area: 'work',
  horizon: 'ongoing',
  why: null,
  doneWhen: null
} as unknown as GoalRow;

const FEEDBACK = /^\{owner\} gave feedback\./;
const briefOf = (
  kind: FollowUpKind,
  rows: { t?: typeof task; g?: GoalRow } = { t: task, g: goal }
) => followUpBrief(followUp(kind), ask, rows.t, rows.g);

test('a call the office made tells the Odd not to make it again, with what came back', () => {
  const lines = followUpBrief(followUp('carry_out'), {
    ...ask,
    kind: 'call',
    call: {
      connector: 'notes',
      tool: 'capture',
      arguments: { text: 'a thought' },
      result: { ok: true, text: 'captured', at: '2026-11-09T00:00:00.000Z' }
    }
  });
  assert.match(lines[0], /the office made it for you\. Do not make it again\./);
  assert.ok(lines.includes('- What it returned: captured'));
});

test('only an Odd at Draft is offered a standing yes after a call the office made, and never after a no', () => {
  const called = (ok: boolean): typeof ask => ({
    ...ask,
    kind: 'call',
    call: {
      connector: 'notes',
      tool: 'capture',
      arguments: {},
      result: { ok, text: ok ? 'captured' : 'failed', at: '2026-11-09T00:00:00.000Z' }
    }
  });
  const offers = (lines: string[]) => lines.some((l) => l.includes('ask_for_standing_yes'));
  const carry = (level: 'draft' | 'act', ok = true) =>
    followUpBrief(followUp('carry_out'), called(ok), undefined, undefined, { level });
  assert.equal(offers(carry('draft')), true);
  assert.equal(offers(carry('act')), false);
  assert.equal(offers(carry('draft', false)), false);
  assert.equal(offers(followUpBrief(followUp('denied'), called(true))), false);
});

test("a finished task's run hears only the owner's choice answers", () => {
  const steps = [
    {
      text: 'Paste the key',
      done: true,
      answer: 'not-for-the-odd',
      action: { kind: 'secret', connector: 'c', name: 'n' }
    },
    {
      text: 'Pick a blue',
      done: true,
      answer: 'Navy',
      action: { kind: 'choice', options: ['Navy', 'Teal'] }
    }
  ] as TaskRow['steps'];
  const lines = briefOf('task_done', { t: { row: { ...task.row, steps }, files: [] } });
  assert.ok(lines.includes('- They answered "Pick a blue" with: Navy'), lines.join('\n'));
  assert.ok(!lines.join('\n').includes('not-for-the-odd'), lines.join('\n'));
});

test("a task given in a chat brings the owner's words there to the run that picks it up, beside their note, and a task given elsewhere is briefed as before", () => {
  const said = 'Give me a task asking for my favourite colour.\nThen write my answer to colour.md.';
  const plain = briefOf('task_done');
  const lines = briefOf('task_done', { t: { row: { ...task.row, ownerSaid: said }, files: [] } });
  const quoted =
    '- What {owner} said in chat when you gave it: "Give me a task asking for my favourite colour. Then write my answer to colour.md."';
  assert.ok(lines.includes(quoted), lines.join('\n'));
  assert.ok(
    lines.indexOf(quoted) < lines.indexOf('- Their note: Their words'),
    'it sits with what the owner gave, before their note'
  );
  assert.ok(
    lines.some((l) => l.startsWith('2. Do what they asked for in chat, or the next step')),
    lines.join('\n')
  );
  assert.ok(!plain.join('\n').includes('in chat'), plain.join('\n'));
  assert.equal(lines.length, plain.length + 1, 'the quoted line is the only line added');
});

test('a switch the owner turned on tells the Odd its run has it, names what it asked for, and does the work once for a twin ask', () => {
  const asked = { ...ask, kind: 'switch', switches: ['web'] } as AskRow;
  const twin = { ...ask, id: 8 } as AskRow;
  const lines = followUpBrief(followUp('carry_out'), asked, undefined, undefined, { also: [twin] });
  assert.equal(
    lines[0],
    '{owner} approved your ask #7 and turned on Browse the web for you. This run has it.'
  );
  assert.match(lines[1], /^This also answers your ask #8, /);
  assert.ok(lines.includes('- What you asked to turn on: Browse the web'));
});

test('a level the owner raised tells the Odd its run has it, and that hand-offs stay at Draft', () => {
  const lines = followUpBrief(followUp('carry_out'), { ...ask, kind: 'level', level: 'act' });
  assert.equal(lines[0], '{owner} approved your ask #7 for the Act level, and this run has it.');
  assert.equal(
    lines[1],
    'Work a colleague hands you, and a thread you pick back up, still runs at Draft at most.'
  );
  assert.ok(lines.includes('- The level you asked for: Act'), lines.join('\n'));
});

test('a level raised to Act, when the owner lets the Odd act on its own on work from colleagues, says hand-offs run at Act too', () => {
  const lines = followUpBrief(
    followUp('carry_out'),
    { ...ask, kind: 'level', level: 'act' },
    undefined,
    undefined,
    { actsOnHandOffs: true }
  );
  assert.equal(lines[0], '{owner} approved your ask #7 for the Act level, and this run has it.');
  assert.equal(
    lines[1],
    '{owner} lets you act on your own on work a colleague hands you, so it runs at Act too. A thread you pick back up still runs at Draft at most.'
  );
});

test("a level raised to Act, carried out for a colleague's hand-off, tells the Odd this run stays at Draft", () => {
  const lines = followUpBrief(
    followUp('carry_out'),
    { ...ask, kind: 'level', level: 'act' },
    undefined,
    undefined,
    { draftOnly: true }
  );
  assert.equal(
    lines[0],
    "{owner} approved your ask #7 for the Act level. Your own work runs at Act from now on; this run serves a colleague's hand-off, so it works at Draft at most."
  );
  assert.equal(lines[1], '');
});

test("a level raised to Draft, carried out for a colleague's hand-off, tells the Odd its run has it", () => {
  const lines = followUpBrief(
    followUp('carry_out'),
    { ...ask, kind: 'level', level: 'draft' },
    undefined,
    undefined,
    { draftOnly: true }
  );
  assert.equal(lines[0], '{owner} approved your ask #7 for the Draft level, and this run has it.');
  assert.equal(lines[1], '');
});

test('office tools the owner turned on tell the Odd its run has them', () => {
  const lines = followUpBrief(followUp('carry_out'), {
    ...ask,
    kind: 'office_tool',
    officeTools: ['office_report']
  });
  assert.equal(
    lines[0],
    '{owner} approved your ask #7 and turned on Office report for you. This run has it.'
  );
  assert.ok(lines.includes('- What you asked to turn on: Office report'), lines.join('\n'));
});

/**
 * The tool an Odd raises each kind of ask with, or null when the office raises
 * it (a held hand-off, the usage window, a held outside call, missed job runs) or more than one
 * tool does (`leave_office` and `remove_odd`). Keyed by AskKind, so a new kind
 * fails the type check here until it names its tool.
 */
const RAISED_WITH: Record<AskKind, string | null> = {
  approval: 'raise_ask',
  access: 'ask_for_access',
  hire: 'propose_hire',
  goal: 'propose_goal',
  plan: 'propose_goal_plan',
  hand_offs: null,
  window: null,
  reply: 'propose_reply',
  filter: 'propose_filter',
  folder: 'ask_for_folder',
  switch: 'ask_for_switch',
  level: 'ask_for_level',
  office_tool: 'ask_for_office_tool',
  call: null,
  remove: null,
  bring_back: 'bring_back_odd',
  catch_up: null,
  standing: 'ask_for_standing_yes'
};

test('the rework brief names the tool each kind an Odd can rework is raised with', () => {
  const brief = briefOf('rework').join('\n');
  for (const kind of ASK_KINDS) {
    const tool = RAISED_WITH[kind];
    if (OWNER_ANSWERS.ask[kind].iterate === 'refused' || tool === null) continue;
    assert.ok(brief.includes(tool), `${kind}: the rework brief names ${tool}`);
  }
});

test('every follow-up kind gets its own brief, and a hand-off with no hand-off row, a goal with no goal and a task_done with no task get the feedback brief', () => {
  // A hand-off, a hand-back and an edit are briefed before this when their row is there.
  const feedbackKinds: FollowUpKind[] = ['hand_off', 'handed_back', 'edited'];
  const firstLines = new Set<string>();
  for (const kind of FOLLOW_UP_KINDS) {
    const first = briefOf(kind)[0];
    if (feedbackKinds.includes(kind)) {
      assert.match(first, FEEDBACK, kind);
      continue;
    }
    assert.doesNotMatch(first, FEEDBACK, kind);
    assert.ok(!firstLines.has(first), `${kind} shares its brief with another kind`);
    firstLines.add(first);
  }
  assert.match(briefOf('goal', { t: task })[0], FEEDBACK);
  assert.match(briefOf('task_done', { g: goal })[0], FEEDBACK);
});

test("a finished task's brief names each work that picked up on its own, and is the same as before when none did", () => {
  const alone = followUpBrief({ ...followUp('task_done'), pickedUp: null }, ask, task);
  const told = followUpBrief(
    { ...followUp('task_done'), pickedUp: ['Print\nrun', 'Frame it'] },
    ask,
    task
  );
  const lines = [
    '- "Print run" was waiting on this too and has picked up on its own; leave that work to it.',
    '- "Frame it" was waiting on this too and has picked up on its own; leave that work to it.'
  ];
  assert.deepEqual(
    told.filter((l) => !lines.includes(l)),
    alone,
    'the lines are the only change'
  );
  const note = told.indexOf('- Their note: Their words');
  assert.deepEqual(
    lines.map((l) => told.indexOf(l)),
    [note + 1, note + 2],
    'each line sits with what the owner gave, before the steps'
  );
  assert.ok(!alone.some((l) => l.includes('picked up on its own')));
});

test("a carry-out started by a connect task's end names each work that picked up on its own, after the ask, and is the same as before when none did", () => {
  const asked: AskRow[] = [
    { ...ask, kind: 'access', access: { connector: 'gmail', level: 'read' } } as AskRow,
    {
      ...ask,
      kind: 'folder',
      folder: { path: '/tmp/taxes', level: 'read', given: { path: '/tmp/taxes', level: 'read' } }
    } as AskRow,
    { ...ask, kind: 'switch', switches: ['web'] } as AskRow,
    ask
  ];
  const line =
    '- "Inbox sort" was waiting on this too and has picked up on its own; leave that work to it.';
  for (const a of asked) {
    const alone = followUpBrief({ ...followUp('carry_out'), pickedUp: null }, a);
    const told = followUpBrief({ ...followUp('carry_out'), pickedUp: ['Inbox\nsort'] }, a);
    assert.deepEqual(
      told.filter((l) => l !== line),
      alone,
      `${a.kind}: the line is the only change`
    );
    const at = told.indexOf(line);
    assert.ok(
      at > told.indexOf(`- What you said would happen: ${a.ifApproved}`) &&
        at < told.findIndex((l) => l.startsWith('1. ')),
      `${a.kind}: the line sits with the ask, before the steps`
    );
  }
});

// Each kind keeps its words in the diff, including the fallback kinds. The run
// tests separately check that the office passes these words to its AI tool.
for (const kind of FOLLOW_UP_KINDS) {
  test(`${kind} keeps the words its run receives`, (t) => {
    t.assert.snapshot(briefOf(kind));
  });
}
