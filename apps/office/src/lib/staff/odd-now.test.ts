// The rules an Odd's live state keeps after any run of events: every screen
// shows the same state, nothing claims work that is not there, the Jobs tab
// follows the runs, a hand-off reads "is on it" only while a run serving it
// goes, a chat reply ranks above background runs, and the card's tabs reload only
// when a run starts or ends. Random event sequences drive the page's
// snapshot; the test keeps its own record of what is true from the events
// alone, and each rule asserts equality with it. odd-now-fixtures.test.ts
// renders the screens themselves. Run with `npm test -w @oddboro/office`;
// `ODD_NOW_SEEDS` sets how many sequences.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskRow } from '@oddboro/ledger';
import { explore, type Explore } from '@oddboro/ledger/sequences';
import {
  CARRY_OUT_LABEL,
  CATCH_UP,
  deskOf,
  GONE,
  HAND_OFF_LABEL,
  handOff,
  HELLO,
  IDS,
  JOBS,
  NAMES,
  nameOf,
  work
} from '#lib/staff/odd-now-cases.ts';
import {
  floorMode,
  handOffProgress,
  handOffWords,
  jobRunning,
  lineWords,
  oddNow,
  railCount,
  railRing,
  nowIn,
  readerProps,
  runsChanged,
  runWords,
  tagWords,
  workItems,
  type OddNow,
  type Show,
  type Snapshot
} from '#lib/staff/odd-now.ts';
import { ACTIVITY_LABEL, type Activity, type StaffProfile } from '#lib/staff/roster.ts';
import type { Work } from '#lib/staff/work.ts';

const SEEDS = Number(process.env.ODD_NOW_SEEDS ?? 300);
const LENGTH = 40;

const RUN_LABELS = [...JOBS, CATCH_UP, HELLO];
const TOOLS = ['Read', 'Edit'];
/** Where the floor may put an Odd: at work, elsewhere, and at the owner's door. */
const PLACES: Activity[] = ['work', 'read', 'play', 'wait'];
/** The place an Odd's job puts it. */
const JOB_PLACE: Activity = 'read';
const HEADING = 'Kitchen';
const RUNS_EACH = 3;

type Event =
  | { kind: 'runQueued'; odd: string; key: number; label: string }
  | { kind: 'runStarted'; key: number }
  | { kind: 'toolStep'; key: number; tool: string }
  | { kind: 'runEnded'; key: number }
  | { kind: 'queuedRunDropped'; key: number }
  | { kind: 'followUpAdded'; odd: string; id: number }
  | { kind: 'followUpClaimed'; odd: string; id: number; key: number }
  | { kind: 'carryOutClaimed'; odd: string; handOff: number; key: number }
  | { kind: 'chatStarted'; odd: string }
  | { kind: 'chatEnded'; odd: string }
  | { kind: 'askRaised'; odd: string; id: number }
  | { kind: 'askAnswered'; id: number }
  | { kind: 'taskGiven'; odd: string | null; id: number }
  | { kind: 'taskEnded'; id: number }
  | { kind: 'messageSent'; odd: string }
  | { kind: 'messageRead'; odd: string }
  | { kind: 'threadHeld'; hub: string; holder: string; title: string }
  | { kind: 'threadReleased'; title: string }
  | { kind: 'activityChanged'; odd: string; activity: Activity };

/** The test's own record: what is true, from the events alone. */
type Run = {
  key: number;
  odd: string;
  label: string;
  going: boolean;
  /** The hand-off it serves: its own, or the one whose ask a carry-out answers. */
  handOff?: number;
  steps: number;
};
type Record_ = {
  serial: number;
  /** Every run going or queued, in the order it joined. */
  runs: Run[];
  /** Follow-ups yet to start. */
  waiting: { id: number; odd: string }[];
  /** Every hand-off follow-up ever added. */
  handOffs: { id: number; odd: string }[];
  chats: Set<string>;
  asks: { id: number; odd: string }[];
  tasks: { id: number; odd: string | null }[];
  messages: Set<string>;
  threads: { hub: string; holder: string; title: string }[];
  activity: Record<string, Activity>;
  last?: Event;
};

type State = { snap: Snapshot; before: Record<string, OddNow>; now: Record<string, OddNow> };

