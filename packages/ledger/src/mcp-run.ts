// The tool server's run: who it acts as, what the office set for it, the
// server itself and the helpers every tool uses.
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AlreadyOnDesk,
  ask,
  grantsFor,
  ownerName,
  staffer,
  type GoAhead,
  type LedgerRow
} from './office.ts';
import { type GoalView } from './goals.ts';
import { goalWhen, HEALTH_WORDS, HORIZONS, STATUS_WORDS } from './goal-words.ts';
import { handsOff } from './capabilities.ts';
import { LEVELS, parseLevel } from './access-words.ts';
import { type CarriedFile } from './hand-offs.ts';
import { MANAGER_ROLE } from './managers.ts';
import { type OwnerWords } from './lessons.ts';
import { workFile } from './threads.ts';
import { INSTRUCTIONS, THREADS_DIR, workName, workPath } from './work-paths.ts';
import { MISSED_RUNS, type HireProposal } from './schema.ts';
import { officeDay, SCHEDULE_RULE, WEEKDAYS, zone, zoneName } from './time.ts';
import {
  GRANTABLE_TOOLS,
  hasTool,
  isGrantable,
  isOffered,
  type OfficeToolId,
  type RIDES_WITH,
  type ToolRun
} from './tools.ts';
import { home, isOfficeFile, isWhereNamed } from './home.ts';
import { trustSystemCertificates } from './certificates.ts';
import { advancedMode, projectConnections } from './project-sessions.ts';
import { skillsOf } from './staff-skills.ts';

trustSystemCertificates();
const ME = process.env.STAFF_ID ?? '';
const me = await staffer(ME);
if (!me) throw new Error(`STAFF_ID "${ME}" names no Odd in this office`);
/** What this office's staff call the owner. */
const OWNER = await ownerName();
/** The office's time zone in words, like "Pacific Time". */
const ZONE = zoneName();
const has = (tool: OfficeToolId) => hasTool(me.tools, tool);
/** This staffer's own folder. Files it names are relative to it. */
const HOME = home('staff', ME);

/**
 * The owner's message, when this run is a chat with them. The office sets it, not
 * the staffer, so a change made "because the owner asked" carries their real words.
 */
const OWNER_SAID = process.env.OWNER_SAID || undefined;
/**
 * The files the owner attached to that message, set by the office: each one's
 * tag in their message, its path in this Odd's folder, and the owner's own
 * name for it. `tell_lead` takes every one to the lead with their words.
 */
const OWNER_FILES = ownerFiles(process.env.OWNER_FILES);
// Each Gmail account is a connector of its own. With more than one, the Odd
// names the one the email came to, and the reply goes out from it.
const held = await grantsFor(ME);
const mailboxes = held
  .filter((g) => g.connector.config.google === 'gmail')
  .map((g) => ({ id: g.connectorId, account: g.connector.config.account }));
/** This run, as the office tools' row conditions read it. */
const RUN: ToolRun = {
  gmail: mailboxes.length > 0,
  // Project tools exist only while the owner keeps Advanced mode on.
  project:
    process.env.LESSON_RUN !== '1' &&
    (await advancedMode()) &&
    (await projectConnections(ME)).length > 0,
  write: held.some((g) => g.level === 'act'),
  skills: (await skillsOf(ME)).length > 0,
  chat: OWNER_SAID !== undefined,
  manager: me.role === MANAGER_ROLE
};
/**
 * Whether this run is offered `tool` (`isOffered`). A tool with a condition is
 * registered behind this, never behind a rule of its own.
 */
const offered = (tool: OfficeToolId) => isOffered(me.tools, tool, RUN);
/**
 * The owner's note a follow-up carries out: their reason on an ask, what to
 * change, or their note on a task. Lessons may quote it; it is no go-ahead.
 */
const OWNER_NOTE = process.env.OWNER_NOTE || undefined;
/**
 * The owner's version of a file they edited, when this run reads that edit.
 * Lessons may quote it, as guesses only (`keptAs`); it is no go-ahead.
 */
const OWNER_EDIT = process.env.OWNER_EDIT || undefined;
/** The owner's words this run carries for a lesson. A run carries one of the three at most. */
const OWNER_WORDS: OwnerWords | undefined = OWNER_EDIT
  ? { text: OWNER_EDIT, from: 'edit' }
  : OWNER_SAID
    ? { text: OWNER_SAID, from: 'chat' }
    : OWNER_NOTE
      ? { text: OWNER_NOTE, from: 'note' }
      : undefined;
