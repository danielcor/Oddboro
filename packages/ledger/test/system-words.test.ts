// The words Setup's first card says that differ by system, word for word on
// each, and on a system the office does not know.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computerWord, systemWords } from '../src/system-words.ts';

test('each system, and one the office does not know, gets the words Setup said before they moved into one table', () => {
  const computer = {
    word: 'computer',
    label: 'This computer',
    trustAsks: "It takes your computer's password, once.",
    trustWaiting: 'Waiting for your password',
    trustFailed: 'The certificate was not trusted. Try again, and enter your password.',
    notFirefox: 'Chrome or Edge'
  };
  assert.deepEqual(systemWords('mac'), {
    word: 'Mac',
    label: 'Your Mac',
    trustAsks: "It takes your Mac's password, once.",
    trustWaiting: 'Waiting for your password',
    trustFailed: 'The certificate was not trusted. Try again, and enter your password.',
    notFirefox: 'Safari or Chrome'
  });
  assert.deepEqual(systemWords('linux'), computer);
  assert.deepEqual(systemWords('windows'), {
    ...computer,
    trustAsks: 'Windows asks you to confirm it, once.',
    trustWaiting: 'Waiting for you to confirm',
    trustFailed: 'The certificate was not trusted. Try again, and confirm when Windows asks.'
  });
  assert.deepEqual(systemWords(undefined), computer);
});

test('the computer is a Mac only on a Mac', () => {
  assert.deepEqual((['mac', 'linux', 'windows', undefined] as const).map(computerWord), [
    'Mac',
    'computer',
    'computer',
    'computer'
  ]);
});
