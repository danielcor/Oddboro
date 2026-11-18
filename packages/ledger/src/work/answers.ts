// How an answer reaches a lead's work, as steps a decider takes on its
// `Draft`: the owner's answer or a task's end joins the lead's waiting pick-up
// or starts one, goes back to a hand-off, or reaches the Odd that raised it on
// no work, and parked work wakes as its task ends. The deciders that use them
// are in asks.ts and tasks.ts.
//
// Pure: every import that reaches the database is a type.
import { switchesSaid, type OwnSwitch } from '../access-words.ts';
import {
  flat,
  OWN_RUN,
  OWNER_ANSWERS,
  type AskAnswer,
  type AskEffect,
  type TaskEffect
} from '../desk-answers.ts';
import { filterWords, type GmailFilter } from '../filter-words.ts';
import type { Decision } from '../office-asks.ts';
import {
  chatCardOf,
  type AskKind,
  type HeldCall,
  type InChat,
  type Outcome,
  type ReplyDraft
} from '../schema.ts';
import type { TaskEnded } from '../task-parking.ts';
import type { Decided } from '../transition.ts';
import { changeOf, draft, putAll, type Change, type Draft, type WorkRows } from './snapshot.ts';
import { askRow, type Ask, type Task, type Thread } from './state.ts';
import { addRun, handBack, hasLeft, isHandOff, newRun, oweRun } from './threads.ts';
import { carriedOutBy, sameWanted, TWINNED } from './twins.ts';

/**
 * The owner's answer, or a task's end, reaches the lead of a thread: it joins the lead's oldest `resume` there still
 * queued, a line each, so several answers landing together wake it once, or
 * it starts one. Only a queued row is joined: one an Odd's leaving ended
 * never starts, so a line joined to it would never be read. Nothing when the
 * lead left the office, since it runs nothing. With no line, as when the time
 * a lead parked its work until comes, a waiting pick-up is enough as it is.
 */
export function answerLead(
  d: Draft,
  threadId: number,
  line: string | null,
  o: { askId?: number; chat?: InChat },
  now: Date
): void {
  const t = d.rows.threads.get(threadId);
  const lead = t && d.rows.staff.get(t.hubId);
  if (!lead || lead.leftAt) return;
  // Answered in the lead's own chat: the pick-up replies there, under the newest card answered.
  const chatCard = chatCardOf(lead.id, o.chat);
  const waiting = [...d.rows.followUps.values()]
    .filter(
      (f) =>
        f.staffId === lead.id &&
        f.threadId === threadId &&
        f.kind === 'resume' &&
        f.run.is === 'queued'
    )
    .sort((a, b) => a.id - b.id)[0];
  if (waiting) {
    if (line === null) return;
    const note = waiting.note ? `${waiting.note}\n${line}` : line;
    putAll(d, [{ table: 'followUps', row: { ...waiting, note, ...(chatCard && { chatCard }) } }]);
    return;
  }
  addRun(
    d,
    newRun(
      {
        staffId: lead.id,
        kind: 'resume',
        threadId,
        note: line,
        askId: o.askId ?? null,
        chatCard: chatCard ?? null
      },
      now
    ),
    now
  );
}

type OpenThread = Extract<Thread, { status: 'open' }>;

/** A run on an ended task's own work that parked work hears of: the title of that work, or null for a task on no work. */
export type OwnRun = { work: string | null; earlier?: true };

/**
 * The task ended: every open thread parked on it picks up, with what
 * happened. `ownRun` is there when a run on the task's
 * own work picks up too, so each parked thread is told that run carries its
 * own part; `earlier` when that run was set going as the task ended, before
 * this wake. A stopped thread lost its park, so it wakes for nothing.
 */
export function wakeParked(
  d: Draft,
  task: Task,
  how: { ended: TaskEnded; ownRun?: OwnRun },
  now: Date
): void {
  const parked = [...d.rows.threads.values()]
    .filter(
      (t): t is OpenThread => t.status === 'open' && t.park.on === 'task' && t.park.task === task.id
    )
    .sort((a, b) => a.id - b.id);
  putAll(
    d,
    parked.map((t) => ({ table: 'threads', row: { ...t, park: { on: 'none' } } }) as const)
  );
  const owner = d.rows.owner;
  const title = flat(task.title);
  const note = flat(task.note ?? '');
  const ended = {
    done: `${owner} finished "${title}", the task you parked this work on.`,
    dropped: `${owner} dropped "${title}", the task you parked this work on, so it will not be finished.`,
    withdrawn: `"${title}", the task you parked this work on, was taken off ${owner}'s desk, so it will not be finished.`
  }[how.ended];
  // A task on no work can be parked on only by the Odd that gave it
  // (`parkOnTask`), so its own run is this Odd's.
  const run = how.ownRun;
  const own = !run
    ? ''
    : run.work === null
      ? run.earlier
        ? " Another run of yours was set going when the task ended and carries its own part: do only this work's part here."
        : " Another run of yours picks up from that task too and carries its own part: do only this work's here."
      : run.earlier
        ? ` A run on "${flat(run.work)}", the work that task was given on, was set going when the task ended, and its lead carries that work's own part: do only this work's part here.`
        : ` "${flat(run.work)}", the work that task was given on, picks up too, and its lead carries that work's own part: do only this work's here.`;
  const next = how.ended === 'done' ? 'Pick it up now' : 'Decide what comes of the work now';
  const said = `${ended}${own} ${next}`;
  for (const t of parked) answerLead(d, t.id, note ? `${said}: ${note}` : `${said}.`, {}, now);
}

