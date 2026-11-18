// The office's own tools, in plain words. Every staffer has the ones marked
// `always`: they are how it asks the owner for things and sees what it holds.
// The owner grants the rest one staffer at a time, from the Settings tab. Safe to
// import in the browser.
import type { AskKind, Step } from './schema.ts';
import { OWNER_ANSWERS } from './desk-answers.ts';

export type OfficeTool = {
  id: string;
  name: string;
  /** What it lets a staffer do, for the owner. */
  does: string;
  always?: boolean;
  /** Offered only while the Odd holds Gmail (`mailboxes` in mcp-run.ts), even by `always`. */
  withGmail?: boolean;
  /** Offered only when the owner shared a native conversation with this Odd. */
  withProject?: boolean;
  /** Offered only while the Odd holds a service at Read and write, even by `always`. */
  withWrite?: boolean;
  /** Offered only while the owner attached a skill to the Odd, even by `always`. */
  withSkills?: boolean;
  /**
   * Offered only in a chat, where the office sets the owner's words
   * (`OWNER_SAID` in mcp-run.ts), even by `always`: the tool acts on what the
   * owner just said, and a job or a follow-up has no such words.
   */
  inChat?: boolean;
  /** Never offered to the Office Manager, even by `always`: the manager never leaves. */
  notToManager?: boolean;
  /** It shapes the run's prompt (`see_office`) and is no tool the Odd calls, so never offered. */
  prompt?: boolean;
};

