// The words for access, in one place: the owner's permission levels, and how
// the owner and an Odd read a level, a grant and a folder, and the names of
// the tab where the owner sets an Odd's access, of its sections that hold the
// level and the switches, and of the switches. The page imports this, so it
// imports nothing.

/**
 * What the owner agrees to when they turn on Advanced mode in Setup. The
 * ledger keeps these words with their yes (`setAdvancedMode`).
 */
export const ADVANCED_CONSENT =
  'Advanced mode lets the office open Claude Code and Codex in your own projects. Work sent there runs with your permissions on this computer, outside Oddboro’s limits, and can change files, run commands or reach the internet as your coding tool allows.';

/** The owner's permission levels, lowest first. */
export const LEVELS = ['read', 'draft', 'act'] as const;
export type Level = (typeof LEVELS)[number];
export const levelAtMost = (a: Level, b: Level): boolean => LEVELS.indexOf(a) <= LEVELS.indexOf(b);
/** `v` when it names a level, for a request body or a tool input. */
export const parseLevel = (v: unknown): Level | undefined => LEVELS.find((l) => l === v);
/** What the owner reads for each level. */
export const LEVEL_LABEL: Record<Level, string> = {
  read: 'Reads and reports',
  draft: 'Drafts for your yes',
  act: 'Acts on its own'
};
/**
 * Each level's name. The Odd reads it, and so does the owner where an ask
 * names a level: a level ask's title, card and button.
 */
export const LEVEL_NAME: Record<Level, string> = { read: 'Read', draft: 'Draft', act: 'Act' };
/** What the owner reads a level lets the Odd `name` do, on a level ask's card. */
export const AT_LEVEL: Record<Level, (name: string) => string> = {
  read: (name) => `At Read, ${name} reads and reports.`,
  draft: (name) =>
    `At Draft, ${name} prepares changes outside the office, and each one waits for your yes.`,
  act: (name) =>
    `At Act, ${name} uses the tools you connected for ${name} at read and write without asking you first, in chats with you, in ${name}'s jobs and in work you approve. Right after you approve, you choose whether work another Odd hands ${name} runs at Draft, where each change waits for your yes, or at Act. A thread ${name} picks back up still runs at Draft.`
};
/**
 * The owner's choice for work another Odd hands the Odd `name`, made each
 * time they put it at Act and changed on its Settings tab while it is there
 * (`staff.actsOnHandOffs`): the choice's title, each option's label and line,
 * and the ledger line a change writes.
 */
export const HAND_OFF_CHOICE = {
  title: (name: string) => `When another Odd hands ${name} work`,
  ask: {
    label: 'Ask me first',
    line: (name: string) => `${name} works at Draft on it, and each change waits for your yes.`
  },
  acts: {
    label: (name: string) => `${name} acts on its own`,
    line: (name: string) =>
      `${name} works at Act on it, without asking you. Another Odd's words can come from something it read, so they would reach your tools without your yes.`
  },
  ledger: (name: string, acts: boolean) =>
    acts
      ? `Let ${name} act on its own on work from colleagues`
      : `Set ${name} to ask first on work from colleagues`
} as const;
/** A grant to an outside tool is read or act. */
export type GrantLevel = Extract<Level, 'read' | 'act'>;
/** What the owner reads for a grant level; the Odd reads the same words in lower case. */
export const GRANT_LABEL: Record<GrantLevel, string> = { read: 'Read only', act: 'Read and write' };
/**
 * The lowest level a grant works at. A level says how much an Odd does on
 * its own, not what it may reach: write works from Draft, where each change
 * waits for the owner's yes, and at Act it goes without asking.
 */
export const GRANT_NEEDS: Record<GrantLevel, Level> = { read: 'read', act: 'draft' };
/** Whether a grant works at `level`. */
export const grantWorks = (grant: Level, level: Level): boolean =>
  grant === 'read' || levelAtMost(GRANT_NEEDS.act, level);
/** Whether each change through a grant waits for the owner's yes: write, held at Draft. */
export const writesWait = (grant: Level, level: Level): boolean =>
  grant === 'act' && level === 'draft';
/** A folder the owner gives is read, or read and changed (`write`). */
export type FolderAccess = 'read' | 'write';
/** What the owner reads for a folder level. */
export const FOLDER_LABEL: Record<FolderAccess, string> = {
  read: 'Can read',
  write: 'Can read and change'
};
/** What the Odd reads for a folder level. */
export const FOLDER_SAID: Record<FolderAccess, string> = {
  read: 'read only',
  write: 'read and change'
};

/**
 * The name of the Odd card's tab that holds its switches, folders and tools.
 * The card shows it and the Odds are told it, so a rename reaches both.
 */
export const SETTINGS_TAB = 'Settings';
/** That tab in a sentence, by whose card it is on: "your", "Rowan's", "this Odd's". */
export const settingsTab = (whose: string): string => `${whose} ${SETTINGS_TAB} tab`;
/** The Settings tab's section that holds the Odd's tool, its sign-in, its model and its level. */
export const MODEL_SECTION = 'Model';
/** The Settings tab's section that holds the Run commands and Browse the web switches and the office tools. */
export const OFFICE_SECTION = 'Office';
/** A section of that tab in a sentence, by whose card it is on. */
const under = (section: string, whose: string): string => `${settingsTab(whose)}, under ${section}`;
/** Where the level is: "your Settings tab, under Model". */
export const modelSection = (whose: string): string => under(MODEL_SECTION, whose);
/** Where the switches are: "your Settings tab, under Office". */
export const officeSection = (whose: string): string => under(OFFICE_SECTION, whose);
/** Where the owner sets an Odd's level, as one sentence an Odd reads. */
export const levelRoute = (owner: string, whose: string): string =>
  `${owner} sets ${whose} level on ${modelSection(whose)}.`;
/**
 * The owner's two switches for an Odd's own tools, by the staff column each
 * sets. The Settings tab shows these names and the Odds are told them.
 */
export const SWITCH_NAMES: Record<'commands' | 'web', string> = {
  commands: 'Run commands',
  web: 'Browse the web'
};
/** One of the owner's two switches for an Odd's own tools. */
export type OwnSwitch = keyof typeof SWITCH_NAMES;
/** Both switches, in the order the Settings tab lists them. */
export const OWN_SWITCHES: readonly OwnSwitch[] = ['commands', 'web'];
/** Switches by name, joined: "Run commands and Browse the web". */
export const switchesSaid = (s: readonly OwnSwitch[]): string =>
  OWN_SWITCHES.filter((x) => s.includes(x))
    .map((x) => SWITCH_NAMES[x])
    .join(' and ');
/**
 * Said by both tools that get an outside tool (find_connectors and
 * ask_for_access): an Odd without the web went looking for a web search
 * server when the owner's Browse the web switch was the way.
 */
export const NOT_OWN_TOOLS =
  'Not for web search, reading pages or a shell: those are your own tools, and my_access says how to get them.';

/** The office offers one read-only LegalZoom mailbox. */
export const POSTAL_ID = 'legalzoom-virtual-mail';
export const POSTAL_NAME = 'Physical mail (LegalZoom)';
export const POSTAL_URL = 'https://api.earthclassmail.com/v2/mcp/readonly';
