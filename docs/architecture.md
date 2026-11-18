# The picture: where a change goes

A new kind of thing starts at its one declaration, and the type checker or a
named test then lists every other place it must reach. This page names each
declaration, the shared function for each job, and the check that fails when
a place is missed. One more of something that exists (an Odd, a room, an
office, a connector, a lesson, a goal) is a row or a JSON file and needs no
code: the office grows by adding instances, as the 2026-10-29 eight-blocks
decision in `docs/decisions/` says.

## The parts

Imports point one way. An app imports packages and a package never imports
an app; `ledger` imports `world` and `sprites`, and `world` imports `sprites`.

- `packages/ledger`. The office's records and every rule about them: the
  tables (`src/schema.ts`), what the office does with them (`src/office.ts`),
  the tool server an Odd runs with (`src/mcp.ts`), the AI tools
  (`src/agents.ts`), and what a run may reach (`src/capabilities.ts`). Server
  only, except the entries `packages/ledger/CLAUDE.md` names as the page's.
- `apps/office`. The office server and its page: the floor (`src/lib/floor/`),
  the panels (`src/lib/ui/`), the routes (`src/routes/api/`, one folder per
  thing), and running Odds (`src/lib/server/`: `staff.ts` runs one, `cli.ts`
  gets each AI tool's launch ready (`LAUNCHES`), `drive.ts` runs it and reads
  its stream, `sandbox.ts` walls commands).
- `packages/world`. Rooms and offices as JSON (`rooms/`, `plans/`), an
  owner's office built from a spec (`src/generate.ts`), and `composeWorld`.
- `packages/sprites`. The art as `.px` text, the palette, the compiler.
- `apps/desktop`. The Tauri shell around the office. It imports no package;
  its contract with the server is in `apps/desktop/CLAUDE.md`.
- `apps/site`. The public site, static. It reads `sprites` and `world` only.
- `scripts`. The lint guards: plain Node, no dependencies.
- `.github/workflows`. `ci.yml` runs the checks on every pull request, on a
  Mac, Linux and Windows, unless it changes only the site or the docs;
  `site.yml` checks those; `app-smoke.yml` installs and smoke-tests the app
  on pull requests that change it, and by hand; `release.yml` builds the app;
  `codeql.yml` scans.

## One function per job

Before writing a helper, use the one that already does the job.

| Job                                                     | Use                                                                   | In                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Write a ledger row (a decision, a hire, a run)          | `record()`                                                            | `packages/ledger/src/office-ledger.ts`                 |
| Find the office's folders, code and ports               | `home()`, `CODE`, `OFFICE_PORT`, `DATABASE_PORT`                      | `packages/ledger/src/home.ts`                          |
| Tell the office's time                                  | `zone()`                                                              | `packages/ledger/src/time.ts`                          |
| Read or write `.env`                                    | `readEnv()`, `writeEnv()`                                             | `packages/ledger/src/env.ts`                           |
| Read which system this is                               | `currentPlatform()`                                                   | `packages/ledger/src/platform.ts`                      |
| Start Claude Code, or reach Windows                     | `claudeCommand()`, `powershell()`                                     | `packages/ledger/src/platform.ts`                      |
| Know an AI tool's name and systems                      | `AGENT_NAMES`, `AGENT_PLATFORMS`                                      | `packages/ledger/src/agents.ts`                        |
| Know whether a run gets a shell                         | `commandsHow()`, `runsCommands()`                                     | `packages/ledger/src/agents.ts`                        |
| Know what an Odd's run reaches                          | `capabilities()`, `ownTools()`                                        | `packages/ledger/src/capabilities.ts`                  |
| Say a level or where the owner sets access              | `LEVELS`, `settingsTab()`, `levelRoute()`                             | `packages/ledger/src/access-words.ts`                  |
| Know whether an Odd holds an office tool                | `hasTool()`                                                           | `packages/ledger/src/tools.ts`                         |
| Register an office tool                                 | `tool()`                                                              | `packages/ledger/src/mcp-run.ts`                       |
| Check a folder before an Odd gets it                    | `checkFolder()`                                                       | `packages/ledger/src/office-folders.ts`                |
| Put a follow-up on a thread                             | `transitionWork()` with `runQueued`, whose `oweRun()` runs `settle()` | `packages/ledger/src/work/threads.ts`                  |
| Change a system that keeps state                        | `transition()`                                                        | `packages/ledger/src/transition.ts`                    |
| Decide what an event does to the office's work          | `decide()`, through `transitionWork()`                                | `packages/ledger/src/work/decide.ts`                   |
| Test a system with random event sequences               | `explore()`                                                           | `packages/ledger/src/sequences.ts`                     |
| Run an AI tool and read its stream                      | `drive()`                                                             | `apps/office/src/lib/server/drive.ts`                  |
| Say what an Odd is doing, on any screen                 | `oddNow()`                                                            | `apps/office/src/lib/staff/odd-now.ts`                 |
| Tell the page something changed                         | a table's trigger, or `emit()`                                        | `apps/office/src/lib/server/events.ts`                 |
| Tell every run how the office works                     | `house()`                                                             | `apps/office/src/lib/server/house.ts`                  |
| Run as the office, not as an Odd                        | `runAsOffice()`                                                       | `apps/office/src/lib/server/office-run.ts`             |
| Give the page an Odd                                    | `toProfile()`                                                         | `apps/office/src/lib/server/profile.ts`                |
| Reach an outside tool's server, for the owner or a run  | `upstream()`, through the run's gateway                               | `apps/office/src/lib/server/access.ts`                 |
| Refuse a request from anywhere but the page             | `guardOffice`                                                         | `apps/office/src/lib/server/owner-page.ts`             |
| Call the office from the page                           | `call()`, `stream()`, `follow()`                                      | `apps/office/src/lib/ui/api.ts`                        |
| Fail a lint guard                                       | `report()`                                                            | `scripts/lib/files.ts`                                 |
| Test against a database, the tool server, or the office | `pglite.ts`, `tool-server.ts`, `office-under-test.ts`                 | `packages/ledger/test/`, `apps/office/src/lib/server/` |

