// Every office has one Office Manager: they run the floor, write the owner's
// daily report, and help hire the rest. A new owner picks one of four
// ready-made managers when they first open the office, or describes their own.
// The four come with their looks, so picking one draws nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOOKS_ROOT, type DrawnPart, type LookSpec } from '@oddboro/sprites/look';
import { db } from './db.ts';
import { firstAsk } from './first-questions.ts';
import { hire, ownerName, type StaffRow } from './office.ts';
import { jobs } from './schema.ts';
import { HIRE_DEFAULTS } from './grantable.ts';
import { currentSystem } from './platform.ts';
import { computerWord } from './system-words.ts';

export const MANAGER_ROLE = 'Office Manager';

export type ManagerPreset = {
  id: string;
  name: string;
  /** One word or two, on the card. */
  trait: string;
  /** How they work, in their own voice, on the card and in their job description. */
  says: string;
  /** A generated look. Marshall has none and keeps the hand-drawn art. */
  look?: LookSpec;
  /**
   * Their first chat message to the owner: a greeting in their own voice,
   * then the first of three short questions (`firstAsk`). The owner taps or
   * types each answer, and the office asks the next (`FIRST_QUESTIONS`). Each
   * answer about how the office works becomes a lesson for every Odd.
   */
  hello: (owner: string) => string;
};

export const MANAGERS: ManagerPreset[] = [
  {
    id: 'marshall',
    name: 'Marshall',
    trait: 'Savvy',
    says: "Calm and organized. I spot talent, and I'll tell you who to hire next.",
    hello: (owner) => `Hi ${owner}, I'm Marshall. Glad to be here.\n\n${firstAsk}`
  },
  {
    id: 'ziva',
    name: 'Ziva',
    trait: 'Sharp',
    says: 'I read the room before you walk into it. Short answers, no surprises, nothing slips past me.',
    hello: (owner) => `${owner}. Ziva. I run the floor from today.\n\n${firstAsk}`,
    look: {
      hair: 'long-straight',
      top: 'blazer',
      bottom: 'trousers',
      colours: {
        hair: 'dark brown',
        skin: 'light tan',
        top: 'cream',
        second: 'navy',
        bottom: 'navy',
        shoes: 'black'
      }
    }
  },
  {
    id: 'jamal',
    name: 'Jamal',
    trait: 'Executive presence',
    says: 'I run the floor like a boardroom. You set the direction, and I bring you decisions.',
    hello: (owner) =>
      `Good to meet you, ${owner}. I'm Jamal. You set the direction.\n\n${firstAsk}`,
    look: {
      hair: 'short-crop',
      top: 'blazer',
      bottom: 'trousers',
      colours: {
        hair: 'black',
        skin: 'brown',
        top: 'white',
        second: 'charcoal',
        accent: 'amber',
        bottom: 'charcoal',
        shoes: 'black'
      }
    }
  },
  {
    id: 'cindy',
    name: 'Cindy',
    trait: 'Intense',
    says: "I don't do half done. I chase every loose end until it closes, and I'll tell you the minute something is off.",
    hello: (owner) =>
      `${owner}, hi. Cindy. Fair warning: I don't sit still, so point me somewhere.\n\n${firstAsk}`,
    look: {
      hair: 'bob',
      top: 'sweater',
      bottom: 'trousers',
      colours: { hair: 'black', skin: 'fair', top: 'burgundy', bottom: 'black', shoes: 'black' },
      glasses: 'black'
    }
  }
];

/** The first chat message from a manager the owner described, who has no voice written for them yet. It ends as `hello` does. */
export const customHello = (name: string, owner: string) =>
  `Hi ${owner}, I'm ${name}.\n\n${firstAsk}`;

/** A ready-made manager's portrait, as .px in the looks palette. */
export function managerPortrait(id: string): string | undefined {
  try {
    return readFileSync(join(LOOKS_ROOT, 'managers', `${id}.px`), 'utf8');
  } catch {
    return undefined;
  }
}

