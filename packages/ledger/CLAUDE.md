# packages/ledger

`@oddboro/ledger`. The office's records in Postgres: the owner's name, the Odds (the
`staff` table), asks, tasks for the owner, the files an Odd attaches to them,
pokes (one-time chat messages an Odd sets for later), reports, connectors and grants, jobs and runs, token usage and the owner's plan
windows, the names the owner gives the rooms, the owner's goals and who serves
them, the lessons the owner teaches the Odds, the app's updates, and the ledger itself.
Drizzle ORM over the `postgres` driver. Server only, except `./time`,
`./tools`, `./agents`, `./access`, `./grantable`, `./goals`, `./update-window`, `./work-paths`, `./desk-answers`, `./live-tables`, `./filters`, `./system-words` and `./lesson-rules`, which the page may import.
`./sequences` is for tests in any package, never the page.

`src/run-registry.ts` holds each live run, its stop handle and its work in
progress. `reserveRun` and `releaseRun` own its lifetime; the office derives
its slot queue and chat state from these entries. It holds no saved office data.

`src/work/` is the work core: what happens to threads, follow-ups, asks and
tasks, as events (`WorkEvent` in `src/work/events.ts`), each decided by one
pure function (`DECIDERS` in `src/work/decide.ts`) and written in one
transaction (`transitionWork` in `src/work/apply.ts`, over `transition` in
`src/transition.ts`). `docs/architecture.md` says how a system that keeps
state takes this shape.

Where a new kind of thing starts, the shared function for each job, and the
check that catches a missed place: `docs/architecture.md`.

## Running it

