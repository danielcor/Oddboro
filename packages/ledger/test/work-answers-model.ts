// The sequence test's model of asks and tasks (work-sequences.test.ts): what
// raising, giving, answering and ending them do, from the events alone. Pure:
// no database.
import type { Decision } from '../src/office-asks.ts';
import type { AskKind, AskStatus, HeldCall, Outcome, ReplyDraft } from '../src/schema.ts';
import type { GmailFilter } from '../src/filter-words.ts';
import type { AskDone, EventOf, LiveKind, NewAsk, NewTask } from '../src/work/events.ts';
import { SERVES_NO_THREAD } from '../src/work/kinds.ts';
import { TWINNED } from '../src/work/twins.ts';
import {
  askOf,
  holdForWindow,
  insert,
  left,
  meet,
  newRun,
  settle,
  show,
  windowHolds,
  type AskRec,
  type Chat,
  type Model,
  type TaskRec
} from './work-model.ts';
import { T0 } from './work-rows.ts';

// Where an Odd raises an ask, and who. Each place is one kind of answer path.
type Place = { staffId: string; handOffId: number | null; threadId: number | null };
export const PLACES = {
  /** Rico, on no work. */
  none: { staffId: 'rico', handOffId: null, threadId: null },
  /** Ada, on the work she leads. */
  lead: { staffId: 'ada', handOffId: null, threadId: 1 },
  /** Rico, on Ada's hand-off to him. */
  handOff: { staffId: 'rico', handOffId: 6, threadId: 4 },
  /** Tess, on a hand-off from Theo, who left. */
  leadLeft: { staffId: 'tess', handOffId: 14, threadId: 3 },
  /** Jo, on the work she led before her leaving stopped it. */
  broughtBack: { staffId: 'jo', handOffId: null, threadId: 8 },
  /** Rico, on work Ada leads: a plan only. */
  notLead: { staffId: 'rico', handOffId: null, threadId: 2 }
} satisfies Record<string, Place>;
type PlaceName = keyof typeof PLACES;
const ANYWHERE: PlaceName[] = ['none', 'lead', 'handOff', 'leadLeft', 'broughtBack'];

export const GMAIL = { connector: 'gmail', level: 'act' } as const;
export const FOLDER = { path: '/office/papers', level: 'write' } as const;
const REPLY: ReplyDraft = {
  to: ['supplier@example.com'],
  cc: [],
  subject: 'Re: the venue',
  body: 'That date works.',
  summary: 'They asked for a date.'
};
const FILTER: GmailFilter = {
  criteria: { from: 'news@example.com' },
  action: { skipInbox: true },
  summary: 'Newsletters'
};
const CALL: HeldCall = { connector: 'gmail', tool: 'archive', arguments: { id: 'm1' } };
const AT = T0.toISOString();

/**
 * Each ask kind the generator raises: where, with what, and what the office
 * did for a yes it approves by doing. The generator asks for one tool, one
 * folder, one set of switches, one level and one set of office tools, so
 * every open ask of one Odd and one of those kinds is a twin of the others.
 */
export const RAISE: Record<
  AskKind,
  { at: PlaceName[]; with?: (p: Place) => Partial<NewAsk>; done?: AskDone }
