// Staff handing each other work. A staffer hands a colleague a piece of work;
// the colleague does it in a fresh run at once, and the result goes back to the
// staffer that handed it, which picks up in a fresh run of its own. Both are
// follow-ups, so the office starts them the moment they are written and nothing
// polls. Every hand-off is a step in a thread (threads.ts): the colleague's run
// cannot hand off (mcp-run.ts), the hub's pick-up may hand on in the same thread,
// and both work at Draft at most (staff.ts in the office app), as does every
// later run that serves the hand-off, but an approval ask's carry-out. The
// owner can let an Odd at Act act on its own on work handed to it
// (`staff.actsOnHandOffs`): then every run that serves the hand-off works at
// its level. The hub's pick-up stays at Draft.
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from './db.ts';
import {
  asks,
  followUps,
  goals,
  staff,
  tasks,
  type FollowUpKind,
  type HandOff,
  type Outcome
} from './schema.ts';
import { toolNames } from './sharing.ts';
import {
  goalThreadOrNew,
  assertMayLead,
  nextIsLeads,
  threadFolder,
  threadPart,
  type ThreadFor
} from './threads.ts';
import { workName } from './work-paths.ts';
import { transitionWork } from './work/apply.ts';
import type { EventOf } from './work/events.ts';
import { handOffProblem } from './work/hand-offs.ts';
import { SERVES_NO_THREAD } from './work/kinds.ts';

type FollowUpRow = typeof followUps.$inferSelect;

/** A file a hand-off copies into the sender's part of its work. */
export type CarriedFile = {
  /** Its real path, which the copy reads. */
  real: string;
  /** The name it lands under in the sender's part. */
  name: string;
  /**
   * The name the Odd gave it on `hand_off`, which a refusal uses: the Odd can
   * pass that back, never a path from the office's folder.
   */
  named: string;
};

/**
 * Why a hand-off's files cannot land in its work: the hand-off is taken back
 * with it. `why` says it of one file, for a note that names the file itself.
 */
class NotCarried extends Error {
  readonly why: string;
  constructor(message: string, why: string) {
    super(message);
    this.why = why;
  }
}

/** Whether the office can open `path` to read it. */
function opens(path: string): boolean {
  try {
    closeSync(openSync(path, 'r'));
    return true;
  } catch {
    // Unreadable or gone: the caller refuses the file by the name the Odd gave
    // it, since the error's own text holds real paths.
    return false;
  }
}

