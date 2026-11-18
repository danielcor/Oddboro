// Random event sequences for tests, and the shrink that cuts a failure down
// to its shortest form. A test describes its system and its rules once as an
// `Explore`, and `explore` drives seeded random runs through it.
//
// This file imports nothing, so a test in any package can load it.

/** Mulberry32: the same seed always gives the same numbers, each in [0, 1). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What a test tells `explore`. Events are plain data. `explore` picks each one
 * from what `next` offers, with the seed's own draw. On a replay, an event
 * counts as still valid when `next` offers one that serialises the same: by
 * value, since `next` makes fresh events on every call.
 */
export type Explore<S, E, R> = {
  /**
   * A fresh state and the test's own record of what is true, built only from
   * events. Never keep `rnd` in the record: `next` would then draw from it,
   * and the shrink would keep events that do nothing.
   */
  start: (rnd: () => number) => { state: S; record: R };
  /**
   * Every event valid now, values included, from the record alone: never from
   * the system's answer, and never from a random draw. A test that wants
   * varied values lists each one. A draw here would offer other events on a
   * replay than on the run, so the shrink would keep events it should drop.
   */
  next: (record: R) => E[];
  /** The system under test: production code. */
  step: (state: S, event: E) => S;
  /** The test's own record of the event. */
  note: (record: R, event: E) => void;
  /** Each rule broken after this event, as { rule, detail }. Equality, never "at most". */
  broken: (state: S, record: R, events: E[]) => { rule: string; detail: string }[];
};

/**
 * Runs `seeds` random sequences of up to `length` events, one per seed from
 * `from`. Returns nothing when every rule held, or the first failing seed
 * with its broken rule and the shortest events found that still break it.
 * Pass the seed back as `from`, with `seeds: 1`, to replay a failure.
 *
 * The seed count is the caller's: each test file reads its own environment
 * variable, so a long run is one variable away.
 */
export function explore<S, E, R>(
  x: Explore<S, E, R>,
  o: { seeds: number; length: number; from?: number }
): undefined | { seed: number; rule: string; detail: string; events: E[] } {
  const from = o.from ?? 0;
  wholeAtLeast('seeds', o.seeds, 1);
  wholeAtLeast('length', o.length, 1);
  wholeAtLeast('from', from, 0);

  for (let seed = from; seed < from + o.seeds; seed++) {
    const rnd = random(seed);
    const fresh = x.start(rnd);
    let state = fresh.state;
    const events: E[] = [];
    while (events.length < o.length) {
      const offered = x.next(fresh.record);
      if (offered.length === 0) break;
      const event = offered[Math.floor(rnd() * offered.length)];
      state = x.step(state, event);
      x.note(fresh.record, event);
      events.push(event);
      const [first] = x.broken(state, fresh.record, events);
      // The run stops at the first event that breaks a rule, so its events
      // are already the shortest failing prefix.
      if (first) {
        const shrunk = shrink(x, seed, first.rule, { events, detail: first.detail });
        return { seed, rule: first.rule, ...shrunk };
      }
    }
    // A run with no events checked nothing, and passing it would hide that.
    if (events.length === 0) throw new Error(`explore: seed ${seed} generated no events`);
  }
  return undefined;
}

type Failure<E> = { events: E[]; detail: string };

/**
 * Removes one event at a time while the same rule still breaks, until no
 * single removal does.
 */
function shrink<S, E, R>(
  x: Explore<S, E, R>,
  seed: number,
  rule: string,
  failed: Failure<E>
): Failure<E> {
  let best = failed;
  let shorter = true;
  while (shorter) {
    shorter = false;
    for (let i = 0; i < best.events.length;) {
      const tried = replay(x, seed, rule, best.events.toSpliced(i, 1));
      if (tried) {
        best = tried;
        shorter = true;
      } else {
        i++;
      }
    }
  }
  return best;
}

/**
 * Replays `events` from the seed's start. An event the record no longer
 * offers is dropped, since a real run could not have sent it. Stops at the
 * first event that breaks any rule, and returns the events kept when `rule`
 * is among the ones broken there.
 */
function replay<S, E, R>(
  x: Explore<S, E, R>,
  seed: number,
  rule: string,
  events: E[]
): Failure<E> | undefined {
  const fresh = x.start(random(seed));
  let state = fresh.state;
  const kept: E[] = [];
  for (const event of events) {
    const key = JSON.stringify(event);
    if (!x.next(fresh.record).some((e) => JSON.stringify(e) === key)) continue;
    state = x.step(state, event);
    x.note(fresh.record, event);
    kept.push(event);
    const broken = x.broken(state, fresh.record, kept);
    if (broken.length > 0) {
      const same = broken.find((b) => b.rule === rule);
      return same && { events: kept, detail: same.detail };
    }
  }
  return undefined;
}

function wholeAtLeast(name: string, value: number, least: number): void {
  if (!Number.isInteger(value) || value < least) {
    throw new Error(
      `explore: ${name} must be a whole number of at least ${least}, and is ${value}`
    );
  }
}
