// What In progress, the card's header and the floor tag call a follow-up's run,
// with real staff runs in a throwaway office.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { L, folder, followThrough, type Gave } from './office-under-test.ts';

const { inProgress } = await import('./staff.ts');

test(
  "a colleague's run on a hand-off shows the work's title, while its message still names who handed it over",
  { timeout: 60_000 },
  async (t) => {
    const ready = join(folder, 'label-ready');
    const title = `Hold until ${ready} exists.`;
    const h = await L.handOff({
      from: 'lead',
      to: 'paige',
      work: { title, brief: 'Count the seats.' },
      thread: { title: 'Fair seating' }
    });
    assert.ok('id' in h);
    const f = await L.startFollowUp(h.id);
    assert.ok(f);
    const run = followThrough(f);
    try {
      await t.waitFor(() => assert.ok(inProgress().paige?.[0]), { timeout: 20_000 });
      assert.equal(inProgress().paige[0].label, title);
    } finally {
      writeFileSync(ready, '');
    }
    const r = await run;
    const gave: Gave = JSON.parse(r.text.split('\nOutcome:')[0]);
    assert.ok(gave.message.includes(`For Lena: ${title}`), gave.message.slice(0, 300));
  }
);
