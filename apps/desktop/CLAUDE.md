# apps/desktop

Oddboro for the Mac, Linux and Windows. A Tauri v2 shell in Rust that runs
the office server (`apps/office`, built with adapter-node) on a bundled Node
and shows it in a window. On a Mac: Apple Silicon, macOS 13 or later, a signed
and notarized `.app` in a `.dmg`. On Linux: an AppImage for x86_64 or arm64,
on a systemd desktop with a Secret Service keyring and a notification
service. On Windows: a per-user installer (NSIS) for x64 or arm64, Windows 10
or 11, not code-signed yet. No UI framework: the only page of its own is
`loading/index.html`.

Where a new kind of thing starts, the shared function for each job, and the
check that catches a missed place: `docs/architecture.md`.

What differs between the systems is in `#[cfg(...)]` branches, one per
function: the home and log folders and the PATH (`env.rs`), asking Node to
quit, keeping the computer awake and notifications (`server.rs`), opening
links, the tray icon and closing the window (`main.rs`), and reopening after
an update (`update.rs`).

## What the shell does

1. Checks for a newer version before anything else (`update::on_launch`,
   5 second timeout). If there is one, the loading window says "Updating
   Oddboro to X.Y.Z", and the shell downloads it, checks its signature,
   installs it and opens the new version. Offline or any error, it logs the
   problem and starts as it is. See "Updates" below.
2. Checks the port. If anything answers on it, shows "another office is
   already running" and quits. It never attaches to that office.
3. Reads the owner's login-shell PATH once (`$SHELL -l -i -c`, so
   `~/.zshrc` and the Node managers it sets up run, then `$SHELL -l -c` if
   that fails; 5 second timeout each; `/bin/zsh` on a Mac and `/bin/sh` on
   Linux when `SHELL` is unset), then adds `/opt/homebrew/bin`,
   `/usr/local/bin`, `~/.local/bin` and `~/.claude/local` if missing. Windows has no login shell: the app's
   own PATH, plus `%USERPROFILE%\.local\bin` (Claude Code's and uv's
   installers), WinGet's `Links` folder and `C:\Program Files\Git\cmd`.
4. Starts Node, shows the small loading window, and asks `GET /` every half
   second for up to 90 seconds. When it answers, the main window opens the
   office and the loading window closes. On timeout, a dialog shows the last
   lines of the log and the app quits.
