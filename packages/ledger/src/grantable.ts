// What the owner can grant an Odd, in one list: each grant's control on the
// Odd's card, the line an Odd hears when it lacks it, where it hears that
// line, how it gets the grant, and whether a hire starts with it. The staff
// PATCH route's body keys are typed from here, so a new owner control fails
// the type check until it is classed. A hire's starting values live here too.
// The page imports this, so it imports only files the page reads too.
import { levelRoute, SWITCH_NAMES, type Level } from './access-words.ts';
import { AGENT_NAMES, type Agent, type CommandsHow, type GrantedFolder } from './agents.ts';
import { OWNER_ANSWERS, type Effect } from './desk-answers.ts';
import type { AskKind } from './schema.ts';
import { isGrantable, STARTER_TOOLS, type OfficeToolId } from './tools.ts';

/** Every key the staff PATCH route (`/api/staff/[id]`) reads from its body. */
export const STAFF_PATCH_KEYS = [
  'permission',
  'agent',
  'tool',
  'on',
  'commands',
  'web',
  'folder',
  'access',
  'accept',
  'effort',
  'model',
  'account',
  'actsOnHandOffs'
] as const;
export type StaffPatchKey = (typeof STAFF_PATCH_KEYS)[number];

/** What the owner can grant an Odd. */
export const GRANT_KINDS = [
  'commands',
  'web',
  'folders',
  'office_tools',
  'outside_tools',
  'level'
] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/**
 * What each grant's missing line needs to say its words, and nothing more.
 * A new GrantKind fails the type check at `OWNER_GRANTS` until it has a row
 * here. The Run commands and Browse the web lines keep a literal `{owner}`,
 * which `ownToolsSaid`'s caller fills; the others take the owner's name from
 * their caller.
 */
export type Readers = {
  // `where` is the card another Odd reads about: the owner's own control there,
  // since a reader can ask only for itself. With none, the Odd reads its own line.
  commands: { agent: Agent; how: CommandsHow; where?: string };
  web: { where?: string };
  folders: Record<string, never>;
  office_tools: { owner: string; where: string };
  // house() knows no tool and no owner's name, so it never offers a switch.
  outside_tools: { has: (tool: string) => boolean };
  // `whose` is the card another Odd reads about (office_report). With none, the
  // Odd reads its own line, which asks for the level.
  level: { owner: string; whose?: string };
};

/** A function in `capabilities.ts` or the office's `house.ts` that says a grant's missing line. */
export type Hearer = 'ownToolsLine' | 'outsideLines' | 'askAboveLevel' | 'house' | 'accessInRun';

export type OwnerGrant<K extends GrantKind> = {
  /** The owner's control: PATCH keys on `/api/staff/[id]`, or the desk ask that grants it. */
  control: { patch: readonly StaffPatchKey[] } | { ask: AskKind };
  /** What the Odd hears when it lacks this, or none, with the Linear row that owes it. */
  missing: ((r: Readers[K]) => string) | { none: string };
  /** The functions that say `missing` to an Odd. */
  heard: readonly Hearer[];
  /** How the Odd gets it: an ask it can raise, or the owner's own control on its Settings tab. */
  route: { ask: AskKind } | { owner: 'settings' };
  /** What approving the route's ask does (its `OWNER_ANSWERS` cell), when the route is an ask. */
  approving?: readonly Effect[];
  /** Whether a hire starts with it, read from `HIRE_DEFAULTS` where that holds it. */
  atHire: boolean;
};

type Starts = { permission: Level; tools: OfficeToolId[] };
/**
 * What a hire starts with when the owner picks nothing: the schema's column
 * defaults, `hire()`, the Office Manager's hire, a persona's hire
 * (`hirePersona`), the hire drawer and each grant's `atHire` read it, so it
 * comes before `OWNER_GRANTS`.
 * The rest have homes that work them out: the tool is the office's own
 * (`officeAgent()` in office-staff.ts), the account its Office account and the
 * model the office's (both null), and thinking `DEFAULT_EFFORT`, never below
 * `MANAGER_EFFORT_FLOOR` for the manager (agents.ts).
 */
export const HIRE_DEFAULTS: {
  staff: Starts & { commands: boolean; web: boolean; folders: GrantedFolder[] };
  manager: Starts;
  persona: Starts;
} = {
  staff: { permission: 'read', tools: STARTER_TOOLS, commands: false, web: false, folders: [] },
  manager: {
    permission: 'draft',
    tools: [
      ...STARTER_TOOLS,
      'office_report',
      'propose_hire',
      'list_goals',
      'propose_goal',
      'propose_goal_plan',
      'update_goal',
      // 0016_leaving gives these to every manager hired before them.
      'remove_odd',
      'bring_back_odd'
    ]
  },
  // A persona's hands draft for its voice, so they start a level above a staff hire.
  persona: { permission: 'draft', tools: STARTER_TOOLS }
};

