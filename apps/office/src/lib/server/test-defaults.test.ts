// The office's tests run away from the developer's own world too: its test
// script loads the ledger's test-defaults.ts, which gives each test process a
// home of its own and a PATH of node and the system's folders. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { AGENTS } from '@oddboro/ledger/agents';
import { toolsOnPath } from '@oddboro/ledger/tools-on-path';

const OFFICE = fileURLToPath(new URL('../../../', import.meta.url));

test('the office tests run in a home of their own too', () => {
  assert.notEqual(homedir(), userInfo().homedir, "HOME is still the developer's own");
  assert.deepEqual(toolsOnPath(AGENTS), [], 'an AI tool a test process could start');
});

test(
  "the owner page's tests never start the developer's claude",
  // The stand-in is a shell script, and CI does not run the office suite on Windows.
  { skip: process.platform === 'win32' && 'the claude stand-in is a shell script' },
  () => {
    const folder = mkdtempSync(join(tmpdir(), 'oddboro-claude-stand-in-'));
    after(() => rmSync(folder, { recursive: true, force: true }));
    const marks = join(folder, 'started.log');
    writeFileSync(join(folder, 'claude'), `#!/bin/sh\necho "$*" >> '${marks}'\nexit 1\n`);
    chmodSync(join(folder, 'claude'), 0o755);

    // The office's own test command, run on owner-page.test.ts alone.
    const script = (
      JSON.parse(readFileSync(join(OFFICE, 'package.json'), 'utf8')) as {
        scripts: { test: string };
      }
    ).scripts.test;
    const [command, ...args] = script.split(' ');
    assert.equal(command, 'node');
    assert.equal(args.at(-1), '"src/**/*.test.ts"');
    args[args.length - 1] = 'src/lib/server/owner-page.test.ts';

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${folder}${delimiter}${process.env.PATH ?? ''}`
    };
    // Inherited, it makes the child skip its files and pass with no tests run.
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, args, {
      cwd: OFFICE,
      env,
      encoding: 'utf8',
      timeout: 50_000
    });

    assert.equal(child.status, 0, child.stdout + child.stderr);
    const passed = Number(/^(?:ℹ|#) pass (\d+)$/m.exec(child.stdout)?.[1] ?? 0);
    assert.ok(passed > 0, `no test passed:\n${child.stdout}`);
    const started = existsSync(marks) ? readFileSync(marks, 'utf8') : '';
    assert.equal(started, '', 'claude was started with these arguments');
  }
);