/** The ask the owner approved that this run carries out, set by the office. No other ask counts. */
const APPROVED_ASK = Number(process.env.APPROVED_ASK) || undefined;
/**
 * Set by the office for a colleague's run on a hand-off: asks and tasks it
 * raises carry it, so the owner's answer goes back, and it cannot hand off.
 */
const HAND_OFF_ID = Number(process.env.HAND_OFF_ID) || undefined;
/**
 * The level this run works at most, set by the office when it is below the
 * Odd's own. my_access reads it from the env (`accessInRun`).
 */
const CEILING = parseLevel(process.env.CEILING);
/**
 * The thread this run works on, either side, set by the office. Asks and tasks
 * it raises carry it. The hub's runs hand off into it and may park it.
 */
const THREAD_ID = Number(process.env.THREAD_ID) || undefined;
/** Set by the office for every run: a thread it puts work on keeps it (`keepRun` in work/hand-offs.ts, `runsGoing`). */
const RUN_KEY = process.env.RUN_KEY || undefined;
/**
 * Set by the office for a run that only reads the owner's reason or edit for a
 * lesson (`servesNoThread`): it hands nothing on, so it gets no hand_off.
 */
const LESSON_RUN = process.env.LESSON_RUN === '1';
/**
 * Set by the office when a lead's run picks up a colleague's handed-back
 * result: the colleague's id. What the run puts on the desk names them, so
 * the owner sees whose work it came from.
 */
const VIA = process.env.VIA || undefined;
/** What an ask or task raised in this run is part of. */
const RAISED_ON = { handOffId: HAND_OFF_ID, threadId: THREAD_ID };
/** Whether this run gets hand_off, and whether it is told the threads it leads. */
const HANDS_OFF = handsOff(me.tools, {
  thread: THREAD_ID !== undefined,
  handOff: HAND_OFF_ID !== undefined,
  lesson: LESSON_RUN
});

const approvedArg = z
  .number()
  .int()
  .optional()
  .describe(
    `Outside a chat with ${OWNER}: the id of the ask they approved, while you carry it out.`
  );

/** The owner's go-ahead for a change to this staffer, or why there is none. */
async function goAhead(askId?: number): Promise<GoAhead | { problem: string }> {
  if (OWNER_SAID) return { said: OWNER_SAID };
  if (askId) {
    const a = await ask(askId);
    if (a?.staffId !== ME || a.status !== 'approved')
      return { problem: `Ask #${askId} is not an ask of yours that ${OWNER} approved.` };
    // Each yes covers the run that carries it out, and no later one.
    if (askId !== APPROVED_ASK)
      return { problem: `Ask #${askId} is not the approved ask this run is carrying out.` };
    return { askId };
  }
  return {
    problem: `Only when ${OWNER} asks for it in chat, or with the id of an ask they approved. To propose it, raise_ask with the exact change first.`
  };
}

/** An optional link from a new ask to the one the owner sent back. */
const revisesArg = z
  .number()
  .int()
  .optional()
  .describe(`When ${OWNER} sent an ask back to rework, its id. Leave out otherwise.`);

const attachArg = z
  .array(z.string())
  .max(5)
  .optional()
  .describe(
    `Files that go with it: one in your folder, e.g. ['notes/intake.md'], or one in the folder of a goal or work you are on, by its path from ${THREADS_DIR}/, e.g. ['${workName(12, 'paige/index.html')}']. Attach the file itself, never a copy. ${OWNER} sees them on their desk and edits a Markdown one from your folder right there, so do not tell them where to find it.`
  );

/** A file an Odd names on a tool call: its office name and real path, or undefined when it cannot read it. */
async function readableFile(p: string): Promise<{ name: string; real: string } | undefined> {
  if (isAbsolute(p)) return undefined;
  if (workPath(p)) {
    const real = await workFile(ME, p);
    return real ? { name: p, real } : undefined;
  }
  const name = ownFile(p);
  return name ? { name, real: resolve(realpathSync(HOME), name) } : undefined;
}

/**
 * The attachments as names the owner's viewer opens (`workPath` for a file in
 * a thread's folder, else a path inside this staffer's folder), or why one is
 * not. Never a full path, and never a file reached through a link out.
 */