const start = (): { state: State; record: Record_ } => {
  const activity = Object.fromEntries(IDS.map((id) => [id, 'work' as Activity]));
  const snap: Snapshot = {
    ids: IDS,
    inProgress: {},
    toStart: {},
    chatting: [],
    desk: deskOf([], []),
    staff: [],
    messages: {},
    threads: [],
    activity,
    nameOf
  };
  const now = oddNow(snap);
  return {
    state: { snap, before: now, now },
    record: {
      serial: 1,
      runs: [],
      waiting: [],
      handOffs: [],
      chats: new Set(),
      asks: [],
      tasks: [],
      messages: new Set(),
      threads: [],
      activity: { ...activity }
    }
  };
};

/** Every event valid now, each payload listed from the record. */
function next(r: Record_): Event[] {
  const out: Event[] = [];
  const key = r.serial;
  for (const odd of IDS) {
    const runs = r.runs.filter((x) => x.odd === odd).length;
    if (runs < RUNS_EACH)
      for (const label of RUN_LABELS) out.push({ kind: 'runQueued', odd, key, label });
    if (r.waiting.filter((w) => w.odd === odd).length < 2)
      out.push({ kind: 'followUpAdded', odd, id: key });
    out.push(r.chats.has(odd) ? { kind: 'chatEnded', odd } : { kind: 'chatStarted', odd });
    if (!r.asks.some((a) => a.odd === odd)) out.push({ kind: 'askRaised', odd, id: key });
    if (!r.tasks.some((t) => t.odd === odd)) out.push({ kind: 'taskGiven', odd, id: key });
    out.push(r.messages.has(odd) ? { kind: 'messageRead', odd } : { kind: 'messageSent', odd });
    for (const activity of PLACES)
      if (activity !== r.activity[odd]) out.push({ kind: 'activityChanged', odd, activity });
    for (const holder of IDS) {
      const title = `${nameOf(odd)}'s work with ${nameOf(holder)}`;
      if (holder !== odd && r.threads.length < 3 && !r.threads.some((t) => t.title === title))
        out.push({ kind: 'threadHeld', hub: odd, holder, title });
    }
  }
  if (!r.tasks.some((t) => t.odd === null)) out.push({ kind: 'taskGiven', odd: null, id: key });
  for (const x of r.runs) {
    if (x.going) {
      out.push({ kind: 'toolStep', key: x.key, tool: TOOLS[x.steps % TOOLS.length] });
      out.push({ kind: 'runEnded', key: x.key });
    } else {
      out.push({ kind: 'runStarted', key: x.key });
      out.push({ kind: 'queuedRunDropped', key: x.key });
    }
  }
  for (const w of r.waiting)
    if (r.runs.filter((x) => x.odd === w.odd).length < RUNS_EACH)
      out.push({ kind: 'followUpClaimed', odd: w.odd, id: w.id, key });
  // Once a hand-off's own run is claimed, the owner's yes to what it asked can start a carry-out.
  for (const h of r.handOffs)
    if (
      !r.waiting.some((w) => w.id === h.id) &&
      r.runs.filter((x) => x.odd === h.odd).length < RUNS_EACH
    )
      out.push({ kind: 'carryOutClaimed', odd: h.odd, handOff: h.id, key });
  for (const a of r.asks) out.push({ kind: 'askAnswered', id: a.id });
  for (const t of r.tasks) out.push({ kind: 'taskEnded', id: t.id });
  for (const t of r.threads) out.push({ kind: 'threadReleased', title: t.title });
  return out;
}

