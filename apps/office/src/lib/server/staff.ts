// Running a staffer: each chat message or job run is Claude Code, or Grok, Codex
// or Gemini for an Odd the owner moved to one (cli.ts), run headless, with the staffer's job
// description from Postgres added to the system prompt. Server only.
//
// A Claude Code run gets the office's file tools where `FILES_VIA_OFFICE` says,
// else its own five (Read, Glob, Grep, Write, Edit), and with the owner's switches as its tool takes them (`OwnTools`), Bash in
// Claude Code's sandbox and WebSearch and WebFetch. It may read only its own
// folder, the owner's data folder, on a thread the thread's folder, and the
// folders the owner gave it (see `readable`), may write only inside the
// staffer's own folder, its own part of that thread's and the folders the
// owner gave it to change, except its tools' own instructions (`INSTRUCTIONS`
// in files.ts), git's usual places in a folder the owner gave it (hooks, the
// config file, submodules' copies: `REPO_RUNS`, which says what they do not
// stop) and, reading the owner's edit, that file (`deniedEdits`),
// loads no project settings, skills or plugins, and is denied anything not
// pre-approved. It always gets the office server (asks,
// tasks, the ledger), plus whatever access the owner granted: servers at read
// level (the tools the server marks as only reading, `readsOnly`) or at write
// level (every tool), each through the office's gateway (gateway.ts), which
// keeps the keys and sign-ins. Hosted servers get a fresh OAuth token per run.
import { savedTaskWords } from './chat-delivery.ts';
import {
  accountOf,
  accountsHome,
  AGENT_NAMES,
  anyStaffer,
  capabilities,
  capped,
  handedOver,
  handOffsLine,
  CHAT_STORIES_MAX,
  chatSession,
  type ChatCard,
  claimPoke,
  clockTime,
  currentPlatform,
  DATABASE_URL,
  deliveries,
  EDIT_CHARS,
  editShown,
  effortFor,
  FILES_SERVER,
  filesViaOffice,
  goal as findGoal,
  fitStories,
  folderLines,
  goalsFor,
  goalWhen,
  handOffBrief,
  handOffContext,
  handOffsFor,
  handsOff,
  hasTool,
  HEALTH_WORDS,
  heldReach,
  holdNetwork,
  home,
  jobsFor,
  ledStories,
  lessonLine,
  lessonsOf,
  levelLine,
  liveLessons,
  MANAGER_ROLE,
  modelFor,
  networkHeld,
  OFFICE_ACCOUNT,
  onStories,
  outsideLines,
  ownerName,
  ownerNoteOf,
  ownToolsSaid,
  pokeMissed,
  recentThreads,
  recentThreadsBrief,
  recordUsage,
  releaseRun,
  reserveRun,
  resultsToJoin,
  roster,
  rulePath,
  runCeiling,
  runsAtDraft,
  runsGoing,
  runsOnLine,
  SECRET_STORES,
  servesHandOff,
  servesNoThread,
  setPlanLimits,
  settingsTab,
  STAFF_SERVER,
  skillsOf,
  staffer,
  stageOf,
  standsFor,
  startFirstDay,
  stillOnDesk,
  storyOf,
  taskFiles,
  threadBrief,
  thread as threadById,
  threadFolder,
  threadOnKnown,
  threadPart,
  threadsFor,
  threadsOn,
  threadsOnBrief,
  toolHome,
  workLedBrief,
  workOnBrief,
  writesWait,
  zone,
  zoneName,
  type Agent,
  type AskRow,
  type CallPlace,
  type Capabilities,
  type ConnectorRow,
  type EditShown,
  type FollowUpKind,
  type FollowUpRow,
  type GoalRow,
  type HandOffStep,
  type Level,
  type Outcome,
  type OwnTools,
  type PokeRow,
  type RecentThread,
  type CheckedFiles,
  type StaffRow,
  type TaskRow,
  type ThreadStory,
  type Unparked,
  type UsageKind,
  workTitle
} from '@oddboro/ledger';
import { flat } from '@oddboro/ledger/desk-answers';
import { currentSystem } from '@oddboro/ledger/platform';
import { computerWord } from '@oddboro/ledger/system-words';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import type { ChatEntry, ChatEvent } from '../staff/chat.ts';
import { floorTool, followUpDetail, type WorkAbout } from '../staff/work.ts';
import type { ChatFile } from '#lib/attachments.ts';
import { agentCommand } from './agent-sign-in.ts';
import { sourceReady } from './access.ts';
import { lastExchange } from './chat-preface.ts';
import { addToChat, history } from './chat-turns.ts';
import { claudeAccountOf, claudeRunHome } from './claude.ts';
import { keptAt, plainName } from './chat-files.ts';
import { endedEarly, LAUNCHES, stoppedWhy } from './cli.ts';
import { drive, ownsGroup, type RunEnd, type Sink } from './drive.ts';
import { bus, emit } from './events.ts';
import { deniedEdits, denyRules, readStaffFile } from './files.ts';
import { firstDayOf } from './first-day.ts';
import { followUpBrief, waitEnded } from './follow-up-brief.ts';
import { closeGateway, openGateway } from './gateway.ts';
import { runEndLine } from './health.ts';
import {
  ACT_WRITE,
  house,
  managerWork,
  skillsSection,
  stillOnDeskSection,
  whoIsHereSection
} from './house.ts';
import { NOT_SIGNED_IN, SIGN_IN_WHERE, type McpServer, type RunImage } from './launch.ts';
import { notifyMac } from './notify.ts';
import { OUTCOME_LINE, personaRun, voiced } from './persona-run.ts';
import { offeredSection } from './persona-offered.ts';
import { catchUp, NOW, parseSession, saveSession, sectionsOf } from './resume.ts';
import { toolServerEnv } from './run-env-allow.ts';
import { cut, officeEnv } from './run-env.ts';
import { sandboxPaths } from './sandbox-paths.ts';
import { NETWORK_REFUSED, NETWORK_REFUSED_LINE } from './sandbox.ts';
import { downtime, installsAt, updateForChat } from './update.ts';
import { tooOldLine } from './versions.ts';
export { activeReply, addToReply, chat, replyToOwnerTurn, stopReply } from './chat-run.ts';
export { history, keepOwnerTurn } from './chat-turns.ts';
export { runJob } from './job-run.ts';
export { chatting, inProgress, isBusy, runsActive, stopRuns } from './run-state.ts';

/** The owner's data folder, which every staffer may read, whatever tool it runs on. */
const DATA = home('data');
const HOMES = home('staff');
const CHAT_TIMEOUT_MS = 5 * 60_000;
const JOB_TIMEOUT_MS = 20 * 60_000;

import { isBusy, slot } from './run-state.ts';

export async function isStaff(id: string): Promise<boolean> {
  return /^[a-z0-9-]+$/.test(id) && !!(await staffer(id));
}

function homeOf(id: string): string {
  const dir = join(HOMES, id);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  return dir;
}

/** The chat as the owner sees it: what was said, and each delivery and lesson where it landed. */
export async function chatLog(id: string): Promise<ChatEntry[]> {
  const items: ChatEntry[] = (await deliveries(id)).map(({ at, ...d }) => ({
    at: at.toISOString(),
    from: 'staff',
    text: '',
    item: d
  }));
  const kept: ChatEntry[] = (await lessonsOf(id))
    .filter((l) => l.heardBy === id)
    .map(({ id: lessonId, text, quote, appliesTo, how, status, staffId, missed, createdAt }) => ({
      at: createdAt.toISOString(),
      from: 'staff',
      text: '',
      lesson: { id: lessonId, text, quote, appliesTo, how, status, staffId, missed }
    }));
  // Each step of a hand-off lands where it happened, so a reply that came back
  // an hour later sits after whatever was said in that hour. The giver's chat
  // keeps the colleague's reply inside the hand-off and shows its own pick-up.
  // A hand-off it gave sits on the card of its thread, where the thread began.
  const lines = await handOffsFor(id);
  const threads: ChatEntry[] = (await threadsFor(id)).map((line) => ({
    at: line.at.toISOString(),
    from: 'staff',
    text: '',
    thread: { line, steps: lines.filter((h) => h.gave && h.threadId === line.id) }
  }));
  const handOffs: ChatEntry[] = lines.flatMap((line) => {
    const at = (d: Date, step: HandOffStep, back?: number): ChatEntry => ({
      at: d.toISOString(),
      from: 'staff',
      text: '',
      handOff: { line, step, back }
    });
    return [
      ...(line.gave ? [] : [at(line.at, 'given')]),
      ...line.backs.flatMap((b, i) =>
        line.gave
          ? b.pickUp.at && b.pickUp.text
            ? [at(b.pickUp.at, 'next', i)]
            : []
          : b.answered
            ? []
            : [at(b.at, 'reply', i)]
      )
    ];
  });
  const messages = history(id).map(({ item: _item, ...message }) => message);
  return [...messages, ...items, ...threads, ...handOffs, ...kept].sort((a, b) =>
    a.at.localeCompare(b.at)
  );
}