async function attachable(
  paths: string[] = []
): Promise<{ paths: string[] } | { problem: string }> {
  const out: string[] = [];
  for (const p of paths) {
    const name = (await readableFile(p))?.name;
    if (!name)
      return {
        problem: `No file at ${p} that you can attach. Name a file in your folder by its path inside it, e.g. notes/intake.md, or one in the folder of a goal or work you are on from ${THREADS_DIR}/, e.g. ${workName(12, 'paige/index.html')}, never by its full path. Write it first if it is not there.`
      };
    out.push(name);
  }
  return { paths: [...new Set(out)] };
}

const fileName = z
  .string()
  .max(240)
  .regex(/^[\w.-]+(?:\/[\w.-]+)*$/)
  .refine(
    (s) => s.split('/').every((part) => part !== '.' && part !== '..'),
    'Use a file name inside the work folder.'
  );
const jobFiles = z.object({
  thread: z.number().int().positive().max(2147483647),
  input: fileName
    .optional()
    .describe(
      "A scheduled writer's result to read first, including its Odd's part, like clerk/wire.md."
    ),
  output: fileName.describe('The result to write inside your own part, like edition.md.'),
  sources: z
    .array(z.string().min(1).max(120))
    .max(12)
    .optional()
    .describe(
      'Tools needed to produce this file: connector ids or web. A checked input from another job needs no source account of its own.'
    )
});
const planFiles = jobFiles.omit({ thread: true }).extend({
  share: z
    .boolean()
    .optional()
    .describe(
      'Ask for permission to put material from the listed sources in only this result, readable by the Odds on this goal.'
    )
});
const atArg = z.string().regex(SCHEDULE_RULE.oddAt);
const scheduleArg = z.discriminatedUnion('every', [
  z.object({ every: z.literal('minutes'), n: z.number().int().min(SCHEDULE_RULE.oddMinMinutes) }),
  z.object({ every: z.literal('day'), at: atArg }),
  z.object({ every: z.literal('weekday'), at: atArg }),
  z
    .object({ every: z.literal('week'), day: z.enum(WEEKDAYS), at: atArg })
    .describe('Once a week, e.g. { every: "week", day: "Fri", at: "16:00" }.')
]);
const missedArg = z
  .enum(MISSED_RUNS)
  .optional()
  .describe(
    `What the job does with runs it missed while the office was off. 'latest' (the usual, for sweeps, reports and reminders): only the newest run matters. 'record': every missed period gets its own entry, filled later. Pick 'record' only when each run adds an entry to a series that must have no gaps, such as a daily count or a trend file.`
  );

/**
 * A file in this staffer's folder, as the path inside it to its real path, or
 * undefined when there is none. A link out of the folder is not in it.
 */
function ownFile(path: string): string | undefined {
  try {
    const root = realpathSync(HOME);
    const file = realpathSync(resolve(root, path));
    return file.startsWith(root + sep) && statSync(file).isFile()
      ? relative(root, file)
      : undefined;
  } catch {
    // Nothing at that path.
    return undefined;
  }
}

// `ownFile` gives the system's separator, so a step is split on both. A Mac's
// and Windows's disks read `claude.md` as `CLAUDE.md`, so case does not count.
const lowerInstructions = INSTRUCTIONS.map((n) => n.toLowerCase());
const isInstructionFile = (name: string): boolean =>
  name.split(/[\\/]/).some((step) => lowerInstructions.includes(step.toLowerCase()));

/**
 * The office name of a file a hand_off names by its full path: in this Odd's
 * folder, its path inside it; in the office's folder of threads, its work name,
 * since a hand-off's brief lists the work's files at their full paths. Any
 * other name stays as it is.
 */
function officeName(p: string): string {
  if (!isAbsolute(p)) return p;
  const inside = (root: string) => {
    const r = relative(root, p);
    return r && !isAbsolute(r) && r.split(sep)[0] !== '..' ? r : undefined;
  };
  const own = inside(HOME);
  if (own) return own;
  const work = inside(home(THREADS_DIR));
  return work ? `${THREADS_DIR}/${work.split(sep).join('/')}` : p;
}

/** Why a file cannot go with work an Odd passes on, by `hand_off` or `tell_lead`. */
type Unfit = 'unread' | 'link' | 'instruction' | 'hidden' | 'office';

/**
 * A file named to go with work, as the office found it, or why it cannot go.
 * `hand_off` and `tell_lead` refuse the same files, each in its own words.
 */
async function fitToCarry(
  asked: string
): Promise<
  | { file: { name: string; real: string }; inWork?: { thread: number; inside: string } }
  | { unfit: Unfit }