## A system that keeps state

Something the office keeps that changes as things happen, such as its work
or the lessons, decides each change in one pure function and writes it in one
transaction, as the 2026-11-11 `[arch]` decision in `docs/decisions/` says. A
new one takes the same four parts:

1. **Its states.** One union per stored thing, a parser that reads a row into
   a state its type allows and refuses a row whose columns disagree, and a
   serializer that writes every column back. The work's are in
   `packages/ledger/src/work/state.ts`. A check in a migration holds each
   rule for every new write, as `0033_work_checks` does.
2. **Its events and deciders.** What can happen, as plain data, each with one
   pure decider: no database, no clock. The work's are `WorkEvent` and
   `DECIDERS`; the lessons' are `LessonCommand` and `decideLesson` in
   `packages/ledger/src/lesson-rules.ts`. `test/pure-modules.test.ts` checks
   that they load no database.
3. **Its rules in a sequence test.** A test drives random events through the
   system with `explore()`, keeps its own record of what is true, and says
   each rule as an equality against that record.
   `packages/ledger/test/work-sequences.test.ts` and
   `lesson-sequences.test.ts` are the examples.
4. **The shell.** `transition()` loads and locks the rows, asks the decider,
   and writes the change, with ledger lines after the commit. The work's
   entry is `transitionWork()`. A system with no row to lock takes a lock of
   its own, as the lessons do per scope (`lockScopes` in `lessons.ts`).

## Adding a new kind

Each entry says where to start, then what fails when a place is missed. Where
nothing fails, it says so: name that place in the pull request.

Planned work starts where a "Later" line says, not here: the "Later" sections
of `packages/ledger/CLAUDE.md`, `apps/office/src/lib/server/CLAUDE.md`,
`apps/desktop/CLAUDE.md`, `scripts/CLAUDE.md` and `docs/CLAUDE.md` say what
comes first for a run timeline (one row per run), Stop for a run, a new
office tool or AI tool, a release smoke test, splitting a
big file, the size guard and a long guide file. The page pass is the last line
of "Rules for this app" in `apps/office/CLAUDE.md`. Whoever does a "Later" item
deletes its line, and whoever finds this page wrong fixes it in the same
change.

