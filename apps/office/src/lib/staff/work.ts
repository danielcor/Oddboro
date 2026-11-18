// A staffer's work in progress, as the office tools track it and the page
// shows it: a job, a follow-up (an approved ask, a rework, an answer, a
// pick-up after a task or a colleague, work handed over) or a draft. Safe to
// import in the browser.
import type { FollowUpKind } from '@oddboro/ledger';

export type { Work, WorkAbout } from '@oddboro/ledger/run-registry';

/**
 * What a follow-up does, in a few words, by its kind: the line over its title
 * under In progress, whether it runs or waits to start. `ask` is the ask it
 * answers, `colleague` the name of the Odd that handed the work over or back.
 */
export function followUpDetail(
  kind: FollowUpKind,
  o: { ask?: number; colleague?: string } = {}
): string {
  const words: Record<FollowUpKind, string> = {
    carry_out: `Carrying out ask #${o.ask}`,
    rework: `Reworking ask #${o.ask}`,
    denied: `Reading why you said no to ask #${o.ask}`,
    task_done: 'Picking up after your task',
    goal: 'Planning your goal',
    first_day: 'Getting started',
    hand_off: `Work ${o.colleague} handed over`,
    handed_back: `Picking up after ${o.colleague}`,
    resume: 'Picking the work back up',
    answered: 'Reading your answer',
    edited: 'Learning from your edit'
  };
  return words[kind];
}

/**
 * How long a piece of work has run, in whole minutes: "just started",
 * "4 min", "1 h 5 min". Whole minutes, so nothing needs redrawing every second.
 */