> = {
  approval: { at: ANYWHERE },
  access: { at: ANYWHERE, with: () => ({ access: GMAIL }) },
  hire: { at: ANYWHERE },
  goal: { at: ANYWHERE },
  plan: {
    at: ['lead', 'broughtBack', 'notLead'],
    with: () => ({ plan: { goalId: 1, items: [] } })
  },
  hand_offs: {
    at: ['lead'],
    with: () => ({ held: { from: 'ada', to: 'rico', title: 'Check the menu', brief: 'Please.' } })
  },
  window: { at: ['none'] },
  reply: {
    at: ANYWHERE,
    with: () => ({ reply: REPLY }),
    done: { reply: { ...REPLY, sent: { action: 'send', at: AT, gmailId: 'g1' } } }
  },
  filter: {
    at: ANYWHERE,
    with: () => ({ filter: FILTER }),
    done: { filter: { ...FILTER, created: { at: AT, gmailId: 'f1', tidied: 2 } } }
  },
  folder: {
    at: ANYWHERE,
    with: () => ({ folder: FOLDER }),
    done: { folder: { ...FOLDER, given: FOLDER } }
  },
  switch: { at: ANYWHERE, with: () => ({ switches: ['web'] }) },
  level: { at: ANYWHERE, with: () => ({ level: 'act' }) },
  office_tool: { at: ANYWHERE, with: () => ({ officeTools: ['office_report'] }) },
  call: {
    at: ANYWHERE,
    with: () => ({ call: CALL }),
    done: { call: { ...CALL, result: { ok: true, text: 'Archived', at: AT } } }
  },
  // Its own leaving.
  remove: { at: ANYWHERE, with: (p) => ({ odd: p.staffId }) },
  bring_back: { at: ANYWHERE, with: () => ({ odd: 'theo' }) },
  catch_up: { at: ['none'] },
  standing: { at: ANYWHERE }
};

// Every decision, through the status each gives the ask. office-asks.ts
// reaches the database, so its list is not imported here.
const STATUS_OF: Record<Decision, AskStatus> = {
  approve: 'approved',
  deny: 'denied',
  iterate: 'revise'
};
export const DECISIONS = Object.keys(STATUS_OF) as Decision[];

/**
 * An answer reaches a thread's lead, as today: it joins the lead's oldest
 * queued resume there, a line, or starts one; nothing for a lead that left.
 * With no line (a time park's wake) a join adds nothing and a new resume has
 * no note. The chat card goes only to a lead whose chat it is, and a join takes it.
 */
export function answerLead(
  r: Model,
  threadId: number,
  marker: string | null,
  o: { askId?: number; chat?: Chat } = {}
): number | undefined {
  const lead = r.threads.get(threadId)!.hub;
  const leadLeft = left(r, lead);
  // A wake with no line leaves no marker to find, so the test checks the lead has a queued resume instead.
  if (marker !== null)
    r.expected.delivered.push({ lead, threadId, kind: 'resume', marker, leadLeft });
  if (leadLeft) {
    meet('an answer for a lead that left');
    return undefined;
  }
  const card = o.chat?.staffId === lead ? o.chat.card : null;
  if (o.chat && !card) meet("a chat answer reaching another Odd's pick-up, which takes no card");
  const mine = [...r.runs.values()]
    .filter((f) => f.staffId === lead && f.threadId === threadId && f.kind === 'resume')
    .sort((a, b) => a.id - b.id);
  const waiting = mine.find((f) => f.is === 'queued');
  if (waiting) {
    if (marker !== null) waiting.lines++;
    meet("an answer joining a lead's queued pick-up");
    if (card) {
      waiting.card = card;
      meet('a chat answer joining a pick-up, which takes its card');
    }
    return waiting.id;
  }
  meet(
    mine.some((f) => f.is === 'ended')
      ? 'an answer to a lead whose pick-up there ended starts a new one'
      : "an answer starting a lead's pick-up"
  );
  return insert(
    r,
    newRun({
      staffId: lead,
      kind: 'resume',
      threadId,
      askId: o.askId ?? null,
      card,
      lines: marker === null ? 0 : 1
    })
  );
}

/** The task ended: every open thread parked on it picks up, its lead told in a queued resume. */
export function wake(r: Model, taskId: number, ownRunEarlier: boolean): void {
  const k = r.tasks.get(taskId)!;
  for (const t of [...r.threads.values()].sort((a, b) => a.id - b.id)) {
    if (t.status !== 'open' || t.park.on !== 'task' || t.park.task !== taskId) continue;
    t.park = { on: 'none' };
    const runId = answerLead(r, t.id, `"${k.title}"`);
    if (runId !== undefined) r.expected.wake = { runId, title: k.title, ownRunEarlier };
  }
}

