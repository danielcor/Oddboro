// Slot admission and Stop share one registry, including work still in line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { L } from './office-under-test.ts';
const { slot, inProgress, chatting, stopRuns, runsActive } = await import('./run-state.ts');

test('three background runs start, a fourth waits, and the next starts only as one ends', async (t) => {
  const held = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const entered: number[] = [];
  const runs = held.map((hold, i) =>
    slot('paige', { kind: 'job', label: `Job ${i}`, detail: 'Counting' }, async (onEvent, key) => {
      entered.push(i);
      assert.ok(L.runsGoing.has(key));
      onEvent({ type: 'tool', name: 'Read' });
      await hold.promise;
      return i;
    })
  );
  try {
    assert.deepEqual(entered, [0, 1, 2]);
    assert.equal(inProgress().paige[3].queued, true);
    assert.equal(inProgress().paige[0].steps, 1);
    assert.deepEqual(
      inProgress()
        .paige.filter((w) => !w.queued)
        .map((w) => w.label),
      ['Job 0', 'Job 1', 'Job 2']
    );
    held[0].resolve();
    await t.waitFor(() => assert.deepEqual(entered, [0, 1, 2, 3]));
    assert.equal(inProgress().paige.filter((w) => w.queued).length, 0);
  } finally {
    for (const h of held) h.resolve();
    assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3]);
  }
  assert.equal(runsActive(), false);
  assert.deepEqual(inProgress(), {});
});

test('an Odd leaving aborts both running and queued work without leaving a busy slot', async () => {
  const runs = Array.from({ length: 4 }, (_, i) =>
    slot('paige', { kind: 'job', label: `Job ${i}`, detail: 'Counting' }, async (_event, key) => {
      const live = L.runsGoing.get(key)!;
      if (!live.stop.signal.aborted)
        await new Promise<void>((done) =>
          live.stop.signal.addEventListener('abort', () => done(), { once: true })
        );
      return live.stop.signal.reason;
    })
  );
  stopRuns('paige');
  assert.deepEqual(await Promise.all(runs), ['left', 'left', 'left', 'left']);
  assert.equal(runsActive(), false);
  assert.deepEqual(inProgress(), {});
});

test("a new hire's hello is not a chat reply: chatting() leaves it out and its work keeps the label Saying hello", async () => {
  const reply = L.reserveRun({ staffId: 'paige', kind: 'chat', turnId: 'turn-1' });
  try {
    await slot(
      'newbie',
      { kind: 'draft', label: 'Saying hello', detail: 'Introducing themselves' },
      async () => {
        assert.deepEqual(chatting(), ['paige']);
        assert.equal(inProgress().newbie[0].label, 'Saying hello');
      },
      { greeting: true }
    );
  } finally {
    L.releaseRun(reply);
  }
  assert.deepEqual(chatting(), []);
});
