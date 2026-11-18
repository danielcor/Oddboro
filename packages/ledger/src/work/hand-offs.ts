// Work passing between Odds: a lead hands a piece of its work to a colleague,
// and a colleague tells the work's lead what the owner said in chat. Each
// decider mirrors the database code it replaces, named on each, and takes
// every fact from the loaded rows.
//
// Pure: every import that reaches the database is a type.
import { AGENT_NAMES } from '../agents.ts';
import { flat } from '../desk-answers.ts';
import { fixedError } from '../errors.ts';
import type { Carried } from '../hand-offs.ts';
import type { HeldHandOff } from '../schema.ts';
import { clockTime } from '../time.ts';
import type { After, Decided } from '../transition.ts';
import { answerLead } from './answers.ts';
import { askRaised } from './asks.ts';
import type { EventOf, HandOffHeld, NewAsk, WorkResults } from './events.ts';
import {
  changeOf,
  draft,
  foldIn,
  putAll,
  type Change,
  type Draft,
  type Inserted,
  type Odd,
  type WorkRows
} from './snapshot.ts';
import type { Thread } from './state.ts';
import { handOn, hasLeft, holdForWindow, idOf, openThread } from './threads.ts';

/**
 * The hand-offs a round of work takes before the office asks the owner whether
 * it keeps going (`keepGoingAsk`). The one finished round in the trial
 * offices took 6: plan, build, review, a fix and a check, and one more.
 */
export const HAND_OFF_LIMIT = 8;
/** The share of the Claude plan's 5-hour window past which new hand-offs to Odds on it wait. */
const WINDOW_GUARD = 0.85;
const percent = (share: number) => `${Math.round(share * 100)}%`;
/** A copy of the list `toolNames` in ../sharing.ts formats with, since that file loads the database. */
const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * What the Odd handing off is told when its hand-off did not go, once the
 * work's number is known.
 */
export function handOffProblem(p: HandOffHeld<number>): string {
  if ('notLed' in p)
    return `Work ${p.notLed} is not work you lead. Hand off on work you lead, or start new work.`;
  return `The office holds new hand-offs: the Claude plan's usage window is at ${percent(p.share)}. Work ${p.window} picks back up when the window resets at ${p.at}, or sooner if the owner lets hand-offs run. Say so, and finish this run.`;
}

type HandedOff = WorkResults['handedOff'];

/**
 * A lead hands a colleague a piece of work, through `handOff` in
 * ../hand-offs.ts: on work it leads, or on new work it opens. Nobody who left
 * the office hands work on or takes it, and work that stopped, or waits on the
 * owner's answer to going on, takes none. Taken or held, the work keeps the key
 * of the run handing it on. Past the usage window's guard the work waits for
 * the reset, and the change still commits; once a round has taken
 * `HAND_OFF_LIMIT`, one ask holds the hand-off until the owner's yes. The files
 * it carries are copied into the sender's part of the work in the same change,
 * taken or asked, so a copy that fails takes the hand-off back with it.
 */
export function handedOff(
  rows: WorkRows,
  e: EventOf<'handedOff'>,
  now: Date
): Decided<Change<HandedOff>> {
  if (e.to === e.from)
    return {
      refused: 'You cannot hand work to yourself. Do it in this run, or hand it to a colleague.'
    };
  const to = rows.staff.get(e.to);
  if (!to || to.leftAt)
    return { refused: `Nobody called "${e.to}" works here. Use a colleague's id from the list.` };
  // The office stops the runs of an Odd that leaves; this is a call that landed as it left.
  if (hasLeft(rows, e.from)) return { refused: 'You left the office, so you hand nothing on.' };
  const d = draft(rows);
  if ('open' in e.thread && e.thread.open.hubId !== e.from) {
    // A goal's new work opens under its lead even though this hand-off does not go, as today.
    const thread = openThread(d, e.thread.open, [], now);
    return { change: changeOf(d, { held: { notLed: thread } }), after: [] };
  }
  if ('id' in e.thread) {
    const refused = goesOnRefused(rows, e.thread.id, e.from);
    if (refused) return { refused };
  }

  // From here the sender leads the work.
  const after: After[] = [];
  // A new window ask goes in before the work it holds, which points at it.
  const held = windowHolds(d, { to, lead: e.from }, after, now);
  const thread =
    'id' in e.thread ? e.thread.id : openThread(d, e.thread.open, e.run ? [e.run] : [], now);
  const threadId = typeof thread === 'number' ? thread : idOf(d, thread);
  if (typeof thread === 'number') keepRun(d, thread, e.run);
  if (held) {
    holdForWindow(d, { threadId, at: held.resetsAt, ask: held.by }, now);
    return {
      change: changeOf(d, { held: { window: thread, share: held.share, at: held.at } }),
      after
    };
  }

  const t = d.rows.threads.get(threadId);
  if (!t) throw fixedError('A hand-off went on work the rows do not hold.');
  // Finished work being continued starts a new round.
  const used = t.status === 'open' ? t.handOffsUsed : 0;
  if (e.carry.length)
    d.outside.push({ kind: 'carryFiles', threadId: thread, from: e.from, files: e.carry });
  if (used >= HAND_OFF_LIMIT) {
    const asked = raise(
      d,
      keepGoingAsk(rows, t, { from: e.from, to: e.to, ...e.work }),
      'keep going',
      after,
      now
    );
    return { change: changeOf(d, { asked, thread }), after };
  }
  const sharing = rows.prepared.sharing;
  if (!sharing) throw fixedError('A hand-off was taken with what it carries not prepared.');
  const id = handOn(d, { threadId, to: e.to, handOff: sharing, used: used + 1 }, now);
  return { change: changeOf(d, { id, thread, left: HAND_OFF_LIMIT - (used + 1) }), after };
}

