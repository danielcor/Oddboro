// What an Odd is told names the owner's computer as it is: a Mac only on a
// Mac. A run's brief and a manager's desk at hire, on each system. Run with
// `npm test -w @oddboro/office`.
import { chatOf, L, odd, onPlatform } from './office-under-test.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await L.pg`insert into staff ${L.pg(odd('wren', 'Wren'))}`;

/** Words that would tell an Odd it runs on a Mac. */
const MAC_WORDS = /\b(Mac|Finder|System Settings)\b/;

for (const platform of ['linux', 'win32'] as const)
  test(`on ${platform}, nothing an Odd is told names a Mac, Finder or System Settings`, () =>
    onPlatform(platform, async () => {
      const gave = await chatOf('wren');
      assert.match(gave.system, /runs on their computer\./);
      for (const [what, text] of Object.entries({
        system: gave.system,
        message: gave.message,
        desk: L.managerDesk('Max', 'Plainly.', 'Ada')
      }))
        assert.doesNotMatch(text, MAC_WORDS, `${what} on ${platform}`);
    }));

test("on a Mac, the brief and a manager's desk say the owner's Mac", () =>
  onPlatform('darwin', async () => {
    assert.match((await chatOf('wren')).system, /runs on their Mac\./);
    assert.match(L.managerDesk('Max', 'Plainly.', 'Ada'), /which runs on their Mac\./);
  }));