5. Writes Node's stdout and stderr to `~/Library/Logs/Oddboro/office.log` on
   a Mac, `~/.local/state/oddboro/office.log` on Linux (`XDG_STATE_HOME`
   wins when set) and `%LOCALAPPDATA%\Oddboro\Logs\office.log` on Windows,
   or wherever `ODDBORO_LOG` says. Its own lines start `oddboro: ` and the
   time in UTC: first `Oddboro <version> (<target>) opening` with the pid,
   port, home and webview version, then the update check, `started node`,
   `office page loaded: <url>` once the window has the page, and the words
   of every dialog it shows (`dialog: ...`), written before the dialog waits
   for OK. The office adds `office:` lines (each startup step's time,
   `ready`, a new version's `first start of X after Y`) and `page:` lines
   (the page's boot and its errors), as `apps/office/CLAUDE.md` says. Past
   10 MB the log moves to `office.log.1` when Node next starts.
6. Restarts Node when it dies: after 1s, 5s, then 30s, at most 5 times in 10
   minutes. Then it shows the log tail and quits. After a restart the main
   window reloads.
7. Keeps the computer awake while Node runs. On a Mac,
   `/usr/bin/caffeinate -s -w <node pid>`, on AC power only. On Linux,
   `systemd-inhibit --what=sleep --mode=block cat`, with `cat`'s stdin a pipe
   the shell holds: it lets go when Node stops or the shell dies. It holds on
   battery too, and closing a laptop's lid still suspends it (logind ignores
   inhibitors for the lid by default). On Windows, a thread that called
   `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` and waits;
   Windows lets go when it ends. It too holds on battery, and the lid still
   sleeps the laptop.
8. Closing the main window hides it, and the shell tells the page
   (`oddboro:hidden`), which pauses the music; showing the window again
   (`oddboro:shown`) plays it on (`apps/office/src/lib/ui/music.svelte.ts`). The Dock icon and the menu bar item
   (Open Oddboro, Open at login, Quit Oddboro) bring it back. Open at login
   uses `tauri-plugin-autostart`: a LaunchAgent on a Mac, an entry in
   `~/.config/autostart` naming the AppImage on Linux. On Linux the tray shows
   only where something owns `org.kde.StatusNotifierWatcher` on the session
   bus (KDE, most tiling setups, GNOME with the AppIndicator extension). With
   none, as on GNOME when it ships, closing the window quits Oddboro, since
   nothing could bring it back. On Windows the tray icon is the app's
   coloured icon, and Open at login is a Run entry in the registry. Opening
   Oddboro again while it runs shows its window
   (`tauri-plugin-single-instance`, Linux and Windows; the Mac does this
   itself).
9. On quit, sends Node SIGTERM, waits up to 10 seconds, then SIGKILL. A
   SIGTERM, SIGINT or SIGHUP to the shell itself quits the same way. A second
   one kills the shell at once. Windows has no SIGTERM: the shell closes
   Node's stdin, which the server takes as "quit", waits the same 10 seconds,
   then ends it with `TerminateProcess`. Node runs with `CREATE_NO_WINDOW`,
   so neither it nor anything it starts opens a console window.
10. Keeps links to the office's own origin in the window. Links to any other
    origin, `mailto:` and `tel:`, and every `target="_blank"` or
    `window.open`, open in the default browser.
11. Reports a panic, giving up on the office (step 4's timeout, step 6's
    limit, or Node not starting) and a broken install (no Node, no server
    code), only when it found a report address and the office's `.env`
    says `OFFICE_DIAGNOSTICS=yes`, read at send time (`diagnostics.rs`). The
    address is `ODDBORO_DIAGNOSTICS_DSN` from the shell's environment, else
    the one the release was built with (`build.rs`), else the office's
    `.env`. A report carries a fixed text and Node's exit code when it has
    one, or for a panic its place in the code with the message withheld, never the log.
    It leaves with only the fields an allow list names and the computer's
    name replaced. Its file paths follow the office's rule (`report_path`):
    in a release, the shell's own code relative to the repo, which its build
    maps to `/oddboro` (`PATH_MAPS` in `scripts/release.ts`, most specific
    folder last, since the compilers apply the last match); any other file
    under the home folder as its name alone; and files outside it whole. A
    loaded file (a debug image) is named by its file name alone, and of the
    device only the chip's architecture is kept. Each report sends on its
    own thread and holds up the dialog or the panic 2 seconds at most; a run
    sends one panic report. With no address the shell sets no panic hook and
    runs no thread for reports. A report to New Altitude's address (or to the
    account site `ODDBORO_ACCOUNT_SITE` names, from the environment or the
    office's `.env`) needs the office's New Altitude sign-in, by the office's
    rule (`needs_sign_in`, tested against the office's
    `needs-sign-in.cases.json`). On its thread the shell reads the sign-in
    the office saved: on Linux with the office's own command (`secret-tool`),
    and on a Mac from its own Keychain items (`secrets.rs`), where the app's
    office keeps it. It sends with its access token in the
    `authorization` header. It never refreshes or writes the sign-in, so a
    token with under a minute left is not sent. The report is dropped while
    signed out, when the token has run out, and on Windows, whose
    Credential Manager the shell does not read. The read counts in the same
    2 seconds.

The page gets no Tauri IPC: there are no capability files, and remote pages
never get IPC without one.

When the shell gives up, its exit code says why: 2 another office has the
port, 3 no Node, 4 no office server, 5 a bad server URL, 6 the server would
not start or keep running, 7 no window. 0 is a quit.

## The contract with the server

- Entry: `<resources>/server/apps/office/build/index.js`, run with cwd
  `<resources>/server/apps/office`.
- Node: the sidecar beside the shell, `Contents/MacOS/node` on a Mac,
  `usr/bin/node` in the AppImage and `node.exe` in the install folder on
  Windows, from `src-tauri/binaries/node-<target>` (`aarch64-apple-darwin`,
  `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, or
  `x86_64-pc-windows-msvc.exe` and `aarch64-pc-windows-msvc.exe`). `build.rs` passes the target to the code as
  `ODDBORO_TARGET`, so a debug build finds its copy.
- Env Node gets:

| Variable                       | Value                                                      |
| ------------------------------ | ---------------------------------------------------------- |
| `PORT`                         | the port, 4500 unless the shell's env sets `ODDBORO_PORT`  |
| `ODDBORO_PORT`                 | the same                                                   |
| `HOST`                         | `127.0.0.1`                                                |
| `ORIGIN`                       | `http://127.0.0.1:<port>`                                  |
| `BODY_SIZE_LIMIT`              | `12M` for chat imports; attachments keep their own limit   |
| `ODDBORO_HOME`                 | `~/.oddboro` (`%USERPROFILE%\.oddboro`), unless set        |
| `ODDBORO_CODE`                 | `<resources>/server`                                       |
| `ODDBORO_DB_PORT`              | passed through when the shell's env sets it                |
| `PATH`                         | the login-shell PATH from step 3                           |
| `ODDBORO_VERSION`              | the app's version, like `0.0.4`                            |
| `BODY_SIZE_LIMIT`              | `11M`, so a 10 MB file attached in a chat gets through     |
| `ODDBORO_UPDATE_TOKEN`         | a fresh secret per run, release builds only                |
| `ODDBORO_SECRETS`              | `shell` on a Mac: the shell keeps the office's secrets     |
| `ODDBORO_GOOGLE_CLIENT_SECRET` | the Google sign-in client's secret, when the build had one |
| `ODDBORO_GITHUB_CLIENT_SECRET` | the GitHub sign-in app's secret, when the build had one    |
| `ODDBORO_DIAGNOSTICS_DSN`      | the report address from step 11, when the shell found one  |

- `ODDBORO_APP=1`. With it the server quits on SIGTERM once its HTTP server
  closes, and when its stdin closes (`apps/office/src/hooks.server.ts`). It
  also has no web address: onboarding skips the address step and the office
  never touches Caddy.
- Node's stdout is a pipe too. A line `oddboro:notify <title>\t<text>` is a
  notification, which the shell shows as Oddboro's: `mac-notification-sys`
  with the Glass sound on a Mac, and a toast through
  `tauri-winrt-notification` on Windows, under the app's identifier, which
  the installer gives its Start menu shortcut. On Linux the shell calls
  `org.freedesktop.Notifications.Notify` on the session bus, with app name
  Oddboro and the hint `desktop-entry=oddboro`. When that call fails it runs
  `notify-send --app-name=Oddboro --hint=string:desktop-entry:oddboro`. If
  both fail, the office log gets one line with the exit code and stderr.
  A line `oddboro:update-check` is the owner's Check now. A line
  `oddboro:secret <json>` asks for the Keychain (below). Every other line goes
  to the log.
- A host program the shell starts on Linux (`systemd-inhibit`, `xdg-open`,
  `secret-tool`, and `notify-send`) gets the host's library path from
  `src-tauri/src/host.rs`. Inside an AppImage `LD_LIBRARY_PATH` points at the
  glib the bundle carries, which is older than the host's libnotify, so those
  programs fail to start. `host.rs` drops that path, or puts back the values
  the runtime saved, and takes the AppImage's folders off `PATH`.
- The Keychain, on a Mac (`src-tauri/src/secrets.rs`). The office sends
  `oddboro:secret {"id":n,"op":"list"|"legacy"|"set"|"remove","account":"...","value":"..."}`
  and the shell answers on Node's stdin with one line, `{"id":n,"ok":true,...}`
  or `{"id":n,"ok":false,"error":"..."}`. `list` gives `secrets`, every
  account and value under the service `com.oddboro.office`; `legacy` gives
  `accounts`, the names alone under the old service `oddboro`, which macOS
  shows without a prompt. The shell reads and writes through Apple's Security
  framework (`security-framework`), in the login keychain, so each item trusts
  only Oddboro, by its Developer ID team and bundle id: updates keep access,
  and any other program gets macOS's "allow access" prompt. No line holding
  `oddboro:secret` ever reaches the log, whole or garbled. The office opts in
  from `hooks.server.ts` (`useShellSecrets` in the ledger); its child
  processes never do.
- Node's stdin is a pipe the shell holds open. It closes when the shell dies
  by any means, Force Quit included, so a force-quit shell never leaves Node
  running on the port.
- `ODDBORO_SERVER_URL`, when set, skips Node and opens that URL. Use it to run
  the shell against `vite dev`.

## Updates

Every update is required. `src-tauri/src/update.rs` runs them with
`tauri-plugin-updater`, in release builds only.

1. The app checks
   `https://github.com/New-Altitude/Oddboro/releases/latest/download/latest.json`.
   A draft release is invisible there, so nothing updates until the owner
   publishes one. `ODDBORO_UPDATE_URL` replaces the address, for testing on
   this Mac only.
2. On launch it installs a newer version before the server starts (step 1
   above).
3. While the office runs it checks every 4 hours, and when the server writes
   `oddboro:update-check` (Check now in Setup). It downloads a new version in
   the background and checks its signature against the public key in
   `tauri.conf.json`, then `POST`s `{ version, notes }` to
   `http://127.0.0.1:<port>/api/update` with the header
   `X-Oddboro-Update-Token`. A check that finds nothing posts
   `{ checked: true }`; one that fails posts `{ failed }`.
4. Then it asks `GET /api/update` every 30 seconds. When the answer has
   `install: true` (the server decides, see `apps/office/CLAUDE.md`), it stops
   Node the usual way (`server::stop`), installs, and opens the new version.
5. On a Mac it reopens itself with `open -n` and passes every `ODDBORO_*`
   variable on with `--env`, since launchd drops the old process's
   environment. Tauri's own `restart()` would lose them. On Linux the updater
   replaces the AppImage file in place (the path in `APPIMAGE`), and the shell
   starts it with its own environment plus `ODDBORO_RELAUNCH_FROM=<its pid>`.
   The new one waits up to 30 seconds for that pid to go
   (`update::wait_for_old`) before it claims the single instance and the
   port. The AppImage must sit somewhere the owner can write, such as
   `~/Applications`. On Windows the updater runs the new version's installer
   in passive mode (a progress bar, no questions) and ends the shell itself,
   after the shell has stopped Node; the installer opens the new version
   when it is done. Only a failed install comes back to the shell, which
   reopens the same version the Linux way, with `ODDBORO_RELAUNCH_FROM`.
6. The private key that signs updates lives outside the repo, in
   `~/.tauri/oddboro-updater.key` on the owner's Mac, its password in the
   keychain (`security find-generic-password -s oddboro-updater-key -a password -w`),
   and both in the GitHub secrets below. Losing it means no installed app can
   update again.

## Files

- `src-tauri/src/main.rs`. Windows, the menu bar item, links, and the
  startup steps.
- `src-tauri/build.rs`. Tauri's build, and the target triple as
  `ODDBORO_TARGET`. It rebuilds when `ODDBORO_DIAGNOSTICS_DSN` changes.
- `src-tauri/src/diagnostics.rs`. The shell's error reports: the address,
  the owner's answer, the New Altitude sign-in, the allow list and the
  sending.
- `src-tauri/src/server.rs`. Starting, watching, restarting and stopping Node.
- `src-tauri/src/env.rs`. Port, home, log path and the login-shell PATH.
- `src-tauri/src/host.rs`. The environment a host program gets inside an
  AppImage.
- `src-tauri/src/secrets.rs`. The office's secrets in the Mac's Keychain, and
  the line protocol it asks with.
- `src-tauri/src/update.rs`. Checking, downloading and installing updates,
  and asking the server when.
- `src-tauri/tauri.conf.json`. The app, with no sidecar or resources, so
  `cargo check` and `cargo clippy` work before anything is staged.
- `src-tauri/tauri.bundle.conf.json`. Adds `externalBin` and the
  `../stage/` to `server/` resource map. `npm run bundle` and `release.ts`
  merge it.
- `src-tauri/tauri.release.conf.json`. Turns on `createUpdaterArtifacts`.
  Only `release.ts` merges it, on a Mac, since it needs the updater key.
- `src-tauri/tauri.linux.conf.json`. Tauri merges it on Linux by itself: the
  AppImage target, with GStreamer bundled (`bundleMediaFramework`), since the
  AppImage points GStreamer at its own plugins and the office plays music.
- `src-tauri/tauri.windows.conf.json`. Tauri merges it on Windows by itself:
  the NSIS target, installed per user under `%LOCALAPPDATA%` with no
  administrator, the WebView2 bootstrapper for a Windows without WebView2,
  and the updater's passive install.
- `loading/loading.js`. The loading window's words: "Opening the office", or
  "Updating Oddboro to X.Y.Z" when the shell sets `window.oddboroUpdating`.
- `src-tauri/Entitlements.plist`. `allow-jit` and
  `allow-unsigned-executable-memory`, which V8 in Node needs under the
  hardened runtime. No App Sandbox: the server spawns `claude` and reads
  `~/.claude`.
- `scripts/stage.ts`. Builds the office and the sprites, then lays out
  `stage/`: the office build, which bundles every third-party package the
  office itself runs except Sentry, the production `node_modules` that Sentry,
  the ledger, sprites and world load, at the versions installed in the repo
  (optional ones too, so the ledger's terminal library, `node-pty`, ships, and
  a stage that cannot install it fails; it has no Linux prebuild, so a Linux
  stage compiles it with Python, make and a C++ compiler), and those three as plain
  JavaScript (types stripped, `.ts` imports rewritten) in
  `node_modules/@oddboro/`, with their files beside them. Packages' test
  folders (`__screenshots__`, `__tests__`) and every source map stay out, and a staged path
  longer than 180 characters fails the stage: the Windows installer's
  builder stops at 260, and GitHub's runner puts the stage 60 deep. Sentry's
  build tools stay out too: peer packages (Vite and SvelteKit, with Rolldown
  and Lightning CSS), and `BUILD_ONLY` (Sentry's bundler plugins, the oxc
  parser and the `sentry` CLI). The stage keeps only this machine's terminal library and helpers.
  The Mac release signs and verifies them before bundling the app. The keyring
  must carry its publisher's timestamped Developer ID signature on a Mac.
  Any other native code fails the stage. It fails if the office lists a
  third-party package under `dependencies` that `UNBUNDLED` does not name
  (Sentry's two): its build bundles the rest, so they belong in
  `devDependencies` (0.0.5 shipped 16,000 files of them, #13). It fails if
  any page chunk is over 500 kB. It fetches the Node
  binary for this machine's Node version, system and chip, and checks it
  against nodejs.org's sums (Windows's comes as a zip, unpacked with
  Windows's own `tar`). `scripts/smoke.ts --stage` then checks the stage.
- `scripts/smoke.ts` and `scripts/driver.ts`. The smoke test, and what
  drives the installed app for it. See "Smoke tests".
- `installer/`. The window the Mac `.dmg` opens to: the app and
  Applications on Oddboro's grass lot, an arrow between them.
  `lot.json` is the lot (a room stamp of grass and park props), `arrow.px`
  the arrow. `scripts/installer.ts` draws them into `background.tiff` (1x
  and 2x) and has Finder lay out a scratch disk named Oddboro, keeping its
  layout as `DS_Store`. `release.ts` copies both into every `.dmg`. Only
  Finder writes a layout Finder trusts, and it finds the picture by its path
  on a disk named Oddboro, so the volume name must stay. After changing
  `lot.json` or `arrow.px`, run `npm run installer -w @oddboro/desktop` on a
  Mac and commit both files. `-- --look` writes only the picture, with the
  icons marked, to `out/installer-look.png`.
- `stage/` must hold no folder symlinks. The bundler walks it without
  following them, so a linked folder never reaches the app.
- `stage/`, `src-tauri/binaries/`, `src-tauri/target/` and `src-tauri/gen/`
  are gitignored.

## Releases come from GitHub only

Public releases are built on GitHub's runners (Mac, Ubuntu 22.04 on x86_64
and arm64, and Windows on x64 and arm64), never on a developer's computer: Tauri writes the source
folder's full path into the app, and on a developer's computer that path
names them. The Ubuntu runners are the oldest supported Ubuntu, so the
AppImages run on systems with an older glibc too. `scripts/release.ts` maps Rust's
own source paths to neutral ones and refuses to sign a build that still holds
the builder's home folder. Local builds stay for testing: `npm run bundle`, or
a signed `tauri build --bundles app` run beside the owner's office on 4510.

`.github/workflows/release.yml` runs by hand, and on every push to `main`
that changes what goes into the app: `apps/desktop`, `apps/office`,
`packages`, `.nvmrc` or the workflow itself, but not a `CLAUDE.md`. A merge
that touches only the site or the docs builds nothing. Neither does a
lockfile-only update, so run it by hand for one that should ship. Six jobs:

1. `version` picks the next patch version from the highest PUBLISHED release
   tag (none gives `0.0.1`), and writes GitHub's generated notes. A draft
   never takes a number. The committed version never changes; the build sets it
   (`release.ts --version`).
2. `mac` installs Node from `.nvmrc`, Rust stable with `aarch64-apple-darwin`
   and the repo's packages, imports the Developer ID certificate into a
   temporary keychain, and runs `release.ts`: build, sign, notarize with the
   API key, staple, the updater archive and its signature, and a
   `latest.json` for `darwin-aarch64`.
3. `linux`, once on x86_64 and once on arm64, installs the libraries Tauri
   builds against and runs `release.ts`: the AppImage, its signature, a copy
   under the site's name, and a `latest.json` for `linux-x86_64` or
   `linux-aarch64`. Only the updater key and the Google client's secret are
   needed.
4. `windows`, once on x64 (`windows-latest`) and once on arm64
   (`windows-11-arm`), installs Rust where the runner lacks it, on arm64
   names the Windows SDK's `rc.exe` and Visual Studio's clang (the registry
   points Rust's build at a Windows Kits folder without `rc.exe`, and ring
   needs clang there), and runs
   `release.ts`: the installer, its signature, a copy under the site's name,
   and a `latest.json` for `windows-x86_64` or `windows-aarch64`. Only the
   updater key and the Google client's secret are needed. The installer is not code-signed, so Windows
   SmartScreen warns before it runs.
   Before it signs, `release.ts` checks the build's own version: the Windows
   app and installer's file version, and the Mac app's `Info.plist`.
5. `smoke` installs each build and runs it on its own kind of machine, plus
   the x86_64 AppImage on Ubuntu 24.04 (see "Smoke tests"). No secrets. One
   failure, and no draft.
6. `draft` tests and runs `scripts/check-release.ts` on what the five builds
   uploaded, and creates nothing unless every build passes: exactly the files
   this version should have, each site copy byte for byte the versioned file,
   each `latest.json` naming this version, its own machine and this release's
   file, each updater signature verified against the app's public key over
   the file's own bytes and naming its file and version, and each served
   file at least about half its 0.0.8 size, so none is cut off or empty
   (`smallest` in `BUILDS`; bloat is `stage.ts`'s to catch). 0.0.6 shipped
   0.0.5's Windows installer (#40); this is the check that stops that. It
   writes the merged `latest.json` and the list of files to upload, so the
   draft never takes a file it did not check. Then it deletes any draft of
   the same version, and creates a DRAFT release `vX.Y.Z` on the merge
   commit, with the notes and these assets:
   `Oddboro.dmg`, `Oddboro-x86_64.AppImage`, `Oddboro-aarch64.AppImage`,
   `Oddboro-x64-setup.exe` and `Oddboro-arm64-setup.exe` (the site's
   Download buttons link to `releases/latest/download/` under these names,
   so every release carries them), the versioned `.dmg`, the Mac updater
   archive and its `.sig`, each versioned AppImage and installer and its
   `.sig`, and `latest.json`.
7. The owner reads the draft and presses Publish. Installed apps pick it up at
   their next check, and the next build takes the next version. Until then,
   each merge replaces the draft, so it always holds the newest `main`.

Each build job also passes `ODDBORO_DIAGNOSTICS_DSN` and Sentry's
`SENTRY_AUTH_TOKEN`, with `SENTRY_ORG` and `SENTRY_PROJECT` from the release
environment's variables. With the token, `release.ts` builds the shell with line
tables (inside the binary on Linux, a `.dSYM` or `.pdb` beside it on the
Mac and Windows) and uploads them, and the office's build uploads its source
maps. Without it the release profile stays stripped and nothing goes to
Sentry. A `--test` build uploads nothing.

The repo must be public for installed apps to reach the release. While it is
private, `latest.json` answers 404 to them.

### Smoke tests

`scripts/smoke.ts` checks a real build the way an owner meets it, one row of
a table per step; a failed required row fails the run. It runs the app on
port 4590, database port 54590, a throwaway home and its own log
(`ODDBORO_LOG`), and points `ODDBORO_UPDATE_URL` at an address that refuses,
so the build never updates itself away. The port, home and log are its own;
the secrets are not, so the office runs with no secret store
(`ODDBORO_SECRETS=office`), always with `--stage` and off CI for the app, and
never reads the owner's Keychain or keyring.
The Mac app keeps its secrets through its shell, in the same Keychain the
owner's Oddboro uses, so off CI `--installed` and `--artifact` on a Mac
refuse to run without `--my-keychain`. The rows: it installs; the version
matches (the uninstall entry, `oddboro.exe` and the Start menu shortcut on
Windows; `Info.plist`, `codesign`, `spctl` and the stapled ticket on a Mac);
it starts with no dialog; the real window shows the welcome and Next moves it
to the name step; a write with no `Origin` gets 403 and the page's own shape
404 (#25); the setup checks pass, with a stand-in Claude Code found where an
install puts it (PR #18, CI only); it onboards; the log has the window
loading the page and the page booting, with no page errors; it quits with
Node and both ports gone; it starts twice more with its data; on Windows it
uninstalls.

`scripts/driver.ts` drives it, each system its own way: the NSIS installer
with `/S` and UI Automation on Windows (WebView2 on GitHub's runners drops
DevTools' argument), the `.dmg` copied to a resolved folder and
Accessibility through System Events on a Mac (a path through a symlink stops
the app), the AppImage under Xvfb with a GNOME keyring and WebDriver through
`tauri-driver` on Linux. A dialog fails the run with its words. A run stops
only what it started: the processes it spawned, the shells and Nodes its own
log names, and everything under them. Another Oddboro it finds fails the row
with its pid, and the run leaves it running.

```sh
node apps/desktop/scripts/smoke.ts --stage                       # the staged server, after stage.ts, with Sentry on (port 9 takes nothing)
node apps/desktop/scripts/smoke.ts --installed                    # the app on this computer, on its own port, home and log
node apps/desktop/scripts/smoke.ts --from <folder> --version 0.0.9   # a build job's output, as release.yml runs it
```

`--artifact <file>` takes one installer, AppImage or `.dmg`. On Windows it
replaces and then uninstalls the Oddboro installed for this user, so off a
runner it asks for `--replace-installed`. Quit Oddboro first: Linux and
Windows keep to one at a time. Results go to `--out`: `results.json`,
`summary.md`, `office.log`, `shell.log` and a screenshot. The run's home
goes when it ends, pass or fail; `--keep` keeps it for a look.

### Secrets

Set each as a secret of the `release` environment (the repo's Settings,
Environments, release), never as a repo secret. Only `main` may use that
environment, so a workflow run from any other branch, or a pull request, never
sees the keys. Set one with `gh secret set <NAME> -R New-Altitude/Oddboro --env
release`. Never commit a value.

| Secret                               | What it is                                                                                                                     | How to make it                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APPLE_CERTIFICATE`                  | The Developer ID Application certificate and key, as base64                                                                    | Keychain Access, export "Developer ID Application: New Altitude, Inc." as `cert.p12` with a password, then `base64 -i cert.p12 \| pbcopy`              |
| `APPLE_CERTIFICATE_PASSWORD`         | The password set on that export                                                                                                | Chosen at export                                                                                                                                       |
| `APPLE_API_KEY`                      | The App Store Connect API key, the `.p8` file's contents                                                                       | App Store Connect, Users and Access, Integrations, Team Keys, a key with Developer access. Download `AuthKey_<id>.p8`, then `pbcopy < AuthKey_<id>.p8` |
| `APPLE_API_KEY_ID`                   | That key's ID                                                                                                                  | The Key ID column on the same page                                                                                                                     |
| `APPLE_API_ISSUER`                   | The team's issuer ID                                                                                                           | The Issuer ID above the keys on the same page                                                                                                          |
| `TAURI_SIGNING_PRIVATE_KEY`          | The updater signing key, for every build                                                                                       | `pbcopy < ~/.tauri/oddboro-updater.key`                                                                                                                |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password                                                                                                                   | `security find-generic-password -s oddboro-updater-key -a password -w \| pbcopy`                                                                       |
| `KEYCHAIN_PASSWORD`                  | Any random string, for the runner's temporary keychain                                                                         | `openssl rand -hex 24 \| pbcopy`                                                                                                                       |
| `GOOGLE_OAUTH_CLIENT_SECRET`         | The Desktop OAuth client's secret for Google sign-in. Google treats it as not confidential, but it stays out of the repo       | New Altitude's password manager, "Oddboro Google OAuth client"                                                                                         |
| `OAUTH_GITHUB_CLIENT_SECRET`         | The GitHub OAuth App's secret, for servers that sign in through GitHub. It ships in the app, but stays out of the repo         | The "Oddboro" OAuth App in New Altitude's GitHub organization settings, Developer settings. GitHub refuses secret names that start with `GITHUB_`      |
| `SENTRY_AUTH_TOKEN`                  | A Sentry auth token for the project the release uploads to, which uploads the shell's debug files and the office's source maps | An organization auth token from the organization's settings in Sentry                                                                                  |

Three variables too, none of them secret: `ODDBORO_DIAGNOSTICS_DSN`, the
relay's address the app sends reports to, and `SENTRY_ORG` and
`SENTRY_PROJECT`, the Sentry organization and project the uploads go to. Set
each with `gh variable set <NAME> -R New-Altitude/Oddboro --env release`.
Without the address a release sends no reports.

### A test build

`release.ts --test` lets the app take an `http://` `ODDBORO_UPDATE_URL`. On a
Mac it signs with the Developer ID in this keychain and skips notarizing. Never
ship one.

```sh
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/oddboro-updater.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s oddboro-updater-key -a password -w)"
ODDBORO_RELEASE_URL=http://127.0.0.1:4598 \
  node apps/desktop/scripts/release.ts --version 0.0.91 --test --out /tmp/oddboro-0.0.91
```

## Icons and signing

- The icons are Oddboro's mark, the glowing pixel O, on a black rounded
  square. `npm run mark -w @oddboro/sprites` draws every one, on a Mac:
  `icon.icns`, `icon.ico` (Windows builds embed it), the PNGs, and
  `icons/tray.png`, the letter alone as a template image macOS tints. Windows
  shows `icons/32x32.png` in the tray instead. Never edit an icon by hand.
- `branding/google-oauth-logo.png` is the logo for the Google OAuth client's
  branding page: 120 by 120, as Google asks. The same script draws it.
- No `signingIdentity` in the config: `release.ts` passes the Developer ID
  as `APPLE_SIGNING_IDENTITY`.

## Commands

Run from the repo root.

```sh
npm run shell -w @oddboro/desktop     # tauri dev against ODDBORO_SERVER_URL, default http://127.0.0.1:4500
npm run bundle -w @oddboro/desktop    # tauri build for this machine: the .app and .dmg, the AppImage, or the installer
npm run check-types -w @oddboro/desktop   # cargo check
npm run lint -w @oddboro/desktop      # cargo clippy -D warnings, cargo fmt --check, prettier
```

`npm run bundle` writes to `src-tauri/target/release/bundle/`.

To build on Linux, install Rust and the libraries Tauri builds against first.
On Fedora:

```sh
sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel gcc gcc-c++ patchelf
```

The AppImage bundles the GStreamer plugins installed on the build machine.
Its bundler looks in Debian's folders, so on Fedora name them before
`npm run bundle` (`release.ts` does this by itself):

```sh
export GSTREAMER_PLUGINS_DIR=/usr/lib64/gstreamer-1.0 GSTREAMER_HELPERS_DIR=/usr/libexec/gstreamer-1.0
```

`shell` and `bundle` are not named `dev` and `build`, so the root
`npm run dev` and `npm run build` never start a Rust build or a window.
Bundling needs `stage/` and the Node binary first.

A debug binary (`cargo build` in `src-tauri/`) has no bundle. It falls back
to `src-tauri/binaries/node-<target>` and `stage/`. On a Mac its error
dialogs never show: without a parent window they go through
`CFUserNotification`, which needs a bundle. To run it beside the owner's
office:

```sh
ODDBORO_PORT=4510 ODDBORO_DB_PORT=54510 ODDBORO_HOME=/tmp/oddboro-test-home \
  src-tauri/target/debug/oddboro
```

## Later

Each line says what to do when its trigger comes.

- Building NEW-1673: add a smoke test to the release that starts the built
  app and makes one call of each HTTP method its office answers. A built
  app's server can refuse what the dev server allows: in a release,
  SvelteKit's origin check refuses any action from the owner's own page that
  is not sent as JSON (`apps/office/CLAUDE.md`, "Who the office answers").

## Pinned versions

- `@tauri-apps/cli` 2.12.4, and the npm `sentry` CLI 0.45.0, for the
  release's debug files
- `tauri` 2.12.5, `tauri-build` 2.7.4
- `tauri-plugin-autostart` 2.7.0, `tauri-plugin-dialog` 2.8.4
- `tauri-plugin-updater` 2.14.1, `serde_json` 1.0.154
- `getrandom` 0.3.4, for the update token
- `sentry` 0.49.5, and `rustls` 0.23.46 with `ring`, for error reports
- `reqwest` 0.13.5, the client sentry sends with, named so a report can
  carry the sign-in's token
- `libc` 0.2.191 (Mac and Linux)
- `mac-notification-sys` 0.6.15 (Mac only)
- `security-framework` 3.7.0 (Mac only), for the Keychain
- `tauri-plugin-single-instance` 2.5.3 (Linux and Windows)
- `zbus` 5.19.0 (Linux only; the plugin brings the same zbus)
- `windows-sys` 0.61.2, `tauri-winrt-notification` 0.8.1 (Windows only)
