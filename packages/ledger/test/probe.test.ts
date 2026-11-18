// What a one-shot command comes back as: it ran, it failed, it could not
// start, or it ran out of time. Each command is this Node itself, or a file the
// test makes, so nothing here needs a tool installed.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { probe } from '../src/platform.ts';

const folder = mkdtempSync(join(tmpdir(), 'oddboro-probe-'));
after(() => rmSync(folder, { recursive: true, force: true }));

test('a command that is not there is missing, not an empty answer', async () => {
  assert.deepEqual(await probe('oddboro-no-such-command', []), { status: 'missing' });
});

test('a file marked to run whose interpreter is not there is missing too', async () => {
  // A Mac and Linux refuse it with ENOENT, as execve finds no
  // /no/such/interpreter. Windows refuses it at the start in its own way.
  const file = join(folder, 'not-a-program');
  writeFileSync(file, '#!/no/such/interpreter\nThese are words, not a program.\n');
  chmodSync(file, 0o755);
  assert.deepEqual(await probe(file, []), { status: 'missing' });
});

test('a command that exits with an error failed, with its code and what it printed', async () => {
  assert.deepEqual(
    await probe(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'
    ]),
    { status: 'failed', code: 3, out: 'out', err: 'err' }
  );
});

test('a command still going when its time is up timed out', async () => {
  assert.deepEqual(
    await probe(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 200 }),
    { status: 'timeout' }
  );
});

test('a command that ends cleanly is ok, with what it printed', async () => {
  assert.deepEqual(await probe(process.execPath, ['-e', 'console.log(1)']), {
    status: 'ok',
    out: '1\n',
    err: ''
  });
});

test('input reaches the command on stdin, then ends, so a command reading to the end returns', async () => {
  const echo =
    'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(s))';
  assert.deepEqual(
    await probe(process.execPath, ['-e', echo], {
      input: 'A title\nand "quoted" details',
      timeout: 10_000
    }),
    { status: 'ok', out: 'A title\nand "quoted" details', err: '' }
  );
});

test('with no input, stdin still ends, so a command reading to the end returns before its time', async () => {
  const reader =
    'process.stdin.on("data", () => {}).on("end", () => process.stdout.write("read to the end"))';
  const started = Date.now();
  assert.deepEqual(await probe(process.execPath, ['-e', reader], { timeout: 10_000 }), {
    status: 'ok',
    out: 'read to the end',
    err: ''
  });
  const took = Date.now() - started;
  assert.ok(took < 5_000, `the command waited ${took} ms for stdin to end`);
});

test('a command that ignores SIGTERM is stopped at its time with the signal given, and timed out', async () => {
  // A stand-in that lives 30 s, far past its time, unless something kills it.
  const stubborn = join(folder, 'stubborn.mjs');
  writeFileSync(stubborn, "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000);\n");
  const started = Date.now();
  assert.deepEqual(
    await probe(process.execPath, [stubborn], { timeout: 1_000, killSignal: 'SIGKILL' }),
    { status: 'timeout' }
  );
  const took = Date.now() - started;
  assert.ok(took < 15_000, `the command ran ${took} ms, past its time`);
});
