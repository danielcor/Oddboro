// Each call the office's own code makes out of its process by a name
// `check-outbound.ts` counts (that file lists what it counts and what it does
// not, such as each AI tool's run in a child process). Hard rule 4 says
// nothing leaves the office without the owner's yes, so each entry says where
// its calls go, what they send and whose yes covers them. `check-outbound.ts` fails when a
// file's calls differ from its entry here.

export type Outbound = {
  /** The file, from the repo root. */
  file: string;
  /** How many call sites the file has, as check-outbound.ts counts them. */
  calls: number;
  to: string;
  sends: string;
  yes: string;
};

export const OUTBOUND: readonly Outbound[] = [
  {
    file: 'apps/office/src/lib/server/postal-codes.ts',
    calls: 1,
    to: 'GeoNames (download.geonames.org), for its postal code file for one country.',
    sends:
      'The country the owner picked, in the file name. Never the postal code: the office looks it up in the file on this computer.',
    yes: 'The owner pressing Show weather in Setup with a new country or postal code.'
  },
  {
    file: 'apps/office/src/lib/server/weather.ts',
    calls: 1,
    to: "MET Norway's forecast service (api.met.no).",
    sends:
      "The place's latitude and longitude rounded to one decimal (about 11 km), and Oddboro's name and version.",
    yes: 'The owner turning weather on in Setup. The office asks only while a page of it is open and seen, and not before the last answer expires; Turn off stops it.'
  },
  {
    file: 'apps/office/src/lib/server/project-sessions/codex-rpc.ts',
    calls: 2,
    to: 'The local Codex App Server, through authenticated loopback or the private socket the owner chose.',
    sends:
      'Native conversation requests, assignments, corrections and answers to provider permission prompts.',
    yes: 'The owner turning on Advanced mode and connecting that conversation; a shared Odd sends only after the owner takes over its exact proposal, or at Act when the owner lets it send to that session without asking.'
  },
  {
    file: 'apps/office/src/lib/ui/ProjectSessions.svelte',
    calls: 2,
    to: 'The office on this computer.',
    sends: 'The selected session ID for updates and a request for the system folder picker.',
    yes: 'The owner opening Projects and choosing a project folder.'
  },
  {
    file: 'apps/office/src/lib/ui/ProjectTerminal.svelte',
    calls: 1,
    to: 'The office on this computer.',
    sends: 'The selected session and terminal view IDs for its output stream.',
    yes: 'The owner opening that native terminal.'
  },
  {
    file: 'apps/office/src/lib/ui/project-api.ts',
    calls: 1,
    to: 'The office on this computer.',
    sends: 'The selected project action, instruction, file reference or native terminal input.',
    yes: 'The owner taking that action in Projects. Native tool approval remains in the native conversation.'
  },
  {
    file: 'apps/office/src/lib/server/access.ts',
    calls: 1,
    to: 'A hosted connector, at the address it was saved with.',
    sends:
      "The connector's own secrets in its headers, a request for its tools, and each call an Odd's run makes to it through the office's gateway (gateway.ts), with that call's arguments. For LegalZoom physical mail, also the owner's mailbox list and check while they choose one mailbox in setup.",
    yes: 'The owner adding that connector, and granting the Odd it at Read only or Read and write.'
  },
  {
    file: 'apps/office/src/lib/server/aws.ts',
    calls: 5,
    to: "AWS, in the Regions the owner named: IAM Identity Center's sign-in and role lookup, and Secrets Manager.",
    sends:
      "The sign-in's device request and its token, the account and role the owner picked, the names of the owner's secrets, and each secret an AWS tool's key is read from.",
    yes: 'The owner signing in to AWS, choosing the role on the desk, and picking a key from AWS.'
  },
  {
    file: 'apps/office/src/lib/server/address.ts',
    calls: 6,
    to: "Caddy's admin and the office's own address on this computer, GitHub for Caddy's release and checksums, and the name server this computer uses, for the office's address.",
    sends:
      "The office's Caddy settings, kept on this computer, a download request for Caddy, and the name local.oddboro.com to look up.",
    yes: "The owner setting up the office's address in Setup."
  },
  {
    file: 'apps/office/src/lib/floor/engine.ts',
    calls: 1,
    to: "The office, on this computer: the floor's sprite atlas.",
    sends: "A request for the atlas. Nothing of the owner's.",
    yes: 'The owner opening the office; nothing leaves this computer.'
  },
  {
    file: 'apps/office/src/lib/floor/looks.ts',
    calls: 1,
    to: "The office, on this computer: an Odd's drawn look.",
    sends: "A request for the look. Nothing of the owner's.",
    yes: 'The owner opening the office; nothing leaves this computer.'
  },
  {
    file: 'apps/office/src/lib/ui/ChatPanel.svelte',
    calls: 2,
    to: 'The office, on this computer: the chat route.',
    sends: "The owner's chat messages, to the office that runs the Odd.",
    yes: 'The owner sending the message; nothing leaves this computer here.'
  },
  {
    file: 'apps/office/src/lib/ui/UpdatesSection.svelte',
    calls: 1,
    to: 'The office, on this computer: its live line of changes.',
    sends: "A request to hear changes. Nothing of the owner's.",
    yes: 'The owner opening the Setup window; nothing leaves this computer.'
  },
  {
    file: 'apps/office/src/lib/ui/api.ts',
    calls: 4,
    to: "The office, on this computer: the page's routes.",
    sends:
      "The owner's actions on the page, to the office, and each file the owner attaches in a chat (`sendFile`).",
    yes: 'The owner acting on the page; nothing leaves this computer here.'
  },
  {
    file: 'apps/office/src/lib/ui/music.svelte.ts',
    calls: 1,
    to: 'The office, on this computer: the focus noise file.',
    sends: "A request for the file. Nothing of the owner's.",
    yes: 'The owner playing focus noise; nothing leaves this computer.'
  },
  {
    file: 'apps/office/src/lib/ui/atlas.ts',
    calls: 1,
    to: 'The office, on this computer: the sprite atlas.',
    sends: "A request for the atlas. Nothing of the owner's.",
    yes: 'The owner opening the office; nothing leaves this computer.'
  },
  {
    file: 'apps/office/src/routes/+page.svelte',
    calls: 1,
    to: 'The office, on this computer: its live line of changes.',
    sends: "A request to hear changes. Nothing of the owner's.",
    yes: 'The owner opening the office; nothing leaves this computer.'
  },
  {
    file: 'apps/office/src/lib/server/gemini.ts',
    calls: 1,
    to: "Google's Gemini models list.",
    sends: 'The Gemini API key the owner typed, to check it works.',
    yes: 'The owner giving the office a Gemini API key.'
  },
  {
    file: 'apps/office/src/lib/server/google/http.ts',
    calls: 1,
    to: 'Google: Gmail and Drive.',
    sends:
      "The owner's token, and what each call needs: an Odd's read, search, draft, change or send, or a reply or filter the owner sends from its card on the desk, with any files from the Odd's own folder attached to it (`mailAttachments`).",
    yes: "The owner signing Gmail or Drive in and granting the Odd it at Read only or Read and write, or the owner's Send, Save to drafts or Create on the card."
  },
  {
    file: 'apps/office/src/lib/server/oauth.ts',
    calls: 2,
    to: "A connector's sign-in server, GitHub for a server that signs in through New Altitude's GitHub app, Google to read which account a Gmail or Drive sign-in is, and New Altitude's site for the owner's account, each persona's sign-in and the list of personas the account is offered (account.ts's and persona.ts's calls go through this file's `steadyFetch`).",
    sends:
      "The office's sign-in requests and tokens for that connector, account or persona, the token asking New Altitude who is signed in and which personas it offers, and the sign-out's token to revoke.",
    yes: "The owner signing a connector in, signing in to their New Altitude account, or a persona's Add or Reconnect."
  },
  {
    file: 'apps/office/src/lib/server/persona-door.ts',
    calls: 1,
    to: "A persona's door on New Altitude, at its account's sign-in server.",
    sends:
      "The persona's own sign-in token, and for each chat, job or follow-up of that persona Odd, a hand-off from another Odd included: the owner's name, what it was asked and its hands' report, cut to the door's limit, with a chat's earlier exchanges.",
    yes: "The owner's Add on that persona, which lets each of those runs answer through its door."
  },
  {
    file: 'apps/office/src/instrumentation.server.ts',
    calls: 1,
    to: "New Altitude's relay for reports, or the owner's own Sentry when a build from source names one.",
    sends:
      "Error and trace reports from the server, carrying only what `diagnostics.ts` lets through (no chats, no Odds' work and nothing from the owner's files), with the New Altitude sign-in on those to the relay.",
    yes: "The owner's Diagnostics switch in Setup. With no answer, nothing is sent."
  },
  {
    file: 'apps/office/src/hooks.client.ts',
    calls: 2,
    to: 'The office itself: the page sends through it and never to the relay.',
    sends:
      'Error and trace reports from the page, each through the same filter, which the office then forwards as `instrumentation.server.ts` says. Also, to /api/client-log, that the page booted and each error it hit, at most 20 a page load, which the office writes to the log on this computer and sends nowhere.',
    yes: "The owner's Diagnostics switch in Setup for the reports. With no answer, the office drops what it gets. The log lines stay on this computer, so they need none."
  },
  {
    file: 'apps/office/src/lib/server/versions.ts',
    calls: 1,
    to: 'The npm registry.',
    sends: "An AI tool's package name, to read its newest version. Nothing of the owner's.",
    yes: "The owner's choice of AI tool; the check sends no owner data."
  },
  {
    file: 'packages/ledger/src/search-model.ts',
    calls: 1,
    to: "GitHub, for the search model's files on Oddboro's own release (github.com), and the GitHub host it redirects them to. A redirect anywhere else is refused.",
    sends: "A download request for each file. Nothing of the owner's.",
    yes: "The owner clicking Download on Setup's ledger search line. Embedding itself runs inside the office and sends nothing."
  },
  {
    file: 'packages/ledger/src/local-db.ts',
    calls: 1,
    to: "The office's own database socket, in the office home on this computer.",
    sends: 'Nothing: it only opens a connection, to learn whether another office answers there.',
    yes: 'None needed: nothing leaves this computer, and it carries no data.'
  },
  {
    file: 'packages/ledger/src/office-access.ts',
    calls: 1,
    to: "Google's token revocation address.",
    sends: 'The Gmail or Drive sign-in being removed, so Google cancels it too.',
    yes: 'The owner disconnecting that connector.'
  },
  {
    file: 'packages/ledger/src/registry.ts',
    calls: 1,
    to: 'The MCP Registry.',
    sends: "The search words, the owner's or an Odd's.",
    yes: 'The owner searching for a connector, or granting an Odd find_connectors.'
  },
  {
    file: 'packages/ledger/src/setup.ts',
    calls: 3,
    to: 'The office, on this computer.',
    sends: 'Requests asking whether the office is up and how it can be reached.',
    yes: 'The owner running setup; nothing leaves this computer.'
  },
  {
    file: 'apps/desktop/src-tauri/src/update.rs',
    calls: 1,
    to: "The desktop app's update feed on GitHub (tauri.conf.json's updater endpoints).",
    sends: "The app's version and system, as the updater asks for its feed.",
    yes: 'The owner installing the desktop app, which checks for updates.'
  },
  {
    file: 'apps/desktop/src-tauri/src/diagnostics.rs',
    calls: 5,
    to: "New Altitude's relay for reports, or the owner's own Sentry when the settings name one.",
    sends:
      "The shell's error reports, carrying only what this file lets through, with the New Altitude sign-in as a bearer token on those to the relay.",
    yes: "The owner's Diagnostics switch in Setup. With no answer, nothing is sent."
  }
];
