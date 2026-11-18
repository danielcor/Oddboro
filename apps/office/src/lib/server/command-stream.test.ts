// The runner the page's installs and sign-ins stream through
// (command-stream.ts), with a shortened sign-in limit and `sh` commands that
// stand in for an installer or a sign-in: an install runs to its end however
// long it takes, a sign-in past its limit stops and says why, and a sign-in
// that fails ends on its own last line. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandSlot, type Action } from './command-stream.ts';

/** Far shorter than the commands below take, so a cut would show. */
const SHORT_MS = 200;

const start = (action: Action, script: string) =>
  commandSlot(SHORT_MS).start(action, 'sh', ['-c', script], { PATH: process.env.PATH });

const parse = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { line?: string; url?: string; done?: boolean; ok?: boolean });

/** Run `script` through a slot with the short limit, as `action`, and read every line it streams. */
const run = async (action: Action, script: string) => parse(await start(action, script).text());

test('an install that takes longer than a sign-in may is never cut, and ends done', async () => {
  assert.deepEqual(await run('install', 'sleep 1; echo Installed.'), [
    { line: 'Installed.' },
    { done: true, ok: true }
  ]);
});

test('a sign-in that outlasts its limit is stopped, and says so in plain words rather than ending on its own last line', async (t) => {
  // The limit runs on a mock clock, moved on only once the sign-in page's
  // line is in: on a busy machine `sh` can take longer to print it than the
  // limit itself.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // `exec`, so the wait is the command the runner stops, as a real sign-in is.
  const res = start(
    'sign-in',
    'echo "Open this URL to sign in: https://auth.example/x"; exec sleep 30'
  );
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const more = async () => {
    const { value, done } = await reader.read();
    if (value) text += value;
    return !done;
  };
  while (!text.includes('"url"') && (await more()));
  t.mock.timers.tick(SHORT_MS);
  while (await more());
  assert.deepEqual(parse(text), [
    { line: 'Open this URL to sign in: https://auth.example/x' },
    { url: 'https://auth.example/x' },
    { line: 'The sign-in took longer than 5 minutes, so the office stopped it. Try again.' },
    { done: true, ok: false }
  ]);
});

test('a sign-in whose command fails ends not done, on its own last line', async () => {
  assert.deepEqual(await run('sign-in', 'echo "Could not sign in."; exit 1'), [
    { line: 'Could not sign in.' },
    { done: true, ok: false }
  ]);
});
