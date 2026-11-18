// The owner route, database and paired plugin run together. Only the native
// terminal and Claude's process discovery stand in for an installed client.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { L, folder, request } from '../office-under-test.ts';

const claude = await import('./claude-project.ts');
let running: Awaited<ReturnType<typeof claude.claudeProjects>> = [];
mock.module('./claude-project.ts', {
  namedExports: { ...claude, claudeProjects: async () => running }
});
mock.module('./terminal.ts', {
  namedExports: {
    ProjectTerminal: {
      open: async () => ({
        running: true,
        events: new EventEmitter(),
        releaseProcess: async () => {}
      })
    }
  }
});
const { projectController } = await import('./controller.ts');
const c = projectController();
const action = (body: unknown) => request('/api/project-sessions', 'POST', { body });
async function until(fn: () => boolean | Promise<boolean>) {
  const end = performance.now() + 5000;
  while (performance.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('The office did not reach the expected delivery state.');
}
const state = async (id: string) => (await L.projectWork(id))[0];

test('a missing receiver fails visibly, and the owner retries the same assignment through to its report', async (t) => {
  await L.setOwnerName('Tester');
  await L.setAdvancedMode(true);
  const project = join(folder, 'delivery');
  mkdirSync(project);
  const s = await c.connect('claude', project);
  await L.shareProject(s.id, 'paige');
  const r = await L.requestProject({
    id: randomUUID(),
    sessionId: s.id,
    staffId: 'paige',
    prompt: 'Return chestnut.',
    draft: true
  });
  const { box, plugin } = claude.prepareClaude(s);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const send = action({ action: 'decide', id: s.id, key: r.id, approve: true });
  await until(() => existsSync(join(box, 'probe.json')));
  t.mock.timers.tick(30_000);
  assert.equal((await send).status, 200);
  assert.equal((await state(s.id)).state, 'failed');
  assert.match((await state(s.id)).answer!, /plugin is not ready.*Nothing was sent/);
  assert.equal((await L.projectOverview()).find((row) => row.id === s.id)?.status, 'waiting');
  assert.equal(existsSync(join(box, 'offer.json')), false);
  t.mock.timers.reset();

  const config = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'));
  const client = new Client({ name: 'delivery-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      ...config.mcpServers.oddboro_project,
      cwd: project,
      env: { CLAUDE_CODE_SESSION_ID: s.nativeId },
      stderr: 'pipe'
    })
  );
  const monitor = spawn(process.execPath, [join(plugin, 'start-watch.mjs')], {
    cwd: project,
    env: { CLAUDE_CODE_SESSION_ID: s.nativeId },
    stdio: 'pipe'
  });
  t.after(async () => {
    t.mock.timers.reset();
    await client.close();
    const ended = once(monitor, 'exit');
    monitor.kill();
    await ended;
  });
  assert.equal(
    (await action({ action: 'decide', id: s.id, key: r.id, approve: true })).status,
    200
  );
  assert.equal((await state(s.id)).id, r.id);
  assert.equal((await state(s.id)).state, 'sending');
  await client.callTool({ name: 'take_work', arguments: {} });
  await until(async () => (await state(s.id)).state === 'working');
  await client.callTool({ name: 'finish_work', arguments: { id: r.id, answer: 'chestnut' } });
  await until(async () => (await state(s.id)).state === 'done');
  const history = await (await action({ action: 'history', id: s.id })).json();
  assert.equal(history.work[0].answer, 'chestnut');
  const reports =
    await L.pg`select body from reports where staff_id = 'paige' and title = ${'Project session: ' + s.title}`;
  assert.equal(reports.length, 1);
  assert.match(reports[0].body, /chestnut/);
  assert.equal(existsSync(join(box, 'offer.json')), false);
  await c.disconnect(s.id);
});