/** Every grant the owner can make, and how an Odd learns it lacks one. */
export const OWNER_GRANTS = {
  commands: {
    // A move to another tool (`agent`) can switch it on too.
    control: { patch: ['commands'] },
    // The switch is offered only when it reaches the tool on this system
    // (`commandsHow`), so an Odd is never told of one the owner cannot move.
    missing: ({ agent, how, where }: Readers['commands']) =>
      how.state !== 'switch'
        ? `No shell: ${AGENT_NAMES[agent]} can't run commands here.`
        : where
          ? `No shell: {owner} can switch on ${SWITCH_NAMES.commands} in ${where}.`
          : `No shell: ask {owner} to turn on ${SWITCH_NAMES.commands} with ask_for_switch.`,
    heard: ['ownToolsLine'],
    route: { ask: 'switch' },
    approving: OWNER_ANSWERS.ask.switch.approve,
    atHire: HIRE_DEFAULTS.staff.commands
  },
  web: {
    control: { patch: ['web'] },
    // Browse the web follows the owner on every tool.
    missing: ({ where }: Readers['web']) =>
      where
        ? `No web: {owner} can switch on ${SWITCH_NAMES.web} in ${where}.`
        : `No web: ask {owner} to turn on ${SWITCH_NAMES.web} with ask_for_switch.`,
    heard: ['ownToolsLine'],
    route: { ask: 'switch' },
    approving: OWNER_ANSWERS.ask.switch.approve,
    atHire: HIRE_DEFAULTS.staff.web
  },
  folders: {
    control: { patch: ['folder', 'access', 'accept'] },
    // Said only to an Odd with no folder at all.
    missing: () => 'When a job needs a folder outside the office, ask with ask_for_folder.',
    heard: ['accessInRun'],
    route: { ask: 'folder' },
    approving: OWNER_ANSWERS.ask.folder.approve.then,
    atHire: HIRE_DEFAULTS.staff.folders.length > 0
  },
  office_tools: {
    control: { patch: ['tool', 'on'] },
    // Said while any office tool the owner can give is still not given.
    missing: ({ owner, where }: Readers['office_tools']) =>
      `${owner} grants other office tools in ${where}; when a job needs one, ask for it with ask_for_office_tool.`,
    heard: ['accessInRun'],
    route: { ask: 'office_tool' },
    approving: OWNER_ANSWERS.ask.office_tool.approve,
    atHire: HIRE_DEFAULTS.staff.tools.some(isGrantable)
  },
  outside_tools: {
    control: { ask: 'access' },
    // The leading space joins it to the sentence before it in house().
    missing: ({ has }: Readers['outside_tools']) =>
      !has('ask_for_access')
        ? ''
        : has('find_connectors')
          ? ' For more outside tools, call find_connectors, then ask_for_access.'
          : ' For more outside tools, call ask_for_access.',
    heard: ['house'],
    route: { ask: 'access' },
    approving: OWNER_ANSWERS.ask.access.approve,
    // hire() grants no outside tool: each comes through an access ask.
    atHire: false
  },
  level: {
    control: { patch: ['permission'] },
    missing: ({ owner, whose }: Readers['level']) =>
      whose
        ? levelRoute(owner, whose)
        : `When a job needs a higher level, ask ${owner} for it with ask_for_level.`,
    heard: ['outsideLines', 'askAboveLevel'],
    route: { ask: 'level' },
    approving: OWNER_ANSWERS.ask.level.approve,
    // Every Odd holds a level; a hire's is `HIRE_DEFAULTS.staff.permission`.
    atHire: true
  }
} as const satisfies { [K in GrantKind]: OwnerGrant<K> };

/**
 * Every PATCH key is the control of a grant, a setting of how the Odd runs,
 * or a qualifier another key needs (`on` for `tool`, `access` and `accept` for `folder`).
 */
export const PATCH_KEY: Record<StaffPatchKey, GrantKind | 'run setting' | 'qualifier'> = {
  permission: 'level',
  agent: 'run setting',
  tool: 'office_tools',
  on: 'qualifier',
  commands: 'commands',
  web: 'web',
  folder: 'folders',
  access: 'qualifier',
  accept: 'qualifier',
  effort: 'run setting',
  model: 'run setting',
  account: 'run setting',
  actsOnHandOffs: 'run setting'
};