- **An ask kind.** Start at `ASK_KINDS` in `packages/ledger/src/schema.ts`.
  Check-types fails at `OWNER_ANSWERS.ask` in
  `packages/ledger/src/desk-answers.ts`, which says what each answer does. A
  kind the owner answers on its own card (a reply, a filter, a folder, a call)
  gives `approve` a `by`, the line a bare yes gets, and its route approves it;
  a plain yes (a `switch`, `level` or `office_tool` ask) names its effects
  directly. Check-types then fails at `TWINS` in
  `packages/ledger/src/work/twins.ts`, the repeat guard's switch in
  `raiseAsk` (`office-asks.ts`), `grantSetting` in `office-decide.ts`,
  `carriedLinesOf` and `carryOutBrief` in
  `apps/office/src/lib/server/follow-up-brief.ts`, `YES_SAID` in
  `apps/office/src/lib/ui/yes-said.ts`, and `ASK_ROWS` in the office's
  `named-tools.test.ts`.
- **A follow-up kind.** Start at `FOLLOW_UP_KINDS` in
  `packages/ledger/src/work/kinds.ts`. Check-types fails at every
  `Record<FollowUpKind, ...>`, `AT_DRAFT` and `SERVES_NO_THREAD` beside it
  among them, and at the switch in
  `apps/office/src/lib/server/follow-up-brief.ts`.
- **A work event.** Start at `WorkEvent` in
  `packages/ledger/src/work/events.ts`. Check-types fails at `WorkResults`
  beside it and at `DECIDERS` in `work/decide.ts` until the event has its
  decider.
- **A desk item.** Start at `DESK_ITEMS` in `desk-answers.ts`. Check-types
  fails at `OWNER_ANSWERS`, `Item` in `DeskDrawer.svelte`, `replyBrief` and
  `openDelivered`.
- **A connector kind.** Start at `CONNECTOR_KINDS` in `schema.ts`. Check-types
  fails at each switch on it, each ending in a `never` default. `builtin`
  connectors (Gmail, Google Drive) are served by the office itself (`builtin`
  in `access.ts`).
- **Something the owner can grant, or an owner control on an Odd's card.**
  Start at `OWNER_GRANTS` and `PATCH_KEY` in
  `packages/ledger/src/grantable.ts`. Check-types fails a key added to
  `STAFF_PATCH_KEYS` until `PATCH_KEY` classes it, and a new grant until
  `OWNER_GRANTS` has its row. `grantable.test.ts` holds each line an Odd
  hears about a grant it lacks. A hire's starting values are `HIRE_DEFAULTS`
  in the same file.
- **An AI tool.** Start at `AGENTS` in `packages/ledger/src/agents.ts`.
  Check-types fails at every `Record<Agent, ...>`, `AGENT_FILES` and
  `OFFICE_MODEL_VAR` among them, and at `WALLS` in
  `apps/office/src/lib/server/launch-contract.test.ts`. `agent-files.test.ts`
  fails until its instruction files and home folders are in both security
  lists.
- **An AI tool on another system.** Start at its `runs` and `commands` in
  `AGENT_PLATFORMS`. `sandbox-paths.test.ts` fails until `SANDBOX_PATHS` in
  `apps/office/src/lib/server/sandbox-paths.ts` declares that system, and
  `launch-contract.test.ts` launches the tool there. `scripts/check-platform.ts`
  fails a `process.platform` read anywhere but `currentPlatform()`.
- **A secret store.** Start at `STORE_MARKS` in `packages/ledger/src/office-folders.ts`;
  `SECRET_STORES` is its keys, so one list says what a run and a given folder
  stay out of. Each entry says how the store is found anywhere but
  the top of the home, where its name is enough.
  `own-tools.test.ts` walks every entry.
- **A variable a run needs.** Start at `RUN_ENV_ALLOW` in
  `apps/office/src/lib/server/run-env-allow.ts`, or `TOOL_SERVER_ENV` beside
  it for the tool server. `launch-contract.test.ts` fails a name that reaches
  a run unlisted. No check: a run that lacks a name it needs fails only when
  it runs.
