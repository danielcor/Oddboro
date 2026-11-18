// What Setup and the page call this computer on each system: off a Mac they
// name no Mac, but for the one sentence that lists the systems. Setup's
// checks, its Docker and database fixes (which the terminal's setup shows
// too) and the page's header, in an office under test (office-under-test.ts).
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { folder, onPlatform, withEnv } from './office-under-test.ts';

// After the office under test set its home, as the office's own imports are.
const { checkDatabase, checkDocker } = await import('@oddboro/ledger/checks');
const page = await import('../../routes/+page.server.ts');
const setupRoute = await import('../../routes/api/setup/+server.ts');

/** The one sentence that names a Mac on every system, since it is true on each. */
const ALLOWED = ['Oddboro runs on a Mac, Linux or Windows.'];
const MAC = /\bMac\b/;
const withoutAllowed = (text: string) => ALLOWED.reduce((t, a) => t.replaceAll(a, ''), text);

// A Docker that is installed and not running, and a folder with no Docker at
// all, so both of the Docker check's fixes show whatever this computer has.
const stopped = join(folder, 'docker-stopped');
const none = join(folder, 'docker-none');
mkdirSync(stopped);
mkdirSync(none);
writeFileSync(
  join(stopped, 'docker'),
  '#!/bin/sh\n[ "$1" = --version ] && { echo "Docker version 27.0.0"; exit 0; }\nexit 1\n'
);
chmodSync(join(stopped, 'docker'), 0o755);
/** Nothing listens on port 1, so the database check gives its fix. */
const UNREACHABLE = 'postgres://postgres:postgres@127.0.0.1:1/postgres';

/** Every fix and finding Setup shows that names this computer. */
async function setupWords(): Promise<{ text: string; system: unknown; notifySettings: unknown }> {
  // `GET` and `load` ignore their event; the cast stands in for the one Kit would build.
  const setup = (await (await setupRoute.GET({} as never)).json()) as {
    system: unknown;
    notifySettings: unknown;
    checks: { id: string }[];
  };
  // The keyring check names the store by the system the office loaded on, which
  // a test cannot change (`MAC` in platform.ts), so on this Mac it says the Mac
  // keychain under any system. Every other check is read here.
  setup.checks = setup.checks.filter((c) => c.id !== 'keyring');
  const docker = await Promise.all(
    [stopped, none].map((dir) => withEnv({ PATH: dir }, () => checkDocker()))
  );
  const database = await checkDatabase(UNREACHABLE);
  const { computer } = (await page.load({} as never)) as { computer: string };
  for (const fix of [...docker, ...database.checks].map((c) => c.fix))
    assert.ok(fix, 'each check gives a fix here, or there is nothing to read');
  return {
    text: JSON.stringify({ setup, docker, database, computer }),
    system: setup.system,
    notifySettings: setup.notifySettings
  };
}

for (const [platform, system, notifySettings] of [
  ['linux', 'linux', false],
  ['win32', 'windows', true]
] as const)
  test(`on ${system}, Setup and the page name no Mac but the sentence listing the systems`, async () => {
    const said = await onPlatform(platform, setupWords);
    assert.doesNotMatch(withoutAllowed(said.text), MAC);
    assert.match(said.text, /this computer/);
    assert.match(said.text, /Your computer/);
    assert.equal(said.system, system);
    assert.equal(said.notifySettings, notifySettings);
  });

test('on a Mac, Setup and the page still say Mac', async () => {
  const said = await onPlatform('darwin', setupWords);
  assert.match(withoutAllowed(said.text), /this Mac/);
  assert.match(said.text, /Your Mac/);
  assert.equal(said.system, 'mac');
  assert.equal(said.notifySettings, true);
});
