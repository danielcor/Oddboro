// How the office opens a file on this computer, with the opener stubbed, so no
// test starts a browser. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

type Spawned = EventEmitter & { unref: () => void; unrefs: number };
const spawned: { cmd: string; args: string[]; options: object; child: Spawned }[] = [];
/** What the stub opener does once spawned: exit with a code, fail to start, or stay up. */
let then: { exit: number } | 'fails to start' | 'stays up' = { exit: 0 };
mock.module('node:child_process', {
  namedExports: {
    execFile: () => assert.fail('only spawn opens a file'),
    execFileSync: () => assert.fail('only spawn opens a file'),
    spawn: (cmd: string, args: string[], options: object) => {
      const child = Object.assign(new EventEmitter(), {
        unrefs: 0,
        unref: () => void child.unrefs++
      });
      spawned.push({ cmd, args, options, child });
      const does = then;
      setImmediate(() => {
        if (does === 'fails to start') return void child.emit('error', new Error('spawn ENOENT'));
        child.emit('spawn');
        if (typeof does === 'object') child.emit('exit', does.exit, null);
      });
      return child;
    }
  }
});
const { OPENER_FAILS_WITHIN_MS, hostEnv, openFile } = await import('../src/platform.ts');
// The failures below are logged on purpose; keep them out of the test output.
mock.method(console, 'error', () => {});

test('a file opens with the system opener, the path whole in one argument, detached, with no shell and no wait', async () => {
  then = { exit: 0 };
  const path = '/srv/office/game.html';
  const openers: Partial<Record<NodeJS.Platform, [string, string[]]>> = {
    darwin: ['open', [path]],
    win32: ['rundll32', ['url.dll,FileProtocolHandler', path]]
  };
  const [opener, words] = openers[process.platform] ?? ['xdg-open', [path]];
  assert.equal(await openFile(path), true);
  const [{ cmd, args, options, child }] = spawned.splice(0);
  assert.equal(cmd, opener);
  assert.deepEqual(args, words);
  const { env, ...rest } = options as { env?: NodeJS.ProcessEnv };
  assert.deepEqual(rest, { detached: true, stdio: 'ignore' });
  assert.deepEqual(env, hostEnv());
  assert.equal(child.unrefs, 1, 'the office does not wait on the browser');
});

test('an opener that will not start says so instead of throwing', async () => {
  then = 'fails to start';
  assert.equal(await openFile('/srv/office/game.html'), false);
  spawned.splice(0);
});

test('an opener that starts and exits with an error says it did not open', async () => {
  then = { exit: 1 };
  assert.equal(await openFile('/srv/office/game.html'), false);
  spawned.splice(0);
});

test('an opener that stays up, as xdg-open may, counts as opened once the wait is over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  then = 'stays up';
  let opened: boolean | undefined;
  const opening = openFile('/srv/office/game.html').then((ok) => (opened = ok));
  await new Promise((started) => setImmediate(started));
  t.mock.timers.tick(OPENER_FAILS_WITHIN_MS - 1);
  await Promise.resolve();
  assert.equal(opened, undefined, 'still waiting for a quick failure');
  t.mock.timers.tick(1);
  assert.equal(await opening, true);
  const [{ child }] = spawned.splice(0);
  // A failure after the wait reaches only the log.
  child.emit('exit', 1, null);
  assert.equal(opened, true);
});