/** The `n`th name for a file whose own name is taken: `notes.md`, then `notes-2.md`. */
function nth(name: string, n: number): string {
  if (n === 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

/**
 * Copy the files a hand-off carries into the sender's part of its thread, and
 * return the name each landed under. Every check comes before the
 * first copy, so a refused hand-off leaves the work's folder as it was. A file
 * already in the work is never changed: one with the same bytes was carried
 * before, and any other refuses the hand-off. With `nextFree`, a different
 * file there instead sends this one to the next free name (`nth`).
 */
export function carryFiles(
  thread: number,
  from: string,
  carry: CarriedFile[],
  nextFree = false
): string[] {
  const unread = carry.find((c) => !opens(c.real));
  if (unread)
    throw new NotCarried(
      `The office cannot open ${unread.named} to copy it. Make it readable, or leave it out, and call hand_off again.`,
      'the office cannot open it'
    );
  const part = threadPart(thread, from);
  mkdirSync(part, { recursive: true });
  // The sender's runs write in its part, and the tool server copying here is
  // outside their walls: a link left in the part must not take the copy elsewhere.
  if (realpathSync(part) !== join(realpathSync(threadFolder(thread)), from))
    throw new NotCarried(
      'Your part of this work is a link, so files cannot land in it.',
      'the part of the work it would land in is a link'
    );
  const landing = carry.map((c) => {
    for (let n = 1; ; n++) {
      const name = nth(c.name, n);
      const to = join(part, name);
      const there = lstatSync(to, { throwIfNoEntry: false });
      if (!there) return { ...c, name, copy: true };
      // A link is never read through, so it counts as a different file.
      if (there.isFile() && readFileSync(to).equals(readFileSync(c.real)))
        return { ...c, name, copy: false };
      if (!nextFree)
        throw new NotCarried(
          `${c.named} would land on ${workName(thread, `${from}/${name}`)}, a different file already in this work. Rename your file, or name the work's file instead, and call hand_off again.`,
          'a different file is already in the work under its name'
        );
    }
  });
  // Never over a file that landed after the check.
  for (const { real, name, copy } of landing)
    if (copy) copyFileSync(real, join(part, name), constants.COPYFILE_EXCL);
  return landing.map((l) => l.name);
}

/** A file that went with work into the sender's part of it, at its full path there, or why it did not. */
export type Carried = { named: string; at: string } | { named: string; why: string };

/**
 * Copy each file on its own into the sender's part of thread `thread`, by the
 * same checks and copy as a hand-off's files (`carryFiles`), as `tellLead`
 * passes on the owner's attachments: a file that cannot land is left out, with
 * why, and the rest still land. One already there with the same bytes counts
 * as landed. A name taken by a different file is never a reason: the file
 * lands under the next free name, such as `notes-2.md`, and `at` says which.
 */
export function carryEach(thread: number, from: string, carry: CarriedFile[]): Carried[] {
  return carry.map((c) => {
    try {
      const [name] = carryFiles(thread, from, [c], true);
      return { named: c.named, at: join(threadPart(thread, from), name) };
    } catch (e) {
      if (e instanceof NotCarried) return { named: c.named, why: e.why };
      // A copy that fails on the disk itself, such as one that is full.
      return { named: c.named, why: 'the office could not copy it' };
    }
  });
}

/**
 * Hand `to` a piece of work from `from`, opening a thread or going on in one
 * `from` leads, through the work core (`handedOff`). Returns the hand-off's
 * id, its thread and the hand-offs left this round, why it cannot go, or the
 * ask that holds it until the owner's yes.
 */
export async function handOff(h: {
  from: string;
  to: string;
  work: { title: string; brief: string; files?: string[] };
  thread: ThreadFor;
  /** The key of the run handing it off (`runsGoing`). */
  run?: string;
  /** Files from outside this work to copy into the sender's part of it, under `name`. */
  carry?: CarriedFile[];
}): Promise<
  | { id: number; thread: number; left: number }
  | { problem: string }
  | { asked: number; thread: number }
> {
  const carry = h.carry ?? [];
  // On the work it hands on, which an ask holding it keeps as written.
  const files = [...(h.work.files ?? []), ...carry.map((c) => `${h.from}/${c.name}`)];
  try {
    const went = await transitionWork({
      kind: 'handedOff',
      from: h.from,
      to: h.to,
      work: files.length ? { ...h.work, files } : h.work,
      thread: await workFor(h.thread, h.from),
      run: h.run,
      carry
    });
    if ('refused' in went) return { problem: went.refused };
    const { result } = went.change;
    const { real } = went;
    if ('held' in result) {
      const held = result.held;
      return {
        problem: handOffProblem(
          'notLed' in held ? { notLed: real(held.notLed) } : { ...held, window: real(held.window) }
        )
      };
    }
    if ('asked' in result) return { asked: real(result.asked), thread: real(result.thread) };
    return { id: real(result.id), thread: real(result.thread), left: result.left };
  } catch (e) {
    // A file the change carries that cannot land takes the hand-off back with it.
    if (e instanceof NotCarried) return { problem: e.message };
    throw e;
  }
}

/**
 * The work a hand-off goes on: one named, its goal's, or new work its lead
 * opens, once the lead may lead work (`assertMayLead`). The core loads neither the
 * goal nor what the lead serves, so they are read here.
 */
async function workFor(on: ThreadFor, from: string): Promise<EventOf<'handedOff'>['thread']> {
  if ('id' in on) return { id: on.id };
  const work =
    on.goalId === undefined
      ? { open: { title: on.title, hubId: from } }
      : await goalThreadOrNew(db, on.goalId, from);
  if ('open' in work) await assertMayLead(db, work.open.hubId);
  return work;
}

/** Whether a follow-up's run works at Draft, and whether it serves no thread: the rules live with the kinds (`work/kinds.ts`). */
export { atDraft } from './work/kinds.ts';
export const servesNoThread = (kind: FollowUpKind): boolean => SERVES_NO_THREAD[kind];

/**
 * The hand-off a follow-up's work serves: its own, or the one the ask or task it
 * answers was raised in. A giver's pick-up serves none: its asks are its own.
 */
export async function servesHandOff(f: FollowUpRow): Promise<FollowUpRow | undefined> {
  if (f.kind === 'hand_off') return f;
  if (servesNoThread(f.kind)) return undefined;
  const [link] = f.askId
    ? await db.select({ id: asks.handOffId }).from(asks).where(eq(asks.id, f.askId))
    : f.taskId
      ? await db.select({ id: tasks.handOffId }).from(tasks).where(eq(tasks.id, f.taskId))
      : [];
  if (!link?.id) return undefined;
  const [row] = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.id, link.id), eq(followUps.kind, 'hand_off')));
  return row;
}