const TOOLS = [
  {
    id: 'my_project_sessions',
    name: 'Shared projects',
    does: 'Reads assignments and answers in the native conversations you shared with it.',
    always: true,
    withProject: true
  },
  {
    id: 'send_project_work',
    name: 'Work in shared projects',
    does: 'Proposes an assignment to a shared native conversation. It waits for your yes, unless you let this Odd send to that session without asking.',
    always: true,
    withProject: true
  },
  { id: 'raise_ask', name: 'Ask you', does: 'Puts an ask on your desk.', always: true },
  { id: 'my_asks', name: 'Its asks', does: 'Sees how you decided its asks.', always: true },
  {
    id: 'my_tasks',
    name: 'Its tasks',
    does: 'Sees how you finished the tasks it gave you, and what you answered.',
    always: true
  },
  { id: 'my_access', name: 'Its access', does: 'Sees the tools you gave it.', always: true },
  {
    id: 'reconnect_access',
    name: 'Reconnect its tools',
    does: 'Gives you the steps to connect a tool again, one you already gave it, when its key or sign-in stops working.',
    always: true
  },
  {
    id: 'ask_for_folder',
    name: 'Ask for folders',
    does: 'Asks you for a folder on this computer, to read or to change. You give it with one click, or a narrower one.',
    always: true
  },
  {
    id: 'ask_for_switch',
    name: 'Ask for switches',
    does: 'Asks you to turn on Run commands or Browse the web for it. You turn it on with one click.',
    always: true
  },
  {
    id: 'ask_for_level',
    name: 'Ask for a higher level',
    does: 'Asks you to raise its level. You raise it with one click.',
    always: true
  },
  {
    id: 'ask_for_office_tool',
    name: 'Ask for office tools',
    does: 'Asks you to turn on office tools it needs. You turn them on with one click.',
    always: true
  },
  {
    id: 'ask_for_standing_yes',
    name: 'Ask to stop asking',
    does: 'Asks you to let it use a tool without asking each time, such as one that only stages a change. You say yes or no once.',
    always: true,
    withWrite: true
  },
  { id: 'my_jobs', name: 'Its jobs', does: 'Sees its own jobs and schedules.', always: true },
  {
    id: 'read_skill',
    name: 'Read its skills',
    does: 'Reads the full instructions of a skill you attached to it, before it follows one. A skill gives it no tools, folders or permissions.',
    always: true,
    withSkills: true
  },
  {
    id: 'leave_office',
    name: 'Ask to leave',
    does: 'Asks you to let it go from the office, when you tell it to leave. It goes only on your yes.',
    always: true,
    inChat: true,
    notToManager: true
  },
  {
    id: 'withdraw',
    name: 'Take things off your desk',
    does: 'Takes its own open asks and tasks off your desk, when you tell it to in chat.',
    always: true,
    inChat: true
  },
  {
    id: 'keep_lesson',
    name: 'Keep lessons',
    does: 'Remembers a correction you give it, so you never give it twice. You see each one in its chat, with Undo.',
    always: true
  },
  {
    id: 'used_lesson',
    name: 'Use lessons',
    does: 'Tells the office when a lesson changed its work, so you see which ones it uses.',
    always: true
  },
  {
    id: 'my_goals',
    name: 'Its goals',
    does: 'Sees the goals it serves, and how they are going. Never the others.',
    always: true
  },
  {
    id: 'log_progress',
    name: 'Log progress',
    does: 'Says how a goal it serves or leads is going, with one line of evidence.',
    always: true
  },
  {
    id: 'tell_lead',
    name: 'Tell the lead',
    does: 'Passes what you tell it in chat about work another Odd leads to that Odd: your words, and what it understood you to mean.',
    always: true,
    inChat: true
  },
  {
    id: 'draft_bug_report',
    name: 'Draft bug reports',
    does: 'Drafts an Oddboro bug report when you ask in chat. A File this bug report button under its reply opens the draft for you to review. Nothing is filed until you choose.',
    always: true,
    inChat: true
  },
  {
    id: 'search_ledger',
    name: 'Search the ledger',
    does: 'Reads every decision you made and all work done, by anyone.'
  },
  {
    id: 'give_owner_a_task',
    name: 'Give you tasks',
    does: 'Puts numbered steps on your desk for things only you can do.'
  },
  {
    id: 'find_connectors',
    name: 'Find tools',
    does: 'Searches the office catalog and the public MCP Registry.'
  },
  {
    id: 'ask_for_access',
    name: 'Ask for tools',
    does: 'Asks you to connect an outside tool for it.'
  },
  {
    id: 'edit_my_job',
    name: 'Edit its jobs',
    does: 'Changes its own jobs, when you ask in chat or approve an ask.'
  },
  {
    id: 'edit_my_description',
    name: 'Edit its job description',
    does: 'Rewrites its own job description, when you ask in chat or approve an ask.'
  },
  {
    id: 'hand_off',
    name: 'Hand off work',
    does: 'Gives a colleague a piece of work. The colleague starts at once, and the result comes back to it to pick each next step, or a time to pick the work back up. It says up front how many steps it expects. Needing more than it expected, or expecting a lot, asks you first.'
  },
  {
    id: 'oddboro_update',
    name: 'Oddboro updates',
    does: 'Reads this app’s update status and can check for a new version. Shows update controls in chat; only you can choose Install now.',
    always: true,
    inChat: true
  },
  {
    id: 'poke_owner',
    name: 'Poke you',
    does: 'Sends you a chat message later, once: a check-in or a nudge.'
  },
  {
    id: 'propose_reply',
    name: 'Propose replies',
    does: 'Brings you one email reply at a time to edit, then send or save to Gmail drafts. Only with Gmail, and nothing goes until you click.',
    // Every Odd's, offered only while it holds Gmail: a hire proposal's list
    // of tools once left it out, and its replies went into a file instead.
    always: true,
    withGmail: true
  },
  {
    id: 'propose_filter',
    name: 'Propose filters',
    does: 'Brings you one Gmail filter at a time to change, then create. Only with Gmail, and nothing changes until you click.',
    // Every Odd's, offered only while it holds Gmail, as propose_reply is.
    always: true,
    withGmail: true
  },
  {
    id: 'propose_hire',
    name: 'Propose hires',
    does: 'Brings you a hire, ready to open in the hire window.'
  },
  {
    id: 'see_office',
    name: "Sees who's in the office",
    does: 'Sees every Odd here by name and role, so it can hand work to the right one, or ask you which one you mean.',
    prompt: true
  },
  {
    id: 'office_report',
    name: 'Office report',
    does: 'Sees what every Odd did: jobs, runs, asks and tasks.'
  },
  {
    id: 'list_goals',
    name: 'All goals',
    does: 'Sees every goal, who serves it and how it is going.'
  },
  {
    id: 'propose_goal',
    name: 'Propose goals',
    does: 'Offers a goal it heard from you, for your yes. Never sets one alone.'
  },
  {
    id: 'propose_goal_plan',
    name: 'Plan goals',
    does: 'Brings you one plan per goal: who to hire and what Odds already here take on.'
  },
  {
    id: 'remove_odd',
    name: 'Remove Odds',
    does: 'Asks you to let another Odd go from the office. It goes only on your yes.',
    inChat: true
  },
  {
    id: 'bring_back_odd',
    name: 'Bring Odds back',
    does: 'Asks you to bring back an Odd that left the office, as it was. It comes back only on your yes.',
    inChat: true
  },
  {
    id: 'update_goal',
    name: 'Update goals',
    does: 'Marks a goal met or paused, or rewords it, when you ask in chat or approve an ask.'
  }
] as const satisfies readonly OfficeTool[];
export type OfficeToolId = (typeof TOOLS)[number]['id'];
/** Every office tool, each with its id from the list above, so a typo in an id fails the type check. */
export const OFFICE_TOOLS: readonly (OfficeTool & { id: OfficeToolId })[] = TOOLS;

