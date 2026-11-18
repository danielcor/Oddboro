// A failed disk copy must not look like a database the owner can restore.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
// Use the throwaway home the ledger creates for this test process.
delete process.env.ODDBORO_HOME;
const { home } = await import('../src/home.ts');
const { backUpForNewVersion } = await import('../src/backup.ts');

test('an incomplete copy leaves the last version and recoverable backups alone, and retry copies the whole database', (t) => {
  fs.mkdirSync(home('db'), { recursive: true });
  fs.writeFileSync(home('db', 'last-page'), 'all data');
  fs.writeFileSync(home('version'), '1.0.0');
  const older = 'pre-1.0.0-20261101T010000Z';
  fs.mkdirSync(home('backups', older, 'db'), { recursive: true });

  const copy = t.mock.method(fs, 'cpSync', (_source: string, destination: string) => {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(join(destination, 'first-page'), 'some data');
    throw Error('Disk full');
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => backUpForNewVersion('2.0.0'), /Disk full/);
  } finally {
    copy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readdirSync(home('backups')), [older]);
  assert.equal(fs.readFileSync(home('version'), 'utf8'), '1.0.0');

  const saved = backUpForNewVersion('2.0.0');
  assert.ok(saved);
  assert.equal(fs.readFileSync(join(saved, 'db', 'last-page'), 'utf8'), 'all data');
  assert.deepEqual(fs.readdirSync(join(saved, 'db')), ['last-page']);
  assert.equal(fs.readFileSync(home('version'), 'utf8').trim(), '2.0.0');
});

test('a copy a force-quit cut off is cleared before the next backup', () => {
  fs.mkdirSync(home('db'), { recursive: true });
  fs.writeFileSync(home('db', 'last-page'), 'all data');
  fs.writeFileSync(home('version'), '2.0.0');
  const leftover = home('backups', '.copying-cutoff');
  fs.mkdirSync(join(leftover, 'db'), { recursive: true });
  fs.writeFileSync(join(leftover, 'db', 'first-page'), 'some data');

  const saved = backUpForNewVersion('3.0.0');
  assert.ok(saved);
  assert.ok(!fs.existsSync(leftover));
  assert.ok(!fs.readdirSync(home('backups')).some((n) => n.startsWith('.copying-')));
  assert.equal(fs.readFileSync(join(saved, 'db', 'last-page'), 'utf8'), 'all data');
});
