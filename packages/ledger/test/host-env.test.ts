// The environment a host program gets inside an AppImage. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { test } from 'node:test';
import { hostEnv } from '../src/platform.ts';

const mount = '/tmp/mount/Oddboro';

test('outside an AppImage the environment is the one passed in', () => {
  const env = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/lib' };
  assert.equal(hostEnv(env), env);
});

test('an AppImage drops the bundled library path and its folders on PATH', () => {
  const env = hostEnv({
    APPDIR: mount,
    APPIMAGE: '/opt/Oddboro.AppImage',
    LD_LIBRARY_PATH: `${mount}/usr/lib`,
    LD_PRELOAD: `${mount}/lib/preload.so`,
    PATH: [`${mount}/usr/bin/`, '/usr/bin', '/tmp/mount/Oddborox/usr/bin'].join(delimiter),
    HOME: '/opt/owner'
  });
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.PATH, ['/usr/bin', '/tmp/mount/Oddborox/usr/bin'].join(delimiter));
  assert.equal(env.HOME, '/opt/owner');
  assert.equal(env.APPDIR, mount);
});

test('a saved library path is put back, and an empty one means unset', () => {
  const restored = hostEnv({
    APPIMAGE: '/opt/Oddboro.AppImage',
    APPIMAGE_ORIGINAL_LD_LIBRARY_PATH: '/opt/nvidia',
    LD_LIBRARY_PATH: `${mount}/usr/lib:/opt/nvidia`,
    APPIMAGE_ORIG_LD_PRELOAD: '/opt/preload.so',
    PATH: '/usr/bin'
  });
  assert.equal(restored.LD_LIBRARY_PATH, '/opt/nvidia');
  assert.equal(restored.LD_PRELOAD, '/opt/preload.so');
  assert.equal(restored.PATH, '/usr/bin');

  const cleared = hostEnv({
    APPDIR: mount,
    APPIMAGE_ORIGINAL_LD_LIBRARY_PATH: '',
    APPIMAGE_ORIG_LD_LIBRARY_PATH: '/opt/should-not-win',
    LD_LIBRARY_PATH: `${mount}/usr/lib`,
    PATH: [`${mount}/usr/bin`, '/usr/bin'].join(delimiter)
  });
  assert.equal(cleared.LD_LIBRARY_PATH, undefined);
  assert.equal(cleared.LD_PRELOAD, undefined);
  assert.equal(cleared.PATH, '/usr/bin');
});