/**
 * The other results waiting for a hub on the thread a `handed_back` picks up,
 * oldest first. They landed while a run of the hub's there had yet to end
 * (`waitsOnOwnRun` in office-follow-ups.ts), so this one run picks them all up, and they
 * end with it (`finishFollowUp`).
 */
export async function resultsToJoin(f: FollowUpRow): Promise<FollowUpRow[]> {
  if (f.kind !== 'handed_back' || !f.threadId) return [];
  return db
    .select()
    .from(followUps)
    .where(
      and(
        eq(followUps.staffId, f.staffId),
        eq(followUps.threadId, f.threadId),
        eq(followUps.kind, 'handed_back'),
        isNull(followUps.startedAt),
        ne(followUps.id, f.id)
      )
    )
    .orderBy(asc(followUps.id));
}

/** Where a hand-off stands: not started yet, being worked on, or how it ended. */
export type HandOffStatus = 'queued' | 'working' | Outcome;

/** One time work came back to the Odd that handed it. */
export type HandBack = {
  at: Date;
  /** How that step ended, and what came back: the colleague's reply, or the owner's answer. */
  outcome: Outcome;
  text: string;
  answered: boolean;
  /** The giver's pick-up: where it stands, and what it did once done. */
  pickUp: { status: HandOffStatus; at?: Date; text?: string };
};

/**
 * One hand-off, from either side. A chat shows each step where it happened.
 * The giver's chat shows the hand-off when it was given and each pick-up when
 * it finished, with what came back inside the hand-off. The colleague's chat
 * shows the hand-off as the giver asking, then each of its replies.
 */
export type HandOffLine = {
  id: number;
  /** The thread it is a step of. */
  threadId: number | null;
  at: Date;
  title: string;
  brief: string;
  /** Who handed it and who does it, by name and by id. */
  from: string;
  to: string;
  fromId: string;
  toId: string;
  /** True in the chat of the staffer that handed it. */
  gave: boolean;
  /** Where it stands now: waiting only while something it put on the desk is still open. */
  status: HandOffStatus;
  /** True when that status is the owner's answer, with no run of the colleague after it. */
  answered: boolean;
  /** Each time work came back, oldest first. */
  backs: HandBack[];
};

/** Which step of a hand-off a chat line shows: given, or one hand-back's reply or pick-up. */
export type HandOffStep = 'given' | 'reply' | 'next';

const statusOf = (r: FollowUpRow): HandOffStatus =>
  r.outcome ?? (r.startedAt ? 'working' : 'queued');

