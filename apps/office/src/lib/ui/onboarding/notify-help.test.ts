// The help Setup gives when the test notification did not show: each
// system's own steps, in the app and out, with Open it only where the office
// can open a settings page, and what a browser's own notifications need.
// NotifyHelp.svelte is compiled and rendered on the server, as the page would
// show it. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import type { System } from '@oddboro/ledger/platform';
import { compiledForServer } from './compiled-for-server.ts';
import { browserNeeds, notifyHelp } from './notify-help.ts';
import type NotifyHelpComponent from './NotifyHelp.svelte';

const NotifyHelp = await compiledForServer<typeof NotifyHelpComponent>(
  join(dirname(fileURLToPath(import.meta.url)), 'NotifyHelp.svelte')
);

const shown = (props: { system: System | undefined; app: boolean; canOpen: boolean }) =>
  render(NotifyHelp, { props: { ...props, onOpen: () => {}, onTest: () => {} } }).body;
const texts = (o: { system: System; app: boolean }) =>
  notifyHelp({ ...o, canOpen: true }).map((s) => s.text);

const CHECK =
  "Check that notifications are on in your system's settings, and not paused or in Do Not Disturb.";

test('Linux in the app gets its own steps, with no Open it and no System Settings', () => {
  const body = shown({ system: 'linux', app: true, canOpen: false });
  assert.match(body, /not paused or in Do Not Disturb/);
  assert.match(body, /notification service/);
  assert.match(body, /Send another test/);
  assert.doesNotMatch(body, /Open it/);
  assert.doesNotMatch(body, /System Settings/);
});

test('a Mac with a settings page to open gets an Open it button', () => {
  assert.match(
    shown({ system: 'mac', app: true, canOpen: true }),
    /<button class="link"[^>]*>Open it<\/button>/
  );
});

test('a system with no settings page gets no Open it, whatever its steps say', () => {
  for (const system of ['mac', 'windows'] as const)
    assert.equal(
      notifyHelp({ system, app: false, canOpen: false }).some((s) => s.open),
      false,
      system
    );
});

test("the Mac's and Windows's steps are the ones Setup gave before", () => {
  const again = 'Send another test';
  assert.deepEqual(texts({ system: 'mac', app: true }), [
    'In System Settings, open Notifications.',
    'Find Oddboro. Turn on Allow notifications.',
    again
  ]);
  assert.deepEqual(texts({ system: 'mac', app: false }), [
    'In System Settings, open Notifications.',
    "Find Script Editor: it carries the office's notifications. Turn on Allow notifications.",
    'If Script Editor is not listed, open it once from Applications, Utilities, then come back.',
    again
  ]);
  assert.deepEqual(texts({ system: 'windows', app: true }), [
    'In Settings, open System, then Notifications.',
    'Find Oddboro. Turn on Allow notifications.',
    again
  ]);
  assert.deepEqual(texts({ system: 'windows', app: false }), [
    CHECK,
    "They arrive as Windows PowerShell's. In Settings, Notifications, check that Windows PowerShell is allowed.",
    again
  ]);
});

test('Linux out of the app keeps the notify-send line', () => {
  assert.deepEqual(texts({ system: 'linux', app: false }), [
    CHECK,
    'Oddboro sends them with notify-send, so your desktop needs a notification service. GNOME, KDE and most desktops have one built in.',
    'Send another test'
  ]);
});

test("only a Mac is told the browser itself needs notifications on in the system's settings", () => {
  assert.deepEqual((['mac', 'linux', 'windows', undefined] as const).map(browserNeeds), [
    'On a Mac, the browser itself also needs notifications on in System Settings, Notifications.',
    undefined,
    undefined,
    undefined
  ]);
});