/**
 * Whether an ended task started a run of its own, as `ownRunOf` reads it: a
 * done task an Odd gave, or a dropped one whose answer went to its work, or
 * on no work to the Odd that gave it unless it was withdrawn. Never on
 * stopped work or work whose lead left.
 */
export function ranOwn(r: Model, k: TaskRec): boolean {
  const from = askOf(r, k.askId);
  const threadId = k.threadId ?? from?.threadId ?? null;
  const handOffId = k.handOffId ?? from?.handOffId ?? null;
  const owns =
    k.status === 'done'
      ? k.staffId !== null
      : threadId !== null || (handOffId === null && k.staffId !== null && !k.withdrawn);
  if (!owns) return false;
  const own = threadId === null ? undefined : r.threads.get(threadId);
  return !own || (own.status !== 'stopped' && !left(r, own.hub));
}

/** An answer goes back to the hand-off or thread it was raised on; false when it was raised on neither. */
function answerBack(
  r: Model,
  on: { handOffId: number | null; threadId: number | null; askId?: number },
  back: { outcome: Outcome; marker: string; chat?: Chat }
): boolean {
  if (on.handOffId) {
    const origin = r.runs.get(on.handOffId);
    if (origin?.kind !== 'hand_off') return true;
    const lead = origin.handOff!.from;
    const leadLeft = left(r, lead);
    r.expected.delivered.push({
      lead,
      threadId: origin.threadId,
      kind: 'handed_back',
      marker: back.marker,
      leadLeft
    });
    if (leadLeft) {
      meet('an answer for a lead that left');
      return true;
    }
    meet('an answer handed back to the lead that handed on the work');
    r.expected.handedBack.push({
      staffId: lead,
      from: origin.staffId,
      outcome: back.outcome,
      threadId: origin.threadId
    });
    insert(
      r,
      newRun({
        staffId: lead,
        kind: 'handed_back',
        threadId: origin.threadId,
        handOff: {
          from: origin.staffId,
          title: origin.handOff!.title,
          outcome: back.outcome,
          answered: true
        },
        lines: 1
      })
    );
    return true;
  }
  if (on.threadId === null) return false;
  answerLead(r, on.threadId, back.marker, { askId: on.askId, chat: back.chat });
  return true;
}

/** A run an answer owes an Odd, on the thread its ask or task was raised on unless its kind serves none. */
function oweRun(
  r: Model,
  o: {
    staffId: string;
    kind: LiveKind;
    askId?: number;
    taskId?: number;
    lines: number;
    chat?: Chat;
  }
): void {
  const raisedOn = SERVES_NO_THREAD[o.kind]
    ? null
    : o.askId !== undefined
      ? (askOf(r, o.askId)?.threadId ?? null)
      : o.taskId !== undefined
        ? (r.tasks.get(o.taskId)?.threadId ?? null)
        : null;
  const card = o.chat?.staffId === o.staffId ? o.chat.card : null;
  if (card) meet("a chat answer carried under its card by its own Odd's run");
  insert(
    r,
    newRun({
      staffId: o.staffId,
      kind: o.kind,
      threadId: raisedOn,
      askId: o.askId ?? null,
      taskId: o.taskId ?? null,
      lines: o.lines,
      card
    })
  );
}

/** One carry-out per place a result goes back to: a hand-off's first, then a thread's, and no work's only alone. */
function carryOuts(r: Model, together: AskRec[], chat?: Chat): void {
  const rank = (a: AskRec) => (a.handOffId ? 0 : a.threadId ? 1 : 2);
  const places = new Set<string>();
  let started = 0;
  if (together.length > 1 && chat) meet('twins answered in chat, under the asked one only');
  for (const a of [...together].sort((p, q) => rank(p) - rank(q) || p.id - q.id)) {
    const place = a.handOffId
      ? `hand-off ${a.handOffId}`
      : a.threadId
        ? `thread ${a.threadId}`
        : '';
    if (places.has(place) || (place === '' && started > 0)) continue;
    places.add(place);
    started++;
    oweRun(r, {
      staffId: a.staffId,
      kind: 'carry_out',
      askId: a.id,
      lines: 0,
      chat: chat?.card === `ask:${a.id}` ? chat : undefined
    });
  }
}

