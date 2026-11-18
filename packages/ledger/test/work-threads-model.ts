// The sequence test's model of threads and leaving (work-sequences.test.ts):
// what parking work, the clock's wake, handing work on, telling a lead, and
// an Odd leaving or coming back do, from the events alone. Pure: no database.
import type { Carried, CarriedFile } from '../src/hand-offs.ts';
import type { EventOf, WorkEvent } from '../src/work/events.ts';
import { answerLead, decideAsk, endTask } from './work-answers-model.ts';
import {
  askOf,
  holdForWindow,
  insert,
  left,
  meet,
  newRun,
  settle,
  windowHolds,
  type Model
} from './work-model.ts';
import { minutes, recordingEffects } from './work-rows.ts';
import { finish } from './work-runs-model.ts';

/** What every run of the Odd yet to start was about, as the leaving's entry reads it. */
export const ABOUT = 'the work';
const ABOUT_EACH_RUN: ReadonlyMap<number, string> = new Map(
  // More than any sequence makes, so every run the leaving fails is named.
  Array.from({ length: 1000 }, (_, i) => [i + 1, ABOUT] as const)
);

/** A round of work takes this many hand-offs before the owner is asked to go on. */
const ROUND = 8;
const WINDOW_RESET = 'usage window has reset';

/** A file from outside the work, carried with a hand-off or the owner's words. */
const FILE: CarriedFile = { real: '/outside/notes.md', name: 'notes.md', named: 'notes.md' };
/** What the entry's copy of the owner's attachments gave: one landed, one it could not copy. */
const NOTED: Carried[] = [
  { named: 'notes.md', at: 'notes.md' },
  { named: 'plan.pdf', why: 'the office cannot open it' }
];

/** The work each Odd is on and does not lead, as the entry reads it: Rico and Tess on Ada's hand-offs, Tess on Jo's stopped work. */
const WORKS_ON: Record<string, ReadonlySet<number>> = {
  ada: new Set(),
  rico: new Set([2, 4, 5]),
  tess: new Set([3, 4, 8]),
  theo: new Set(),
  jo: new Set()
};
const ODD_IDS = Object.keys(WORKS_ON);

/** The fakes a leaving passes for its after-commit I/O; deciding calls none of them. */
export const stopped: string[] = [];
const LEAVE_EFFECTS = { stopRuns: (id: string) => void stopped.push(id) };
/** A withdrawal is a no and does no I/O; the model never calls these. */
const NO_IO = recordingEffects().effects;

/** Every threads and leaving event valid now, from the record alone. */
export function threadEvents(r: Model): WorkEvent[] {
  const parks: WorkEvent[] = [1, 4, 5, 9].flatMap((threadId) =>
    [{ at: minutes(r.at) }, { at: minutes(r.at + 3) }, { task: 1 }, { task: 4 }, { task: 5 }].map(
      (on): WorkEvent => ({ kind: 'parked', staffId: 'ada', threadId, on, worksOn: WORKS_ON.ada })
    )
  );
  const due = [...r.threads.values()].filter((t) => t.park.on === 'time' || t.park.on === 'window');
  const handOff = (
    from: string,
    to: string,
    thread: EventOf<'handedOff'>['thread'],
    carry: CarriedFile[]
  ): WorkEvent => ({
    kind: 'handedOff',
    from,
    to,
    work: { title: `Piece ${r.at}`, brief: 'Please do it.' },
    thread,
    run: `${from} chat`,
    carry
  });
  const told = (staffId: string, threadId: number, words: string, carry = false): WorkEvent => ({
    kind: 'toldLead',
    staffId,
    threadId,
    said: `Sam said: Owner words ${r.at}. Thanks.`,
    words,
    reading: 'They want it sooner.',
    exchange: '',
    worksOn: WORKS_ON[staffId],
    files: carry ? NOTED : []
  });
  const words = `Owner words ${r.at}`;
  return [
    ...parks,
    { kind: 'parked', staffId: 'ada', threadId: 9, on: { task: 2 }, worksOn: WORKS_ON.ada },
    {
      kind: 'parked',
      staffId: 'rico',
      threadId: 4,
      on: { at: minutes(r.at) },
      worksOn: WORKS_ON.rico
    },
    { kind: 'parked', staffId: 'rico', threadId: 9, on: { task: 5 }, worksOn: WORKS_ON.rico },
    ...[...due.map((t) => t.id), 2].map((threadId): WorkEvent => ({ kind: 'clockWoke', threadId })),
    ...['rico', 'tess', 'theo', 'jo', 'ada'].flatMap((to) => [
      handOff('ada', to, { id: 1 }, []),
      handOff('ada', to, { id: 5 }, [FILE]),
      handOff('ada', to, { open: { title: 'New work', hubId: 'ada' } }, [FILE])
    ]),
    handOff('ada', 'rico', { id: 3 }, [FILE]),
    handOff('jo', 'rico', { id: 8 }, [FILE]),
    handOff('rico', 'tess', { id: 4 }, []),
    handOff('rico', 'tess', { open: { title: 'New work', hubId: 'rico' } }, [FILE]),
    // A goal's new work, which opens under its manager, Jo.
    handOff('ada', 'rico', { open: { title: 'Goal work', hubId: 'jo', goalId: 1 } }, [FILE]),
    told('rico', 4, words),
    told('rico', 5, words, true),
    told('rico', 2, words, true),
    told('rico', 4, 'Words never said'),
    told('rico', 1, words),
    told('tess', 3, words, true),
    told('tess', 8, words, true),
    told('tess', 4, words),
    told('jo', 8, words),
    ...ODD_IDS.map((staffId): WorkEvent => ({
      kind: 'oddRemoved',
      staffId,
      line: { kind: 'decision', actor: 'owner', title: `Let ${staffId} go from the office` },
      about: ABOUT_EACH_RUN,
      effects: LEAVE_EFFECTS
    })),
    ...ODD_IDS.map((staffId): WorkEvent => ({
      kind: 'oddBroughtBack',
      staffId,
      line: { kind: 'decision', actor: 'owner', title: `Brought ${staffId} back to the office` }
    }))
  ];
}