/** Why a hand-off cannot go on work already open or ended, which writes nothing. */
function goesOnRefused(rows: WorkRows, id: number, from: string): string | undefined {
  const t = rows.threads.get(id);
  if (t?.hubId !== from) return handOffProblem({ notLed: id });
  if (t.status === 'stopped')
    return `Work ${id} has ended (${t.status}). Nothing more runs on it. Tell the owner so.`;
  const asked = [...rows.asks.values()]
    .filter((a) => a.threadId === id && a.kind === 'hand_offs' && a.status === 'open')
    .sort((a, b) => a.id - b.id)[0];
  if (asked)
    return `Work ${id} waits on the owner's answer to ask #${asked.id} about going on, and holds the hand-off that raised it, which goes ahead on their yes. This one did not go: once the held one comes back, hand it on again if it is still needed. Finish this run; their answer brings you back.`;
  return undefined;
}

/** The lead's run handing work on keeps its key on the work, last. */
function keepRun(d: Draft, threadId: number, run: string | undefined): void {
  const t = d.rows.threads.get(threadId);
  if (!run || !t) return;
  putAll(d, [{ table: 'threads', row: { ...t, runs: [...t.runs.filter((k) => k !== run), run] } }]);
}

/**
 * Whether a hand-off to `to` waits for the usage window: only for an Odd on
 * Claude Code, past the guard, with a reset still ahead, and when the owner
 * has not let hand-offs run in this window. `ask` is this window's ask, when one was raised.
 */
function windowHold(
  rows: WorkRows,
  to: Odd,
  now: Date
): { resetsAt: Date; at: string; share: number; ask: number | undefined } | undefined {
  const w = rows.window;
  if (to.agent !== 'claude' || !w?.resetsAt || w.resetsAt <= now || w.share < WINDOW_GUARD)
    return undefined;
  if (w.ask?.status === 'approved') return undefined;
  return { resetsAt: w.resetsAt, at: clockTime(w.resetsAt, now), share: w.share, ask: w.ask?.id };
}

/**
 * Whether a hand-off from `lead` to `to` waits for the usage window
 * (`windowHold`), and the ask it waits under: this window's, or one raised
 * now into this change, its after-steps into `after`. Every start of a
 * hand-off asks this: a new one (`handedOff`) and a held one the owner said
 * yes to (`start_held` in ./asks.ts).
 */
export function windowHolds(
  d: Draft,
  h: { to: Odd; lead: string },
  after: After[],
  now: Date
): { resetsAt: Date; at: string; share: number; by: number | Inserted } | undefined {
  const hold = windowHold(d.rows, h.to, now);
  if (!hold) return undefined;
  const { ask, ...rest } = hold;
  return {
    ...rest,
    by: ask ?? raise(d, windowAsk(d.rows, h.lead, hold.share, hold.at), 'window', after, now)
  };
}

/**
 * The office's one ask for this window. It is office-wide, so it is filed under
 * the manager, who runs the floor, else under the lead that hit the guard. Its
 * why names the Odds on Claude Code when the office has Odds on other tools.
 */
function windowAsk(rows: WorkRows, leadId: string, share: number, at: string): NewAsk {
  const odds = [...rows.staff.values()]
    .filter((o) => !o.leftAt)
    .sort((a, b) => a.name.localeCompare(b.name));
  const onClaude = odds.filter((o) => o.agent === 'claude').map((o) => o.name);
  const guard = `Past ${percent(WINDOW_GUARD)} of it, the office pauses work`;
  const why =
    onClaude.length === odds.length
      ? `Every Odd runs on your Claude plan, so they all share its 5-hour window. ${guard} Odds pass to each other so the window lasts. Runs already going carry on.`
      : `The Odds on ${AGENT_NAMES.claude} share your Claude plan's 5-hour window: ${list.format(onClaude)}. ${guard} handed to them so the window lasts. Work for Odds on other tools, and runs already going, carry on.`;
  const manager = odds.find((o) => o.manager);
  return {
    staffId: manager?.id ?? leadId,
    kind: 'window',
    title: `Your Claude plan's 5-hour window is ${percent(share)} used. Pause work Odds pass to each other until it resets at ${at}, or let it carry on?`,
    why,
    ifApproved: `Work on hold picks back up now, and Odds pass work on until the window resets at ${at}. If you say no, it stays on hold and picks back up when it resets.`
  };
}