/**
 * The answer to items raised on no work reaches their Odd once, unless this
 * change already starts it a run for one: a line in its queued `answered`
 * run on no work, or a new one.
 */
function offWorkAnswer(
  r: Model,
  o: { staffId: string; item: 'ask' | 'task'; ids: number[]; asked: number; chat?: Chat }
): void {
  if (!o.ids.length || left(r, o.staffId)) return;
  const started = [...r.runs.values()].some(
    (f) =>
      f.id >= r.expected.firstNew &&
      f.staffId === o.staffId &&
      o.ids.includes((o.item === 'ask' ? f.askId : f.taskId) ?? -1)
  );
  if (started) return;
  const id = o.ids.includes(o.asked) ? o.asked : Math.min(...o.ids);
  const chat = id === o.asked ? o.chat : undefined;
  const waiting = [...r.runs.values()]
    .filter(
      (f) =>
        f.staffId === o.staffId && f.kind === 'answered' && f.threadId === null && f.is === 'queued'
    )
    .sort((a, b) => a.id - b.id)[0];
  if (waiting) {
    waiting.lines++;
    meet("an answer on no work joining its Odd's queued answered run");
    const card = chat?.staffId === o.staffId ? chat.card : null;
    if (card) waiting.card = card;
    return;
  }
  oweRun(r, {
    staffId: o.staffId,
    kind: 'answered',
    ...(o.item === 'ask' ? { askId: id } : { taskId: id }),
    lines: 1,
    chat
  });
}

/** Done or failed work opens again for something raised on it; stopped work only for a plan. */
function raisedOn(r: Model, threadId: number, plan: boolean): void {
  const t = r.threads.get(threadId)!;
  if (t.status === 'done' || t.status === 'failed' || (plan && t.status === 'stopped')) {
    meet(t.status === 'stopped' ? 'a plan opening stopped work again' : 'ended work opened again');
    t.status = 'open';
    t.park = { on: 'none' };
  }
  settle(r, threadId);
}

/** Each place raises each kind at most twice, so twins and a repeated held call happen, and the draw stays varied. */
export const raiseKey = (a: Pick<NewAsk, 'kind' | 'staffId' | 'handOffId' | 'threadId'>) =>
  show([a.kind, a.staffId, a.handOffId ?? null, a.threadId ?? null]);
export const giveKey = (k: NewTask) =>
  show([k.staffId, k.handOffId ?? null, k.threadId ?? null, k.steps]);
const count = (r: Model, key: string) => r.raised.set(key, (r.raised.get(key) ?? 0) + 1);

export function raise(r: Model, a: NewAsk): void {
  count(r, raiseKey(a));
  // An Odd that left puts nothing on the desk (nothing stays open for an Odd that left), whatever its run still does.
  if (left(r, a.staffId)) {
    r.expected.refused = 'not taken';
    meet('an ask raised by an Odd that left');
    return;
  }
  // The generator holds one call, so an open call of the same Odd is the same call.
  const same =
    a.kind === 'call'
      ? r.asks.find((k) => k.staffId === a.staffId && k.kind === 'call' && k.status === 'open')
      : undefined;
  if (same) {
    r.expected.already = same.id;
    meet('a held call raised again while it is open');
    return;
  }
  r.asks.push({
    id: Math.max(...r.asks.map((k) => k.id)) + 1,
    staffId: a.staffId,
    kind: a.kind,
    title: a.title,
    odd: a.odd ?? null,
    held: a.held ?? null,
    status: 'open',
    handOffId: a.handOffId ?? null,
    threadId: a.threadId ?? null
  });
  if (a.threadId) raisedOn(r, a.threadId, !!a.plan);
}