> {
  const file = await readableFile(asked);
  if (!file) return { unfit: 'unread' };
  const inWork = workPath(file.name);
  // `ownFile` names the file where its real path is, so a link on the way,
  // such as an attachments folder swapped for one, names another file.
  // `workFile` refuses a link in the work already.
  if (!inWork && !isWhereNamed({ realInside: file.name, named: asked })) return { unfit: 'link' };
  if (isInstructionFile(file.name)) return { unfit: 'instruction' };
  if (file.name.split(/[\\/]/).some((step) => step.startsWith('.'))) return { unfit: 'hidden' };
  if (!inWork && isOfficeFile(file.name)) return { unfit: 'office' };
  return { file, inWork };
}

/** The name a file from an Odd's own folder lands under in its part of the work. */
const landingName = (name: string): string => name.replace(/[\\/]/g, '-');

/** What `hand_off` says of a file it refuses, named as the Odd named it. */
const HAND_OFF_UNFIT: Record<Unfit, (p: string) => string> = {
  unread: (p) =>
    `You cannot read ${p}. Name a file in your folder by its path inside it or its full path, or one in the folder of work you are on from ${THREADS_DIR}/, and call hand_off again.`,
  link: (p) =>
    `${p} is reached through a link, and a hand-off carries only a file where it really is. Name the file itself, and call hand_off again.`,
  instruction: (p) =>
    `${p} is an instruction file, and those never go with a hand-off. Say what your colleague needs in the brief, and call hand_off again.`,
  hidden: (p) =>
    `${p} is a hidden file, and those never go with a hand-off. Name another file, or leave it out, and call hand_off again.`,
  office: (p) =>
    `${p} is one of the office's own files, and those never go with a hand-off. Say what your colleague needs in the brief, and call hand_off again.`
};

/** Why a file the owner attached did not go to the lead with `tell_lead`, as the lead's note says it. */
const TELL_LEAD_UNFIT: Record<Unfit, string> = {
  unread: 'the office cannot read it',
  link: 'it is reached through a link',
  instruction: 'it is an instruction file',
  hidden: 'it is a hidden file',
  office: "it is one of the office's own files"
};

/**
 * The files a hand_off names, as paths inside the folder of work `on` for
 * those already there, and what to copy there for the rest, or why the
 * hand-off cannot go.
 */
async function filesForHandOff(
  named: string[],
  on: number | undefined
): Promise<{ here: string[]; carry: CarriedFile[] } | { problem: string }> {
  const here: string[] = [];
  const carry: CarriedFile[] = [];
  // Each landing name to the file there: as the office found it, and as the Odd named it.
  const landing = new Map<string, { name: string; named: string }>();
  for (const p of named) {
    const found = await fitToCarry(officeName(p));
    if ('unfit' in found) return { problem: HAND_OFF_UNFIT[found.unfit](p) };
    const { file, inWork } = found;
    const inside = inWork && inWork.thread === on ? inWork.inside : undefined;
    const name = landingName(file.name);
    // Lower case, since a Mac's and Windows's disks hold those as one file.
    const lands = (inside ?? `${ME}/${name}`).toLowerCase();
    const first = landing.get(lands);
    if (first?.name === file.name) continue;
    if (first)
      return {
        problem: `Two of these files would land under one name: ${first.named} and ${p}. Rename one and call hand_off again.`
      };
    landing.set(lands, { name: file.name, named: p });
    if (inside) here.push(inside);
    else carry.push({ real: file.real, name, named: p });
  }
  return { here, carry };
}

/** The owner's attachments the office set, or none when it set nothing readable. */
function ownerFiles(env: string | undefined): { tag: string; path: string; name: string }[] {
  if (!env) return [];
  try {
    const read = z
      .array(z.object({ tag: z.string(), path: z.string(), name: z.string() }))
      .safeParse(JSON.parse(env));
    return read.success ? read.data : [];
  } catch {
    // Not JSON: the office sets it, so this is no message of the owner's.
    return [];
  }
}

/**
 * The files the owner attached to their message, as `tell_lead` takes them to
 * the lead: what to copy, named by each one's tag, and why any cannot go. The
 * same checks as `hand_off`'s files, and every file goes, not a pick. Each
 * lands under the owner's name for it, its last part only, by the same rules:
 * never a hidden name or an instruction file's.
 */
