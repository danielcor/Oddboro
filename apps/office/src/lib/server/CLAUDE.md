# apps/office/src/lib/server

The office's server side: each Odd's runs and the AI tools they go through,
office runs, the job clock, events and the keychain. How it all works is in
`apps/office/CLAUDE.md`; this file says where to start a change here.

## Where to touch

Each kind of thing starts at its one declaration; the type checker or a test
then names every other place.

- To let a run have a variable from the office's own environment, add its
  name to `RUN_ENV_ALLOW` in `run-env-allow.ts`, for every system, one system
  or one tool, with a comment saying which tool needs it and why. A run gets
  nothing else of the office's environment (`runEnv`), and nor does an
  outside tool's server the gateway starts for it (`outsideToolEnv`).
- A variable the office's tool server reads as it starts goes in
  `TOOL_SERVER_ENV` in `run-env-allow.ts`. The tool server's entry, which
  every tool's launch reads, sets it by name (`toolServerEnv`), so the server
  never depends on the AI tool passing it on.
- To sandbox a tool on a new system, start at `SANDBOX_PATHS` in
  `sandbox-paths.ts`. `sandbox-paths.test.ts` fails until that system's paths
  are declared for every tool that sandboxes there.
- To add an AI tool, or a system a tool runs on, start at `AGENTS` and
  `AGENT_PLATFORMS` in the ledger's `agents.ts`. `launch-contract.test.ts`
  then starts every tool on every system it runs on, from an office whose
  environment holds things no run should get, and fails its type check until
  the new tool has an Odd there and a reader of its walls (`WALLS`).
- To call out of the computer from new code (a door to an outside service,
  such as a persona's, an error report, or a new connector kind), add or
  update the file's entry in `OUTBOUND` in the repo's `scripts/outbound.ts`:
  how many calls, where they go, what they send and whose yes covers them.
  `npm run lint` fails until the entry matches the code. A kind of call the
  guard does not name yet (a new client library's constructor or init) goes
  in `scripts/check-outbound.ts` too. A call through a child process (an
  installer, a tool's update check, an AI tool's run) is not counted, so the
  guard does not catch one; that file says what else it does not count.
- To add a route that changes something (a POST, PUT, PATCH or DELETE
  handler, a staff PATCH body key, or an `op` in `TASK_OPS`), add its row to
  `OWNER_ACTIONS` in `owner-actions.ts`: the ledger kind it records, the
  kinds it may record and when (`mayRecord`, for a route that writes only
  sometimes, never `none`), what it changes or the Linear row that owes one,
  or why it is not an action. `owner-actions.test.ts` fails until the row is
  there, and drives each recording row to check it writes exactly one ledger
  row of that kind, and each `mayRecord` row to check it writes only the
  kinds it lists, and some in the state its driver sets up to write. A GET
  that changes something, or a page's `load` that does, gets a row by hand:
  the test cannot tell it from a read.
- To add a kind of run (`UsageKind` in the ledger), add its row to
  `RUN_FAILURE` in `run-failures.ts`: each place the owner finds its error.
  The type check fails until the row is there and `failed-run.test.ts` has a
  way to make that kind fail; the test then checks the error shows in
  exactly those places.
- To change what Odds are told (`house.ts`, a run's brief, or the lines in
  the ledger's `capabilities.ts`), change the words, then run
  `npm run prompts:accept -w @oddboro/office` and commit the changed
  `prompts.test.ts.snapshot` with them. `prompts.test.ts` holds the prompt of
  each kind of run an Odd makes and fails until its snapshot matches, so
  review reads the change line by line. A new follow-up kind fails its type
  check until it has a case there. Add a new case at the end of the file, so
  the ids in the cases before it stay put.

## Live runs

`runsGoing` in the ledger's `run-registry.ts` is the one registry. Reserve an
entry before preparation and release it after the result is kept. Each entry
has a stop controller and an end promise. `run-state.ts` admits background
slots and derives the floor's work from those entries. `chat-run.ts` owns
saved chat attempts, Stop and Send now (`add` on a Claude Code chat's entry). The job clock keeps its own due
jobs; it never owns a second process registry.

## Later

Each line says what to do when its trigger comes.

- Building NEW-1651 or NEW-1654, whichever comes first: give each run one
  row of its own, with `runs.jobId` optional and usage pointing at the run.
- When a feature changes `staff.ts` substantially (it adds to or rewrites a
  group of functions, not a line or two): first move the piece it touches into
  a module of its own, then make the change there. Do not split the file in
  one go while pull requests are open.