function note(r: Record_, e: Event): void {
  r.last = e;
  const run = (key: number) => r.runs.find((x) => x.key === key);
  switch (e.kind) {
    case 'runQueued':
      r.runs.push({ key: e.key, odd: e.odd, label: e.label, going: false, steps: 0 });
      r.serial++;
      return;
    case 'runStarted':
      run(e.key)!.going = true;
      return;
    case 'toolStep':
      run(e.key)!.steps++;
      return;
    case 'runEnded':
    case 'queuedRunDropped':
      r.runs = r.runs.filter((x) => x.key !== e.key);
      return;
    case 'followUpAdded':
      r.waiting.push({ id: e.id, odd: e.odd });
      r.handOffs.push({ id: e.id, odd: e.odd });
      r.serial++;
      return;
    case 'followUpClaimed':
      r.waiting = r.waiting.filter((w) => w.id !== e.id);
      r.runs.push({
        key: e.key,
        odd: e.odd,
        label: HAND_OFF_LABEL,
        going: false,
        handOff: e.id,
        steps: 0
      });
      r.serial++;
      return;
    case 'carryOutClaimed':
      r.runs.push({
        key: e.key,
        odd: e.odd,
        label: CARRY_OUT_LABEL,
        going: false,
        handOff: e.handOff,
        steps: 0
      });
      r.serial++;
      return;
    case 'chatStarted':
      r.chats.add(e.odd);
      return;
    case 'chatEnded':
      r.chats.delete(e.odd);
      return;
    case 'askRaised':
      r.asks.push({ id: e.id, odd: e.odd });
      r.serial++;
      return;
    case 'askAnswered':
      r.asks = r.asks.filter((a) => a.id !== e.id);
      return;
    case 'taskGiven':
      r.tasks.push({ id: e.id, odd: e.odd });
      r.serial++;
      return;
    case 'taskEnded':
      r.tasks = r.tasks.filter((t) => t.id !== e.id);
      return;
    case 'messageSent':
      r.messages.add(e.odd);
      return;
    case 'messageRead':
      r.messages.delete(e.odd);
      return;
    case 'threadHeld':
      r.threads.push({ hub: e.hub, holder: e.holder, title: e.title });
      return;
    case 'threadReleased':
      r.threads = r.threads.filter((t) => t.title !== e.title);
      return;
    case 'activityChanged':
      r.activity[e.odd] = e.activity;
      return;
  }
}

/** The page's snapshot after the event, as the server's views would send it. */
function apply(s: Snapshot, e: Event): Snapshot {
  const runs = (each: (w: Work) => Work | undefined) =>
    Object.fromEntries(
      Object.entries(s.inProgress).map(([id, list]) => [id, list.flatMap((w) => each(w) ?? [])])
    );
  const withRun = (odd: string, w: Work) => ({
    ...s.inProgress,
    [odd]: [...(s.inProgress[odd] ?? []), w]
  });
  switch (e.kind) {
    case 'runQueued':
      return { ...s, inProgress: withRun(e.odd, work(e.key, e.label)) };
    case 'runStarted':
      return { ...s, inProgress: runs((w) => (w.id === e.key ? { ...w, queued: false } : w)) };
    case 'toolStep':
      return {
        ...s,
        inProgress: runs((w) => (w.id === e.key ? { ...w, steps: w.steps + 1, doing: e.tool } : w))
      };
    case 'runEnded':
    case 'queuedRunDropped':
      return { ...s, inProgress: runs((w) => (w.id === e.key ? undefined : w)) };
    case 'followUpAdded': {
      const item = work(-e.id, HAND_OFF_LABEL, {
        kind: 'follow-up',
        detail: 'Work handed over',
        toStart: true
      });
      return { ...s, toStart: { ...s.toStart, [e.odd]: [...(s.toStart[e.odd] ?? []), item] } };
    }
    case 'followUpClaimed':
      return {
        ...s,
        toStart: { ...s.toStart, [e.odd]: (s.toStart[e.odd] ?? []).filter((w) => w.id !== -e.id) },
        inProgress: withRun(
          e.odd,
          work(e.key, HAND_OFF_LABEL, { kind: 'follow-up', handOffId: e.id })
        )
      };
    case 'carryOutClaimed':
      return {
        ...s,
        inProgress: withRun(
          e.odd,
          work(e.key, CARRY_OUT_LABEL, { kind: 'follow-up', handOffId: e.handOff })
        )
      };
    case 'chatStarted':
      return { ...s, chatting: [...s.chatting, e.odd] };
    case 'chatEnded':
      return { ...s, chatting: s.chatting.filter((id) => id !== e.odd) };
    case 'askRaised':
      return { ...s, desk: deskOf([...s.desk.asks, { id: e.id, staffId: e.odd }], s.desk.tasks) };
    case 'askAnswered':
      return {
        ...s,
        desk: deskOf(
          s.desk.asks.filter((a) => a.id !== e.id),
          s.desk.tasks
        )
      };
    case 'taskGiven':
      return { ...s, desk: deskOf(s.desk.asks, [...s.desk.tasks, { id: e.id, staffId: e.odd }]) };
    case 'taskEnded':
      return {
        ...s,
        desk: deskOf(
          s.desk.asks,
          s.desk.tasks.filter((t) => t.id !== e.id)
        )
      };
    case 'messageSent':
      return { ...s, messages: { ...s.messages, [e.odd]: 1 } };
    case 'messageRead': {
      const { [e.odd]: _read, ...messages } = s.messages;
      return { ...s, messages };
    }
    case 'threadHeld':
      return {
        ...s,
        threads: [...s.threads, { title: e.title, hubId: e.hub, holderId: e.holder }]
      };
    case 'threadReleased':
      return { ...s, threads: s.threads.filter((t) => t.title !== e.title) };
    case 'activityChanged':
      return { ...s, activity: { ...s.activity, [e.odd]: e.activity } };
  }
}