async function attachedForLead(): Promise<{
  carry: CarriedFile[];
  unfit: { named: string; why: string }[];
}> {
  const carry: CarriedFile[] = [];
  const unfit: { named: string; why: string }[] = [];
  for (const { tag, path, name } of OWNER_FILES) {
    const found = await fitToCarry(path);
    const plain = name.split(/[\\/]/).pop() ?? '';
    const why =
      'unfit' in found
        ? found.unfit
        : !plain || plain.startsWith('.')
          ? 'hidden'
          : isInstructionFile(plain)
            ? 'instruction'
            : undefined;
    if (why) unfit.push({ named: tag, why: TELL_LEAD_UNFIT[why] });
    else if ('file' in found) carry.push({ real: found.file.real, name: plain, named: tag });
  }
  return { carry, unfit };
}

/** What propose_hire and propose_goal_plan both take to describe one hire. */
const hireFields = {
  name: z.string().max(40).describe('A first name for the Odd.'),
  role: z.string().max(60),
  remit: z.string().max(200).describe('One line for the card: what it is for.'),
  job_description_file: z
    .string()
    .describe('The job description, a file in your folder, e.g. notes/jd-mail-clerk.md.'),
  permission: z
    .enum(LEVELS)
    .describe('read reads and reports, draft prepares drafts for their yes, act acts alone.'),
  room: z
    .string()
    .optional()
    .describe('Where it works: workspace, workspace-east, mail-room, library or lobby.'),
  office_tools: z
    .array(z.string())
    .optional()
    .describe(
      `Office tools beyond the ones every Odd has: ${GRANTABLE_TOOLS.join(', ')}. Leave out for the usual starters.`
    ),
  appearance: z
    .string()
    .max(600)
    .optional()
    .describe(
      'What the person looks like, in a sentence or two: hair, build of clothes, colours, glasses or a beard. The office draws them from it.'
    ),
  first_job: z
    .object({
      name: z.string(),
      instructions: z.string(),
      schedule: scheduleArg,
      report: z
        .boolean()
        .optional()
        .describe(
          `Put each result on ${OWNER}'s desk as a report. True when the job makes something for them to read.`
        ),
      missed: missedArg
    })
    .optional(),
  intake_file: z
    .string()
    .optional()
    .describe(
      `An intake ${OWNER} filled in for this hire, a file in your folder. The new Odd gets a copy as notes/intake.md and reads their answers first-hand.`
    ),
  persona_slug: z
    .string()
    .max(80)
    .optional()
    .describe(
      `When the hire is a real person New Altitude offers as a persona: its slug, if you know it. Set role to "<Full Name> Persona" either way.`
    )
};
const hireShape = z.object(hireFields);
type HireArgs = z.infer<typeof hireShape>;

/** One hire as a proposal, or why the files it names are not there. */
function hireFrom(a: HireArgs): HireProposal | string {
  const jd = ownFile(a.job_description_file);
  if (!jd) return `No file at ${a.job_description_file} in your folder. Write it first.`;
  const intake = a.intake_file ? ownFile(a.intake_file) : undefined;
  if (a.intake_file && !intake) return `No file at ${a.intake_file} in your folder.`;
  return {
    name: a.name,
    role: a.role,
    remit: a.remit,
    room: a.room,
    permission: a.permission,
    jobDescriptionFile: jd,
    tools: a.office_tools?.filter(isGrantable),
    appearance: a.appearance,
    job: a.first_job,
    intakeFile: intake,
    personaSlug: a.persona_slug?.trim() || undefined
  };
}

/** A goal for a staffer to read: what it is, why, what done looks like, and how it is going. */
function goalText(g: GoalView & { part?: string }, others = true): string {
  const head = `## Goal #${g.id}: ${g.title}\n${STATUS_WORDS[g.status]}, ${goalWhen(g)}, ${g.area}`;
  return [
    head,
    g.why && `Why it matters: ${g.why}`,
    g.doneWhen && `Done when: ${g.doneWhen}`,
    g.part && `Your part: ${g.part}`,
    others &&
      (g.staff.length
        ? `Served by: ${g.staff.map((s) => `${s.name} (${s.part})`).join('; ')}`
        : 'Nobody serves it yet.'),
    g.progress.length
      ? `Progress, newest first:\n${g.progress.map((p) => `- ${day(p.createdAt)} ${p.name}: ${HEALTH_WORDS[p.health]}. ${p.note}`).join('\n')}`
      : 'No progress logged yet.'
  ]
    .filter(Boolean)
    .join('\n');
}

