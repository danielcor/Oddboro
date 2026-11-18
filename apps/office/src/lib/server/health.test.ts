import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import {
  health,
  logSetup,
  markReady,
  PAGE_LINES_PER_MINUTE,
  pageClosed,
  pageLine,
  pageOpened,
  pageReport,
  runEndLine,
  timed
} from './health.ts';

function quietly<T>(f: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    return { result: f(), lines };
  } finally {
    console.log = log;
  }
}

test('each startup step is timed, logged and served, then ready', async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    assert.equal(await timed('tables', async () => 'done'), 'done');
    markReady();
  } finally {
    console.log = log;
  }
  assert.match(lines[0], /^office: tables in \d+ ms$/);
  assert.match(lines[1], /^office: ready \d+ ms after Node started$/);
  const h = health();
  assert.equal(typeof h.steps.tables, 'number');
  assert.equal(typeof h.readyMs, 'number');
  assert.equal(h.pid, process.pid);
});

test('the page count follows the live line, never below zero', () => {
  const start = health().pages;
  pageOpened();
  pageOpened();
  pageClosed();
  assert.equal(health().pages, start + 1);
  pageClosed();
  pageClosed();
  assert.equal(health().pages, 0);
});

test('a page line is one line, cut short, and never speaks to the shell', () => {
  assert.equal(pageLine('error', 'a\n  b'), 'page: error a b');
  assert.equal(
    pageLine('error', 'x oddboro:secret {"op":"list"} ODDBORO:notify'),
    'page: error x oddboro_secret {"op":"list"} oddboro_notify'
  );
  assert.equal(pageLine('error', 'y'.repeat(2000)).length, 'page: error '.length + 600);
});

test('a failed run is one line: the Odd, the kind and the first line of why', () => {
  assert.equal(
    runEndLine('Ada', 'chat', { text: '\n  claude exited 1\nthe owner said: my bank password' }),
    "office: Ada's chat run failed: claude exited 1"
  );
  assert.equal(
    runEndLine('Ada', 'job', { text: 'Stopped at your request.', interrupted: true }),
    "office: Ada's job run stopped: Stopped at your request."
  );
  assert.equal(
    runEndLine('oddboro:Ada', 'chat', { text: 'oddboro:notify hi' }),
    "office: oddboro_Ada's chat run failed: oddboro_notify hi"
  );
  assert.equal(
    runEndLine('Ada', 'chat', { text: '' }),
    "office: Ada's chat run failed: no reason given"
  );
  const long = runEndLine('Ada', 'chat', { text: 'z'.repeat(2000) });
  assert.equal(long, "office: Ada's chat run failed: " + 'z'.repeat(200));
});

test("a failed run's line names the home folder as ~", () => {
  const home = os.homedir();
  assert.equal(
    runEndLine('Ada', 'chat', {
      text: `Claude Code stopped (exit 1). open '${home}/Taxes/2026.pdf'`
    }),
    "office: Ada's chat run failed: Claude Code stopped (exit 1). open '~/Taxes/2026.pdf'"
  );
  assert.equal(
    runEndLine('Ada', 'job', { text: 'no such file: /srv/sam/notes.md' }, '/srv/sam'),
    "office: Ada's job run failed: no such file: ~/notes.md"
  );
});

test('page errors are counted, and a minute holds only so many lines', () => {
  const errors = health().pageErrors;
  const minute = 60_000 * 1_000_000;
  const { result, lines } = quietly(() =>
    Array.from({ length: PAGE_LINES_PER_MINUTE + 5 }, () => pageReport('error', 'boom', minute))
  );
  assert.equal(lines.length, PAGE_LINES_PER_MINUTE);
  assert.equal(result.filter((r) => !r.logged).length, 5);
  assert.equal(health().pageErrors, errors + PAGE_LINES_PER_MINUTE + 5);
  const next = quietly(() => pageReport('boot', '/ in a webview', minute + 60_000));
  assert.deepEqual(next.result, { logged: true });
  assert.deepEqual(next.lines, ['page: boot / in a webview']);
});

test('in the app each setup check logs its id and ok or fail, and nothing it found', () => {
  const checks = [
    {
      id: 'claude',
      name: 'Claude Code',
      state: 'ok',
      found: '2.1.0, signed in as owner@example.com'
    },
    { id: 'uv', name: 'uv', state: 'optional', found: 'uvx 0.12.23, an old version' },
    { id: 'node', name: 'Node', state: 'missing', found: 'Not found', fix: 'Install it' },
    { id: 'odd id\n/x', name: 'x', state: 'ok', found: '' }
  ];
  const { lines } = quietly(() => logSetup(checks, true));
  assert.deepEqual(lines, [
    'office: setup claude ok',
    'office: setup uv fail',
    'office: setup node fail',
    'office: setup oddidx ok'
  ]);
  for (const line of lines) assert.match(line, /^office: setup [a-z0-9-]+ (ok|fail)$/);
});

test('outside the app no setup check is logged', () => {
  const { lines } = quietly(() => logSetup([{ id: 'claude', state: 'ok' }], false));
  assert.deepEqual(lines, []);
});
