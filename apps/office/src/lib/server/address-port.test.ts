// The address the server gives when the office runs on a port other than
// 4500 (`ODDBORO_PORT`). Its own file, since the port is read as the ledger
// loads: it is set here before address.ts is imported. Nothing listens on it
// and no server starts. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { after, mock, test } from 'node:test';
import { HOSTS } from './hosts.ts';

process.env.ODDBORO_PORT = '4651';
const { address } = await import('./address.ts');

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

test('an office on its own port that could not check port 80 gives that port in the address, not 4500', async () => {
  // Nothing outside this process is asked: the real name does not resolve
  // here, nothing answers at the address, and every look at port 80 finds its
  // command missing, on whichever system this runs.
  mock.method(dns, 'lookup', async () => {
    throw new Error('no answer');
  });
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('nothing answers');
  });
  mock.method(
    childProcess,
    'execFile',
    (cmd: string, _args: string[], _options: object, done: (e: Error) => void) => {
      done(Object.assign(new Error('not there'), { code: 'ENOENT', syscall: `spawn ${cmd}` }));
      return {};
    }
  );
  syncBuiltinESMExports();
  assert.deepEqual(await address(), { host: HOSTS[1], port: 4651, state: 'unchecked' });
});