/**
 * The tool folder an Odd's runs use: its account's (accounts.ts), or '' for
 * the owner's own Claude login, which an Office account not yet signed in
 * keeps (`claudeRunHome`). A saved session counts only in the folder it was
 * made in.
 */
export async function runHomeOf(who: StaffRow): Promise<string> {
  const account = await accountOf(who);
  if (who.agent === 'claude') return (await claudeRunHome(account)) ?? '';
  return toolHome(who.agent, account);
}

/**
 * The servers and tool permissions one run gets: the outside tools
 * `capabilities` says it holds. A run the office starts on its own
 * (`atDraft`), and any run that serves a colleague's hand-off, works at Draft
 * at most (`ceiling`), so a colleague's words never stand in for the owner's
 * yes. Only the carry-out of an approval ask, the owner's yes to that exact
 * action, keeps the Odd's level, and so does every run that serves a
 * hand-off when the owner lets the Odd act on its own on work from
 * colleagues (`actsOnHandOffs`). Its
 * caps come down to the ceiling too (`capped`), so its prompt lists what it loads.
 * Every outside tool reaches the run through the office's gateway
 * (gateway.ts), which keeps the keys and passes on only the tools the grant
 * reaches; `gate` is the run's token, closed when the run ends. The tool's own
 * allow list names the same tools, so either one alone holds. A write grant
 * at Draft lists every tool, and the gateway holds each change for the
 * owner's yes (`writesWait`), on the desk where `place` says, but for the
 * tools the owner lets the Odd use without asking (`standing`), in any run
 * with a place but one a colleague's words reach (`handed`: one that serves a
 * colleague's hand-off, or a lead's pick-up of a result) while the owner keeps
 * such work to ask first (`handedOver`); a run with no place (a
 * lesson run) changes nothing. At Act it holds only calls to the tools the
 * owner set to ask first (`askFirst`).
 */
async function access(
  who: StaffRow,
  ceiling: Level,
  ms: number,
  place: CallPlace | undefined,
  handed: boolean
) {
  const office: McpServer = {
    type: 'stdio',
    command: process.execPath,
    args: [STAFF_SERVER],
    // What the server reads as it starts, by name (`TOOL_SERVER_ENV`): the
    // run's own environment, which the tool passes on, holds little of the office's.
    env: { ...toolServerEnv(), STAFF_ID: who.id, DATABASE_URL }
  };
  const servers: Record<string, McpServer> = { office };
  const allowed = ['mcp__office'];
  const held = capped(await capabilities(who), ceiling);
  const caps = handed ? handedOver(held) : held;
  const reach: {
    connector: ConnectorRow;
    level: Level;
    waits: boolean;
    standing: string[];
    askFirst: string[];
  }[] = [];
  for (const a of caps.outside) {
    if (a.heldBack) continue;
    const c = a.connector;
    if (!(await sourceReady(c))) {
      a.heldBack = 'sign-in ran out';
      continue;
    }
    reach.push({
      connector: c,
      level: a.level,
      waits: writesWait(a.level, caps.level),
      standing: a.standing,
      askFirst: a.askFirst
    });
    if (a.level === 'act') allowed.push(`mcp__${c.id}`);
    else allowed.push(...c.readTools.map((t) => `mcp__${c.id}__${t}`));
  }
  const { token: gate, servers: outside } = openGateway(reach, ms, place, who.id);
  Object.assign(servers, outside);
  return { servers, office, allowed, caps, gate };
}

/**
 * Who the staffer works for, built fresh each run: the owner, its own intake,
 * and the goals it serves, which are the only goals it sees.
 */
async function whoFor(who: StaffRow, dir: string): Promise<string> {
  const serving = (await goalsFor(who.id)).filter((g) => g.status === 'active');
  const goalLine = (g: (typeof serving)[number]) => {
    const latest = g.progress[0];
    return [
      `  - Goal #${g.id}: ${g.title} (${goalWhen(g).toLowerCase()}, ${g.area}).`,
      g.why && `Why: ${g.why}.`,
      g.doneWhen && `Done when: ${g.doneWhen}.`,
      `Your part: ${g.part}.`,
      latest
        ? `Latest: ${HEALTH_WORDS[latest.health].toLowerCase()}, ${latest.note} (${latest.name})`
        : 'No progress logged yet.'
    ]
      .filter(Boolean)
      .join(' ');
  };
  return [
    '',
    '## Who you work for',
    '',
    `- {owner}. This office is theirs, and runs on their ${computerWord(currentSystem())}.`,
    existsSync(join(dir, 'notes', 'intake.md')) &&
      "- {owner}'s own answers from when you were hired are in notes/intake.md. Read them before your first piece of work, and again whenever you are unsure what they want.",
    serving.length
      ? `- The goals you serve. You see only these; my_goals has the latest:\n${serving.map(goalLine).join('\n')}`
      : '- You serve none of their goals yet.',
    serving.length > 0 &&
      '- After a run that moves one of these goals, or shows it slipping, call log_progress once with one line of evidence.',
    hasTool(who.tools, 'list_goals') &&
      '- list_goals shows every goal, who serves it and how it is going.',
    ''
  ]
    .filter((l) => l !== false)
    .join('\n');
}

/** "Oct 30", in the office's time zone. */
const shortDay = (d: Date) =>
  d.toLocaleDateString('en-US', { timeZone: zone(), month: 'short', day: 'numeric' });

/**
 * What the owner has taught this staffer, and every Odd: the live lessons,
 * loaded into every run by the office, so none depends on the staffer
 * remembering to look.
 */
async function taught(who: StaffRow): Promise<string> {
  const live = await liveLessons(who.id);
  return [
    '',
    '## What {owner} has taught you',
    '',
    '- When {owner} corrects your work or says how they want something done from now on, call keep_lesson once, with their words. Only a chat, a run carrying a note {owner} left on an ask or a task, or a run reading their edit to one of your files has their words; in any other run keep_lesson refuses, so tell them in your reply instead. The lesson is enough: it beats your job steps where they disagree, so do not also edit your job for the same correction unless they ask you to.',
    '- Only the lessons listed here are yours. A correction {owner} gave another Odd, which you may see in the ledger, is not a lesson for you.',
    '- How the whole office should work is a lesson for every Odd. When {owner} says how much the office should do without checking with them, or how they want to hear how things are going, keep it with scope everyone, in their words, even when they do not say it is for everyone. If the answer is too vague to act on, like "just be helpful", ask one follow-up question, and keep nothing if that is still vague. If they skip the question, keep nothing: the office\'s own way stands.',
    `- A lesson can make you more careful, never more permitted. It never widens your level or your tools, and nothing leaves the office on a lesson alone: it still needs {owner}'s yes on that exact action, ${ACT_WRITE}. If their words ask for more than you hold, such as "send emails without asking", keep only what makes you more careful, and tell them plainly that more access is ${settingsTab('the')}'s job, not a lesson's.`,
    ...(live.length
      ? [
          '- Follow every lesson below wherever it applies. A lesson marked "only in" applies only there; one with no mark applies everywhere. Where two disagree, the newer one wins. Where one disagrees with your job steps, the lesson wins.',
          '- A lesson about how you write to {owner} covers what they read from you: chat messages, reports and drafts. It does not cover the titles and fields of asks and tasks unless it says so.',
          '- Before your final reply, go through the lessons below. For each one that shaped what you wrote or did this run, call used_lesson with its id, and do what its answer says. Never mention a lesson that changed nothing.',
          '- When a new lesson replaces one below, keep_lesson needs replaces set to its id and why_replaced. Choose missed when {owner} corrected something the old lesson already covered, so they had to say it again; choose refined only when they changed or narrowed what they want. After a missed one, tell them in one line that you missed it.',
          '- A lesson only for you can replace only one marked for you. For one marked for every Odd, keep yours without replaces: the newer lesson wins for you, and the other Odds keep theirs.',
          '',
          ...live.map((l) => lessonLine(l, shortDay(l.createdAt)))
        ]
      : ['- Nothing yet.']),
    ''
  ].join('\n');
}

