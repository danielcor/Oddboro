// No Svelte file in the office branches on the system. Each choice by system
// is a lookup in a `Record<System, ...>` (system-words.ts, or a module beside
// its component, such as notify-help.ts), which the component reads.
// system-branches.test.ts holds the office's TypeScript to the same rule; it
// parses TypeScript, which cannot read a Svelte template, so this one reads
// each file's text for a comparison on a name `system`, or a switch on it.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { svelteFiles } from './source-files.ts';

/**
 * `system` on either side of `===`, `!==`, `==` or `!=`, or as the whole
 * subject of a `switch`, as a whole name.
 */
const COMPARE = /\bsystem\s*[!=]==?|[!=]==?\s*system\b|\bswitch\s*\(\s*system\s*\)/g;

/** The line of each comparison or switch on `system` in one file's text. */
function branches(text: string): number[] {
  return [...text.matchAll(COMPARE)].map((m) => text.slice(0, m.index).split('\n').length);
}

test('a comparison on system counts either way round, as does a switch on it, and another name or a read of system does not', () => {
  const lines = branches(
    [
      "const label = system === 'mac' ? 'a' : 'b';", // 1: counts
      "{#if system !== 'windows'}", // 2: counts
      "{#if 'linux' === system}", // 3: counts
      "{#if 'mac' !== system}", // 4: counts
      // Onboarding.svelte's first card is a step named 'mac', not the system.
      "{#if step === 'mac'}", // 5
      '<NotifyHelp {system} />', // 6
      'const words = systemWords(system);', // 7
      "{#if subsystem === 'mac'}", // 8
      'switch (system) {', // 9: counts
      'switch(system)', // 10: counts
      'switch (subsystem) {', // 11
      'switch (systemName) {' // 12
    ].join('\n')
  );
  assert.deepEqual(lines, [1, 2, 3, 4, 9, 10]);
});

test('no Svelte file in the office compares the system: each choice is a lookup the component reads', () => {
  const files = svelteFiles();
  assert.ok(files.length > 0, 'no Svelte file was read, so nothing was checked');
  const found = files
    .map((f) => ({ path: f.path, lines: branches(f.text) }))
    .filter((f) => f.lines.length);
  assert.deepEqual(
    found,
    [],
    'Move each choice into a Record<System, ...> lookup (system-words.ts) and read it in the component.'
  );
});
