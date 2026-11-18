// The installed app, driven from outside: install a built Oddboro, start it
// on a port, home and log of its own, wait for it, read and press its real
// window, quit it. smoke.ts runs its checks with this. Nothing here ships.
//
// Each system's own way in, proved on GitHub's runners (plan Phase 0):
// - Windows: the NSIS installer with /S, then UI Automation, which reads the
//   WebView2 page and presses its buttons as a screen reader does.
// - Mac: the .dmg copied out, then Accessibility through System Events.
// - Linux: the AppImage, then WebDriver through tauri-driver.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const WIN = process.platform === 'win32';
export const MAC = process.platform === 'darwin';
export const LINUX = process.platform === 'linux';
export const PORT = 4590;
/** The office's database port, which only Windows uses: a Mac and Linux reach it through a socket in the home. */
export const DB_PORT = 54590;
export const BASE = `http://127.0.0.1:${PORT}`;
// A release build installs any newer version before its server starts. An
// update address that refuses at once keeps a run on the build it tests.
const NO_UPDATES = 'https://127.0.0.1:9/latest.json';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a program and gives back its output, failure or not. */
export function sh(cmd: string, args: string[], timeout = 60_000): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export function run(cmd: string, args: string[], timeout = 300_000): string {
  const r = sh(cmd, args, timeout);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.code}: ${r.out}`);
  return r.out;
}

/** Takes seconds on the arm64 Windows runner: never in a loop that times something. */
export const ps = (script: string) =>
  execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();

const quoted = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function tcp(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port });
    s.setTimeout(500, () => {
      s.destroy();
      done(false);
    });
    s.once('connect', () => {
      s.destroy();
      done(true);
    });
    s.once('error', () => done(false));
  });
}

export async function until<T>(
  what: string,
  f: () => Promise<T | undefined>,
  secs: number
): Promise<T> {
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    const value = await f().catch(() => undefined);
    if (value !== undefined) return value;
    await sleep(500);
  }
  throw new Error(`no ${what} within ${secs} s`);
}

/** A GET with no key, as any other program on the computer would send it. */
export async function getJson<T>(path: string, secs = 20): Promise<T> {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(secs * 1000) });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return (await r.json()) as T;
}

/** A request with no key unless `headers` carries one. */
export async function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  secs = 20
): Promise<{ status: number; text: string }> {
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(secs * 1000)
  });
  return { status: r.status, text: (await r.text()).slice(0, 200) };
}

/**
 * How a check asks the office for what only the app may ask. The office in
 * the app answers only requests with the app's key, which the real app's
 * shell keeps to itself.
 */
export type Office = {
  getJson<T>(path: string, secs?: number): Promise<T>;
  send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
    secs?: number
  ): Promise<{ status: number; text: string }>;
};

/** The first line a run writes on the staged server's stdin, as the shell does. */
export const keyLine = (key: string): string => `oddboro:key ${key}\n`;

/** Over HTTP, with the key a run gave the staged server, as the app's window carries it. */
export function withKey(key: string): Office {
  const cookie = { cookie: `oddboro-key=${key}` };
  return {
    async getJson<T>(path: string, secs = 20) {
      const r = await fetch(BASE + path, {
        headers: cookie,
        signal: AbortSignal.timeout(secs * 1000)
      });
      if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
      return (await r.json()) as T;
    },
    send: (method, path, headers, body, secs) =>
      send(method, path, { ...headers, ...cookie }, body, secs)
  };
}

/**
 * From inside the real app's page (Linux, through WebDriver), which carries
 * the window's own key. The page's browser adds its own Origin and
 * Sec-Fetch-Site, whatever `headers` says.
 */
export function inPage(script: Driven['script']): Office {
  const ask = async (method: string, path: string, body?: unknown) => {
    const r = await script(
      `const r = await fetch(arguments[0], { method: arguments[1], headers: { 'content-type': 'application/json' }, body: arguments[2] ?? undefined }); return { status: r.status, text: await r.text() };`,
      [path, method, body === undefined ? null : JSON.stringify(body)]
    );
    if (typeof r !== 'object' || r === null) throw new Error(`${method} ${path}: ${String(r)}`);
    return r as { status: number; text: string };
  };
  return {
    async getJson<T>(path: string) {
      const r = await ask('GET', path);
      if (r.status !== 200) throw new Error(`GET ${path}: ${r.status}`);
      return JSON.parse(r.text) as T;
    },
    send: async (method, path, _headers, body) => {
      const r = await ask(method, path, body);
      return { status: r.status, text: r.text.slice(0, 200) };
    }
  };
}

/** What the office's own page sends with a write. WebKit before macOS 13.3 sends no Sec-Fetch-Site. */
export const pageHeaders = (secFetchSite: boolean): Record<string, string> => ({
  origin: BASE,
  'content-type': 'application/json',
  ...(secFetchSite ? { 'sec-fetch-site': 'same-origin' } : {})
});

/** Where a build without ODDBORO_LOG writes (0.0.8 and older). */
export function defaultLogFile(): string {
  if (WIN) return join(process.env.LOCALAPPDATA ?? '', 'Oddboro', 'Logs', 'office.log');
  if (MAC) return join(homedir(), 'Library', 'Logs', 'Oddboro', 'office.log');
  const state = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(state, 'oddboro', 'office.log');
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pids in `tasklist /fo csv /nh` output. */
export function parseTasklist(out: string): number[] {
  return out
    .split('\n')
    .map((l) => Number(l.split('","')[1]))
    .filter((pid) => pid > 0);
}

/**
 * The shells in `ps -eo pid=,args=` or `pid=,comm=` output. Only the program
 * a process runs counts, never its arguments: smoke.ts's own `--artifact`
 * names the AppImage.
 */
export function shellsIn(out: string, self: number): number[] {
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(
      ([pid, program]) => Number(pid) !== self && /((^|\/)oddboro|\.AppImage)$/.test(program ?? '')
    )
    .map(([pid]) => Number(pid));
}

/**
 * By command line and by program name: started through WebDriver, the
 * AppImage's shell can carry a command line that names neither, and a shell
 * left running keeps the next launch from starting (one Oddboro at a time).
 */
export function shellPids(): number[] {
  if (WIN)
    return parseTasklist(
      sh('tasklist', ['/FI', 'IMAGENAME eq oddboro.exe', '/FO', 'CSV', '/NH']).out
    );
  const found = ['pid=,args=', 'pid=,comm='].flatMap((columns) =>
    shellsIn(sh('ps', ['-eo', columns]).out, process.pid)
  );
  return [...new Set(found)];
}

function officeNodes(): number[] {
  if (WIN)
    return ps(
      `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'office.build.index\\.js' }).ProcessId -join ' '`
    )
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  return sh('ps', ['-eo', 'pid=,args='])
    .out.split('\n')
    .filter((l) => l.includes('apps/office/build/index.js'))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

/**
 * The pids a shell's own log names: each shell's "opening: pid N" and each
 * Node's "started node, pid N", on the shell's own `oddboro:` lines only, so
 * a page's error line can never name one.
 */
export function loggedPids(log: string): number[] {
  return [...log.matchAll(/^oddboro: .*?(?:opening: pid|started node, pid) (\d+)/gm)].map((m) =>
    Number(m[1])
  );
}

/** The processes under `roots`, from `pid ppid` lines. */
export function descendantsIn(out: string, roots: number[]): number[] {
  const rows = out.split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const found = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of rows)
      if (pid > 0 && found.has(parent) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
  }
  return [...found].filter((pid) => !roots.includes(pid));
}

/**
 * What this run started and is still running: what it spawned, the pids its
 * own log names (never the owner's log), and every process under those.
 * Each is kept once found, so a Node whose shell quit first still counts. A
 * pid seen gone is dropped for good, so a pid the system hands out again is
 * never this run's. Windows lists no children: `taskkill /T` takes the tree.
 */
export function runPids(r: Run): number[] {
  const log = existsSync(r.log) ? readFileSync(r.log, 'utf8') : '';
  for (const pid of loggedPids(log)) if (!r.gone.has(pid)) r.pids.add(pid);
  if (!WIN)
    for (const pid of descendantsIn(sh('ps', ['-eo', 'pid=,ppid=']).out, [...r.pids]))
      r.pids.add(pid);
  for (const pid of r.pids)
    if (!alive(pid)) {
      r.pids.delete(pid);
      r.gone.add(pid);
    }
  return [...r.pids];
}

/** Stops what this run started, and nothing else. */
function killRun(r: Run): void {
  for (const pid of runPids(r)) {
    if (WIN) sh('taskkill', ['/F', '/T', '/PID', String(pid)]);
    else sh('kill', ['-9', String(pid)]);
  }
}

/** Oddboro shells and office servers this run did not start. The run never stops them. */
function strays(r: Run): number[] {
  const ours = new Set(runPids(r));
  return [...new Set([...shellPids(), ...officeNodes()])].filter((pid) => !ours.has(pid));
}

/**
 * The words of a dialog the shell shows. They block until someone presses OK.
 * Windows: a message box (#32770) of the shell's. Mac: a dialog with no parent
 * window goes through CFUserNotification, which UserNotificationCenter shows.
 */
export function dialogText(pid: number): string {
  try {
    if (WIN)
      return ps(
        `Add-Type -AssemblyName UIAutomationClient; $A=[Windows.Automation.AutomationElement]; ` +
          `$c=New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid}); ` +
          `@($A::RootElement.FindAll('Children',$c) | Where-Object { $_.Current.ClassName -eq '#32770' } | ForEach-Object { ` +
          `(@($_.FindAll('Descendants',[Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join ' ') }) -join ' / '`
      );
    if (MAC)
      return sh(
        'osascript',
        [
          '-e',
          'tell application "System Events" to if exists process "UserNotificationCenter" then get value of every static text of every window of process "UserNotificationCenter"'
        ],
        20_000
      ).out;
  } catch {
    // No dialog to read.
  }
  return '';
}

export type Installed = { exe: string; dir: string; uninstall?: () => Promise<string> };

/**
 * Windows: the per-user NSIS installer, silent. Its path goes in resolved,
 * with backslashes: Tauri's installer reads its options from the whole
 * command line, its own path included, so `.../release/bundle/nsis/...` reads
 * as /R (open the app when done) and /NS (no shortcuts).
 */
export async function installWindows(file: string): Promise<Installed> {
  const before = new Set(shellPids());
  run(resolve(file), ['/S']);
  const dir = join(process.env.LOCALAPPDATA ?? '', 'Oddboro');
  const exe = join(dir, 'oddboro.exe');
  if (!existsSync(exe)) throw new Error(`${exe} is not there after the install`);
  await sleep(3000);
  // Only a shell the install opened, with its Node and WebView2 under it.
  const opened = shellPids().filter((pid) => !before.has(pid));
  if (opened.length) {
    for (const pid of opened) sh('taskkill', ['/F', '/T', '/PID', String(pid)]);
    throw new Error(`the silent install opened Oddboro (${opened.join(', ')}); closed it`);
  }
  const uninstall = async () => {
    sh(join(dir, 'uninstall.exe'), ['/S']);
    await until('the app removed', async () => (!existsSync(exe) ? true : undefined), 90);
    await until(
      'its uninstall entry removed',
      async () => (uninstallEntry() ? undefined : true),
      60
    );
    return `${exe} and its uninstall entry are gone`;
  };
  return { exe, dir, uninstall };
}

/** Windows: the version the uninstall entry names, or '' when there is none. */
export function uninstallEntry(): string {
  return ps(
    `@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object DisplayName -eq 'Oddboro').DisplayVersion -join ','`
  );
}

export function fileVersion(file: string): string {
  return ps(`(Get-Item -LiteralPath ${quoted(file)}).VersionInfo.ProductVersion`);
}

/**
 * Mac: the app copied out of the .dmg. The folder is resolved first: under a
 * symlink (/var is one) the app does not start (plan, finding 2).
 */
export function installMac(file: string): Installed {
  const mount = mkdtempSync(join(tmpdir(), 'oddboro-dmg-'));
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file]);
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'oddboro-app-'))), 'Oddboro.app');
  try {
    run('ditto', [join(mount, 'Oddboro.app'), dir]);
  } finally {
    sh('hdiutil', ['detach', mount]);
  }
  return { exe: join(dir, 'Contents', 'MacOS', plist(dir, 'CFBundleExecutable')), dir };
}

export function plist(app: string, key: string): string {
  return run('plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]);
}

export function installLinux(file: string): Installed {
  chmodSync(file, 0o755);
  return { exe: file, dir: file };
}

/** One run's own corner: home, log and WebView2 profile, beside its other output. */
export type Run = {
  out: string;
  home: string;
  log: string;
  env: Record<string, string>;
  /** What this run started, as `runPids` finds it. */
  pids: Set<number>;
  /** Pids seen gone, never counted again. */
  gone: Set<number>;
};

export function makeRun(out: string): Run {
  mkdirSync(out, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'oddboro-smoke-home-'));
  const log = join(out, 'office.log');
  const env: Record<string, string> = {
    ODDBORO_PORT: String(PORT),
    ODDBORO_DB_PORT: String(DB_PORT),
    ODDBORO_HOME: home,
    ODDBORO_LOG: log,
    ODDBORO_UPDATE_URL: NO_UPDATES
  };
  // WebView2 joins a browser already running on the same profile, so a run
  // never shares the owner's.
  if (WIN) env.WEBVIEW2_USER_DATA_FOLDER = mkdtempSync(join(tmpdir(), 'oddboro-smoke-webview-'));
  return { out, home, log, env, pids: new Set(), gone: new Set() };
}

/** The log the shell writes: the run's own, or for a build without ODDBORO_LOG, the usual one. */
export function logText(r: Run): string {
  const file = existsSync(r.log) ? r.log : defaultLogFile();
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function logTail(r: Run, lines = 12): string {
  return logText(r).trimEnd().split('\n').slice(-lines).join(' / ') || '(no log)';
}

/** The shell's own output goes to shell.log: the AppImage's launcher prints its errors there. */
export function launch(exe: string, r: Run): ChildProcess {
  const file = join(r.out, 'shell.log');
  appendFileSync(file, `--- launch at ${new Date().toISOString()}\n`);
  const fd = openSync(file, 'a');
  const app = spawn(exe, [], { env: { ...process.env, ...r.env }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  if (app.pid) r.pids.add(app.pid);
  return app;
}

/**
 * Waits for the office to answer, as the shell does: any answer at all, since
 * without the app's key it is a refusal. A dialog or the shell quitting fails it.
 * Windows looks for a dialog only after 30 s, then every 15 s: one look takes
 * seconds on the arm64 runner and would blur a normal start's time.
 */
export async function ready(app: ChildProcess, r: Run, secs = 120): Promise<number> {
  const started = Date.now();
  let lookForDialog = 30_000;
  while (Date.now() - started < secs * 1000) {
    const answered = await fetch(`${BASE}/api/update`, { signal: AbortSignal.timeout(2000) }).then(
      () => true,
      () => false
    );
    if (answered) return Date.now() - started;
    // The AppImage's launcher may hand off and exit 0, so only a failing exit counts there.
    if (app.exitCode !== null && (!LINUX || app.exitCode !== 0))
      throw new Error(
        `the shell exited ${app.exitCode} before the office answered. Log: ${logTail(r)}`
      );
    if (Date.now() - started > lookForDialog) {
      lookForDialog += 15_000;
      const text = dialogText(app.pid ?? 0);
      if (text) throw new Error(`the shell shows a dialog: ${text}`);
    }
    await sleep(500);
  }
  throw new Error(
    `no answer within ${secs} s. Dialog: ${dialogText(app.pid ?? 0) || 'none'}. Shells: ${shellPids().join(', ') || 'none'}. Log: ${logTail(r)}`
  );
}

async function allGone(r: Run): Promise<boolean> {
  return !(await tcp(PORT)) && !(await tcp(DB_PORT)) && !runPids(r).length;
}

/** What this run started gone, and both ports closed, within `secs`. */
export const goneWithin = (r: Run, secs: number): Promise<boolean> =>
  until('a quit', async () => ((await allGone(r)) ? true : undefined), secs).then(
    () => true,
    () => false
  );

export const leftRunning = async (r: Run): Promise<string> =>
  `port ${PORT} open: ${await tcp(PORT)}, port ${DB_PORT} open: ${await tcp(DB_PORT)}, this run's processes: ${runPids(r).join(', ') || 'none'}`;

/**
 * Fails when an Oddboro this run did not start is running: the next launch
 * would hand off to it. The run names it and leaves it alone.
 */
function noStrays(r: Run): void {
  const found = strays(r);
  if (found.length)
    throw new Error(
      `an Oddboro this run did not start is running (pid ${found.join(', ')}). The run left it alone. Quit it, then run again`
    );
}

/**
 * After a quit that did not finish in time: stops what this run started, and
 * says what it found. Anything else is named, never stopped.
 */
async function stopRun(r: Run, what: string): Promise<string> {
  const left = await leftRunning(r);
  killRun(r);
  if (!(await goneWithin(r, 10)))
    throw new Error(`still running after ${what} and a kill: ${await leftRunning(r)}`);
  noStrays(r);
  return left;
}

/**
 * Mac and Linux: SIGTERM, the shell's normal quit. Windows has no signal a
 * script can send, so a kill, which closes Node's stdin and so stops it.
 */
export async function quit(app: ChildProcess, r: Run): Promise<number> {
  const started = Date.now();
  // Everything under the shell, noted while it still has its parent.
  runPids(r);
  if (WIN) app.kill();
  else app.kill('SIGTERM');
  if (await goneWithin(r, 15)) {
    // Timed before the look for strays, which takes seconds on Windows.
    const ms = Date.now() - started;
    noStrays(r);
    return ms;
  }
  const left = await stopRun(r, 'the quit');
  throw new Error(`still running 15 s after the quit (${left}); stopped what this run started`);
}

/** The real window, from outside: its text and buttons, and a press by a button's name. */
export type Page = {
  read(): Promise<string>;
  press(name: string): Promise<void>;
};

/**
 * Windows: the WebView2 page through UI Automation. Chromium builds its
 * accessibility tree once a client asks, so the first read warms it.
 */
export function automationPage(pid: number): Page {
  const windows = `Add-Type -AssemblyName UIAutomationClient; $A=[Windows.Automation.AutomationElement]; $wins=@($A::RootElement.FindAll('Children',(New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})))); `;
  const view = () =>
    ps(
      windows +
        `$doc=$null; foreach ($w in $wins) { $d=$w.FindFirst('Descendants',(New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Document))); if ($d) { $doc=$d; break } }; ` +
        `if (-not $doc) { 'no page' } else { $doc.Current.Name + ' || ' + (@($doc.FindAll('Descendants',[Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -First 60) -join ' | ') }`
    );
  let warm = false;
  return {
    async read() {
      if (!warm) {
        view();
        await sleep(3000);
        warm = true;
      }
      return view();
    },
    async press(name) {
      const done = ps(
        windows +
          `$c=New-Object Windows.Automation.AndCondition((New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Button)), (New-Object Windows.Automation.PropertyCondition($A::NameProperty, ${quoted(name)}))); ` +
          `$b=$null; foreach ($w in $wins) { $b=$w.FindFirst('Descendants',$c); if ($b) { break } }; ` +
          `if (-not $b) { 'missing' } elseif (-not $b.Current.IsEnabled) { 'disabled' } else { $b.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); 'pressed' }`
      );
      if (done === 'disabled') throw new Error(`${name} is disabled`);
      if (done !== 'pressed') throw new Error(`no button named ${name} in the page`);
    }
  };
}

/**
 * Mac: the WKWebView page through Accessibility. The elements are listed once
 * and the list walked: walking `entire contents` directly resolves each one
 * afresh, and every name comes back empty. Delimiters are set outside the
 * tell block, where they would go to the app.
 */
export function accessibilityPage(pid: number): Page {
  const osa = (script: string) => sh('osascript', ['-e', script], 90_000);
  return {
    async read() {
      const r = osa(`set out to {}
tell application "System Events" to tell (first process whose unix id is ${pid})
  set els to entire contents of window 1
  repeat with e in els
    try
      set r to role of e
      if r is "AXStaticText" then set end of out to (value of e as text)
      if r is "AXButton" then set end of out to ("[" & (name of e as text) & "]")
    end try
  end repeat
end tell
set AppleScript's text item delimiters to " | "
return out as text`);
      if (r.code !== 0) throw new Error(`System Events: ${r.out}`);
      return r.out;
    },
    async press(name) {
      const r =
        osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
  set els to entire contents of window 1
  repeat with e in els
    try
      if role of e is "AXButton" then
        set {n1, d1} to {"", ""}
        try
          set n1 to name of e as text
        end try
        try
          set d1 to description of e as text
        end try
        if n1 is "${name}" or d1 is "${name}" then
          perform action "AXPress" of e
          return "pressed"
        end if
      end if
    end try
  end repeat
end tell
return "missing"`);
      if (r.out !== 'pressed') throw new Error(`no button named ${name} in the page (${r.out})`);
    }
  };
}

/** Linux: a run through tauri-driver, which starts the app itself. */
export type Driven = {
  page: Page;
  /** Runs a script in the page and gives back what it returns. */
  script(body: string, args?: unknown[]): Promise<unknown>;
  /** Ends the session and the app, and says how; throws if anything is left running. */
  stop(): Promise<string>;
};

/**
 * The WebDriver session starts on the loading window, which closes once the
 * office answers. The office window then shows up as a new handle to switch to.
 */
export async function webdriverStart(exe: string, r: Run): Promise<Driven> {
  const driver = spawn('tauri-driver', ['--port', '4444'], {
    env: { ...process.env, ...r.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let driverLog = '';
  driver.stdout?.on('data', (d) => (driverLog += d));
  driver.stderr?.on('data', (d) => (driverLog += d));
  const wd = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:4444${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000)
    });
    return ((await res.json()) as { value: unknown }).value;
  };
  let session = '';
  if (driver.pid) r.pids.add(driver.pid);
  const stop = async (): Promise<string> => {
    // Everything under tauri-driver, noted while it still has its parent.
    runPids(r);
    if (session) await wd('DELETE', `/session/${session}`).catch(() => undefined);
    driver.kill();
    try {
      if (await goneWithin(r, 10)) {
        noStrays(r);
        return 'closed with the WebDriver session';
      }
      return `killed: the session left it running (${await stopRun(r, 'the session')})`;
    } finally {
      writeFileSync(join(r.out, 'tauri-driver.log'), driverLog);
    }
  };
  try {
    await until('tauri-driver', async () => ((await wd('GET', '/status')) ? true : undefined), 30);
    const created = (await wd('POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application: exe } } }
    })) as { sessionId?: string };
    if (!created.sessionId)
      throw new Error(`tauri-driver made no session: ${JSON.stringify(created)}`);
    session = created.sessionId;
    await until(
      'the office window',
      async () => {
        const url = JSON.stringify(await wd('GET', `/session/${session}/url`));
        if (url.includes(BASE)) return true;
        if (url.includes('no such window')) {
          const handles = (await wd('GET', `/session/${session}/window/handles`)) as string[];
          if (handles.length)
            await wd('POST', `/session/${session}/window`, { handle: handles.at(-1) });
        }
        return undefined;
      },
      120
    );
  } catch (e) {
    await stop().catch(() => undefined);
    throw e;
  }
  // Values go in as WebDriver arguments, never inside the code.
  const script = (body: string, args: unknown[] = []) =>
    wd('POST', `/session/${session}/execute/async`, {
      script: `const done = arguments[arguments.length - 1]; Promise.resolve((async () => { ${body} })()).then(done, (e) => done(String(e)));`,
      args
    });
  const page: Page = {
    async read() {
      return String(
        await script(
          `return document.title + ' || ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 3000);`
        )
      );
    },
    async press(name) {
      const found = await script(
        `const name = arguments[0]; const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === name || x.getAttribute('aria-label') === name); if (!b) return 'missing'; b.click(); return 'pressed';`,
        [name]
      );
      if (found !== 'pressed') throw new Error(`no button named ${name} in the page`);
    }
  };
  return { page, script, stop };
}