- **An office tool.** Start at its row in `OFFICE_TOOLS` in
  `packages/ledger/src/tools.ts`, and register it in its `mcp-*.ts` file behind
  `has()`. A tool registered only alongside another, never granted alone
  (such as `my_pokes` with `poke_owner`), goes in `RIDES_WITH` instead,
  under the tool it rides with. When it is offered is a field on its row,
  never a rule in its `mcp-*.ts` file, which registers such a tool behind `offered()`:
  `withGmail` only while the Odd holds Gmail, `withWrite` only while it holds
  a service at Read and write, `withSkills` only while the owner attached a
  skill to it, `inChat` only in a chat on the owner's words,
  `notToManager` never to the Office Manager.
  Whether the owner grants it is the `office_tools` row of `OWNER_GRANTS`.
  `hand-off-tool.test.ts` fails a registered tool that is neither listed nor
  rides with one, check-types fails an id `OFFICE_TOOLS` lacks in
  `STARTER_TOOLS` or `has()`. The ledger's `named-tools.test.ts` fails a
  tool's description naming an office tool the Odd does not hold, and the
  office's `named-tools.test.ts` fails the same in `house()` and every
  follow-up's brief, unless that test's `NAMES_UNHELD` declares it with the
  Linear row that owes the fix.
- **A table.** Start at its `pgTable` in `schema.ts`, then run
  `npm run db:generate`. Its row in `LIVE_TABLES` in
  `packages/ledger/src/live-tables.ts` says whether the page hears it, and its
  trigger goes in a migration by hand. CI's "Migrations match the schema"
  fails a schema change with no migration, and `live-tables.test.ts` fails a
  table with no row or a trigger its row does not say.
- **A goal status.** Start at `GOAL_STATUSES` in `schema.ts`. Check-types
  fails at every `Record<GoalStatus, ...>`, `GOAL_IS_LIVE` in `goal-words.ts`
  among them.
- **A page call or a route.** A route is a folder under
  `apps/office/src/routes/api/`, and the page reaches it through `call()`,
  `stream()` or `follow()`, which take an `ApiUrl`: check-types fails a call
  to a route that does not exist. A route the owner acts through has its row
  in `OWNER_ACTIONS` in `apps/office/src/lib/server/owner-actions.ts`;
  `owner-actions.test.ts` fails a POST, PUT, PATCH or DELETE handler with
  none, a row that says it records but writes no ledger row, and a row that
  writes only sometimes (`mayRecord`, the kinds it may write and when) but
  writes a kind it does not list, or nothing in the state that writes. No check
  finds a GET or a page's `load` that changes something: give it a row by
  hand, and the test then fails if its handler goes.
- **A call out of the office.** Start at its file's entry in `OUTBOUND` in
  `scripts/outbound.ts`, with whose yes covers it (hard rule 4).
  `scripts/check-outbound.ts` fails lint when a file's calls, by the names it
  counts, differ from its entry. It counts no child process, such as an AI
  tool's run.
- **A kind of run.** Start at `UsageKind` in `schema.ts`. Check-types fails
  at `RUN_FAILURE` in `apps/office/src/lib/server/run-failures.ts`, and
  `failed-run.test.ts` holds where each failure lands. Live execution uses
  `runsGoing` in `run-registry.ts`, with a stop handle on each entry.
  `run-state.test.ts` checks admission and removal; `chat-steer.test.ts`
  checks that Stop and Send now select only the named attempt.
- **A room kind.** Start at `ROOM_KINDS` in `packages/world/src/generate.ts`.
  Check-types fails at `KIND_ABOUT` and `ROOM_ID`. No check: its furnishing
  in `recipe()`, and the rooms an Odd names in a hire proposal (`hireFields`
  in `mcp-run.ts`), which list Main Street's by hand.
- **A migration.** After a schema change, `npm run db:generate` writes it; a
  trigger, function or row goes in one by hand. `migrations.test.ts` fails a
  journal entry out of order or a file with no entry. No check runs it
  against a real office's data: do that by hand, as
  `packages/ledger/CLAUDE.md` says under "Running it".
- **A lint guard.** Start at a script in `scripts/` that fails through
  `report()`, add it to `lint:guards` in the root `package.json`, and give it
  a line in `scripts/CLAUDE.md`. No check: a guard left out of `lint:guards`
  never runs.
- **A `CLAUDE.md` or a decision.** `check-context-index.ts` fails a
  `CLAUDE.md` its nearest ancestor does not name, and `check-ledger.ts` a
  decision file out of shape (`docs/decisions/CLAUDE.md`).