// What the record says each Odd should show, in the test's own words.

const going = (r: Record_, id: string) => r.runs.filter((x) => x.odd === id && x.going);
const queuedRuns = (r: Record_, id: string) => r.runs.filter((x) => x.odd === id && !x.going);
const waitingOf = (r: Record_, id: string) => r.waiting.filter((w) => w.odd === id);
const waitsOnOwner = (r: Record_, id: string) =>
  r.messages.has(id) || r.asks.some((a) => a.odd === id) || r.tasks.some((t) => t.odd === id);

function expectedShow(r: Record_, id: string): Show['is'] {
  if (r.messages.has(id)) return 'message';
  if (waitsOnOwner(r, id)) return 'waitingOnYou';
  if (r.threads.some((t) => t.holder === id)) return 'holding';
  if (r.threads.some((t) => t.hub === id)) return 'leading';
  if (r.chats.has(id)) return 'chatting';
  if (going(r, id).length > 0) return 'running';
  if (queuedRuns(r, id).length + waitingOf(r, id).length > 0) return 'queued';
  return 'free';
}

/** The Jobs tab's "Running <words> now.", and a running Odd's line: the first run going and how many more. */
function expectedRunWords(r: Record_, id: string): string | undefined {
  const [first, ...more] = going(r, id).map((x) => x.label);
  if (first === undefined) return undefined;
  return more.length > 0 ? `${first} +${more.length} more` : first;
}

function expectedWords(r: Record_, id: string): string {
  const shows = expectedShow(r, id);
  const place = r.activity[id];
  switch (shows) {
    case 'message':
      return 'Has a message for you';
    case 'waitingOnYou':
      return 'Waiting on you';
    case 'holding': {
      const t = r.threads.find((x) => x.holder === id)!;
      return `${t.title} · with ${nameOf(t.hub)}`;
    }
    case 'leading': {
      const t = r.threads.find((x) => x.hub === id)!;
      return going(r, id).length > 0
        ? `${t.title} · with ${nameOf(t.holder)}`
        : `Waiting on ${nameOf(t.holder)}`;
    }
    case 'chatting':
      return 'Replying to you';
    case 'running':
      return expectedRunWords(r, id)!;
    case 'queued':
      return ACTIVITY_LABEL[place];
    case 'free':
      return place === 'work' ? 'At their desk' : ACTIVITY_LABEL[place];
  }
}

/** What every screen shows, read through the word functions the screens call. */
const screens = (n: OddNow) => ({
  show: n.show.is,
  tag: tagWords(n),
  headed: tagWords(n, HEADING),
  line: lineWords(n),
  work: workItems(n).map((w) => [w.id, !!w.toStart]),
  count: railCount(n),
  ring: railRing(n),
  jobsLine: runWords(n),
  runNowLocked: n.runs.length > 0
});

/** The same, from the record. */
const expectedScreens = (r: Record_, id: string) => ({
  show: expectedShow(r, id),
  tag: expectedWords(r, id),
  headed: `→ ${HEADING}`,
  line: expectedWords(r, id),
  work: [
    ...going(r, id).map((x) => [x.key, false]),
    ...queuedRuns(r, id).map((x) => [x.key, false]),
    ...waitingOf(r, id).map((w) => [-w.id, true])
  ],
  count: r.runs.filter((x) => x.odd === id).length + waitingOf(r, id).length,
  ring: waitsOnOwner(r, id),
  jobsLine: expectedRunWords(r, id),
  runNowLocked: going(r, id).length > 0
});

