// The dates an Odd reads in my_goals are the office's days, as a run sees them:
// the office tool server (src/mcp.ts) in a process of its own, over the office's
// own database in a throwaway folder. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db, toolServer } from './tool-server.ts';

const { goalProgress, goals, staff, staffGoals } = await import('../src/schema.ts');

await db.insert(staff).values({
  id: 'penny',
  name: 'Penny',
  role: 'Writer',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  desk: 'You are Penny.'
});
const [goal] = await db.insert(goals).values({ title: 'A newsletter every Friday' }).returning();
await db.insert(staffGoals).values({ staffId: 'penny', goalId: goal.id, part: 'all of it' });
// 8:30 PM in New York on Nov 3 is 01:30 UTC on Nov 4.
await db.insert(goalProgress).values({
  goalId: goal.id,
  staffId: 'penny',
  health: 'on_track',
  note: 'Issue 1 drafted.',
  createdAt: new Date('2026-11-04T01:30:00Z')
});

const client = await toolServer('penny', {
  RUN_KEY: 'k-goal-day',
  OFFICE_TIME_ZONE: 'America/New_York'
});

test("progress logged on an evening in New York reads as that day in my_goals, not tomorrow's UTC date", async () => {
  const r = await client.callTool({ name: 'my_goals', arguments: {} });
  const said = (r.content as { type: string; text: string }[])[0]?.text ?? '';
  assert.match(said, /- 2026-11-03 Penny: /);
  assert.doesNotMatch(said, /2026-11-04/);
});
