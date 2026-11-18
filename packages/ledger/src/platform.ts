// What differs between operating systems, in one place: where logs go, how a
// page or a file opens, how a login service runs, and the environment a host
// program gets inside an AppImage. Each system gets one entry in the tables
// below. A Mac uses launchd and ~/Library/Logs, Linux a systemd user unit and
// the XDG state folder, and Windows a Task Scheduler task and
// %LOCALAPPDATA%\Oddboro. Everything else in the office is the same code on
// each.
import { execFile, execFileSync, spawn, type ExecFileException } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type System = 'mac' | 'linux' | 'windows';

/**
 * The system the office runs on, read at each call. Every other file asks this
 * instead of reading `process.platform` (scripts/check-platform.ts), so a test
 * that fakes the system reaches every reader. The constants below are fixed
 * when this file loads.
 */
export const currentPlatform = (): NodeJS.Platform => process.platform;

const SYSTEMS: Partial<Record<NodeJS.Platform, System>> = {
  darwin: 'mac',
  linux: 'linux',
  win32: 'windows'
};
/** The system the office runs on, read at each call, or undefined for one it does not know. */
export const currentSystem = (): System | undefined => SYSTEMS[currentPlatform()];

/** The system the office runs on, as it was when this file loaded. */
export const SYSTEM = currentSystem();
export const MAC = SYSTEM === 'mac';
export const LINUX = SYSTEM === 'linux';
export const WINDOWS = SYSTEM === 'windows';

/**
 * Names an AppImage runtime may have used to keep a variable from before it
 * started. The long name is the usual one. The short name is the other
 * spelling. The first that is set wins, and an empty value means it was unset.
 */
const SAVED_LIBRARY_PATH = ['APPIMAGE_ORIGINAL_LD_LIBRARY_PATH', 'APPIMAGE_ORIG_LD_LIBRARY_PATH'];
const SAVED_PRELOAD = ['APPIMAGE_ORIGINAL_LD_PRELOAD', 'APPIMAGE_ORIG_LD_PRELOAD'];

/**
 * The environment for a program that ships with the computer, such as
 * notify-send, xdg-open, secret-tool or zenity. Outside an AppImage this is
 * `base` itself. Inside one, the runtime points LD_LIBRARY_PATH at the glib
 * it bundled, which is older than the host's, so those programs fail to
 * start. This puts back the values from before the AppImage started, or
 * removes them, and takes the AppImage's own folders off PATH.
 */
export function hostEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!base.APPIMAGE && !base.APPDIR) return base;
  const env: NodeJS.ProcessEnv = { ...base };
  restoreOrClear(env, 'LD_LIBRARY_PATH', SAVED_LIBRARY_PATH);
  restoreOrClear(env, 'LD_PRELOAD', SAVED_PRELOAD);
  if (base.APPDIR && env.PATH) env.PATH = withoutAppDir(env.PATH, base.APPDIR);
  return env;
}

function restoreOrClear(
  env: NodeJS.ProcessEnv,
  key: 'LD_LIBRARY_PATH' | 'LD_PRELOAD',
  names: readonly string[]
) {
  let found = false;
  let value: string | undefined;
  for (const name of names) {
    if (!Object.hasOwn(env, name)) continue;
    found = true;
    value = env[name];
    break;
  }
  if (found && value) env[key] = value;
  else delete env[key];
}

/** A path without its trailing slashes. A loop, since a regex here is slow on a long run of them. */
function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/** PATH with every entry inside the AppImage mount taken out. */
function withoutAppDir(path: string, appdir: string): string {
  const root = trimSlashes(appdir);
  if (!root) return path;
  return path
    .split(delimiter)
    .filter((entry) => {
      const dir = trimSlashes(entry);
      return dir !== root && !dir.startsWith(`${root}/`);
    })
    .join(delimiter);
}

/**
 * Where the office's logs go. XDG_STATE_HOME wins wherever it is set;
 * otherwise each system's own place for them.
 */
export const LOGS = process.env.XDG_STATE_HOME
  ? join(process.env.XDG_STATE_HOME, 'oddboro')
  : MAC
    ? join(homedir(), 'Library', 'Logs')
    : WINDOWS
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Oddboro', 'Logs')
      : join(homedir(), '.local', 'state', 'oddboro');

/** The office service's log. */
export const OFFICE_LOG = join(
  LOGS,
  MAC && !process.env.XDG_STATE_HOME ? 'oddboro-office.log' : 'office.log'
);

/**
 * How a one-shot command came back. `missing` means it could not start: it is
 * not there (ENOENT), may not run (EACCES), or is not a program this system
 * can run (ENOEXEC). It carries no text, so no caller can show a raw error or
 * take "not there" for an empty answer.
 */