/** Whether the card's tabs reload after each kind of event: only a run starting or ending. */
const RELOADS: Record<Event['kind'], boolean> = {
  runQueued: false,
  runStarted: true,
  toolStep: false,
  runEnded: true,
  queuedRunDropped: false,
  followUpAdded: false,
  followUpClaimed: false,
  carryOutClaimed: false,
  chatStarted: false,
  chatEnded: false,
  askRaised: false,
  askAnswered: false,
  taskGiven: false,
  taskEnded: false,
  messageSent: false,
  messageRead: false,
  threadHeld: false,
  threadReleased: false,
  activityChanged: false
};

type Check = (now: Record<string, OddNow>, r: Record_, before: Record<string, OddNow>) => string[];

/**
 * Runs the random sequences against one rule and gathers what they reached,
 * so each test can show its rule met the cases that matter.
 */
function sequences(rule: string, check: Check): { failed: unknown; seen: Set<string> } {
  const seen = new Set<string>();
  const x: Explore<State, Event, Record_> = {
    start: () => start(),
    next,
    step: (state, e) => {
      const snap = apply(state.snap, e);
      return { snap, before: state.now, now: oddNow(snap) };
    },
    note,
    broken: (state, r) => {
      seen.add(r.last!.kind);
      for (const id of IDS) {
        const runs = going(r, id);
        seen.add(`${expectedShow(r, id)}${runs.length > 0 ? ' with a run going' : ''}`);
        if (runs.length > 1) seen.add('two runs going');
        if (runs[0]?.label === HELLO) seen.add('a hello going first');
        if (runs.some((x) => x.label === CATCH_UP) && !runs.some((x) => x.label === JOBS[0]))
          seen.add('a catch-up going without its job');
        if (expectedShow(r, id) === 'holding' && runs.some((x) => x.handOff !== undefined))
          seen.add('holding while its hand-off run goes');
        if (runs.some((x) => x.label === CARRY_OUT_LABEL)) seen.add('a carry-out going');
        if (expectedShow(r, id) === 'free' && r.activity[id] === 'work') seen.add('free at work');
      }
      return check(state.now, r, state.before).map((detail) => ({ rule, detail }));
    }
  };
  return { failed: explore(x, { seeds: SEEDS, length: LENGTH }), seen };
}

const reached = (seen: Set<string>, cases: string[]) =>
  assert.deepEqual(
    cases.filter((c) => !seen.has(c)),
    [],
    'the sequences never reached these cases'
  );

test('every screen shows the state the record says, and the work list, rail and Jobs tab follow the runs whatever the Odd shows', () => {
  const { failed, seen } = sequences('every screen shows the state the record says', (now, r) =>
    IDS.flatMap((id) => {
      const shown = JSON.stringify(screens(now[id]));
      const want = JSON.stringify(expectedScreens(r, id));
      return shown === want ? [] : [`${id} shows ${shown}, the record says ${want}`];
    })
  );
  assert.equal(failed, undefined);
  reached(seen, [
    'message with a run going',
    'waitingOnYou with a run going',
    'holding with a run going',
    'leading with a run going',
    'leading',
    'chatting with a run going',
    'running with a run going',
    'queued',
    'free'
  ]);
});

test('an Odd with nothing going on and nothing for the owner says nothing of working, running or waiting on you', () => {
  const idle = (r: Record_, id: string) =>
    r.runs.every((x) => x.odd !== id) &&
    waitingOf(r, id).length === 0 &&
    !r.chats.has(id) &&
    !waitsOnOwner(r, id) &&
    !r.threads.some((t) => t.hub === id || t.holder === id) &&
    // The floor sends an Odd to the owner's door only while it waits on them.
    r.activity[id] !== 'wait';
  const { failed, seen } = sequences('an idle Odd claims no work', (now, r) =>
    IDS.filter((id) => idle(r, id)).flatMap((id) => {
      const n = now[id];
      const said = [tagWords(n), lineWords(n), runWords(n) ?? ''];
      const claims = said.filter((w) => /Working|Running|Waiting on you/.test(w));
      return claims.length > 0 || railRing(n) || railCount(n) > 0
        ? [`${id} is idle and shows ${JSON.stringify(screens(n))}`]
        : [];
    })
  );
  assert.equal(failed, undefined);
  reached(seen, ['free at work']);
});