/**
 * Tools the tool server registers beside a listed one, held with it: an Odd
 * that may poke the owner sees and cancels its pokes, and one that hands off
 * may park its thread until a time.
 */
export const RIDES_WITH = {
  my_pokes: 'poke_owner',
  cancel_poke: 'poke_owner',
  resume_at: 'hand_off'
} as const satisfies Record<string, OfficeToolId>;

/**
 * Tools every new hire starts with, whatever tools its hire names, which the
 * owner may then take off. Migration 0017 gave `see_office` to every Odd
 * already hired.
 */
export const ON_BY_DEFAULT: OfficeToolId[] = ['see_office'];

/** What a new hire starts with. The owner adds or removes from there. */
export const STARTER_TOOLS: OfficeToolId[] = [
  ...ON_BY_DEFAULT,
  'search_ledger',
  'give_owner_a_task',
  'find_connectors',
  'ask_for_access',
  'edit_my_job',
  'edit_my_description',
  'hand_off',
  'poke_owner'
];

/** The office tools the owner gives an Odd, beyond the ones every Odd has. */
export const GRANTABLE_TOOLS = OFFICE_TOOLS.filter((t) => !t.always).map((t) => t.id);
const GRANTABLE = new Set<string>(GRANTABLE_TOOLS);
export const isGrantable = (id: string): id is OfficeToolId => GRANTABLE.has(id);

/** Office tools by name, in the order of `OFFICE_TOOLS`, joined: "Office report, All goals and Propose hires". */
export const officeToolsSaid = (ids: readonly string[]): string => {
  const names = OFFICE_TOOLS.filter((t) => ids.includes(t.id)).map((t) => t.name);
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : (names[0] ?? '');
};

/** Whether a staffer holding `granted` may use the office tool `id`. */
export const hasTool = (granted: readonly string[], id: string) =>
  OFFICE_TOOLS.some((t) => t.id === id && (t.always || granted.includes(id)));

/**
 * A step the office does something for: a sign-in, a secret, a tool list or
 * a choice, and the sign-in's step that ticks itself when it lands (it shares
 * the sign-in's `oauth:` key). The task cannot be done without these. Every
 * other step is a checklist the owner may tick or not.
 */
export const mustDo = (s: Step): boolean => !!s.action || !!s.key?.startsWith('oauth:');

/** How many steps still hold up Mark done. */
export const stepsToGo = (steps: Step[]): number =>
  steps.filter((s) => mustDo(s) && !s.done).length;
/** What about a run decides which office tools it is offered, beyond what its Odd holds. */
export type ToolRun = {
  /** The Odd holds Gmail, at any level. */
  gmail: boolean;
  /** A shared native conversation, outside a lesson-only run. */
  project?: boolean;
  /** The Odd holds a service at Read and write. */
  write?: boolean;
  /** The owner attached at least one skill to the Odd. */
  skills?: boolean;
  /** A chat, where the office sets the owner's words (`OWNER_SAID`). */
  chat: boolean;
  /** The Odd is the Office Manager. */
  manager: boolean;
};

/**
 * Whether `run` is offered the office tool `id`: its Odd, holding `granted`,
 * has it (`hasTool`), it is a tool the Odd calls (not `prompt`), and each
 * condition the tool's row sets holds (`withGmail`, `withProject`, `withWrite`,
 * `withSkills`, `inChat`, `notToManager`).
 * The tool server registers by it.
 */
export const isOffered = (granted: readonly string[], id: string, run: ToolRun): boolean => {
  const row = OFFICE_TOOLS.find((t) => t.id === id);
  return (
    hasTool(granted, id) &&
    !row?.prompt &&
    (!row?.withGmail || run.gmail) &&
    (!row?.withProject || run.project === true) &&
    (!row?.withWrite || run.write === true) &&
    (!row?.withSkills || run.skills === true) &&
    (!row?.inChat || run.chat) &&
    (!row?.notToManager || !run.manager)
  );
};

/** A task step the owner ticks by hand: one with no control, or a sign-in. */
export const tickable = (s: Step) => !s.action || s.action.kind === 'oauth';

/**
 * Asks the owner answers yes or no, with no Iterate: the office raised it
 * itself, so nobody could rework one sent back, or it lets an Odd go, brings
 * one back or lets one use named tools without asking, which has nothing to
 * rework.
 */
export const yesOrNo = (kind: AskKind | undefined): boolean =>
  kind !== undefined && OWNER_ANSWERS.ask[kind].iterate === 'refused';
