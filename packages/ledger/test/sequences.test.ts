// The random-sequence harness drives seeded runs through a toy system and
// cuts each failure down to its shortest form. Later sequence tests rest on
// it, so each test here fails when the part it names breaks.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explore, random, type Explore } from '../src/sequences.ts';

// How many seeds each test runs; set SEQUENCES_SEEDS for a longer run.
const SEEDS = Number(process.env.SEQUENCES_SEEDS ?? 50);

type Move = 'up' | 'down' | 'look';

// A counter whose `up` sticks at `stuckAt` when one is given, and whose
// `down` refuses at 0 the way real code refuses an event that could not happen.
function counter(stuckAt: number | undefined) {
  return (n: number, move: Move): number => {
    if (move === 'down') {
      if (n === 0) throw new Error('nothing to take away');
      return n - 1;
    }
    if (move === 'up') return n === stuckAt ? n : n + 1;
    return n;
  };
}

function counting(
  step: (n: number, move: Move) => number,
  seen: { checks: number; longest: number }
) {
  const x: Explore<number, Move, { count: number }> = {
    start: () => ({ state: 0, record: { count: 0 } }),
    next: (record) => (record.count > 0 ? ['up', 'down', 'look'] : ['up', 'look']),
    step,
    note: (record, move) => {
      if (move === 'up') record.count++;
      if (move === 'down') record.count--;
    },
    broken: (state, record, events) => {
      seen.checks++;
      seen.longest = Math.max(seen.longest, events.length);
      return state === record.count
        ? []
        : [
            {
              rule: 'the counter shows what the events add up to',
              detail: `after ${events.length} events the counter shows ${state} where the events make ${record.count}`
            }
          ];
    }
  };
  return x;
}

// Breaks only once ten events have gone, so no shorter sequence fails and
// the events come back as generated.
const tenDigits: Explore<null, number, null> = {
  start: () => ({ state: null, record: null }),
  next: () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  step: (state) => state,
  note: () => {},
  broken: (_state, _record, events) =>
    events.length === 10 ? [{ rule: 'ten events', detail: events.join('') }] : []
};

test('the same seed gives the same sequence', () => {
  const draws = (seed: number) => Array.from({ length: 1000 }, random(seed));
  assert.deepEqual(draws(7), draws(7));
  assert.notDeepEqual(draws(8), draws(7));
  assert.ok(draws(7).every((d) => d >= 0 && d < 1));

  const first = explore(tenDigits, { seeds: 1, length: 10, from: 7 });
  assert.equal(first?.seed, 7);
  assert.equal(first?.events.length, 10);
  assert.equal(first?.detail, first?.events.join(''));
  assert.deepEqual(explore(tenDigits, { seeds: 1, length: 10, from: 7 }), first);
  assert.notDeepEqual(explore(tenDigits, { seeds: 1, length: 10, from: 8 })?.events, first?.events);
});

test('a toy counter that breaks its rule at 3 is shrunk to the three events that break it', () => {
  const seen = { checks: 0, longest: 0 };
  const x = counting(counter(2), seen);
  for (let seed = 0; seed < SEEDS; seed++) {
    assert.deepEqual(explore(x, { seeds: 1, length: 200, from: seed }), {
      seed,
      rule: 'the counter shows what the events add up to',
      detail: 'after 3 events the counter shows 2 where the events make 3',
      events: ['up', 'up', 'up']
    });
  }
  // Some runs failed after more than three events, so the shrink had work to do.
  assert.ok(seen.longest > 3, `the longest failing run had ${seen.longest} events`);
});

test('shrinking keeps the rule that broke, never trading it for another', () => {
  const counted = counting(counter(2), { checks: 0, longest: 0 });
  // A second rule that only a cut-down run tends to reach: dropping an early
  // up can move a later down to second place.
  const twoRules: typeof counted = {
    ...counted,
    broken: (state, record, events) => [
      ...counted.broken(state, record, events),
      ...(events.length === 2 && events[1] === 'down'
        ? [{ rule: 'a down never comes second', detail: events.join(' ') }]
        : [])
    ]
  };
  const rules = new Set<string>();
  for (let seed = 0; seed < SEEDS; seed++) {
    const failed = explore(twoRules, { seeds: 1, length: 200, from: seed });
    assert.ok(failed, `seed ${seed} broke no rule`);
    rules.add(failed.rule);
    assert.deepEqual(
      failed,
      failed.rule === 'a down never comes second'
        ? { seed, rule: failed.rule, detail: 'up down', events: ['up', 'down'] }
        : {
            seed,
            rule: 'the counter shows what the events add up to',
            detail: 'after 3 events the counter shows 2 where the events make 3',
            events: ['up', 'up', 'up']
          }
    );
  }
  // Both rules broke somewhere, so each answer above was checked.
  assert.equal(rules.size, 2);
});

type Add = { add: number };

test('a failure among events that carry values is shrunk to the shortest sequence', () => {
  const seen = { longest: 0 };
  // A total that sticks at 2, and refuses a 2 on nothing the way real code
  // refuses an event that could not happen. Each call to `next` makes fresh
  // events, so a replay finds them by value.
  const x: Explore<number, Add, { sum: number }> = {
    start: () => ({ state: 0, record: { sum: 0 } }),
    next: (record) => (record.sum === 0 ? [{ add: 0 }, { add: 1 }] : [{ add: 0 }, { add: 2 }]),
    step: (n, { add }) => {
      if (add === 2 && n === 0) throw new Error('a 2 only follows a 1');
      return Math.min(n + add, 2);
    },
    note: (record, { add }) => {
      record.sum += add;
    },
    broken: (state, record, events) => {
      seen.longest = Math.max(seen.longest, events.length);
      return state === record.sum
        ? []
        : [
            {
              rule: 'the total shows what the events add up to',
              detail: `the total shows ${state} where the events make ${record.sum}`
            }
          ];
    }
  };
  for (let seed = 0; seed < SEEDS; seed++) {
    assert.deepEqual(explore(x, { seeds: 1, length: 200, from: seed }), {
      seed,
      rule: 'the total shows what the events add up to',
      detail: 'the total shows 2 where the events make 3',
      events: [{ add: 1 }, { add: 2 }]
    });
  }
  // Some runs failed with adds of nothing among them, so the shrink had them to cut.
  assert.ok(seen.longest > 2, `the longest failing run had ${seen.longest} events`);
});

test('a rule that is never broken returns nothing', () => {
  const seen = { checks: 0, longest: 0 };
  assert.equal(
    explore(counting(counter(undefined), seen), { seeds: SEEDS, length: 20 }),
    undefined
  );
  // Every event of every run was checked.
  assert.equal(seen.checks, SEEDS * 20);
});

test('explore fails a run that generated no events', () => {
  const none: Explore<null, number, null> = { ...tenDigits, next: () => [] };
  assert.throws(() => explore(none, { seeds: 3, length: 10, from: 4 }), {
    message: 'explore: seed 4 generated no events'
  });
  // A seed count read from an unset variable runs nothing, so it fails too.
  assert.throws(() => explore(tenDigits, { seeds: Number(undefined), length: 10 }), {
    message: 'explore: seeds must be a whole number of at least 1, and is NaN'
  });
  assert.throws(() => explore(tenDigits, { seeds: 0, length: 10 }), {
    message: 'explore: seeds must be a whole number of at least 1, and is 0'
  });
  assert.throws(() => explore(tenDigits, { seeds: 1, length: 0 }), {
    message: 'explore: length must be a whole number of at least 1, and is 0'
  });
});
