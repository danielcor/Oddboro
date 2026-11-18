# apps/office

The floor the owner watches, and the desk they work from. SvelteKit 3 with Svelte 5
runes, PixiJS for the pixel-art floor, Tailwind for the page around it, and
Postgres through `@oddboro/ledger`. Port 4500 on 127.0.0.1, or `ODDBORO_PORT`.

`npm test` builds the sprites first when `packages/sprites/dist/meta.json` is
missing, as on a fresh clone: hiring reads it.

Where a new kind of thing starts, the shared function for each job, and the
check that catches a missed place: `docs/architecture.md`.

`vite build` leaves `@oddboro/*` out of the server build (a Rolldown external
in `vite.config.ts`), so each package finds its own files beside its code and
the app ships them whole (`apps/desktop/scripts/stage.ts`). In the app
(`ODDBORO_APP=1`) `hooks.server.ts` quits on SIGTERM and when stdin closes,
and reads the app's key from stdin first (see "Who the office answers").

What the office says about itself, for the app's log and its smoke test
(`apps/desktop/CLAUDE.md`, "Smoke tests"). `init` writes an `office:` line
with the version and system, one per startup step with its time (the key in
the app, secrets, database, tables, update row) and `office: ready N ms after Node started`;
in the app, each time a request computes the setup checks, one
`office: setup <id> ok` or `fail` line per check (the id and result alone,
`logSetup`); a new version's first start writes `office: first start of X after Y`
(`backup.ts` in the ledger). `GET /api/health` serves the same: version,
pid, uptime, step times, how many pages hold the live line and how many page
errors came in (`src/lib/server/health.ts`). The page reports its boot and
every error it hits to `POST /api/client-log` (`src/hooks.client.ts`, as
JSON like every action), which writes one `page:` line each, cut to 600
characters, at most 30 a minute, with `oddboro:` defused so a page never
speaks to the shell. A run that fails or is stopped writes one line to stderr
(`run` in `staff.ts`, `runEndLine`): `office: <Odd>'s <kind> run failed: ` or
`stopped: `, then the first line of why, cut to 200 characters, defused the
same way. Never the owner's message or the reply. The shell puts the time on
every line.

The keychain is the system's own secret store (`@oddboro/ledger/secrets`,
through `src/lib/server/keychain.ts`). In the Mac app the shell keeps it:
`init` in `hooks.server.ts` calls `useShellSecrets()`, which loads every
secret into memory once and sends each change to the shell over the
server's stdin and stdout, so each item trusts only Oddboro. The first start
moves the items `security` kept under `oddboro` across, with no prompt.
Only the server opts in: `cleanEnv` in `claude.ts` drops `ODDBORO_SECRETS`,
and its child processes, the staff tool server among them, keep `security`.
In development the office saves through `security -i` on its stdin, in
pieces under 3,900 bytes a line, so no value is on a command line.

## How it works

1. `src/routes/+page.server.ts` composes the office the owner moved into, or
   the sample Main Street plan until they have one (`currentOffice()` in
   `src/lib/server/space.ts`), and loads the Odds and the owner's desk from
   Postgres (`@oddboro/ledger`). Room names are kept per office: `main-street`
   for the sample, `office-<id>` for a layout.
2. `/atlas/atlas.png` and `/atlas/atlas.json` serve the compiled atlas from
   `packages/sprites/dist/`.
3. The page builds a `Floor` (`src/lib/floor/engine.ts`): sprites by draw
   pass, sky behind windows, and sun shafts and dust by day, unless the
   office's weather is overcast (see "Weather"). At night every
   sprite wears a tint by the hour, emissive pixels ride on top of their own
   sprite at full brightness, and each lamp adds a glow cut to its room.
   Doors open only for an Odd stepping through them. The hour is always
   the office's time zone, which the page gets from the server and sets with
   `setZone` before it shows a time.
4. Each Odd is a `StaffActor` (`src/lib/floor/staff.ts`). It walks to a
   free spot for its activity, preferring its own `room` for work, intake and
   reading. Where it stands is real state: an open ask or task from it puts
   it outside the owner's door (`wait`), a running job puts it to work in its room,
   and so does a thread of its own a colleague holds (its tag reads "Waiting on
   <colleague>"; `floorMode` in `src/lib/staff/odd-now.ts`), and otherwise it wanders between work and breaks. A free Odd's own
   clock starts when it arrives, for a random stay that depends on the
   activity (`STAY` in the page), so Odds never all get up at once. An
   Odd on a job stays at it until the job ends. While an Odd walks, its
   tag reads "→ Room", or "→ <colleague>" on a visit: handing work on, or
   bringing a result back, it walks over, stays about 2 s and goes back to
   the spot it holds (`visit`). It goes after a colleague who moved on while
   it walked up to three times, then stays where it got to. An Odd on a
   thread's work, and its lead while running, show the thread's title and who
   else is on it (`src/lib/staff/thread-tags.ts`). Odds never go home.
   A spot holds one Odd at a time, from the moment one sets off for it:
   every move (the schedule, the Send tab, a chat) skips held spots. A chat
   brings an Odd to the owner's desk, or outside the owner's door when someone is
   already at the desk. The Send tab shows a full place as taken, by whom.
5. `/api/events` is the page's one live line: Postgres NOTIFY (fired by
   triggers on every table, whichever process wrote the row) plus who is
   running a job (`src/lib/server/events.ts`). The page refetches
   `/api/office` on a change. It also carries a `lesson` event (`LessonEvent`)
   for each lesson an Odd keeps (`staff` is the Odd that heard it) and each
   use an Odd makes of one, and a `hand-off` event (`HandOffEvent`) for each
   piece of work an Odd hands a colleague and each result going back, which
   sends `from` over to `to`. On a `lessons` or `lesson_uses` change, or a
   `follow_ups` one, the server reads the rows newer than the last it told
   (`lessonNewsSince`, `handOffNewsSince`), from the newest there when it
   started, so a restart tells nothing again. The owner's Keep, Undo and edits
   are no news, nor is a hand-back that carries the owner's answer. A kept
   lesson plays a notebook once over the Odd that heard it, and a used one a
   note (`pop` on `StaffActor`, art in `fx-pop`). One that arrives while
   another plays is dropped. While it plays, the Odd's name tag rises over it
   (`tagLift`, read in `onRender`) and settles after. Nothing polls.
6. Two full-height panels flank the floor (`src/lib/ui/SidePanel.svelte`).
   Each resizes by dragging its inner edge (or the arrow keys on it), and
   remembers its width per viewer. Where the two overlap, the end one paints
   over the start one, but the start one's front window can sit on top: the
   one the owner opened last sits on top, picking an Odd
   puts that Odd on top, and closing the Odd or clicking the window's tab
   brings the window back on top (`raised` in `windows.svelte.ts`, passed to
   `SidePanel.svelte` as `onTop` in `+page.svelte`).
   The start side is the office plate (name,
   the clock, Setup, and the Desk, Goals, Lessons, Ledger, Services, Hire and Office
   buttons), which opens into a bar of windows
   (`src/lib/ui/windows.svelte.ts`): the Desk, the Goals, the Lessons, the
   Ledger, each hire and each open file is a tab. D opens the Desk. Every
   open window stays mounted, so a drawing keeps going while the owner works
   another. ✕ folds the bar away with its windows still open; closing a
   window with unsaved edits or a drawing in progress asks first.
   The end edge holds the Odds rail (`src/lib/ui/OddsRail.svelte`) once the
   office has an Odd: a ⌘K button on top (Ctrl K off a Mac, set once the
   page knows), then every Odd's portrait, with its
   count of work in progress and an ember ring when it waits on the owner.
   Hovering the rail, moving into it with the keyboard, the ⌘K button or
   Cmd+K (Ctrl+K) from anywhere widens the rail itself toward the floor
   (200 ms, none under reduced motion): each portrait gains its name and
   role, and the top slot a search over name, role and remit (Cmd+K puts the
   cursor there), with the arrow keys to pick one and Enter to open a chat
   (`chatAbout(id, '')`). The portraits stay at the edge. Picking an Odd
   opens its panel, sliding in from the screen's edge, and the rail slides
   off the screen while the panel is open; Cmd+K brings it back over the
   panel until an Odd is picked or the pointer leaves. Closing or folding
   the panel (») brings the rail back. An effect that reads what it writes
   loops until Svelte stops the page (`effect_update_depth_exceeded`): the
   rail's ⌘K effect writes untracked. The
   camera centres on the floor left between the panels and the rail, and
   the Desk pill moves to stay clear. The floor opens on the whole building
   and stays where the owner drags it. While an Odd's panel is open, the
   camera follows that Odd; a drag lets go until the owner selects someone
   or reopens the panel.
