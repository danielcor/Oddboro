import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { supportReport } from './support-report.js';

test('a support report prints known events from the recent log, including a failed startup step', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'oddboro-report-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'office.log');
  await writeFile(
    file,
    [
      'office: tables in 789 ms',
      'x'.repeat(140000),
      '2026-11-15T12:34:56.123Z office: database in 18 ms',
      'office: tables failed',
      'oddboro: 2026-11-15T12:34:59.000Z update check failed: private-token',
      'page: error private-token',
      'office: setup private-token fail',
      'office: key in 999 ms'
    ].join('\n')
  );
  const report = await supportReport(file, '0.0.11');
  assert.match(report, /Version: 0.0.11/);
  assert.match(report, /Earlier log entries omitted/);
  assert.match(report, /2026-11-15T12:34:56.123Z database in 18 ms/);
  assert.match(report, /tables failed/);
  assert.match(report, /Update check failed/);
  assert.match(report, /Entries omitted: 2/);
  assert.doesNotMatch(report, /789 ms|999 ms|private-token/);
  const missing = await supportReport(join(folder, 'missing'), 'private-version');
  assert.match(missing, /Office log unavailable/);
  assert.doesNotMatch(missing, /private-version/);
});

test('Setup downloads the shell log with online reports off on Mac, Linux and Windows', async (t) => {
  const { folder, onPlatform } = await import('./office-under-test.ts');
  const { GET } = await import('../../routes/api/diagnostics/+server.ts');
  const file = join(folder, 'support-test.log');
  await writeFile(file, 'office: tables in 123 ms\nunknown private content\n');
  const before = { log: process.env.ODDBORO_LOG, answer: process.env.OFFICE_DIAGNOSTICS };
  process.env.ODDBORO_LOG = file;
  process.env.OFFICE_DIAGNOSTICS = 'no';
  t.after(() => {
    if (before.log === undefined) delete process.env.ODDBORO_LOG;
    else process.env.ODDBORO_LOG = before.log;
    if (before.answer === undefined) delete process.env.OFFICE_DIAGNOSTICS;
    else process.env.OFFICE_DIAGNOSTICS = before.answer;
  });
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const response = await onPlatform(platform, () => GET({} as Parameters<typeof GET>[0]));
    assert.equal(
      response.headers.get('content-disposition'),
      'attachment; filename="oddboro-support.txt"'
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.ok(text.includes('System: ' + platform));
    assert.ok(text.includes('tables in 123 ms'));
    assert.doesNotMatch(text, /private content/);
  }
});