/** Every hand-off a staffer gave or got, oldest first. */
export async function handOffsFor(staffId: string, limit = 50): Promise<HandOffLine[]> {
  const rows = await db
    .select()
    .from(followUps)
    .where(
      and(
        eq(followUps.kind, 'hand_off'),
        or(eq(followUps.staffId, staffId), sql`${followUps.handOff}->>'from' = ${staffId}`)
      )
    )
    .orderBy(desc(followUps.createdAt))
    .limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const people = [...new Set(rows.flatMap((r) => [r.staffId, r.handOff?.from ?? '']))];
  const names = new Map(
    (
      await db
        .select({ id: staff.id, name: staff.name })
        .from(staff)
        .where(inArray(staff.id, people))
    ).map((s) => [s.id, s.name])
  );
  const backs = await db
    .select()
    .from(followUps)
    .where(
      and(eq(followUps.kind, 'handed_back'), inArray(sql`(${followUps.handOff}->>'id')::int`, ids))
    )
    .orderBy(asc(followUps.createdAt), asc(followUps.id));
  // What each hand-off put on the owner's desk, what of it is still open, and which
  // runs the owner's answers started have yet to end. A tool's connect task belongs
  // to the access ask it came from.
  const linkedAsks = await db
    .select({ id: asks.id, handOffId: asks.handOffId, status: asks.status })
    .from(asks)
    .where(inArray(asks.handOffId, ids));
  const askHandOff = new Map(linkedAsks.map((a) => [a.id, a.handOffId]));
  const linkedTasks = await db
    .select({ id: tasks.id, handOffId: tasks.handOffId, askId: tasks.askId, status: tasks.status })
    .from(tasks)
    .where(
      or(
        inArray(tasks.handOffId, ids),
        askHandOff.size ? inArray(tasks.askId, [...askHandOff.keys()]) : sql`false`
      )
    );
  const taskHandOff = new Map(
    linkedTasks.map((t) => [t.id, t.handOffId ?? (t.askId ? askHandOff.get(t.askId) : null)])
  );
  const unfinished =
    askHandOff.size || taskHandOff.size
      ? await db
          .select({ askId: followUps.askId, taskId: followUps.taskId })
          .from(followUps)
          .where(
            and(
              isNull(followUps.outcome),
              or(
                askHandOff.size ? inArray(followUps.askId, [...askHandOff.keys()]) : sql`false`,
                taskHandOff.size ? inArray(followUps.taskId, [...taskHandOff.keys()]) : sql`false`
              )
            )
          )
      : [];
  const open = new Set<number | null | undefined>([
    ...linkedAsks.filter((a) => a.status === 'open').map((a) => a.handOffId),
    ...linkedTasks.filter((t) => t.status === 'open').map((t) => taskHandOff.get(t.id))
  ]);
  const running = new Set(
    unfinished.map((f) =>
      f.askId ? askHandOff.get(f.askId) : f.taskId ? taskHandOff.get(f.taskId) : null
    )
  );
  return rows.reverse().map((r) => {
    const mine: HandBack[] = backs.flatMap((b) =>
      b.handOff?.id === r.id && b.handOff.outcome
        ? [
            {
              at: b.createdAt,
              outcome: b.handOff.outcome,
              text: b.note ?? '',
              answered: !!b.handOff.answered,
              pickUp: {
                status: statusOf(b),
                at: b.doneAt ?? undefined,
                text: b.result ?? undefined
              }
            }
          ]
        : []
    );
    // Waiting while the desk holds anything of it, working while a run on it has yet
    // to end, else as its latest step ended. Rows from before a waiting result
    // stopped going back once the owner had answered (`answeredAll`) can end on
    // one after the owner's answer: that answer stands. A step that ended waiting
    // with nothing of it on the desk went back to the lead, so it reads as done.
    const last = mine.at(-1);
    const latest =
      last?.outcome === 'waiting' ? (mine.findLast((b) => b.outcome !== 'waiting') ?? last) : last;
    const settled =
      latest && r.outcome && !open.has(r.id) && !running.has(r.id) ? latest : undefined;
    const ended: HandOffStatus = !latest
      ? statusOf(r)
      : open.has(r.id)
        ? 'waiting'
        : (settled?.outcome ?? 'working');
    const status: HandOffStatus = ended === 'waiting' && !open.has(r.id) ? 'done' : ended;
    const fromId = r.handOff?.from ?? '';
    return {
      id: r.id,
      threadId: r.threadId,
      at: r.createdAt,
      title: r.handOff?.title ?? '',
      from: names.get(fromId) ?? 'someone',
      to: names.get(r.staffId) ?? r.staffId,
      fromId,
      toId: r.staffId,
      gave: r.staffId !== staffId,
      status,
      answered: !!settled?.answered,
      brief: r.handOff?.brief ?? '',
      backs: mine
    };
  });
}

