// How the office reads a coding tool's version (`versionOf` in versions.ts).
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { versionOf } from './versions.ts';

const folder = mkdtempSync(join(tmpdir(), 'oddboro-versions-'));
after(() => rmSync(folder, { recursive: true, force: true }));

test(
  'a tool that prints its version and then hangs past the time limit gives no version, never what it printed before it hung',
  { skip: process.platform === 'win32' && 'the stand-in is a script with a #! line' },
  async () => {
    // The read waits 15 seconds before it gives up, so this test takes that long.
    writeFileSync(
      join(folder, 'codex'),
      `#!${process.execPath}\nprocess.stdout.write('codex-cli 0.166.0\\n');\nsetTimeout(() => {}, 60_000);\n`
    );
    chmodSync(join(folder, 'codex'), 0o755);
    const was = process.env.PATH;
    process.env.PATH = folder;
    try {
      assert.equal(await versionOf('codex'), undefined);
    } finally {
      process.env.PATH = was;
    }
  }
);
