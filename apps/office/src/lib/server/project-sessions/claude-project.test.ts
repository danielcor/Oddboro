// Find existing asks Claude Code which sessions run in a project. When it
// cannot answer, the owner reads plain words, never the raw error of starting
// the command, its path, or what it printed.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { CLAUDE_LIST_FAILED, claudeProjects } from './claude-project.ts';

/** The office's words for each system it runs on, written out. */
const NOT_INSTALLED: [NodeJS.Platform, string][] = [
  ['darwin', 'Claude Code is not installed on this Mac.'],
  ['linux', 'Claude Code is not installed on this computer.'],
  ['win32', 'Claude Code is not installed on this computer.']
];
const FAILED = "Claude Code could not list this project's conversations. Try again.";

/** What listing `folder` throws, with PATH only `path`. */
async function refusal(folder: string, path: string): Promise<string> {
  const was = process.env.PATH;
  process.env.PATH = path;
  try {
    return await claudeProjects(folder).then(
      () => assert.fail('listing should have failed'),
      (e: Error) => e.message
    );
  } finally {
    process.env.PATH = was;
  }
}

test('with no Claude Code on this computer, listing a project says it is not installed on this Mac or computer, with no raw error or path', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'office-claude-project-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    for (const [system, words] of NOT_INSTALLED) {
      Object.defineProperty(process, 'platform', { value: system });
      // An empty folder as the whole PATH, so no claude can be found.
      const refused = await refusal(root, root);
      assert.equal(refused, CLAUDE_LIST_FAILED.missing(), system);
      assert.equal(refused, words, system);
      assert.doesNotMatch(refused, /ENOENT/);
      assert.ok(!refused.includes(root), refused);
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * How a stand-in `claude` answers `agents --json`, as a shell script body.
 * Each prints its own path, as a real failure's text would, so a test sees
 * whether any of it reaches the owner.
 */
const ANSWERS: [string, string][] = [
  ['exits 1', 'echo "Command failed: $0 agents" >&2; exit 1'],
  ['exits 0 with text that is not JSON', 'echo "$0: not JSON"'],
  ['exits 0 with an object, not a list', 'echo "{}"']
];

test(
  'when Claude Code fails, or answers with anything but a list, listing a project says it could not list them, with no path or raw error',
  { skip: process.platform === 'win32' && 'the stand-ins are shell scripts' },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'office-claude-project-')));
    try {
      for (const [how, body] of ANSWERS)
        await t.test(`a claude that ${how}`, async () => {
          const bin = await mkdtemp(join(root, 'bin-'));
          writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${body}\n`);
          chmodSync(join(bin, 'claude'), 0o755);
          const refused = await refusal(root, bin);
          assert.equal(refused, CLAUDE_LIST_FAILED.failed);
          assert.equal(refused, FAILED);
          assert.ok(!refused.includes(root), refused);
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('when Claude Code does not answer in time, listing a project says it could not list them, with no command text', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'office-claude-project-')));
  const started: string[][] = [];
  // probe reaches execFile through its import, so the stand-in goes on the
  // module and the import is brought up to date with it. execFile marks the
  // error `killed` when its own timer stopped the command.
  mock.method(
    childProcess,
    'execFile',
    (cmd: string, args: string[], _options: object, done: (e: Error) => void) => {
      started.push([cmd, ...args]);
      done(
        Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}`), {
          killed: true,
          signal: 'SIGTERM'
        })
      );
      return {};
    }
  );
  syncBuiltinESMExports();
  try {
    const refused = await refusal(root, root);
    assert.deepEqual(
      started.map((s) => s.slice(-4)),
      [['agents', '--json', '--cwd', root]]
    );
    assert.equal(refused, FAILED);
    assert.ok(!refused.includes(root), refused);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