const notTaken = (r: Model) => {
  r.expected.refused = 'not taken';
};

/** A lead parks its open work until a time, or until a task it can see is still open, and not one on that same work. */
export function park(r: Model, e: EventOf<'parked'>): void {
  const t = r.threads.get(e.threadId);
  const led = t?.status === 'open' && t.hub === e.staffId ? t : undefined;
  if ('at' in e.on) {
    if (!led) return notTaken(r);
    if (led.park.on === 'task') meet('a time park replacing a task park');
    if (led.park.on === 'window') meet('a time park replacing a window hold');
    led.park = { on: 'time', at: +e.on.at };
    return;
  }
  const k = r.tasks.get(e.on.task);
  const on = k ? (k.threadId ?? askOf(r, k.askId)?.threadId ?? null) : null;
  const seen =
    !!k &&
    (k.staffId === e.staffId ||
      (on !== null && (r.threads.get(on)?.hub === e.staffId || e.worksOn.has(on))));
  if (!k || !seen || k.status !== 'open' || on === e.threadId || !led) return notTaken(r);
  if (led.park.on === 'time') meet('a task park replacing a time park');
  led.park = { on: 'task', task: k.id };
}

/** The clock reaches a park's time: the park lifts and the lead picks the work up once, told when the window reset. */
export function clockWake(r: Model, e: EventOf<'clockWoke'>): void {
  const t = r.threads.get(e.threadId);
  const p = t?.park;
  if (t?.status !== 'open' || !p || p.on === 'none' || p.on === 'task' || p.at > +minutes(r.at)) {
    meet('a clock wake with nothing due');
    return;
  }
  t.park = { on: 'none' };
  if (p.on === 'window') meet('a usage window reset waking held work');
  const lead = t.hub;
  const queued = [...r.runs.values()].some(
    (f) => f.staffId === lead && f.threadId === t.id && f.kind === 'resume' && f.is === 'queued'
  );
  meet(queued ? 'a clock wake joining a queued resume' : 'a clock wake starting a resume');
  r.expected.clockWake = { threadId: t.id, lead, leadLeft: left(r, lead) };
  answerLead(r, t.id, p.on === 'window' ? WINDOW_RESET : null);
  settle(r, t.id);
}

/** True when the work is stopped or its lead left: it takes no new hand-off and no words (nothing new reaches stopped work). */
function stoppedWork(r: Model, threadId: number): boolean {
  const t = r.threads.get(threadId);
  return !!t && (t.status === 'stopped' || left(r, t.hub));
}

/** New work a hand-off opens, led by `hub`. */
function open(r: Model, o: { title: string; hubId: string }): number {
  const id = Math.max(...r.threads.keys()) + 1;
  const hub = o.hubId;
  r.threads.set(id, {
    id,
    title: o.title,
    hub,
    holder: hub,
    status: 'open',
    park: { on: 'none' },
    leadsJobGoing: false,
    used: 0
  });
  return id;
}

