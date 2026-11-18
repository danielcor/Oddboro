// That "How the office works" (house), "Who's in the office" and every
// follow-up's brief name only office tools the run reading them is offered
// (`isOffered`, as the tool server registers them), for an Odd holding no
// office tool the owner gives and for one holding each alone, in every kind
// of run. The tool server's own descriptions are held by the ledger's
// named-tools.test.ts. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FOLLOW_UP_KINDS,
  type AskKind,
  type AskRow,
  type FollowUpRow,
  type GoalRow,
  type TaskRow
} from '@oddboro/ledger';
import { GRANTABLE_TOOLS, isOffered, OFFICE_TOOLS, type ToolRun } from '@oddboro/ledger/tools';
import { followUpBrief } from './follow-up-brief.ts';
import { house, whoIsHereSection } from './house.ts';

/**
 * Office tools a text names though the Odd reading it may not hold them, by
 * the text. Each is owed to NEW-1716: fixing one changes what an Odd reads,
 * so it is that row's work. No brief is left out for running only when its
 * Odd holds a tool: no follow-up checks the Odd's tools before it starts.
 */
const NAMES_UNHELD: Record<string, readonly string[]> = {
  house: ['hand_off', 'propose_reply', 'propose_filter'], // NEW-1716
  'resume brief': [
    'give_owner_a_task',
    'hand_off',
    'poke_owner',
    'list_goals',
    'propose_goal_plan'
  ], // NEW-1716
  'first_day brief': ['ask_for_access'], // NEW-1716
  'goal brief': [
    'give_owner_a_task',
    'find_connectors',
    'ask_for_access',
    'office_report',
    'list_goals',
    'propose_goal_plan'
  ], // NEW-1716
  'task_done brief': ['give_owner_a_task', 'propose_hire', 'propose_goal_plan'], // NEW-1716
  'carry_out brief': ['give_owner_a_task'], // NEW-1716
  'rework brief': [
    'ask_for_access',
    'propose_hire',
    'propose_goal',
    'propose_goal_plan',
    'propose_reply',
    'propose_filter'
  ], // NEW-1716
  // These three share the feedback brief (`followUpBrief`).
  'hand_off brief': ['give_owner_a_task'], // NEW-1716
  'handed_back brief': ['give_owner_a_task'], // NEW-1716
  'edited brief': ['give_owner_a_task'] // NEW-1716
};

// Only the fields a brief reads are filled in; the rest of each row stays out.
const asked = { id: 7, title: 'Send it', why: 'Because', ifApproved: 'It goes' };
/**
 * Every ask a brief words apart, by kind: its answer, whether it got access
 * or plans a hire, what it carries, and what the owner gave or the office
 * called. A kind with no rows is worded as an approval is. A new kind fails
 * the type check here until it says which.
 */
const ASK_ROWS: Record<AskKind, object[]> = {
  approval: [{ ...asked, kind: 'approval', status: 'approved' }],
  access: [{ ...asked, kind: 'access', status: 'approved', access: {} }],
  hire: [{ ...asked, kind: 'hire', status: 'approved' }],
  plan: [
    { ...asked, kind: 'plan', status: 'approved', plan: { items: [{ kind: 'hire' }] } },
    { ...asked, kind: 'plan', status: 'denied', plan: { items: [] } }
  ],
  folder: [
    {
      ...asked,
      kind: 'folder',
      status: 'approved',
      folder: { path: '/work/taxes', level: 'write', given: { path: '/work/taxes', level: 'read' } }
    }
  ],
  switch: [{ ...asked, kind: 'switch', status: 'approved', switches: ['commands', 'web'] }],
  level: [{ ...asked, kind: 'level', status: 'approved', level: 'act' }],
  office_tool: [
    {
      ...asked,
      kind: 'office_tool',
      status: 'approved',
      officeTools: ['office_report', 'list_goals']
    }
  ],
  call: [
    {
      ...asked,
      kind: 'call',
      status: 'approved',
      call: { connector: 'mail', tool: 'send_message', arguments: { to: 'a' } }
    }
  ],
  reply: [
    {
      ...asked,
      kind: 'reply',
      status: 'approved',
      reply: { to: ['ada@example.com'], cc: [], subject: 'Lunch', body: 'Yes', summary: 'A lunch' }
    }
  ],
  filter: [
    {
      ...asked,
      kind: 'filter',
      status: 'approved',
      filter: {
        criteria: { from: 'news@example.com' },
        action: { skipInbox: true },
        summary: 'News'
      }
    }
  ],
  goal: [],
  hand_offs: [],
  window: [],
  remove: [],
  bring_back: [],
  catch_up: [],
  standing: []
};
const ASKS = Object.values(ASK_ROWS).flat() as unknown as AskRow[];
const task = {
  row: { id: 4, title: 'Sign in', why: 'Needed', steps: [] } as unknown as TaskRow,
  files: []
};
const goal = { id: 2, title: 'More clients', area: 'work', horizon: 'ongoing' } as GoalRow;

