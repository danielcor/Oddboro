// A service's stored tools follow what it lists now (`refreshTools`): new and
// dropped tools, Read only's reach both ways, and each tool's description. A
// dropped tool leaves each Odd's standing yes. Nothing changed writes nothing.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { connectors, grants, ledger, staff } from '../src/schema.ts';
import { db } from './pglite.ts';

const { changesSaid, connector, refreshTools, toolsChanged } = await import('../src/office.ts');

await db.insert(staff).values({
  id: 'cleo',
  name: 'Cleo',
  role: 'Assistant',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft',
  desk: 'You are Cleo.'
});
await db.insert(connectors).values({
  id: 'cal',
  name: 'Calendar',
  description: 'A calendar.',
  kind: 'http',
  tools: ['list_events', 'add_event', 'apply_changes'],
  readTools: ['list_events'],
  toolNotes: { list_events: 'List events.', add_event: 'Stage an event.', apply_changes: '' },
  readyAt: new Date()
});
await db
  .insert(grants)
  .values({ staffId: 'cleo', connectorId: 'cal', level: 'act', standing: ['add_event'] });

const titles = async () => (await db.select().from(ledger)).map((l) => l.title);

test('nothing changed writes nothing', async () => {
  const ch = await refreshTools('cal', [
    { name: 'list_events', description: 'List events.', readOnly: true },
    { name: 'add_event', description: 'Stage an event.', readOnly: false },
    { name: 'apply_changes', readOnly: false }
  ]);
  assert.equal(changesSaid(ch), 'Up to date.');
  assert.equal(toolsChanged(ch), false);
  assert.deepEqual(await titles(), []);
});

test('a new tool, a dropped one, a new read tool and a lost standing yes are kept and recorded', async () => {
  const ch = await refreshTools('cal', [
    { name: 'list_events', description: 'List events.', readOnly: true },
    { name: 'find_time', description: 'Find a free slot.', readOnly: true },
    { name: 'apply_changes', description: 'Apply what was staged.', readOnly: false }
  ]);
  assert.equal(changesSaid(ch), 'Tools updated: 1 new, 1 gone, Read only changed.');
  assert.equal(toolsChanged(ch), true);
  const c = (await connector('cal'))!;
  assert.deepEqual(c.tools, ['list_events', 'find_time', 'apply_changes']);
  assert.deepEqual(c.readTools, ['list_events', 'find_time']);
  assert.equal(c.toolNotes.apply_changes, 'Apply what was staged.');
  // add_event went, so a tool that comes back by that name asks first.
  const [g] = await db.select().from(grants).where(eq(grants.connectorId, 'cal'));
  assert.deepEqual(g.standing, []);
  assert.deepEqual((await titles()).sort(), [
    'Calendar added find_time, and dropped add_event',
    'Cleo asks again before using add_event in Calendar',
    'Read only for Calendar now reaches find_time'
  ]);
});

test('a tool the service stops marking as reading leaves Read only, and says so', async () => {
  await db.delete(ledger);
  await refreshTools('cal', [
    { name: 'list_events', description: 'List events.', readOnly: true },
    { name: 'find_time', description: 'Find a free slot.', readOnly: false },
    { name: 'apply_changes', description: 'Apply what was staged.', readOnly: false }
  ]);
  assert.deepEqual((await connector('cal'))!.readTools, ['list_events']);
  assert.deepEqual(await titles(), ['Read only for Calendar no longer reaches find_time']);
});

test('a service that drops an Ask first tool and adds one moves the Ask first to it, and says so', async () => {
  await db.delete(ledger);
  await db.insert(staff).values({
    id: 'ace',
    name: 'Ace',
    role: 'Assistant',
    remit: 'Tests.',
    variant: 'a',
    portrait: 'a',
    permission: 'act',
    desk: 'You are Ace.'
  });
  await db.insert(connectors).values({
    id: 'mail',
    name: 'Mail',
    description: 'A mailbox.',
    kind: 'http',
    tools: ['search', 'delete_message'],
    readTools: ['search'],
    readyAt: new Date()
  });
  await db
    .insert(grants)
    .values({ staffId: 'ace', connectorId: 'mail', level: 'act', askFirst: ['delete_message'] });
  // The service renamed delete_message, and added a read beside it.
  await refreshTools('mail', [
    { name: 'search', readOnly: true },
    { name: 'list_labels', readOnly: true },
    { name: 'trash_message', readOnly: false }
  ]);
  const [g] = await db.select().from(grants).where(eq(grants.connectorId, 'mail'));
  // The old name stays, so it still asks first if it comes back; a read never waits.
  assert.deepEqual(g.askFirst, ['delete_message', 'trash_message']);
  assert.ok((await titles()).includes("Moved Ace's Ask first in Mail to trash_message"));
  // With nothing on Ask first, a dropped tool moves nothing.
  await db.update(grants).set({ askFirst: [] }).where(eq(grants.connectorId, 'mail'));
  await refreshTools('mail', [
    { name: 'search', readOnly: true },
    { name: 'remove_message', readOnly: false }
  ]);
  const [after] = await db.select().from(grants).where(eq(grants.connectorId, 'mail'));
  assert.deepEqual(after.askFirst, []);
});

test('a tool on Without asking whose description changed asks again, and says why; a first description changes nothing', async () => {
  await db.delete(ledger);
  await db.insert(connectors).values({
    id: 'board',
    name: 'Board',
    description: 'A board.',
    kind: 'http',
    tools: ['stage_card', 'move_card'],
    readTools: [],
    toolNotes: { stage_card: 'Stage a card change.' },
    readyAt: new Date()
  });
  await db.insert(grants).values({
    staffId: 'cleo',
    connectorId: 'board',
    level: 'act',
    standing: ['stage_card', 'move_card']
  });
  await refreshTools('board', [
    { name: 'stage_card', description: 'Move a card at once.', readOnly: false },
    { name: 'move_card', description: 'Move a card.', readOnly: false }
  ]);
  const [g] = await db.select().from(grants).where(eq(grants.connectorId, 'board'));
  // move_card had no description stored, so its first one is no change.
  assert.deepEqual(g.standing, ['move_card']);
  const [line] = await db.select().from(ledger);
  assert.equal(line.title, 'Cleo asks again before using stage_card in Board');
  assert.match(line.body ?? '', /Board changed what it says it does/);
});