export type Probe =
  | { status: 'ok'; out: string; err: string }
  | { status: 'failed'; code: number | null; out: string; err: string }
  | { status: 'missing' }
  | { status: 'timeout' };

/**
 * Run a command to its end and say how it went, with what it printed. No
 * shell, and no time limit unless `timeout` (in ms) gives one. On Windows no
 * window either, unless `showWindow`: some commands open a window the owner
 * must see, such as the browser or a dialog asking them to confirm, and
 * hiding the command can hide that window too. `input` goes to the command's
 * stdin. stdin then closes, given input or not, so a command that reads to
 * the end never waits.
 * Text passed this way stays out of the process list. `killSignal` is what
 * stops a command at its timeout, SIGTERM unless given: a command that
 * ignores SIGTERM runs on, and its caller waits, until it ends by itself.
 */
export function probe(
  cmd: string,
  args: readonly string[],
  o: {
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    showWindow?: true;
    input?: string;
    maxBuffer?: number;
    killSignal?: NodeJS.Signals;
  } = {}
): Promise<Probe> {
  const { showWindow, input, ...options } = o;
  return new Promise((done) => {
    try {
      const child = execFile(
        cmd,
        args,
        {
          ...options,
          env: hostEnv(options.env ?? process.env),
          encoding: 'utf8',
          ...(showWindow ? {} : { windowsHide: true })
        },
        (e, out, err) => done(e ? ended(e, out, err) : { status: 'ok', out, err })
      );
      // stdin always closes, with or without input, so a command that reads
      // it sees the end at once. execFile ignores a `stdio` option, so ending
      // its pipe is the only way. A command can exit before it reads, such as
      // one with no sign-in. The pipe then fails, and the callback above
      // already says how it ended.
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    } catch (e) {
      // A file this system cannot run (ENOEXEC) throws here rather than in the
      // callback. Anything else thrown here is a wrong argument, so it rejects.
      if (!couldNotStart(e)) throw e;
      done({ status: 'missing' });
    }
  });
}

/** Whether an error is the command failing to start, thrown or passed to the callback. */
const couldNotStart = (e: unknown) =>
  e instanceof Error && 'syscall' in e && String(e.syscall).startsWith('spawn');

function ended(e: ExecFileException, out: string, err: string): Probe {
  // execFile marks the error killed only when its own timer stopped the command.
  if (e.killed) return { status: 'timeout' };
  if (couldNotStart(e)) return { status: 'missing' };
  return { status: 'failed', code: typeof e.code === 'number' ? e.code : null, out, err };
}

const run = async (cmd: string, args: string[]) => (await probe(cmd, args)).status === 'ok';

/**
 * Whether `pid` exited and waits for its parent to reap it, which
 * `process.kill(pid, 0)` still finds. ps says so on a Mac and Linux. Windows
 * has no ps and no such wait, so there it never does. False when ps fails.
 */
export function waitsToBeReaped(pid: number): boolean {
  if (currentPlatform() === 'win32') return false;
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z');
  } catch {
    return false;
  }
}

// Windows PowerShell 5.1 ships with every Windows, so the office reaches the
// Credential Manager, toasts and Task Scheduler through it with nothing to
// install. Values go in as environment variables, never pasted into the
// script, so nothing a caller passes needs quoting. Output is UTF-8 both ways.
const POWERSHELL = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const psScript = (script: string) =>
  '$ErrorActionPreference = "Stop"; [Console]::InputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
  script;

