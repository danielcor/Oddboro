// What each of the owner's routes that changes something leaves in the
// ledger. Every POST, PUT, PATCH and DELETE handler under src/routes has one
// row, keyed `<METHOD> <route id>`; the staff PATCH takes several actions, one
// per body key, so it has a row per key `PATCH_KEY` does not class as a
// qualifier, and the task POST has a row per `op` in `TASK_OPS`. A GET reads,
// so the test cannot find one that changes something: such a GET, or a page's
// `load`, gets a row by hand. owner-actions.test.ts fails on a handler with no
// row and on a GET row whose handler is gone, and drives each `records` row to
// check it writes exactly one ledger row of that kind, and each `mayRecord`
// row in a state where it writes, to check it writes only the kinds it lists.
import type { LedgerKind } from '@oddboro/ledger';

/** The Linear row that owes a ledger line for each action that names it. */
const NO_ROW = 'NEW-1693';
const SETUP = 'Setting up the office, before or beside its records, not an action on them.';

export type OwnerAction =
  /** It writes one ledger row of this kind. */
  | { records: LedgerKind }
  /**
   * It writes ledger rows of these kinds and no other, only when and as many as
   * `when` says; otherwise none. A route that writes a row only sometimes is
   * never `none`, which would hide the row from the next reader. One action
   * can write several kinds: adding a persona Odd writes its hire and a `work`
   * row for each part drawn for it (`saveParts` in the ledger).
   */
  | { mayRecord: readonly [LedgerKind, ...LedgerKind[]]; when: string }
  /**
   * It changes the office's records and writes no ledger row: what it changes,
   * or the Linear row that owes one.
   */
  | { none: string }
  /** It changes none of the office's records, and why. */
  | { notAnAction: string };

/** Every `op` the task route takes. The route's `op` has this type, so it can compare no other. */
export const TASK_OPS = [
  'finish',
  'start-response',
  'response',
  'tick',
  'untick',
  'choose',
  'oauth',
  'secret',
  'aws-current',
  'aws-sign-in',
  'aws-roles',
  'aws-choose',
  'aws-secrets-connected',
  'aws-secret-names',
  'aws-secret-keys',
  'aws-secret',
  'tools',
  'confirm-tools',
  'postal-inboxes',
  'postal-select'
] as const;
export type TaskOp = (typeof TASK_OPS)[number];