/** What an answer to an ask does, a step at a time, in the order the code takes them. */
type Step =
  | 'carryOut'
  | 'carryOuts'
  | 'rework'
  | 'held'
  | 'handOffs'
  | 'window'
  | 'back'
  | 'lesson'
  | 'planning'
  | 'leaves';
const NO: Step[] = ['back', 'lesson'];
/**
 * Today's answers to each kind of ask, written out, and when the rule that
 * every answer is heard lets one go unheard by any run, whatever its place.
 * A kind with no `sendBack` refuses Iterate.
 */
export const KINDS: Record<
  AskKind,
  {
    yes: Step[];
    no: Step[];
    sendBack: boolean;
    /** `handsOn`: the ask holds a hand-off that goes with a yes, its colleague still here. */
    unheard?: (o: { yes: boolean; reason: string | null; handsOn: boolean }) => boolean;
  }
> = {
  approval: { yes: ['carryOut'], no: NO, sendBack: true },
  // Its yes reaches the Odd through the grant, after the commit.
  access: { yes: [], no: NO, sendBack: true, unheard: (o) => o.yes },
  hire: { yes: ['back'], no: NO, sendBack: true },
  goal: { yes: ['planning', 'back'], no: NO, sendBack: true },
  plan: { yes: ['planning', 'back'], no: NO, sendBack: true },
  // A yes with no words is heard through the held hand-off's result, when one goes.
  hand_offs: {
    yes: ['held', 'handOffs'],
    no: ['handOffs', 'lesson'],
    sendBack: false,
    unheard: (o) => o.yes && !o.reason && o.handsOn
  },
  // The office's own: a yes reaches the held work's leads, and a no nobody.
  window: { yes: ['window'], no: [], sendBack: false, unheard: () => true },
  reply: { yes: ['back'], no: NO, sendBack: true },
  filter: { yes: ['back'], no: NO, sendBack: true },
  folder: { yes: ['carryOuts'], no: NO, sendBack: true },
  switch: { yes: ['carryOuts'], no: NO, sendBack: true },
  // As a switch's, but the runs it starts reply under no chat card (`NO_CARD`).
  level: { yes: ['carryOuts'], no: NO, sendBack: true },
  office_tool: { yes: ['carryOuts'], no: NO, sendBack: true },
  call: { yes: ['carryOut'], no: NO, sendBack: true },
  remove: { yes: ['back', 'leaves'], no: NO, sendBack: false },
  bring_back: { yes: ['back'], no: NO, sendBack: false },
  // The office's own: a yes owes the job its missed runs, and a no needs nothing.
  catch_up: { yes: [], no: [], sendBack: false, unheard: () => true },
  standing: { yes: ['back'], no: NO, sendBack: false }
};

/** The kinds whose yes starts its carry-outs with no chat card, even when answered in chat. */
const NO_CARD: AskKind[] = ['level', 'office_tool'];

const WINDOW_MARKER = 'until the usage window resets';