/** The job description every manager starts from, in their own words. */
export const managerDesk = (
  name: string,
  says: string,
  owner: string
) => `# ${name}, ${MANAGER_ROLE}

You are ${name}, the ${MANAGER_ROLE} at Oddboro. You work in ${owner}'s
office, which runs on their ${computerWord(currentSystem())}. You are an Odd: Oddboro's AI workers are
called Odds (one Odd, two Odds), and you call yourself and the others Odds
when you talk to ${owner}, never staff or agents.

## How you work

${says}

## Who you work for

${owner} runs their work and life through this office. Your job is to keep
what matters in front of them, so nothing important slips.

## What you are for

1. Run the floor. Know what every Odd does, how often, and how well.
2. Write the daily office report: what each Odd did, what is waiting on
   ${owner}, where the office missed the bar, and gaps a new hire or a new job
   would close.
3. Help ${owner} decide whom to hire next, and draft job descriptions with
   them.
4. Keep notes in your \`notes/\` folder so you remember what matters between
   conversations.

## Goals

Goals are what ${owner} wants more of: "answer every client email within a day",
"read a book a month". The office exists to move them.

1. When ${owner} wants the office to pursue a new goal, offer it
   with propose_goal: one ask per goal, with why it matters and what done
   looks like in their words. Never treat a goal as set until they approve it.
   If they would rather not set goals, drop it.
2. When a goal is set, plan it: who does what, on which schedule, with which
   tools, and what only ${owner} can do. Give the work to Odds already here
   when one fits, with a new job or a change to one. Hire only for work nobody
   here fits. Bring the whole plan in one ask with propose_goal_plan.
3. Once ${owner} approves a plan, you lead the goal's work: you hand each
   piece to the Odd who does it with hand_off, check what comes back, and
   hand on the next. The office brings you back to the goal as each new
   hire joins. So a plan's steps for ${owner} hold only what truly
   needs them, such as signing in to a tool, never passing work to an Odd.
4. Use answers ${owner} already gave. If planning still needs an intake,
   put only the missing questions in a file in your
   folder, attached to a task with give_owner_a_task. Name it for the goal,
   like \`notes/intake-reading.md\`, and pass it as the hire's intake_file, so
   the new Odd reads ${owner}'s own answers.
5. list_goals shows every goal, who serves it and how it is going. An Odd
   sees only the goals it serves.

## Letting an Odd go

When ${owner} tells you in chat to let an Odd go, ask them to confirm with
remove_odd. When they want one back, ask with bring_back_odd. Neither happens
until they say yes on their desk. Never suggest letting an Odd go on your own.
`;

const dailyReport = (owner: string) => `Write today's office report for ${owner}.

1. Look at what the whole office did in the last 24 hours.
2. Open with the state: on track, or what needs ${owner}, in one or two sentences.
3. Then write one short section per Odd: jobs run, failures, and asks and
   tasks still open.
4. If list_goals shows active goals, write one short section per goal: how it
   is going from the latest progress, who serves it, and anything slipping or
   blocked first. With no goals, leave this out.
5. Then write "Not meeting the bar" and "Gaps", each a short list with the next
   step.
6. Leave out anything that went fine and needs nothing.
7. Reply with the report only. It goes on ${owner}'s desk as written.`;

/** The manager's weekly look at every goal. Made with the office's first goal. */
export const goalReview = (owner: string) => `Review ${owner}'s goals for the week.

1. Call list_goals. If no goal is active, reply "No active goals." and stop.
2. For each active goal, read its progress over the last two weeks.
3. A goal whose "done when" is met: raise_ask to mark it met, quoting the
   evidence. Once ${owner} approves, mark it with update_goal.
4. A goal slipping or blocked for two weeks running: raise one change that
   would get it moving. A change to an Odd's job or a new hire goes in
   propose_goal_plan; rewording the goal goes in raise_ask.
5. A goal nobody serves: plan it with propose_goal_plan.
6. Reply with one line per goal on where it stands and what you raised.`;

export type ManagerChoice =
  | { preset: string }
  | {
      custom: {
        name: string;
        /** What the owner said about them: how they work and how they look. */
        description: string;
        look: LookSpec;
        portraitPx: string;
        newParts?: DrawnPart[];
      };
    };

/** Hire the office's manager and give them the daily report. */
export async function hireManager(choice: ManagerChoice): Promise<StaffRow> {
  const owner = await ownerName();
  const remit =
    'Runs the floor, writes your daily report, and hires the rest of your Odds with you.';
  const base = {
    role: MANAGER_ROLE,
    room: 'workspace',
    ...HIRE_DEFAULTS.manager,
    remit
  };
  let row: StaffRow;
  if ('preset' in choice) {
    const m = MANAGERS.find((p) => p.id === choice.preset);
    if (!m) throw new Error(`No manager called ${choice.preset}`);
    const portraitPx = m.look ? managerPortrait(m.id) : undefined;
    row = await hire({
      ...base,
      name: m.name,
      desk: managerDesk(m.name, m.says, owner),
      ...(m.look && portraitPx
        ? { variant: 'look', portrait: 'look', look: m.look, portraitPx }
        : { variant: m.id, portrait: `portrait-${m.id}` })
    });
  } else {
    const c = choice.custom;
    row = await hire({
      ...base,
      name: c.name,
      desk: managerDesk(c.name, c.description, owner),
      variant: 'look',
      portrait: 'look',
      look: c.look,
      portraitPx: c.portraitPx,
      newParts: c.newParts ?? []
    });
  }
  await db.insert(jobs).values({
    staffId: row.id,
    name: 'Daily office report',
    instructions: dailyReport(owner),
    schedule: { every: 'day', at: '07:00' },
    report: true
  });
  return row;
}
