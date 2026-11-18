// What Setup says when the owner did not see the test notification: each
// system's own steps, in the app and out of it, and what a browser's own
// notifications need on each system. A type import only, so the page can
// load it.
import type { System } from '@oddboro/ledger/platform';

/** One step. `open` gets an Open it button, `test` is Send another test. */
export type NotifyStep = { text: string; open?: true; test?: true };

const CHECK =
  "Check that notifications are on in your system's settings, and not paused or in Do Not Disturb.";
const TEST: NotifyStep = { text: 'Send another test', test: true };

/** The steps before Send another test, by system, then in the app or run from the repo. */
const HELP: Record<System, { app: NotifyStep[]; repo: NotifyStep[] }> = {
  mac: {
    app: [
      { text: 'In System Settings, open Notifications.', open: true },
      { text: 'Find Oddboro. Turn on Allow notifications.' }
    ],
    repo: [
      { text: 'In System Settings, open Notifications.', open: true },
      {
        text: "Find Script Editor: it carries the office's notifications. Turn on Allow notifications."
      },
      {
        text: 'If Script Editor is not listed, open it once from Applications, Utilities, then come back.'
      }
    ]
  },
  // Linux has no one settings page, and in the app the office does not send
  // through notify-send, so neither is named there.
  linux: {
    app: [
      { text: CHECK },
      {
        text: 'Your desktop needs a notification service. GNOME, KDE and most desktops have one built in.'
      }
    ],
    repo: [
      { text: CHECK },
      {
        text: 'Oddboro sends them with notify-send, so your desktop needs a notification service. GNOME, KDE and most desktops have one built in.'
      }
    ]
  },
  windows: {
    app: [
      { text: 'In Settings, open System, then Notifications.', open: true },
      { text: 'Find Oddboro. Turn on Allow notifications.' }
    ],
    repo: [
      { text: CHECK },
      {
        text: "They arrive as Windows PowerShell's. In Settings, Notifications, check that Windows PowerShell is allowed.",
        open: true
      }
    ]
  }
};

/** What a browser's own notifications need besides the site's permission, where the system asks for more. */
const BROWSER_NEEDS: Record<System, string | undefined> = {
  mac: 'On a Mac, the browser itself also needs notifications on in System Settings, Notifications.',
  linux: undefined,
  windows: undefined
};

/** The line for this system, or none, as on a system the office does not know. */
export function browserNeeds(system: System | undefined): string | undefined {
  return system ? BROWSER_NEEDS[system] : undefined;
}

/**
 * The steps for this system. Open it only where the office can open the
 * settings page (`canOpen`); a system it does not know gets the general check.
 */
export function notifyHelp(o: {
  system: System | undefined;
  app: boolean;
  canOpen: boolean;
}): NotifyStep[] {
  const steps = o.system ? HELP[o.system][o.app ? 'app' : 'repo'] : [{ text: CHECK }];
  return [...steps.map((s) => (s.open && !o.canOpen ? { text: s.text } : s)), TEST];
}