/**
 * What an ended task starts (`OWNER_ANSWERS`): the access ask a tool's
 * connect task came from, the effects of how it ended, and where the owner's
 * answer goes back (`answer_back`): `on` the hand-off or work it is on, its own
 * or its ask's, else to `offWorkOdd`, the Odd that gave it, unless that Odd
 * took it off the desk. `taskEnded` and `ownRunOf` both read it, so parked
 * work hears of the same run that starts.
 */
export function taskEffects(
  rows: WorkRows,
  t: Task
): {
  from: Ask | undefined;
  effects: readonly TaskEffect[];
  on: { handOffId: number | null; threadId: number | null };
  offWorkOdd: string | null;
} {
  // A tool's connect task belongs to the access ask it came from.
  const from = t.askId === null ? undefined : rows.asks.get(t.askId);
  const effects: readonly TaskEffect[] =
    t.status !== 'done'
      ? OWNER_ANSWERS.task.dropped
      : !t.staffId
        ? OWNER_ANSWERS.task.done.noOdd
        : from?.kind === 'access'
          ? OWNER_ANSWERS.task.done.fromAccess
          : OWNER_ANSWERS.task.done.other;
  const on = {
    handOffId: t.handOffId ?? from?.handOffId ?? null,
    threadId: t.threadId ?? from?.threadId ?? null
  };
  const offWorkOdd =
    on.handOffId === null && on.threadId === null && !(t.status === 'dropped' && t.withdrawn)
      ? t.staffId
      : null;
  return { from, effects, on, offWorkOdd };
}

/**
 * The other asks the owner's one answer settled with `a`, as `answeredWith`
 * in office-asks.ts finds them: the same Odd, kind and tool or folder,
 * decided in the same moment the same way.
 */
export function answeredWith(rows: WorkRows, a: Ask): Ask[] {
  if (!TWINNED.includes(a.kind) || a.status === 'open') return [];
  return [...rows.asks.values()]
    .filter(
      (r) =>
        r.id !== a.id &&
        r.staffId === a.staffId &&
        r.kind === a.kind &&
        r.status !== 'open' &&
        r.status === a.status &&
        r.decidedAt.getTime() === a.decidedAt.getTime() &&
        sameWanted(askRow(a), askRow(r))
    )
    .sort((x, y) => x.id - y.id);
}

/**
 * The run of an ended task's own, on its work or for its Odd, that
 * `wakeParked` tells parked work of, if one picks up: whether the task's end
 * starts one (`OWN_RUN`), and never on stopped work or work whose lead left
 * the office, which runs nothing.
 */
export function ownRunOf(rows: WorkRows, t: Task): OwnRun | undefined {
  const { from, effects, on, offWorkOdd } = taskEffects(rows, t);
  if (t.status === 'done' && from?.access?.connectOnly) {
    // Other work parked on this task must only be told of a run that will actually start.
    const doing = carriedOutBy(answeredWith(rows, from).map(askRow));
    if (!doing.some((a) => a.threadId === on.threadId && a.handOffId === on.handOffId))
      return undefined;
  }
  const ownRuns = effects.some(
    (e) =>
      OWN_RUN[e] === 'always' ||
      (OWN_RUN[e] === 'on its work, else its Odd' && (on.threadId !== null || offWorkOdd !== null))
  );
  if (!ownRuns) return undefined;
  const own = on.threadId === null ? undefined : rows.threads.get(on.threadId);
  // Its lead leaving stopped the work, so a lead brought back since still reads as gone.
  if (own && (own.status === 'stopped' || rows.staff.get(own.hubId)?.leftAt !== null))
    return undefined;
  return { work: own?.title ?? null };
}

/** The owner's words on an ended task: the response they saved when they finished it, then their note. */
export const taskAnswer = (t: Task): string | null =>
  [t.status === 'done' && t.responseVersion ? t.response : null, t.note]
    .filter(Boolean)
    .join('\n\n') || null;

/** What a made call returned, cut to fit a ledger line or a brief. */
export const callResultText = (r: NonNullable<HeldCall['result']>, max = 4000): string =>
  `${r.ok ? '' : 'The tool said it failed: '}${r.text.length > max ? `${r.text.slice(0, max)}…` : r.text}`;

/** A created filter in one line, for its ledger line and the answer: what it does, and what was tidied. */
export const filterDone = (f: GmailFilter) =>
  `${filterWords(f)}${f.created?.tidied ? `, and tidied ${f.created.tidied} ${f.created.tidied === 1 ? 'email' : 'emails'}` : ''}`;