export function runningFor(since: string, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (min < 1) return 'just started';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Claude Code's file tools, which Grok's and Gemini's stand for. */
type FileTool = 'Read' | 'Glob' | 'Grep' | 'Edit' | 'Write';

/**
 * Every tool a run's own tools are named by, in plain words: the one place the
 * owner reads a tool's name from, on the In progress tab and in chat ("Mira
 * is reading files"), so each starts with a verb ending in -ing. Each tool's
 * reader gives the floor Claude Code's names (codex.ts, gemini.ts,
 * `streamTools` in claude.ts for Grok).
 */
const TOOL_WORDS: Record<string, string> = {
  Read: 'Reading files',
  Glob: 'Looking for files',
  Grep: 'Searching files',
  Edit: 'Editing files',
  Write: 'Writing a file',
  /** Codex's shell. */
  Bash: 'Running a command',
  /** Grok finds an MCP tool before it calls one. */
  ToolSearch: 'Looking for a tool',
  /** Browse the web: Claude Code's names, then Gemini's and Grok's, which reach the floor as they are. */
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a web page',
  google_web_search: 'Searching the web',
  web_search: 'Searching the web',
  web_fetch: 'Reading a web page'
};

/**
 * The office's own tools (the ledger's `mcp-*.ts` files, which `mcp.ts` imports), each in words. A test holds
 * this to every tool they register, so a new one cannot show as its name.
 */
export const OFFICE_TOOL_WORDS: Record<string, string> = {
  ask_for_access: 'Asking you for access',
  cancel_poke: 'Calling off a poke',
  draft_bug_report: 'Drafting a bug report',
  edit_my_description: 'Editing its description',
  edit_my_job: 'Editing its job',
  find_connectors: 'Looking for a tool to connect',
  give_owner_a_task: 'Giving you a task',
  hand_off: 'Handing off work',
  keep_lesson: 'Keeping a lesson',
  list_goals: 'Looking at the goals',
  log_progress: 'Logging progress',
  my_access: 'Checking its access',
  my_project_sessions: 'Checking project assignments',
  send_project_work: 'Sending a project assignment',
  my_asks: 'Checking its asks',
  my_tasks: 'Checking its tasks',
  my_goals: 'Checking its goals',
  my_jobs: 'Checking its jobs',
  leave_office: 'Asking you to let it leave',
  withdraw: 'Taking things off your desk',
  my_pokes: 'Checking its pokes',
  oddboro_update: 'Checking Oddboro updates',
  office_report: 'Reading the office report',
  poke_owner: 'Setting a poke for you',
  propose_goal: 'Proposing a goal',
  propose_goal_plan: 'Proposing a plan for a goal',
  propose_hire: 'Proposing a hire',
  remove_odd: 'Asking you to let an Odd go',
  bring_back_odd: 'Asking you to bring an Odd back',
  propose_reply: 'Drafting an email reply for you',
  propose_filter: 'Drafting a Gmail filter for you',
  ask_for_folder: 'Asking you for a folder',
  ask_for_switch: 'Asking you to turn on a switch',
  ask_for_level: 'Asking you for a higher level',
  ask_for_office_tool: 'Asking you for an office tool',
  ask_for_standing_yes: 'Asking to use a tool without your yes each time',
  raise_ask: 'Raising an ask',
  read_skill: 'Reading one of its skills',
  reconnect_access: 'Asking you to reconnect a tool',
  resume_at: 'Setting when to pick up again',
  search_ledger: 'Searching the Ledger',
  tell_lead: 'Telling its lead',
  update_goal: 'Updating a goal',
  used_lesson: 'Noting a lesson it used'
};

/**
 * Verbs an outside tool's name often starts with (list_secret_names,
 * search_thoughts). A name that starts with one reads as doing it; any other
 * reads as using the tool, so no line ever says "is list".
 */
const VERBS = new Set(
  (
    'add analyze append archive ask assign attach browse build calculate call cancel capture ' +
    'change check clear click close comment compare complete compute convert copy count create ' +
    'delete deploy describe download draft edit estimate execute explain export extract fetch ' +
    'fill filter find fix follow generate get grep import inspect install invite invoke join ' +
    'label launch list load lock log look make manage mark merge modify move navigate open parse ' +
    'patch pause pin plan post preview print publish pull push put query queue rank read recall ' +
    'record refresh register reject release reload remember remove rename reply report request ' +
    'reset resolve restart restore resume retrieve review run save scan schedule scrape search ' +
    'select send set share show sign sort start stop store submit subscribe summarize sync tag ' +
    'take test track transcribe translate trigger type undo unlock update upload upsert validate ' +
    'verify view watch write'
  ).split(' ')
);

/** A verb with -ing: list to listing, write to writing, get to getting. */
export function gerund(verb: string): string {
  if (verb.endsWith('ie')) return `${verb.slice(0, -2)}ying`;
  if (/[^aeiou]e$/.test(verb)) return `${verb.slice(0, -1)}ing`;
  // One short syllable ending consonant, vowel, consonant doubles its end: get, run, tag.
  if (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(verb)) return `${verb}${verb.at(-1)}ing`;
  return `${verb}ing`;
}

/** An outside tool's name as what the Odd is doing: listing secret names, or using thought stats. */
function outsideWords(tool: string): string {
  const [first, ...rest] = tool.split(/[_\-\s]+/).filter(Boolean);
  const verb = first?.toLowerCase() ?? '';
  const words = [first, ...rest].join(' ').toLowerCase();
  if (!VERBS.has(verb)) return `Using ${words}`;
  const doing = gerund(verb);
  return [`${doing[0].toUpperCase()}${doing.slice(1)}`, ...rest.map((w) => w.toLowerCase())].join(
    ' '
  );
}

/** Grok's names for the same five tools: what a Grok run gets (grok.ts), and Claude Code's name for each. */
export const GROK_FILE_TOOLS = {
  read_file: 'Read',
  list_dir: 'Glob',
  grep: 'Grep',
  write: 'Write',
  search_replace: 'Edit'
} as const satisfies Record<string, FileTool>;

/**
 * Gemini's built-in file tools, the only ones a Gemini run may call, and
 * Claude Code's name for each, which its reader gives the floor (gemini.ts).
 */
export const GEMINI_FILE_TOOLS = {
  read_file: 'Read',
  read_many_files: 'Read',
  list_directory: 'Glob',
  glob: 'Glob',
  grep_search: 'Grep',
  write_file: 'Write',
  replace: 'Edit'
} as const satisfies Record<string, FileTool>;

/**
 * The office's file tools (files-server.ts in the ledger), as each coding tool
 * names them in its stream, and Claude Code's name for each, which the floor
 * is told (`floorTool`).
 */
export const OFFICE_FILE_TOOLS = {
  mcp__files__read_file: 'Read',
  mcp__files__list_files: 'Glob',
  mcp__files__find_files: 'Glob',
  mcp__files__search_files: 'Grep',
  mcp__files__write_file: 'Write',
  mcp__files__edit_file: 'Edit'
} as const satisfies Record<string, FileTool>;

/** A tool call as the floor is told it: an office file tool by Claude Code's name for it. */
export const floorTool = (name: string): string =>
  Object.hasOwn(OFFICE_FILE_TOOLS, name)
    ? OFFICE_FILE_TOOLS[name as keyof typeof OFFICE_FILE_TOOLS]
    : name;

/**
 * A tool's name, as Claude Code names it, in plain words. An outside tool's
 * service shows by the name in `services` (by its id), else by its id.
 */
export function toolWords(name: string, services: Record<string, string> = {}): string {
  if (Object.hasOwn(TOOL_WORDS, name)) return TOOL_WORDS[name];
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return outsideWords(name);
  const [, server, tool] = m;
  if (server === 'office') return OFFICE_TOOL_WORDS[tool] ?? outsideWords(tool);
  return `${outsideWords(tool)} (${services[server] ?? server})`;
}