/**
 * A lead hands a colleague in the office a piece of its work. Not to itself,
 * not from or to an Odd that left, and not on work it does not lead, that
 * stopped, or that waits on the owner's answer to going on. Past the
 * window's guard the work is held until the reset; past a round's hand-offs
 * the owner is asked; else the colleague's run is queued.
 */
export function handOff(r: Model, e: EventOf<'handedOff'>): void {
  const x = r.expected;
  if ('id' in e.thread && stoppedWork(r, e.thread.id)) {
    x.onStoppedWork = true;
    meet('a hand-off on stopped work');
  }
  const to = r.odds.get(e.to);
  if (e.to === e.from || !to || to.left) return notTaken(r);
  if (left(r, e.from)) {
    meet('a hand-off from an Odd that left');
    return notTaken(r);
  }
  if ('open' in e.thread && e.thread.open.hubId !== e.from) {
    open(r, e.thread.open);
    x.handOff = 'held';
    meet("a hand-off opening a goal's work its sender does not lead");
    return;
  }
  if ('id' in e.thread) {
    const id = e.thread.id;
    const t = r.threads.get(id);
    const asking = r.asks.some(
      (a) => a.threadId === id && a.kind === 'hand_offs' && a.status === 'open'
    );
    if (!t || t.hub !== e.from || t.status === 'stopped' || asking) return notTaken(r);
  }
  if (r.broughtBack.has(e.to)) meet('a hand-off to an Odd brought back');
  const id = 'id' in e.thread ? e.thread.id : open(r, e.thread.open);
  const t = r.threads.get(id)!;
  const ended = t.status !== 'open';
  if (windowHolds(r, e.to)) {
    if (ended) t.used = 0;
    holdForWindow(t);
    settle(r, id);
    x.handOff = 'held';
    meet('a hand-off held for the usage window');
    return;
  }
  x.passes = { threadId: 'id' in e.thread ? id : 'new', from: e.from };
  const used = ended ? 0 : t.used;
  if (used >= ROUND) {
    r.asks.push({
      id: Math.max(...r.asks.map((a) => a.id)) + 1,
      staffId: t.hub,
      kind: 'hand_offs',
      // The owner reads the work by its title, and the answer quotes the ask's.
      title: `${r.odds.get(t.hub)!.name} needs a few more steps to finish ${t.title}. Go ahead?`,
      odd: null,
      held: { from: e.from, to: e.to, title: e.work.title },
      status: 'open',
      handOffId: null,
      threadId: id
    });
    settle(r, id);
    x.handOff = 'asked';
    meet('a hand-off past the round asking the owner');
    return;
  }
  if (ended) {
    t.status = 'open';
    t.park = { on: 'none' };
  }
  t.used = used + 1;
  insert(
    r,
    newRun({
      staffId: e.to,
      kind: 'hand_off',
      threadId: id,
      handOff: { from: e.from, title: e.work.title }
    })
  );
  x.handOff = 'taken';
  meet(e.carry.length > 0 ? 'a hand-off taken with files' : 'a hand-off taken');
  if ('open' in e.thread) meet('a hand-off taken on new work');
}

/** A colleague passes the owner's own words about work it is on to that work's lead, who picks it up once. */
export function tellLead(r: Model, e: EventOf<'toldLead'>): void {
  const x = r.expected;
  if (stoppedWork(r, e.threadId)) {
    x.onStoppedWork = true;
    meet('words for stopped work');
  }
  const t = r.threads.get(e.threadId);
  if (
    !e.said.includes(e.words) ||
    !t ||
    t.hub === e.staffId ||
    !e.worksOn.has(t.id) ||
    stoppedWork(r, t.id)
  )
    return notTaken(r);
  x.passes = { threadId: t.id, from: e.staffId };
  meet(e.files.length > 0 ? 'words told to a lead with files' : 'words told to a lead');
  answerLead(r, t.id, e.words);
}

/**
 * The owner lets an Odd go. It leaves, every work it leads stops, then in
 * order each open ask it raised or about it is withdrawn, each open task it
 * gave is withdrawn, and each of its runs yet to start fails. One gone
 * already changes nothing.
 */