/**
 * Every text an Odd may read here, by name: house(), which every run reads,
 * "Who's in the office", which a run whose Odd holds `see_office` reads,
 * and each kind's brief in every wording it has, which only a follow-up reads,
 * and a follow-up is never a chat.
 */
const texts = (has: (tool: string) => boolean, run: ToolRun): Record<string, string> => ({
  house: house({ has, now: '9:00', zone: 'London time' }),
  // Offered here exactly when the Odd holds hand_off, so this checks only that an
  // Odd without it is never told to call it. That a run whose Odd holds it but is
  // not offered it (`handsOff`) is not told either is staff-run.test.ts's.
  "who's here": whoIsHereSection(
    [
      {
        id: 'nate',
        name: 'Nate',
        role: 'Researcher',
        remit: 'Researches a question.',
        persona: true
      }
    ],
    has('hand_off')
  ),
  ...(!run.chat &&
    Object.fromEntries(
      FOLLOW_UP_KINDS.map((kind) => [
        `${kind} brief`,
        [
          ...ASKS.flatMap((a) =>
            followUpBrief({ kind, note: 'Their words' } as FollowUpRow, a, task, goal)
          ),
          ...followUpBrief({ kind, note: null } as FollowUpRow)
        ].join('\n')
      ])
    ))
});

/** The office tools each Odd was given, beyond the ones every Odd has. */
const ODDS: string[][] = [[], ...GRANTABLE_TOOLS.map((t) => [t])];
/** Every kind of run, by what decides the tools it is offered beyond what its Odd holds. */
const RUNS: ToolRun[] = [false, true].flatMap((chat) =>
  [false, true].flatMap((manager) => [false, true].map((gmail) => ({ chat, manager, gmail })))
);

test('house() and every brief name only office tools the run reading them is offered, except the declared ones', () => {
  const seen: Record<string, Set<string>> = {};
  const undeclared: Record<string, string[]> = {};
  for (const holds of ODDS)
    for (const run of RUNS) {
      const has = (tool: string) => isOffered(holds, tool, run);
      for (const [name, text] of Object.entries(texts(has, run))) {
        const unheld = OFFICE_TOOLS.map((t) => t.id).filter(
          (id) => !has(id) && new RegExp(`\\b${id}\\b`).test(text)
        );
        for (const n of unheld) (seen[name] ??= new Set()).add(n);
        const left = unheld.filter((n) => !NAMES_UNHELD[name]?.includes(n));
        if (left.length)
          undeclared[`${name} (holding ${holds.join(', ') || 'none'}, ${JSON.stringify(run)})`] =
            left;
      }
    }
  assert.deepEqual(undeclared, {});
  for (const [name, names] of Object.entries(NAMES_UNHELD))
    for (const n of names) assert.ok(seen[name]?.has(n), `${name} no longer names ${n}`);
});