test('a job shows Running exactly while a run with its name goes, and Run now is locked exactly while any run goes', () => {
  const { failed, seen } = sequences('the Jobs tab follows the runs going', (now, r) =>
    IDS.flatMap((id) => {
      const runs = going(r, id);
      const shown = JOBS.map((job) => jobRunning(now[id], job));
      const want = JOBS.map((job) => runs.some((x) => x.label === job));
      const locked = now[id].runs.length > 0;
      return JSON.stringify(shown) === JSON.stringify(want) && locked === runs.length > 0
        ? []
        : [
            `${id} shows ${JOBS} running as ${shown}, locked ${locked}; the record says ${want}, ${runs.length} going`
          ];
    })
  );
  assert.equal(failed, undefined);
  reached(seen, [
    'two runs going',
    'a catch-up going without its job',
    'waitingOnYou with a run going',
    'holding with a run going'
  ]);
});

test('a colleague is on a hand-off exactly while a run serving it goes, its own or a carry-out, whatever it shows', () => {
  const { failed, seen } = sequences(
    'a hand-off is on it only while a run serving it goes',
    (now, r) =>
      r.handOffs.flatMap((h) =>
        [...IDS, GONE].flatMap((id) => {
          const line = handOff({ id: h.id, toId: id, to: nameOf(id) });
          const onIt = handOffProgress(line, nowIn(now)).text === `${nameOf(id)} is on it`;
          const want = going(r, id).some((x) => x.handOff === h.id);
          return onIt === want
            ? []
            : [`${id} reads as on hand-off ${h.id}: ${onIt}, the record says ${want}`];
        })
      )
  );
  assert.equal(failed, undefined);
  reached(seen, [
    'holding while its hand-off run goes',
    'a carry-out going',
    'followUpClaimed',
    'carryOutClaimed',
    'runStarted'
  ]);
});

test('an Odd shows Replying to you exactly while its chat reply goes and nothing above it holds, and a hello reads as a run', () => {
  const { failed, seen } = sequences(
    'a chat reply shows above runs, and a hello is not one',
    (now, r) =>
      IDS.flatMap((id) => {
        const above = waitsOnOwner(r, id) || r.threads.some((t) => t.hub === id || t.holder === id);
        const replying = r.chats.has(id) && !above;
        const line = lineWords(now[id]);
        if ((line === 'Replying to you') !== replying)
          return [`${id} says "${line}", replying ${replying}`];
        if (
          !replying &&
          !above &&
          going(r, id)[0]?.label === HELLO &&
          line !== expectedRunWords(r, id)
        )
          return [`${id}'s hello reads "${line}"`];
        return [];
      })
  );
  assert.equal(failed, undefined);
  reached(seen, ['chatting with a run going', 'chatting', 'a hello going first']);
});

test("the card's tabs reload when a run starts or ends, and never on a tool step, a queued run or a chat reply", () => {
  const { failed, seen } = sequences(
    "the card's tabs reload only when a run starts or ends",
    (now, r, before) => {
      const kind = r.last!.kind;
      const reloads = runsChanged(before, now);
      return reloads === RELOADS[kind] ? [] : [`after ${kind} the tabs reload: ${reloads}`];
    }
  );
  assert.equal(failed, undefined);
  reached(seen, Object.keys(RELOADS));
});

test("the floor sends an Odd to the door while it waits on the owner, and to its job's place while a run goes or it waits on a colleague", () => {
  const { failed, seen } = sequences('the floor follows the state', (now, r) =>
    IDS.flatMap((id) => {
      const place = floorMode(now[id], JOB_PLACE);
      const want = waitsOnOwner(r, id)
        ? 'wait'
        : going(r, id).length > 0 || expectedShow(r, id) === 'leading'
          ? JOB_PLACE
          : undefined;
      return place === want ? [] : [`${id} goes to ${place}, the record says ${want}`];
    })
  );
  assert.equal(failed, undefined);
  reached(seen, ['leading', 'holding with a run going', 'chatting with a run going', 'queued']);
});

/** The office with Bo running the hand-off above, and Dee, who has left, not on the roster. */
const handOffOffice = (): Snapshot => ({
  ids: IDS,
  inProgress: { bo: [work(1, HAND_OFF_LABEL, { kind: 'follow-up', queued: false, handOffId: 7 })] },
  toStart: {},
  chatting: [],
  desk: deskOf([], []),
  staff: IDS.map((id) => ({ id, name: NAMES[id] }) as StaffProfile),
  messages: {},
  threads: [],
  activity: Object.fromEntries(IDS.map((id) => [id, 'work' as Activity])),
  nameOf
});

