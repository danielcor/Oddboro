// What a run's office tool server is told about the run. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { officeEnv } from './run-env.ts';

const plain = { key: 'k1', signedOut: [], lessonRun: false, networkHeld: false };

test('every run carries its key, so a thread it hands off on holds its pick-ups while it goes', () => {
  assert.equal(officeEnv(plain).RUN_KEY, 'k1');
  assert.equal(officeEnv({ ...plain, threadId: 7, handOffId: 3 }).RUN_KEY, 'k1');
});

test("only a run that reads the owner's no or edit for a lesson is told it hands nothing on", () => {
  assert.equal(officeEnv({ ...plain, lessonRun: true }).LESSON_RUN, '1');
  assert.equal(officeEnv({ ...plain, fromColleague: true }).FROM_COLLEAGUE, '1');
  assert.equal(officeEnv(plain).FROM_COLLEAGUE, undefined);
  assert.equal(officeEnv(plain).LESSON_RUN, undefined);
});

test("the owner's words are cut to 4000 units, never between the two halves of an emoji", () => {
  const long = 'a'.repeat(3999) + '😀' + 'b';
  assert.equal(officeEnv({ ...plain, ownerSaid: long }).OWNER_SAID, 'a'.repeat(3999));
  assert.equal(officeEnv({ ...plain, ownerNote: long }).OWNER_NOTE, 'a'.repeat(3999));
  const fits = 'a'.repeat(3998) + '😀' + 'b';
  assert.equal(officeEnv({ ...plain, ownerSaid: fits }).OWNER_SAID, 'a'.repeat(3998) + '😀');
});

test("a chat's last exchange reaches the tool server, cut to fit", () => {
  assert.equal(officeEnv({ ...plain, chatExchange: 'x' }).CHAT_EXCHANGE, 'x');
  const long = 'a'.repeat(3999) + '😀' + 'b';
  assert.equal(officeEnv({ ...plain, chatExchange: long }).CHAT_EXCHANGE, 'a'.repeat(3999));
});

test('the files the owner attached reach the tool server whole, never cut, and none sets nothing', () => {
  const files = Array.from({ length: 10 }, (_, i) => ({
    tag: `Image #${i + 1} ${'x'.repeat(400)}`,
    path: `attachments/20261111-090000-aaaa-${i}.png`,
    name: `${i}.png`
  }));
  assert.deepEqual(JSON.parse(officeEnv({ ...plain, ownerFiles: files }).OWNER_FILES), files);
  assert.equal(officeEnv({ ...plain, ownerFiles: [] }).OWNER_FILES, undefined);
});

test("a run below the Odd's level names its level, and the rest only when set", () => {
  assert.deepEqual(officeEnv(plain), { RUN_KEY: 'k1' });
  assert.deepEqual(
    officeEnv({
      ...plain,
      ownerSaid: 'Hi',
      approvedAsk: 4,
      signedOut: ['gmail', 'slack'],
      ownerNote: 'Not Fridays.',
      ownerEdit: 'New text',
      ceiling: 'draft',
      handOffId: 3,
      threadId: 7,
      networkHeld: true
    }),
    {
      RUN_KEY: 'k1',
      OWNER_SAID: 'Hi',
      APPROVED_ASK: '4',
      SIGNED_OUT: 'gmail,slack',
      OWNER_NOTE: 'Not Fridays.',
      OWNER_EDIT: 'New text',
      CEILING: 'draft',
      HAND_OFF_ID: '3',
      THREAD_ID: '7',
      OFFICE_NETWORK_HELD: '1'
    }
  );
});

test('only an owner chat gets the updater snapshot', () => {
  const update = {
    current: '0.0.10',
    managed: true,
    ready: false,
    version: null,
    installAt: null,
    checking: false,
    checked: null
  };
  assert.equal(officeEnv({ ...plain, update }).ODDBORO_UPDATE_STATUS, undefined);
  assert.deepEqual(
    JSON.parse(officeEnv({ ...plain, update, ownerSaid: 'Check updates' }).ODDBORO_UPDATE_STATUS),
    update
  );
});