/**
 * What this run can do: its level, the tool its runs go through, where it
 * writes, its own tools, and each outside tool it holds or was granted.
 * `officeHeld` says this office holds the network, which its own tools' line
 * applies as my_access does (`ownToolsSaid`).
 */
function canDo(
  caps: Capabilities,
  owner: string,
  agent: Agent,
  own: OwnTools,
  officeHeld: boolean
): string {
  const lines = outsideLines(caps, owner);
  const writes = own.granted.some((f) => f.write)
    ? 'You write files only in your folder, on work you share with colleagues in your part of its folder, and in the folders {owner} gave you to change.'
    : 'You write files only in your folder, or, on work you share with colleagues, in your part of its folder.';
  const reach = [
    'the outside tools below',
    ...(own.web ? ['the web'] : []),
    ...(own.granted.length ? ['the folders {owner} gave you'] : [])
  ];
  const beyond = `Beyond the office, you reach only ${reach.length > 1 ? `${reach.slice(0, -1).join(', ')} and ${reach.at(-1)}` : reach[0]}.`;
  return [
    '',
    '## What you can do',
    '',
    `- ${levelLine(caps.level, owner)}`,
    // At Act, what the owner chose for work another Odd hands it, as my_access says.
    ...(caps.level === 'act' ? [`- ${handOffsLine(caps.actsOnHandOffs, owner)}`] : []),
    `- ${runsOnLine(agent)}`,
    `- ${[writes, ...ownToolsSaid(agent, caps.own, officeHeld), beyond].join(' ')}`,
    '- If a brief names tools you do not have, do the work with your own tools.',
    '- Outside tools:',
    ...(lines.length ? lines.map((l) => `  - ${l}`) : ['  - None yet.']),
    ''
  ].join('\n');
}

/**
 * The system prompt. A run on no thread, such as a chat or a job, lists the
 * threads the staffer leads, so it can continue one rather than open another;
 * a run on a thread hands on in that one, and a run that cannot hand on is
 * told none (`leads`). A chat also lists the threads it
 * works on and does not lead, so what {owner} says there about one reaches
 * its lead. `led` are the stories of the threads it leads (`ledStories`):
 * the lead's run on its thread is told how to move it on, and its chat where
 * its work stands. `on` are the stories of work another Odd leads: a chat's
 * (`onStories`) or a colleague's run on that thread (`storyOf`). A chat's
 * stories together keep to `CHAT_STORIES_MAX`, since it pays for them on every
 * turn; one left out keeps its line in these lists.
 */
async function prompt(
  who: StaffRow,
  opts: {
    dir: string;
    caps: Capabilities;
    owner: string;
    thread?: number;
    chat: boolean;
    led: ThreadStory[];
    on: ThreadStory[];
    shown?: number[];
    own: OwnTools;
    /** Whether this office holds the network (`networkHeld`), read once as the run starts. */
    officeHeld: boolean;
    /**
     * Whether the run is offered `hand_off` (`tool`) and is told the threads it
     * leads (`leads`), by the tool server's own rule (`handsOff`).
     */
    hands: { tool: boolean; leads: boolean };
  }
): Promise<string> {
  const { dir, own, hands, chat } = opts;
  // run() fills in the time, so the rest can be compared with what a resumed session saw.
  const now = NOW;
  const updating = installsAt();
  const led = chat
    ? fitStories(opts.led, (s) => workLedBrief([s]), CHAT_STORIES_MAX)
    : { kept: opts.led, used: 0 };
  const on = chat
    ? fitStories(opts.on, (s) => workOnBrief([s]), CHAT_STORIES_MAX - led.used).kept
    : opts.on;
  const goalsLeftOut = opts.led
    .filter((s) => s.thread.goalId !== null && !led.kept.includes(s))
    .sort((a, b) => b.thread.id - a.thread.id)
    .map(listedLine);
  return (
    who.desk +
    '\n' +
    skillsSection(await skillsOf(who.id)) +
    (await whoFor(who, dir)) +
    (hasTool(who.tools, 'see_office')
      ? whoIsHereSection(
          (await roster())
            .filter((o) => o.id !== who.id)
            .map((o) => ({
              id: o.id,
              name: o.name,
              role: o.role,
              remit: o.remit,
              persona: !!o.package
            })),
          hands.tool
        )
      : '') +
    (await taught(who)) +
    // A chat is told the story of each live goal it leads (`workLedBrief`), so
    // its list leaves those out. Work with no goal stays on it, told or not: the
    // list is where the run hears how to continue it.
    (hands.leads
      ? recentThreadsBrief([
          ...goalsLeftOut,
          ...(await recentThreads(who.id, {
            told: led.kept.filter((s) => s.thread.goalId !== null).map((s) => s.thread.id)
          }))
        ])
      : '') +
    (chat ? threadsOnBrief(await threadsOn(who.id)) : '') +
    (opts.thread
      ? opts.led.flatMap((story) => threadBrief({ story, shown: opts.shown })).join('\n')
      : workLedBrief(led.kept)) +
    (chat ? workOnBrief(on) : on.flatMap((story) => threadOnKnown({ story })).join('\n')) +
    (who.role === MANAGER_ROLE
      ? managerWork(existsSync(join(dir, 'notes', 'pending-judgments.md')))
      : '') +
    // An Odd that can propose a hire hears which real people it may propose as personas.
    (hasTool(who.tools, 'propose_hire') || hasTool(who.tools, 'propose_goal_plan')
      ? offeredSection(
          new Set((await roster()).flatMap((o) => (o.package ? [o.package.slug] : [])))
        )
      : '') +
    stillOnDeskSection(await stillOnDesk(who.id)) +
    house({
      has: (t) => (t === 'hand_off' ? hands.tool : hasTool(who.tools, t)),
      now,
      zone: zoneName(),
      updatesAt: updating === undefined ? undefined : clockTime(updating)
    }) +
    `\n## Where things are\n\n- Your folder: ${dir}\n- Your notes: ${join(dir, 'notes')}\n- {owner}'s data folder: ${DATA}\n` +
    (own.granted.length
      ? `- Folders {owner} gave you:\n${folderLines(own)
          .map((l) => `  - ${l}\n`)
          .join('')}`
      : '') +
    canDo(opts.caps, opts.owner, who.agent, own, opts.officeHeld)
  );
}

/** A story as its one line in the list of work an Odd leads. */
const listedLine = ({ thread: t, waiting, goal }: ThreadStory): RecentThread => ({
  id: t.id,
  title: t.title,
  stage: stageOf(t.status, waiting),
  goal
});

/**
 * How a run ended. `saved` means its tool named a session, which went in the
 * session file, so a later run that resumes it holds this run's message.
 */
export type Run = {
  ok: boolean;
  text: string;
  saved?: true;
  interrupted?: true;
  /** A file job's check of what this run wrote (`CheckedFiles`, less the periods it started with). */
  checked?: Omit<CheckedFiles, 'periods'>;
};
const stopped = (): Run => ({ ok: false, text: 'Stopped at your request.', interrupted: true });
/** How a run ends on its stop: the owner's Stop, or the Odd leaving the office (`stopRuns`). */
const stoppedBy = (who: StaffRow, signal?: AbortSignal): Run =>
  signal?.reason === 'left'
    ? { ok: false, text: `${who.name} left the office, so this stopped.` }
    : stopped();

type Window = { utilization?: number; resetsAt?: number };

