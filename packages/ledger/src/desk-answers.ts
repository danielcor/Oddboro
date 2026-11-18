// What reaches the Odd when the owner answers something on the desk: an ask,
// a task or a report, and a goal's change of status. One row per kind and
// answer, so a new kind fails the type check here until it says what its
// answer does. Imports types only, so the page reads it too.
import type { AskKind, AskStatus, GoalStatus, Step, TaskStatus } from './schema.ts';

export const DESK_ITEMS = ['ask', 'task', 'report'] as const;
export type DeskItem = (typeof DESK_ITEMS)[number];

/** The answer a step holds, when it is an answer the owner chose: a secret goes to the keychain, and `tickStep` accepts an answer on any step. */
export const stepAnswer = (s: Step): string | undefined =>
  s.answer && s.action?.kind === 'choice' ? s.answer : undefined;

/** Text on one line, so what a brief or note carries cannot split a section (`sectionsOf`) or a note (`answers()`). */
export const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** What the owner chose on a task's steps. */
export function ownerAnswers(steps: Step[]): { step: string; answer: string }[] {
  return steps.flatMap((s) => {
    const answer = stepAnswer(s);
    return answer ? [{ step: s.text, answer }] : [];
  });
}

/** What the owner said on a task, on one line: each `<step>: <answer>`, then their note, joined by spaces. Empty when they said nothing. */
export function taskSaid(t: { steps: Step[]; note: string | null }): string {
  return flat(
    [...ownerAnswers(t.steps).map((a) => `${a.step}: ${a.answer}`), t.note ?? ''].join(' ')
  );
}

/**
 * What each run a task's end starts on the task's own work is told of other
 * work parked on that task. That work picks up in its own run at the same
 * moment (`wakeParked`), so without this line both runs did the parked work.
 * "This", not "this task": a carry-out's brief speaks of the ask, not of the
 * connect task that ended.
 */
export const pickedUpLine = (title: string): string =>
  `"${flat(title)}" was waiting on this too and has picked up on its own; leave that work to it.`;

/** How each end of an ask or task reads to an Odd. */
export const SAID_AS: Record<Exclude<AskStatus, 'open'> | Exclude<TaskStatus, 'open'>, string> = {
  approved: 'approved',
  denied: 'turned down',
  revise: 'sent back',
  done: 'finished',
  dropped: 'dropped'
};

/** The reason `raiseAsk` closes an ask with when the Odd raises a new version of it: the office's words, never the owner's. */
export const ASK_REPLACED = 'Replaced by a new version.';

/** Whether the Odd replaced this ask with a new version, so the owner never answered it. */
export const askReplaced = (a: { status: AskStatus; reason: string | null }): boolean =>
  a.status === 'revise' && a.reason === ASK_REPLACED;

