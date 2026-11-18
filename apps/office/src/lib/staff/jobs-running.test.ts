// The Jobs section says a job is running only for a job's run. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import {
  HAND_OFF_LABEL,
  IDS,
  JOBS,
  NAMES,
  nameOf,
  work,
  deskOf
} from '#lib/staff/odd-now-cases.ts';
import { oddNow, type Snapshot } from '#lib/staff/odd-now.ts';
import type { Activity, StaffProfile } from '#lib/staff/roster.ts';
import type { Work } from '#lib/staff/work.ts';

/** The Jobs section's markup for Ada with these runs going. */
async function jobsWith(runs: Work[]): Promise<string> {
  register('./svelte-load.ts', import.meta.url);
  const { render } = await import('svelte/server');
  const JobsSection = (await import('#lib/ui/JobsSection.svelte')).default;
  const snap: Snapshot = {
    ids: IDS,
    inProgress: { ada: runs },
    toStart: {},
    chatting: [],
    desk: deskOf([], []),
    staff: IDS.map((id) => ({ id, name: NAMES[id] }) as StaffProfile),
    messages: {},
    threads: [],
    activity: Object.fromEntries(IDS.map((id) => [id, 'work' as Activity])),
    nameOf
  };
  const profile = { id: 'ada', name: 'Ada' } as StaffProfile;
  return render(JobsSection, { props: { profile, version: 0, now: oddNow(snap).ada } }).body;
}

test("the Jobs section does not call a hand-off's run a running job", async () => {
  const body = await jobsWith([
    work(1, HAND_OFF_LABEL, { kind: 'follow-up', queued: false, handOffId: 7 })
  ]);
  assert.ok(!body.includes(`Running ${HAND_OFF_LABEL}`), body.slice(0, 400));
  assert.ok(body.includes('What it does on its own, and how often'), body.slice(0, 400));
});

test("the Jobs section names a job's run as running, beside other work", async () => {
  const body = await jobsWith([
    work(1, HAND_OFF_LABEL, { kind: 'follow-up', queued: false, handOffId: 7 }),
    work(2, JOBS[0], { queued: false })
  ]);
  assert.ok(body.includes(`Running ${JOBS[0]} now.`), body.slice(0, 400));
});