7. **The Desk** (`src/lib/ui/DeskDrawer.svelte`) is everything waiting on the owner:
   open asks, open tasks, unread reports. The pill at the top shows the count,
   the tab title carries it, a waiting Odd's tag turns ember, and a
   notification for each new item is one switch away, under You in the Setup
   window (`Welcome.svelte`, per viewer). An open item has All items above it,
   on a row of its own, to go back to the list. A task's Choose one step and a
   chat's first questions share one choice style (`.choice` in `app.css`). A
   task step renders as Markdown: an address links, and inline code copies on a
   click (`copyCode` on `Markdown.svelte`). An open item starts with who sent it:
   portrait, name, role and remit, and a click opens that Odd's card. An ask takes Deny, Iterate or Approve,
   with a reason that is optional except to iterate. Approving starts the
   Odd on it; a Deny with a reason starts the Odd reading it, to keep any
   lesson in it; Iterate sends it back with the owner's words and the new version
   arrives linked to the old. An ask the office raised itself, to keep work
   going past a round's hand-offs or the usage window's, takes no Iterate
   (`yesOrNo` in the ledger's `tools.ts`). The usage window's ask takes Pause it or Let
   it carry on instead, and no Odd reads a no to it. An access ask's Approve reads Connect: once
   approved, the same open card becomes the connect task it made (the decision's answer names
   it, `task`), so the owner goes straight on to Sign in. A task an Odd gave them, marked done, goes back to that Odd to
   pick up from (an intake becomes the hire it was for). One given in a chat
   brings the owner's message there too (`taskDoneBrief` in `src/lib/server/follow-up-brief.ts`). A report has Reply and
   Read: feedback is a reply in its writer's chat, not a form on the desk. Opening
   any item selects it in its sender's chat on the end side. Selecting text in a report offers Chat (`src/lib/ui/SelectToChat.svelte`):
   the owner picks any Odd, and its chat opens with the passage quoted as a
   draft (`chat-about.svelte.ts` carries it to `ChatPanel`). Each of those is a follow-up (`src/lib/server/follow-ups.ts`,
   started from `hooks.server.ts`, woken by changes to `follow_ups` and by any run ending). Its reply
   ends in an outcome line; every outcome goes in the ledger, a failure always
   goes on the desk, and a success only when the owner ticked "Report when done". A
   restart mid-run marks it failed rather than run it twice. When the owner
   gave the answer on a card in the Odd's own chat, the route gets `chat: true`,
   the follow-up keeps that card (`chatCard`, set by `followUp`, `setGoal` or
   `answerLead` in the ledger), and as the run ends `endFollowUp` adds its
   reply to that chat as one `told` line whose `re` names the card
   (`answerInChat` in `staff.ts`); a failed run's line says so in one line and
   carries `runFailed`, never `failed`, which would mark the owner's line before
   it unanswered. An answer on the Desk adds no chat line. A proposed hire
   has "Open hire window" in place of Approve; hiring from it approves it,
   copies the owner's intake into the hire's `notes/intake.md` and links it to
   the goal it was proposed for. Every hire then gets going alone (`firstDay`):
   its first job, if it has one, comes with the hire, its panel opens on Chat
   while it walks in, and it says hello there in the session later chats
   resume. What the hello says, and whether a first day follows, come from
   `firstDayOf` in `src/lib/server/first-day.ts`. A hire with a job then gets a
   `first_day` follow-up that starts its work at once: it checks its intake,
   relevant Ledger entries, shared work and colleagues before asking the owner.
   A colleague's work goes through a hand-off when allowed; only what still
   needs the owner goes on the desk as a task, missing tools as an access ask,
   otherwise the first real piece of
   work, whose result goes on the desk. A hire with no job starts nothing: it
   runs only when handed work. One serving a goal joins the goal's thread as a
   colleague, and the hire route links it to the goal before it approves the
   hire ask, since that answer wakes the goal's lead to hand it its first piece. A goal ask (the manager heard one
   in chat) has "Set the goal". A plan ask lists its parts, each ticked: Odds
   already here taking a part, with a new job or a change to one, and hires.
   Approving takes the ticked parts (`approvePlan`): Odds already here start at
   once, each hire becomes a hire ask the page opens in its own hire window,
   and the owner's steps land as a task. Every plan goes on its goal's thread,
   whatever run raised it, and once those parts exist the answer brings the
   manager back there (`answerLead` in the ledger), told to lead the work by handing each
   piece on; a denied one, told not to start it. The plan's hire asks go on
   that thread too, so hiring one brings the manager back again, to hand the
   hire its first piece.
   A `reply` ask (an Odd's `propose_reply`) opens in its own review
   (`src/lib/ui/ReplyReview.svelte`): "Reply 1 of 3 · from Paige", the Odd's
   summary, the email it answers unfolded on demand
   (`GET /api/asks/[id]/original`, read from Gmail with the office's token,
   shown as plain text), then From (the account, `reply.account`), To, Cc,
   Subject and the body to edit. Replies and filters go through the Gmail
   account their ask names (`mailboxOf`), and a sign-in that is gone puts
   that account's reconnect task on the desk. Send or
   Save to Gmail drafts posts to `/api/asks/[id]/reply`: the office calls
   Gmail itself (`src/lib/server/replies.ts`, building the email with
   `message` in `google/gmail.ts`), and only once Gmail took it approves the
   ask with the owner's version (`approveReply`), one ledger line, and the
   answer going back where the ask came from. Every email Oddboro writes ends
   with "Sent from Oddboro" in plain words (`withFooter` in the
   ledger's `mail-footer.ts`), added where the text is first written:
   `propose_reply` and Gmail's `create_draft`. The owner sees it in the body
   and may delete it; sending never adds it, and only as the email goes does
   "Oddboro" in that last line become a link to oddboro.com (`linkFooter`). A body with an https Markdown
   link goes as plain text and HTML (`bodyParts` in `google/gmail.ts`), the
   rest escaped. A Gmail failure leaves it open
   and shows Gmail's words; Gmail signed out puts the office's reconnect
   steps on the desk and names them. A changed subject or body is kept as
   `replies/<ask id>.md` in the Odd's folder and starts the `edited` run
   (`learnFromReply` in `files.ts`, item 13). Ask for changes is Iterate,
   Discard is Deny, and Skip only moves on. Back, Next and the arrow keys
   (outside a field) step through the open replies, oldest first
   (`ReviewNav.svelte`). Plain Approve refuses a reply.
   A `filter` ask (an Odd's `propose_filter`) opens in
   `src/lib/ui/FilterReview.svelte`: the summary, Matches and Does as fields
   the owner may change, "About N emails match today"
   (`GET /api/asks/[id]/filter-preview`, Gmail's estimate for the search the
   criteria make, counted again when a Matches field changes), and "Also tidy
   the N emails it already matches", ticked. Create filter posts
   `{ criteria, action, tidy }` to `/api/asks/[id]/filter`
   (`src/lib/server/filters.ts`): the office finds or makes the label (never
   one of Gmail's own), tidies the matching mail (listed, then changed 1,000
   at a time), makes the filter last, so a failure leaves nothing to make
   twice, then approves with `approveFilter`. A Gmail failure leaves it open;
   a sign-in from before filters (403, `lacksScope`) puts the reconnect task
   on the desk. Ask for changes and Discard work as on a reply, and Back and
   Next step through the open filters. A `folder` ask (an Odd's
   `ask_for_folder`) shows the folder with the home written `~` (the desk's
   `folders`, worked out on the server) and its level in words
   (`FolderAsk.svelte`), with Deny, Send back (Iterate), Change and Give
   access. Change opens the path field, the system's picker
   (`/api/folders/pick`) and the level toggle, so the owner can narrow it
   first. Give access posts `{ path, level, reason }` to
   `/api/asks/[id]/folder`: `giveFolder` in the ledger checks it as the
   Folders tab does and gives it in the transaction that approves the ask,
   with one Ledger line in the Settings tab's words, and the `carry_out` run
   that answer starts reaches it. A refusal leaves it open and shows the
   Folders tab's line. Plain Approve refuses a folder ask. A `switch` ask (an
   Odd's `ask_for_switch`) takes Turn on, which approves it and turns Run
   commands, Browse the web or both on for that Odd in one step, as the
   Settings tab does. A `level` ask (an Odd's `ask_for_level`) takes Raise to
   and the level it names ("Raise to Act"), and an `office_tool` ask (an
   Odd's `ask_for_office_tool`) takes Turn on; each approves it and makes the
   Settings tab's own change for that Odd in one step. Raise to Act shows the
   Act check first, until the owner passed it (below). A `standing` ask (an
   Odd's `ask_for_standing_yes`) takes Allow or Deny and no Iterate, and Allow
   puts the tools on the grant. Each kind's yes button words live in
   `src/lib/ui/yes-said.ts` (`YES_SAID`), which the Desk imports and
   `yes-said.test.ts` holds. A `remove` ask (an Odd's `leave_office`, or the
   manager's `remove_odd`) takes Remove, and a `bring_back` ask (the
   manager's `bring_back_odd`) takes Bring back; both take Deny and no
   Iterate. An item a lead raised from a colleague's
   handed-back work says so on its sender line ("Marshall, from Paige's
   work", `via` on the ask or task), and the colleague's name opens their
   chat; the item still belongs to the lead.
   A task's steps can carry an action: a hosted server's sign-in, a secret that goes in
   the keychain (`src/lib/server/keychain.ts`), AWS's sign-in, a tool list to confirm, or a
   choice. AWS is three tools the office connects itself (`src/lib/server/aws.ts`,
   the step in `src/lib/ui/AwsSignIn.svelte`), one desk step each: AWS
   Secrets Manager (`aws-secrets`), AWS read only (`aws-read`) and AWS builder
   (`aws-build`). The owner signs in to their IAM Identity Center once for all
   three, on AWS's own page (a device sign-in; where to sign in and the tokens
   go in the keychain as `aws`/`sso` and renew until the access portal session
   ends), and each tool's step then picks one role and its Region
   (`chooseAwsRole`), which connects it (`confirmTools`). Secrets Manager's
   role is the office's: the office answers that tool itself, in this process
   (`secretNamesClient` in `upstream`), with one tool that lists names and
   descriptions and never a value. Read only and builder run AWS's hosted MCP
   Server behind `mcp-proxy-for-aws-cli` (`proxyArgs`, which needs uv), on
   that role's short-lived credentials, which `upstream` fetches when the
   gateway first connects; picking the role first tries a value read with it
   and refuses when AWS answers with one, dropping it unread. Read only's
   `readsByRole` lets a Read only grant reach all its tools, since its role is
   the boundary. Each step's text links to its guide on the site (`AWS_GUIDES`
   and `siteLink` in `src/lib/site.ts`). Once Secrets Manager is connected, a
   key step on any tool can name an AWS secret instead of a pasted key
   (`AwsSecretPick.svelte`, the connector's `fromAws`): the page sees names and
   descriptions only, and `toolKeys` reads the value with the office's role
   whenever `upstream` connects. A run holds back the AWS tools, and any tool
   keyed from AWS, once the AWS sign-in ended (`awsReady`). Any ticked step can be undone (`untickStep`): a checkbox unticks, and an action step has Undo, which opens its action again (a wrong key gets pasted again). A bare key saved for an `Authorization` header goes
   out as `Bearer <key>` (`headerSecret`); a value with a scheme goes as it is. Steps without one tick by hand, as a checklist: only a step with an action, and
   the sign-in's step that ticks itself (its `oauth:` key), holds up Mark done (`stepsToGo` in
   `src/lib/ui/task-steps.ts`). Ticking keeps the task open: the drawer opens an item only
   when its `focus` changes, never because the desk reloaded. Finishing a task records it in the ledger as the owner's work. A task's response
   (`src/lib/ui/TaskResponse.svelte`, one editor on the Desk and on the task's chat card)
   saves through `/api/tasks/[id]` with the version it opened; a draft stays on the task
   (`task-response.svelte.ts`) while the owner moves between tasks. Mark done saves the
   words shown first (`finishWithResponse`), and the follow-up gets them word for word.
8. **The Ledger** (`src/lib/ui/LedgerPanel.svelte`) searches every decision and
   piece of work by meaning. **Goals** (`src/lib/ui/GoalsPanel.svelte`) are what
   the owner wants more of, grouped by area: each with why it matters, what
   done looks like, when, who serves it and their part, and the progress Odds
   log. The owner sets, rewords, pauses, marks met or drops one, and adds or
   takes off Odds (`/api/goals`). Setting one starts the Office Manager
   planning it (a `goal` follow-up), and the plan comes back as one ask.
   An open goal lists its work, newest first, and keeps an ended one
   (`goalsWindow`), each row its title and one line on where it stands
   (`workLine` in `src/lib/ui/format.ts`): who has it, when its lead picks it
   up, paused for the plan's window, waiting on you, done, failed or stopped.
   No row says thread, a number, a hand-off count or tokens. A reopened thread
   is still one row. Under the goals, Other work lists every thread for no goal
   still under way or waiting on the owner, newest first, in the same rows,
   with what each waits on, oldest first. A click on one opens
   the oldest thing it waits on, on the Desk, else its hub's chat, where it
   shows as a card. The list reloads when goals or threads change (`version`).
   **Lessons** (`src/lib/ui/LessonsLibrary.svelte`) is what the office knows
   about the owner: every open lesson (`GET /api/lessons`, `libraryLessons`).
   It opens on About you, the lessons for every Odd; a filter per Odd shows
   what that Odd follows (its own and every Odd's), and All shows every one.
   Guesses waiting for Keep come first, apart from the kept ones, each naming
   the Odd that heard it, with the same controls as on a Lessons tab
   (`Lesson.svelte`). Uses count that Odd's under its filter, else every
   Odd's together. The search box filters by a lesson's words, quote and where
   it applies, on the page. `openLessons(filter)` opens the one window on that
   filter (About you when none is given; `{ staff }` for one Odd, `'all'` for
   the floor's library shelf), and switches an open one to it. It reloads
   when lessons change (`version`).
9. The Odd's panel has three groups, each an icon and a word (the icon
   alone when the bar is under 18rem): **Chat** (the chat alone, with no
   row of tabs), **Knowledge** (a book icon: Skills, Lessons and Storage;
   a persona Odd has no Skills) and **Settings** (its own four tabs,
   below). A group opens on the tab it was last on; the Lessons tab counts
   its guesses, and the Knowledge group itself shows no count. It opens on Chat. Storage
   (`StorageTab.svelte`, what a row lists and says in `storage-list.ts`) is a tree of everything the Odd kept in its own
   folder, then, under Shared work, its part of each thread it is on (by the
   test `workFile` uses, `workTitles` in the ledger), one folder per piece of
   work by its title, newest first. Search covers both, and a shared file
   reads as its work's title and its path there, never a thread's number or
   folder. It comes from `/api/staff/[id]/storage`
   (`oddStorage` in `src/lib/server/storage.ts`): never the office's own
   files (`OFFICE_FILES` in the ledger's `home.ts`), an instruction file, a hidden entry or a
   link, and at most 5,000 entries across both, which it says. A file opens
   in the viewer. It is read when the tab opens and when the office says something
   changed. The Odd's name in the header, with an info icon beside
   it, opens its info page (`OddInfo.svelte`), which has no tab, so the
   tabs have room: one scrolling page of sections, most useful first. Who it
   is, what it is doing now, and what its runs go through (tool, model,
   thinking level); In progress (`WorkSection.svelte`); Jobs
   (`JobsSection.svelte`: click one to edit it in place, "+ Add a job", and
   "Next run today at 3:00 PM" or Paused, from `nextRunAt` and `nextWhen`
   in format.ts); the job description; stats; the look, with Redraw look
   and Send to a place; and Remove from the office, which says what leaving
   does and asks once on the page before DELETE on the staff route lets the
   Odd go (`removeOdd` in the ledger's `leaving.ts`). The Office Manager's page
   has no Remove (`manager` on the profile). The next office load drops the
   Odd from the roster, so it leaves the floor and its panel closes; any run
   of it stops (`stopRuns` in `staff.ts`, registered in `hooks.server.ts`).
   While it has work in progress, a count in a turning
   ring sits beside the name (CSS only, still under reduced motion, and gone
   with nothing in progress); it opens the info page at In progress, as
   `show: {tab: 'work'}` does. The chat stays mounted
   while the panel is open, so a
   reply survives switching tabs or collapsing. A send first keeps the owner's
   line in `chat.jsonl` with its source and turn ID (`keepOwnerTurn` in
   `chat-turns.ts`). Imports and uploads share the existing `attachments`
   folder and `ChatFile` records. Each inline import is checked before any
   part is saved. The runner opens text and PDF files through its file tools;
   Claude Code, Codex and Grok also receive picture bytes. Get a reply on an
   unanswered line reuses its saved input, even after a restart. A finished
   reply carries the same ID. Older lines need none. The chat shows every ask, task
   and report the Odd put on the desk, where it landed (`chatLog` merges
   `deliveries()` into `chat.jsonl`), with where each stands now, and every
   hand-off it gave or got (`handOffsFor`). A hand-off it gave sits on the card
   of its thread (`threadsFor`), where the thread began, even once it is
   continued: its title, when it began, where it stands in the same words as
   the Goals window (`workLine`) and anything waiting on the owner, with each
   step on Open. A click anywhere on a desk item's card opens it: the card is
   one button, its title still selectable, and a click that ends a selection
   opens nothing; its controls sit below it, outside the button. It opens
   on the start side: on the Desk while it waits, else a report in its own
   window (`ReportView.svelte`). A goal or plan card also takes a decision
   in chat, using the Desk's ask route and the same plan checkboxes. The
   manager's New goal box opens from the plus menu, starts empty and sets that exact title through the
   Goals route. A retry with its request id returns the goal already set. A typed
   answer to a task has one path: its response editor on the card, opened
   empty for a plain question, where Save and finish saves the words and
   finishes the task as from chat. A task with choices shows them as buttons,
   a tap answering the choice and finishing it. `chatAnswer` in
   `src/lib/ui/task-steps.ts` says which tasks take one response in chat; one
   with a file to fill in, a sign-in, a secret or a tool step, a choice and a
   response together, or a connect task, stays on the Desk. Files beside a
   response are only to read, so that task answers in chat. Neither starts a chat run; the follow-up
   replies in the chat afterwards. Reply under an item otherwise sends a message about
   it: the run gets the item in full, and a reply about a report marks it read
   and goes in the ledger as the owner's feedback (`replyToReport`). A
   colleague's chat also lists the threads it works on and does not lead,
   those it was handed work on and those of a goal it serves, tells it each
   one's story and what the owner said on it, and `tell_lead` passes what the
   owner says there about one to its lead, who decides the next step, with
   every file they attached to that message (`OWNER_FILES`, from `officeEnv`, each with the owner's name for it, `plainName`). Raising a goal's work there itself is refused, pointing to
   `tell_lead`. Each
   message also tells the session what no run of it wrote (`chatPreface` in
   `src/lib/server/chat-preface.ts`): what the Odd delivered, and the asks
   the owner decided, since it last replied, and the pokes delivered and the lines the office said in the Odd's
   name (`told`, from `sayInChat`, like a new manager's hello) since the owner
   last wrote. A new manager's hello ends with the first of three short
   questions (`FIRST_QUESTIONS` in the ledger's `first-questions.ts`). While
   one is the chat's last line, the chat shows its answers as a column of
   choices on the owner's side, the first marked Default; a tap sends that
   answer as the owner's message. An answer outside the choices runs
   the manager at once. Each of the first two suggested choices gets a
   short acknowledgment and the next question from the office (`chat` in
   `staff.ts`, a `told` line, no run); the third runs the manager, whose new
   session hears all three in its replay. Any Odd offers choices the same
   way: a chat reply that ends with `[choice] ...` lines (every run's
   "How the office works" says so) loses them from its text
   (`splitChoices` in `src/lib/choices.ts`, also on the stream's `done`),
   keeps them as `choices` on its `chat.jsonl` line, and shows them as
   those buttons, with no Default, while it is the chat's last line.
   Every Odd holding `see_office` (all, unless the owner takes it off)
   gets "Who's in the office" in its prompt (`whoIsHereSection` in
   `house.ts`), and every run is told to ask which one when a name could
   be an Odd or someone outside, or there is more than one way to do it.
   The owner's line is stamped when sent,
   so what lands during a reply sits between the two. Under each message is one
   line (`src/lib/ui/chat-lines.ts`): its time ("4 min ago" for an hour, then the
   clock, with the full date on hover or focus), how long a chat run took
   (`took` on the reply's line in `chat.jsonl`), then Reply on a desk item or
   Copy on a message. A day break ("Today", "Yesterday", "Friday, November 6")
   goes between days in the office's time zone. The Odd's work in progress
   shows at the chat's foot, one line each with how long it has run in whole
   minutes and the tool it is using, and a click opens In progress. Its clock
   moves once a minute only while a time still counts minutes or work is in
   progress. The owner can type while the Odd replies; a message sent then
   shows as waiting under the reply, with Cancel to take it back to the box,
   and goes when the reply ends. A second Send while one waits joins it, so
   the Odd answers both in one turn (`waiting` in `ChatPanel.svelte`). A chat
   whose run fails, or throws on the way to a reply, keeps
   the owner's line, and the error in place of the reply, marked `failed`
   (`ChatEntry`), so a reload shows both as the chat showed them live; the
   next message tells the session what the owner wrote that it never had, and
   only that the run failed on a message it has: a resumed session has each
   one up to the last failed run whose tool named a session (`inSession`,
   `chatPreface`), since that run's message carried the earlier ones. The
   owner attaches pictures, PDFs and text files (`ATTACHABLE` in
   `src/lib/attachments.ts`, up to 10 of 10 MB each): pasting or dropping
   one on the box puts its tag at the caret (`[Image #1]` for a pasted
   picture, else its name, `chat-attach.ts`), and Attach files in the plus
   menu adds files to the tray alone. The plus button (More) beside the box
   opens a short menu built from one list (`MORE`: label, action, where it
   shows): Attach files, New goal in the manager's chat, and Report a bug.
   Arrow keys move in it, Enter picks, Escape or a click outside closes it,
   and focus goes back to the box after an action. Report a bug opens a
   review form (`src/lib/ui/BugReport.svelte`) with a title and details,
   the only two fields that leave the office. When the chat's last Odd line
   is a failed reply, its error starts the details (`failedReply` in
   `src/lib/bug-report.ts`), and the owner can edit it. The form says it
   posts publicly on GitHub and needs a GitHub account. Open draft on
   GitHub opens the issue form at `New-Altitude/Oddboro` (`BUG_REPO`) in the
   browser, with details too long for a link left to copy (`browserDraft`);
   nothing is filed until the owner submits it there. When `gh` is on the
   path, Post with GitHub CLI files it with the Mac's signed-in `gh`
   account (`/api/staff/[id]/bug-reports`, the reviewed text on stdin, any
   `GH_TOKEN` dropped), then adds the issue's link to the chat as a told
   line. A post GitHub does not confirm keeps the form and links to the
   issue list; Cancel keeps the chat as it was. The chat has no slash
   commands: whatever the owner types goes to the Odd, a request to report
   a bug included, and a message that names a bug tells the Odd to draft it
   with `draft_bug_report` (`chat-run.ts`). That tool, every Odd's in a chat
   only, keeps the title and details for its run (`keepBugDraft` in the
   ledger's `bug-drafts.ts`); when the run ends the office takes them
   (`takeBugDraft`, gone either way) and keeps them on the reply as `bug`
   (`ChatEntry`). Under such a reply, a File this bug report button (styled as a chat choice) opens the same review form
   with that title and details, editable (`formStart` in
   `src/lib/bug-report.ts`). It never opens GitHub or posts: the owner
   still picks Open draft on GitHub, the form's main button, or Post with
   GitHub CLI. The tray previews each file with a ✕, in a column at the
   end side over the plus button and Send, three files tall at most
   (`.tray`), scrolling past that. The box is always as tall as that
   column (`side` in `fit`), and at least as tall as the plus button and
   Send (`MIN_INPUT`, 76 px), so it grows up as files are attached.
   Deleting a tag drops its file. Copied text that brings a picture of
   itself pastes as text. On Send each file goes alone to
   `/api/staff/[id]/attachments` as application/octet-stream, which keeps
   it in the Odd's own `attachments/` (`src/lib/server/chat-files.ts`)
   under `<date>-<time>-<4 random hex>-<name>`, never over another file,
   then the message names them by tag and kept name. The run's message
   ends with each tag's full path (`attachedBrief` in `chat-run.ts`), and the
   run opens them with its own file tools; Codex, whose `view_image` is
   off, gets the pictures as `--image`. `chat.jsonl` keeps them on the
   owner's line (`files`), and the chat shows them from
   `/api/staff/[id]/attachments/[name]`. An Odd sends any file in its own
   folder on an email: `propose_reply` and Gmail's `create_draft` take
   `attachments` by path (`mail-attachments.ts` in the ledger checks each
   is a plain file there, not hidden and not the office's own, and drops
   the kept name's prefix, so a recipient sees `image.png`). The reply
   review shows them (`/api/asks/[id]/attachments/[n]`) with a ✕ each;
   the owner may take any off, never add one, and the office checks and
   reads them again as it sends. `create_draft` knows whose files to read
   from the call's `_meta` (`ODD_META` in `google/http.ts`), which only the
   gateway and `makeCall` set, on the office's own Google servers alone.
   An email with files goes to Gmail's upload address as MIME
   (`uploadType=multipart`). `hand_off` takes files from the Odd's own
   folder too, `attachments/` included, and the ledger copies them into the
   giver's part of the work's folder as it hands off (`carryFiles`), so the
   colleague reads the owner's screenshot too. A Gmail
   call held at Draft says what it does and to how many emails as its
   title (`heldWords` in `google/gmail.ts`, through `heldWordsFor` in
   `access.ts`), and lists each email's subject, sender and date on the
   desk (`call.shown`, never in an Odd's prompt), with the exact call
   folded under it. `update_labels` takes many `thread_ids` in one call.
   Its input grows with the text
   up to 60% of the chat, and the bar above it drags it taller; that height is
   remembered per viewer. Every run's system prompt opens with "Who you work
   for" (`whoFor` in `staff.ts`): the owner, the Odd's own `notes/intake.md` when it has one, and the active
   goals it serves with its part and the latest progress. An Odd sees only
   the goals it serves. Every run's "How the office works" (`house` in
   `src/lib/server/house.ts`) holds the rules every run keeps, whatever it is
   for: only its reply and what a tool call put on the desk or in chat reach
   the owner, so it never says it sent, gave, brought or handed something no
   tool call in that run did, it never promises the owner a later step that no
   tool call in the run set up, and it speaks of the owner by name or as
   "they" unless told otherwise. A rule for every run goes there, never in
   one run's brief. Before it, "Still on {owner}'s desk from you"
   (`stillOnDeskSection`, from the ledger's `stillOnDesk`) lists the Odd's
   open asks and tasks with their ids, newest first, 15 at most and a count
   of the rest, a reply as "Reply to <subject>", and is left out when there
   are none; a resumed chat hears it when it changes. The rules say to read
   it first and to revise an item rather than raise it again. After it comes "What {owner} has taught you"
   (`taught` in `staff.ts`): the live lessons for this Odd and for every
   Odd, each with where it applies when it says (`lessonLine`), and the rules:
   how the whole office should work (how much to do without checking, how
   the owner wants to hear how things go) is a lesson for every Odd, a vague
   answer gets one follow-up question or nothing kept, a lesson never widens
   the Odd's level or tools (more access is the Settings tab's job), and a
   lesson about writing to the owner covers what they read, not ask and task
   titles. An Odd keeps one from the owner's words in a chat or on an ask or a
   task, or from their edit to one of its files (item 13), which is always a
   guess for that Odd alone. The chat shows each lesson where the Odd kept
   it, and the Lessons
   tab every open one, guesses waiting for the owner's Keep first, each with
   Keep, Undo, Edit and who it is for, and a line when the owner had to say it
   again. A lesson that applies in one place says "Only in: ..." under it, and
   Edit changes its words and where it applies. The tab's label counts those guesses (`guesses` on the profile,
   reloaded with `/api/office` on a `lessons` change). A guess not kept within
   7 days is dropped: it leaves the tab and the count, and its chat line says
   so, with Keep after all. Prompts never name the owner: they say `{owner}`, and
   `run()` in `staff.ts` and `runAsOffice` fill in `ownerName()` for this
   install. `src/lib/server/staff.ts` runs `claude -p` on the owner's login for chats,
   job runs, follow-ups and drafts, or `grok -p` for an Odd that runs on Grok,
   `codex exec` for one on Codex, or `gemini` for one on Gemini (`staff.agent`;
   each gets ready through `LAUNCHES` in `src/lib/server/cli.ts`). The owner picks it in the hire
   window's Model step, stored with the hire before its hello runs, and on the
   Settings tab's Model tab (`AccessTab.svelte`), which both show
   `ModelPicker.svelte`; both list the tools `/api/agents` finds on PATH
   (Grok in xAI's install folder `~/.grok/bin` too, and Claude Code where
   `claudeCommand` finds it on Windows, `agentCommand`),
   with each one's sign-in, which the owner starts beside the picker,
   only those offered on this system (`AGENT_PLATFORMS` in the ledger: Claude
   Code, Codex and Grok on a Mac, Linux and Windows, Gemini nowhere until a
   live run proves its walls). Where `FILES_VIA_OFFICE` says, the office
   carries the run's files: the tool's own file tools are off and the
   ledger's `files-server.ts` is its one way to files, started per run with
   its folders in `ODDBORO_FILES`; a
   switch on the Settings tab goes through `setAgent` from the staff PATCH, clears the Odd's chat
   session, and gets a 409 while the Odd is replying. A computer without the
   picked tool fails the run naming it; it never falls back to the other.
   On the Settings tab (named Access before it held the model too), the
   Model tab (`ModelPicker.svelte`, the hire window's Model step too) picks
   the tool with the same tiles as setup, all one height
   (`ToolTiles.svelte`), with the picked tool's install or update below
   them (`RunsOn` with `installOnly`), then the account it signs in with:
   a card for the tool's Office account and each one the owner added
   (accounts.ts in the ledger), "+ Add a sign-in", and one row of the same
   buttons for the picked account (Sign in, Switch account, Sign out,
   and for an added one Rename and Remove). Every account is a folder of its own, `~/.oddboro/accounts/
<tool>/<id>`, and a run points its tool at it (`GROK_HOME`, `CODEX_HOME`,
   `CLAUDE_CONFIG_DIR`); no run reads another account's folder. Claude Code's
   Office account runs on the owner's own login until it is signed in
   (`claudeRunHome`), and Setup's Claude card and the account card say so.
   A session counts only in the folder it was made in (`home` in
   session.json), so a move starts a new one, which hears the chat and is
   told where the rest is (`chat.jsonl`, replay.ts). Then its model from that tool's list
   (`MODELS` in the ledger's agents.ts, `setModel`; "The office's default"
   keeps the office's: Opus or Sonnet from setup, Codex's and Grok's own),
   passed as `--model` or `-m`, then the permission level, then
   Thinking, which picks how hard its runs think, from the levels
   its tool takes (`EFFORTS` in the ledger's agents.ts): Medium until the
   owner picks, never below Medium for the Office Manager (`effortFor`,
   `setEffort`). Every run passes it: Claude Code's `--effort`, Codex's
   `model_reasoning_effort`, Grok's `--reasoning-effort`, so no Odd takes the
   owner's own Claude Code setting or a tool's default.
   The Act check: before the owner puts any Odd at Act for the first time,
   the page shows three true or false statements in a modal over the whole
   page (`ActCheck.svelte`, a `<dialog>` opened with `showModal`). Escape or
   Cancel changes nothing. The office checks the answers (POST
   `/api/act-check`, `passActCheck` in the ledger; the words and right
   answers live only in the ledger's `act-check.ts`), keeps the pass once in
   `owner.act_check_at` with one ledger line, "Passed the Act check", and
   then the raise goes ahead. A wrong answer shows why under it and keeps
   the answers. Each owner action that puts an Odd at Act goes through
   `withActCheck` (`act-check.svelte.ts`): the level button "Acts on its
   own", a level ask's Raise to Act and a hire at Act. The page knows from
   `actChecked` in its load, and a 409 from the office (`ACT_CHECK_NEEDED`)
   opens it too. The office refuses Act until the pass whatever sends it:
   `changeLevel` and `hire` throw `ActCheckNeeded`, so a level ask's yes
   leaves the ask open. Read and Draft never need it, and an Odd already at
   Act stays there. No Odd's prompt or tool sees the check.
   Right after the check passes, or at once when it was passed before, the
   same three actions ask what happens when another Odd hands that Odd work
   (`HandOffChoice.svelte`, in the check's look), every time an Odd goes to
   Act from a lower level and never for one already there. Ask me first is
   picked to start with every time, by design: no permission is given unless
   the owner picks it. Cancel changes nothing. The raise sends the pick as
   `actsOnHandOffs` (Settings PATCH, the ask POST, the hire POST), and the
   office keeps the stored value when none comes. The words live in the
   ledger's `HAND_OFF_CHOICE`. While the Odd is at Act, the Settings tab shows
   the same two options under Permission level (PATCH with `actsOnHandOffs`
   alone, `setActsOnHandOffs`, refused below Act); below Act they are hidden
   and the stored value stays. Each change writes its own access line, such as
   "Let Ada act on its own on work from colleagues".
   The Settings tab has four tabs, Model first, then Office, Folders and
   Services, each an icon and a word, the icon alone when the bar is under
   22rem (a container query). Office, Folders and Services each have a search
   box over their list, which filters it as the owner types and clears on a
   tab change. Office lists two switches, Run
   commands and Browse the web, above the office tools the owner gives, then
   under Always on, with no switch, each office tool every Odd has that some
   run of this one is offered (`isOffered`, so the Office Manager's leaves out
   Ask to leave; both lists
   split from `OFFICE_TOOLS` by `toolGroups` in `src/lib/ui/tool-groups.ts`,
   and filtered by the same search); Folders
   (`FoldersList.svelte`) lists each folder with Can read and Can write side
   by side; Services holds the outside tools, each with Read only and Read and write side by side, changed in place (`setGrantLevel`, PATCH on the access route): the tool stays signed in, and only Revoke (the trash can) forgets it, after Confirm in place of the row. Refresh beside it reads the service's tools now and says what changed. Actions (n), shut until opened, reads them too as it opens, saying only what changed, and lists every tool the grant reaches, those that change something first (`tools` from the access route), each with what it does in the service's own words (`connectors.toolNotes`, kept current with the rest of the stored tools, `refreshTools`). Each of those has Ask first and Without asking, with the Odd's level as the default: at Draft, Without asking lets the Odd call it with no desk item (PATCH with `tool` and `standing`, `setStanding` in the ledger); at Act, Ask first puts each call to it on the desk (PATCH with `tool` and `askFirst`, `setAskFirst`, and the gateway's `waitsFor`). A tool that only reads says so. Choose a folder asks
   `/api/folders/pick`, which opens the system's own picker on this computer
   (`src/lib/server/folder-picker.ts`: AppleScript on a Mac, PowerShell's
   Forms dialog on Windows, zenity or kdialog on Linux), one at a time; a
   cancel picks nothing, and where none can open the page says why and keeps
   the typed path. A picked folder starts at Can read and goes through the
   same PATCH and `checkFolder` as a typed one. Each service's name there
   has a pencil that edits it in place, Enter or Save to keep and Escape to
   drop (`ServiceName.svelte`), and an AWS tool already connected has Change role or Region
   (`ServiceActions.svelte`, `/api/services/[id]`), which puts its AWS step
   on the desk again from the office (`changeAwsTask`) and opens it. Under a
   grant the Odd's level does not allow, a line says so, with one click that
   raises the level. The plate's Services window (`ServicesPanel.svelte`,
   `services()` in the ledger) lists every service an Odd holds or that is
   connected, with each Odd and its grant; a click on an Odd opens its card.
   The line saying what an Odd is doing names an outside tool's service by
   its name (`serviceNames`, sent with the office state), not its id. Each switch and folder goes through
   the staff PATCH, `setOwnTool` in the ledger's `office-staff.ts` or `setFolder` in its
   `office-folders.ts`,
   which records a Ledger line, gets no 409 and takes effect on the next run;
   a change that opens or closes the internet to the Odd's commands says so
   in the line's body (`NETWORK_NOTE`). The page gets one profile per Odd,
   built on the server (`toProfile` in `src/lib/server/profile.ts`): the
   stored switches and folders, and `reach`, what its runs get now (the
   ledger's `ownTools`, less a network this office holds back:
   `heldReach`). The Odds list shows `reach` as chips beside each Odd's
   role: Commands, Web and its folder count. Run commands shows
   `reach.commands` and how the Odd's tool takes it (`commandsHow`): a switch
   on Claude Code on a Mac and Codex on a Mac and Linux, else unchecked and locked,
   with its reason under it, and the PATCH refuses `{commands}` for a locked
   one. Under one locked off, when a tool on this system follows the switch
   (`offer`), one click moves the Odd there with Run commands on ("Switch Sam
   to Claude Code?"): one PATCH with `{agent, commands}`, which checks that
   the tool it moves to follows the switch before it changes anything. A
   refusal (a 409 while the Odd is replying, or a 400) shows the route's line
   under that button, not at the tab's foot, until the next click. Under
   Browse the web, one line says what the tool's web does and what its
   commands do with it (`webLine` in the ledger's `agents.ts`), such as
   "Search and read web pages. With Run commands on, its commands can reach
   the internet too." A folder is typed as a path and set to Can
   read or Can read and change, anywhere on the computer; `checkFolder`
   refuses the home folder and one that holds or sits in a secret store (at the
   home's top by name, anywhere else by what it holds, in the folder, the folders
   above it and one level down), the office's
   home or Oddboro's code, comparing real paths as the disk spells
   them (`realpathSync.native`), and one whose real path holds `*`, `?`, `[`
   or `]`, which Codex cannot take ("That folder's path has a character an
   Odd's tool can't take: [", `FOLDER_REFUSED.glob`; a folder given before
   that rule is not checked again). A whole drive or system files
   (`broadFolder`) comes back as `{ warning }`, given nothing, and
   `FolderWarning.svelte` shows it with a warning icon, a More info link to
   the site's `/info/folder-sharing/`, and Accept and Cancel; Accept sends the
   same change again with `accept`, on this tab and on a folder ask's Give
   access. `setFolder` refuses a folder on Can read inside one on Can write,
   either way round ("A folder on Can read can't sit inside one on Can write.
   This Odd can already change everything in it.",
   `FOLDER_REFUSED.readInsideChange`), and one that would hold a folder
   dropped for holding keys ("That folder holds one of this Odd's folders that
   has your keys or sign-ins.", `FOLDER_REFUSED.nested`); the line shows under
   the field. Since the tab adds
   each folder at Can read first, a folder to change goes inside one to read in
   either order. An Odd asks for a folder with `ask_for_folder` (item 7), for Run
   commands or Browse the web with `ask_for_switch`, for a higher level with
   `ask_for_level`, and for office tools with `ask_for_office_tool`, never with
   steps for this tab: a rule in `house.ts` says so. The
   list reads the profile's folders, each with the home folder written `~`
   (`shown`), so it loads nothing of its own and the staff route has no GET;
   a level change or Remove sends the path as stored. A folder that holds or
   sits in a secret store (`touchesStore` on the profile, `touchesSecretStore`
   on the server) reaches no run, so it says "Holds keys or sign-ins, so this
   Odd no longer gets it." and can still be removed. One gone from the disk
   reaches no run either, and gets that line only if its stored path is in a store. `run()` takes the
   switches and folders as its tool takes them from `capabilities()`
   (`caps.own`), less a held network, and passes the given folders still on
   the disk and in no secret store (`touchesSecretStore` in the ledger); the prompt lists them under "Where things are", and "What you
   can do" says what the Odd's own tools reach and, for Run commands or
   Browse the web when it lacks one, whether it can ask for it with
   `ask_for_switch` (`ownToolsSaid` in the ledger's `capabilities.ts`, held
   network included), the same line `my_access` gives. `office_report` gives
   it too, naming the Odd, since another Odd reads it ("Rowan's own tools",
   "Rowan's Settings tab"). The same way, an outside tool held back by the
   level tells the Odd to ask with `ask_for_level`, and office tools not all
   given tell it to ask with `ask_for_office_tool` (`OWNER_GRANTS` in the
   ledger's `grantable.ts`); another Odd reading the level line in
   `office_report` still reads that the owner sets it on Rowan's Settings tab.
   `src/lib/server/grok.ts` starts a Grok run from the office's own Grok home,
   `~/.oddboro/grok` (`GROK_HOME`), never the owner's `~/.grok`. The owner signs
   in to it from the office's page (`agent-sign-in.ts`, item 18); a run from a
   home with no sign-in fails pointing to the Settings tab (`endedEarly` in `cli.ts`),
   a run past Grok's plan limit says so in the office's own words, with no
   link (`GROK_PLAN_LIMIT`), and any other early end gives the tool's own words. The sandbox keeps Grok
   from saving a renewed sign-in, so a sign-in that could run out before a
   run ends is renewed first with `grok models` outside the sandbox, and a
   run whose sign-in has still run out is refused pointing to the Settings tab
   (`grokSignedOut` in `grok.ts`). The office carries its files on every
   system (`FILES_VIA_OFFICE`): its `--tools` are `todo_write` (Grok has no
   "no tools") and, with Browse the web, `web_search` and `web_fetch`, with
   `GROK_WEB_FETCH=1` on that run alone (every other grok gets `0`); never a
   file tool of its own or a shell, so Run commands shows off, and no edit is
   allowed, so `dontAsk` refuses any file tool Grok might gain. The office's
   file tools reach it through `search_tool` and `use_tool`. On a Mac and
   Linux a kernel sandbox profile per Odd (per run on a thread) holds the
   whole run, the office's file server included, as a second wall, built on
   Grok's `strict`, which reads the Odd's folders (a chat also the folders of the
   work it leads or is on, in the Odd's own profile), the owner's data folder, the
   folders the owner gave it and the tool server's code, writes the given
   folders it may change (`readWrite`), and
   shuts `~/Library`, `/Library`, and on a Mac `/tmp` and `/var` (Linux leaves those two open: Grok cannot start with either shut); Windows has none. Grok
   refuses every sandbox when `/var/run/docker.sock` is a link to a path off
   its own list (OrbStack, Colima, Rancher Desktop), so then the run gets a
   home of its own in Grok's home, whose `.docker/run` leads to the socket's
   folder (`runHome`), and its tool servers keep the owner's HOME. Any
   other socket link Grok refuses gets the office's own words, with the way to
   another tool (`stoppedWhy` in `cli.ts`). Read
   deny rules (`UNREADABLE`) cover what the kernel still lets it read, Grok's
   home among them, and Edit and Write deny rules cover Grok's home, whose
   sessions folder the kernel lets it write, both further walls should Grok
   ever give a run a file tool. Every deny rule, for either tool, names the
   path and everything under it (`denyRules` in `files.ts`).
   `src/lib/server/codex.ts` starts a Codex run from the office's own Codex
   home, `~/.oddboro/codex` (`CODEX_HOME`), never the owner's `~/.codex`. The
   office writes its `config.toml` only into a home with none, before the
   sign-in check, so the sign-in from the office's page (item 18), where a run
   without one points, is kept as a file. Every run
   passes the office's switches as `-c` (`SWITCHES`) under `--strict-config`.
   With Run commands on (a Mac or Linux), a Codex Odd has a shell, held by
   one kernel permission profile per run
   (`filesystem` in `codex.ts`): everything shut but the system's own folders
   and Apple's developer tools (`codexReads` in `SANDBOX_PATHS`, and the folder `xcode-select -p`
   names, Xcode.app's on a Mac that uses it, found once: `developerReads`) and node's OpenSSL config (`opensslConf`), read, `/tmp` shut, its thread folders, the owner's data folder, the folders the owner gave it
   and the owner's developer tool folders (`devReads` in `sandbox.ts`, as
   Claude Code's commands read them) read, their listed credential files shut
   but not their env files or projects' git configs, its
   folder, its part of a thread, the given folders it may change and its own temp folder
   (`codex-tmp/<run key>`) written, instruction files and the edited file
   never, and no network, Browse the web or not (`network` in the profile,
   from `commandsOnline`: with it on, Codex's commands reached the office's own
   API and database on this Mac). On Linux Codex itself mounts `.codex` and
   `.agents` read only at the top of each write folder, so those two exact paths
   are left to it (`SELF_SHUT`), and no run reads an `AGENTS.md`
   (`project_doc_max_bytes`), since a shut one failed the run's start. The office carries its files
   (`FILES_VIA_OFFICE`), so with Run commands off it has no shell. On Windows
   it never has one: Codex's own sandbox opened every Odd's folder to reads,
   so a run there is in Codex's read-only mode and Run commands stays locked
   off. Its own web search is set per run, `live`
   with Browse the web and `disabled` without (`web_search`, not one of
   `SWITCHES`). The run is a process group of its
   own; when it ends or times out, that group and each of its commands'
   groups stop (`stopGroups` in `launch.ts`). A job a command moves into a
   group of its own (`set -m`) outlives the run, still confined: macOS shows
   no other process's environment, so nothing finds it once it leaves the tree.
   `src/lib/server/gemini.ts` starts a Gemini run from the office's own Gemini
   home, `~/.oddboro/gemini` (`GEMINI_CLI_HOME`), never the owner's
   `~/.gemini`, signed in only with an API key the owner gives on the office's
   page (item 18), kept in the keychain like the Claude key. The keychain is
   read once per office start, the miss too, so a key put there outside the
   page is seen after a restart; with none the run points to the Settings tab and
   starts nothing. A Gemini Odd has file
   tools and, with Browse the web, Gemini's `google_web_search` and
   `web_fetch`; never a shell, so Run commands shows off. Gemini holds its
   reads to its folder, the owner's data folder, its thread folders and the
   folders the owner gave it (`--include-directories`), and one policy file per
   run (`geminiRules`), in a run folder outside every readable path with the
   run's settings and instructions, is its write wall: every tool it does not
   name denied, reads, the web tools with Browse the web and the granted MCP
   tools allowed, writes allowed only by full path under its folder, its part
   of a thread and the given folders it may change, and refused for an
   instruction file there in any case, the edited file in any case, and any
   path with a `.` or `..` part, `//`, a backslash or a character past ASCII.
   The policy is proved against Gemini's own engine
   (`gemini-policy.test.ts`); a message starting with `/` goes in after a line
   break, so Gemini never runs it as a command.
   A chat resumes the Odd's session without waiting for a background slot.
   Stop, beside "is replying…", names the run on that saved turn, and later runs hear that
   reply as stopped by the owner, not failed (`chatPreface`). Ordinary Send
   queues while a reply runs. On a Claude Code Odd the queued message offers
   Send now, and Ctrl+Enter in the box (Ctrl on every system) queues and
   sends now at once: `PATCH /api/staff/[id]/chat` names the run, and
   `addToReply` in `chat-run.ts` writes the words to that run's stdin as a
   second stream-json user message, which Claude Code answers in the same
   turn. A Claude Code chat run reads stream-json and keeps stdin open until
   its result (`streamed` in `runTool`); a run that took added words ends
   when Claude Code does. The words are an owner line of the same turn
   (`source.kind` `added`). A run past its result takes nothing, and the page
   sends the words as the next message. Send now is off for a message with
   files, and absent for one about a desk item or work, and on Codex, Grok,
   Gemini and persona Odds. Closing the window just stops the stream to that
   window. A message about a job or goal in progress goes to its lead.
   Claude Code keeps a session's first system prompt, so a resumed chat's message opens with the
   time and each section that changed since that session last saw it, in full
   (`catchUp` in `src/lib/server/resume.ts`; `session.json` keeps what it saw).
   A chat that starts a new session (after a move to another tool, or with
   `session.json` gone or unreadable: `sessionIdIn`) opens with the latest of
   the chat instead, word for word, oldest first: the newest lines whose text
   and retold files fit in 24,000 characters (`REPLAY_CHARS`), never a failed run's error, and the files changed since
   the oldest of them (since the owner line before it, when that is the Odd's
   reply: `replaySince`) in the Odd's own folder and the folders the owner
   gave it to change, among the first 2,000 entries of each, 30 named and the
   rest counted (`replay` and `changedSince` in `src/lib/server/replay.ts`).
   `chatPreface` leaves out the told, poke and failed run's owner lines the
   replay holds and keeps those the budget cut, so each since the owner last
   wrote is said once; of a failed run's line the replay holds, it says only
   that the run failed.
   Nothing on screen shows it.
   The office tells each run's tool server about the run through its
   environment (`officeEnv` in `src/lib/server/run-env.ts`): every run gets a
   `RUN_KEY`, and a `denied` or `edited` run, which only reads the owner's
   words for a lesson, gets `LESSON_RUN`, so it is offered no `hand_off`. A
   lead's pick-up of a colleague's result gets `VIA`, that colleague (the
   newest result's, when it joins several), which its `raise_ask`,
   `give_owner_a_task`, `propose_reply` and `propose_filter` store as `via`. Jobs, follow-ups
   and drafts each start a fresh session and run side by side, up to three
   per Odd (`AT_ONCE`); the next waits for a slot. Each one is listed in
   `inProgress()` (from `src/lib/server/run-state.ts`, derived from the
   shared `runsGoing` registry) with what it
   is, when it started, and the tool it is using now. The list reaches the
   page with each `working` event; only work starting or ending reloads the
   card's tabs. In progress also lists each follow-up yet to start
   (`followUpsWaiting` in `follow-ups.ts`, from the ledger's
   `followUpsToStart`), such as a lead's pick-up after a task the owner
   finished while the chat that gave it still goes: its title, what it will
   do, and "Starts once <name>'s current run on this work ends". The page
   reads those with `/api/office`, again on each change to `follow_ups`. Every Claude Code run gets the
   office's file tools where `FILES_VIA_OFFICE` says, else its own five
   (Read, Glob, Grep, Write, Edit), `Bash` with Run commands and
   `WebSearch` and `WebFetch` with Browse the web, and reads only its own
   folder, the owner's data folder (as a Grok run does), Claude
   Code's sessions folder for its own folder, where long
   tool results land, on a thread, the thread's folder, and the folders the
   owner gave it. A lead's chat reads
   the folder of each live (active or paused) goal it leads and of its latest
   other work, and a colleague's chat the folder of each piece of work it is on;
   each is told where the work stands, as its pick-ups there are (`readable` in `staff.ts`; Read rules cover Glob and Grep,
   and `dontAsk` turns down every other path). Deny rules beat any allow,
   the owner's own Claude Code settings included, so `unreadable` names what
   stays shut whatever else allows it: the secret stores in `SECRET_STORES`
   (the ledger's `office-folders.ts`, which `checkFolder` also reads): `~/.ssh`,
   `~/.aws`, `~/.gnupg`, `~/.config`, `~/Library`, `~/AppData`,
   `~/.claude.json`, `~/.google_workspace_mcp` (where
   that MCP server keeps its sign-ins for other apps on the Mac), `~/.grok`,
   `~/.codex`, `~/.gemini`, `~/.docker` and `~/.kube`, and the Linux
   browsers' and keyrings' folders `~/.mozilla`, `~/.local/share/keyrings`,
   `~/.pki`, `~/snap` and `~/.var/app`, everything
   in `~/.oddboro` besides `staff/` and `data/` (and `threads/<id>/` for a
   run on that thread), every other
   Odd's folder, and everything in `~/.claude` besides this run's sessions.
   The rules, the sandbox and the system prompt reach Claude Code in files
   beside the run's MCP file (`--settings`, `--append-system-prompt-file`),
   never on the command line: one deny for each folder in `~/.claude/projects`
   passed Windows' 32,767 characters for an owner who uses Claude Code a lot.
   With Run commands, the settings add Claude Code's sandbox (`claudeSandbox`
   in `src/lib/server/sandbox.ts`): commands read what the run reads, plus
   their temp folder, node when it sits in the home folder, the owner's
   developer tool folders, and the system's own folders outside `/Users` and
   `/Volumes` (`denyRead`), write only where the run writes, never the data
   folder or what `deniedEdits` names (`denyWrite`), reach the internet only
   with Browse the web on, and see none of the secrets in the run's
   environment (`credentials.envVars`, `hiddenFromCommands`):
   `ANTHROPIC_API_KEY`, `CLAUDE_CODE_MESSAGING_TOKEN` (which Claude Code sets
   itself), `DATABASE_URL` and every name that says key, token, secret,
   password, credential, auth or cookie, except the office's own git settings
   (`GIT_CONFIG_KEY_0` and `_1`, from `gitEnv` in `launch.ts`), let through by
   exact name (`OFFICE_GIT`), since git stops every command when one is
   hidden; every other name that looks like a secret stays hidden. Claude
   Code and the office's tool server keep them. The developer tool folders
   are those in `DEV_FOLDERS` that exist (`~/.npm`, `~/.nvm`, `~/.volta`,
   `~/.pyenv`, `~/.rbenv`, `~/.cargo`, `~/.rustup`, `~/.bun`, `~/.deno`,
   `~/go`, `~/.gradle`, `~/.m2`, `~/.gem` and `~/.local/bin`), and the file
   each link in `~/.local/bin` leads to elsewhere in the home, never that
   file's folder, read only (`devReads`, which Codex's profile reads too).
   Shut in them, for both tools (`denies`): the files and folders in
   `DEV_SECRETS` (`~/.cargo/credentials`, `credentials.toml`, `config` and
   `config.toml`, `~/.gradle/gradle.properties`, `init.gradle`,
   `init.gradle.kts` and `init.d`, `~/.m2/settings.xml` and
   `settings-security.xml`, `~/.gem/credentials`), and the file in each entry
   of the folders `EACH_ENTRY` names, listed per run: npm's global config in
   each node version nvm and Volta keep (`~/.nvm/versions/node/<v>/etc/npmrc`,
   `~/.volta/tools/image/node/<v>/etc/npmrc`), each script in
   `~/.gradle/init.d`, and the `config` of each repository Go keeps in
   `~/go/pkg/mod/cache/vcs` and Cargo keeps for a git dependency in
   `~/.cargo/git/db`, whose remote's address can carry a token. For
   Claude Code only (`globDenies`), every `.env`, `.env.*` and `.git/config`
   under each folder, as a `**` glob, and the file in every entry of those
   `EACH_ENTRY` folders by a single `*`, so one made during a run is shut
   too; its sandbox honours both (a `cat` failed, measured on 2.1.318).
   Codex gets no glob: none was measured in its profile, so a Codex Odd's
   commands can still read an env file or a project's git config there, and
   an entry made during the run. Whether Codex shuts a whole folder
   (`init.d`) was not measured, so each script in it is listed by name too. A
   credential file that is on no list is read. A folder or link target in or holding a secret store, the
   office's home or Oddboro's code is left out, as `checkFolder` refuses one,
   and so is one whose real path holds a glob character (`GLOB`); a link
   that leads outside the home adds nothing, so one into `/Users`, `/Volumes`
   or a temp folder stays shut. `~/.docker` is not listed: the docker CLI
   needs the daemon's socket, which the sandbox does not open. With Browse
   the web on too, the sandbox allows every host (`OPEN_NETWORK`) but every
   address of this Mac (`macAddresses`), since the office's API and database
   listen here and anything on every address (the office's own Caddy on a
   Mac) is one hop from them: the loopback names and the any-address in
   both families (`MAC_NAMES`: localhost, 127.0.0.1, ::1, [::1], 0.0.0.0, ::
   and [::]), each address `networkInterfaces()` gives at run start, IPv6
   bare and in brackets, and this Mac's own names from `os.hostname()`: that
   string, and the bare name before the first dot alone and with `.local`,
   lowercased, since `<name>.local` resolves to this Mac. The proxy matches
   names in any letter case. Claude Code's proxy (2.1.318) refused the 20
   loopback forms the earlier fix tried, `[::]` and its long form, the LAN
   IPv4 in dotted, decimal, hex, `::ffff:` and `nip.io` forms, IPv6
   link-local addresses, and a Caddy on every address reached by the LAN
   address with `Host: oddboro.localhost`. It matches exact hosts and
   resolved addresses, not ranges, and refuses a zoned address
   (`fe80::1%en0`) as a malformed host, so zones are not listed. Still open:
   other `127.x` addresses (nothing answers there on a Mac unless `lo0` has
   an alias), other machines on the network, and an address this Mac gets
   during a run. A Claude Code that refuses that (`NETWORK_REFUSED`)
   fails the run that met it, which tells the owner so
   (`NETWORK_REFUSED_LINE`), and the office records one Ledger line
   (`holdNetwork` in the ledger); from then on its Claude Code runs keep
   commands off the internet, which the line under Browse the web says, as do
   the prompt and `my_access` of a run that would have had it, `office_report`
   for each such Odd, and the Ledger line of a switch that would open it
   (`heldReach`). Every run's tool server is told the office holds it
   (`OFFICE_NETWORK_HELD`), whatever the run's own tool. The hold is
   in memory, so a restart tries the open network once more. Bash writes in
   every folder Claude Code works in, so `--add-dir` then names only the data
   folder, the folders the run writes and, last, the run's temp folder:
   without it, Claude Code's sandbox lets commands write only its own folder
   inside it, and npm keeps its cache beside that, in `npm`. That run gets a temp folder of
   its own, `/private/tmp/ob-<start of the run key>` as `CLAUDE_CODE_TMPDIR`,
   removed when it ends, the office's git and npm settings (`shellEnv` in
   `launch.ts`: `gitEnv`, npm's cache in the temp folder, and npm's user and
   global configs at files never made, so neither the owner's `~/.npmrc` nor
   the `etc/npmrc` beside the node running npm is read), and
   none of the office's `NODE_OPTIONS`.
   Claude Code's own sandbox refuses every `.git/config` write, so a Claude
   Code Odd cannot start a repository anywhere: `git init` exits 128, even in
   its own folder, and Claude Code's sandbox setting that allows git config
   did not change that on 2.1.318 (measured in a live run).
   A run writes only inside `~/.oddboro/staff/<id>/`, on a thread its own
   part of the thread's folder, and the folders the owner gave it to change,
   never an instruction file in any
   (`CLAUDE.md`, `CLAUDE.local.md`, `.claude`, `.grok`, `AGENTS.md`,
   `.mcp.json`, `AGENTS.override.md`, `.codex`, `.agents`, `GEMINI.md`, `.gemini`; `INSTRUCTIONS` and `deniedEdits` in `files.ts`), nor git's
   usual places, `.git/hooks`, `.git/config` and `.git/modules` (submodules'
   copies), anywhere in a
   folder the owner gave it to change (`REPO_RUNS`, `repoRunPaths`), which it
   still reads, since git cannot run without them (Grok as Edit and Write
   denies only, Gemini as write refusals). They do not stop every way code
   in a project can run later: a `.git` pointer file or `.git/commondir`
   naming a config elsewhere, a nested repository for Codex, and code in
   project files such as package scripts, a Makefile or tests. The owner
   looks at what an Odd changed before running that project's tools. Its own
   folder and its part of a thread are left out, so a Codex Odd can start a
   repository in a subfolder of its own folder; in a granted repository,
   Claude Code's own sandbox refuses a write to `.git/config` too (a live
   run: exit 1, the file unchanged). Codex gets no
   entry: it keeps each write folder's own `.git` read only by itself, so a
   Codex Odd cannot commit in a given repository, and a repository nested in
   a given folder is not covered for Codex, which takes a glob only to deny,
   and a deny stops git reading. Every run with a shell, Claude Code's and
   Codex's, gets the office's git settings (`gitEnv` in `launch.ts`, inside
   `shellEnv`), so an
   Odd's git ignores the owner's global git settings (`GIT_CONFIG_GLOBAL`,
   and `core.excludesFile` and `core.attributesFile` set to nothing) and
   a Codex Odd's `git init` copies no sample hooks (`GIT_TEMPLATE_DIR`, an
   empty folder in the run's temp folder). Codex takes `shellEnv` through one
   `-c shell_environment_policy.set`, since its shell inherits only the core
   variables and a second `set` would replace the first. Nor does it write the file a run
   reading the owner's edit is reading. It gets no skills, no
   plugins, none of the owner's own CLAUDE.md files, no Claude Code
   auto-memory, and of the office process's own environment only the names
   `RUN_ENV_ALLOW` lists (`runEnv` in `run-env-allow.ts`; no `GIT_` or `AWS_`
   variable among them, since a tool server runs outside the sandbox and could
   sign in as the owner). It gets the office's own MCP server (`packages/ledger/src/mcp.ts`) with
   only the office tools the owner ticked under "In the office" on the Settings tab,
   and whatever outside access the owner granted: servers at read (the tools
   the server marks as only reading, less any whose name says it changes
   something: `readsOnly` in `packages/ledger/src/read-only.ts`) or write
   (every tool, from Draft; at Draft each call that changes something waits
   for the owner's yes, below). Every outside tool reaches the
   run through the office's gateway (`src/lib/server/gateway.ts`, at
   `/api/gateway/<connector>`): the run gets the office's address and a
   token that lives as long as the run, never the server's address, key or
   sign-in. The gateway connects to the real server (`upstream` in
   `access.ts`, which starts a command's server with only the names a run
   may have, `outsideToolEnv` in `run-env-allow.ts`, and its own secrets),
   lists only the tools the grant reaches, refuses any other
   call, and keeps the connector's stored tools in step with the list it got
   (`refreshTools` in the ledger): new and dropped tools, Read only's reach
   both ways, each tool's description, and a dropped or redescribed tool off each standing
   yes, each change but a description with a Ledger line. The office does the
   same when the owner opens a service's Actions on the Settings tab, and on
   their Refresh (`/api/services/[id]/tools`, `refreshService`), never on a
   timer. A connector
   that cannot start during a run gets one Ledger line naming it, per run, in
   the office's own words for why and never the error's text, which can repeat
   a key (`whyNoStart`); the run still gets the error itself. A write
   grant at Draft (`writesWait`, either the Odd's own level or a run capped
   there) lists every tool, passes reads on, and holds each call that does
   not pass `readsOnly` (or `readsByRole`) as a `call` ask on the desk
   (`raiseCall`), placed as the run's own asks are (`CallPlace`: its key,
   thread, hand-off and `via`); the same call still open is not raised twice,
   and a lesson run, with no place, is refused one. Each tool that changes
   something is listed with a required `oddboro_title` and `oddboro_why`, the
   Odd's short title and reason for the owner, which the gateway takes out of
   the call and the desk shows as the ask's title (after the service's name,
   unless the office reads one from the call, as for Gmail) and under Why; a
   call without both is refused and holds nothing. The run hears that
   nothing changed yet. A tool the Odd uses without asking (`grants.standing`,
   the ledger's `standing.ts`) goes straight through in any run with a place,
   but one a colleague's words reach (one that serves a colleague's hand-off,
   or a lead's pick-up of a result) while the owner asks first on
   that Odd's work from colleagues (`actsOnHandOffs` off, `handedOver` in the
   ledger's `capabilities.ts`): there each call waits for the owner's yes,
   is listed without the two fields, and each such call rides on the run's
   next held call to that service (`before`), which the desk lists as "Made
   without asking before this call", so a commit shows what it applies.
   Each held call takes only the calls since the run's last one. The
   desk shows the tool and its exact inputs, with Make this
   call: `/api/asks/[id]/call` makes that call itself (`makeCall`, once per
   ask even on a second click), then `approveCall` keeps the result and
   starts the Odd's `carry_out` run, which carries on with what it returned.
   A service the office cannot reach leaves the ask open. The run's
   tool still gets its own per-tool allow list, so either one alone holds. Which outside tools a run gets comes from `capabilities()` in
   `packages/ledger/src/capabilities.ts`, which also says why a granted one is
   held back (above the Odd's level, still connecting). The prompt's "What you
   can do" section, `my_access`, `office_report` and the owner's Settings tab all
   read it for the level, what the Odd's own tools reach (`ownTools`: Run
   commands, Browse the web, whether commands reach the internet, and the
   folders) and each outside tool. The prompt, `my_access` and
   `office_report` also name the tool its runs go through, the prompt and
   `my_access` in one line (`runsOnLine`). A hosted sign-in that ran out
   shows only to the run, which passes it to its own `my_access` as
   `SIGNED_OUT`; `office_report` and the Settings tab still show that tool as
   working. A run below the Odd's own level (a hand-off's, either side, a
   hub's pick-up, or any run that serves a colleague's hand-off, such as the
   carry-out of a level, office tool or outside tool ask raised in one; the
   carry-out of an approval ask, the owner's yes to that exact action, runs
   at the Odd's level) passes its ceiling as `CEILING` the same way, so `my_access`
   says Draft and why, with a write grant read only, as the prompt does
   (`capped`, `accessInRun`). When the owner lets the Odd act on its own on
   work from colleagues (`staff.acts_on_hand_offs`), the hand-off's own run
   and every run that serves it keep the Odd's level; the hub's pick-up, a
   thread picked back up and a lesson run stay at Draft. A run a colleague's
   words reach (one that serves a hand-off, or the hub's pick-up of a result)
   passes `FROM_COLLEAGUE`, so `my_access` leaves out the standing yeses it
   does not have there. An Odd at Act is told what the owner chose, in its
   prompt and in `my_access` (`handOffsLine`). `run-ceiling.test.ts` checks
   every state with the choice off and on.
   Physical mail signs in to LegalZoom's read-only endpoint. The owner chooses
   one PMB for the office on the Desk. A run receives only list, details, and
   scanned text. The gateway supplies the chosen PMB and checks the Odd still
   holds the grant on each request. No setup key or inbox list reaches the Odd.
   `postal.test.ts` exercises this with two synthetic mailboxes. The provider's
   [tool catalog](https://api.earthclassmail.com/v2/mcp_catalog.json) names the
   current schemas. Before release, sign in with an authorized test account,
   select a mailbox, read a known scanned letter in chat and open its original.
   Hosted servers sign in with OAuth (`src/lib/server/oauth.ts`): the task's
   Sign in opens the service, it returns to `/connect/callback`, the tokens go
   in the keychain, and each run's gateway connects with a fresh access token
   as a header. A token is refreshed
   one at a time per sign-in (`once`), since a service may end a sign-in whose
   refresh token arrives twice. For the same reason `steadyFetch` retries only
   a request that never left this computer; one whose answer was lost is not
   retried within one request. GitHub refuses a token request with 200 and its
   error in the body, which the SDK would drop without a word, so `githubRefusal`
   hands the SDK a 400 and logs GitHub's reason, and `freshAccess` logs any
   renewal that did not take. The same provider signs the owner in to New
   Altitude (see "A New Altitude account"). Gmail and Google
   Drive are `builtin` connectors (migration `0009_google`): the office serves
   their tools itself (`src/lib/server/google/`, connected in-process by
   `builtin` in `access.ts`), and signs each in on its own with New Altitude's
   Google Desktop client and its own scopes (`GOOGLE_SCOPES` in `oauth.ts`:
   Gmail's `gmail.modify` and `gmail.settings.basic`, for filters; a stored
   sign-in that lacks one signs in afresh, `covers`; the
   secret from `ODDBORO_GOOGLE_CLIENT_SECRET`, which the shell passes from the
   build, or `.env` in development). A hosted server that signs in through
   GitHub, which lets no app register itself, signs in the same way with New
   Altitude's GitHub OAuth App and `GITHUB_SCOPES` (`ODDBORO_GITHUB_CLIENT_SECRET`):
   `knowServer` finds its sign-in server first, since the SDK picks scopes
   before the app. A build without either secret says so on Sign in
   (`BuiltWithout`). Each Google call asks `bearer` for a live
   token, so it never leaves the office process. One connector is one Google
   account of one product, found by `config.google` (`gmail` or `drive`),
   never by its id: scopes, the server `builtin` makes, and the reply and
   filter routes all go by it. A sign-in keeps the address
   (`config.account`) and renames the connector ("Gmail (ada@example.com)",
   `signedInAs`); one to an address another connector of the product holds
   is not kept (`keepGoogleAccount` in `oauth.ts`): the store gets back what
   it had, Google is not told, and the callback page and the task's sign-in
   step say why. Each account's tools end by naming it (`accountServer` in
   `google/http.ts`). Revoking the last grant cancels the sign-in at Google
   first (`revokeAtGoogle` in the ledger), unless another Google connector,
   either product, is signed in to the same account. A further account
   (`gmail-2`) no Odd holds leaves the catalog. On the Services tab, picking
   Gmail or Google Drive once one is connected lists each connected account
   and "Another Google account" (a connector still waiting on its sign-in,
   or a new one, `another` on the grant). A
   Claude Code run gets its servers as a file in `<home>/mcp/` only the owner
   reads, and a Codex run reads the gateway's token from
   `ODDBORO_GATEWAY_TOKEN`, so no token is on a command line. When a tool an Odd holds stops working, it calls
   `reconnect_access` (every Odd has it): the office puts its own connect
   steps on the desk again (`reconnectTask`), after the Odd's steps for
   getting a new key, with no ask, one open per tool. The key steps go only
   on a tool that takes a key: a sign-in tool's task has no key box, so the
   office leaves them out and tells the Odd. Odds never write connect steps
   by hand.
10. Every run records its tokens per model and the owner's plan windows (5 hours
    and weekly), read from Claude Code's own stream. A run often reports only
    one window, so each is kept as it last came (`notePlan`). The card's back shows
    them (`src/lib/ui/UsageStats.svelte`, LayerChart bars). An Odd's text renders
    as Markdown through `src/lib/ui/Markdown.svelte` (markdown-it, raw HTML
    off). Only a written-out address links out: one with its scheme
    (`https://`, `http://`, `mailto:`, `ftp://`), one that starts `//`, an
    email address, or a Markdown link (markdown-it refuses `javascript:` and
    the like). A bare name like `plan.md` or `www.example.com` stays text
    (linkify's `fuzzyLink` off).
11. The job clock (`src/lib/server/jobs.ts`, started from `hooks.server.ts`)
    keeps one timer for the soonest due job, poke or parked thread, resets on
    any change to the jobs, pokes or threads table, and looks at the time at least every ten minutes because macOS
    stops timers in sleep. A look that fails, as when the database does not
    answer, is logged and tried again in 30 seconds. A run's result goes in the ledger, and on the owner's
    desk as a report when the job says so. Each run records its trigger:
    `schedule` when the timer started it, `manual` when the owner pressed Run now.
    `job-run.ts` uses the shared runner and live slots.
    A job with scheduled files reads its writer's checked result and writes in
    its own part of that work. Opening the job checks the saved assignment,
    accounts and source access without running it. The timer also checks source
    sign-ins. The file server records the read and write; the office checks
    the result against the file on disk. Gemini uses native file tools, so it
    cannot verify a file job. Other jobs run as before.
    A reader's input is its writer's file for the period the run is for
    (`scheduledInput` in the ledger), by the writer's run, never by whether
    the bytes changed. Before a reader runs, the clock asks `readerTurn` in
    `jobs.ts`: while its writer still owes that period (running, due, or owed
    and catching up), the reader owes its time instead and gets in line again
    when the writer's run ends, so after the Mac sleeps both run in order. A
    writer that skipped the period makes the reader skip it too, on the While
    you were away card; one that has not written a first file yet makes it
    skip quietly. While the writer's `catch_up` ask is open the reader waits
    too; a yes runs both in order, and a no makes it skip those periods (a
    change to the asks table makes waiting readers look again,
    `readersLookAgain`). Only a writer that ran for the period and left no checked
    file fails the reader's run.
    A thread its hub parked with `resume_at` wakes at that time: the clock
    starts the hub's `resume` follow-up. One parked on a task (`after_task`)
    wakes when that task is done or dropped, with no clock. So does a thread the usage window
    held, at the window's reset (`handedOff` in the ledger's `src/work/hand-offs.ts`).
    A manual run leaves the schedule where it was, and the Office Manager's report data
    (office times) tells the two apart. The Jobs tab edits a job in place, and opens the Odd's job description
    in the document editor (`src/lib/ui/JobDescription.svelte`); a save
    refuses if the description changed since the owner opened it. On an Odd
    that is not the Office Manager or a persona, the owner can open a Claude
    agent file here to compare and edit its proposed instructions. The section
    lists the file's servers as the hire window does (`AgentFileServers.svelte`),
    less any tool the Odd already holds or has asked for (`sortFor`). Save
    updates the same Odd through the description route, then raises those
    access asks at read, as a hire does; a refused save raises none. The file's
    tools and permission mode are never taken. A local Odd's Skills tab, under
    Knowledge, lists the SKILL.md files the owner attached, each by name with
    when to use it and Remove (`src/lib/ui/StaffSkills.svelte`, the ledger's
    `staff_skills`). Add a skill reads the name and when to use it from the
    file's front matter (`src/lib/staff/skill.ts`); the owner writes what is
    missing, can change either, and reads the text before Save. A name already
    saved shows the saved copy beside the new one. A save or a Remove applies
    only while the saved copy is the one the owner saw. Every run lists each
    skill's name and when to use it under "Your skills" (`skillsSection` in
    `house.ts`), never its text, and the Odd reads one with the office tool
    `read_skill`. A skill grants no tool, folder or permission. While an
    update is about to install it starts no scheduled job (item 17).
    Every job run is told the time it is for and the time it is now
    (`src/lib/server/job-brief.ts`); Run now is for the moment it is pressed. A
    job whose time passed while the Mac slept follows `jobs.missed`
    (`dueNow` in the ledger's `missed-runs.ts`): a `latest` job catches up once
    if under half a period passed since its newest missed time, else skips and
    shows on the desk's While you were away card (`desk().away`, Run now or
    Dismiss, `/api/jobs/away`); a `record` job fills each missed period in one
    run that lists them, or past ten raises one `catch_up` ask. Owed runs
    (`jobs.owed`) wait in the clock's one line and start one after another; a
    job on time never waits for it. A catch-up shows in In progress as
    "Catching up <N> periods of <job>". The job form sets the kind ("When the
    office was off at run time"). To try it in a running office, move a
    job's next run into the past from the repo, with that office's home
    (on Windows, its database port in `ODDBORO_DB_PORT` too). The write wakes
    the clock at once.

    ```sh
    ODDBORO_HOME=<home> node --input-type=module <<'EOF'
    import { pg } from '@oddboro/ledger';
    await pg`update jobs set next_run_at = now() - interval '2 days 45 minutes' where name = '<job>'`;
    await pg.end();
    EOF
    ```

12. **Hire** on the office plate opens the hire drawer
    (`src/lib/ui/HireDrawer.svelte`). An owner can start it from a Claude Code
    agent Markdown file with Import. Its name, description, instructions and
    supported model fill the same form, and the form names in plain words the
    settings left in the file. A header that does not parse says so in one
    sentence. Each MCP server the file lists by an https address, or by a name
    the office's tools have (`knownTools`), becomes an access ask at read on the
    desk when the Odd is hired (`src/lib/server/imported-servers.ts`), so nothing
    connects without the owner's yes. The form's lines about the file are
    `src/lib/ui/AgentFileServers.svelte`. A server that runs a command is listed in
    the form and never run or asked for. Picking another choice clears the
    import. Step one makes the person's look
    (`src/lib/ui/LookStudio.svelte`), drawn or built. Drawn: the owner
    describes them, LookStudio asks `/api/looks`, and
    the owner sees the portrait and the walk, then redraws with a note or keeps it.
    Built: `src/lib/ui/OddParts.svelte` cycles hair, top and bottom and
    picks colours and glasses (the shuffle in the image's corner picks all of them at random), each change rendered at once by
    `/api/looks/parts` from the list at `/api/me/parts`. Building comes first and is the default, since it takes no time; only offices
    whose tool draws looks (`drawsLooks`, `/api/agents`) also offer drawing. The onboarding manager card offers the same, as "Build your own".
    Nobody is hired without a kept look; in the hire window a look built from parts is kept as it lands (`autoKeep` on `LookStudio`), so Next is the one click, and name and role share a line. While it draws,
    `src/lib/ui/PixelDrawing.svelte` paints a bust pixel by pixel beside the
    stage and the time. Step three picks the level; a hire at Act shows the Act check first, until it is passed. Step four, Model, picks
    what its runs go through the way an Odd's Model tab does: the tool, the
    account it signs in with, the model and how hard it thinks, each the
    office's unless the owner picks another (item 9).
    Hiring grants no tools. The Odd asks for Run commands or Browse the web
    with `ask_for_switch` when a job needs one, for a higher level with
    `ask_for_level`, for office tools it lacks with `ask_for_office_tool`, and
    for outside tools with `ask_for_access`. A first job reports to the owner's desk unless they
    untick it; a proposal can say either way. "Draft it" drafts the job
    description. Both run as the office (`src/lib/server/office-run.ts`),
    never as an Odd, so a new office can hire its first. An office run goes
    to the office's tool (`officeAgent()`) through its launch (`LAUNCHES` in
    `cli.ts`): on Grok or Codex with that tool's own sandbox, in a folder of
    its own under `<home>/office/runs` that reads nothing else, has no MCP,
    web or network, and goes when the run ends, pictures and all. A hire with
    no tool picked starts on the office's tool. Opened from a
    proposed hire, it starts filled in, reading the job description from the
    proposer's file at that moment. Hiring writes a `staff` row, and the
    hire comes by bus, an Odd or a persona alike: the bus pulls up at the
    stop, the hire steps off and walks to work, and the bus drives on
    (`ride` in `src/routes/+page.svelte`). The camera shows the whole office
    while the bus comes, then steps in on the hire as it gets off and follows
    it to its spot, as on the first run, unless the owner drags or zooms. Nothing waits on it: it can be
    tapped from the moment it steps off. Only the first run's manager is
    waited for. When the office opens, Odds do not walk in: each starts
    already at its spot (`StaffActor.arrive`), outside the owner's door if they owe
    it an answer, in its room if a job is running, anywhere else otherwise.
13. **Files** an Odd attaches to an ask or a task are rows in the
    `attachments` table, sent with the desk. `src/lib/ui/Attachments.svelte`
    lists them under the item and shows a Markdown one in
    `src/lib/ui/FileEditor.svelte` (a file in `DocEditor.svelte`, the one
    document editor) right there (a task starts in Edit); any
    other file opens in its own window. A file attached from a thread's folder,
    such as a page a colleague built for a goal, is named
    `threads/<id>/<odd>/<path>` (the ledger's `work-paths.ts`). It shows by its
    bare name and opens to read only, since the Odd that attached it may not be
    the one that wrote it (`src/lib/ui/viewer.ts` says what the viewer offers). While an attached file has unsaved
    edits, the desk's finishing buttons wait and leaving the item asks first.
    Files an Odd names in any text it writes open as a window of
    their own (`src/lib/ui/FileViewer.svelte`, the same editor in a window): rendered or editable, saved
    only by Save, with Back asking first when there are unsaved changes. `Markdown.svelte` links a full path, or a path
    inside the writer's folder in code or a link, only once `/api/files/resolve`
    says the viewer opens it, or that it is a page the browser opens (a page links
    even when too big or not text for the viewer), and links that file; anything else stays
    text (`src/lib/ui/file-links.ts` asks once per name per page;
    `src/lib/ui/markdown.ts` renders it). A full path into a thread's folder, in
    text or a `file:` link, is that file's `threads/<id>/...` name for the Odd
    whose part holds it, shown by its bare name; a `file:` link that names no
    office file stays text. Any other full path, from the writer, may be a file
    in a folder the owner gave it: the office answers with its
    `folders/<folder's name>/<path>` name (`givenPath` in `work-paths.ts`), shown
    as `<folder's name>/<path>`, and a `file:` link to one that opens nothing
    keeps only its words. A bare file
    name opens the one file with that name in the Odd's folder, outside hidden folders.
    When no file there has that name, it opens the newest file of that name in
    the Odd's own parts of thread folders, such as a goal's, and the link, the
    viewer and the Ledger still show only the bare name.
    `src/lib/server/files.ts` serves only text files up to 1 MB that already
    exist inside that Odd's own folder, its parts of thread folders, or a
    folder the owner gave it that its runs still get (`givenFile`, through the
    ledger's `ownTools`: never one gone from the disk or in or holding a secret
    store, so a proposed hire's intake never copies a file from one), never
    through a link to a file or a folder. It takes a bare name, or a path
    inside the Odd's own folder such as `site/index.html`, which opens only
    when its real path lands inside that folder; never a full path but one
    into a folder the owner gave it, which opens that one path, by the
    innermost such folder, only to read (the owner's folder holds the owner's
    own work), and nothing in a folder whose name another given folder shares
    or a drive's top; a path
    with a folder never reaches a thread, except a `threads/<id>/...` name
    (an attached file's, a Storage entry's, or the one the page turns a full
    path into), which opens that one file in any part of the
    folder while the Odd is on that thread (`workFile` in the ledger). A folder
    it may not read hides only what is in it. An error the owner reads names
    only the file's bare name (`ownerMessage`); the rest goes to the log. A
    file that is there, in a given folder its runs no longer get, says so by
    the folder's name alone ("notes.md is in old-mac, which holds keys or
    sign-ins, so Paige no longer gets it."; `noFile`). It
    refuses a save if the Odd changed the file
    since the owner opened it, and records each save in the ledger. A save
    that changed the file starts an `edited` follow-up (`learnFromEdit`): the
    Odd reads its version beside the owner's and keeps a lesson only if the
    change shows how the owner wants such work done, as a guess waiting for
    Keep. That run may not write the file. One runs per file: a save before
    it ends joins it, and once it ends, a file changed since it read it starts
    one more (`readEditAgain`). A file on a task is a form the owner fills in,
    so saving it starts none.
    A page an Odd built (`.html` or `.htm`, `src/lib/pages.ts`) links to the
    viewer like any file, which shows its source, and gets an "Open in
    browser" button beside the link and in the viewer's own header, so an
    attached page gets one too. The button posts the same name to
    `/api/files/open`, which finds the file the viewer would open, takes its
    real path, refuses anything else, and opens it as a file on the Mac with
    the system opener (`openFile` in the ledger's `platform.ts`: no shell, and
    the office does not wait on the browser). The office never reads a page it
    opens this way, so a page over the viewer's 1 MB still gets its link and
    button, and only the viewer says it is too big. An opener that fails to
    start or exits with an error within a second tells the owner it could not
    open the page. Like every action, only the
    owner's page reaches it (see "Who the office answers").
14. **Looks.** A look built from parts (`buildLook`) takes a portrait made
    from the same parts (`partsPortrait` in the sprites package) and draws
    nothing, so it runs on any tool. Drawing a look runs only where
    `officeDrawsLooks()` holds: Claude Code on Opus or Fable, Codex on Sol or
    Astra; elsewhere `drawLook` refuses with `cannotDrawLook()`.
    `src/lib/server/looks.ts` draws a person (`drawLook`): one
    office run with the parts library, the swatches, the body, two example
    parts and two example portraits in the prompt. It checks every piece
    (`problemsWith`) and retries once with what was wrong; a failed reply from
    words alone is kept in `~/.oddboro/office/last-look.md`. `/api/staff/[id]/look` and
    `/portrait` serve a hired Odd's frames and portrait, cached per
    version, and PUT on `look` saves a redraw from the card's **Redraw look**. A
    persona Odd's card has no Redraw look and `setLook` refuses one: its look
    is its package's ("A New Altitude persona as an Odd").
    The floor loads each drawn look into the atlas under its own variant
    (`src/lib/floor/looks.ts`), and `Pixel` takes an image `src`.
    The owner can draw someone from a headshot: `LookStudio` shrinks it to
    512 px as a JPEG on the page (which drops its metadata), `/api/looks`
    passes it to `drawLook`, and `runAsOffice` sends it as an image block
    over stream-json input, so the run still has no tools. Office runs pass
    `--no-session-persistence`, so Claude Code keeps no transcript of one. The
    photo, and Claude's `read` and `check` of the face, are never written to
    disk or the ledger.
    With a photo, the prompt (`PHOTO` in `looks.ts`) has Claude write a
    `read` block first (hair darkness and hairline, facial hair and its colour,
    glasses, skin, expression, neckline), then build the look from it.
    Swatches are listed with their hex values so colours match by darkness,
    not name. Without a photo a drawing is one run at low effort, one to two
    minutes; high effort took five to ten and drew no better from words. With
    one, it is two at medium, five to seven minutes, and the hire window says
    so: the drawing, then a look-and-fix run (`lookAndFix`)
    that sees the photo beside the portrait and sprite at 8x, lists what
    differs in a `check` block, and redraws. A fix that fails the checks is
    dropped and the first drawing stands. `/api/looks` takes a `model` from a
    short list (`MODELS` in its route) to compare models; the page never sends
    one, so the office's default draws.
15. **Pokes.** An Odd sets a one-time message for later with `poke_owner`,
    from a chat or a job run; it belongs to the Odd, never to a job. The
    office clock (`src/lib/server/jobs.ts`) delivers it on the minute
    (`deliverPoke` in `staff.ts`): a `poke` line in the Odd's chat and a
    notification on the owner's computer (`notifyMac`: as Oddboro's in the
    app; from the repo through `osascript` on a Mac, `notify-send` on Linux,
    and a toast shown as Windows PowerShell's on Windows). More than 15 minutes late (the Mac
    slept) it is marked missed instead (`pokeMissed`); time the app spent
    down for an update does not count, so a poke due then lands after the
    restart. The chat ends with a line per poke to
    come ("Ada will message you at 7:01 AM"), with Send now (`pokeNow`) and
    Cancel but not its words, so a poke reads first as a message from the
    Odd when it lands. `in_minutes: 0` sends one now. A job run the
    owner starts by hand (Run now) is told they are at the screen, so it
    sends now whatever quiet hours it keeps. The Odd's next chat turn
    is told which pokes landed since the owner last wrote.
16. **Switches.** Any prop that gives off light (a light line or glowing
    pixels) can be switched: lamps, desk screens, fires, the shop windows.
    A tap on the floor (a press that does not drag) switches the prop drawn
    on top there, and the cursor shows a hand over one. A tap on a library
    shelf no switch covers opens the Lessons on All (`onShelf`, `tapAt` in
    `engine.ts`), so the library's lamps and fire still switch. The page
    flips a switch at once and `PUT /api/switches` keeps it in the ledger's
    `switched_off` table, whose trigger brings every open page along. Off, the prop shows
    its `off` frame (drawn, like the cold fireplace, or compiled with each
    glowing colour in its palette `off` colour), its glow and light go out,
    and its animation stops. A desk whose screen is off is nobody's: its
    work spot counts as taken, so whoever works there gets up for another
    desk, or something else to do when none is free.

17. **Updates.** The shell (`apps/desktop`) finds, downloads and checks a
    new version, then tells the server through `/api/update`
    (`src/lib/server/update.ts`). Only the shell may report one: from this
    computer (rule 1 of "Who the office answers") with the app's key in its
    header (`fromShell` in `src/lib/server/app-key.ts`). A release build
    passes `ODDBORO_UPDATES=1`, which shows Check now. The office picks
    `installAt`: the start of the owner's next window (02:00 to 04:00 office
    time by default, `app_update` in the ledger), or now when the owner presses
    Install now. The rules are in `@oddboro/ledger/update-window`. From 15
    minutes before `installAt` the Odds are held (`held()`): the job clock and
    follow-ups start nothing new, and every run's "How the office works" says
    when Oddboro updates, to start nothing that runs past it and to write where
    it is to its notes. The shell asks `GET /api/update` every 30 seconds;
    `install` turns true once `installAt` has come and no chat, job,
    follow-up, draft or office drawing runs, or 20 minutes after it whatever
    runs. That answer records `downAt`; the next start records `upAt` and
    forgets the ready update (`loadUpdate`). The Setup window's Updates section
    (`src/lib/ui/UpdatesSection.svelte`) shows the version (`ODDBORO_VERSION`,
    or "development"), Check now (the server writes `oddboro:update-check` on
    its stdout), the window, and a ready update with Install now and Install
    tonight. It hears `app_update` changes on `/api/events`.
18. **Installing and signing other tools in.** The owner installs the
    office's Grok, Codex and Gemini, signs Grok and Codex in, and gives Gemini
    its API key, from the page, never Terminal
    (`src/lib/server/agent-sign-in.ts`). `/api/agents` carries each tool's
    sign-in: signed in when Grok's `auth.json` in its office home holds an
    account (its email shown), when Codex's exists (the email from its
    `id_token`), or when Gemini has a key. It also carries how each tool
    takes Run commands on this system (`commandsHow`), so the hire drawer's
    line (`hireToolsLine`) names that switch only where the owner can move it,
    and Browse the web alone until the tools load. `/api/agents/[tool]`
    changes one, only for a tool this system offers and never Claude Code.
    Sign in runs the tool's browser sign-in in its office home
    (`grok login --oauth`, and
    `codex login -c cli_auth_credentials_store="file"`), streamed through the
    runner Claude Code's sign-in uses (`src/lib/server/command-stream.ts`), with
    the sign-in page's address as a link; a second one starts over, Cancel
    stops it, and at five minutes the office stops it and says so. Install runs
    the tool's own installer
    on the same runner (`npm install -g` for Codex and Gemini, xAI's script
    through `bash -c` for Grok, which adds Grok to `~/.grok` and the shell's
    PATH), with no key and no Grok or xAI setting of the office's own
    (`installEnv`). It runs to its end, however long, and while it runs
    every other request about that tool gets 409; `/api/agents` says it is
    installing, so a refreshed page shows it. Installed means `agentCommand` finds
    the command: on PATH, and for Grok also in `~/.grok/bin`, where its
    installer puts it when no folder on the office's PATH can take its link.
    Every grok the office starts, a run's too, is that file
    (`grokCommand` in `grok.ts`), so one installed there runs without a
    restart. Every `grok` the office starts outside a
    run (the sign-in and the renewal's `grok models`) names the home's own
    `leader.sock`, since Grok's default is the owner's `~/.grok`. Sign out
    deletes that home's `auth.json` and never runs a tool's own logout, which
    once removed the owner's own `~/.grok` sign-in. A Gemini key is tried once
    with a listing of Google's models before the keychain keeps it. The page's
    side is `src/lib/ui/agent-tools.svelte.ts`, used by the Your AI tiles
    (`src/lib/ui/OfficeTools.svelte`) and by "Runs on". The tiles show on
    setup's Your AI card (`AiCard.svelte`) and as the Setup window's Your AI
    section: one per tool on every system, a tool this system does not offer
    greyed with why (`notOfferedWhy`), and the picked tool's panel below
    them. Picking a tile sets the office's tool (`OFFICE_AGENT`, PUT
    `/api/agents`). Each panel offers one action
    (`toolAction` in `src/lib/ui/tool-action.ts`: Install, nothing while
    installing, Sign in, Cancel, Switch account over a sign-in that may have
    stopped working, or a key), and Sign out beside it when signed in and not
    installing (`offersSignOut`). An install that ends with the tool still not
    found says to restart Oddboro. Each list reads the tools when made, after
    any of them installs a tool or changes a sign-in, and on window focus while
    a sign-in waits or an install runs; nothing polls.

## Designing the office

The Office window (`src/lib/ui/OfficeDesigner.svelte`) takes the owner's words
and `POST /api/office/design` asks Claude, as the office, for an `OfficeSpec`
(a room the owner places carries `side`, west or east, and `row`, back or
front; a change to an office is told where its rooms stand now)
plus a `draw` list: up to 12 pieces the library lacks (props, wall hangings,
desk pieces, floors, wall styles). `drawArt` (`src/lib/server/office-art.ts`)
draws each in its own run, all at once, from `FORMAT.md`, `ART.md`, the
palette and two library pieces of the same kind; a piece that fails twice is
left out and the room falls back to the library. `drawOffice` builds the spec
with `generateOffice` and sends it back once with the problems if it fails.
The drawing runs as a job on the server (`src/lib/server/design-job.ts`), one
at a time: `POST /api/office/design` starts it, and `GET` follows it a line of
JSON per step (`spec`, `plan` with the floor built from library stand-ins for
the pieces still drawing, each `art`, then `done`), so the window shows each
piece as it lands. A page that reloads follows it again and gets every line so
far. `PUT { moveIn: true }` moves in the moment it is done. The window previews the real
floor (`Floor.create(..., { preview: true })`) with the new art loaded by
`addArt` (`src/lib/floor/art.ts`), in the window and in a full-screen
**View larger** dialog. A preview zooms below 1x only to levels where each
tile covers whole device pixels; anything between leaves black seams at tile
edges. The window lists the rooms, what was drawn, and what a floor seen from
above cannot show, and redraws with a note, keeping the pieces already drawn.
The office the owner is in changes the same way: `/api/office/layouts` returns
its spec as `current`, and a note redraws it from that spec. Each note is
added to the layout's words as a "Then:" line, so a later change starts from
everything asked so far. A change in words also shows Claude every room's
items by id and tile, so it can return room `edits` (remove, move, add) that
name the very thing. The window has no arranging by hand, and no refurnishing
by the latest rules: both built each change through a route the office never
had, so they are out until it has one (NEW-1615). **Save to the office** in the
large view moves in at once. For a whole look the library lacks, like a
dungeon, Claude makes a theme: it draws stand-ins with `replaces` (drawn over
the original, keeping its footprint and spots) and maps them in the spec's
`swaps`, with `windows: false` for a place underground. Once a drawing builds,
`lookOver` paints every room and the building's front and street
(`paintWorld` from `@oddboro/world/render`) and shows Claude each with its
inventory in one run. It fixes what reads wrong with room edits, furnishes
rooms a theme left bare, and asks for stand-ins, swaps and a facade for
anything still off the look, inside or out. Those pieces draw as a second
round (`drawAll`), and the office keeps everything it asked for if that
builds, else only the room edits, else the first version. A change keeps to
what it touched (`scopeOf`): the look-over sees only rooms whose spec changed,
and the front and street only if the theme did; its edits elsewhere are
ignored, and with nothing touched it does not run. Nothing changes until **Move in**:
`POST /api/office/move-in` (`moveInto` in `src/lib/server/move-in.ts`) checks
the art and builds the spec again on the server, keeps the layout and its art (`saveArt`), and `moveIn` makes it the
office. Kept art joins the library for every later drawing: `officeLibrary()`
in `space.ts` merges it into the catalog and the page loads its sheet beside
the atlas. It first remembers where
each Odd works in the office being left, puts anyone it remembers back in
the one being entered, and moves the rest to the work room with the most free
seats. The `offices` trigger reloads every open page. Earlier layouts and the
sample stay in the window to move back to.

## A new owner's first visit

`npm run setup` asks nothing and opens the browser. Until the owner is
welcomed, the page loads the sample's empty lot (`currentOffice({ lot: true })`,
`lotOf` from `@oddboro/world`), and `Onboarding.svelte` runs six cards (`steps.ts`), the same on a Mac, Linux and Windows (hard rule 14), in
the start panel, titled "{name}'s Lot" until the office stands on it. The
command center's buttons and tabs appear there once the first run is over, so
the owner meets the panel first. The cards: Your computer (`MacCard`, the checks
from `/api/setup`, and Notifications: a test of the computer's (`notifyMac` in `src/lib/server/notify.ts`, which macOS shows as Oddboro's in the app and as Script Editor's from the repo) with that system's own steps if it does not show (`notify-help.ts`, shown by `NotifyHelp.svelte`: System Settings on a Mac, Settings on Windows, and on Linux a check that notifications are on and that the desktop has a notification service), and, outside the app, the browser's for the Desk; the owner moves on with Next), their name, Your AI (`AiCard`, item 18: a tile per tool, the picked one the office's tool, and its panel below: Claude Code's installs it through `/api/setup/claude` and is `ClaudeCard`, a Claude plan tab with the account Claude Code is signed in to, from `claude auth status`, and Sign in to Claude Code or Switch account, or an API key tab, with a model picker in both. On Claude Code, Sonnet cannot draw looks or design offices: `canDraw()` in `claude.ts` refuses them, and the later cards offer only the ready-made managers and Main Street; the model,
or an API key kept in the keychain; `src/lib/server/claude.ts` passes both to
every run. Next waits until the picked tool is signed in), the Office Manager (`ManagerCard`: four ready-made ones from
`GET /api/onboarding`, or one described and drawn by `/api/looks` while the
owner carries on), the space (`SpaceCard`: Quick is Main Street, the default; Custom (1-2 minutes) is
a description or a chip, and starts the design job), and Open the office.
No card asks about error reports, a New Altitude sign-in or New Altitude
personas: the owner finds them in Setup (see "Diagnostics" and "A New Altitude account"), so a new owner
gets to work sooner. `POST /api/onboarding` keeps the time zone, finishes the
welcome, hires the manager (`hireManager`), writes their hello into their chat
(each ready-made manager's `hello` in `managers.ts`, in their own voice; a
described one gets `customHello`),
adds each persona granted on its card right after the manager
(`installGrantedPersonas`; one that fails is told to the page and never fails
the welcome), and tells the design job to move in when it is done. The hello asks three questions, each skippable
with its default said: what the office should help them get done (the manager
offers an answer as a goal), how much to do on their own inside the office (the
question says first that nothing leaves it without the owner's yes; until
they say, the Odds draft and bring it to them), and everything or
only what needs them (until they say, only what needs them, plus the daily
report). The manager keeps each answer about how the office works as a lesson
for every Odd. No run wrote the hello, so `sayInChat` marks it `told` and the
manager's first chat is told it said it (item 9). Then the reveal
(`src/lib/floor/reveal.ts`) plays on the page's own floor. A drawn office waits
behind a "Building the layout" card (tiles laid in a loop, the design's progress
line, a bar of pieces drawn) until the job's `done`, so it goes up the way it
will look, never on library stand-ins. A described manager still drawing keeps
a card up ("Drawing Rosa") while the office goes up behind it: the drawn art
goes in the atlas, `Floor.swap` puts the office in place with every part hidden, and
`raise` chalks the rooms, lays the floors row by row, raises the walls and drops
the furniture in, room by room, lamps on. Once the manager is ready (at once for
a ready-made one), a bus drives up the street, and they walk from the bus stop
to the owner's desk, where their card opens on the chat. Skip, under the caption
while they come, sends the bus off and puts them at the desk at once
(`StaffActor.arrive`). Until the office has
moved in, the page keeps the floor it raised (`landing`) rather than reloading on the move. "Good Morning, Neighbor" opens the music over it. The music is a player (`music.svelte.ts`, one per page) over the 25 tracks in `static/audio/`, named in `tracks.ts`: a random order that skips the last few played, loved tracks twice as often, passed ones never, repeat one, and the Mac's media keys. Later visits play only if the owner left it on. Every choice is per viewer in localStorage. The player also offers focus noise (`static/sounds/focus-noise.m4a`, a 32 second pink noise loop whose end crossfades into its start): the player's icon is a button with a caret that opens a menu, Soundtrack or Focus noise, and the icon becomes three waves while the noise is on. The song stays loaded and paused meanwhile, so switching back resumes it where it stopped. The noise plays through Web Audio (a looping buffer and a gain node for the volume), since an `<audio loop>` leaves about 50 ms of silence at each restart; its audio context is made at the first play and suspended whenever the noise stops. The tracks are AAC with every tag stripped but the title, since Safari won't play Opus, and LICENSE-ASSETS keeps the folder out of the Apache license. The bottom of the start panel (`FloorControls.svelte`), there during the first run and after, holds the player on the start side (the icon and its menu, the track's name, then love, back, play, next, repeat, pass, then the seek bar with the time, and a speaker that opens a vertical volume slider with a mute). A hairline separates it from the end side, where the light and, under it, the zoom stack at the same width. The light: Auto follows the office clock, the sun and the moon hold the floor at day or night for that viewer. Then the zoom: Fit shows the whole office in the room the panels leave (and stops following an Odd), and minus and plus step a crisp level out or in (`Floor.zoomBy`), gliding. A plan that fails twice raises the sample instead.

## The office's address

`https://local.oddboro.com` (a public DNS record points it at 127.0.0.1),
falling back to `oddboro.localhost` where a network's DNS drops that answer.
The desktop app (`ODDBORO_APP`) skips all of this: it opens the office in its own
window, onboarding shows no address step, and it never touches Caddy.

Caddy takes ports 80 and 443 and hands everything to the office on its own
port, `OFFICE_PORT` (4500, or `ODDBORO_PORT`) (`src/lib/server/address.ts`,
the Address row on the first card). With nothing on port 80 the office runs
its own Caddy as `com.oddboro.caddy`, downloading it from Caddy's releases (checked against the published checksum) if the Mac has
none. With the owner's Caddy on port 80 it adds two routes and a certificate
policy through Caddy's admin API (127.0.0.1:2019, with an explicit origin, which
that API wants), touches none of their files, and adds them again when the
office starts and when a page loads (`keepAddress`). With anything else on port
80 it stays at the office's own port; on Windows that is often http.sys,
Windows' own web server. Port 80 is looked at with `ss` on Linux,
`/usr/sbin/lsof` on a Mac and PowerShell on Windows, each through `probe`. A
look that fails, times out or finds its command missing gives `unchecked`,
never free, since reading it as free would offer a Caddy that cannot start:
the address then stays at the office's own port and the card says it could
not look. The card shows that port from the server (`shownAddress` in
`src/lib/address.ts`). On Windows the office's own Caddy listens on 127.0.0.1
and [::1] only (`ownCaddyfile`), so the firewall never asks. On a Mac it
listens on every address, since a process the owner runs can bind a port under 1024
only there (127.0.0.1 and ::1 were refused, measured), so other machines on
the network can reach it, and what keeps an Odd's commands off it is the
deny list each run gets (`macAddresses`, item 9). Linux was not measured and
gets no bind either. The owner's own Caddy listens where they
set it. HTTPS uses Caddy's own authority; the Mac trusts it once,
with the owner's password in the macOS dialog (Make it secure; Windows asks in
its own dialog and adds it to the owner's list, with no admin), because a
browser shows notifications only on a secure page. Firefox keeps its own trusted
list, and the card says so to Firefox users. `npm run setup` opens the secure
address when it answers and is trusted.

## Who the office answers

Other pages open in the owner's browser can send requests to the office too,
and so can any program on the owner's computer, so `guardOffice`
(`src/lib/server/owner-page.ts`, the first step of the server's `handle` in
`hooks.server.ts`, before Sentry's) checks every route and API request before
the route sees it, in every mode. Files built into the page (scripts, styles,
images, under `/_app/`) are served before the check. SvelteKit's own check
stays on as well, for form posts and any action with no content type. In a
release, whose port moves, the adapter takes the office's origin to be https,
so that check refuses the owner's own http page. So the page's `call()`
(`src/lib/ui/api.ts`) sends every action as JSON, body or not.

In the desktop app (`ODDBORO_APP`), before the rules below, every request
must carry the app's key (`src/lib/server/app-key.ts`). Anything without it
gets 403 and "This office opens only in the Oddboro app. Open Oddboro to see
it.", reads too, which a browser shows as a plain page.

- The shell makes a fresh key every time it starts Node: 32 bytes from the
  system's random source, held only in its memory
  (`apps/desktop/src-tauri/src/key.rs`). Node reads it as the first line on
  its stdin (`readKey`, from `hooks.server.ts`, which waits for it after
  making the home private and before the secrets and the database). It is
  never in a file, the Keychain, the environment, a command line, a URL or a
  log line: any program running as the owner can read another's environment
  and command line (`ps -E`). A key that leaks after its Node is gone opens
  nothing.
- Before the shell trusts the server on the port, at the first start and
  every restart, the server proves it holds the key: `GET /api/proof?nonce=`
  with a fresh nonce of 64 hex digits, answered with HMAC-SHA256 under the
  key of `oddboro-proof:` and the nonce (`proof`). The route passes the guard
  without the key, as a GET, and answers nothing but that shape. The label
  keeps the answer good for nothing else, and it says nothing of the key. A
  program that took the port cannot answer it, so the window never sends it
  the cookie.
- The window carries it in a cookie, `oddboro-key`: HttpOnly, so no page
  script reads it, SameSite=Strict, and with no expiry, so it ends with the
  app and the webview never writes it to disk. The shell sets it, after the
  proof, before the window asks the office for anything, and sets the new
  start's cookie before the window reloads after a restart. Every request the page makes carries
  it: `fetch`, the live line (`/api/events`), pictures and music.
- A cookie names a host but no port, so a picture in an Odd's reply at
  another port on 127.0.0.1 would carry the key to whatever listens there.
  The window's pages therefore get a policy (`WINDOW_CSP`): pictures, sound,
  fonts, frames and connections only from the office itself, `data:`,
  `blob:` and https.
- The shell's own requests (`/api/update`, `/api/browser-link`) carry it in
  the `X-Oddboro-Key` header. That header counts there and nowhere else.
- Without the key, only these get in: the sign-in callbacks (rule 5), as
  GETs to those two exact paths; the shell's proof request; a run's call to
  its gateway with its token; and a link for the owner's browser.
- Those, and the shell's and a run's way past rule 3, are judged on the
  address the request was sent to (`sentTo`), never on the path SvelteKit
  hands the handle. Kit takes `/__data.json` off a data request, and a remote
  function call under `/_app/remote/` names its page in a header the caller
  writes, so either could otherwise pass as an exception. The table of
  hostile and legitimate targets in `src/lib/server/request-targets.ts` runs
  through the guard in the app (`app-key.test.ts`), from source
  (`owner-page.test.ts`) and through the dev server's rule
  (`vite-config.test.ts`).
- The owner's browser has no key. When the window opens an office address in
  a new window (a file attached in a chat), the shell asks
  `POST /api/browser-link` for a code for that path and opens the address
  with `?oddboro-link=<code>`. The code works once, for that path only, as a
  GET, within a minute (`mintLink`, `takeLink`). Open in browser for a page
  an Odd built opens the file itself, not an office address, so it needs none.

An office run from source (`npm run dev`, `npm run setup`, the login
service, the tests) has no key and keeps the rules below alone.

1. The request must come from this computer (`fromThisComputer`): the
   connection's address and every address in X-Forwarded-For are loopback
   (127.0.0.0/8, ::1, or ::ffff:127.x), and anything else, an entry that is
   not a plain address included, gets 403, reads too. Through Caddy the
   connection is always from 127.0.0.1, and Caddy writes the client it served
   into that header and drops one the client sent, or adds the real address
   last when it trusts the client, so this is what keeps another machine on
   the network out. A program on this computer can write the header too; this
   rule is not for that. The built server serves the files built into the
   page before it. Under `vite dev`, which setup and the login service run,
   the same rule (`src/lib/server/this-computer.ts`) runs first in
   `onlyThisComputer` (rule 6), so Vite's own routes and its live-reload
   websocket refuse another machine too.
2. The Host must be one of the office's names, whatever the port: 127.0.0.1,
   [::1], localhost, the addresses through Caddy (`HOSTS` in
   `src/lib/server/hosts.ts`) and the app's `ORIGIN`. A site that points its
   own name at 127.0.0.1 looks same-origin to the browser, so only the name
   gives it away. A route asked by any other name gets 403.
3. Anything but GET, HEAD and OPTIONS must come from the owner's page
   (`fromOwnerPage`): Sec-Fetch-Site says same-origin, or, with none, the
   Origin names the Host asked, whatever the scheme, since through Caddy the
   page is https and the office http. With neither, 403.
4. The other clients are the app's shell, which reports updates to
   `/api/update` and asks for browser links at `/api/browser-link` with the
   app's key in its header (`fromShell` in `src/lib/server/app-key.ts`), and
   an Odd's run, which calls `/api/gateway/<connector>` with its token
   (`fromRun` in `src/lib/server/gateway.ts`).
5. `/account/callback` and `/connect/callback` arrive as GETs from the
   owner's browser, sent back by the service's sign-in page, so they pass
   rule 3 with no Origin, and in the app they pass without the key. Each
   finishes only a sign-in whose state the office made and has not spent
   (`claimSignIn` in `account.ts`, `finishSignIn` in `oauth.ts`).
6. Vite's dev server answers before the handle. `onlyThisComputer` in
   `vite.config.ts`, the first plugin, asks rule 1 before Vite's routes and
   its websocket: another machine gets 403, and its websocket is closed.
   Vite also has its own route, `/__open-in-editor`, that opens a file in an
   editor. `noEditorLaunch` refuses it with 403, always, this computer
   included: nothing in the office uses it.

## Diagnostics

Error and trace reports go to Sentry only after the owner's yes, and those
through New Altitude only while the office is signed in to a New Altitude
account.

1. The address is `ODDBORO_DIAGNOSTICS_DSN`, from the environment or `.env`.
   The app's shell passes its own (`apps/desktop/CLAUDE.md`). With none,
   `serverOptions` (`src/lib/server/diagnostics.ts`) returns nothing: the SDK
   never starts, Setup shows no switch, and the relay drops what it gets.
2. The answer is `OFFICE_DIAGNOSTICS` in `.env`: `yes`, `no`, or unasked for
   anything else, which sends nothing. `PUT /api/diagnostics` writes it, from
   the Setup switch (`DiagnosticsSection`), the one place the owner turns
   reports on; neither the first visit nor the Desk asks. It holds from the
   next report, with no restart. `npm run reset` clears it.
3. The gate: `gated` wraps the SDK's transport and asks `diagnosticsOn()` on
   every send. What leaves has passed the one allow list in
   `src/lib/diagnostics.ts` (`scrubEvent`, `scrubSpan`):
   - An error's message only in a shape code writes (`keptMessage`): an
     engine template with any property key as `[key]`, a system error's code
     and call (`ENOENT open`), a Postgres error's SQLSTATE with its table,
     column and constraint names, or a message Oddboro's code wrote
     (`fixedError` in `@oddboro/ledger/errors`). Every other text leaves as
     `[withheld]`.
   - No address the office reaches. Every outgoing request, to the office
     itself or another service, is named by its method alone, and no span
     keeps `server.address`. A page frame from the office (the host and port
     the page reached the relay on, whatever the scheme, or `HOSTS` on its
     default port) keeps its origin, and its path under `/_app/`; any other
     URL (another loopback port, a host, a browser extension, `file:`,
     `blob:`) keeps its file name alone. Not the scheme: the built office
     sees its own URL as https, since adapter-node reads no `ORIGIN`, while
     the desktop window loads it over http.
   - File paths by `reportPath`: relative to Oddboro's own code, from
     `node_modules/` on inside a package, the file name alone anywhere else
     under the home folder, and whole outside it. The shell's `report_path`
     is the same rule.
   - None of what the SDK collects by default (`DATA_COLLECTION`).

   Every span container tells Sentry never to infer an address
   (`infer_ip: 'never'`), and `fitDoor` cuts an envelope to the door's size
   limit.

4. The sign-in: reports to New Altitude's own address over https, or to the
   account site when `ODDBORO_ACCOUNT_SITE` names one (`needsSignIn` in
   `src/lib/diagnostics.ts`; the shell's `needs_sign_in` is the same rule,
   and both are tested against `src/lib/needs-sign-in.cases.json`), go only
   while the office is signed in, each with the account's access token in
   its `authorization` header. Signed out, the gate drops them, Setup shows
   no switch (`shown()`) and the page's traces follow a no (`pageAnswer()`).
   Any other address never gets the token. The gate gets it from
   `accountToken()` and reuses it for `TOKEN_REUSE_MS`, under the refresh
   margin, within one sign-in: a burst of reports reads the secret store
   once, and a new sign-in never sends the old token. It imports
   `account.ts` when a report goes, never at the top, because that brings
   in Postgres (step 7). `flush` waits for every send from its start,
   including one still waiting on a token refresh, up to the flush's
   timeout: a refresh slower than that loses its report when a crash ends
   the office.
5. The relay: the page's SDK (`hooks.client.ts`) posts to
   `/api/diagnostics/envelope`, never to Sentry. The route scrubs each event
   and span again and sends them through the office's own transport, so the
   gate applies to them too.
6. Traces: about one in ten (`TRACE_SAMPLE_RATE`). `QUIET_ROUTES` are never
   traced: the office and project event streams stay open, project commands carry
   terminal input, `/api/update` is the shell's poll, and the relay would trace itself.
7. `instrumentation.server.ts` loads before the server, so
   `src/lib/server/diagnostics.ts` and `src/lib/server/hosts.ts` import
   nothing that brings in Postgres.

## Weather

The weather where the owner is, as a pill beside the desk count. Off until
the owner turns it on in Setup. The decision is in `docs/decisions/`
(grep `weather`).

1. Setup's Weather section (`WeatherSection.svelte`) takes a country (the
   ones GeoNames covers, `POSTAL_COUNTRIES` in `src/lib/weather.ts`, starting
   at the browser's region), a postal code and °C or °F (°F for the US,
   Liberia and Myanmar until the owner picks). Show weather is
   `PUT /api/weather`.
2. The lookup (`src/lib/server/postal-codes.ts`) downloads
   `download.geonames.org/export/zip/<CC>.zip`, reads `<CC>.txt` out of it
   with Node's zlib (`zip.ts`), and finds the code: whole, then the part the
   file lists (GB, GG, JE and IM drop the last three characters, CA keeps three,
   NL four), then the longest listed start (a coarse area, a ZIP+4). In IE,
   MT, CL, CN, AR and BR, whose files hold coarse areas, it takes the listed
   code sharing the most of its start. Anything else not found answers
   `missing` with the closest code, which Setup offers as Use. Nothing of the
   file is kept.
3. The setting is `OFFICE_WEATHER` in `.env`, as JSON: country, the code as
   typed, the place ("Seattle, WA 98101", which Setup shows as Matched),
   latitude and longitude to one decimal, and the unit. Every window and the
   app share it. The same country and code again change only the unit, with
   no lookup. Turn off (`DELETE`) clears it. Each change sends
   `{ type: 'weather' }` on the live line, and every page asks again.
4. The forecast (`src/lib/server/weather.ts`) is MET Norway's
   `locationforecast/2.0/compact`, asked by the server alone, with
   `Oddboro/<version> https://oddboro.com` as the User-Agent and gzip. One
   cache serves every window: it asks only when a page asks after the last
   answer's Expires (read against MET Norway's Date), sends
   `If-Modified-Since` with the last `Last-Modified`, and shares one request
   among pages asking at once. A failure keeps the last series and its
   reason: 10 minutes, doubling to 6 hours, or an hour, doubling, after a 429
   or 403. Each answer serves the hour that has started from the kept series
   (`currentHour`): temperature, cloud and the raw `symbol_code`.
5. `GET /api/weather` answers the setting, that hour, the reason a check
   failed, and `next`: the series' next hour or the expiry, whichever is
   first. The page (`weather.svelte.ts`) asks as it opens, then on the page's
   15 s clock only once `next` has passed, and only while
   `document.visibilityState` is visible (`askNow`); `visibilitychange`
   catches up. Off, `next` is null and the page asks nothing until the live
   line says the setting changed.
6. The pill (`WeatherPill.svelte`) sits in the desk pill's row with the same
   classes: an icon for the sky (`WeatherIcon.svelte`, one per family in
   `SKIES`: `skyOf` maps every MET Norway symbol to one) and the temperature.
   A click opens the place, the sky in words (`conditionWords`), the time of
   the last answer, why the last check failed, Change in Setup, and the
   credit to MET Norway and GeoNames. A failed check greys the pill and adds a
   coral dot; the last report stays.
7. The floor draws each sky (`Floor.setWeather(symbol)`), only while the
   light is Auto; holding day or night shows the clock's sky. `lookOf` in
   `src/lib/floor/sky.ts` reads the symbol: what falls (rain, sleet, snow),
   how hard (light, steady, heavy), thunder, drifting clouds, fog. The
   drawing is `src/lib/floor/weather-layer.ts`, over whatever floor is
   loaded: outdoors is any cell in no indoor room or hall and no wall,
   and the panes are the sprites tagged `window`.
   - The window sky (`skyBand`) is the clock's, softened for partly cloudy,
     grey at the hour's brightness under cloud, darker in rain or snow and
     darkest in a storm. Overcast also stops the sun shafts and dims the
     scene a little by day (`dimOf`).
   - Partly cloudy: a small cloud crosses each pane, a pixel every two
     seconds, all in step. Fog: a haze over the grounds that thins toward
     the building, drawn once.
   - Rain, sleet and snow fall over the grounds from one pool of `POOL`
     sprites made once; `placeFall` wraps each mark into the view, so all
     are on screen, and the field stays fixed to the world. Heavier symbols
     fall thicker and faster. Rain slants, darker over pale stone, flecks
     on hard ground, and at night catches the street lamps. Snow sways and
     settles on the grounds over 15 minutes, fading over 30 after.
   - Thunder: a soft flash over the grounds and the panes every 8 to 25
     seconds (`flashStep`), fading over four ticks, and one flash in three
     draws a pixel bolt over the grounds.
   - Everything steps on the ambient clock (12 a second). A sky with nothing
     moving (clear, cloudy, fog) asks for no draw, and partly cloudy only
     when its clouds move. A hidden page stops it with the rest of the
     floor. Under reduced motion nothing moves: the marks hold still, and
     there is no flash or bolt.

## A New Altitude account

An owner who already has a New Altitude account can sign in to it in Setup
(`AccountSection`, which shows `AccountSignIn.svelte`). The first visit does
not offer it. Error reports to New Altitude and the personas New Altitude
offers need it (see "A New Altitude persona as an Odd"); nothing else does.

1. The site is `ODDBORO_ACCOUNT_SITE`, `https://members.newaltitude.ai` when
   unset. The issuer comes from that site's protected resource document; the
   resource sent is always the configured site.
2. `src/lib/server/account.ts` signs in through the connectors' provider
   (`oauth.ts`) as its own public client, asks for `profile` and `personas`
   (the personas New Altitude offers, `persona.ts`), and returns to
   `/account/callback`. It asks `/api/me` once and keeps only the
   id, name and email. Everything lives in one secret,
   `new-altitude-account:oauth`, in the system's secret store, never in the
   settings file. With no store, Sign in refuses before any request, and a
   store that cannot write gets the same words. Only the newest Sign in's
   page can finish, and none while a sign-in holds tokens; the same holds
   for each persona's sign-in. A persona's sign-in returns to the same
   callback, and its page stays good when the account's sign-in starts
   again. An old page says to start again from Oddboro. Any failure after
   the tokens are kept signs out, so no tokens stay without an account. If
   the store cannot keep them, nothing is kept here, and the grant lapses at
   New Altitude on its own.
3. The states (`AccountStatus` in `src/lib/account.ts`): `in` while the
   sign-in holds tokens, `expired` once New Altitude refused a refresh (the
   account is kept, so the page can say whose it was), `out` with none.
4. Every change goes to every open page on the live line as
   `{ type: 'account', status }`; the page keeps it in `account.svelte.ts`.
   `GET /api/account` checks it live, refreshing only a token close to
   running out. `POST` starts a sign-in. `DELETE` signs out: it ends each persona's
   sign-in (`endPersonaGrants`), then revokes the
   refresh token at New Altitude, then removes the secret even when New
   Altitude cannot be reached. The page makes these requests only through
   `src/lib/ui/account-actions.ts`. Its Switch account, shown with the
   signed-in line, signs out and then starts a new sign-in, so a Cancel or a
   refused start leaves the office signed out.
5. `accountToken()` is the one way to get the account's token.
   `npm run reset` leaves the sign-in, as it leaves connector sign-ins.

## A New Altitude persona as an Odd

New Altitude may offer a signed-in account a persona as an Odd. The owner
adds it from Hire, whose first step asks Hire an Odd or Hire a persona (the
persona path signs in to New Altitude first, then shows the offers as a grid
with a Hire button each, and closes once the persona joins), or in Setup's
Account section (`PersonaOffer.svelte`, with Disconnect). The first visit does
not offer it. It then works like any Odd, except that it speaks in
the persona's voice.

1. The package. `GET /api/personas` asks New Altitude's `/api/personas/odds`
   with the account's token (`syncPersonas` in `src/lib/server/persona.ts`).
   That read calls New Altitude and writes the ledger, so a browser that
   says it comes from another site gets 403, as for an action.
   Each listed persona brings its package: name, role, remit, hello, look,
   portrait and parts, the same in every office. `persona-package.ts` checks
   its shape, then the look checks a drawn look passes. Every part is named
   `<slug>-<name>`, in the package and in its drawing (`checkPart`), and
   replaces only a part drawn for an Odd of the same persona; a built-in
   part or one drawn for any other Odd refuses the package. An account
   signed in with `profile` alone answers
   `rescope`, read from the kept scope with no request, and the offer shows
   Sign in again, which signs out and in, since a refresh never widens a
   grant.
2. The grant. Add and Reconnect (`POST /api/personas/[slug]`) run the
   persona's own sign-in for its door, `new-altitude-persona-<slug>:oauth`
   with scope `stream`, through the account's provider and callback.
   Add reads New Altitude's list first: a persona it does not offer now
   gets 404 and no sign-in. A kept sign-in whose refresh New Altitude did
   not answer gets 502 and no page, since that page could never finish.
   Disconnect (`DELETE`) ends it and makes the Odd quiet. Signing out ends
   every persona's sign-in. The secret store cannot list its entries, so
   each write of a persona's sign-in also names the persona in
   `new-altitude-personas:granted` there, and ending one takes the name out
   once its secret is gone. Sign-out ends each sign-in that list or a
   persona Odd names, whatever New Altitude lists. A door that turns the
   sign-in's token down drops its tokens, so Reconnect opens New Altitude's
   page again instead of refreshing a sign-in the door refuses.
3. The install. `installPersona` hires it with the package's look and
   portrait (`hirePersona` in `@oddboro/ledger`), saves its parts, and says
   its hello with `sayInChat`. An install it refuses ends that persona's
   sign-in, since nothing here would use it. Nothing is drawn.
   `staff.package` holds the slug, the version, New Altitude's disclosure
   sentence and `quiet`; it is null for every other Odd. A persona the
   owner added in an office not yet welcomed joins right after the manager.
   Only the owner's Add in this office, this run, hires one: a sign-in the
   store kept from before is not a yes, since every office on this computer
   shares the store and a reset leaves it. That persona's card shows Add,
   which uses the kept sign-in with no page. The page
   keeps it off the floor until the manager has walked in, then it walks on
   (`firstRun` in `+page.svelte`).
4. Hands, then voice. `run()` in `staff.ts` hands a persona Odd's chat, job
   or follow-up to `personaRun` (`persona-run.ts`). Its own coding tool runs
   first, as its hands, with `personaDesk` as its job description, and only
   its tool steps reach the page. Then the door answers: `persona-door.ts`
   sends the owner's words and the hands' report, cut to fit 4,000
   characters, to `<issuer>/<slug>/stream`. A chat sends its earlier answered
   exchanges and keeps the door's session in the Odd's folder. Any answer but
   `answered` fails the run with a note and the report. An interrupted answer
   shows the words the persona returned above the report. Nothing counts as done
   without the complete answer: a follow-up drops
   the hands' Outcome line, and a chat shows no sign-in card (the persona's
   access is its own, item 5). Stop cancels the call to the door. An answered
   follow-up keeps the hands' Outcome line after the voice. Every other
   run, such as a draft or a follow-up that reads the owner's no or edit
   for a lesson, stays with the hands. Every word sent to the door is in
   `persona-run.ts`, and every detail of the door's address and answer in
   `persona-door.ts`.
5. Quiet. `quiet` is `access` (New Altitude stopped offering it), `grant`
   (its sign-in ended) or `signed-out`. A quiet Odd answers its line at once
   and runs nothing; its chat shows the line and one button
   (`PersonaQuiet.svelte`): Check again for `access`, Reconnect for the
   others.
6. Sync. `syncPersonas` runs when the office starts, on each
   `GET /api/personas` and on Check again, never on a timer. A newer package
   version replaces the name, role, remit, look, portrait and the package's
   own parts; the hello is not said again. A persona no longer listed goes
   quiet for `access`, and listed again it lifts that quiet only. An
   unreachable New Altitude changes nothing. A listed persona whose sign-in
   is kept with no Odd, as after a restart before Open the office, joins
   this run's sign-ins, so Open the office installs it.
7. The page. Every change reaches open pages on the live line as
   `{ type: 'persona', slug, joined, problem? }`. `persona-offers.svelte.ts`
   keeps one map for the page, so the offer and a quiet Odd's chat show the
   same wait or problem. The chat prints the disclosure above the messages.
   `hand_off` tells a colleague that a persona's replies come from New
   Altitude, so what is handed to it leaves this computer.
8. A proposal for a real person. A hire window opened from a proposal that
   names a persona on offer shows that persona in place of the builder,
   with Add, which starts the install on the hire grid with it picked.
   `proposedPersona` in `src/lib/persona.ts` matches by the proposal's
   `personaSlug`, or else by the whole display name as its name or role
   ("<Full Name> Persona"), never a first name, and two matches are none. A
   middle initial does not count, so "Nate Jones" matches "Nate B. Jones".
   `proposalView` picks what the window shows:
   - A proposal that may name a persona (`hasPersonaHint`: a slug, the word
     persona, or a name of more than one word) shows a still placeholder
     until the offers answer, so the builder never shows only to be
     replaced. After five seconds with no answer the builder opens and stays.
   - One that says it means a persona (`namesPersona`: a slug or the word
     persona) and has no match asks for the New Altitude sign-in while
     signed out (`AccountSignIn`; signing in reads the offers again), offers
     Try again while New Altitude does not answer, and says so when the
     list lacks the person.
   - Any other proposal opens the builder, at once when it has no hint.
   - Build an ordinary Odd instead is on every persona view. The builder it
     opens, as the timeout's, never starts with the person's name, role or
     appearance (`ordinaryFrom`).
   - Add sends the ask's id with the persona's sign-in to
     `POST /api/personas/[slug]`. The office keeps it in memory, and
     `installPersona` approves the ask once the persona joins, with the note
     "<Owner> added <Name>'s New Altitude persona instead of a new Odd." A
     sign-in left unfinished, an install that fails, a restart or a later Add
     without the ask leaves the proposal open.
9. Who an Odd may propose. Each read of New Altitude's list
   (`readListing`) keeps the names and slugs on offer in memory
   (`persona-offered.ts`); signed out, or a list refused, keeps none, and an
   unreachable New Altitude changes nothing. The system prompt of an Odd
   holding `propose_hire` or `propose_goal_plan` gets one line from it
   (`offeredSection`): who is on offer, to propose by `persona_slug`, and
   who already works here. No run calls New Altitude for it.

## Running it always

1. `npm run service:install -w apps/office` installs a login service
   (`scripts/office-service.ts`, label `com.oddboro.office`): launchd on a
   Mac, a systemd user unit on Linux, a Task Scheduler task on Windows
   (`@oddboro/ledger/platform`). On Linux it starts with the desktop session,
   so what it runs can open windows. On a Mac it runs the office under
   `caffeinate -s`, so the Mac stays awake on power. On Windows the task runs
   a batch loop in `%LOCALAPPDATA%\Oddboro\services` under
   `conhost --headless`, so no window shows, and needs no admin. Every way, it
   restarts the office if it stops. Logs go to
   `~/Library/Logs/oddboro-office.log` on a Mac,
   `~/.local/state/oddboro/office.log` on Linux and
   `%LOCALAPPDATA%\Oddboro\Logs\office.log` on Windows.
2. `npm run service:uninstall -w apps/office` removes it. Stop it before
   running `npm run dev`, since both want port 4500.
3. The office starts its own database, so nothing else has to. A database in
   Docker needs Docker Desktop to start at login. Search by meaning runs inside
   the office once the owner downloads the search model from Setup
   (`POST /api/setup/search`); without it the ledger falls back to words.

## Where things live

| Path                                  | What it holds                                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/floor/`                      | The PixiJS floor and the Odds on it                                                                                                                                          |
| `src/lib/staff/roster.ts`             | The Odd shape the page gets (`StaffProfile`), hiring looks, and the label for each activity                                                                                  |
| `src/lib/ui/`                         | The card and its tabs, the Desk, the Ledger, hiring, chat                                                                                                                    |
| `src/lib/server/`                     | Staff runs, office runs, looks, the job clock, events, keychain. Where to start a change there: [CLAUDE.md](src/lib/server/CLAUDE.md)                                        |
| `src/lib/server/profile.ts`           | An Odd as the page gets it (`toProfile`): its stored switches and folders, and what its runs reach now                                                                       |
| `src/lib/server/sandbox.ts`           | What a run's commands reach: the variables hidden from them, Claude Code's sandbox, the developer tool folders, and the refusal line                                         |
| `src/lib/server/aws.ts`               | AWS: the office's one sign-in, each AWS tool's role and the read check, the names-only Secrets Manager tool, and keys from AWS                                               |
| `src/lib/site.ts`                     | Links to the public site's guides (`siteLink`): `localhost:4501` under `npm run dev`, else oddboro.com, or `ODDBORO_SITE_URL`                                                |
| `src/routes/api/`                     | One folder per thing the page reads or changes                                                                                                                               |
| `src/lib/server/office-design.ts`     | Drawing an office from the owner's words, and where Odds move to                                                                                                             |
| `src/lib/server/design-job.ts`        | The drawing as a job on the server, which pages follow                                                                                                                       |
| `src/lib/ui/onboarding/`              | A new owner's first visit: the cards, the reveal's story, the music                                                                                                          |
| `src/lib/floor/reveal.ts`             | The office going up beat by beat, and the bus                                                                                                                                |
| `src/lib/weather.ts`                  | The weather's setting, report, skies, words and units, shared by the server and the page                                                                                     |
| `src/lib/server/weather.ts`           | The weather setting in `.env`, and the one MET Norway cache that honours Expires                                                                                             |
| `src/lib/server/postal-codes.ts`      | A postal code looked up in its country's GeoNames file, on this computer                                                                                                     |
| `src/lib/diagnostics.ts`              | What a report may carry, and when a trace is taken: the server's, the relay's and the page's one rule                                                                        |
| `src/lib/server/diagnostics.ts`       | The SDK's options and the gate every report passes, with the owner's answer                                                                                                  |
| `src/lib/server/account.ts`           | The New Altitude sign-in: start, callback, refresh, sign out                                                                                                                 |
| `src/lib/account.ts`                  | The account and its states, shared by the server and the page                                                                                                                |
| `src/lib/server/persona.ts`           | The personas New Altitude offers: sync, each persona's sign-in, install, Disconnect                                                                                          |
| `src/lib/server/persona-package.ts`   | A persona's package checked before the office trusts it                                                                                                                      |
| `src/lib/server/persona-offered.ts`   | The names and slugs on offer at the last read, as one prompt line for an Odd that can propose a hire                                                                         |
| `src/lib/server/persona-run.ts`       | A persona Odd's run: its hands, then its voice, and every word sent to its door                                                                                              |
| `src/lib/server/persona-door.ts`      | The persona's door on New Altitude: its address, scope, what a turn sends and what comes back                                                                                |
| `src/lib/persona.ts`                  | The offers, the quiet reasons and their lines, shared by the server and the page                                                                                             |
| `src/lib/ui/persona-offers.svelte.ts` | The page's offers and each persona's wait or problem, with Add, Reconnect, Disconnect and Check again                                                                        |
| `src/lib/ui/PersonaQuiet.svelte`      | A quiet persona Odd's line and its one button                                                                                                                                |
| `src/lib/server/office-backup.ts`     | Back up this office and Restore from a backup: the download, taking a file back, and starting again so it goes in. What a backup holds is in the ledger's `office-backup.ts` |
| `src/lib/server/hosts.ts`             | The office's names through Caddy (`HOSTS`), alone so reporting loads before Postgres                                                                                         |
| `scripts/office-service.ts`           | The login service                                                                                                                                                            |
| `src/app.css`                         | Tokens. Every colour in the chrome reads these.                                                                                                                              |

## Rules for this app

- Imports use `#lib/...` with the file extension. SvelteKit 3 replaced `$lib`
  with Node subpath imports, declared in `package.json`.
- Zoom follows the wheel or pinch as it happens, then settles on the next
  level the way the gesture went (`settleFrom`), where every art pixel covers
  whole device pixels (half steps on a Retina screen). A small scroll takes one
  step and never springs back; a nudge under 2% stays put. The floor only
  rests at those levels.
- The camera never shows past the grounds' edge: the farthest zoom out still
  fills the screen, and panning stops at the edge.
- The page loads the floor's PixiJS code with `import()` as it mounts
  (`src/lib/floor/index.ts`), and the Office designer and an Odd's usage
  charts load when opened, and `Markdown.svelte` loads markdown-it with the
  first text it shows (plain text until then), so the first page carries
  none of PixiJS, layerchart or markdown-it. Import a floor module's values only through `index.ts`; a
  type import is free.
- Panels and dialogs that open on a click load when they open, with
  `{#await import('…') then { default: X }}` at the render site in
  `src/routes/+page.svelte`. Only what shows at start (the plate, the top bar,
  the floor controls, the Odds rail, the side panel frame) is imported at the
  top. The first run's guide loads beside the floor, and the Odd's card and the
  Desk are fetched once after the floor draws, so they open at once.
- Third-party packages go under `devDependencies` in `package.json`, even
  the ones the office runs: the build bundles those, and the app ships only
  what the workspace packages load (`apps/desktop/scripts/stage.ts`).
  `dependencies` holds the workspace packages, and Sentry's two
  (`@sentry/sveltekit`, `@sentry/core`) alone: its tracing hooks modules as
  they load (`instrumentation.server.ts`), so the build leaves it out and the
  app ships it.
- The floor draws only when something on screen changed. Pixi's own
  every-frame draw is off. Anything that changes the picture outside the
  camera calls `floor.invalidate()`. Name tags and room signs move in
  `floor.onRender`, never in the ticker.
- Room signs scale with the floor: laid out at 11px for 1.5x (`SIGN_ZOOM`, the
  usual fit), centred on the back wall's top band, and cut short with an
  ellipsis past the room's width. They keep the same size and place against
  the room at every zoom, and hide below 1x, which only a preview reaches. The owner renames a room with the pencil on its sign
  (`PUT /api/rooms`); the names live in the ledger's `room_names` table and
  reach the page with the office state. Code that shows a room name reads
  the page's `world`, which has them applied, not `office.world`.
- The world's sprites are filed into 16-tile blocks, and a draw shows only
  the blocks on screen. A bigger office costs the same to draw as this one.
  A new kind of world sprite goes through `addToBlock`.
- Animated sprites are plain sprites whose frames the ambient clock turns, 12
  times a second. Never use `AnimatedSprite`: it ticks every frame on its own.
  An icon over an Odd (`pop`) turns in the Odd's own `update`, like its walk,
  because it moves with the Odd and lasts about 1.5 s; the ambient clock's
  sprites stand still in their blocks.
- Street lamps follow the daylight: the floor puts them out from about 6:50 am
  to 6:15 pm and lights them otherwise (`DAYLIGHT_LAMPS` in
  `src/lib/floor/engine.ts`). A lamp the owner switched off stays off.
- The camera never jumps. Every move it makes (the overview, following a
  Odd, a swap to another world) glides through `glideTo` in
  `src/lib/floor/engine.ts`; only the first frame and a resize place it at
  once. A swap keeps the owner's view on the street and glides out only if the
  new building would not fit. Dragging or zooming takes the camera back. Past the grounds the floor lays a meadow (`MEADOW` tiles a side) with the street and the river carried out to its edges and trees scattered over it (`countryside` in `engine.ts`), so the camera can pull back far enough to fit the whole office between open panels (`viewCover`).
- No CSS animation loops forever. Play it once, or only while something is
  happening, like the dots while a reply loads.
- The office keeps the owner's time zone (`zone()` from `@oddboro/ledger/time`),
  never the screen's. There is no time slider and there are no office hours:
  Odds work around the clock.
- A new owner lands on the first visit (`src/lib/ui/onboarding/`) until they
  press Open the office. The plate's Setup link opens the Setup window
  (`src/lib/ui/Welcome.svelte`) after that.
- Never show demo numbers as real ones. The card's back shows only measured
  usage.
- A tool connects at read or write: read gets the tools its server marks as
  only reading (`readsOnly`), write gets every tool from Draft, and at Draft
  each change waits for the owner's yes.
- A headless Odd cannot reuse Claude Code's own MCP sign-ins (it reports
  `needs-auth`). That is why the office runs OAuth itself.
- Charts use LayerChart. Its tooltip reads `--color-surface-*`; set them from
  the office tokens on the chart's wrapper.
- Render an Odd's text with `Markdown.svelte`, never `{@html}` of anything else.
- Night is a per-sprite tint, not a multiply blend. PixiJS 8 multiply
  darkened the whole scene when its source was a render texture. The preview
  renderer in `packages/world` still multiplies, so its night renders differ
  a little from the office.
- In dev, `window.floor` holds the `Floor` for poking at from the console.
- When the next new panel comes, or NEW-1665 is built: first give the whole
  page one pass at phone and desktop width with an accessibility check, one
  helper for the page's actions, tables for its words, one source for its
  colours and one shared snapshot of the office. Text that tells the owner
  how an action went is built from the server's result (NEW-1709). Add a
  lint that fails on a promise nobody awaits or catches; that brings ESLint,
  a new dependency, so the change says why.

## Access from chat

`ChatAccessAsk.svelte` uses the Desk's folder and switch handlers, sent
with `chat: true` so the run the answer starts replies under the card. A
broad folder keeps its warning and needs the same Accept as the Desk. A
failed chat can offer `ChatSignInCard.svelte` for the account that run
used; `chat-sign-in.ts` reads that account. Its retry is the chat's own
Retry reply on the saved turn, so the earlier failed reply stays in
history. Access cards come from database deliveries, never the Odd's chat
file.

The Projects window and its local controller live in
`src/lib/ui/ProjectSessions.svelte` and `src/lib/server/project-sessions/`.
Projects is a window in the start panel (`openProject` in
`windows.svelte.ts`). While it is in front on a wide screen, the panel
stretches to 8 px short of the Odd's panel, else of the Odds rail
(`projectsReach` in `+page.svelte`, `reach` on `SidePanel.svelte`), the desk
pill hides, and the music keeps its usual width. Its handle still drags: the
width it leaves is Projects' own (`reachWidth`, kept beside the panel's usual
width), from `min` up to that reach, and dragged all the way it follows the
reach again. Another tab in front brings the usual width back. While the rail is wide
(hovered, focused or ⌘K: `onwiden` on `OddsRail.svelte`), the panel steps
back to the wide rail's edge, in the rail's own 200 ms, so every Odd stays in
view. Its sessions run down the start side as a listbox; the selected one's
terminal fills the rest, and its details fold out over the terminal. The
terminal refits at once and sends the session its size only once it settles
(`ProjectTerminal.svelte`).
They sit behind Advanced mode (`owner.advanced_at`), which the owner turns on
in Setup's Advanced section (`AdvancedSection.svelte`, `PUT
/api/setup/advanced`) after one warning. The page holds it in `advanced` in
`windows.svelte.ts`: off, the top bar and the chat's plus menu offer no
Projects. Off, `/api/project-sessions` and its event stream answer 403
(`ADVANCED_OFF`), and turning it off ends every open stream
(`detachProjectViews`). Find existing reads Claude Code's own session files
(`claude-sessions.ts`); the terminal loads `node-pty` only when it opens. See
[project sessions](../../docs/project-sessions.md) for native clients,
handover and recovery.
