# docs/

Decisions, the reasons behind the hard rules, the office design, and the
backlog. Read a doc's status before acting on it: **proposed** (not agreed),
**ratified** (agreed, not built), **built** (in the code), **historical**
(kept for reference).

- [decisions/CLAUDE.md](decisions/CLAUDE.md). The ledger, one file per decision. How to find, record and supersede one.
- `office.gif`. The animation at the top of the README. `npm run office-gif -w @oddboro/site` makes it.
- `hard-rules.md`. **Ratified.** The reason behind each hard rule in the root `CLAUDE.md`, one section per rule, same order.
- `code-standard.md`. **Ratified.** The twelve rules, Q1 to Q12, that code is written to and a pull request is reviewed against.
- `architecture.md`. **Built.** The picture: the parts, one function per job, and where each new kind of thing starts and which check catches a missed place.
- `project-sessions.md`. **Built.** Native Codex and Claude Code sessions: start or attach, permissions, and recovery.
- `chat-update-boundaries.md`. **Built.** Update status and owner controls in chat, and the limits on untrusted instructions.

## Later

Each line says what to do when its trigger comes.

- When a `CLAUDE.md` gets long enough to cost its readers, so that someone
  working in its folder has to read past detail they do not need: move that
  detail into the code's comments or a doc the file points at, and keep what
  someone working there needs.