export function decideAsk(r: Model, e: EventOf<'askDecided'>): void {
  const x = r.expected;
  const a = askOf(r, e.id)!;
  const how = KINDS[a.kind];
  const yes = e.decision === 'approve';
  if (
    (e.decision === 'iterate' && (!e.reason || !how.sendBack)) ||
    (yes && RAISE[a.kind].done && !e.done)
  ) {
    x.refused = 'answer refused';
    meet('an answer refused before the ask closes');
    return;
  }
  if (a.status !== 'open') {
    x.refused = 'answered already';
    meet('an answer to an ask answered already');
    return;
  }
  const reason = e.reason || null;
  const twins =
    TWINNED.includes(a.kind) && e.decision !== 'iterate'
      ? r.asks.filter(
          (k) =>
            k.status === 'open' && k.id !== a.id && k.staffId === a.staffId && k.kind === a.kind
        )
      : [];
  for (const k of [a, ...twins]) {
    k.status = STATUS_OF[e.decision];
    k.decidedAt = r.at;
  }
  const chat = e.inChat ? { staffId: a.staffId, card: `ask:${a.id}` } : undefined;
  const marker = `"${a.title}"`;
  const outcome: Outcome = e.decision === 'deny' ? 'failed' : 'done';
  const offWork: AskRec[] = [];
  const steps: Step[] = e.decision === 'iterate' ? ['rework'] : yes ? how.yes : how.no;
  for (const step of steps)
    switch (step) {
      case 'carryOut':
        oweRun(r, {
          staffId: a.staffId,
          kind: 'carry_out',
          askId: a.id,
          lines: reason ? 1 : 0,
          chat
        });
        break;
      case 'carryOuts':
        carryOuts(r, [a, ...twins], NO_CARD.includes(a.kind) ? undefined : chat);
        break;
      case 'rework':
        oweRun(r, { staffId: a.staffId, kind: 'rework', askId: a.id, lines: 1, chat });
        break;
      case 'held':
        if (a.held && a.threadId !== null) handOn(r, a.threadId, a.held);
        break;
      case 'handOffs':
        if (a.threadId !== null) answerHandOffs(r, a, { yes, reason, marker });
        else if (!answerBack(r, a, { outcome, marker })) offWork.push(a);
        break;
      case 'window':
        if (yes) answerWindow(r, a);
        break;
      case 'back':
        if (twins.length > 0 && chat) meet('twins answered in chat, under the asked one only');
        for (const k of [a, ...twins])
          if (
            !answerBack(
              r,
              { ...k, askId: k.id },
              { outcome, marker, chat: k === a ? chat : undefined }
            )
          )
            offWork.push(k);
        break;
      case 'lesson':
        if (reason && !e.withdrawn)
          oweRun(r, { staffId: a.staffId, kind: 'denied', askId: a.id, lines: 1 });
        break;
      case 'planning':
      case 'leaves':
        break;
      default:
        step satisfies never;
    }
  const ownLeave = steps.includes('leaves') && a.odd === a.staffId;
  if (!e.withdrawn && !steps.includes('planning') && !ownLeave)
    offWorkAnswer(r, {
      staffId: a.staffId,
      item: 'ask',
      ids: offWork.map((k) => k.id),
      asked: a.id,
      chat
    });
  hearAsk(r, { a, twins, steps, yes, reason, withdrawn: !!e.withdrawn, ownLeave });
}

/** Which runs of the Odd that raised it hear an answer, by place, from the record alone. */
function hearAsk(
  r: Model,
  o: {
    a: AskRec;
    twins: AskRec[];
    steps: Step[];
    yes: boolean;
    reason: string | null;
    withdrawn: boolean;
    ownLeave: boolean;
  }
): void {
  const { a, steps } = o;
  if (o.withdrawn || left(r, a.staffId)) return;
  const groups = new Map<string, AskRec[]>();
  for (const k of [a, ...o.twins]) {
    const key = k.handOffId ? `hand-off ${k.handOffId}` : `thread ${k.threadId}`;
    groups.set(key, [...(groups.get(key) ?? []), k]);
  }
  const handsOn = !!a.held && !left(r, a.held.to) && !windowHolds(r, a.held.to);
  const excepted = KINDS[a.kind].unheard?.({ yes: o.yes, reason: o.reason, handsOn }) ?? false;
  const starts = steps.some((s) => s === 'carryOut' || s === 'carryOuts' || s === 'rework');
  for (const group of groups.values()) {
    const g = group[0];
    const place = g.handOffId
      ? 'other'
      : g.threadId === null
        ? 'none'
        : r.threads.get(g.threadId)!.hub === a.staffId
          ? 'own'
          : 'other';
    let runs: 0 | 1 = 1;
    if (excepted) {
      runs = 0;
      meet('an answer its kind lets go unheard');
    } else if (place === 'none' && o.ownLeave) {
      runs = 0;
      meet("a yes to an Odd's own leaving, raised on no work");
    } else if (place === 'none' && steps.includes('carryOuts') && groups.size > 1) {
      runs = 0;
      meet('twins on no work carried out at another place');
    } else if (place === 'other' && !starts) continue;
    if (runs === 1) meet(`an answer heard on ${place} work`);
    if (group.length > 1 && runs === 1) meet('twins at one place heard once');
    if (place === 'none' && steps.includes('lesson') && o.reason && runs === 1)
      meet('an answer on no work heard by the lesson run');
    const planning = place === 'none' && steps.includes('planning');
    if (planning) meet("a goal's yes heard by its planning run");
    r.expected.heard.push({
      staffId: a.staffId,
      place,
      threadId: g.threadId,
      askIds: group.map((k) => k.id),
      taskIds: [],
      marker: `"${a.title}"`,
      planning,
      runs
    });
  }
}

