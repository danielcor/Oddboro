// Every published release, newest first, for /releases/. Add one when its
// draft on GitHub is published, with the same version as its tag. A release
// may carry art: a name from scripts/release-art.ts, whose looping GIF and
// still `npm run art` writes for night (static/art/releases/) and for day
// (static/art/day/releases/). The page shows the theme's pair. The newest
// release's art is also the page's link preview, from the frame named as
// `share` in release-art.ts.
import type { BuildId } from '#lib/downloads.svelte.ts';

export type Release = {
  version: string;
  /** The day it was published on GitHub, in Pacific time, as YYYY-MM-DD. */
  date: string;
  title: string;
  summary: string;
  notes: string[];
  /** The builds this release carries. */
  builds: BuildId[];
  art?: {
    name: string;
    alt: string;
    /** What the link preview's frame shows. */
    shareAlt: string;
  };
};

export const RELEASES: Release[] = [
  {
    version: '0.0.11',
    date: '2026-11-13',
    title: 'Work in your own projects with Claude Code and Codex, from the office.',
    summary:
      'Turn on Advanced mode in Setup, and Projects opens Claude Code and Codex in your own folders. Approvals, the Desk and chat all do more for you.',
    notes: [
      'Choose, tool by tool, which changes an Odd makes without asking and which wait for your yes. Each change an Odd waits on says what it does and why.',
      'Answer your Desk from chat: set a goal, approve a plan, give an Odd access, or sign in where it asked.',
      'Add to a Claude Code reply while it runs: Send now, or Ctrl+Enter, puts your words into the reply under way. Stop sits beside the reply.',
      'Your message and files are saved the moment you send them, so closing the tab mid-reply loses nothing. An Odd no longer stays stuck on "Still replying" until you restart the office.',
      "When your computer was off at a job's time, jobs no longer all run at once when it wakes. Each one catches up or skips the missed run, depending on the job.",
      'When work passes from one Odd to another, the next Odd knows what was done, what you said, and which files it has.',
      'Report an Oddboro bug from chat, with the details filled in. An Odd can draft the report for you to file.',
      'Grok and Codex Odds start on Linux. Grok takes long messages and photos on Windows.',
      'Signing in to New Altitude works behind company networks and antivirus that check secure connections.',
      'An Odd can read your LegalZoom physical mailbox. It can only read, never change anything.'
    ],
    builds: ['mac', 'windows-x64', 'windows-arm64', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'advanced',
      alt: 'An Odd types at its desk. On the wall, a switch under a sign marked ADVANCED flips on and its light turns green. The monitor flashes and grows into a wide terminal titled PROJECTS, where lines of code type out and scroll while the Odd keeps working.',
      shareAlt:
        'A pixel-art office desk where the monitor has grown into a wide terminal titled PROJECTS, full of code, beside a wall switch marked ADVANCED.'
    }
  },
  {
    version: '0.0.10',
    date: '2026-11-10',
    title: 'A round of bug fixes.',
    summary:
      'Odds answer again on Windows, drawing works in the app, and installing an AI on a Mac finds npm.',
    notes: [
      'On Windows, an Odd no longer fails on its first message when you use Claude Code a lot.',
      'Drawing works again in the app. A redesign no longer leaves pieces undrawn.',
      'Installing Codex, Gemini or Claude Code on a Mac finds npm when Node comes from nvm, fnm, Volta, asdf or mise. When npm is missing, Oddboro tells you to install Node.js.',
      "When your office's AI is not installed, Oddboro says so and points you to Setup. Onboarding draws your office again after a failed try.",
      'When GitHub stops renewing a sign-in, Settings shows GitHub as needing a new sign-in.'
    ],
    builds: ['mac', 'windows-x64', 'windows-arm64', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'bug-hunters',
      alt: 'A white van marked BUG HUNTERS pulls up outside the office and its back door swings open. Two bug hunters in yellow suits, hoods, gas masks and spray tanks hop out, walk up to the front door side by side, and go in. The door slides shut behind them.',
      shareAlt:
        'A white van marked BUG HUNTERS parked outside a pixel-art office, with a bug hunter in a yellow suit and gas mask beside it.'
    }
  },
  {
    version: '0.0.9',
    date: '2026-11-10',
    title: 'Your New Altitude personas can join your office.',
    summary:
      'Sign in to your New Altitude account from the office, and you can hire your personas as Odds. They work beside the Odds you already have.',
    notes: [
      'Give an Odd a screenshot, a PDF or a text file in chat. Paste it, drop it or pick it.',
      'An Odd can attach its own files to an email reply, or hand them to a colleague.',
      'Odds know who else works in your office, and ask which one you mean when a name could be someone else. You can turn this off for an Odd in its Settings.',
      'Remove an Odd you no longer need. Your Office Manager can bring it back, with its history.',
      'Type to an Odd while it replies. Your message sends when the reply ends.',
      'When an Odd needs to run commands or browse the web, it asks on your Desk, and one click turns it on.',
      'Give an Odd a folder anywhere on your computer, like a project on another drive. A whole drive or system folders warn you first.',
      'Click a file an Odd made with a colleague to open it, and find it later in Storage.',
      'Connect GitHub with one sign-in. No token to make.',
      'Odds can run on Fable 5.2.',
      'Signed in to New Altitude, Oddboro asks once whether it may send error reports. Nothing goes until you say yes, and reports leave out anything personal.',
      'Grok Odds work on a Mac that runs OrbStack, Colima or Rancher Desktop.',
      'The office no longer stops answering when Ollama hangs.',
      'Reconnecting a tool you sign in to no longer asks you for a key.',
      'Oddboro has a new icon: the glowing pixel O.'
    ],
    builds: ['mac', 'windows-x64', 'windows-arm64', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'personas',
      alt: 'Inside the office, the front doors slide open and smoke rolls in. Nate, Michele and Sam Frank walk out of it in gold sunglasses and strike a pose, Michele and Sam with arms up and Nate in the middle with arms down. The view closes in on their faces, they take off their sunglasses together, then Michele walks off one side and Nate and Sam the other.',
      shareAlt:
        'Three people in gold sunglasses strike a pose inside the open front doors of a pixel-art office.'
    }
  },
  {
    version: '0.0.8',
    date: '2026-11-07',
    title: 'Odds work in Gmail, Google Drive and AWS.',
    summary:
      'Connect Gmail, Google Drive or your AWS account, and an Odd can work in it. An Odd at Drafts for your yes can now make changes too, and each one waits for your yes.',
    notes: [
      'An Odd writes each email reply for you to edit, then send or save to your Gmail drafts.',
      'An Odd can suggest a Gmail filter. Filters only sort mail. They never delete or forward it.',
      'Connect more than one Google account. Each one signs in and revokes on its own.',
      "Connect AWS three ways: Secrets Manager, read only, or builder. One AWS sign-in covers all three, and Odds never see a secret's value.",
      'A key for any other tool can come from an AWS secret, instead of one you paste.',
      'Odds reach files only through Oddboro now, on every system, so they reach only the folders you gave them. Grok Odds take a little longer with files.',
      'On a Mac, the keys Oddboro keeps in your Keychain open only for Oddboro.'
    ],
    builds: ['mac', 'windows-x64', 'windows-arm64', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'gym',
      alt: 'In the office gym, an Odd runs on a treadmill, pedals an exercise bike, curls dumbbells, and lifts a loaded bar off the rack and presses it overhead. It carries the bar to a bench, sits facing you, and presses it overhead three times.',
      shareAlt: 'In a pixel-art office gym, an Odd sits on a bench and holds a bar overhead.'
    }
  },
  {
    version: '0.0.7',
    date: '2026-11-06',
    title: 'Updating on Windows no longer starts over.',
    summary:
      'On Windows, the update to 0.0.6 installed 0.0.5 again and started over, with no way to stop it. We shipped the wrong installer. Windows now updates straight to 0.0.7.',
    notes: [
      'Each try left a copy of the installer behind. To get the space back, delete the Oddboro-0.0.6-updater folders in %TEMP%.',
      'When you give an Odd a service that is already connected, Oddboro now says the Odd can use it. It no longer points you to a task that is not there.'
    ],
    builds: ['mac', 'windows-x64', 'windows-arm64', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'loop',
      alt: 'An Odd walks along the office hallway, off its end and back in at its start, three times, saying "UPDATING!", then "AGAIN?", then "AND AGAIN?". The fourth time, it stops halfway, turns to face you and says "OUT OF THE LOOP!"',
      shareAlt:
        'An Odd stands in a pixel-art office hallway, facing out, and says "OUT OF THE LOOP!"'
    }
  },
  {
    version: '0.0.6',
    date: '2026-11-05',
    title: 'Odds pass the work along.',
    summary:
      'Your Office Manager hands pieces of a goal to the Odds you hired, and their work comes back to your Desk.',
    notes: [
      "Your office and each Odd can run on Claude Code, Codex or Grok. You pick the office's at setup.",
      'Each Odd can have its own sign-in, model and thinking level.',
      'Tell an Odd something once, and it keeps it as a lesson.',
      'You can give an Odd folders on your computer to read or change. It can also run commands and browse the web, once you turn those on.',
      "Build an Odd's look from parts, or have it drawn.",
      "Odds can use hosted tools that take a key instead of a sign-in, like Open Brain. The key stays in your computer's password store.",
      'Fixed a bug that was preventing Revoke access for an Odd from working.'
    ],
    builds: ['mac', 'windows-x64', 'windows-arm64', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'hand-off',
      alt: 'Two Odds pass things back and forth in a hallway, a speech bubble for each: a folder ("HAND-OFF!", "HANDS ON!", "FOLDER AND WISER"), a book with an X on it ("CODEX MARKS THE SPOT"), a hop ("GROK ON!"), a sticky note slapped on the wall ("LESSON? IT STUCK."), a key into a brain that lights up ("NO BRAINER!"), and the key taken back ("BACKSIES!").',
      shareAlt:
        'In a pixel-art hallway, an Odd holds a glowing brain with a key in it and says "NO BRAINER!", while another Odd watches.'
    }
  },
  {
    version: '0.0.5',
    date: '2026-11-04',
    title: 'Windows, on Windows, on Windows.',
    summary: 'Oddboro runs on Windows. Download the installer for your chip, x64 or arm64.',
    notes: [
      'Windows warns before the installer runs while it is not signed. Select More info, then Run anyway. This will be solved as soon as we get our Notarization Approval.',
      'Closing the window pauses the music. Opening it again plays on.',
      'The volume slider works on Linux.'
    ],
    builds: ['mac', 'windows-x64', 'windows-arm64', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'windows',
      alt: 'An Odd walks along an endless office hallway, past a window in every other square of the wall and a lamp now and then, and the hallway never ends.',
      shareAlt:
        'An Odd walks along a pixel-art office hallway with a window in every other square of the wall.'
    }
  },
  {
    version: '0.0.4',
    date: '2026-11-04',
    title: 'We closed a gap that could let other websites reach your office.',
    summary:
      'A page open in your browser could send your office requests, like approving an ask. That was our mistake. Now the office takes changes only from its own window.',
    notes: [],
    builds: ['mac', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'locked-door',
      alt: 'The office front door stands open. An Odd walks up, its two doors slide shut together, and it locks them with a CLICK, then steps back, a padlock on the door, and turns to face the street.',
      shareAlt:
        'An Odd stands on the sidewalk facing out, beside the shut front door of a pixel-art office with a padlock on it.'
    }
  },
  {
    version: '0.0.3',
    date: '2026-11-03',
    title: 'Oddboro runs on Linux.',
    summary:
      'Download the AppImage for your chip, x86_64 or arm64, and open it. It does what the Mac app does.',
    notes: [
      'It needs systemd, a keyring and notifications. GNOME and KDE have all three.',
      'On a desktop with no tray, like stock GNOME, closing the window quits Oddboro.'
    ],
    builds: ['mac', 'linux-x86_64', 'linux-aarch64'],
    art: {
      name: 'linux',
      alt: 'An Odd types at a desk. A penguin jumps out of the monitor, arcs over the desk and lands on the floor.',
      shareAlt: 'A pixel-art penguin stands on the office floor beside an Odd typing at its desk.'
    }
  },
  {
    version: '0.0.2',
    date: '2026-11-03',
    title: 'A stuck sign-in starts over.',
    summary:
      'If you close the Claude sign-in page too soon, open it again or cancel. You no longer wait five minutes to try again.',
    notes: [],
    builds: ['mac'],
    art: {
      name: 'stuck-sign-in',
      alt: 'An Odd walks up to the office front door and bumps into it, three times, then backs away with a question mark over its head.',
      shareAlt:
        'An Odd stands outside the shut front door of a pixel-art office with a question mark over its head.'
    }
  },
  {
    version: '0.0.1',
    date: '2026-11-02',
    title: 'Hello, world.',
    summary:
      'The first Oddboro: a pixel office on your Mac, where AI workers called Odds take jobs off your hands.',
    notes: [
      'You pick your Office Manager, your first Odd. It runs the floor and helps you hire the rest.',
      'Odds work on your Claude plan or an Anthropic API key.',
      'Each Odd gets only the access its job needs.',
      'It runs on Macs with Apple silicon.'
    ],
    builds: ['mac'],
    art: {
      name: 'hello-world',
      alt: 'An Odd types at a desk, and a speech bubble above it spells out "Hello, world!" one letter at a time.',
      shareAlt: 'An Odd types at a desk under a speech bubble that says "Hello, world!"'
    }
  }
];