export const OWNER_ACTIONS = {
  // The owner's New Altitude account lives in the system's secret store, and
  // the reports switch in the settings file; none of them is a record.
  'POST /api/account': { notAnAction: SETUP },
  'DELETE /api/account': {
    none: "Ends the account's sign-in and each persona's, and makes every persona Odd quiet."
  },
  'POST /api/client-log': {
    notAnAction: "Writes the page's boot or error to the log on this computer; no record changes."
  },
  'PUT /api/diagnostics': { notAnAction: SETUP },
  // The weather place and unit, kept in .env with the office settings.
  'PUT /api/weather': { notAnAction: SETUP },
  'DELETE /api/weather': { notAnAction: SETUP },
  'POST /api/diagnostics/envelope': {
    notAnAction: "Passes the page's error report through the office's filter; nothing is kept."
  },
  // The account's sign-in is setup. A persona's comes back here too, and
  // wakes its quiet Odd or adds it.
  'GET /account/callback': {
    mayRecord: ['hire', 'work'],
    when: "A hire, and a work row for each part of its look, when a persona's sign-in finishes in an open office with no Odd of it yet."
  },
  'POST /api/accounts': { records: 'access' },
  'PATCH /api/accounts': { records: 'access' },
  'DELETE /api/accounts': { records: 'access' },
  'PUT /api/agents': { notAnAction: SETUP },
  'POST /api/agents/[tool]': { notAnAction: SETUP },
  'PUT /api/agents/[tool]': { notAnAction: SETUP },
  'DELETE /api/agents/[tool]': { notAnAction: SETUP },
  'POST /api/asks/[id]': {
    mayRecord: ['decision', 'access', 'hire', 'work'],
    when: "A decision for every answer. A yes also writes a second decision for a goal it sets or a plan it takes, an access row for a tool already connected, and for a remove or bring_back ask the Odd's hire row; letting an Odd go closes what it had open as the staff DELETE does."
  },
  'POST /api/asks/[id]/call': { records: 'decision' },
  'POST /api/asks/[id]/filter': { records: 'decision' },
  'POST /api/asks/[id]/folder': { records: 'decision' },
  'POST /api/asks/[id]/reply': { records: 'decision' },
  'POST /api/backup': {
    notAnAction:
      "Closes the line the page shows after a restore, kept in the office's home; no record changes."
  },
  'POST /api/backup/restore': {
    none: 'Puts a backup in place of the whole office at its next start, the database included; the office before it is saved aside.'
  },
  'POST /api/browser-link': {
    notAnAction:
      "Makes a one-time link for the owner's browser, kept in memory for a minute; no record changes."
  },
  'PUT /api/files': { records: 'work' },
  'POST /api/files/open': {
    notAnAction: 'Opens a page the Odd built in the browser; it changes nothing.'
  },
  'POST /api/files/resolve': { notAnAction: 'A read through POST: which names the viewer opens.' },
  'POST /api/folders/pick': {
    notAnAction:
      "Opens the system's folder picker; a picked folder is given through the staff PATCH."
  },
  // An Odd's run reaching its outside tools, with the token the office gave
  // that run (gateway.ts). From the owner's page it answers 401 and changes
  // nothing; what a run's call there changes, the office records itself
  // (`refreshTools`).
  'POST /api/gateway/[connector]': { notAnAction: "Only an Odd's run reaches it." },
  'DELETE /api/gateway/[connector]': { notAnAction: "Only an Odd's run reaches it." },
  'POST /api/goals': { records: 'decision' },
  'PUT /api/goals/[id]': { records: 'decision' },
  'POST /api/goals/[id]/staff': { records: 'decision' },
  'DELETE /api/goals/[id]/staff': { records: 'decision' },
  'POST /api/project-sessions': {
    none: 'Connections, grants and instructions are kept in project_sessions and project_requests. Native terminal input never enters the office ledger.'
  },
  'POST /api/jobs/[id]': { none: NO_ROW },
  'DELETE /api/jobs/away': { none: "Takes the jobs off the desk's While you were away card." },
  'PATCH /api/lessons/[id]': { records: 'decision' },
  'POST /api/looks': {
    notAnAction: 'Draws a look for the hire window; nothing is kept until a hire.'
  },
  'POST /api/looks/parts': {
    notAnAction: 'Builds a look from parts for the hire window; nothing is kept until a hire.'
  },
  'POST /api/office/design': {
    notAnAction: 'Starts drawing an office; nothing changes until Move in, which records.'
  },
  'PUT /api/office/design': { records: 'work' },
  'POST /api/office/layouts/[id]': { records: 'work' },
  'POST /api/office/move-in': { records: 'work' },
  'POST /api/onboarding': {
    mayRecord: ['hire', 'work'],
    when: 'A hire for the Office Manager, and for each persona granted on its card a hire and a work row for each part of its look.'
  },
  // Reads New Altitude's list and brings each persona Odd in line with it:
  // quiet or speaking again, which writes no ledger row, or on a newer package.
  'GET /api/personas': {
    mayRecord: ['work'],
    when: 'One for each persona Odd New Altitude lists on a newer package.'
  },
  // Add and Reconnect. A kept sign-in that still holds finishes at once, as
  // the callback does, and wakes its quiet Odd or adds it.
  'POST /api/personas/[slug]': {
    mayRecord: ['hire', 'work'],
    when: 'A hire, and a work row for each part of its look, when a kept sign-in still holds, the office is open and it has no Odd of the persona yet.'
  },
  'DELETE /api/personas/[slug]': { none: "Ends a persona's sign-in and makes its Odd quiet." },
  'POST /api/pokes/[id]': { none: NO_ROW },
  'DELETE /api/pokes/[id]': { none: NO_ROW },
  'POST /api/reports/[id]': { none: NO_ROW },
  'PUT /api/rooms': { records: 'work' },
  // The owner's name, and that the welcome is done (the `owner` table).
  'POST /api/setup': { none: NO_ROW },
  'POST /api/setup/address': { notAnAction: SETUP },
  'PUT /api/setup/claude': { notAnAction: SETUP },
  'POST /api/setup/claude': { notAnAction: SETUP },
  'DELETE /api/setup/claude': { notAnAction: SETUP },
  'POST /api/setup/notify': { notAnAction: SETUP },
  'POST /api/setup/search': { notAnAction: SETUP },
  // The owner's yes to Advanced mode's warning, and turning it off again.
  'PUT /api/setup/advanced': { records: 'decision' },
  // The owner's answers to the Act check (`passActCheck`).
  'POST /api/act-check': {
    mayRecord: ['decision'],
    when: 'One row the first time every answer is right. None for a wrong answer, or once the check was passed.'
  },
  'PATCH /api/services/[id]': { records: 'access' },
  'POST /api/services/[id]': { none: NO_ROW },
  // The owner's Refresh (`refreshTools`).
  'POST /api/services/[id]/tools': {
    mayRecord: ['access'],
    when: 'A row for each change the service made to its tools since the office last read them: tools added or dropped, Read only reaching more or fewer, and each Odd that lost a standing yes. Nothing when only a description changed, or nothing did.'
  },
  'POST /api/staff': { records: 'hire' },
  // The owner's Remove (`removeOdd`).
  'DELETE /api/staff/[id]': {
    mayRecord: ['hire', 'decision', 'work'],
    when: "One hire row as the Odd leaves. What it had open closes with a row each, as that item's own end would write: a decision per ask of it or about it withdrawn, a work row per open task dropped and per follow-up it had yet to start, which fails."
  },
  'PATCH /api/staff/[id]#permission': { records: 'access' },
  'PATCH /api/staff/[id]#agent': { records: 'access' },
  'PATCH /api/staff/[id]#tool': { records: 'access' },
  'PATCH /api/staff/[id]#commands': { records: 'access' },
  'PATCH /api/staff/[id]#web': { records: 'access' },
  'PATCH /api/staff/[id]#folder': { records: 'access' },
  'PATCH /api/staff/[id]#effort': { records: 'access' },
  'PATCH /api/staff/[id]#model': { records: 'access' },
  'PATCH /api/staff/[id]#account': { records: 'access' },
  'PATCH /api/staff/[id]#actsOnHandOffs': { records: 'access' },
  'POST /api/staff/[id]/access': { records: 'access' },
  'PATCH /api/staff/[id]/access': { records: 'access' },
  'DELETE /api/staff/[id]/access': { records: 'access' },
  'POST /api/staff/[id]/attachments': {
    notAnAction:
      "Keeps a file the owner attaches in the Odd's attachments folder, as part of the chat message that names it, which the chat's own log keeps."
  },
  'POST /api/staff/[id]/bug-reports': {
    notAnAction:
      "Files the owner's reviewed bug report on GitHub with their own GitHub CLI, then adds its link to the chat, which the chat's own log keeps."
  },
  'DELETE /api/staff/[id]/chat': {
    none: 'Stops only the named reply attempt and keeps its outcome in chat.'
  },
  'PATCH /api/staff/[id]/chat': {
    notAnAction:
      "Adds the owner's words to the named reply while it runs; the chat's own log keeps them."
  },
  'POST /api/staff/[id]/chat': {
    notAnAction:
      "The chat's own log keeps it; a decision in it is recorded by the tool the Odd calls."
  },
  'PUT /api/staff/[id]/skills': {
    mayRecord: ['work'],
    when: 'The owner adds, updates or removes a skill. A stale copy changes nothing.'
  },
  'POST /api/staff/[id]/description': {
    notAnAction: 'A read through POST: what saving a changed agent file would ask for.'
  },
  'PUT /api/staff/[id]/description': { records: 'work' },
  'POST /api/staff/[id]/jobs': { none: NO_ROW },
  'PUT /api/staff/[id]/look': { records: 'work' },
  // Marks the Odd's delivered pokes read as its chat shows them.
  'POST /api/staff/[id]/pokes': { none: NO_ROW },
  'POST /api/staff/draft': {
    notAnAction: 'Drafts a job description for the hire window; nothing is kept until a hire.'
  },
  'PUT /api/switches': { none: NO_ROW },
  'POST /api/tasks/[id]#start-response': {
    none: 'Starts the response on an open task from its selected reference file.'
  },
  'POST /api/tasks/[id]#response': {
    none: 'Keeps the versioned response on its task. Finishing records the owner action.'
  },
  'POST /api/tasks/[id]#finish': { records: 'work' },
  // Finishing is the task's one ledger row, so the steps before it write none.
  'POST /api/tasks/[id]#tick': { none: 'Ticks one step of the task.' },
  'POST /api/tasks/[id]#untick': { none: 'Unticks one step of the task and forgets its answer.' },
  'POST /api/tasks/[id]#choose': { none: "Ticks a choice step with the owner's answer." },
  'POST /api/tasks/[id]#oauth': {
    none: 'Starts a sign-in; a server that needs none is marked open and its step ticks.'
  },
  'POST /api/tasks/[id]#secret': {
    none: "Keeps the owner's key in the secret store, drops any AWS secret named for it, and ticks the step."
  },
  'POST /api/tasks/[id]#aws-current': {
    notAnAction: "Reads where the office signed in to AWS, and this tool's role so far."
  },
  'POST /api/tasks/[id]#aws-sign-in': {
    none: "Starts the AWS sign-in; a new place to sign in drops every AWS tool's role."
  },
  'POST /api/tasks/[id]#aws-roles': {
    notAnAction: 'Waits for the AWS sign-in, whose tokens are no record, and lists its roles.'
  },
  'POST /api/tasks/[id]#aws-choose': {
    none: "Sets the tool's AWS role and Region, connects it, and ticks the step."
  },
  'POST /api/tasks/[id]#aws-secrets-connected': {
    notAnAction: 'Reads whether the office has a role to read keys from AWS with.'
  },
  'POST /api/tasks/[id]#aws-secret-names': {
    notAnAction: "Reads the names and descriptions of the AWS account's secrets."
  },
  'POST /api/tasks/[id]#aws-secret-keys': {
    notAnAction: 'Reads the key names inside one AWS secret.'
  },
  'POST /api/tasks/[id]#aws-secret': {
    none: "Names the AWS secret a tool's key comes from, and ticks the step."
  },
  'POST /api/tasks/[id]#tools': { notAnAction: 'Lists the tools the server offers.' },
  'POST /api/tasks/[id]#confirm-tools': {
    none: 'Marks the tool ready with the tools it lists, and ticks the step.'
  },
  'POST /api/tasks/[id]#postal-inboxes': {
    notAnAction: 'Lists the LegalZoom mailboxes the sign-in reaches.'
  },
  'POST /api/tasks/[id]#postal-select': {
    none: 'Saves the one LegalZoom mailbox the office reads, marks the tool ready, and ticks the step.'
  },
  // The app's shell reporting an update, and the owner picking when it
  // installs: both write the `app_update` row.
  'POST /api/update': { none: NO_ROW },
  // The owner's update window, in the `app_update` row.
  'PUT /api/update': { none: NO_ROW },
  // A hosted server's sign-in comes back here: its tokens go in the keychain
  // and the task's sign-in step ticks.
  'GET /connect/callback': { none: NO_ROW }
} as const satisfies Record<string, OwnerAction>;

/** Each action that writes a ledger row, always or only sometimes. */
export type Recording = {
  [K in keyof typeof OWNER_ACTIONS]: (typeof OWNER_ACTIONS)[K] extends
    { records: LedgerKind } | { mayRecord: readonly LedgerKind[] }
    ? K
    : never;
}[keyof typeof OWNER_ACTIONS];