/** Run a PowerShell script and return what it prints. Throws when it fails. */
export function powershellSync(script: string, env: Record<string, string> = {}, input?: string) {
  return execFileSync('powershell.exe', [...POWERSHELL, '-Command', psScript(script)], {
    encoding: 'utf8',
    env: { ...hostEnv(), ...env },
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
}

/** Run a PowerShell script and say how it went, with what it printed. */
export function powershell(script: string, env: Record<string, string> = {}): Promise<Probe> {
  return probe('powershell.exe', [...POWERSHELL, '-Command', psScript(script)], {
    env: { ...process.env, ...env },
    timeout: 120_000
  });
}

/** Whether a PowerShell script succeeded. */
async function ps(script: string, env: Record<string, string> = {}): Promise<boolean> {
  const r = await powershell(script, env);
  switch (r.status) {
    case 'ok':
      return true;
    case 'failed':
    case 'missing':
    case 'timeout':
      return false;
    default: {
      const missed: never = r;
      throw new Error(`PowerShell came back as ${JSON.stringify(missed)}`);
    }
  }
}

/**
 * Each system's opener: the program, then any words it needs before what it
 * opens. Windows goes through rundll32, not `cmd /c start`, so the & in a
 * query string is not read as a command. A system the office does not know
 * tries xdg-open.
 */
const OPENER: Record<System, [string, ...string[]]> = {
  mac: ['open'],
  linux: ['xdg-open'],
  windows: ['rundll32', 'url.dll,FileProtocolHandler']
};
const [OPEN, ...OPEN_WORDS] = OPENER[SYSTEM ?? 'linux'];

/**
 * Open a URL in the owner's browser, and say whether the opener took it. Its
 * window shows: on Windows a hidden one would pass through rundll32 to the
 * program the URL opens, which could then open hidden.
 */
export async function openUrl(url: string): Promise<boolean> {
  const r = await probe(OPEN, [...OPEN_WORDS, url], { showWindow: true });
  switch (r.status) {
    case 'ok':
      return true;
    case 'failed':
    case 'missing':
    case 'timeout':
      return false;
    default: {
      const missed: never = r;
      throw new Error(`The opener came back as ${JSON.stringify(missed)}`);
    }
  }
}

/**
 * How long an opener has to fail before the office takes it as working. `open`
 * hands the file on and exits at once, but `xdg-open` may stay up as long as
 * the browser does, so the office never waits for it to end.
 */
export const OPENER_FAILS_WITHIN_MS = 1_000;

/**
 * Open a file on this computer in the program the system picks for it, such
 * as the browser for a page. The opener runs on its own, with no shell, and
 * the office never waits on what it opens: this resolves true once the opener
 * exits cleanly or is still up after `OPENER_FAILS_WITHIN_MS`, and false when
 * it could not start or exited with an error in that time.
 */
export function openFile(path: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(OPEN, [...OPEN_WORDS, path], {
      detached: true,
      stdio: 'ignore',
      env: hostEnv()
    });
    const working = setTimeout(() => done(true), OPENER_FAILS_WITHIN_MS);
    const failed = (why: unknown) => {
      clearTimeout(working);
      console.error(`${OPEN} could not open ${path}:`, why);
      done(false);
    };
    child.once('spawn', () => child.unref());
    child.once('error', failed);
    // After the wait the owner was already told it opened, so a late failure only reaches the log.
    child.once('exit', (code, signal) => {
      if (code === 0) {
        clearTimeout(working);
        done(true);
      } else failed(signal ?? `exit ${code}`);
    });
  });
}

/**
 * How to start Claude Code: the program, and any arguments that go before
 * Claude's own. A Mac and Linux find `claude` on the PATH. Windows needs more:
 * npm installs a .cmd shim, which Node will not start without a shell, so the
 * shim's script runs under this Node instead; and Claude's own installer puts
 * claude.exe in ~/.local/bin, which a server started before the install does
 * not have on its PATH. Looked up on each run, so an install mid-session counts.
 * The system is read per call too, not from WINDOWS, so a test can stub it.
 */
export function claudeCommand(): [string, string[]] {
  if (currentPlatform() !== 'win32') return ['claude', []];
  return (
    npmCommand('claude', ['@anthropic-ai', 'claude-code'], [join(homedir(), '.local', 'bin')]) ?? [
      'claude',
      []
    ]
  );
}

/**
 * How to start an npm-installed tool on Windows, found on the PATH (and in
 * `extra` folders): its own .exe when there is one, else its .cmd shim's
 * script run under this Node, since Node will not start a .cmd without a
 * shell. `pkg` is the package's folder under node_modules. Undefined when
 * neither is there.
 */
export function npmCommand(
  command: string,
  pkg: string[],
  extra: string[] = []
): [string, string[]] | undefined {
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extra];
  for (const dir of dirs) {
    const exe = join(dir, `${command}.exe`);
    if (existsSync(exe)) return [exe, []];
    if (!existsSync(join(dir, `${command}.cmd`))) continue;
    const folder = join(dir, 'node_modules', ...pkg);
    try {
      const { bin } = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      const entry = join(folder, typeof bin === 'string' ? bin : (bin?.[command] ?? 'cli.js'));
      return /\.[cm]?js$/.test(entry) ? [process.execPath, [entry]] : [entry, []];
    } catch {
      // A shim with no package beside it: keep looking.
    }
  }
  return undefined;
}

/**
 * An absolute path as Claude Code's permission rules write one: `//` and the
 * path in POSIX form. On Windows, C:\Users\ada becomes //c/Users/ada.
 */
export function rulePath(path: string): string {
  return `/${path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)}`;
}