const goalFields = {
  title: z
    .string()
    .max(140)
    .describe('The goal in their words, one line: "Answer every client email within a day".'),
  why: z.string().max(1000).optional().describe('Why it matters to them.'),
  done_when: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'What done looks like, measurable when it can be: "a reply to every client email within a day, for a month".'
    ),
  horizon: z.enum(HORIZONS.map((h) => h.id) as [string, ...string[]]),
  due: z.string().optional().describe('YYYY-MM-DD, when horizon is "date".'),
  area: z
    .string()
    .max(40)
    .describe('work, family, health, money, learning or fun, or another word.')
};

const server = new McpServer({ name: 'office', version: '1.0.0' });
/**
 * Registers an office tool that refuses any argument its input does not name.
 * The SDK builds a plain object from a raw shape, which drops an unknown key
 * and runs the tool as if it were left out: an Odd whose chat still uses a
 * renamed parameter would start new work when it meant to continue old work.
 * The refusal lists the keys the tool takes instead of echoing the unknown
 * one, since an old name may say a word the Odd never reads.
 */
function tool<Shape extends z.ZodRawShape>(
  name: OfficeToolId | keyof typeof RIDES_WITH,
  { description, inputSchema }: { description: string; inputSchema: Shape },
  run: ToolCallback<Shape>
) {
  const keys = Object.keys(inputSchema);
  const takes = keys.length ? `takes only ${keys.join(', ')}` : 'takes no arguments';
  const strict = z.strictObject(inputSchema, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `${name} ${takes}. Nothing was done. Call it again with those.`
        : undefined
  });
  // `run` is typed by the raw shape, as the SDK types one: the strict object
  // parses to the same arguments, and reads a shape spread from a union
  // (raisedArgs) as unknown fields. Named here because inference picks the raw
  // shape; the first is the output schema, which no office tool has.
  // The ledger refuses a repeat on the owner's desk (`AlreadyOnDesk`): the
  // Odd reads why as a tool error, never as a crash.
  const guarded = (async (...args: unknown[]) => {
    try {
      return await (run as (...a: unknown[]) => unknown)(...args);
    } catch (e) {
      if (e instanceof AlreadyOnDesk) return refused(e.message);
      throw e;
    }
  }) as ToolCallback<Shape>;
  server.registerTool<z.ZodRawShape, typeof strict>(
    name,
    { description, inputSchema: strict },
    guarded
  );
}
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
/**
 * A hand_off that handed nothing on: refused, or held for the owner's answer.
 * An error, so the Odd cannot read it as the work being handed over.
 */
const notHanded = (why: string) => ({
  ...text(`Nothing was handed off yet. ${why}`),
  isError: true
});
/** A resume_at that parked nothing: an error, so the Odd cannot read it as parked. */
const notParked = (why: string) => ({
  ...text(`This work was not parked. ${why}`),
  isError: true
});
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const day = (d: Date | string) => officeDay(new Date(d));
/** "Oct 30", in the office's time zone. */
const shortDay = (d: Date) =>
  d.toLocaleDateString('en-US', { timeZone: zone(), month: 'short', day: 'numeric' });
const line = (r: LedgerRow) =>
  `- ${day(r.createdAt)} [${r.kind}] ${r.actor}: ${r.title}${r.reason ? ` (reason: ${r.reason})` : r.kind === 'decision' ? ' (no reason given)' : ''}`;

/** A tool call that put nothing on the desk. An error, so the Odd cannot read it as done. */
const refused = (why: string) => ({
  ...text(`Nothing went on ${OWNER}'s desk. ${why}`),
  isError: true
});

export {
  ME,
  OWNER,
  ZONE,
  has,
  OWNER_SAID,
  OWNER_FILES,
  mailboxes,
  offered,
  OWNER_WORDS,
  HAND_OFF_ID,
  CEILING,
  THREAD_ID,
  RUN_KEY,
  VIA,
  RAISED_ON,
  HANDS_OFF,
  approvedArg,
  goAhead,
  revisesArg,
  attachArg,
  attachable,
  jobFiles,
  planFiles,
  scheduleArg,
  missedArg,
  filesForHandOff,
  attachedForLead,
  hireFields,
  hireFrom,
  goalText,
  goalFields,
  server,
  tool,
  text,
  notHanded,
  notParked,
  json,
  shortDay,
  line,
  refused
};

// Narrowing does not cross a module boundary, so `me` leaves with the type the throw above proves.
const meChecked: NonNullable<typeof me> = me;
export { meChecked as me };
