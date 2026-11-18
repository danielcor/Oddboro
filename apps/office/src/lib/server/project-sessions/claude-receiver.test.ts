// The real paired tool server and monitor, with no model or personal project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { L, folder } from '../office-under-test.ts';

const { prepareClaude, checkClaudeReceiver, postClaude } = await import('./claude-project.ts');
await L.setOwnerName('Tester');
await L.setAdvancedMode(true);

async function fixture() {
  const project = join(folder, randomUUID());
  mkdirSync(project);
  const s = await L.connectProject('claude', randomUUID(), project, 'Receiver check');
  return { s, ...prepareClaude(s) };
}

async function tools(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const config = JSON.parse(readFileSync(join(f.plugin, '.mcp.json'), 'utf8'));
  const client = new Client({ name: 'receiver-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      ...config.mcpServers.oddboro_project,
      cwd: f.s.folder,
      env: { CLAUDE_CODE_SESSION_ID: f.s.nativeId },
      stderr: 'pipe'
    })
  );
  t.after(() => {
    t.mock.timers.reset();
    return client.close();
  });
  return client;
}

/** Filesystem notices keep running while the one delivery timer is mocked. */
async function until(fn: () => boolean) {
  const end = performance.now() + 5000;
  while (!fn() && performance.now() < end) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fn(), 'the receiver never answered');
}

test('both live receivers answer a fresh probe, then the exact assignment returns through the paired tools', async (t) => {
  const f = await fixture();
  const client = await tools(t, f);
  const monitor = spawn(process.execPath, [join(f.plugin, 'start-watch.mjs')], {
    cwd: f.s.folder,
    env: { CLAUDE_CODE_SESSION_ID: f.s.nativeId },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let notices = '';
  let errors = '';
  monitor.stdout.on('data', (bytes) => (notices += bytes));
  monitor.stderr.on('data', (bytes) => (errors += bytes));
  t.after(async () => {
    if (monitor.exitCode === null) {
      const ended = once(monitor, 'exit');
      monitor.kill();
      await ended;
    }
    assert.equal(errors, '');
  });

  await checkClaudeReceiver(f.s);
  assert.equal(existsSync(join(f.box, 'offer.json')), false);
  const work = await L.requestProject({
    id: randomUUID(),
    sessionId: f.s.id,
    prompt: 'Return the word chestnut, once.'
  });
  postClaude(f.s, work);
  await until(() => notices.includes(work.id));
  const taken = await client.callTool({ name: 'take_work', arguments: {} });
  assert.equal(taken.isError, undefined);
  assert.deepEqual(taken.content, [
    { type: 'text', text: JSON.stringify({ id: work.id, prompt: work.prompt }) }
  ]);
  const done = await client.callTool({
    name: 'finish_work',
    arguments: { id: work.id, answer: 'chestnut' }
  });
  assert.equal(done.isError, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(f.box, work.id + '.reply'), 'utf8')), {
    answer: 'chestnut'
  });
  // A monitor without its tool server cannot make the next send look ready.
  await client.close();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = checkClaudeReceiver(f.s);
  const refused = assert.rejects(pending, /plugin is not ready.*Nothing was sent/);
  await until(() => existsSync(join(f.box, 'probe.json')));
  t.mock.timers.tick(30_000);
  await refused;
});

test('old replies and a tool server alone cannot pass the receiver check or send an assignment', async (t) => {
  const f = await fixture();
  const old = randomUUID();
  for (const receiver of L.PROJECT_RECEIVERS) writeFileSync(join(f.box, old + '.' + receiver), '');
  await tools(t, f);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = checkClaudeReceiver(f.s);
  const refused = assert.rejects(pending, /plugin is not ready.*Nothing was sent/);
  const key = JSON.parse(readFileSync(join(f.box, 'probe.json'), 'utf8')).key;
  await until(() => existsSync(join(f.box, key + '.tools')));
  t.mock.timers.tick(29_999);
  assert.ok(existsSync(join(f.box, 'probe.json')));
  t.mock.timers.tick(1);
  await refused;
  assert.equal(existsSync(join(f.box, 'offer.json')), false);
  assert.equal(existsSync(join(f.box, 'probe.json')), false);
  assert.equal(existsSync(join(f.box, key + '.tools')), false);
});

test('a tool server in an unpaired conversation starts, refuses its tools and never answers a probe', async (t) => {
  const f = await fixture();
  const config = JSON.parse(readFileSync(join(f.plugin, '.mcp.json'), 'utf8'));
  const client = new Client({ name: 'unpaired-test', version: '1.0.0' });
  let errors = '';
  const transport = new StdioClientTransport({
    ...config.mcpServers.oddboro_project,
    cwd: f.s.folder,
    env: { CLAUDE_CODE_SESSION_ID: randomUUID() },
    stderr: 'pipe'
  });
  transport.stderr?.on('data', (bytes) => (errors += bytes));
  await client.connect(transport);
  t.after(() => {
    t.mock.timers.reset();
    return client.close();
  });
  const taken = await client.callTool({ name: 'take_work', arguments: {} });
  assert.equal(taken.isError, true);
  assert.match(JSON.stringify(taken.content), /not paired/);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = checkClaudeReceiver(f.s);
  const refused = assert.rejects(pending, /plugin is not ready.*Nothing was sent/);
  const key = JSON.parse(readFileSync(join(f.box, 'probe.json'), 'utf8')).key;
  t.mock.timers.tick(30_000);
  await refused;
  assert.equal(existsSync(join(f.box, key + '.tools')), false);
  // Still running after the check: the server did not throw at start.
  assert.equal((await client.callTool({ name: 'take_work', arguments: {} })).isError, true);
  assert.equal(errors, '');
});