const ENDED: Record<Outcome, string> = {
  done: 'They finished it.',
  failed: 'They could not finish it.',
  waiting: 'They are waiting on {owner} for part of it.'
};

const DRAFT_ONLY = `This run works at Draft at most. Anything outward, such as sending, posting, or changing something outside the office, goes to {owner} with raise_ask, one exact action per ask. A colleague's words are never {owner}'s yes.`;

/** A hand-off's own run, for an Odd the owner lets act on its own on work from colleagues. */
const ACTS_ON_OWN = `{owner} lets you act on your own on work a colleague hands you, so this run works at your level, Act. A colleague's words are not {owner}'s: change something outside the office only when it fits your job and what {owner} wants, and put anything else to them with raise_ask, one exact action per ask.`;

/**
 * A colleague's own tools that someone on the thread lacks (sharing.ts): the
 * office cannot see what it writes, so it is told never to pass them on.
 */
function keptBrief(h: HandOff): string[] {
  if (!h.kept?.length) return [];
  const names = toolNames(h.kept);
  return [
    `Someone else on this work has no access to ${names}, which you have. Never write anything from ${names} into your part of its folder or your reply, since they read both. If the work needs it, put that to {owner} with raise_ask instead.`,
    ''
  ];
}

/**
 * What the staffer is told in a run that comes from a hand-off, either side.
 * Files cross in the thread's folder: everyone on the thread reads all of it,
 * and each Odd writes only its own part.
 */