/**
 * A held hand-off starts as the first of a new round; done or failed work
 * opens again for it. One for a colleague that left since never goes (nothing stays open for an Odd that left):
 * its lead hears so (`answerHandOffs`). One the usage window holds waits for
 * it, as a new hand-off does, and its lead hears so too.
 */
function handOn(r: Model, threadId: number, held: NonNullable<AskRec['held']>): void {
  if (left(r, held.to)) return;
  const t = r.threads.get(threadId)!;
  if (windowHolds(r, held.to)) {
    holdForWindow(t);
    meet('a yes to a hand-off the usage window holds');
    return;
  }
  if (t.status === 'done' || t.status === 'failed') {
    t.status = 'open';
    t.park = { on: 'none' };
  }
  insert(
    r,
    newRun({
      staffId: held.to,
      kind: 'hand_off',
      threadId,
      handOff: { from: held.from, title: held.title }
    })
  );
}

/**
 * A no stops the work and tells its lead; a yes tells the lead only when the
 * owner wrote something, when its held hand-off's colleague left since, or
 * when the usage window holds that hand-off.
 */
function answerHandOffs(
  r: Model,
  a: AskRec,
  o: { yes: boolean; reason: string | null; marker: string }
): void {
  const t = r.threads.get(a.threadId!)!;
  if (!o.yes) {
    t.status = 'stopped';
    t.park = { on: 'none' };
    meet('a no to more hand-offs stops the work');
  } else if (a.held && left(r, a.held.to)) {
    meet('a yes to a hand-off held for a colleague that left');
  } else if (a.held && !o.reason && !windowHolds(r, a.held.to)) return;
  answerLead(r, t.id, o.marker, { askId: a.id });
}

/** A yes to the usage window frees every open thread it holds and tells each one's lead. */
function answerWindow(r: Model, a: AskRec): void {
  const held = [...r.threads.values()]
    .filter((t) => t.status === 'open' && t.park.on === 'window' && t.park.ask === a.id)
    .sort((p, q) => p.id - q.id);
  for (const t of held) t.park = { on: 'none' };
  for (const t of held) answerLead(r, t.id, WINDOW_MARKER, { askId: a.id });
}