/** A picture of the whole screen. */
export function screenshot(file: string): string {
  if (MAC) run('screencapture', ['-x', file]);
  else if (LINUX) run('import', ['-window', 'root', file]);
  else
    ps(
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
        `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save(${quoted(file)})`
    );
  return `${readFileSync(file).length} bytes`;
}

/**
 * A stand-in Claude Code where an installed one would be: in npm's layout on
 * Windows (a .cmd shim beside node_modules, PR #18's case), a script in
 * ~/.local/bin elsewhere. It answers --version and auth status, nothing more.
 * Only on a CI runner: on a developer's computer it would shadow their own.
 */
export function stubClaude(): string {
  const bin = join(homedir(), '.local', 'bin');
  const answers = `const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('9.9.9 (Claude Code)');
else if (a === 'auth status') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
else { console.error('smoke stand-in: ' + a); process.exit(1); }
`;
  if (WIN) {
    const pkg = join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
    writeFileSync(join(pkg, 'cli.js'), answers);
    writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\n');
    return join(bin, 'claude.cmd');
  }
  // This script's own Node, by its full path: the app's PATH comes from the
  // login shell, which may not hold the runner's.
  mkdirSync(bin, { recursive: true });
  const js = join(bin, 'claude-stand-in.js');
  writeFileSync(js, answers);
  const file = join(bin, 'claude');
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(file, `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(js)} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}