/**
 * What reaches the Odd when the owner answers. A `none` names the Linear row
 * that would add it.
 *
 * - `approval_work`: what approving means, written in the transaction that
 *   approves the ask by the function that approves that kind (`approveGoal`,
 *   `approvePlan`). A goal's yes then puts the manager's planning run on the
 *   goal's new work (`planGoal`).
 * - `carry_out`: a `carry_out` follow-up, to do what the ask or task waited on.
 * - `grant_access`: the access the ask names is granted (`grantAccess`). A tool
 *   already connected starts the work that waited on it (`carry_out`) at once;
 *   otherwise the owner gets a task to connect it, and finishing that starts it.
 * - `give_folder`: the folder the owner gave went to the Odd with the yes
 *   (`giveFolder`), and the work that waited on it starts, once for each place
 *   a result goes back to.
 * - `turn_on`: the switches the ask names turned on with the yes
 *   (`changeOwnTools`), and the work that waited on them starts, once for each
 *   place a result goes back to.
 * - `grant_setting`: the level or office tools the ask names change with the
 *   yes, as the Settings tab changes them (`changeLevel`, `changeTools`), and
 *   the work that waited on them starts, once for each place a result goes
 *   back to.
 * - `start_held`: the hand-off the ask held starts, as the ask is claimed,
 *   unless the usage window holds it as it would a new one.
 * - `answer_window`: the usage window's answer (`answerWindow`).
 * - `answer_hand_offs`: the yes or no to more hand-offs goes to the thread's hub
 *   (`answerHandOffs`).
 * - `answer_back`: the answer itself goes to the hand-off or thread it was
 *   raised on (`answerBack`). Raised on neither, it wakes the Odd that raised
 *   it, once, as an `answered` run (`offWorkAnswer`); a goal's yes does not,
 *   since its planning run follows it.
 * - `rework`: a `rework` follow-up, with what to change.
 * - `denied_lesson`: a `denied` follow-up, when the no carries a reason.
 * - `task_done`: a `task_done` follow-up, to pick up what waited on the task.
 * - `wake_parked`: the work a lead parked on the task picks up, told how the
 *   task ended (`wakeParked`).
 * - `odd_leaves`: the Odd the ask names leaves the office (`removeOdd` in
 *   leaving.ts), after the answer went back, so leaving closes any run it started.
 * - `odd_returns`: the Odd the ask names comes back as it was (`bringBack`).
 * - `catch_up`: the job the ask names owes a run for its missed periods
 *   (`oweCatchUp`), which the office clock starts.
 * - `give_standing`: the tools the ask names went on the Odd's grant with the
 *   yes (`giveStanding`), so its runs use them without asking.
 */
export type Effect =
  | 'approval_work'
  | 'carry_out'
  | 'grant_access'
  | 'give_folder'
  | 'turn_on'
  | 'grant_setting'
  | 'start_held'
  | 'answer_window'
  | 'answer_hand_offs'
  | 'answer_back'
  | 'rework'
  | 'denied_lesson'
  | 'task_done'
  | 'wake_parked'
  | 'odd_leaves'
  | 'odd_returns'
  | 'catch_up'
  | 'give_standing'
  | { none: string };
export type AskEffect = Exclude<Effect, 'task_done' | 'wake_parked'>;
export type TaskEffect = Extract<Effect, 'carry_out' | 'task_done' | 'answer_back' | 'wake_parked'>;

/**
 * Whether each effect of a task's end starts a run of the task's own: always;
 * on its work, else its Odd, as an answer does: it goes back to the work the
 * task is on, to the lead that handed it when the task came on a hand-off,
 * and on no work to the Odd that gave it, as an `answered` run, unless that
 * Odd took the task off the desk; or never. Each such run and the work
 * parked on the task are told of each other (`ownRunOf`), or both do the
 * parked work.
 */
export const OWN_RUN = {
  carry_out: 'always',
  task_done: 'always',
  answer_back: 'on its work, else its Odd',
  wake_parked: 'never'
} as const satisfies Record<TaskEffect, 'always' | 'on its work, else its Odd' | 'never'>;

export type AskAnswer = {
  /**
   * A hire, a reply, a filter, a folder or a call is approved by doing it
   * (`approveHire`, `reply/`, `filter/`, `folder/`, `call/`), never by a bare yes: `by` is what the
   * office answers a bare yes with. Then `then` runs.
   */
  approve: readonly AskEffect[] | { by: string; then: readonly AskEffect[] };
  deny: readonly AskEffect[];
  /**
   * `refused`: the owner says yes or no and nobody reworks it, since the office
   * raised it, or it lets an Odd go, brings one back or lets one use named
   * tools without asking.
   */
  iterate: readonly AskEffect[] | 'refused';
};
/** A no: the answer goes back, and its reason is a lesson for the Odd that asked. */
const NO: readonly AskEffect[] = ['answer_back', 'denied_lesson'];
const REWORK: readonly AskEffect[] = ['rework'];