test('an offered request survives a restart as uncertain and cannot be retried before inspection', async () => {
  const project = join(folder, 'restart');
  mkdirSync(project);
  const s = await L.connectProject('claude', randomUUID(), realpathSync(project), 'Restart');
  const r = await L.requestProject({ id: randomUUID(), sessionId: s.id, prompt: 'Do it once.' });
  assert.equal((await L.claimProject(s.id))?.id, r.id);
  const { box } = claude.prepareClaude(s);
  claude.postClaude(s, r);
  await c.connect('claude', project, s.nativeId);
  assert.equal((await state(s.id)).state, 'uncertain');
  await assert.rejects(action({ action: 'decide', id: s.id, key: r.id, approve: true }));
  assert.equal(JSON.parse(readFileSync(join(box, 'offer.json'), 'utf8')).id, r.id);
  await action({ action: 'resolve', id: s.id, key: r.id });
  assert.equal((await state(s.id)).state, 'stopped');
  assert.equal(existsSync(join(box, 'offer.json')), false);
  await c.disconnect(s.id);
});

test('a live session that never takes its offered work becomes uncertain, and a late reply still finishes it once', async (t) => {
  const project = join(folder, 'late-reply');
  mkdirSync(project);
  const s = await L.connectProject('claude', randomUUID(), realpathSync(project), 'Late reply');
  const r = await L.requestProject({ id: randomUUID(), sessionId: s.id, prompt: 'Do it once.' });
  await L.claimProject(s.id);
  const { box } = claude.prepareClaude(s);
  claude.postClaude(s, r);
  running = [
    { id: s.nativeId, title: s.title, updated: Date.now(), live: true, job: 'native-job' }
  ];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    t.mock.timers.reset();
    running = [];
  });
  await c.connect('claude', project, s.nativeId);
  t.mock.timers.tick(60_000);
  await until(async () => (await state(s.id)).state === 'uncertain');
  assert.match((await state(s.id)).answer!, /has not acknowledged/);
  assert.equal(JSON.parse(readFileSync(join(box, 'offer.json'), 'utf8')).id, r.id);
  t.mock.timers.reset();
  writeFileSync(join(box, r.id + '.reply'), JSON.stringify({ answer: 'The late answer.' }));
  await until(async () => (await state(s.id)).state === 'done');
  assert.equal((await state(s.id)).answer, 'The late answer.');
  assert.equal((await L.projectWork(s.id)).length, 1);
  await c.disconnect(s.id);
});

test('a readiness check that ends with nothing claimed puts the earlier note back', async (t) => {
  const project = join(folder, 'nothing-claimed');
  mkdirSync(project);
  const s = await c.connect('claude', project);
  const { box, plugin } = claude.prepareClaude(s);
  const before = c.view(s.id).note;
  const r = await L.requestProject({ id: randomUUID(), sessionId: s.id, prompt: 'Not now.' });
  const sending = c.work(s.id);
  await until(() => existsSync(join(box, 'probe.json')));
  assert.equal(c.view(s.id).note, 'Checking Claude’s office connection');
  // Advanced mode goes off during the check, so the claim sends nothing.
  await L.setAdvancedMode(false);
  const config = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'));
  const client = new Client({ name: 'nothing-claimed-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      ...config.mcpServers.oddboro_project,
      cwd: project,
      env: { CLAUDE_CODE_SESSION_ID: s.nativeId },
      stderr: 'pipe'
    })
  );
  const monitor = spawn(process.execPath, [join(plugin, 'start-watch.mjs')], {
    cwd: project,
    env: { CLAUDE_CODE_SESSION_ID: s.nativeId },
    stdio: 'pipe'
  });
  t.after(async () => {
    await client.close();
    const ended = once(monitor, 'exit');
    monitor.kill();
    await ended;
    await c.disconnect(s.id);
    await L.setAdvancedMode(true);
  });
  await sending;
  assert.equal(c.view(s.id).note, before);
  assert.equal((await state(s.id)).id, r.id);
  assert.equal((await state(s.id)).state, 'stopped');
  assert.equal(existsSync(join(box, 'offer.json')), false);
});