/** Every run reports the owner's plan windows it has news of, often only one. Keep the latest of each. */
export async function notePlan(info: unknown): Promise<void> {
  const w = (info as { unifiedWindows?: Record<string, Window> } | undefined)?.unifiedWindows;
  const five = w?.five_hour;
  const week = w?.seven_day;
  const when = (s?: number) => (s ? new Date(s * 1000) : null);
  const news = {
    ...(typeof five?.utilization === 'number'
      ? { fiveHour: five.utilization, fiveHourResetsAt: when(five.resetsAt) }
      : {}),
    ...(typeof week?.utilization === 'number'
      ? { sevenDay: week.utilization, sevenDayResetsAt: when(week.resetsAt) }
      : {})
  };
  if (Object.keys(news).length) await setPlanLimits(news).catch(() => {});
}

/**
 * What a staffer's file tools may read: its own folder, the owner's data
 * folder, Claude Code's folder for this run's sessions (long tool results
 * land there), the folder of each thread the run reads (`reads`), and the
 * folders the owner gave it (`granted`). Read rules govern Glob and Grep too,
 * and dontAsk turns down every other path. With Run commands, the sandbox
 * reads the same list.
 */
function readable(dir: string, reads: number[], granted: string[], claude: string): string[] {
  return [dir, DATA, sessionsFolder(dir, claude), ...reads.map(threadFolder), ...granted];
}

/**
 * What a run reads beyond its own: `readable` less the run's folder, which
 * each tool reaches already as its working folder, and Claude Code's sessions
 * folder, which is Claude Code's own. Every tool's launch, and Claude Code's
 * `--add-dir` without commands, read this one list, in `readable`'s order.
 */
function readsBeyond(dir: string, reads: number[], granted: string[], claude: string): string[] {
  const own = [dir, sessionsFolder(dir, claude)];
  return readable(dir, reads, granted, claude).filter((p) => !own.includes(p));
}

/**
 * Claude Code's folder for the sessions of a run in `dir`, where long tool
 * results land, in its account's folder (`claude`): ~/.claude for the owner's
 * own login.
 */
function sessionsFolder(dir: string, claude: string): string {
  return join(claude, 'projects', sessionsOf(dir));
}