/**
 * How Claude Code starts a tool server's command. On Windows `npx` is a batch
 * file, which only cmd can run, so it goes through `cmd /c` there.
 */
export function toolCommand(command: string, args: string[]): { command: string; args: string[] } {
  return WINDOWS && command === 'npx'
    ? { command: 'cmd', args: ['/c', command, ...args] }
    : { command, args };
}

/** A program kept running at login, with its output in one log file. */
export type Service = {
  label: string;
  args: string[];
  log: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Seconds to wait before starting it again after it stops. */
  throttle?: number;
};

/** How one system keeps a program running at login. */
type ServiceManager = {
  install(s: Service): Promise<boolean>;
  remove(label: string): Promise<void>;
  installed(label: string): Promise<boolean>;
  restart(label: string): Promise<boolean>;
  stopSync(label: string): void;
};

const xml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const quoted = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const quietly = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', env: hostEnv() });
  } catch {
    // Not running.
  }
};

export function launchdPlist(s: Service): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(s.label)}</string>`
  ];
  if (s.cwd) lines.push(`  <key>WorkingDirectory</key><string>${xml(s.cwd)}</string>`);
  lines.push('  <key>ProgramArguments</key>', '  <array>');
  for (const a of s.args) lines.push(`    <string>${xml(a)}</string>`);
  lines.push('  </array>');
  if (s.env) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [k, v] of Object.entries(s.env))
      lines.push(`    <key>${xml(k)}</key><string>${xml(v)}</string>`);
    lines.push('  </dict>');
  }
  lines.push('  <key>RunAtLoad</key><true/>', '  <key>KeepAlive</key><true/>');
  if (s.throttle) lines.push(`  <key>ThrottleInterval</key><integer>${s.throttle}</integer>`);
  lines.push(
    `  <key>StandardOutPath</key><string>${xml(s.log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(s.log)}</string>`,
    '</dict>',
    '</plist>',
    ''
  );
  return lines.join('\n');
}

// A user unit started from default.target runs before the desktop exists, so
// it never learns WAYLAND_DISPLAY or DISPLAY, and nothing it runs can open a
// window (Claude Code's sign-in among them). Starting with the graphical
// session gives it the desktop's environment, as launchd does on a Mac.
export function systemdUnit(s: Service): string {
  const lines = [
    '[Unit]',
    `Description=Oddboro (${s.label})`,
    'After=graphical-session.target',
    '',
    '[Service]',
    `ExecStart=${s.args.map(quoted).join(' ')}`
  ];
  if (s.cwd) lines.push(`WorkingDirectory=${s.cwd}`);
  for (const [k, v] of Object.entries(s.env ?? {}))
    lines.push(`Environment=${quoted(`${k}=${v}`)}`);
  lines.push(
    'Restart=always',
    `RestartSec=${s.throttle ?? 5}`,
    `StandardOutput=append:${s.log}`,
    `StandardError=append:${s.log}`,
    '',
    '[Install]',
    'WantedBy=graphical-session.target',
    ''
  );
  return lines.join('\n');
}

const uid = () => process.getuid?.() ?? 501;
const plist = (label: string) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const launchd: ServiceManager = {
  async install(s) {
    writeFileSync(plist(s.label), launchdPlist(s));
    await run('launchctl', ['bootout', `gui/${uid()}/${s.label}`]);
    return run('launchctl', ['bootstrap', `gui/${uid()}`, plist(s.label)]);
  },
  async remove(label) {
    await run('launchctl', ['bootout', `gui/${uid()}/${label}`]);
    rmSync(plist(label), { force: true });
  },
  installed: (label) => run('launchctl', ['print', `gui/${uid()}/${label}`]),
  restart: (label) => run('launchctl', ['kickstart', '-k', `gui/${uid()}/${label}`]),
  stopSync: (label) => quietly('launchctl', ['bootout', `gui/${uid()}/${label}`])
};

const unitFile = (label: string) =>
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'systemd',
    'user',
    `${label}.service`
  );
const systemd: ServiceManager = {
  async install(s) {
    mkdirSync(join(unitFile(s.label), '..'), { recursive: true });
    writeFileSync(unitFile(s.label), systemdUnit(s));
    await run('systemctl', ['--user', 'daemon-reload']);
    // reenable drops a link an older unit left under default.target.
    await run('systemctl', ['--user', 'reenable', `${s.label}.service`]);
    return run('systemctl', ['--user', 'restart', `${s.label}.service`]);
  },
  async remove(label) {
    await run('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
    rmSync(unitFile(label), { force: true });
    await run('systemctl', ['--user', 'daemon-reload']);
  },
  installed: (label) => run('systemctl', ['--user', 'is-enabled', '--quiet', `${label}.service`]),
  restart: (label) => run('systemctl', ['--user', 'restart', `${label}.service`]),
  stopSync: (label) => quietly('systemctl', ['--user', 'stop', `${label}.service`])
};

// Task Scheduler starts a task at logon but neither restarts a program that
// stops nor keeps its output, so the task runs a small batch file that does
// both: it runs the program with its output added to the log, waits, and runs
// it again. conhost --headless keeps any window from showing, even where
// Windows Terminal is the default terminal and would ignore a hidden style.
// The task runs as the owner, signed in, so it reaches their Credential
// Manager and shows their notifications. Registering one needs no admin.
const batch = (s: string) => s.replaceAll('%', '%%');
export function windowsLoop(s: Service): string {
  const lines = ['@echo off', 'chcp 65001 >nul'];
  if (s.cwd) lines.push(`cd /d "${batch(s.cwd)}"`);
  for (const [k, v] of Object.entries(s.env ?? {})) lines.push(`set "${k}=${batch(v)}"`);
  lines.push(
    ':run',
    `${s.args.map((a) => `"${batch(a)}"`).join(' ')} >> "${batch(s.log)}" 2>&1`,
    // ping waits without a console to read keys from, which timeout needs.
    `ping -n ${(s.throttle ?? 5) + 1} 127.0.0.1 >nul`,
    'goto run',
    ''
  );
  return lines.join('\r\n');
}

const taskFolder = () =>
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Oddboro', 'services');
const taskFile = (label: string) => join(taskFolder(), `${label}.cmd`);
const TASK = { ODDBORO_TASK_PATH: '\\Oddboro\\' };
const task = (label: string) => ({ ...TASK, ODDBORO_TASK: label });
const findTask =
  'Get-ScheduledTask -TaskPath $env:ODDBORO_TASK_PATH -TaskName $env:ODDBORO_TASK -ErrorAction Stop';
const stopTask = `${findTask} | Stop-ScheduledTask;`;
const taskScheduler: ServiceManager = {
  async install(s) {
    mkdirSync(taskFolder(), { recursive: true });
    writeFileSync(taskFile(s.label), windowsLoop(s));
    return ps(
      `
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$cmd = '/d /c "' + $env:ODDBORO_TASK_FILE + '"'
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless cmd.exe ' + $cmd)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew -StartWhenAvailable
Get-ScheduledTask -TaskPath $env:ODDBORO_TASK_PATH -TaskName $env:ODDBORO_TASK -ErrorAction SilentlyContinue | Stop-ScheduledTask
Register-ScheduledTask -TaskPath $env:ODDBORO_TASK_PATH -TaskName $env:ODDBORO_TASK -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskPath $env:ODDBORO_TASK_PATH -TaskName $env:ODDBORO_TASK`,
      { ...task(s.label), ODDBORO_TASK_FILE: taskFile(s.label) }
    );
  },
  async remove(label) {
    await powershell(
      `${stopTask} Unregister-ScheduledTask -TaskPath $env:ODDBORO_TASK_PATH -TaskName $env:ODDBORO_TASK -Confirm:$false`,
      task(label)
    );
    rmSync(taskFile(label), { force: true });
  },
  installed: (label) => ps(`${findTask} | Out-Null`, task(label)),
  restart: (label) => ps(`${stopTask} ${findTask} | Start-ScheduledTask`, task(label)),
  stopSync(label) {
    try {
      powershellSync(stopTask, task(label));
    } catch {
      // Not running.
    }
  }
};

/** Each system's login services. */
const SERVICES: Record<System, ServiceManager | undefined> = {
  mac: launchd,
  linux: systemd,
  windows: taskScheduler
};
const services = SYSTEM && SERVICES[SYSTEM];

/** Whether this system can keep the office running at login. */
export const CAN_RUN_AT_LOGIN = !!services;

/** Start a service now and at every login, replacing any older one under its label. */
export async function installService(s: Service): Promise<boolean> {
  if (!services) return false;
  mkdirSync(LOGS, { recursive: true });
  return services.install(s);
}

/** Stop a service and take it off the login list. */
export async function removeService(label: string): Promise<void> {
  await services?.remove(label);
}

/** Whether a service is set to start at login. */
export async function serviceInstalled(label: string): Promise<boolean> {
  return (await services?.installed(label)) ?? false;
}

/** Start a service again, now. */
export async function restartService(label: string): Promise<boolean> {
  return (await services?.restart(label)) ?? false;
}

/** Stop a service now and wait for it, so its files are free. It starts again at login. */
export function stopServiceSync(label: string): void {
  services?.stopSync(label);
}
