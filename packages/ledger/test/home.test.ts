// Where a test's office lives when the test names none: never the owner's
// real office or the port it answers on. And the office home is the owner's
// alone. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';

test("under node --test with no ODDBORO_HOME, the office is a throwaway folder and not the owner's", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
  delete env.ODDBORO_HOME;
  delete env.ODDBORO_DB_PORT;
  const script = `
    const { realpathSync } = await import('node:fs');
    const { home, DATABASE_PORT } = await import(${JSON.stringify(new URL('../src/home.ts', import.meta.url).href)});
    process.stdout.write(JSON.stringify({ home: realpathSync(home()), port: DATABASE_PORT }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
  const { home, port } = JSON.parse(child.stdout) as { home: string; port: number };
  assert.ok(home.startsWith(realpathSync(tmpdir()) + sep), home);
  assert.ok(!home.startsWith(join(homedir(), '.oddboro')), home);
  assert.ok(!existsSync(home), 'the throwaway office outlived its process');
  assert.equal(port, 54399);
});

test(
  'the office makes its home private as it starts, a new one and one an older version left open',
  { skip: process.platform === 'win32' && 'Windows keeps other accounts out of the profile' },
  async () => {
    const parent = mkdtempSync(join(tmpdir(), 'oddboro-private-'));
    const office = join(parent, 'office');
    mkdirSync(office);
    chmodSync(office, 0o755);
    process.env.ODDBORO_HOME = office;
    try {
      const { makeHomePrivate } = await import('../src/home.ts');
      makeHomePrivate();
      assert.equal(statSync(office).mode & 0o777, 0o700);
      rmSync(office, { recursive: true });
      makeHomePrivate();
      assert.equal(statSync(office).mode & 0o777, 0o700);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
);
