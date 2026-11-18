// The chat tool reads the office's snapshot and leaves a request for its reply.
// It has no installation action and never writes the updater's row.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { db, toolServer } from './tool-server.ts';

const { staff } = await import('../src/schema.ts');
const { home, OFFICE_FILES } = await import('../src/home.ts');
const { keepUpdateRequest, takeUpdateRequest } = await import('../src/chat-updates.ts');
const { updateRow } = await import('../src/updates.ts');
await db.insert(staff).values({
  id: 'wren',
  name: 'Wren',
  role: 'Mail Clerk',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  desk: 'You are Wren.'
});
const snapshot = {
  current: '0.0.10',
  managed: true,
  ready: false,
  version: null,
  installAt: null,
  checking: false,
  checked: null
};
const chat = {
  RUN_KEY: 'chat-run',
  OWNER_SAID: 'Check for an update.',
  ODDBORO_UPDATE_STATUS: JSON.stringify(snapshot)
};
const call = (c: Awaited<ReturnType<typeof toolServer>>, action: string) =>
  c.callTool({ name: 'oddboro_update', arguments: { action } });

test('only owner chats get the update tool, and a missing snapshot fails without a request', async () => {
  const job = await toolServer('wren', { RUN_KEY: 'job' });
  assert.ok(!(await job.listTools()).tools.some((t) => t.name === 'oddboro_update'));
  const c = await toolServer('wren', { ...chat, ODDBORO_UPDATE_STATUS: '' });
  assert.ok((await c.listTools()).tools.some((t) => t.name === 'oddboro_update'));
  assert.equal((await call(c, 'check')).isError, true);
  assert.equal(takeUpdateRequest('wren', chat.RUN_KEY), undefined);
});

test('checking keeps one request; status reads the snapshot; neither can install or change the window', async () => {
  const before = await updateRow();
  const c = await toolServer('wren', chat);
  const result = await call(c, 'check');
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result.content), /0.0.10/);
  // Reading status again in the same reply does not cancel the requested check.
  await call(c, 'status');
  assert.deepEqual(takeUpdateRequest('wren', chat.RUN_KEY), { check: true });
  assert.equal(takeUpdateRequest('wren', chat.RUN_KEY), undefined);
  await call(c, 'status');
  assert.deepEqual(takeUpdateRequest('wren', chat.RUN_KEY), { check: false });
  for (const action of ['install', 'install-now', 'restart'])
    assert.equal((await call(c, action)).isError, true);
  assert.equal(takeUpdateRequest('wren', chat.RUN_KEY), undefined);
  assert.deepEqual(await updateRow(), before);
});

test('an unmanaged app, a ready update and an existing check only show the owner controls', async () => {
  for (const state of [
    { managed: false },
    { ready: true, version: '0.0.11' },
    { checking: true }
  ]) {
    const c = await toolServer('wren', {
      ...chat,
      ODDBORO_UPDATE_STATUS: JSON.stringify({ ...snapshot, ...state })
    });
    assert.notEqual((await call(c, 'check')).isError, true);
    assert.deepEqual(takeUpdateRequest('wren', chat.RUN_KEY), { check: false });
  }
});

test('stale or damaged requests are consumed without acting', () => {
  const file = home('staff', 'wren', OFFICE_FILES.updateRequest);
  keepUpdateRequest('wren', { run: 'old-run', check: true });
  assert.equal(takeUpdateRequest('wren', 'new-run'), undefined);
  for (const bad of ['{', '{"run":"new-run","check":true,"install":true}']) {
    writeFileSync(file, bad);
    assert.equal(takeUpdateRequest('wren', 'new-run'), undefined);
    assert.equal(existsSync(file), false);
  }
});