/**
 * The ask that holds a hand-off past the round's limit. The owner reads the
 * work by its title: no thread, no number, no hand-off count.
 */
function keepGoingAsk(rows: WorkRows, t: Thread, held: HeldHandOff): NewAsk {
  const hub = nameOf(rows, t.hubId);
  const to = nameOf(rows, held.to);
  return {
    staffId: t.hubId,
    kind: 'hand_offs',
    threadId: t.id,
    held,
    title: `${hub} needs a few more steps to finish ${t.title}. Go ahead?`,
    why: `${hub} has handed on as many pieces of ${t.title} as the office lets work go without asking you.`,
    ifApproved: `${to} starts on "${held.title}" now, as ${hub} asked. If you say no, ${t.title} stops.`
  };
}

function nameOf(rows: WorkRows, id: string): string {
  const odd = rows.staff.get(id);
  if (!odd) throw fixedError('A hand-off named an Odd the rows do not hold.');
  return odd.name;
}

/** Raises the office's own ask through `askRaised`, into this change under `tag`, and gives the new ask's ref. */
function raise(d: Draft, ask: NewAsk, tag: string, after: After[], now: Date): Inserted {
  const raised = askRaised(d.rows, { kind: 'askRaised', ask }, now);
  if ('refused' in raised) throw fixedError('The office could not raise its own ask.');
  const put = raised.change.put.find((p) => p.table === 'asks' && 'ref' in p);
  if (!put || !('ref' in put))
    throw fixedError('The office raised an ask that went in as no new row.');
  foldIn(d, raised.change, tag);
  after.push(...raised.after);
  // `foldIn` names each ref it takes in under its tag.
  return { ref: `${tag} ${put.ref}` };
}

/**
 * A colleague passes the owner's words about work it is on to that work's
 * lead, as `tellLead` in ../threads.ts does: the lead picks the work back up
 * with them, joining a pick-up of its still queued. `words` must be in what
 * the owner said, so only the owner's own words reach the lead as theirs.
 * Not to work the Odd leads, is not on, that stopped, or whose lead left.
 *
 * The entry copies the owner's attachments first, as `carryEach` does, and
 * the event carries what came of each: the note names where each landed and
 * why each other did not come. A file that cannot land never stops the words.
 */
export function toldLead(
  rows: WorkRows,
  e: EventOf<'toldLead'>,
  now: Date
): Decided<Change<WorkResults['toldLead']>> {
  const owner = rows.owner;
  const id = e.threadId;
  const words = flat(e.words);
  if (!words || !flat(e.said).includes(words))
    return {
      refused: `Pass ${owner}'s own words in words, copied exactly from their message. Your own go in your reply to them.`
    };
  // The whole note stays on one line: the brief reads each line as its own answer.
  const reading = flat(e.reading);
  if (!reading)
    return {
      refused: `Say in reading what you understood ${owner} to mean, in your own words. Nothing was passed on.`
    };
  const t = rows.threads.get(id);
  const lead = t && rows.staff.get(t.hubId);
  if (!t || !lead) return { refused: `There is no work ${id}.` };
  if (lead.id === e.staffId)
    return { refused: `You lead work ${id}, so there is no lead to tell: it is yours.` };
  if (!e.worksOn.has(id))
    return {
      refused: `Work ${id} is not work you are on, so it is not yours to pass on. Tell ${owner} so.`
    };
  if (t.status === 'stopped')
    return { refused: `Work ${id} has stopped, so nothing more runs on it. Tell ${owner} so.` };
  // Its lead's leaving stops the work; this is a call that landed as the lead left.
  if (lead.leftAt)
    return {
      refused: `${lead.name} left the office, so work ${id} has no lead to tell. Tell ${owner} so.`
    };

  const name = rows.staff.get(e.staffId)?.name ?? e.staffId;
  const files = e.files;
  const d = draft(rows);
  // A lead once read this as the colleague taking it on, and sent no work.
  const note = `${name} passed you what ${owner} told them in chat about this work. You decide what comes of it and hand on any work it needs; ${name} does nothing more with it. ${owner}'s words: ${words} ${name}'s own reading, which is not ${owner}'s words: ${reading}${e.exchange ? ` ${e.exchange}` : ''}${attachedLine(files, owner)}`;
  answerLead(d, id, note, {}, now);
  return { change: changeOf(d, { lead: lead.name, ...(files.length && { files }) }), after: [] };
}

/** What the lead's note says of the files the owner attached: where each landed, and which did not come and why. */
function attachedLine(files: Carried[], owner: string): string {
  const landed = files.flatMap((f) => ('at' in f ? [`${flat(f.named)} at ${f.at}`] : []));
  const left = files.flatMap((f) => ('why' in f ? [`${flat(f.named)}, since ${f.why}`] : []));
  return [
    landed.length
      ? ` ${owner} attached ${landed.length === 1 ? 'a file' : `${landed.length} files`} to that message, now in this work: ${landed.join('; ')}.`
      : '',
    left.length
      ? ` ${left.length === 1 ? 'One file' : `${left.length} files`} ${owner} attached did not come: ${left.join('; ')}.`
      : ''
  ].join('');
}