test("the page's reader props give an Odd's screens its own state, any colleague's by id, and none for one who has left", () => {
  const snap = handOffOffice();
  const all = oddNow(snap);
  const onplan = (_hires: AskRow[]) => {};
  const props = readerProps(snap, all, 'ada', onplan);
  assert.equal(props.now, all.ada);
  assert.equal(props.nowOf('bo'), all.bo);
  assert.equal(props.nowOf(GONE), undefined);
  assert.equal(props.nowOf('constructor'), undefined);
  assert.equal(props.desk, snap.desk);
  assert.equal(props.staff, snap.staff);
  assert.equal(props.onplan, onplan);
});

test('a hand-off line says the colleague is on it only while a run serving that hand-off goes', () => {
  const snap = handOffOffice();
  const { nowOf } = readerProps(snap, oddNow(snap), 'ada', () => {});
  assert.deepEqual(handOffProgress(handOff({}), nowOf), { text: 'Bo is on it', yours: false });
  // Bo's other runs do not count: only its run for this hand-off.
  assert.deepEqual(handOffProgress(handOff({ id: 8 }), nowOf), {
    text: 'Bo has not started yet',
    yours: false
  });
  const idle = { ...snap, inProgress: { bo: [work(2, 'Morning brief', { queued: false })] } };
  assert.deepEqual(
    handOffProgress(handOff({}), readerProps(idle, oddNow(idle), 'ada', () => {}).nowOf),
    {
      text: 'Bo has not started yet',
      yours: false
    }
  );
});

test('a hand-off line keeps its words for a finished step and for a colleague who has left', () => {
  const snap = handOffOffice();
  const { nowOf } = readerProps(snap, oddNow(snap), 'ada', () => {});
  const left = handOff({ toId: GONE, to: 'Dee', status: 'failed' });
  assert.equal(nowOf(GONE), undefined);
  assert.deepEqual(handOffProgress(left, nowOf), {
    text: 'Dee could not finish · Ada is taking it from here',
    yours: false
  });
  assert.equal(handOffWords(handOff({ status: 'queued' }), false).text, 'Bo has not started yet');
  assert.deepEqual(handOffWords(handOff({ status: 'waiting' }), false), {
    text: 'Bo is waiting on you · Ada is taking it from here',
    yours: true
  });
  assert.equal(
    handOffWords(handOff({ status: 'done' }), false).text,
    'Bo finished · Ada is taking it from here'
  );
});

/** Bo's step came back waiting on the owner, who said yes. */
const back = {
  at: new Date('2026-11-12T10:00:00.000Z'),
  outcome: 'waiting' as const,
  text: 'Asked the owner',
  answered: true,
  pickUp: { status: 'done' as const }
};

test('a running hand-off line reads on it, back on it, getting back to it or not started, by whether a run goes and whether a step came back', () => {
  for (const status of ['queued', 'working'] as const) {
    const fresh = handOff({ status });
    const returned = handOff({ status, backs: [back] });
    assert.equal(handOffWords(fresh, true).text, 'Bo is on it');
    assert.equal(handOffWords(returned, true).text, 'Bo is back on it');
    assert.equal(handOffWords(returned, false).text, 'Bo is getting back to it');
    assert.equal(handOffWords(fresh, false).text, 'Bo has not started yet');
  }
});

test("a hand-off line says the colleague is back on it while its carry-out of the owner's yes goes", () => {
  // Bo now carries the owner's yes out.
  const line = handOff({ backs: [back] });
  const carrying = (handOffId: number): Snapshot => ({
    ...handOffOffice(),
    inProgress: {
      bo: [work(2, CARRY_OUT_LABEL, { kind: 'follow-up', queued: false, handOffId })]
    }
  });
  const read = (snap: Snapshot) =>
    handOffProgress(line, readerProps(snap, oddNow(snap), 'ada', () => {}).nowOf);
  assert.deepEqual(read(carrying(7)), { text: 'Bo is back on it', yours: false });
  // A carry-out for another hand-off is not this one's.
  assert.deepEqual(read(carrying(8)), { text: 'Bo is getting back to it', yours: false });
});
