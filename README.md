# Oddboro

![The Oddboro office by day: Odds typing at their desks, reading in the library, running on the treadmill and eating in the kitchen, while others walk between rooms](docs/office.gif)

A virtual office for one person, the owner. AI workers called Odds work on a
pixel-art floor, and where each one stands tells you what it is doing. The office runs on your
computer, a Mac, Linux or Windows, and its first Odd is the Office Manager you pick.

[Watch the Oddboro launch demo or read the transcript](https://natesnewsletter.substack.com/p/oddboro-manage-multiple-ai-agents-launch).
The replay shows how the Office Manager keeps track of work across agents.

## Get started

The quickest way is the app, for a Mac, Windows or Linux, from
[oddboro.com/releases](https://oddboro.com/releases/). To run it from source
instead, you need a Mac, Linux or Windows 10 or later, [Node](https://nodejs.org) 24 or
later, and a Claude plan or an Anthropic API key. On Windows, Git for Windows brings
`git`, and the steps below work the same in PowerShell.

1. Clone the repo:

   ```sh
   git clone https://github.com/New-Altitude/Oddboro.git oddboro
   ```

2. Go into it:

   ```sh
   cd oddboro
   ```

3. Run setup:

   ```sh
   npm run setup
   ```

Setup asks nothing. It installs what the office needs, starts the office now
and at every login, and opens it in your browser. The browser walks you through
the rest: Claude Code (it installs it or signs you in), your name, your Office
Manager, the office you want, and its time zone. Then the office goes up in
front of you.

The office lives at `https://local.oddboro.com`. Setup offers to put it there
through [Caddy](https://caddyserver.com), and downloads Caddy if your computer has
none. Without it, the office is at `http://oddboro.localhost:4500`.

## Day to day

Use [project sessions](docs/project-sessions.md) to open a native Codex or Claude Code conversation in the office and share it with an Odd.

- `npm run setup -- --check` checks everything and changes nothing.
- `npm run reset` starts the office over. It moves the old one into
  `~/.oddboro/backups/` and deletes nothing.
- The office keeps its own database, with nothing to install. To use another
  Postgres 15 or later with pgvector (in Docker with `npm run db:up`, or hosted,
  with the direct connection string, not a pooled one), put it in `.env` as
  `DATABASE_URL`.
- Ledger search by meaning needs the search model, a 140 MB download from
  Setup. The office runs it itself, so nothing you search leaves your
  computer. Until then the ledger is searched by its words.
- `uv` runs the tools that come from PyPI. The office says when it is missing.

## Work on it

| Path               | What it holds                                         |
| ------------------ | ----------------------------------------------------- |
| `apps/office`      | The office: SvelteKit and a PixiJS floor, port 4500   |
| `apps/site`        | The public site, oddboro.com: static files, port 4501 |
| `packages/sprites` | The art, the palette, and the atlas compiler          |
| `packages/world`   | Rooms, floor plans, and the office generator          |
| `packages/ledger`  | The records: Odds, the desk, access, jobs, the ledger |
| `scripts`          | Lint guards                                           |
| `docs`             | Decisions, hard rules, the office design, the backlog |

- **Art:** edit or add a `.px` file in `packages/sprites/src/` (the format is in
  `packages/sprites/FORMAT.md`, the style in `packages/sprites/ART.md`), run
  `npm run sprites`, then `npm run render -- main-street` to see the whole floor in
  `packages/world/out/main-street.png`.
- **A space:** add a room stamp to `packages/world/rooms/` and place it in a plan
  in `packages/world/plans/`. No engine code changes.
- **The private-word list:** create `data/private-words.txt` with your names
  and account names, one per line. Git ignores it, and `npm run lint` fails
  until it exists.
- **Before calling anything done,** all three at zero:

  ```sh
  npm run lint
  npm run check-types
  npm run format:check
  ```

The rules are in `CLAUDE.md`.

## Contributing

See `CONTRIBUTING.md`. Every commit in a pull request is signed off under the
Developer Certificate of Origin (`git commit -s`).

## Security

Report a vulnerability privately, never in a public issue. See `SECURITY.md`.

## License

Apache License 2.0. See `LICENSE`, and `NOTICE` for the attribution that
travels with the code. The license grants no rights to the Oddboro name.
The 25 music tracks are not covered by it: see `LICENSE-ASSETS`.
