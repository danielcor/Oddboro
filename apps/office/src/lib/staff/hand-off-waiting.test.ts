// A hand-off line says "Waiting on you" only while the desk holds something
// of the work. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HandBack } from '@oddboro/ledger';
import { handOff } from './odd-now-cases.ts';
import { handOffWords } from './odd-now.ts';

const backOf = (outcome: HandBack['outcome'], pickUp: HandBack['pickUp']['status']): HandBack => ({
  at: new Date('2026-11-12T10:00:00.000Z'),
  outcome,
  text: 'Back',
  answered: false,
  pickUp: { status: pickUp }
});

test("a hand-off line whose lead's pick-up ended waiting does not ask the owner once they answered what it raised", () => {
  // Bo finished; Ada's pick-up raised an ask on the work and ended waiting,
  // and the owner has since answered it. Nothing is on the desk: the line's
  // pick-up status is that run's outcome, which never changes after it.
  const line = handOff({ status: 'done', backs: [backOf('done', 'waiting')] });
  assert.deepEqual(handOffWords(line, false), { text: 'Bo finished', yours: false });
});

test("with nothing of it on the desk, a step that ended waiting reads as the lead's pick-up ended", () => {
  // The ledger reads a step that ended waiting with nothing open as done.
  const picked = handOff({ status: 'done', backs: [backOf('waiting', 'done')] });
  assert.deepEqual(handOffWords(picked, false), { text: 'Done', yours: false });
  const failed = handOff({ status: 'done', backs: [backOf('waiting', 'failed')] });
  assert.deepEqual(handOffWords(failed, false), { text: 'Ada could not pick it up', yours: false });
  const going = handOff({ status: 'done', backs: [backOf('waiting', 'working')] });
  assert.deepEqual(handOffWords(going, false), {
    text: 'Bo finished · Ada is taking it from here',
    yours: false
  });
});

test('a hand-off line asks the owner while something of it is on the desk, however the pick-up ended', () => {
  for (const pickUp of ['done', 'waiting', 'failed'] as const) {
    const line = handOff({ status: 'waiting', backs: [backOf('waiting', pickUp)] });
    assert.deepEqual(handOffWords(line, false), { text: 'Waiting on you', yours: true });
  }
});