/** What a reply ask's ledger line and answer say the owner did with it. */
export const replyDone = (r: ReplyDraft) =>
  r.sent?.action === 'draft' ? 'Saved to Gmail drafts' : 'Sent';

/** What the owner's decision on an ask of this kind does, from its row in `OWNER_ANSWERS`. */
export function effectsOf(kind: AskKind, decision: Decision): readonly AskEffect[] {
  const cell = (OWNER_ANSWERS.ask[kind] as AskAnswer)[decision];
  return cell === 'refused' ? [] : 'by' in cell ? cell.then : cell;
}

/** The ledger's words for turning switches on: "Let Theo run commands and browse the web". */
export const turnedOn = (name: string, on: readonly OwnSwitch[]) =>
  `Let ${name} ${switchesSaid(on).toLowerCase()}`;

/** The refusal when the ask or task was answered already. The entry returns false for it, as a claim that found nothing open does today. */
export const ANSWERED_ALREADY = 'That was answered already.';

/**
 * No run carries the answer out: it goes back to the hand-off or thread it
 * was raised on. A colleague's goes to the lead that
 * handed it the work, as the owner's own answer; a lead's starts or joins its
 * pick-up there. False when it was raised on neither.
 */
export function answerBack(
  d: Draft,
  on: { handOffId: number | null; threadId: number | null; askId?: number },
  back: { outcome: Outcome; answer: string; chat?: InChat },
  now: Date
): boolean {
  if (on.handOffId) {
    const origin = d.rows.followUps.get(on.handOffId);
    if (isHandOff(origin))
      handBack(d, origin, { outcome: back.outcome, result: back.answer, answered: true }, now);
    return true;
  }
  if (!on.threadId) return false;
  answerLead(d, on.threadId, back.answer, { askId: on.askId, chat: back.chat }, now);
  return true;
}

/**
 * The answer to something raised on no work reaches the Odd that raised it,
 * once, as a line in an `answered` run (NEW-1715, NEW-1703). Like a lead's
 * pick-up (`answerLead`), it joins that Odd's oldest `answered` run on no
 * work still queued, so many answers wake it once, or it starts one. `ids`
 * are the items the answer settled on no work, the asked one and its twins:
 * a new row carries them all, with the asked item's id when it is among
 * them, else the lowest, and the chat card only when it carries the asked
 * item. A joined row takes the newest card answered. None when that Odd
 * left, or when this change already starts a run of that Odd for one of
 * them, such as the `denied` run that tells it the no and why.
 */
export function offWorkAnswer(
  d: Draft,
  a: {
    staffId: string;
    item: 'ask' | 'task';
    ids: number[];
    asked: number;
    line: string;
    chat?: InChat;
  },
  now: Date
): void {
  if (!a.ids.length || hasLeft(d.rows, a.staffId)) return;
  const started = [...d.rows.followUps.values()].some((f) => {
    const item = a.item === 'ask' ? f.askId : f.taskId;
    return (
      !d.loaded.followUps.has(f.id) &&
      f.staffId === a.staffId &&
      item !== null &&
      a.ids.includes(item)
    );
  });
  if (started) return;
  const id = a.ids.includes(a.asked) ? a.asked : Math.min(...a.ids);
  const chat = id === a.asked ? a.chat : undefined;
  const waiting = [...d.rows.followUps.values()]
    .filter(
      (f) =>
        f.staffId === a.staffId &&
        f.kind === 'answered' &&
        f.threadId === null &&
        f.run.is === 'queued'
    )
    .sort((p, q) => p.id - q.id)[0];
  if (waiting) {
    const chatCard = chatCardOf(a.staffId, chat);
    const note = waiting.note ? `${waiting.note}\n${a.line}` : a.line;
    putAll(d, [{ table: 'followUps', row: { ...waiting, note, ...(chatCard && { chatCard }) } }]);
    return;
  }
  oweRun(
    d,
    {
      staffId: a.staffId,
      kind: 'answered',
      note: a.line,
      ...(a.item === 'ask' ? { askId: id } : { taskId: id })
    },
    { chat },
    now
  );
}

/**
 * The carry-outs for asks one answer settled, one for each place a result
 * goes back to (`carriedOutBy`), as `carryOutTogether` starts them. The chat
 * card goes only to the run of the ask the owner answered in chat.
 */
export function startCarryOuts(
  d: Draft,
  together: readonly Ask[],
  o: { pickedUp?: string[]; chat?: InChat },
  now: Date
): void {
  for (const a of carriedOutBy(together.map(askRow)))
    oweRun(
      d,
      { staffId: a.staffId, kind: 'carry_out', askId: a.id, note: null, pickedUp: o.pickedUp },
      { chat: o.chat?.card.id === a.id ? o.chat : undefined },
      now
    );
}

/**
 * A goal's change of status, as `updateGoal` in goals.ts makes it: it
 * decides nothing, since every status tells its Odds nothing yet
 * (`GOAL_ANSWERS`, all `none`). The goal row and its line stay in `updateGoal`.
 */
export function goalStatusChanged(rows: WorkRows): Decided<Change<null>> {
  return { change: changeOf(draft(rows), null), after: [] };
}