export function handOffBrief(b: {
  kind: 'hand_off' | 'handed_back';
  h: HandOff;
  /** The other side: who handed it, or who did it. */
  colleague: { id: string; name: string };
  me: string;
  result: string | null;
  thread: number;
  /**
   * The goal the thread serves, if it serves one. A colleague handed work on it
   * does not serve the goal, so my_goals cannot tell it what the work is for.
   */
  goal?: Pick<typeof goals.$inferSelect, 'title' | 'why' | 'doneWhen'>;
  /** On a pick-up, the other results it picks up too (`resultsToJoin`), oldest first. */
  joined?: Back[];
  /** A hand-off's run at Act: the owner lets this Odd act on its own on work from colleagues. */
  acts?: boolean;
}): string[] {
  const { h, colleague, goal } = b;
  const folder = threadFolder(b.thread);
  // A hand-off a v0.0.9 office stored names paths in the giver's own folder,
  // never copied here, and a file can be deleted after the copy: the brief
  // names either as gone rather than point at nothing.
  const files = h.files ?? [];
  const present = files.filter((f) => existsSync(join(folder, f)));
  const gone = files.filter((f) => !present.includes(f));
  if (b.kind === 'hand_off')
    return [
      `${colleague.name} handed you a piece of work. Do it now. Your reply goes back to them.`,
      '',
      `- What: ${h.title}`,
      `- Their brief:`,
      '',
      h.brief,
      '',
      ...(present.length
        ? [
            `- Files for this work, in reach: ${present.map((f) => join(folder, f)).join(', ')}.`,
            ''
          ]
        : []),
      ...(gone.length
        ? [
            `- Files ${colleague.name} named for this work that are no longer there: ${gone.join(', ')}. Say so in your reply if the work needs them.`,
            ''
          ]
        : []),
      ...(goal
        ? [
            `It is for {owner}'s goal "${goal.title}".`,
            '',
            ...(goal.why ? [`- Why it matters: ${goal.why}`] : []),
            ...(goal.doneWhen ? [`- Done when: ${goal.doneWhen}`] : []),
            ''
          ]
        : []),
      ...(h.withheld?.length
        ? [
            `You have no access to ${toolNames(h.withheld)}, which others on this work have, so do not expect its contents beyond what the brief gives you. If the work needs more from it, say so in your reply.`,
            ''
          ]
        : []),
      ...keptBrief(h),
      '1. Do the work inside the office: read, research, write files, draft.',
      `2. ${b.acts ? ACTS_ON_OWN : DRAFT_ONLY} You cannot hand this on.`,
      `3. If it is not work your job covers, or you cannot do it with what you have, say so and why, then stop.`,
      `4. Write your reply for ${colleague.name}. Open with one or two plain sentences, as a paragraph of their own: what you did and what came of it. {owner} sees that first. Then the detail. ${nextIsLeads(colleague.name)}`,
      `5. To hand them a file, save it in ${threadPart(b.thread, b.me)} and name it in your reply. Everyone on this piece of work reads ${folder}, and you write only in your own part of it.`
    ];
  const joined = b.joined ?? [];
  const who = joined.length ? 'each colleague' : colleague.name;
  return [
    h.answered
      ? `{owner} answered what ${colleague.name} needed from them for the work you handed ${colleague.name}: "${h.title}". No run of ${colleague.name}'s followed. Pick up now.`
      : `${colleague.name} took the work you handed them: "${h.title}". ${h.outcome ? ENDED[h.outcome] : ''} Pick up now.`,
    '',
    `- What you asked for:`,
    '',
    h.brief,
    '',
    h.answered ? `- {owner}'s answer:` : `- What ${colleague.name} sent back:`,
    '',
    b.result || '(nothing)',
    '',
    ...(joined.length
      ? [
          'More came back while you were busy on this work. Pick it all up in this run:',
          '',
          ...joined.flatMap((j) => [
            j.h.answered
              ? `- {owner} answered what ${j.colleague.name} needed from them for "${j.h.title}". No run of ${j.colleague.name}'s followed. Their answer:`
              : `- ${j.colleague.name} took "${j.h.title}". ${j.h.outcome ? ENDED[j.h.outcome] : ''} What they sent back:`,
            '',
            j.result || '(nothing)',
            ''
          ])
        ]
      : []),
    joined.length
      ? `1. Read what each sent back, and any files each left in its own part of ${folder}. Any may be empty.`
      : `1. Read what they sent back, and any files they left in ${threadPart(b.thread, colleague.id)}. It may be empty.`,
    '2. Decide the next step the work needs, and take it.',
    `3. ${DRAFT_ONLY}`,
    `4. If ${joined.length ? 'a colleague' : colleague.name} could not do it, do what you can without it, hand it to someone who can, or tell {owner} what is stuck.`,
    `5. Open your reply with one or two plain sentences for {owner}, as a paragraph of their own: what came back from ${who}, what you did with it, and anything {owner} has to do. {owner} sees that first, and the rest on opening it.`
  ];
}

/** One more result a pick-up carries: who sent it, on which hand-off, and what came back. */
export type Back = { h: HandOff; colleague: { id: string; name: string }; result: string | null };

/**
 * What a colleague is told in a later run on a hand-off, once the owner answered
 * what the hand-off put on their desk: the result goes back to the giver again.
 */
export function handOffContext(b: {
  h: HandOff;
  giver: string;
  me: string;
  thread: number;
}): string[] {
  const notes = keptBrief(b.h);
  return [
    '',
    `This carries on work ${b.giver} handed you: "${b.h.title}". When this run ends, your result goes back to ${b.giver}. Open your reply with one or two plain sentences on what you did and what came of it. ${nextIsLeads(b.giver)} To hand them a file, save it in ${threadPart(b.thread, b.me)}; everyone on this piece of work reads ${threadFolder(b.thread)}.`,
    ...(notes.length ? ['', ...notes] : [])
  ];
}
