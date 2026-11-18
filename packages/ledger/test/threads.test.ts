// What a hub is told about its latest threads in a run on no thread, so it can
// continue one rather than open another. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recentThreadsBrief } from '../src/threads.ts';

test('a hub that leads no thread gets no section', () => {
  assert.equal(recentThreadsBrief([]), '');
});

test('each thread is listed with its id, request, where it stands and its goal', () => {
  const text = recentThreadsBrief([
    { id: 34, title: 'Copy the presets', stage: 'under_way' },
    { id: 1, title: 'Build a gravity sim', stage: 'done', goal: 'Learn physics' }
  ]);
  assert.match(text, /^\n## Work you lead\n/);
  assert.match(text, /- Work 34: Copy the presets \(under way\)\./);
  assert.match(text, /- Work 1: Build a gravity sim \(finished, for the goal "Learn physics"\)\./);
  assert.ok(text.indexOf('Work 34') < text.indexOf('Work 1'), 'newest first, as given');
  assert.match(text, /hand_off with continue_work set to its number\. It keeps/);
});

test('a thread with something open on the desk is listed as waiting on the owner', () => {
  const text = recentThreadsBrief([{ id: 9, title: 'Book the hall', stage: 'waiting_on_you' }]);
  assert.match(text, /Work 9: Book the hall \(waiting on \{owner\}\)/);
});

test('a stopped thread is listed as one that cannot be continued', () => {
  const text = recentThreadsBrief([{ id: 7, title: 'Plan the trip', stage: 'stopped' }]);
  assert.match(text, /Work 7: Plan the trip \(it has stopped, so it cannot be continued\)/);
});