`src/home.ts` says where everything is. `home()` is the owner's office
(`ODDBORO_HOME`, else `~/.oddboro`): the database, the Odds' folders, sign-ins,
and `data/`, the folder every Odd may read. `CODE` is the code
(`ODDBORO_CODE`, else this repo; the app's `Resources/server` in a release).
`OFFICE_PORT` and `DATABASE_PORT` come from `ODDBORO_PORT` and
`ODDBORO_DB_PORT` (4500 and 54329); only Windows uses `DATABASE_PORT`.
`makeHomePrivate()` sets the home to 0700 as the office starts, so no other
account on the computer opens it. `STAFF_SERVER` is `mcp.ts` beside it, or
`mcp.js` in a release, and `FILES_SERVER` the file tools (`files-server.ts`)
the same way. Never write `~/.oddboro` or a port anywhere else.
Under `node --test` (`NODE_TEST_CONTEXT`), with no `ODDBORO_HOME`, `home()` is
a folder under the system's temp folder, made on first use and removed at
exit, and with no `ODDBORO_DB_PORT`, `DATABASE_PORT` is 54399: a test never
reaches the owner's real office (`test/home.test.ts`).
Both packages' test scripts also load `test/test-defaults.ts` with `--import`,
before any test module: each test process gets a temp `HOME` and `USERPROFILE`
and a `PATH` of node plus the system's own folders, so no test finds the
developer's AI tools or settings unless it stands one in. It imports only
Node's own modules, so it cannot load a module a test means to mock.
`test/tools-on-path.ts` lists which of some commands a process could start
from its `PATH`, for the tests that hold that. Under test `src/secrets.ts`
starts with a store whose every use throws, naming the stand-in to load,
until a test stands one in (or sets `ODDBORO_SECRETS=system` to test the
system's own store with its command stubbed).

1. With no `DATABASE_URL` in `.env`, the office keeps its own Postgres:
   PGlite inside the office server, files in `~/.oddboro/db`, with
   pgvector. `src/local-db.ts` starts it and serves it on a socket,
   `.s.PGSQL.5432` in the office home (`LOCAL_DATABASE_SOCKET`), or on Windows
   on 127.0.0.1:54329 (`DATABASE_PORT`). Every other process reaches it
   through `DATABASE_URL`, which `src/db.ts` fills in from the office home, as
   `postgres://postgres:postgres@localhost/postgres?host=<home>`, the form psql
   reads. `openPool()` opens a pool on any such URL. An office that finds
   another one answering on its socket stops before it opens the files, and a
   path too long for a socket stops it with the reason
   (`test/local-db.test.ts`). A `DATABASE_URL` in `.env` (Postgres in Docker from
   `npm run db:up`, or hosted) takes its place.
2. The office server brings the tables up to date as it starts
   (`src/upgrade.ts`: pgvector, then `migrations/`). `npm run db:migrate`
   does the same; with the office's own
   database, the office has to be running.
3. After a schema change, `npm run db:generate` writes the next migration.
   Never edit a migration that has run; add one. The chain starts at
   `0000_baseline`, which builds the whole schema at once and ends with the
   change triggers, written by hand. A trigger, function or row that
   `schema.ts` cannot say goes in a migration by hand the same way.
   `0002_hand-offs` is the one exception: it replaced a run of migrations
   that only trial offices ran. Drizzle runs a migration only when its
   journal time is later than the last one the office recorded
   (`test/migrations.test.ts` holds each later than the one before), so `0002`
   carries the time of the last of them those offices ran, and such an
   office skips it. `0003_simplify-cuts` then takes out what they added that
   the office no longer has, and adds what they lack. An office stopped partway through them fails at
   `0002`, since its tables already exist: run `npm run reset` to start it
   over. Before a migration that changes stored data merges, run it against
   a copy of a real office's database (`<home>/db`, copied, never the
   original), and say so in the pull request.
4. Before the app's new version opens the database, `src/backup.ts` copies
   `<home>/db` to `<home>/backups/pre-<version>-<time>/db`. It compares
   `ODDBORO_VERSION` with `<home>/version`, the version that last started, and
   keeps the 3 newest copies. Development (no `ODDBORO_VERSION`) never copies.
   Before that, a restore the owner chose goes in (`src/office-backup.ts`,
   `applyStagedRestore`): the office as it is is copied into
   `<home>/backups/before-restore-<time>`, then each part of the backup takes
   its place. Those copies are never pruned. Their name keeps clear of the
   `pre-` pattern, which the update copies' pruning counts.
5. `npm run reset` starts the office over: it moves `~/.oddboro/db`, the
   Odds' homes, the threads' folders and the office's notes into `~/.oddboro/backups/<time>/`
   and clears the office's keys from `.env`, the owner's answer about
   error reports among them, so the next visit asks again. It never
   touches `data/`.

`ODDBORO_ENV` names another `.env`, to try an office out beside the real
one (with its own `HOME`, so its own `~/.oddboro`). In the app the `.env`
is `<home>/.env`, since every update replaces the app's own folder.
A `.env` a process may not read is skipped (`db.ts`, `readEnv`): Grok's
sandbox shows it to the staff tool server but will not open it. So the
office sets on that server what it needs from `.env` (`DATABASE_URL`,
`OFFICE_TIME_ZONE`, `OFFICE_AGENT`; `access` in the office's `staff.ts`), and
the server never depends on reading it.

`npm test -w @oddboro/ledger` runs `test/` with `node --test`. First
`test/global-setup.ts` makes one database with every migration, and each file
opens a copy (`tool-server.ts`, `pglite.ts`) instead of making and migrating
its own; a file run on its own makes its own. It fails any
test that runs past 15 seconds (`--test-timeout=15000`), or past its own
limit for the two tests that start several tool servers, at 15 seconds per
server: 45 for the `propose_filter` test in `test/filters.test.ts`, 60 for
the shared-project test in `test/project-tools.test.ts`. So a test past its
timeout fails. A run that never exits, from a handle a test left open, CI ends at the
test step's timeout (`timeout-minutes: 10` on each test step in
`.github/workflows/ci.yml`). The
script never passes `--test-force-exit`: under it a run once reported 1,015 of
its 1,058 tests and still exited 0. Of the others, the slowest stays under the cap with every
suite running at once, so a busy Mac has room. A hang holds the database, so every later test in its file
waits out the cap too: keep it no higher than it needs to be. It covers the update
window, the hold, the install decision, a poke's grace, whether a
lesson's quote is the owner's own words, who a lesson is for, which follow-up
notes are the owner's, what an Odd sees
of an edit, that a replacing lesson says why, how a run's prompt lists a
lesson, a hub's list of its threads, which grants a run holds back and
how an Odd is told about each, what a run below the Odd's level keeps, and
every manager's hello and the three first questions (`test/managers.test.ts`).
`test/lessons-db.test.ts` keeps, changes, lists and uses lessons, tells which are news, and starts runs
from the owner's edits and denials; `test/hand-off-limit.test.ts` holds
a round's hand-off limit, the owner's yes or no past it, and continuing a thread; `test/hand-off-news.test.ts`
holds the floor's news of each hand-off and hand-back; `test/thread-access.test.ts`
holds what an Odd sees through a thread; `test/tell-lead.test.ts` holds
the owner's words reaching a thread's lead; `test/pick-ups.test.ts` holds
one run per Odd per thread, results and answers joining one pick-up, and a waiting
result going back only while what it raised is open; and
`test/one-goal-thread.test.ts` walks one goal from plan to end on its one
thread, with each hire as a colleague and only the lead handing on;
`test/goal-thread-no-manager.test.ts` holds that with no manager the first
Odd's thread is the goal's one, and a second Odd's hand-off for it is refused;
`test/owner-tables.test.ts` holds that no table of words the owner reads from
the ledger names a thread or a hand-off, and that work is named by its goal
or its title (`workTitle`), the same whether it finished or a restart cut it off. The tests that drive threads call
`oneThreadPerGoal` (`test/one-thread.ts`) after each test, which fails when a
goal has a second thread or an Odd that serves a goal and has no job leads one. Each runs the office's own code
on an in-memory PGlite with every migration, which `test/pglite.ts` puts in
place of `db.ts` with `mock.module`, hence `--experimental-test-module-mocks`.
`test/hand-off-tool.test.ts` and `test/goal-day-tool.test.ts` run `src/mcp.ts`
in its own process, as the office does for each run, over the office's own
database (`local-db.ts`) in a throwaway folder, which `test/tool-server.ts`
sets up and stops when the file ends, so the suite exits. The first holds
which runs are offered `hand_off`, the run's key reaching the thread, a
hand-off that hands nothing on coming back as an error, and a hand-off's
result naming the work and saying when it starts a new round, `tell_lead` for
a goal hire, the refusal of a goal's work in its chat, a lead naming the
thread an ask is for, every tool refusing a key it does not take, every tool it registers being listed or riding with a listed one, each Odd's tools being exactly the ones every Odd has, the ones it holds and those riding with them, and a hire proposal naming every tool the owner can give; the second, the office's day in `my_goals`. `test/goal-statuses.test.ts` holds which goals a lead's chat and `my_goals` count as live, and `test/schedule-rule.test.ts` an Odd's schedule limit, through the tool server too.
`test/named-tools.test.ts` runs the tool server for an Odd holding no office
tool the owner gives and for one holding each alone, in a run and in a chat,
and fails when a tool's description names an office tool that Odd does not
hold, unless `NAMES_UNHELD` declares it with the Linear row that owes the fix; the office's
`named-tools.test.ts` holds house() and every brief to the same rule.
`test/grantable.test.ts` holds each line an Odd hears when it lacks a grant,
word for word, through each function that says it, each PATCH key's class,
and a hire's starting values.
`test/desk-answers.test.ts` holds what reaches the Odd for each answer on the desk, row by row, and `test/live-tables.test.ts` each table's change trigger against its row.
`test/owner-words.ts` is the check that a line the owner reads says no thread,
hand-off or number, which ledger tests and the office's format test share.
`test/deliveries.test.ts` holds when the owner decided each ask.

## Ledger search

The search model is Nomic Embed Text v1.5 in int8 ONNX, 137 MB. The office
downloads it from Oddboro's own GitHub release (`models-v1`, a pre-release the
app's updater ignores), and `src/search-model.ts` pins each file's size and
SHA-256. The files are Nomic's own, unchanged, from the Hugging Face revision
the code names. A download follows redirects only over HTTPS to GitHub's own
hosts (`DOWNLOAD_HOSTS`) and refuses any other.
It lives in `models/nomic-embed-text-v1.5/` in the office home, which a
backup leaves out. Setup's ledger search line (`checkSearch`) offers the
download; `POST /api/setup/search` in the office runs it. The files arrive
in a folder of their own and move into place only when every one matches
its pin. `src/embed.ts` runs the model through onnxruntime-node, loaded once
per process on the first text after its files pass their checksums again,
and tokenizes with `src/wordpiece.ts`. It prefixes `search_document: ` or
`search_query: `, reads at most 2048 tokens, and takes the mean, layer norm
and length 1, as Nomic says. A file that fails its checksum is removed, so
Setup offers the download again. onnxruntime-node's install script, which
would download CUDA libraries on Linux, never runs: the root `package.json`
denies it in `allowScripts`. Its npm package has no build for an Intel Mac;
there `checkSearch` says so and the ledger is searched by its words. Tests
run a stand-in model (`test/stand-in-model.ts`) and never download; set
`ODDBORO_TEST_SEARCH_MODEL` to a folder with the real files to run
`test/search-model-real.test.ts`.

## Files

`FILES.md` lists each file in this package and what it holds.

Project sessions: `src/project-sessions.ts` holds the native Codex and Claude
Code sessions the owner connects, the one Odd each is shared with, and their
requests. All of it needs Advanced mode (`advancedMode`, `setAdvancedMode`,
`owner.advanced_at`): off, no request is written or claimed and `mcp.ts`
offers no project tool; turning it off takes every Odd off every session and
stops waiting work, and each change is a ledger line. An Odd's request waits
for the owner's Take over and send, whatever its level, unless
`project_sessions.sends_unasked` names that Odd and it is at Act
(`letSendUnasked`); `requestProject` and `claimProject` both check.
`src/project-session-tools.ts` is the local Claude plugin's tool server, with
no database credentials. It and `src/project-watch.ts`, the plugin's monitor,
answer fresh readiness probes through `src/project-receiver.ts` before the
office offers work. `src/project-terminal.ts` opens the native terminal
through node-pty, an optional dependency loaded on the first open. Migration
`0027_project_sessions` adds `project_sessions` and `project_requests` with
their change triggers; `0028_advanced_mode` adds `owner.advanced_at` and
`project_sessions.sends_unasked`. See `docs/project-sessions.md`.

## Rules

- A decision, a finished task, a job run and a hire each write one `ledger`
  row through `record()`, embedded on the way in. Write a row nowhere else.
- The ledger is append-only. Fix a mistake with a new row, never an edit.
- Every table the page shows has a trigger that NOTIFYs `office` with its
  name. A new table the page shows gets one in a migration.
- Text is embedded once, when it is written, never in a loop, inside the
  process that writes it (`src/embed.ts`). Until the owner downloads the
  search model from Setup, or when it cannot run, the row is still written
  with no vector, and search goes by words. Nothing about it leaves the
  computer but the one download (`src/search-model.ts`).
- A row's vector is the one thing the office changes after the row is
  written: the re-index (`reindexLedger`) makes it again, with
  `embedding_model` naming the model, once the model arrives and as the
  office starts while rows are owed. It touches no other column, so the
  Ledger window hears nothing of it.
- `STAFF_ID` is set by the office when it starts `src/mcp.ts`. A tool acts as
  that Odd and no other. In a chat, the office also sets `OWNER_SAID` to
  the owner's message. An Odd changes its own jobs or job description only with
  a go-ahead (`GoAhead`): their words from `OWNER_SAID`, recorded as their decision
  beside the change, or the id of the ask they approved that this run carries
  out, which the office sets as `APPROVED_ASK`. An ask id from a tool argument
  counts only when it matches, so each yes covers one carry-out run. Never take
  the owner's words or an approval from a tool argument alone.
- `deliveries(staffId)` lists every ask, task and report an Odd put on the
  desk, with where each stands; the office shows them in its chat. A folder
  or switch ask also carries its folder (shown, as the Desk shows it), its
  switches and its why, so the chat can show the card. Answering it still
  goes through `giveFolder`, or approval and `changeOwnTools`, as on the
  Desk, and `chat` reaches only the carry-out of the ask answered there. No
  migration.
  `replyToReport` is the owner's feedback, given as a chat reply: it marks the
  report read and records a decision.
- A follow-up (carry out an approved ask, rework one the owner sent back, pick
  up after a task the owner finished, read why the owner said no, read the
  owner's edit to a file) runs once. Older rows may also be
  `feedback`, from before feedback became a chat reply; such a row reads as
  ended and never runs (`RETIRED_KINDS` in `src/work/state.ts`). `startFollowUp` claims it in the
  database before the run, and `finishFollowUp` records the outcome. An Odd
  runs once at a time on a thread: any follow-up on one but a `hand_off`
  waits while a run of the same Odd there has yet to end (`waitsOnOwnRun`),
  and the claim locks the thread, so two at once cannot both start. A run on
  no thread (a chat, a job, a draft, or a follow-up such as a carry-out)
  counts there once it puts work on the thread: a hand-off, taken or held for
  the owner (past the round's limit, or the usage window), a goal's plan, or an
  ask or task its hub names the thread for (`raiseAsk`, `giveTask`). The
  office gives every run a key (`RUN_KEY`) and keeps it in `runsGoing` while
  the run goes, and the thread keeps the key of its hub's runs only
  (`threads.runs`, `keepRun` in `src/work/hand-offs.ts`): a key holds the hub's pick-ups whoever's run it
  is, so a colleague's would stall the lead. The tool server writes the key, in a process of its own, so it
  goes in the database; which keys still go lives in memory only, so a
  restart frees every hold and no key needs clearing. One
  claimed with no outcome after a restart fails through
  `closeStaleFollowUps`; it never runs again. Any failure that goes back to
  a lead (`handBack`), a restart's included, puts nothing on the owner's
  desk, since the lead picks it up at once; any other still reports.
- An Odd's generated look is `staff.look` (the spec) and
  `staff.portrait_px`. Null keeps hand-drawn art. `hire()` and `setLook()`
  refuse a look another Odd has (`lookTaken`), and save any parts drawn
  for it to `parts`, which joins the repo's library for every later look.
- `staff.agent` is the coding tool an Odd runs on (`AGENT_NAMES`: Claude Code,
  Grok, Codex or Gemini). Only the owner picks it: at hire (`hire()`, before any
  run), and after through `setAgent()`, which also
  removes the Odd's chat session (`chatSession`), since the other tool
  cannot resume it. A move may set Run commands with it; `setAgent()` refuses
  that before anything changes when the new tool does not follow the switch. `AGENT_PLATFORMS` says, per tool, which systems offer it
  (`runs`: Claude Code, Grok and Codex on Mac, Linux and Windows, Gemini on
  none until a live run holds its walls; `agentsOn()`, and `offeredAgent()`
  for a hire or a move), and where its Run commands switch follows the owner
  (`commands`: Claude Code on a Mac, Codex on a Mac and Linux, where their
  sandboxes held commands to the Odd's folders). `FILES_VIA_OFFICE` says
  where the office carries a tool's files through its own file tools
  (`filesViaOffice()`): Claude Code, Codex and Grok on every system.
- `staff.commands` and `staff.web` are the owner's Run commands and Browse the
  web switches, and `staff.folders` the folders outside the office the owner
  gave the Odd, each to read or to read and change, by real path. Only the
  owner sets them (`setOwnTool()`, `setFolder()`, or `giveFolder()` from a
  folder ask, below), each change one ledger line.
  Each setter holds its own checks, whoever calls it: `setOwnTool()` refuses
  Run commands, on or off and a repeat included, for a tool that does not
  follow the switch on this system, and `setFolder()` runs `checkFolder()` on
  a folder given and stores its real path. A stored folder in or holding a
  secret store reaches no run, even one given before its store was listed:
  `ownTools()` leaves it out by `touchesSecretStore()`, the test
  `checkFolder()` makes too. The Settings tab still lists it, to take back,
  with a line saying why (`touchesStore` on the office's profile).
  The stored value is the owner's choice; whether a run gets a shell also
  depends on its tool (`commandsHow()`: Claude Code on a Mac and Codex on a
  Mac and Linux follow the switch, Grok and Gemini never), so a tool switch never
  rewrites it. Under a switch locked off, `commandsHow()` names the tool on
  this system that follows it (`offer`), which the Settings tab offers to move
  the Odd to in one click, with the switch on. With Run commands and Browse
  the web both on, commands reach the internet where the tool's walls held
  with the network open (`networkWithWeb` in `AGENT_PLATFORMS`, per system,
  read by `commandsOnline()`: Claude Code on a Mac only, since Codex's commands
  reached the office's own ports on this Mac with its network on), and a change to the switches or the tool that opens or
  closes that says so in its ledger line (`NETWORK_NOTE`). `ownTools()` in
  `capabilities.ts` is that one reading of the switches and folders for a
  run, `my_access`, `office_report` and the page. Once a Claude Code refuses
  the open network, the office holds it (`holdNetwork` in `office-staff.ts`, in the
  office's memory until it restarts), and `heldReach()` is the one rule every
  reader applies: a Claude Code Odd's commands go with no network. The office
  tells every run's tool server so (`OFFICE_NETWORK_HELD`), whatever the run's
  own tool, so `my_access` and `office_report` say it for each Odd they speak
  of (`ownToolsSaid`), and a change that would open the network while held
  records the hold's words (`NETWORK_NOTE.held`). `checkFolder()` takes a folder anywhere on the computer. It refuses the home itself
  and one that holds or sits in a secret store (`SECRET_STORES`, which the
  office's `unreadable` also reads; at the home's top by name, and anywhere
  else, in the home or outside it, the same list (`STORE_MARKS`), by name, or
  for a name a project or an ordinary folder may share by what marks the real
  store, in the folder, the folders above it and one level down, and no
  deeper; a store under another name is not found, and a `.ssh` with only
  custom-named keys and no `known_hosts` is given below the home's top), the
  office's home or its code, and one
  whose real path holds `*`, `?`, `[` or `]`, which Codex cannot take
  (`GLOB`), with one line each (`FOLDER_REFUSED`; the glob line names the
  character). It compares real paths as the disk spells
  them (`realpathSync.native`), so on a Mac `~/.SSH` is `~/.ssh`, and a link
  is where it leads. A whole drive or volume, or a folder in or holding the system's own folders
  (`broadFolder`; never one in the home), comes back as `{ warning:
FOLDER_WARNING }` until the owner accepts it (`accept`, which `giveFolder`
  takes too), and `ask_for_folder` refuses it (`FOLDER_REFUSED.broad`).
  `setFolder()` finds a folder the Odd has by that real
  path, so a level change replaces it. Folders may sit one inside another,
  but a folder only to read is refused inside or around one to change, by a
  new folder or a level change (`FOLDER_REFUSED.readInsideChange`,
  `nestRefused`). A stored folder no
  run gets (`touchesSecretStore()`) does not count for a folder inside it, so
  the owner can give a clean one there, and still counts for a folder that
  would hold it, which would put its store in a run; `folderAskRefused` does
  the same. Taking one back is never refused. `test/own-tools.test.ts` holds `checkFolder`, and
  `test/store-states.ts` is the table of a secret store's states that
  `test/store-states.test.ts`, `test/folder-asks.test.ts` and the office's
  `profile.test.ts` read.
- `usage.staff_id` is null for a run as the office (drafting a job
  description, drawing a look). `usage.tokens` is a generated column, the
  row's one token sum, which a staffer's usage (`usageFor`) adds up.
- Two runs of one Odd can each raise an access ask for the same tool at once
  (a hire's first day and its lead's first hand-off). A later open ask for no
  more than an earlier one (same Odd, same tool, same level or lower:
  `asksNoMore`) is its twin: the desk shows the first alone, and a yes or a no
  to it answers the twins in the same moment (`decide`), each going back where
  it came from. A yes makes one connect task, and finishing it (or a yes to a
  tool already connected) starts one `carry_out` per place a result goes
  back to, not one per ask (`carriedOutBy`): a hand-off's twin first, then a
  thread's, and a twin on neither only when no other runs. That run's brief
  names the twins it stands for (`standsFor`), to do their work once. Only the
  first starts a `denied` run, and Iterate leaves the twins open.
  `test/twin-asks.test.ts` holds it. An ask for another Google account
  (`ask_for_access` with `another_account`, `access.another`, only beside one
  connected already) is a twin of another such ask for the same product, and
  never of a plain one. A yes makes the connector in `grantAccess`
  (`addGoogleAccount`), and the ask and its twins then name it.
- One Google connector is one account of one product (`config.google`,
  `GOOGLE`), with its address in `config.account` once signed in
  (`signedInAs`); look one up by product, never by id (`googleConnectors`).
  Forgetting one revokes at Google only when no other Google connector is
  signed in to the same account (`sharesGrant`), and says so in the ledger
  line. `test/google-accounts.test.ts` holds it.
- An Odd puts a thing on the desk once. `raiseAsk` (for `approval` and
  `goal` asks) and `giveTask` refuse a title the Odd already has open, case
  and spacing ignored, unless the ask `revises` that one; the office's own
  tasks pass `byOffice`. The refusal is an `AlreadyOnDesk` error, which
  `tool()` in `mcp-run.ts` returns as a tool error naming the item. Each check
  runs in the insert's transaction under `pg_advisory_xact_lock` on the Odd
  (`lockDesk`), so two tool servers at once cannot both pass. `stillOnDesk`
  lists what an Odd has open, for its prompt. `test/once-on-desk.test.ts`
  holds it.
- A worker requesting access for separately approved or scheduled work sets
  `connect_only` on `ask_for_access`. Its Desk card explains that approval
  only connects the tool. A normal request for the same tool still resumes its own work.
  Its connect task starts no run on the work it was raised on, so the lead may
  park that work on it (`parked` in `src/work/parking.ts`), and the task's card
  leaves out that the Odd picks up when it is done (`Desk.connectOnly`).
  `test/connect-only.test.ts` holds it.
- An approved access ask with nothing left to connect, or one whose connect
  task the owner finishes, starts a `carry_out` follow-up: the Odd checks the
  tool and does the work that waited on it. Any other task an Odd gave the
  owner, marked done, starts a `task_done` follow-up (`follow_ups.task_id`):
  the Odd reads the answers and attached files, then does what came next,
  like proposing the hire an intake was for. A task given in a chat keeps
  the owner's message there (`tasks.owner_said`, from `OWNER_SAID`), and that
  brief quotes it, so the run hears what they asked to happen once the task
  ends (`test/task-chat-words.test.ts`). Other work parked on the task
  picks up in its own run at the same moment, so `finishTask` reads it first
  and each `task_done` or `carry_out` row the task's end starts names it in
  `follow_ups.picked_up` (`OWN_RUN` in `src/desk-answers.ts` says which ends
  start such a run), office text kept
  out of the owner's `note`: the brief tells the Odd to leave that work to it.
  `finishTask` ends the task, keeps the owner's answer and starts all of this
  in one transaction, so a failed wake leaves the task open. A task can carry
  a response the owner edits (`tasks.response` and `tasks.response_version`,
  from `0024_task_response`, saved by `saveTaskResponse`
  against the version they opened, so a stale save never overwrites newer
  words). Finishing one needs its latest saved version; that text is the
  owner's answer (`taskAnswer`), and the `task_done` run gets it word for word. A dropped task's answer goes
  back to the hand-off or thread it was given on (below); given on neither,
  it wakes the Odd that gave it, once, as an `answered` run. Any answer on
  no work joins that Odd's `answered` run still waiting to start as one more
  line (`offWorkAnswer`), as answers on a thread join its hub's `resume`, so
  twenty nos in a row wake it once.
  A denied ask with a reason also starts a `denied` follow-up: the Odd reads
  the reason, keeps a lesson if it says how to work from now on, and never
  carries the ask out. It serves no hand-off and joins no thread
  (`servesNoThread`), since the denial itself already went back there, or
  stopped the thread when it was a no to more hand-offs. It runs at Draft at
  most (`atDraft`) and is offered no `hand_off`, so no `continue_work`
  either (`LESSON_RUN`); so is the `edited` run below.
  When the owner saves a change to an Odd's file (`writeStaffFile` in the
  office), `learnFromEdit` starts an `edited` follow-up, with
  `follow_ups.edit` holding the path and the file just before the save. The
  run reads the file as it is then, and keeps a lesson only if the change
  shows how the owner wants such work done, and may not write that file. A
  save while one for that Odd and path has not finished starts none: one yet
  to start reads the newest version, and once one under way ends, the office
  (`readEditAgain`) starts one more from the version it read if the file
  changed since. A file attached to a task (a form the owner fills in) starts
  none, and neither does a save that changed nothing. It too joins no thread.
- A lesson (`keep_lesson`) is for the Odd that heard it or for every Odd:
  `staffId` is always `heardBy` or null, and `lessonsOf` relies on that.
  `appliesTo` says where it applies in a few words ("reports"), null for
  everywhere; the same words for another place are another lesson, which
  replaces the open one with those words as it goes live (unless it names
  another in `replaces`), so narrowing or moving a lesson leaves one place.
  An owner change to the place alone keeps the quote. It
  is `said`, and live at once, only when its quote is in `OWNER_SAID` or
  `OWNER_NOTE`; otherwise it waits for the owner's Keep. Only a `said` lesson
  changes one already there: a guess with the same words and place returns
  that lesson as it is, replacing nothing and counting no miss. An `edited` run
  carries the owner's version of the file as `OWNER_EDIT` instead: the quote
  must be in it, and a
  lesson from it is always a guess for that Odd alone, whatever `how` and
  `scope` the Odd passed (`keptAs` reads where the `OwnerWords` came from). `OWNER_NOTE` is the
  owner's note a follow-up carries out (their reason on an ask, or their note
  on a task), set by the office from `ownerNoteOf` (`NOTE_IS_OWNERS`),
  never on a hand-off or a hand-back, whose notes are not the owner's own,
  or a hub's pick-up, whose note joins the office's lines around each answer
  and `tell_lead`'s words. The owner's words there have their own run: the
  `denied` follow-up, or the colleague's chat that heard them. A lesson may quote it, but it is never a go-ahead. A run with none of the three (a job run, a first day) keeps no lesson:
  `keepLesson` refuses, so guesses cannot fill the cap. A quote counts only
  as `QUOTE_MIN_WORDS` or more whole words in a row. When the owner rewords a
  lesson, the new text is its quote too, since they typed it. `keep_lesson`
  refuses a new lesson once its scope holds `LESSON_CAP` live and waiting
  lessons, unless it replaces one; the owner's own changes
  (who it is for, Keep) are not capped. A guess (a waiting lesson) the owner
  has not kept within `GUESS_DAYS` is dropped: `dropped()` works it out from
  `created_at` as the lesson is read, never on a timer. A dropped guess leaves
  the cap, the count `guessesWaiting` gives each Odd's Lessons tab, and the
  tab itself; `lessonsOf` reads it as `dropped`, and Keep still makes it
  live. An Odd cites a lesson the first `CITE_FIRST` times it changes that
  Odd's work, through `used_lesson`, which
  counts each Odd's uses apart in `lesson_uses`. A lesson that
  replaces another with other words passes `replaces` and `why_replaced`, and only then:
  `missed` when the owner had to say again what the old one covered, which
  adds one to the lesson's `missed` and goes in the ledger, or `refined`
  when they changed what they want. A lesson for one Odd never replaces a
  lesson for every Odd: when the owner narrows one that did, the lesson for
  every Odd comes back. Undo on a lesson brings back the one it replaced,
  unless another open lesson replaces that one; a dropped guess is not open.
  `libraryLessons` lists every open lesson, guesses first, with each Odd's
  uses and the total, for the owner's Lessons window. `lessonMark` and
  `lessonNewsSince` give the office each new lesson row and each new use
  after a mark, for its `lesson` events; the owner's changes write neither.
- A lesson makes an Odd more careful, never more permitted. Nothing here or in
  `keepLesson` touches grants or levels, and a run's rules say so: words
  asking for more than the Odd holds keep only the careful part, and more
  access is the Settings tab's job.
- Every manager's hello (`hello` in `MANAGERS`, and `customHello`) is a
  greeting in their own voice, then the first of three short questions
  (`firstAsk`, `FIRST_QUESTIONS` in `src/first-questions.ts`, which imports
  nothing so the chat panel reads it): what to help with first, how much to do
  on their own inside the office (never sending: the question says nothing
  leaves without the owner's yes), and what to hear about between morning
  reports. Each has three to five answers to tap, the default first (draft and
  bring it to them; only what needs them). An answer outside the choices runs the
  manager at once. For a suggested first or second answer the office replies
  to the choice and asks the next question; the manager reads all three answers and keeps
  each about how the office works as a lesson for every Odd.
  `test/managers.test.ts` holds every manager to it.
- A new hire with a job gets a `first_day` follow-up (`startFirstDay`) that
  starts its work right after it says hello, with no ask behind it; its result
  goes on the desk. It is on no thread, and work for a goal the hire serves is
  not in it. A hire with no job gets none: it runs only when handed work. One
  serving a goal gets its first piece from the goal's lead, whom hiring it
  wakes on the goal's thread.
- A hand-off (`hand_off`, in `src/hand-offs.ts`) is a `hand_off` follow-up
  for the colleague, with `follow_ups.hand_off` holding who handed it, the
  title and the brief. `finishFollowUp` hands every outcome back as a
  `handed_back` follow-up for the Odd that handed it, a restart's failure
  included, but for two: the colleague's run that ends waiting goes back
  only while something it raised is still open (`answeredAll`), and nothing
  goes back to a lead that left the office (`hasLeft` in `handBack`). When the
  owner answered all of it before the run ended, the answer already went
  back, or started a run whose result will. When the lead left, the
  colleague pokes the owner that it finished and could not hand it back, the
  Ledger says nothing picks the work up, and nothing goes on the desk
  (`Unreturned`). Results that land while the hub
  runs on the thread wait, and the next pick-up takes them all
  (`resultsToJoin`, named in its brief); they end with it. Both runs work at
  Draft at most, but the colleague's own run keeps its level when the owner
  lets it act on its own on work from colleagues (`staff.acts_on_hand_offs`,
  chosen with each raise to Act, `0032_colleague_hand_offs`). Its brief then
  says so (`handOffBrief`'s `acts`). The hub's pick-up stays at Draft.
- Every hand-off is a step in a thread (`src/threads.ts`, the `threads`
  table). An Odd's `hand_off` with no goal opens one with that Odd as the hub; with a goal it goes on the goal's thread. One goal is
  one thread (`goalThread`): led by the manager, or by the Odd opening it when
  the office has none, it holds the goal's `goal` planning run, every plan for
  it and every hand-off for it (`hand_off` with `goal`), and counts no
  hand-off as it opens. Only its lead hands on there, so a hire serving the
  goal joins it as a colleague. An Odd that serves a goal and has no job leads
  no thread: `assertMayLead`, checked wherever a thread is opened, refuses it
  (`LEADS_NONE`), whatever tool or run got there; the manager is never refused.
  A finished goal thread is found as it is, so a goal never gets a second: an
  ask or task raised on it opens it again (`raisedOn` in `src/work/threads.ts`), and so does the lead's
  next hand-off, so a lookup alone, such as a hand-off the
  office refuses, changes nothing. A stopped one stays stopped: a hand-off
  there is refused, and only a new plan for the goal opens it again
  (`raisedOn` with `plan`), since the plan asks the owner afresh. With no
  manager, a second Odd's hand-off for the goal finds the first Odd's thread
  and is refused, since that Odd leads it. The office sets `RUN_KEY` on every run (`runsGoing`), `THREAD_ID` on every run on a thread, either side, and
  `HAND_OFF_ID` on a colleague's, which then gets no `hand_off`: only the
  hub's runs hand on, into the same thread, so it stays hub and spoke and never
  nests. From a run on no thread, such as a chat or a job, the hub may name a
  thread it leads with `continue_work` instead of opening one; such a run's
  system prompt lists its latest threads (`recentThreads`,
  `recentThreadsBrief`), and its `raise_ask` and `give_owner_a_task` take
  `work`, the thread it leads that the item is for, or null or left out for none (`notLed` refuses
  one it does not lead or that is stopped). Continuing a done or failed thread reopens it with the
  same folder, history, goal and request, for a new round of work; a stopped
  one stays stopped. A round of work takes up to `HAND_OFF_LIMIT` (8)
  hand-offs; continuing an ended thread starts a new one. `handOffsUsed` is
  this round's; every round's are the thread's `hand_off` follow-ups.
  The hand-off decider (`handedOff` in `src/work/hand-offs.ts`) holds the
  limit. The hand-off past it waits: it raises one `hand_offs` ask on the thread,
  holding what the lead chose in `asks.held` (the colleague, title and
  brief), and while that ask is open no other hand-off goes. The office raised it, so it
  takes a yes or a no only (`yesOrNo` in `src/tools.ts`). A yes
  (`start_held` in `src/work/asks.ts`, in the transaction that claims the ask, so a stop between
  them cannot lose it) starts the held hand-off as the first of a new round,
  with what it carries worked out at the yes (`sharing`), so its result
  brings the hub back; the hub hears the yes itself only when
  the owner wrote something with it. Past the usage window's guard the yes
  does not start it: the thread waits for the window as a new hand-off's
  does (below), its round starts afresh, and the hub wakes now to hear that
  it hands it on again once the work picks back up. A no stops the thread, the held hand-off
  never goes, and the hub wakes to say where the work stands. An ask raised
  before asks held their hand-off wakes the hub to hand on again. The hub moves it on by a colleague finishing, by
  `resume_at` (`parkThread`; the office clock calls `wakeThread`, which starts
  a `resume` follow-up), by `resume_at`'s `after_task` (`parkOnTask`, which takes
  only a task the hub gave or one on work it is on, any other reading as no
  task, sets `threads.resume_on_task` and clears the time; `wakeParked` wakes it when the
  task is done or dropped, or taken off the desk (as the task's Odd leaves the office,
  `oddRemoved` in `src/work/leaving.ts`, or through its `withdraw` tool, `withdrawTask`), which wakes it as a drop does, and says which,
  and when a run on the task's own work picks up too, names that work, whose lead carries its
  own part (never a lead that left the office, which runs nothing), or for a task on no work
  says another run of the hub's does, as one does when the owner finishes or drops it (`OWN_RUN`):
  never when it is taken off the desk; a stopped thread loses its park, whether the owner
  stopped it or its hub left the office (`removeOdd`); and the
  hub's next run on the thread ends a park on a task or a time as it starts, whatever starts it,
  and is told the wait ended (`startFollowUp`), while a colleague's run, a pick-up still waiting
  on the hub's run and a usage-window hold leave it; when that run ends failed having parked
  nothing again, the park comes back on its task or its time (`follow_ups.unparked_task`,
  `follow_ups.unparked_at`, `finishFollowUp`): had the task ended during the run, it wakes the
  work as `wakeParked` would have (`endedAs` reads a withdrawal from `tasks.withdrawn`, and
  `ownRunOf` names no run on stopped work, so an Odd brought back since changes neither),
  and a time that passed is left for the clock's `wakeThread`,
  which wakes it once), or by the owner answering an ask or task raised on it
  (`asks.thread_id`, `tasks.thread_id`; `answerLead` when no run follows,
  carrying the ask, so an approved goal plan starts the hub leading its work).
  An answer that comes while the hub's `resume` has yet to start joins it as
  one more line, so hires landing together wake the hub once, and the claim
  returns the row as joined (`startFollowUp`), so the run reads every line.
  Every follow-up on a thread is written through the work core, which settles
  the thread's holder and status (`settle` in `src/work/threads.ts`, the one place status is
  worked out): the status is open until the
  work ends, and an ask or task raised on it that is still open keeps it
  open, however the hub's last run ended. Whether it waits on the owner is
  never stored: `stageOf` reads it from the desk. Each hub run on its thread gets
  `threadBrief`: the steps, the latest result in full, one "Still waiting on"
  line for what it raised that is still open in any round, the newest plan the
  owner approved on it, part by part, with their answer, the hand-offs left,
  and those still out, so it can go on or wait for them. The plan is the order
  of the work: no stage order is coded. A colleague's brief tells it to say
  what it did and never what comes next (`nextIsLeads`).
  Files cross in `threadFolder(id)` (`~/.oddboro/threads/<id>/`): every run on
  the thread reads all of it and writes only `threadPart(id, odd)`.
  An Odd attaches a file there to an ask or a task by its name from the
  office's folder (`src/work-paths.ts`: `threads/<id>/<odd>/<path>`), never a
  copy and never a full path: `workFile` takes it only while the Odd leads or
  works on that thread (`isOnThread`), with no `..` step and no link anywhere
  under the folder of threads, in whoever's part it is. The owner's viewer
  opens it the same way, by its bare name (`shownPath`), and only to read.
  `waitingOn` lists what threads raised that is still open on the desk, oldest
  first across asks and tasks, so a thread's card and its goal name the same
  item first. `goalThreads` gives every thread with its stage for the Goals
  window (`goalsWindow`): waiting on the owner while anything it raised is
  open, whatever its status, else as its status says, with everything it
  waits on, oldest first. The chat's card (`threadsFor`) has the same stage.
  Neither gives the owner a thread number, a hand-off count or tokens: the
  office shows each by its title. Threads come newest first. The window
  lists a goal's under it, and every thread for no goal still under way or
  waiting as other work.
- New hand-offs to Odds on Claude Code wait while the plan's 5-hour usage window is nearly used up
  (`handedOff` in `src/work/hand-offs.ts`), and so does a held one the owner
  says yes to (`start_held`): both ask `windowHolds`. Runs report the share used and the reset time
  (`plan_limits`); the window's size in tokens is not known. Past
  `WINDOW_GUARD` (85%), the hand-off decider refuses each new
  hand-off to an Odd on Claude Code without counting it (one to an Odd on
  another tool goes), parks its thread until the reset
  (`resume_at`, with `threads.held_by` naming the ask; a finished one opens
  again for a new round) and raises one `window` ask per window, locking
  `plan_limits` so two hand-offs raise one. The ask is office-wide, so it is
  filed under the manager (`manager`), or under the hub that hit the guard
  when the office has none. In an office with Odds on other tools, its why
  names the Odds on Claude Code. A yes (`answerWindow` in `src/work/asks.ts`) lets
  hand-offs run until the reset and wakes the held threads through
  `answerLead`; a no leaves them held. The clock's `wakeThread` wakes each at
  the reset with `WINDOW_RESET` (`clockWoke` in `src/work/parking.ts`). At the
  reset the clock also takes an ask nobody answered off the desk with
  `withdrawAsk`, whatever work it still holds (`windowAsksDue` in
  `src/office-usage.ts`). A hub's own `resume_at` replaces a
  hold. A run already going is never stopped. The office raised the ask, so a
  no starts no `denied` run, and it cannot be sent back.
- What an Odd sees through a thread is no wider than its own access
  (`src/sharing.ts`). Each hand-off is compared with every Odd on the thread,
  the hub and each colleague handed work there, and `lacking` is the one
  place that says what one Odd lacks of others' tools: any grant they hold,
  against the reader's grants in force: those `accessOf` holds nothing back
  from, the same rule `capabilities` gives a run its tools by (`access()` in
  the office's `staff.ts`). Browse the web and each folder the owner gave an
  Odd count as tools too (`heldTools`), in force when `ownTools()` gives a run
  them, and a folder the reader has covers every folder inside it. A run
  below the Odd's level (`capped`) holds
  nothing more back: it reads the same tools, only never at write. The office
  never holds a hand-off for sharing: a hub whose work needs a tool's contents
  the colleague lacks is told to `raise_ask` the owner first and hand off after
  the yes, which reaches it as any ask's answer does. The hand-off records
  the tools others on the thread have that the colleague lacks (`withheld`)
  and the colleague's own tools someone on the thread lacks (`kept`); `handOffBrief` and `handOffContext` tell the
  colleague not to expect the first and never to write the second into its
  part or its reply, but to `raise_ask` instead.
- In a chat, a colleague's system prompt lists the latest threads it works
  on and does not lead (`threadsOn`, `threadsOnBrief`): those it was handed
  work on, and those of a goal it serves, before any hand-off. It is told each
  one's story and what the owner said on it, never the asks' text
  (`onStories`, `threadOnKnown`), and may read the thread's folder. `tell_lead`,
  offered only with `OWNER_SAID` set and such a thread, passes the owner's
  words about one to its lead (`tellLead`). The words must be in `OWNER_SAID`;
  the lead picks the thread up through `answerLead`, joining a `resume` that
  waits. It refuses a thread the Odd leads, one it does not work on, and a
  stopped one. The lead wakes to read the owner's words, the colleague's own
  reading, labelled as not the owner's, and the last exchange in that chat,
  less the colleague's own line when the lead lacks a tool the colleague holds
  (`lacking`, `exchangeForLead`), which the note says was left out. Every
  file the owner attached to that message (`OWNER_FILES`) is copied into the
  colleague's part of the work, by `hand_off`'s checks (`fitToCarry` in
  `mcp-run.ts`) and copy (`carryEach`), under the owner's name for it (never a
  hidden or instruction file's name), or the next free name, such as
  `notes-2.md`, when a different file holds it. The note lists each at its
  path there, or says which did not come and why; the words go either way. The
  colleague does nothing more, so the lead decides and hands on.
  With a goal's thread among them, `raise_ask`, `give_owner_a_task`,
  `ask_for_access`, `propose_hire` and a `hand_off` that would open a thread
  refuse it as an error pointing to `tell_lead` (`goalWork` in
  `src/goal-work.ts`) when the Odd has no job and leads no goal's thread the
  owner has not stopped. An Odd with a job of its own is told the rule and
  trusted with it. A named thread it leads is checked first, so a lead is
  never refused its own goal's work.
- A lead's chat and its pick-ups read the same record of a thread it leads
  (`threadStory` in `src/lead-brief.ts`): the steps, the latest result, what
  still waits on the owner, what the owner said on it (`ownerAnswers`; an ask
  an Odd replaced is left out, `askReplaced`), the approved plan and who serves
  the goal now, from the office's records. A chat reads openings of the latest
  steps, one section per live goal it leads and its latest other work
  (`workLedBrief`), and a colleague's chat one per piece of work it is on
  (`threadOnKnown`), together within `CHAT_STORIES_MAX`; a pick-up reads its
  thread's `threadBrief`. A finished task is told once. The office reads them
  once as the run starts (`ledStories`, `onStories`), after any wait for a
  slot, so a run sees what landed while it waited. `my_tasks` and `my_asks` give
  an Odd how the owner finished its tasks and decided its asks, an ask it
  replaced reading `REPLACED`.
- A hand-off that waits on the owner comes home again once they answer. Asks
  and tasks the colleague raises while serving it carry `hand_off_id` (the
  office sets `HAND_OFF_ID` for those runs). `servesHandOff` finds it for the
  follow-up an answer starts, and `finishFollowUp` hands that result back once
  it ends done or failed. With no run to follow (a denial, a dropped task, an
  approved hire), the answer itself goes back (`answerBack` in
  `src/work/answers.ts`).
- A `reply` ask carries one email in `asks.reply` (`ReplyDraft`), raised by
  `propose_reply`, which every Odd has (`always` in `tools.ts`, so no hire's
  tool list can leave it out) and `mcp-mail.ts` offers only while it holds a Gmail
  grant at any level, and which places it as `raise_ask` does.
  Only the office approves one, with `approveReply`, once Gmail sent it or
  saved it as a draft: the owner's final version with `reply.sent`, one
  ledger line ("Sent: ..." or "Saved to Gmail drafts: ..."), and the answer
  back where it came from. No run carries one out, and `decide` refuses a
  plain approve. Replies are never twins: `raiseAsk` refuses a second open
  reply to one email (the same Gmail thread, or with none, the same people
  and subject) unless it `revises` that one, and any reply to a message
  (`inReplyTo`) a sent or saved reply already answered.
  With more than one Gmail grant, `propose_reply` and `propose_filter` require
  `account` (the connector id; its description lists each with its address)
  and default to the only one; the ask keeps `connector` and `account`, and
  the dedupe checks are per account (`sameMailbox`).
  `propose_reply` ends the body with the footer (`withFooter` in
  `src/mail-footer.ts`) unless it already says it; the owner may delete it.
  `propose_reply` takes `attachments`: files in the Odd's own folder by path
  (`mailAttachments` in `src/mail-attachments.ts`), kept on the ask as
  `reply.attachments`; a file that fails the check refuses the call. A file
  goes only where it really is: its real path inside the Odd's real folder
  must be the path it was named by, in any letter case and either Unicode
  form, since a Mac's disk opens an accented name in both (`isWhereNamed` in
  `src/home.ts`, which `hand_off` shares), so a symbolic link or junction on
  the way, to a hidden folder, back to the top or onto another drive, is
  refused, and the Odd is told to name the file itself. The office's own
  files are found by real path in any letter case (`isOfficeFile`, which
  `hand_off` shares too). A hard link is a copy, which an Odd may make anyway.
  `test/replies.test.ts` holds it, two runs at once included, and
  `test/mail-attachments.test.ts` each way of naming one.
- A `filter` ask carries one Gmail filter in `asks.filter` (`GmailFilter` in
  `src/filter-words.ts`, which says one in plain words), raised by
  `propose_filter`, offered and placed as `propose_reply` is. It only files
  mail: skip the inbox, mark read, a label, a star. Only the office approves
  one, with `approveFilter`, once Gmail made it (`filter.created`), with one
  ledger line ("Created a Gmail filter: ..., and tidied N emails"). Filters
  are never twins: `raiseAsk` refuses one for the same mail (`sameCriteria`)
  as one open, unless it `revises` it, or one already created.
  `test/filters.test.ts` holds it.
- A `folder` ask carries one folder in `asks.folder` (`FolderRequest`: the
  real path `checkFolder` gave and `read` or `write`), raised by
  `ask_for_folder`, which every Odd has (`always`). The tool refuses at once
  with the Settings tab's words (`FOLDER_REFUSED`), and refuses a folder the
  Odd has at that level or above, or one `setFolder` would refuse beside the
  folders it has (`folderAskRefused`, with `nestRefused`). `raiseAsk` refuses
  a repeat from the same place (the
  same hand-off and thread, `AlreadyOnDesk`) unless it `revises` it; one from
  another place for the same folder at the same or a lower level is a twin
  (`asksNoMore`, as access asks are). Only the office approves one, with
  `giveFolder`: it checks the owner's folder (the one asked for, or a
  narrower one) and gives it (`changeFolder`, as `setFolder` does) in the
  transaction that approves the ask, so a refusal leaves both as they were.
  The ask keeps the owner's choice as `folder.given`, the one ledger line
  reads as the Settings tab's ("Let Theo read ~/Taxes"), and the yes starts
  one `carry_out` per place (`carryOutTogether`). `decide` refuses a plain
  approve. `test/folder-asks.test.ts` holds it, the tool included.
- A `switch` ask carries the switches an Odd asks for in `asks.switches`
  (Run commands, Browse the web or both), raised by `ask_for_switch`, which
  every Odd has (`always`). The tool leaves out a switch already on, refuses
  when all are on, and refuses Run commands where the Odd's tool never runs
  them (`switchAskRefused`, `commandsHow`). `raiseAsk` refuses a repeat from
  the same place that one open covers; one from another place asking no more
  is a twin (`asksNoMore`). A plain approve turns them on in the transaction
  that approves it (`changeOwnTools`, the Settings tab's own change), refused and left open when the Odd's
  tool can no longer run commands, with one ledger line in the Settings tab's
  words and its network note, and starts one `carry_out` per place
  (`carryOutTogether`). `test/switch-asks.test.ts` holds it, the tool included.
- A `level` ask carries the level an Odd asks for in `asks.level`, raised by
  `ask_for_level`, and an `office_tool` ask the office tools it asks for in
  `asks.office_tools`, raised by `ask_for_office_tool`. Every Odd has both
  (`always`), the Office Manager and persona Odds included. The level tool
  refuses a level the Odd holds already or passed; the office tool tool takes
  only tools the Settings tab grants (`GRANTABLE_TOOLS`), leaves out ones the
  Odd has, and refuses when it has them all. `raiseAsk` treats one from
  another place asking no more as a twin (`asksNoMore`). A plain approve makes
  the Settings tab's own change (`grantSetting`: `changeLevel` or
  `changeTools`) in the transaction that approves it, with the Settings tab's
  ledger words. A yes never lowers a level set higher since, and starts
  one `carry_out` per place (`carryOutTogether`); after a raise to Act, a
  colleague's hand-off and a thread picked back up still run at Draft at
  most, and so does every run that serves a colleague's hand-off, such as the
  carry-out of a level, office tool or outside tool ask raised in one. The one
  exception is the carry-out of an approval ask, the owner's yes to that exact
  action, which runs at the Odd's level so one yes stays one yes. A raise to
  Act also takes the owner's choice for work from colleagues
  (`actsOnHandOffs`, passed to `decideAsk`, `setPermission` and `hire`, and
  changed alone by `setActsOnHandOffs`): on, the hand-off and every run that
  serves it keep the Odd's level, and a change writes its own access line
  (`HAND_OFF_CHOICE` in `access-words.ts`). Left out, the stored choice
  stays; a move down never changes it.
  `test/setting-asks.test.ts` holds it, the tools included.
- A `call` ask carries one held call in `asks.call` (`HeldCall`: the
  connector, the tool and its exact arguments), raised by the office's gateway
  (`raiseCall`) when an Odd at Draft calls a tool that changes something
  through a write grant (`writesWait` in `access-words.ts`; a write grant
  works from Draft, `grantWorks`). Its title and why are the Odd's own words: at Draft
  the gateway adds a required `oddboro_title` and `oddboro_why` to each tool that changes
  something, takes them out of the call, and refuses a call without them. A title the office reads from the call itself (`said`) comes first. The
  same call still open is returned, not raised twice. The changes the run made without asking to the same service since its last held call ride along as `before`, which only the desk shows. Only the office approves one, with `approveCall`, once it made
  the call (`call.result`); `decide` refuses a plain approve. A yes starts a
  `carry_out` run, whose brief has the call and what it returned.
  `apps/office/src/lib/server/gateway.test.ts` holds it.
- A standing yes is a list of a write grant's tools the Odd uses without
  asking (`grants.standing`, `src/standing.ts`): at Draft the gateway passes a
  call to one of them on instead of holding it, in any run with a place,
  never a lesson run, and in a run that serves a colleague's hand-off, or a
  lead's pick-up of a colleague's result (`FROM_COLLEAGUE`), only
  when the owner lets that Odd act on its own on work from colleagues
  (`staff.acts_on_hand_offs`; `handedOver` in `capabilities.ts` empties the
  list otherwise, so each call waits for the owner's yes). A `standing` ask carries the tools in
  `asks.standing` (`StandingRequest`), raised by `ask_for_standing_yes`, which
  every Odd has (`always`) and is offered only while it holds a grant at
  write (`withWrite` in `tools.ts`). The tool refuses an Odd at Act, whose calls go through already, a service not held at write, a tool the
  service does not list or that only reads, tools it already has, and any
  tool the owner said no to for this Odd (`standingAsked`): a no stands.
  `raiseAsk` refuses a second open one that covers it. It takes yes or no
  only (`OWNER_ANSWERS`); a yes puts the tools on the grant in the
  transaction that approves it (`give_standing`, `giveStanding`), refused and
  left open when the grant is no longer write, and the answer goes back as
  any ask's does. The owner gives one or takes it back on the Settings tab
  (`setStanding`, one ledger line each), and lowering the grant to read only
  clears it (`setGrantLevel`). The Odd's prompt and `my_access` name the
  tools (`STANDING` in `capabilities.ts`). A carry-out run of an Odd at Draft
  after a call the office made is told to offer one once when that call only
  prepared a change another call made real (`follow-up-brief.ts` in the office). `test/standing.test.ts` holds it, the tool included.
- Ask first is its mirror at Act (`grants.askFirst`, `setAskFirst`): the
  gateway holds each call to one of those tools as at Draft. Each list is the
  exception to its level and keeps its tools as the level moves; read only
  ends both. A tool the service drops stays on ask first, so one that comes
  back by that name still waits, and the tools that change something it added
  in the same refresh ask first too, since a rename is a drop and an add
  (`refreshTools`, one ledger line). `standingAsked` refuses a standing ask
  for one.
- A service's stored tools follow what it lists now (`refreshTools` in
  `src/office-service-tools.ts`): the tool list, what Read only reaches, each
  tool's description (`connectors.toolNotes`), and a dropped or redescribed tool off each
  standing yes. It writes, with a ledger line per change, only when something
  changed. `test/tool-refresh.test.ts` holds it.
- `asks.via` and `tasks.via` name the colleague whose handed-back work a
  lead raised the item from: the office sets `VIA` on a lead's pick-up, and
  `raise_ask`, `give_owner_a_task`, `propose_reply` and `propose_filter` store it.
- `hand_off` takes `files` the giver can read (`readableFile` in `mcp-run.ts`),
  in its own folder, the owner's chat attachments in `attachments/` among
  them, or the folder of work it is on. `carryFiles` copies each from
  outside the work into the giver's part of the thread's folder as the
  hand-off is taken, and the hand-off keeps their paths in the thread's
  folder (`HandOff.files`, and on a held one through the owner's yes).
  `handOffBrief` lists each at its full path, and names one it cannot find
  there as no longer there: a hand-off a v0.0.9 office stored holds paths
  in the giver's own folder, never copied. `test/hand-off-tool.test.ts`
  holds it.
- A held call (`HeldCall`) may carry `said`, what it does in the owner's
  words from the call alone, which `raiseCall` makes its title, and
  `shown`, each thing it acts on as the service showed it. `shown` is
  words from strangers: only the desk shows it, never a prompt or a brief.
- `withdraw`, every Odd's, offered only in a chat (`OWNER_SAID`), takes the
  Odd's own open asks and tasks off the owner's desk when the owner says so.
  An ask goes through `withdrawAsk` (the office's no, quoting the owner's
  words, no `denied` run, a held call never made), a task through
  `withdrawTask`; anything not the Odd's, or that the owner answered first, is
  left as it is.
  `test/withdraw.test.ts` holds it.
- `draft_bug_report`, every Odd's, offered only in a chat (`OWNER_SAID`),
  keeps a bug report's title and details for the run in the Odd's folder
  (`keepBugDraft` in `src/bug-drafts.ts`, `OFFICE_FILES.bugDraft`). The
  office takes it once as the chat run ends (`takeBugDraft`) and puts it on
  the reply, where File this opens the report form. It files nothing.
  `test/bug-drafts.test.ts` holds it.
- `oddboro_update`, every Odd's and only in owner chat, reads the office's
  run-start update status and keeps a status or check request for its reply
  (`src/chat-updates.ts`). A successful reply shows the existing Updates
  controls. The tool never installs or restarts; Install now is the owner's
  action. `test/chat-updates.test.ts` holds that limit.
- An Odd leaves the office only on the owner's yes, and can come back
  (`src/leaving.ts`). `staff.left_at` marks one that left; the row and its
  history stay. `staffer()` and `roster()` find working Odds only, so a run,
  a hand-off, the tool server (`STAFF_ID` names no Odd) and every staff route
  refuse it; `anyStaffer()` finds one that left too, for a name in history and
  a new hire's id, and `formerStaff()` lists them. The job clock, the
  follow-up queue, pokes and the desk also skip its rows (`ofWorkingOdd`), as
  a second wall. The owner's Remove (DELETE on the staff route) and a yes to a
  `remove` ask both call `removeOdd`, one change through the work core
  (`oddRemoved`) that is saved whole or not at all: the Odd leaves, its
  jobs on turn off and are kept in `staff.jobs_off`, its waiting pokes are
  cancelled and threads it leads stop, with any task, time or usage-window
  hold they waited on cleared; each open ask of it or about it is withdrawn
  (a no by the office, its line going back, no `denied` run), each open task
  dropped, and each follow-up it has yet to start fails, so a lead that
  handed it work hears at once. Once that is saved, the office stops any run
  of it (`whenOddLeaves`). Nothing wakes it after
  (`answerLead` skips a lead that left). A follow-up on work it led ends
  with no report, and a colleague's result waiting there is told to the
  owner by that colleague (`Unreturned`). A yes to `bring_back` calls
  `bringBack`, which turns on the jobs in `jobs_off` from now. What it had open
  stays closed. An Odd asks to leave with `leave_office` (every Odd's), and the
  Office Manager asks with `remove_odd` and `bring_back_odd`; each is offered
  only in a chat (`OWNER_SAID`; `inChat` on its row in `tools.ts`),
  `leave_office` never to the manager (`notToManager`), and each only raises
  the ask. Both kinds take yes or no only (`yesOrNo`), and `decide` refuses a yes `leavingRefused` turns
  down: the manager never leaves, and an Odd whose look a later hire took
  comes back only once one of them is redrawn. `test/leaving.test.ts` holds it,
  with what each tool raises and `leave_office` offered only in a chat and
  never to the manager. `test/hand-off-tool.test.ts` pins which rows are
  `inChat`, `notToManager` and `prompt`.
- A hire ask carries its proposal in `asks.hire`. It is approved only by
  hiring, never by a follow-up run. A proposal may name an intake file, which
  the hire gets a copy of as `notes/intake.md`, a goal it serves, and the
  slug of a New Altitude persona it means (`personaSlug`), which the hire
  window offers in place of a look-alike; that persona's join approves the
  ask, with a note. The
  office approves a hire with `approveHire` (`src/goals.ts`), which links the
  goal in the transaction that approves the ask, so a link that fails leaves
  the proposal open and wakes nobody. Raised on no work, the yes wakes the
  Odd that proposed it with an `answered` run, which carries the owner's note.
- Goals are the owner's. An Odd never sets one: `propose_goal` raises a
  `goal` ask, and `approveGoal` sets it. Setting one, on its yes or by
  `addGoal`, opens the goal's work under the Office Manager with a `goal`
  follow-up there to plan it (`planGoal` in `src/work/threads.ts`), and the
  first goal makes the manager's weekly review job. A `plan` ask (`propose_goal_plan`) holds
  every part of one goal's plan in `asks.plan`, and `raiseAsk` puts it on the
  goal's one thread (`goalThread`), whatever run raised it, and the thread
  keeps that run's key when its raiser leads it (`raisedOn` in `src/work/threads.ts`).
  `approvePlan` takes the parts the owner ticked: Odds already here serve the
  goal in the transaction that approves the ask and get their job at once,
  and the answer names each Odd by name, never its id. Each hire becomes its own hire ask on the
  plan's thread, and the owner's steps a task. `approveAsk` does all that in
  the transaction that approves the ask, so the hub's run finds it, and a
  part that fails leaves the whole plan open. Hiring one of those
  hires answers its ask on the thread, which brings the hub back again.
- An Odd's skills (`staff_skills`, `src/staff-skills.ts`) are text the owner
  attached, one SKILL.md each by name. Only the owner changes them, and only
  against the copy they reviewed (`setSkill`). A run's prompt lists each name
  and when to use it; `read_skill` (`src/mcp-skills.ts`) gives the Odd its own
  skill's text, and is offered only while it has one (`withSkills`). A skill
  grants nothing.
- An Odd sees only the goals it serves (`staff_goals`): `my_goals` and its
  prompt read `goalsFor`, never `allGoals`. `log_progress` takes a goal it
  serves or whose thread it leads (`logProgress`), so the lead planning a goal
  logs before any plan is approved, and refuses every other goal. `list_goals`
  is the Office Manager's.
- A job may name files on one piece of work. A plan binds them to its goal's
  thread. `edit_my_job` can attach an existing job to work the Odd serves or
  rename it in place. Sharing applies to the listed sources in that output.
  A file job's run keeps, in `runs.checked_files`, the periods it is for from
  the moment it starts, then the output digest once the file tools saw it
  write, and a reader's source run. A reader for period P reads the bytes of
  its writer's last run for a period at or before P, which wrote the file on
  disk even when an earlier run was for a newer period
  (`scheduledInput`, `inputFor`): it waits while the writer owes that period,
  skips when the writer skipped it, and fails when that run left no digest.
  An open `catch_up` ask of the writer counts as owed, a refused one as
  skipped (`catchUpAsks`). The same bytes as last period are fine. A model's
  summary is no proof. `addJob`, `updateJob` and `approvePlan` refuse files
  that would put jobs in a ring of readers (`fileCycle`), naming each job.
- A schedule is every n minutes, daily, weekdays, or once a week on a day
  (`{ every: 'week', day: 'Fri', at: '16:00' }`).
- A job's `missed` says what it does with runs missed while the office was
  off: `latest` (the default) or `record`, which fills every missed period.
  The missed times always come from stepping through `nextRun`
  (`runsBetween`), never a second reading of the schedule.
- Every `src/mcp-*.ts` file registers its tools through `tool()`, never
  `server.registerTool` directly: its input refuses a key it does not name and
  lists the ones it does, so an old parameter name in a resumed chat is an
  error, not a call that runs as if it were left out.
- A `src/mcp-*.ts` file registers a tool only when `has()` says the Odd holds it, and
  a tool that rides with one (`RIDES_WITH` in `src/tools.ts`) only beside it.
  Gate on the grant, never on an Odd's id.
- Where to touch. Each kind of thing starts at its one declaration; the type
  checker then names every other place.
  - To add an ask kind, start at `ASK_KINDS` in `src/schema.ts`, then its row
    in `OWNER_ANSWERS` (`src/desk-answers.ts`), which says what each answer
    does. The type checker then names the rest: `TWINS` (`src/work/twins.ts`),
    the repeat guard's switch in `raiseAsk` (`src/office-asks.ts`),
    `grantSetting` (`src/office-decide.ts`), the office's
    `carriedLinesOf` and `carryOutBrief` switches (`follow-up-brief.ts`),
    `YES_SAID` (`src/lib/ui/yes-said.ts`), and the `ASK_ROWS` record in the
    office's `named-tools.test.ts`.
  - To add a follow-up kind, start at `FOLLOW_UP_KINDS` in `src/work/kinds.ts`,
    then its rows in `AT_DRAFT` and `SERVES_NO_THREAD` beside it.
  - To add a work event, start at `WorkEvent` in `src/work/events.ts`, then
    its row in `WorkResults` beside it and its decider in `DECIDERS`
    (`src/work/decide.ts`).
  - To add a connector kind, start at `CONNECTOR_KINDS` in `src/schema.ts`.
  - To add a desk item, start at `DESK_ITEMS` in `src/desk-answers.ts`.
  - To add a goal status, start at `GOAL_STATUSES` in `src/schema.ts`, then
    its row in `GOAL_IS_LIVE` (`src/goal-words.ts`).
  - To add an office tool, start at its row in `OFFICE_TOOLS` in
    `src/tools.ts`; a tool registered beside it goes in `RIDES_WITH`. When
    it is offered (`withGmail`, `withWrite`, `withSkills`, `inChat`, `notToManager`, and `prompt` for
    one that only shapes the prompt and is never offered) is a field on its
    row, which `isOffered` in `src/tools.ts` reads for the tool server
    (`offered()` in `mcp-run.ts`), the Settings tab's Always on group
    (`toolGroups` in the office), `test/hand-off-tool.test.ts` and the
    office's `named-tools.test.ts`.
  - To add an owner control on an Odd's card (a key the staff PATCH route
    reads), start at `STAFF_PATCH_KEYS` in `src/grantable.ts`; the type
    check fails until `PATCH_KEY` classes it as a grant's control, a run
    setting or a qualifier. To add something the owner can grant, start at
    `GRANT_KINDS` there, then its reader in `Readers` and its row in
    `OWNER_GRANTS`: its control, the line an Odd hears when it lacks it (or
    `none` with the Linear row that owes one), the functions that say it,
    how the Odd gets it and whether a hire starts with it. The type check
    then fails at `HEARD` in `test/grantable.test.ts` until it says how that
    line is heard.
  - To change what a hire starts with, change `HIRE_DEFAULTS` in
    `src/grantable.ts`: the schema's column defaults, `hire()`, the Office
    Manager's hire, a persona's hire (`hirePersona`) and the hire drawer read
    it. Run `npm run db:generate`
    after; a changed column default needs a migration.
  - To add a table, start at its `pgTable` in `src/schema.ts`, then its row in
    `LIVE_TABLES` (`src/live-tables.ts`); the trigger that row names goes in a
    migration by hand.
  - To change how often a job may run, start at `SCHEDULE_RULE` in
    `src/time.ts`.
  - To add an AI tool, start at `AGENTS` in `src/agents.ts`, then its rows in
    `AGENT_PLATFORMS` (the systems it runs on, follows Run commands on and
    reaches the internet with commands on), `AGENT_FILES` (its own
    instruction files and home folders, which the office's
    `agent-files.test.ts` holds to `INSTRUCTIONS` and `SECRET_STORES`) and
    `OFFICE_MODEL_VAR` (the office's model variable for it). To offer a tool
    on another system, start at its `AGENT_PLATFORMS` row; the office's
    `sandbox-paths.test.ts` and `launch-contract.test.ts` name what that
    system still needs.
    - Later: at the next raise of `MIN_VERSIONS`, or a new AI tool, add a
      probe that runs each tool's real CLI against its walls. Ask the repo's
      owner first: it needs CI secrets and spends tokens.
  - To read which system the office runs on, call `currentPlatform()` in
    `src/platform.ts`, never `process.platform`, so a test's `onPlatform`
    reaches it. `scripts/check-platform.ts` fails any other read.
  - To change what Odds are told (a line in `src/capabilities.ts`, or a brief
    built in this package), accept the change with
    `npm run prompts:accept -w @oddboro/office`: the office's
    `prompts.test.ts` holds each kind of run's prompt, and
    `apps/office/src/lib/server/CLAUDE.md` says how.
- The owner's name lives in the `owner` table, one row, set per install with
  `setOwnerName()` and read with `ownerName()` ("the owner" until one is set).
  Odd prompts use it, so each install's Odds call the owner by name. Never
  write a name into the code or the docs.
- Secrets never land here. A connector names its secrets; the values live in
  the system's own secret store (`src/secrets.ts`): the Keychain on a Mac, the
  Secret Service keyring on Linux through secret-tool, and the Credential
  Manager on Windows through `@napi-rs/keyring`, in pieces of 2,048 bytes,
  since one credential holds at most 2,560.
- A connector may name AWS secrets for its keys (`fromAws`: the secret, and a
  key inside a JSON one) in place of values in the secret store; the office
  reads them when a run first uses the tool, through its gateway. AWS is three
  built-in tools (`BUILT_IN` in `src/registry.ts`; `AWS_SECRETS_ID`,
  `AWS_READ_ID`, `AWS_BUILD_ID`), which `find_connectors` offers and
  `ensureConnector` adds. Their descriptions tell an Odd to ask the owner what
  they want in AWS when it is not clear. Each one's `aws` config holds its role
  and Region, none of it secret, and all three share one sign-in in the secret
  store (`AWS_SIGN_IN`). An AWS tool no Odd holds drops its role (`forgetAws`),
  except Secrets Manager while a tool's key comes from AWS, and the sign-in
  goes once no AWS tool has a role (`test/aws-tools.test.ts`). GitHub is a
  built-in tool too (`GITHUB_ID`, GitHub's own hosted server), which signs in
  with New Altitude's app; `ask_for_access` turns any `api.githubcopilot.com`
  address an Odd names into it, dropping a key header (`GITHUB_ADDRESS`).
- What the office saves in the secret store, it removes. Revoking the last
  grant to a tool removes its keys and sign-in (`forgetConnector`), and a tool
  that changes how it lets the office in loses the secrets the old way used
  (`reconfigureConnector`). A hosted server named by its address takes a key
  in the header the owner names (`ensureConnector`), or signs in.
- Start Claude Code through `claudeCommand()` in `src/platform.ts`, never as
  a bare `claude`: on Windows an npm install is a `.cmd` Node will not start,
  so the shim's script runs under this Node instead.
- On Windows, reach the system through `powershell()` or `powershellSync()`
  with values passed as `env`, never pasted into the script, so nothing needs
  quoting.
- Start an asynchronous one-shot command through `probe()` in
  `src/platform.ts`, never `execFile`. It says `ok`, `failed`, `missing` or
  `timeout`, and each caller handles all four, so "not there" never reads as
  an empty answer and no raw error reaches the owner. It hides the command's
  window on Windows unless `showWindow`, which only certutil's trust step and
  `openUrl` use. `test/one-shot-commands.test.ts` holds both.

## Later

Each line says what to do when its trigger comes.

- Building NEW-1651 or NEW-1654, whichever comes first: give each run one
  row of its own, with `runs.jobId` optional and usage pointing at the run.
- Building NEW-1644, or adding an office tool or an AI tool: first write a
  threat model for prompt injection: what a page, file or message an Odd
  reads could make it do, and which wall stops each.
- When a test fixture is copied a third time: move it into one shared test
  helper that every copy's tests import.
- When adding an AI tool makes a branch on a tool's name repeat, such as one
  more `agent === 'grok'`: first fold that branch into a per-tool table, a
  `Record<Agent, ...>` as `AGENT_FILES` is, so the next tool fails check-types
  until it has a row.
