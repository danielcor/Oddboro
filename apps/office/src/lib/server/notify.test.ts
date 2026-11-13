// A failed notification is one log line, and notify-send gets the host's
// libraries. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

delete process.env.ODDBORO_APP;

type Done = (
  error: (Error & { code?: number | string | null }) | null,
  stdout: string,
  stderr: string
) => void;
type Call = { cmd: string; args: string[]; env?: NodeJS.ProcessEnv; done: Done };
const calls: Call[] = [];

mock.module('node:child_process', {
  namedExports: {
    execFile: (cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }, done: Done) => {
      calls.push({ cmd, args, env: options.env, done });
    },
    execFileSync: () => {
      throw new Error('notify does not use execFileSync');
    },
    spawn: () => {
      throw new Error('notify does not use spawn');
    }
  }
});

const { notifyMac } = await import('./notify.ts');
const { hostEnv, SYSTEM } = await import('@oddboro/ledger/platform');

const message = 'ping from the office test';

test('a notification uses the host environment, and a failure is one log line', async () => {
  const errors: string[] = [];
  mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });

  const shown = notifyMac('Oddboro', message);
  const sent = calls.at(-1);
  assert.ok(sent, 'the system notifier was started');
  if (SYSTEM === 'linux') {
    assert.equal(sent.cmd, 'notify-send');
    assert.deepEqual(sent.args, [
      '--app-name=Oddboro',
      '--hint=string:desktop-entry:oddboro',
      '--',
      'Oddboro',
      message
    ]);
  }
  const host = hostEnv();
  assert.equal(sent.env?.LD_LIBRARY_PATH, host.LD_LIBRARY_PATH);
  assert.equal(sent.env?.LD_PRELOAD, host.LD_PRELOAD);
  assert.equal(sent.env?.PATH, host.PATH);
  sent.done(null, '', '');
  assert.equal(await shown, true);
  assert.deepEqual(errors, []);

  const missed = notifyMac('Oddboro', message);
  const failed = calls.at(-1);
  assert.ok(failed);
  failed.done(
    Object.assign(new Error('notifier failed'), { code: 127 }),
    '',
    'symbol lookup error: /lib/libnotify.so.4:\nundefined symbol: g_once_init_leave_pointer\n'
  );
  assert.equal(await missed, false);
  assert.equal(
    errors.at(-1),
    `office: notify failed: ${failed.cmd} exited 127: symbol lookup error: /lib/libnotify.so.4: undefined symbol: g_once_init_leave_pointer`
  );
});