/** Claude Code names a working folder's sessions folder after its path. */
function sessionsOf(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * What no staffer may read, even when the owner's own Claude Code settings
 * allow it: a deny rule beats every allow. Secret stores, the rest of the
 * office's folder and other staffers' folders, and the rest of Claude Code's
 * folder, sessions included. Each is denied with everything under it (`denyRules`).
 */
function unreadable(
  id: string,
  dir: string,
  threads: number[],
  granted: string[],
  claude: string
): string[] {
  const reads = readable(dir, threads, granted, claude);
  const besides = (parent: string, keep: string[]) => {
    try {
      return readdirSync(parent)
        .filter((n) => !keep.includes(n))
        .map((n) => join(parent, n));
    } catch {
      return [];
    }
  };
  const paths = [
    // ~/.claude among them, which this run's sessions folder, read, keeps open:
    // the two lines at the end shut the rest of it.
    ...SECRET_STORES.map((p) => join(homedir(), p)),
    ...besides(home(), ['staff', 'data', ...(threads.length ? ['threads'] : [])]),
    ...besides(HOMES, [id]),
    // Every other thread's folder. Claude Code takes a read rule on a folder
    // to cover writes too, so none may cover this run's own part.
    ...(threads.length ? besides(dirname(threadFolder(threads[0])), threads.map(String)) : []),
    // An account's Claude folder sits in the office's accounts folder, which
    // its sessions folder keeps open: shut every other tool's and account's.
    ...(claude.startsWith(`${accountsHome()}${sep}`)
      ? [
          ...besides(accountsHome(), ['claude']),
          ...besides(join(accountsHome(), 'claude'), [basename(claude)])
        ]
      : []),
    ...besides(claude, ['projects']),
    ...besides(join(claude, 'projects'), [sessionsOf(dir)])
  ];
  // Never deny a folder a staffer must read, such as an office kept under ~/Library.
  const covers = (p: string) => reads.some((r) => r === p || r.startsWith(`${p}${sep}`));
  return [...new Set(paths)]
    .filter((p) => !covers(p))
    .flatMap((p) => denyRules(['Read'], rulePath(p)));
}

/** The time as a run is told it: "Tuesday, November 3, 9:41 PM", in the office's time zone. */
const officeNow = () =>
  new Date().toLocaleString('en-US', {
    timeZone: zone(),
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

/**
 * A run ended, so pick-ups it held may start (follow-ups.ts).
 * The page never hears it: /api/events sends only `event`.
 */
export const RUN_ENDED = 'run-ended';

/** What a run is for, and what it may do. */
export type RunOpts = {
  runId?: string;
  signal?: AbortSignal;
  kind: UsageKind;
  /** A scheduled file exchange grants no right to lead or wake the work. */
  jobFiles?: {
    thread: number;
    input?: string;
    output: string;
    record: string;
    inputHash?: string;
    sources?: string[];
  };
  sessionFile?: string;
  extra?: string;
  /** The owner's own message, when this is a chat. */
  ownerSaid?: string;
  /** The owner's text stays literal, even when it contains {owner}. */
  literal?: string;
  /** That chat as it stood before the owner's message: `tell_lead` passes on its last exchange. */
  chatBefore?: ChatEntry[];
  /** The files the owner attached to that message, which `tell_lead` takes to the lead. */
  ownerFiles?: ChatFile[];
  /** What a follow-up was asked, in words a persona can read: its `message` is only a label. */
  asked?: string;
  /** The ask the owner approved that this run carries out: the only one its self-edits may cite. */
  approvedAsk?: number;
  /** The owner's note a follow-up carries out, which a lesson may quote. */
  ownerNote?: string;
  /** The file the owner edited, and their version of it, which a lesson read from it quotes. The run may not write that file. */
  ownerEdit?: { path: string; text: string };
  /** Draft at most: a follow-up `runsAtDraft` names (a kind `atDraft` names, or one that serves a colleague's hand-off, except an approval ask's carry-out and an Odd the owner lets act on its own there), or a file job's run. */
  draftOnly?: boolean;
  /** A run that only reads the owner's reason or edit for a lesson (`servesNoThread`): it hands nothing on. */
  lessonRun?: boolean;
  /** The hand-off a colleague's run serves: asks and tasks it raises carry it, and it cannot hand off. */
  handOffId?: number;
  /** The thread the run works on, either side: it reads the thread's folder and writes its own part. */
  threadId?: number;
  /** On a lead's pick-up of a colleague's result, that colleague: what the run puts on the desk names them. */
  via?: string;
  /**
   * A colleague's words reach this run: it serves a colleague's hand-off, or
   * is a lead's pick-up of a result. Unless the owner lets the Odd act on its
   * own on work from colleagues, no standing yes applies (`handedOver`).
   */
  fromColleague?: boolean;
  /** The hand-backs this run's brief already holds in full, so its lead's story leaves them out. */
  shown?: number[];
  /** Pictures the owner attached in a chat, for a tool that cannot open one with its own tools (Codex). */
  images?: RunImage[];
  timeoutMs: number;
  onEvent?: (e: ChatEvent) => void;
  /** Set by `run`: when the run must end, and the step it is on while it gets ready. */
  clock?: Clock;
};

/**
 * A run's time limit, counted from when the run was asked for, not from when
 * its tool starts. `step` names what the run is doing before its tool starts,
 * so a run that never got that far says where it stopped. While its tool
 * runs (`going`), the tool's own timer ends it at the same deadline.
 */
type Clock = { deadline: number; step: string; over: boolean; going: boolean };

const noReply = (ms: number): Run => ({
  ok: false,
  text: `No reply after ${ms / 60_000} minutes.`
});

/**
 * One run of an Odd. A persona Odd's chat, job or follow-up goes on from its
 * coding tool to its persona on New Altitude (`personaRun`); every other run
 * is the coding tool's alone.
 *
 * It ends by its time limit even when something it waits on before its tool
 * starts never answers, so no chat stays "still replying" and no slot stays
 * busy. A run still getting ready then never starts its tool (`runTool`).
 */
export async function run(who: StaffRow, message: string, opts: RunOpts): Promise<Run> {
  const own = !opts.runId;
  const live = opts.runId
    ? runsGoing.get(opts.runId)
    : reserveRun({ staffId: who.id, kind: opts.kind });
  if (!live) throw new Error('The run is no longer registered.');
  if (live.stop.signal.aborted) return stopped();
  const kind = opts.kind;
  const clock: Clock = {
    deadline: Date.now() + opts.timeoutMs,
    step: 'getting ready',
    over: false,
    going: false
  };
  const input = { ...opts, runId: live.key, signal: live.stop.signal, clock };
  // Before its tool starts, `run` ends it: at its time limit, or at once on
  // Stop or the Odd leaving. Once its tool runs (`going`), `runTool` does.
  const ended = Promise.withResolvers<Run>();
  const timer = setTimeout(() => {
    if (clock.going) return;
    clock.over = true;
    console.error(
      `${who.name}'s ${kind} run stopped after ${opts.timeoutMs / 60_000} minutes, ${clock.step}.`
    );
    const r = noReply(opts.timeoutMs);
    opts.onEvent?.({ type: 'error', message: r.text });
    ended.resolve(r);
  }, opts.timeoutMs);
  const interrupted = () => {
    if (clock.going) return;
    const r = stoppedBy(who, live.stop.signal);
    if (!r.interrupted) opts.onEvent?.({ type: 'error', message: r.text });
    ended.resolve(r);
  };
  live.stop.signal.addEventListener('abort', interrupted, { once: true });
  try {
    const r = await Promise.race([
      who.package && voiced(kind) && !opts.lessonRun
        ? personaRun(who, message, { ...input, kind }, runTool)
        : runTool(who, message, input),
      ended.promise
    ]);
    // stderr: the shell routes only stdout, so an error's words can never reach it as a request.
    if (!r.ok) console.error(runEndLine(who.name, kind, r));
    return r;
  } finally {
    clearTimeout(timer);
    live.stop.signal.removeEventListener('abort', interrupted);
    if (own) {
      releaseRun(live);
      bus.emit(RUN_ENDED);
    }
  }
}

/**
 * One headless run on the Odd's coding tool. `session` resumes a saved session
 * file, or starts fresh. A tool that will not start fails the run, naming the
 * tool: no run falls back to another.
 */
async function runTool(who: StaffRow, message: string, opts: RunOpts): Promise<Run> {
  if (opts.signal?.aborted) return stopped();
  const clock = opts.clock ?? {
    deadline: Date.now() + opts.timeoutMs,
    step: 'getting ready',
    over: false,
    going: false
  };
  const step = (now: string) => void (clock.step = now);
  const dir = homeOf(who.id);
  step('reading its account');
  // The account its tool signs in with, and that account's folder. A session
  // saved in another folder (the Odd moved accounts) cannot resume here.
  const account = await accountOf(who);
  const toolDir = await runHomeOf(who);
  const read =
    opts.sessionFile && existsSync(opts.sessionFile)
      ? parseSession(readFileSync(opts.sessionFile, 'utf8'))
      : undefined;
  const saved = read && (read.home ?? '') === toolDir ? read : undefined;
  /** Claude Code's folder for this run: the account's, or ~/.claude for the owner's own login. */
  const claudeDir = toolDir || join(homedir(), '.claude');
  const ceiling = runCeiling(who.permission, opts.draftOnly);
  // Every run gets a key: a thread it hands off on keeps it, and holds the
  // Odd's pick-ups there until it ends (`runsGoing`), even when it is a
  // follow-up on no thread. A call the gateway holds for the owner carries it too.
  const key = opts.runId!; // run() reserves it before preparation.
  step("opening its tools' gateway");
  const { servers, office, allowed, caps, gate } = await access(
    who,
    ceiling,
    opts.timeoutMs,
    opts.lessonRun
      ? undefined
      : {
          staffId: who.id,
          run: key,
          handOffId: opts.handOffId,
          threadId: opts.threadId,
          via: opts.via
        },
    !!opts.fromColleague
  );
  // A source can sign out between the check of both jobs and this run.
  const unavailable = caps.outside.filter(
    (a) => a.heldBack && opts.jobFiles?.sources?.includes(a.connector.id)
  );
  if (unavailable.length) {
    await closeGateway(gate);
    return {
      ok: false,
      text: unavailable
        .map(
          (a) =>
            `${who.name} needs ${a.connector.name} for the scheduled file. Ask in ${who.name}'s chat to reconnect it (${a.heldBack}).`
        )
        .join('\n')
    };
  }
  // Prompts name the owner as {owner}: each install's staff use its own name.
  step('writing its brief');
  const owner = await ownerName();
  const say = (s: string) => s.replaceAll('{owner}', owner);
  // Claude Code keeps a session's first system prompt on --resume, so a
  // resumed run's message carries the time and the sections that changed.
  const prior = saved?.sessionId;
  const time = officeNow();
  const inChat = opts.kind === 'chat';
  // A Claude Code chat reads stream-json and keeps its stdin open until its
  // result, so Send now can add the owner's words to the turn (`addToReply`).
  // A persona's chat stays closed: its persona hears only the first message.
  const streamed = inChat && who.agent === 'claude' && !who.package;
  // What the Odd knows of the work it leads and the work it is on, read now,
  // as the run starts.
  const led = opts.threadId
    ? await ledStories(who.id, { thread: opts.threadId })
    : inChat
      ? await ledStories(who.id, 'chat')
      : [];
  const on = inChat
    ? await onStories(who.id)
    : opts.threadId && !led.length
      ? await storyOf(opts.threadId)
      : [];
  // A chat reads the folder of all that work, even a story too long to be told
  // there. A folder not made yet stays out: each tool would be started with a
  // path that does not exist. A run on a thread reads that one folder.
  const reads = opts.threadId
    ? [opts.threadId]
    : [...led, ...on].map((s) => s.thread.id).filter((id) => existsSync(threadFolder(id)));
  // The owner's switches and folders as this run's tool takes them (the
  // ledger's `ownTools`, which `capabilities` worked out once), less a network
  // this office holds back after Claude Code refused the open one. Read once,
  // so the run, its prompt and its tool server agree.
  const officeHeld = networkHeld();
  const own = heldReach(who.agent, caps.own, officeHeld);
  const extraReads = own.granted.map((f) => f.path);
  const extraWrites = own.granted.filter((f) => f.write).map((f) => f.path);
  // From the facts officeEnv hands the tool server, so the prompt lists the
  // threads a run leads, and who it may hand work to, only when that run is offered hand_off.
  const hands = handsOff(who.tools, {
    thread: !!opts.threadId,
    handOff: !!opts.handOffId,
    lesson: !!opts.lessonRun
  });
  const system = say(
    (await prompt(who, {
      dir,
      caps,
      owner,
      thread: opts.threadId,
      chat: inChat,
      led,
      on,
      shown: opts.shown,
      own,
      officeHeld,
      hands
    })) + (opts.extra ?? '')
  );
  const sections = sectionsOf(system, say(who.desk));
  const preface = prior ? catchUp(saved?.seen, sections, time) : '';
  // In a chat, the office tools get the owner's own words, so a change the owner asks for
  // there is recorded as their decision without an ask.
  Object.assign(
    office.env,
    officeEnv({
      key,
      ownerSaid: opts.ownerSaid,
      update: opts.ownerSaid ? await updateForChat() : undefined,
      chatExchange: opts.chatBefore && lastExchange(opts.chatBefore, { owner, odd: who.name }),
      ownerFiles: opts.ownerFiles?.map((f) => ({
        tag: f.tag,
        path: keptAt(f.name),
        name: plainName(f.name)
      })),
      approvedAsk: opts.approvedAsk,
      signedOut: caps.outside
        .filter((a) => a.heldBack === 'sign-in ran out')
        .map((a) => a.connector.id),
      ownerNote: opts.ownerNote,
      ownerEdit: opts.ownerEdit?.text,
      ceiling: ceiling !== who.permission ? ceiling : undefined,
      handOffId: opts.handOffId,
      threadId: opts.threadId,
      via: opts.via,
      fromColleague: opts.fromColleague,
      lessonRun: !!opts.lessonRun,
      // Every run while held, whatever its own tool or switches: its
      // office_report speaks of other Odds too.
      networkHeld: officeHeld
    })
  );
  // On a thread, the run writes only its own part of the thread's folder.
  const fileThread = opts.threadId ?? opts.jobFiles?.thread;
  const part = fileThread ? threadPart(fileThread, who.id) : undefined;
  if (part) mkdirSync(part, { recursive: true });
  const writes = [dir, ...(part ? [part] : []), ...extraWrites];
  const denied = deniedEdits({
    dir,
    writes,
    granted: extraWrites,
    edited: opts.ownerEdit?.path
  });
  // Where the office carries the run's files (`FILES_VIA_OFFICE`), its tool's
  // own file tools are off and the office's file server is its one way to
  // files, holding the same folders on every system: it reads what the run
  // reads, writes what it writes, and never writes what `deniedEdits` names.
  const officeFiles = filesViaOffice(who.agent, currentPlatform());
  if (officeFiles) {
    servers.files = {
      type: 'stdio',
      command: process.execPath,
      args: [FILES_SERVER],
      env: {
        ODDBORO_FILES: JSON.stringify({
          cwd: dir,
          reads: readsBeyond(dir, reads, extraReads, claudeDir),
          input: opts.jobFiles?.input,
          writes,
          noWrite: denied
        }),
        ...(opts.jobFiles ? { ODDBORO_FILE_CHECK: JSON.stringify(opts.jobFiles) } : {})
      }
    };
    allowed.push('mcp__files');
  }
  // Bash writes in every folder Claude Code works in (the cwd and each
  // --add-dir), whatever the Edit rules say. So with commands, only the
  // folders the run writes are added, and the sandbox's denyWrite, which beats
  // them, holds the data folder and what `deniedEdits` names: never a folder the
  // run only reads, since one may hold a folder it writes (measured on Claude
  // Code 2.1.318). A data folder that is not there is left out: it sits in
  // the office's home, which is neither the cwd nor added, so nothing in the
  // run can make it.
  const data = existsSync(DATA) ? [DATA] : [];
  // Commands get a temp folder of their own: short, since a long one falls
  // back to the folder every run shares (measured), under this system's temp
  // root (`SANDBOX_PATHS`).
  const tmp = own.commands ? join(sandboxPaths().tmpRoot, `ob-${key.slice(0, 8)}`) : undefined;
  // The temp folder comes last: npm keeps its cache there (`shellEnv`), and
  // without it in --add-dir the sandbox refuses npm's writes (measured).
  const workIn = tmp
    ? [...data, ...(part ? [part] : []), ...extraWrites, tmp]
    : readsBeyond(dir, reads, extraReads, claudeDir);
  // The owner's pick for this Odd, or Medium; never below Medium for the Office Manager.
  const model = modelFor(who.agent, who.model);
  const effort = effortFor(who.agent, who.effort, who.role === MANAGER_ROLE, model);
  const input = preface + say(message) + (opts.literal === undefined ? '' : `\n\n${opts.literal}`);
  step(`checking ${AGENT_NAMES[who.agent]}'s sign-in and version`);
  // An added Claude account nobody signed in to: say where to sign in, rather than Claude Code's own advice.
  if (who.agent === 'claude' && account !== OFFICE_ACCOUNT && !(await claudeAccountOf(account))) {
    const line = `Claude Code ${NOT_SIGNED_IN}`;
    await closeGateway(gate);
    opts.onEvent?.({ type: 'error', message: line });
    return { ok: false, text: line };
  }
  // A tool older than the office runs fails on a switch it does not know, so it never starts.
  const tooOld = await tooOldLine(who.agent, SIGN_IN_WHERE);
  if (tooOld) {
    await closeGateway(gate);
    opts.onEvent?.({ type: 'error', message: tooOld });
    return { ok: false, text: tooOld };
  }
  step(`starting ${AGENT_NAMES[who.agent]}`);
  const allReads = readable(dir, reads, extraReads, claudeDir);
  const launch = await LAUNCHES[who.agent]({
    key,
    staffId: who.id,
    dir,
    reads: [
      ...readsBeyond(dir, reads, extraReads, claudeDir),
      ...(opts.jobFiles?.input ? [opts.jobFiles.input] : [])
    ],
    part,
    writes,
    granted: extraWrites,
    edited: opts.ownerEdit?.path,
    system: system.replaceAll(NOW, time),
    input,
    resume: prior,
    servers,
    allowed,
    timeoutMs: opts.timeoutMs,
    web: own.web,
    commands: own.commands,
    network: own.network,
    effort,
    model,
    account,
    // Claude Code, Grok and Gemini open a picture with their file tools;
    // Codex has no such tool (`view_image` is off), so it gets them with the message.
    ...(opts.images?.length ? { images: opts.images } : {}),
    // What only Claude Code reads (`ClaudeRun`).
    toolDir,
    streamed,
    officeFiles,
    tmp,
    workIn,
    data,
    denied,
    readable: allReads,
    // Working these out lists folders, so only a run whose tool reads them does it.
    ...(who.agent === 'claude'
      ? { unreadable: unreadable(who.id, dir, reads, extraReads, claudeDir) }
      : {}),
    sandboxReads: allReads.filter((p) => p !== DATA || data.length)
  });
  // Stopped while it got ready: `run` has ended it, so it starts nothing now.
  if (opts.signal?.aborted) {
    if (!('refused' in launch)) launch.done();
    await closeGateway(gate);
    return stopped();
  }
  if ('refused' in launch) {
    await closeGateway(gate);
    opts.onEvent?.({ type: 'error', message: launch.refused });
    return { ok: false, text: launch.refused };
  }
  const tool = AGENT_NAMES[who.agent];
  step(`waiting on ${tool}`);
  clock.going = true;
  // The command the page counts as installed, such as a Grok only in xAI's
  // install folder or an npm Claude Code on Windows; by name when there is
  // none, so the run fails naming it.
  const [cmd, before] = agentCommand(who.agent) ?? [who.agent, []];
  /** Codex's and Gemini's whole messages, as the chat shows them. */
  let said = '';
  const sink: Sink = {
    event: (e) => {
      switch (e.type) {
        case 'session':
          // The end carries it.
          break;
        case 'tool':
          opts.onEvent?.({ type: 'tool', name: floorTool(e.name) });
          break;
        case 'delta':
          opts.onEvent?.({ type: 'delta', text: e.text });
          break;
        // Only Codex's and Gemini's readers send whole messages. Claude Code's
        // and Grok's send their text as deltas alone, so no reply shows twice.
        case 'message': {
          const text = (said ? '\n\n' : '') + e.text;
          said += text;
          opts.onEvent?.({ type: 'delta', text });
          break;
        }
        case 'usage':
          void recordUsage(who.id, opts.kind, e.usage).catch(() => {});
          break;
        case 'plan':
          void notePlan(e.info);
          break;
        default: {
          // The type check fails here until a new kind of event has its case.
          const unheard: never = e;
          console.error(`${who.name}'s run has no case for ${JSON.stringify(unheard)}`);
        }
      }
    }
  };
  let started = false;
  const end = await drive(
    () => {
      started = true;
      return spawn(cmd, [...before, ...launch.args], {
        cwd: dir,
        env: launch.env,
        detached: ownsGroup(launch),
        windowsHide: true
      });
    },
    launch,
    sink,
    {
      deadline: clock.deadline,
      signal: opts.signal ?? new AbortController().signal,
      live: runsGoing.get(key)
    }
  );
  clock.going = false;
  const ended = toolEnded(who, end, opts);
  const stderr = end.outcome === 'done' ? '' : end.stderr;
  // A Claude Code that refuses the open network fails this run: the owner
  // is told plainly, and from now on this office's Claude Code runs keep
  // their commands off the internet (`holdNetwork`).
  const refused =
    !ended.ok &&
    who.agent === 'claude' &&
    own.network &&
    NETWORK_REFUSED.test(`${ended.text}\n${stderr}`);
  if (refused)
    void holdNetwork().catch((e: unknown) =>
      console.error("Could not record that Odds' commands stay off the internet:", e)
    );
  // Keyed on the owner's message, not the kind: a new hire's hello is a
  // chat run the owner sent nothing to.
  const line = NETWORK_REFUSED_LINE[opts.ownerSaid === undefined ? 'unsent' : 'sent'];
  const r = refused ? { ok: false, text: line.replaceAll('{name}', who.name) } : ended;
  // Saved however the run ended: once the tool names a session, it holds the message.
  const kept = !!(end.session && opts.sessionFile);
  // The run ends whatever a step here throws: a throw that skipped its end
  // left the chat "still replying" until the office restarted.
  try {
    void closeGateway(gate);
    if (end.session && opts.sessionFile)
      saveSession(opts.sessionFile, { sessionId: end.session, seen: sections, home: toolDir });
    // The time limit passed while it got ready, so the driver started nothing.
    if (end.outcome === 'timeout' && !started)
      console.error(
        `${who.name}'s ${opts.kind} run was ready only after its time limit, so ${tool} never started.`
      );
    // `over` says `run` already told the owner the run hit its time limit, so they hear it once.
    if (!clock.over && !r.interrupted)
      opts.onEvent?.(r.ok ? { type: 'done', text: r.text } : { type: 'error', message: r.text });
  } catch (e) {
    console.error(`${who.name}'s run ended, but tidying up after it failed:`, e);
  }
  return kept ? { ...r, saved: true } : r;
}

/** What an Odd's run says when its tool's run ends (`drive`). */
function toolEnded(who: StaffRow, end: RunEnd, opts: RunOpts): Run {
  switch (end.outcome) {
    // The result's text, else the text streamed, else the last whole message.
    case 'done':
      return { ok: true, text: (end.text ?? end.spoken).trim() };
    case 'failed': {
      const { why } = end;
      // A result that ended early, or one that says it erred, fails the run.
      if ('result' in why)
        return {
          ok: false,
          text:
            why.result.subtype !== 'success'
              ? endedEarly(who.agent, why.result)
              : (why.result.text ?? 'The run failed.')
        };
      if ('tool' in why) return { ok: false, text: why.tool };
      if ('exit' in why) return { ok: false, text: stoppedWhy(who.agent, why.exit, end.stderr) };
      return { ok: false, text: `Could not start ${AGENT_NAMES[who.agent]}: ${why.start}` };
    }
    case 'timeout':
      return noReply(opts.timeoutMs);
    // The run's signal says which: the owner's Stop, or the Odd leaving.
    case 'stopped':
    case 'left':
      return stoppedBy(who, opts.signal);
    default: {
      // The type check fails here until a new way to end has its words.
      const unworded: never = end;
      return unworded;
    }
  }
}

/** What a staffer is told when it reads the owner's edit to its file, for a lesson. */
function editBrief(path: string, shown: EditShown): string[] {
  const cut = shown.from
    ? ` Both start at character ${shown.from}, a little before the first change; the start is the same in both.`
    : '';
  return [
    `{owner} edited your file ${path} and saved it. Below is the file just before their save (your version, unless they had saved it before), then as it is now, each cut at ${EDIT_CHARS} characters.${cut}`,
    '',
    '1. Work out what they changed.',
    '2. If the changes show how they want this kind of work done from now on, call keep_lesson once, quoting their words from the version now. It waits for their Keep, whatever you pass.',
    '3. If it is a one-off fix (a fact, a name, a typo), keep nothing, and say so.',
    '4. Do not edit the file, or anything else. This run only reads the edit.',
    '',
    '<before>',
    shown.before,
    '</before>',
    '',
    '<now>',
    shown.now,
    '</now>'
  ];
}

/**
 * Do the work the owner's answer calls for, in a fresh session, as soon as the owner
 * answers. The staffer ends its reply with an outcome line. A reply without one
 * counts as failed, so the owner hears about it.
 */
export async function followThrough(
  f: FollowUpRow & { unparked?: Unparked },
  a?: AskRow,
  t?: TaskRow,
  g?: GoalRow
): Promise<{ outcome: Outcome; text: string; saw?: string; joined?: number[] }> {
  const who = await staffer(f.staffId);
  if (!who) return { outcome: 'failed', text: `No Odd named ${f.staffId}` };
  // Work a colleague handed over, or its result coming home.
  const handed =
    (f.kind === 'hand_off' || f.kind === 'handed_back') && f.handOff
      ? { kind: f.kind, ...f.handOff }
      : undefined;
  const colleague = handed && {
    id: handed.from,
    name: (await anyStaffer(handed.from))?.name ?? handed.from
  };
  // The hand-off this run's work serves, if any: its own, or the one whose ask or
  // task the owner just answered. Its result goes back to the giver.
  const serves = await servesHandOff(f);
  // Whether this run carries out the owner's yes to an approval ask, which the Draft rule weighs.
  const carriesApproval = f.kind === 'carry_out' && a?.kind === 'approval';
  const giver = serves?.handOff
    ? {
        id: serves.handOff.from,
        name: (await anyStaffer(serves.handOff.from))?.name ?? serves.handOff.from
      }
    : undefined;
  // The thread it works on. Every hand-off is a step in one, and its files cross
  // in the thread's folder. Hand-backs written before they carried their thread cannot find it.
  const threadId = f.threadId ?? serves?.threadId ?? undefined;
  const thread = threadId ? await threadById(threadId) : undefined;
  if (colleague && !thread)
    return {
      outcome: 'failed',
      text: `This hand-off with ${colleague.name} lost track of the work it was for.`
    };
  // Results that landed while a run of this Odd's on the thread had yet to end:
  // this pick-up takes them too, and they end with it.
  const joined = await Promise.all(
    (await resultsToJoin(f)).flatMap(({ id, handOff: h, note }) =>
      h
        ? [
            anyStaffer(h.from).then((c) => ({
              id,
              h,
              result: note,
              colleague: { id: h.from, name: c?.name ?? h.from }
            }))
          ]
        : []
    )
  );
  const joinedIds = joined.map((j) => j.id);
  // What this pick-up raises comes from a colleague's work: the newest result's colleague.
  const via =
    handed?.kind === 'handed_back'
      ? [
          { id: f.id, from: handed.from },
          ...joined.map((j) => ({ id: j.id, from: j.h.from }))
        ].sort((x, y) => y.id - x.id)[0].from
      : undefined;
  // The owner's edit, read now, so saves while this waited to start are in it.
  let edit: { path: string; saw: string; shown: EditShown } | undefined;
  if (f.kind === 'edited') {
    const e = f.edit;
    if (!e) return { outcome: 'failed', text: 'This edit run lost track of its file.' };
    try {
      const saw = (await readStaffFile(who.id, e.path)).content;
      edit = { path: e.path, saw, shown: editShown(e.before, saw) };
    } catch (err) {
      return {
        outcome: 'failed',
        text: `Could not read ${e.path}: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
  const label = edit
    ? `Reading your edit to ${edit.path}`
    : handed
      ? `${handed.kind === 'hand_off' ? 'For' : 'Back from'} ${colleague?.name}: ${handed.title}`
      : f.kind === 'resume'
        ? (thread?.title ?? 'Picking the work back up')
        : (a?.title ??
          (t
            ? `After: ${t.title}`
            : g
              ? `Plan: ${g.title}`
              : f.kind === 'first_day'
                ? 'First day'
                : followUpDetail(f.kind, { colleague: colleague?.name })));
  const task = t ? { row: t, files: await taskFiles(t.id) } : undefined;
  // One carry-out may stand for twin asks that start no run of their own.
  // `standsFor` finds none for a kind that has no twins.
  const also = f.kind === 'carry_out' && a ? await standsFor(a) : [];
  const detail = followUpDetail(f.kind, { ask: a?.id, colleague: colleague?.name });
  // A colleague handed work on a goal's thread is told the goal in its brief.
  const goalServed =
    handed?.kind === 'hand_off' && thread?.goalId ? await findGoal(thread.goalId) : undefined;
  const goal = goalServed ?? (thread?.goalId ? await findGoal(thread.goalId) : g);
  const leadId = thread?.hubId ?? who.id;
  const about: WorkAbout | undefined =
    goal?.status === 'active'
      ? {
          key: randomUUID(),
          kind: 'goal',
          id: goal.id,
          title: goal.title,
          leadId,
          lead: leadId === who.id ? who.name : ((await staffer(leadId))?.name ?? leadId)
        }
      : undefined;
  // The owner sees the work by its one name, as it shows while queued and in
  // the Ledger; `label` stays the run's message to the model.
  const work = {
    kind: 'follow-up' as const,
    label: await workTitle(f),
    detail,
    askId: a?.id,
    about,
    handOffId: serves?.id
  };
  const draftOnly = runsAtDraft({
    kind: f.kind,
    serves: !!serves,
    carriesApproval,
    actsOnHandOffs: who.actsOnHandOffs
  });
  const res = await slot(who.id, work, (onEvent, runId) =>
    run(who, label, {
      kind: 'follow-up',
      literal:
        f.kind === 'task_done' && t?.responseVersion && t.response
          ? savedTaskWords(t.response)
          : undefined,
      runId,
      onEvent,
      asked:
        handed?.kind === 'hand_off'
          ? `${colleague?.name} asked you: ${handed.title}\n\n${handed.brief}`
          : undefined,
      approvedAsk: f.kind === 'carry_out' ? a?.id : undefined,
      ownerNote: ownerNoteOf(f),
      ownerEdit: edit && { path: edit.path, text: edit.shown.now },
      draftOnly,
      lessonRun: servesNoThread(f.kind),
      handOffId: serves?.id,
      // A lead's pick-up reads a colleague's result: it stays at Draft by its
      // kind, and its standing yeses follow the owner's choice too.
      fromColleague: serves !== undefined || f.kind === 'handed_back',
      threadId: thread?.id,
      via,
      shown: f.kind === 'handed_back' ? [f.id, ...joinedIds] : undefined,
      timeoutMs: JOB_TIMEOUT_MS,
      extra: [
        '',
        '## This run',
        '',
        '{owner} is not in a chat with you.',
        // Answered in its chat: the reply this run ends with shows there (`answerInChat`).
        ...(f.chatCard
          ? [
              `They answered in your chat, so your reply at the end also shows there, under the ${f.chatCard.kind} they answered. Write it to them.`
            ]
          : []),
        '',
        // Here, before the kind's own brief, so every kind of run that ended a park says so.
        ...(f.unparked ? waitEnded(f.unparked) : []),
        ...(handed && colleague && thread
          ? handOffBrief({
              kind: handed.kind,
              h: handed,
              colleague,
              me: who.id,
              result: f.note,
              thread: thread.id,
              goal: goalServed,
              joined,
              acts: !draftOnly && who.permission === 'act'
            })
          : edit
            ? editBrief(edit.path, edit.shown)
            : [
                ...followUpBrief(f, a, task, g, {
                  also,
                  draftOnly,
                  level: who.permission,
                  actsOnHandOffs: who.actsOnHandOffs
                }),
                ...(serves?.handOff && giver && thread
                  ? handOffContext({
                      h: serves.handOff,
                      giver: giver.name,
                      me: who.id,
                      thread: thread.id
                    })
                  : [])
              ]),
        '',
        'Then reply with what you did in a few plain lines. End with one line that is exactly one of: "Outcome: done", "Outcome: failed", "Outcome: waiting" (waiting means you put what you need on their desk).',
        ''
      ].join('\n')
    })
  );
  // The file an edited run read, so the office can tell a save made while it ran.
  const saw = edit?.saw;
  if (!res.ok) return { outcome: 'failed', text: res.text, saw, joined: joinedIds };
  const m = OUTCOME_LINE.exec(res.text);
  if (!m)
    return {
      outcome: 'failed',
      text: `${res.text}\n\n(${who.name} did not say whether it finished.)`,
      saw,
      joined: joinedIds
    };
  return {
    outcome: m[1].toLowerCase() as Outcome,
    text: res.text.slice(0, m.index).trim(),
    saw,
    joined: joinedIds
  };
}

/** A one-off draft from a staffer, outside any session: used to draft a job description. */
export async function draft(id: string, message: string): Promise<Run> {
  const who = await staffer(id);
  if (!who) return { ok: false, text: `No Odd named ${id}` };
  return slot(
    id,
    { kind: 'draft', label: 'Drafting', detail: 'Drafting for the hire window' },
    (onEvent, runId) =>
      run(who, message, { kind: 'draft', runId, timeoutMs: CHAT_TIMEOUT_MS, onEvent })
  );
}

/**
 * A new hire's first minutes. It says hello in its chat, in the session the
 * owner's chats then resume. A hire with a job then starts its first day's
 * work as a follow-up, so nobody has to ping it to get it moving. A hire with
 * no job starts nothing: one that serves a goal gets its first piece from the
 * goal's lead, whom approving the hire already woke on the goal's thread, and
 * any other runs only when it is handed work.
 */
export async function firstDay(id: string): Promise<void> {
  const who = await staffer(id);
  if (!who) return;
  // Read from the ledger, after the hire route has added the first job and
  // linked the goal the hire was proposed for, so the hello and the first day
  // agree with what the hire really has.
  const [jobs, serving] = await Promise.all([jobsFor(id), goalsFor(id)]);
  // Only an active goal: it is the only kind its runs are shown (`whoFor`).
  const day = firstDayOf({ jobs: jobs.length, goal: serving.find((g) => g.status === 'active') });
  if (!isBusy(id)) {
    const r = await slot(
      id,
      { kind: 'draft', label: 'Saying hello', detail: 'Introducing themselves' },
      (onEvent, runId) =>
        run(
          who,
          [
            'You were hired a moment ago, and you just walked into the office. {owner} has your chat open. Say hello.',
            '',
            '- Write as yourself, the way your job description says you work: a few short lines, no headings, no lists.',
            '- Say who you are and what you are here for, in your own words, not your job title.',
            ...day.hello
          ].join('\n'),
          {
            kind: 'chat',
            runId,
            sessionFile: chatSession(id),
            timeoutMs: CHAT_TIMEOUT_MS,
            onEvent
          }
        ),
      { greeting: true }
    );
    // The chat session wrote this hello, so it is not a told line.
    if (r.ok) addToChat(id, { at: new Date().toISOString(), from: 'staff', text: r.text });
  }
  if (day.starts) await startFirstDay(id);
}

/**
 * A line from a staffer in their chat that no run wrote, like a new manager's
 * hello. The next chat tells the session it said it (`chatPreface`).
 */
export function sayInChat(id: string, text: string): void {
  addToChat(id, { at: new Date().toISOString(), from: 'staff', text, told: true });
}

/** The most of a failed follow-up's reason its one chat line carries. */
const FAILED_LINE_MAX = 300;

/**
 * The Odd's reply to an answer the owner gave on a card in its chat: what
 * the run their answer started did, in the chat under that card (`re`), so
 * the talk goes on where they answered. One line per run. A failed run says
 * so in one line, shown as a failed reply is. A told line, since no run of
 * the chat session wrote it: the next chat hears it (`chatPreface`).
 */
export function answerInChat(id: string, card: ChatCard, outcome: Outcome, result: string): void {
  const failed = outcome === 'failed';
  const why = cut(flat(result), FAILED_LINE_MAX);
  addToChat(id, {
    at: new Date().toISOString(),
    from: 'staff',
    text: failed
      ? `Could not finish this${why ? `: ${why}` : '.'}`
      : result.trim() || (outcome === 'waiting' ? 'It waits on you, on your desk.' : 'Done.'),
    told: true,
    re: card,
    ...(failed ? { runFailed: true as const } : {})
  });
  emit({ type: 'change', table: 'chat' });
}

/** Deliver a due poke: a chat line from the staffer, and a notification on the Mac. */
export async function deliverPoke(p: PokeRow): Promise<void> {
  // More than 15 minutes late is missed, not counting time the app spent updating.
  const late = pokeMissed(p.at, new Date(), downtime());
  // An Odd that left says nothing: leaving cancelled its pokes, and this is the second wall.
  const who = await staffer(p.staffId);
  if (!who) return;
  if (!(await claimPoke(p.id, late)) || late) return;
  addToChat(p.staffId, {
    at: new Date().toISOString(),
    from: 'staff',
    text: p.message,
    poke: true
  });
  void notifyMac(who?.name ?? 'Oddboro', p.message);
}