export function removeOdd(r: Model, e: EventOf<'oddRemoved'>): void {
  const x = r.expected;
  const o = r.odds.get(e.staffId);
  if (!o || o.left) {
    x.leaving = 'gone';
    meet('a leaving of an Odd gone already');
    return;
  }
  x.leaving = 'left';
  o.left = true;
  r.letGo.add(e.staffId);
  r.broughtBack.delete(e.staffId);
  const byId = <T extends { id: number }>(xs: Iterable<T>) => [...xs].sort((a, b) => a.id - b.id);
  for (const t of byId(r.threads.values()))
    if (t.hub === e.staffId && t.status !== 'stopped') {
      t.status = 'stopped';
      t.park = { on: 'none' };
      meet("a leaving stopping the Odd's work");
    }
  const line = `${o.name} left the office, so this will not go ahead.`;
  for (const a of byId(r.asks))
    // An ask closed as an earlier one's twin is not answered twice.
    if (a.status === 'open' && (a.staffId === e.staffId || a.odd === e.staffId)) {
      const said = a.staffId === e.staffId ? line : `${o.name} left the office already.`;
      meet('a leaving withdrawing an ask');
      withdraw(r, a.id, said);
    }
  for (const k of byId(r.tasks.values()))
    if (k.status === 'open' && k.staffId === e.staffId) {
      meet('a leaving withdrawing a task');
      saidAs(r, line, () =>
        endTask(r, { kind: 'taskEnded', id: k.id, ended: 'withdrawn', note: line, inChat: false })
      );
    }
  // Each run's finish says whether its lead left; with many, the rule holds for the change as a whole.
  let leadLeft = false;
  for (const f of byId(r.runs.values()))
    if (f.staffId === e.staffId && f.is === 'queued') {
      meet('a leaving failing a run yet to start');
      finish(r, f.id, 'failed', [], ABOUT);
      leadLeft ||= !!x.leadLeft;
    }
  x.leadLeft = leadLeft && x.reports.length === 0 ? true : undefined;
}

/** The owner brings an Odd back: in the office again, and every other open ask to bring it back is withdrawn. */
export function bringBack(r: Model, e: EventOf<'oddBroughtBack'>): void {
  const o = r.odds.get(e.staffId);
  if (!o) return;
  if (o.left) meet('an Odd brought back');
  o.left = false;
  r.letGo.delete(e.staffId);
  r.broughtBack.add(e.staffId);
  r.expected.broughtBack = e.staffId;
  const line = `${o.name} is back in the office already.`;
  for (const a of [...r.asks].sort((p, q) => p.id - q.id))
    if (a.status === 'open' && a.odd === e.staffId && a.kind === 'bring_back') {
      meet('a return withdrawing an ask to bring it back');
      withdraw(r, a.id, line);
    }
}

/** An open ask closed as the office's no, its line going back where it came from. */
function withdraw(r: Model, id: number, line: string): void {
  saidAs(r, line, () => decideAsk(r, withdrawal(id, line)));
}

/** Every answer `close` sends a lead reads as `line`, the same for each item a leaving closes. */
function saidAs(r: Model, line: string, close: () => void): void {
  const from = r.expected.delivered.length;
  close();
  for (const to of r.expected.delivered.slice(from)) to.marker = line;
}

function withdrawal(id: number, line: string): EventOf<'askDecided'> {
  return {
    kind: 'askDecided',
    id,
    decision: 'deny',
    reason: line,
    inChat: false,
    withdrawn: line,
    perKind: [],
    effects: NO_IO
  };
}

/**
 * Each event's new rounds, after its model ran: work that ended or stopped
 * and opened again starts a round with no hand-off counted, and a yes to going on
 * starts the hand-off it held as the first of a new round, or, when the
 * usage window holds it, a round with none counted yet. A hand-off's own
 * model counts its round itself.
 */
export function newRounds(r: Model, e: WorkEvent, was: Map<number, string>): void {
  if (e.kind === 'handedOff') return;
  for (const t of r.threads.values()) {
    const before = was.get(t.id);
    if (before !== undefined && before !== 'open' && t.status === 'open') t.used = 0;
  }
  if (e.kind !== 'askDecided' || e.decision !== 'approve') return;
  const a = askOf(r, e.id);
  // One held for a colleague that left never went, nor one the window holds, so the new round has none.
  if (a?.kind === 'hand_offs' && a.held && a.threadId !== null && a.decidedAt === r.at)
    r.threads.get(a.threadId)!.used = left(r, a.held.to) || windowHolds(r, a.held.to) ? 0 : 1;
}