export const OWNER_ANSWERS = {
  ask: {
    approval: { approve: ['carry_out'], deny: NO, iterate: REWORK },
    access: { approve: ['grant_access'], deny: NO, iterate: REWORK },
    hire: {
      approve: { by: 'Approve a hire by hiring', then: ['answer_back'] },
      deny: NO,
      iterate: REWORK
    },
    // Setting the goal wakes the Office Manager to plan it, on the goal's thread.
    goal: { approve: ['approval_work', 'answer_back'], deny: NO, iterate: REWORK },
    // A plan is always raised on its goal's thread, so its answer always reaches the lead.
    plan: {
      approve: ['approval_work', 'answer_back'],
      deny: ['answer_back', 'denied_lesson'],
      iterate: REWORK
    },
    hand_offs: {
      approve: ['start_held', 'answer_hand_offs'],
      deny: ['answer_hand_offs', 'denied_lesson'],
      iterate: 'refused'
    },
    // The office raised it, not the Odd named on it, so a no has no lesson.
    window: { approve: ['answer_window'], deny: ['answer_window'], iterate: 'refused' },
    reply: {
      approve: {
        by: 'Send the reply, or save it to Gmail drafts',
        then: ['answer_back']
      },
      deny: NO,
      iterate: REWORK
    },
    filter: {
      approve: {
        by: 'Create the filter from its card on the desk',
        then: ['answer_back']
      },
      deny: NO,
      iterate: REWORK
    },
    folder: {
      approve: { by: 'Give the folder from its card on the desk', then: ['give_folder'] },
      deny: NO,
      iterate: REWORK
    },
    // Plain Approve is the desk's Turn on.
    switch: { approve: ['turn_on'], deny: NO, iterate: REWORK },
    // Plain Approve is the desk's Raise to (level) or Turn on.
    level: { approve: ['grant_setting'], deny: NO, iterate: REWORK },
    office_tool: { approve: ['grant_setting'], deny: NO, iterate: REWORK },
    call: {
      approve: { by: 'Approve the call from its card on the desk', then: ['carry_out'] },
      deny: NO,
      iterate: REWORK
    },
    remove: { approve: ['answer_back', 'odd_leaves'], deny: NO, iterate: 'refused' },
    bring_back: {
      approve: ['answer_back', 'odd_returns'],
      deny: NO,
      iterate: 'refused'
    },
    // The office raised it, not the Odd named on it, and a no needs nothing done:
    // the job had already moved on to its next time.
    catch_up: { approve: ['catch_up'], deny: [], iterate: 'refused' },
    // A yes or a no settles it: a no stands, so the Odd keeps asking for each call.
    // Off a thread the yes still reaches the Odd: its next run's prompt names the tools.
    standing: {
      approve: ['give_standing', 'answer_back'],
      deny: NO,
      iterate: 'refused'
    }
  } satisfies Record<AskKind, AskAnswer>,
  task: {
    done: {
      /** The owner finished connecting a tool an Odd asked for: the work that waited on it starts. */
      fromAccess: ['carry_out', 'wake_parked'],
      other: ['task_done', 'wake_parked'],
      /** A task no Odd gave the owner. */
      noOdd: ['wake_parked']
    },
    dropped: ['answer_back', 'wake_parked']
  } satisfies {
    done: Record<'fromAccess' | 'other' | 'noOdd', readonly TaskEffect[]>;
    dropped: readonly TaskEffect[];
  },
  report: { read: [] }
} satisfies Record<DeskItem, unknown>;

/**
 * What a goal's change of status tells the Odds that serve it. `updateGoal`
 * runs nothing, so each is a `none`: a status that should reach them widens
 * this type and adds its effect there.
 */
export const GOAL_ANSWERS: Record<Exclude<GoalStatus, 'active'>, readonly { none: string }[]> = {
  paused: [{ none: 'NEW-1704' }],
  met: [{ none: 'NEW-1704' }],
  dropped: [{ none: 'NEW-1704' }]
};