export function give(r: Model, e: EventOf<'taskGiven'>): void {
  const k = e.task;
  count(r, giveKey(k));
  if (k.staffId !== null && left(r, k.staffId)) {
    r.expected.refused = 'not taken';
    meet('a task given by an Odd that left');
    return;
  }
  const one = e.oneOpen;
  const there = one
    ? [...r.tasks.values()]
        .sort((p, q) => p.id - q.id)
        .find(
          (t) =>
            t.status === 'open' &&
            (k.staffId === null || t.staffId === k.staffId) &&
            t.connectors.includes(one.connector)
        )
    : undefined;
  if (there) {
    r.expected.already = there.id;
    meet('a connect task given while one is open');
    return;
  }
  const id = Math.max(...r.tasks.keys()) + 1;
  r.tasks.set(id, {
    id,
    staffId: k.staffId,
    title: k.title,
    status: 'open',
    askId: k.askId ?? null,
    handOffId: k.handOffId ?? null,
    threadId: k.threadId ?? null,
    connectors: k.steps.flatMap((s) =>
      s.action && 'connector' in s.action ? [s.action.connector] : []
    )
  });
  if (k.threadId) raisedOn(r, k.threadId, false);
}

/** The asks one answer settled with `from`: the same Odd and kind, decided at the same event the same way. */
const answeredWith = (r: Model, from: AskRec) =>
  r.asks.filter(
    (k) =>
      k.id !== from.id &&
      k.staffId === from.staffId &&
      k.kind === from.kind &&
      k.status !== 'open' &&
      k.status === from.status &&
      k.decidedAt === from.decidedAt
  );

export function endTask(r: Model, e: EventOf<'taskEnded'>): void {
  const t = r.tasks.get(e.id)!;
  if (t.status !== 'open') {
    r.expected.refused = 'answered already';
    meet('an end of a task ended already');
    return;
  }
  const done = e.ended === 'done';
  t.status = done ? 'done' : 'dropped';
  t.withdrawn = e.ended === 'withdrawn';
  const marker = `"${t.title}"`;
  const chat = e.inChat && t.staffId ? { staffId: t.staffId, card: `task:${t.id}` } : undefined;
  const from = askOf(r, t.askId);
  const fromAccess = done && from?.kind === 'access';
  const on = {
    handOffId: t.handOffId ?? from?.handOffId ?? null,
    threadId: t.threadId ?? from?.threadId ?? null
  };
  if (!done) {
    // To a thread or a hand-off it carries no chat card.
    const went = answerBack(r, on, { outcome: 'failed', marker });
    if (went && e.inChat) meet('a task answered in chat going back to work, with no card');
    if (!went && t.staffId && e.ended !== 'withdrawn')
      offWorkAnswer(r, { staffId: t.staffId, item: 'task', ids: [t.id], asked: t.id, chat });
  } else if (t.staffId && fromAccess) carryOuts(r, [from!, ...answeredWith(r, from!)]);
  else if (t.staffId)
    oweRun(r, { staffId: t.staffId, kind: 'task_done', taskId: t.id, lines: e.note ? 1 : 0, chat });
  wake(r, t.id, false);

  if (e.ended === 'withdrawn' || !t.staffId || left(r, t.staffId)) return;
  const place = on.handOffId
    ? 'other'
    : on.threadId === null
      ? 'none'
      : r.threads.get(on.threadId)!.hub === t.staffId
        ? 'own'
        : 'other';
  if (place === 'other' && !done) return;
  meet(`a task's end heard on ${place} work`);
  r.expected.heard.push({
    staffId: t.staffId,
    place,
    threadId: on.threadId,
    askIds: fromAccess ? [from!.id, ...answeredWith(r, from!).map((k) => k.id)] : [],
    taskIds: [t.id],
    marker,
    planning: false,
    runs: 1
  });
}

/** A tool's connect tasks are dropped, and the work parked on each wakes; nobody else is told. */
export function dropConnectTasks(r: Model, e: EventOf<'connectTasksDropped'>): void {
  const stale = [...r.tasks.values()]
    .filter(
      (t) =>
        t.status === 'open' &&
        (e.staffId === undefined || t.staffId === e.staffId) &&
        t.connectors.includes(e.connector)
    )
    .sort((p, q) => p.id - q.id);
  for (const t of stale) t.status = 'dropped';
  if (stale.length > 0) meet("a tool's connect tasks dropped");
  for (const t of stale) wake(r, t.id, false);
}
