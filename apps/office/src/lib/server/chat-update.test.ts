// A real chat reply carries update controls. Only the existing owner action
// schedules an installation; the shell remains the only source of a version.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import type { ChatEvent } from '../staff/chat.ts';

process.env.ODDBORO_UPDATES = '1';
process.env.ODDBORO_VERSION = '0.0.10';
const { L, chat, folder, history } = await import('./office-under-test.ts');
const { activeReply, stopReply, replyToOwnerTurn } = await import('./chat-run.ts');
const { loadUpdate, status, checked, updateForChat } = await import('./update.ts');
const { KEY_HEADER, KEY_LINE, readKey } = await import('./app-key.ts');
const { POST } = await import('../../routes/api/update/+server.ts');
await loadUpdate();
// The shell's key, on the pipe the shell would use.
const KEY = 'b2'.repeat(32);
const pipe = new PassThrough();
const keyRead = readKey(pipe, 200);
pipe.write(`${KEY_LINE}${KEY}\n`);
await keyRead;

const post = (body: unknown, shell = false) =>
  POST({
    request: new Request('http://localhost/api/update', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: shell ? { [KEY_HEADER]: KEY } : {}
    }),
    getClientAddress: () => '127.0.0.1'
  } as Parameters<typeof POST>[0]);

async function reply(check: boolean, stop = false) {
  const events: ChatEvent[] = [];
  const ready = join(folder, `update-${crypto.randomUUID()}`);
  const message = `Check the app.\nHold until ${ready} exists.`;
  const replying = chat('lead', message, (e) => events.push(e));
  let runId: string | undefined;
  while (!(runId = activeReply('lead')?.runId)) await new Promise((r) => setTimeout(r, 20));
  L.keepUpdateRequest('lead', { run: runId, check });
  if (stop) await stopReply('lead', runId);
  else writeFileSync(ready, '');
  await replying;
  return { events, message };
}

test('a successful check reply saves live controls, starts one check and does not install', async () => {
  const writes: string[] = [];
  const stdout = mock.method(process.stdout, 'write', (s: string) => {
    writes.push(s);
    return true;
  });
  try {
    const { events } = await reply(true);
    assert.ok(events.some((e) => e.type === 'done' && e.updates));
    const kept = history('lead').at(-1)!;
    assert.equal(kept.updates, true);
    assert.equal(writes.filter((s) => s === 'oddboro:update-check\n').length, 1);
    assert.equal((await status()).install, false);
    const replay: ChatEvent[] = [];
    await replyToOwnerTurn('lead', kept.turnId!, (e) => replay.push(e));
    assert.ok(replay.some((e) => e.type === 'done' && e.updates));
    assert.equal(writes.filter((s) => s === 'oddboro:update-check\n').length, 1);
  } finally {
    stdout.mock.restore();
    checked();
  }
});

test('a stopped reply consumes its request without starting a check or offering controls', async () => {
  const writes: string[] = [];
  const stdout = mock.method(process.stdout, 'write', (s: string) => {
    writes.push(s);
    return true;
  });
  try {
    await reply(true, true);
    assert.equal(history('lead').at(-1)?.updates, undefined);
    assert.equal(existsSync(L.home('staff', 'lead', L.OFFICE_FILES.updateRequest)), false);
    assert.ok(!writes.includes('oddboro:update-check\n'));
  } finally {
    stdout.mock.restore();
  }
});

test('only the shell reports a ready update; the chat snapshot omits notes; the owner chooses when to install', async () => {
  await assert.rejects(async () => post({ version: '0.0.11' }), { status: 403 });
  await post({ version: '0.0.11', notes: 'Release text is not a chat instruction.' }, true);
  const known = await updateForChat();
  assert.equal(known.version, '0.0.11');
  assert.ok(!('notes' in known));
  assert.ok(!('install' in known));
  await reply(false);
  assert.equal((await status()).installAt, known.installAt);
  const result = await post({ action: 'install-now' });
  const now = await result.json();
  assert.equal(now.holding, true);
  assert.equal(now.install, true);
  assert.ok(new Date(now.installAt).getTime() <= Date.now());
});
