// A notification on the owner's computer, for pings that should reach them
// with the office closed: a staffer's ping, or the setup test. While the tab
// is open the browser shows its own (Notification API), on every system.
//
// In the app the server asks the shell on stdout, one line each, and the shell
// shows it as Oddboro's (apps/desktop/src-tauri/src/server.rs). Run from the
// repo, each system has its own way, in the table below: osascript on a Mac
// (which macOS shows as Script Editor's, so Script Editor has to be allowed in
// System Settings, Notifications), and notify-send on Linux, which every
// desktop that follows the freedesktop notification spec shows, and a toast
// on Windows through PowerShell. A toast has to name an app Windows knows, and
// the repo installs none, so it shows as Windows PowerShell's, the way a Mac
// shows Script Editor's. A failure is one line on the office's stderr, which
// the app keeps in its log: the exit code and what the program wrote.
import { execFile } from 'node:child_process';
import { IN_APP } from '@oddboro/ledger/home';
import { hostEnv, openUrl, powershell, SYSTEM, type System } from '@oddboro/ledger/platform';

// The words come in as environment variables and are escaped for XML inside.
const TOAST = `
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$e = [Security.SecurityElement]
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + $e::Escape($env:ODDBORO_TITLE) + '</text><text>' + $e::Escape($env:ODDBORO_MESSAGE) + '</text></binding></visual></toast>')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show((New-Object Windows.UI.Notifications.ToastNotification $xml))`;

/** One line: no tab or line break may reach the app inside the words. */
const flat = (s: string) => s.replace(/[\t\r\n]+/g, ' ');

/** One line for the log: the exit code, then stderr with the line breaks taken out. */
const failed = (cmd: string, code: unknown, stderr: unknown) => {
  const exit = code == null || code === '' ? 'error' : String(code);
  const said = String(stderr ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 300);
  return said
    ? `notify failed: ${cmd} exited ${exit}: ${said}`
    : `notify failed: ${cmd} exited ${exit}`;
};

const run = (cmd: string, args: string[]) =>
  new Promise<boolean>((done) =>
    execFile(cmd, args, { env: hostEnv() }, (error, _stdout, stderr) => {
      if (error) console.error(`office: ${failed(cmd, error.code, stderr)}`);
      done(!error);
    })
  );

const NOTIFY: Record<System, ((title: string, message: string) => Promise<boolean>) | undefined> = {
  // Arguments, not a script string, so the words need no escaping.
  mac: (title, message) =>
    run('osascript', [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"',
      '-e',
      'end run',
      message,
      title
    ]),
  linux: (title, message) =>
    run('notify-send', [
      '--app-name=Oddboro',
      '--hint=string:desktop-entry:oddboro',
      '--',
      title,
      message
    ]),
  windows: async (title, message) => {
    const sent = await powershell(TOAST, { ODDBORO_TITLE: title, ODDBORO_MESSAGE: message });
    if (!sent.ok) console.error(`office: ${failed('powershell.exe', sent.code, sent.err)}`);
    return sent.ok;
  }
};

/** Where each system lets the owner allow notifications. Linux has no one place, so none. */
const SETTINGS: Record<System, string | undefined> = {
  mac: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  linux: undefined,
  windows: 'ms-settings:notifications'
};

/** Whether this computer can show the office's own notifications. */
export const CAN_NOTIFY = IN_APP || !!(SYSTEM && NOTIFY[SYSTEM]);

export function notifyMac(title: string, message: string): Promise<boolean> {
  if (IN_APP) {
    process.stdout.write(`oddboro:notify ${flat(title)}\t${flat(message)}\n`);
    return Promise.resolve(true);
  }
  const notify = SYSTEM && NOTIFY[SYSTEM];
  return notify ? notify(title, message) : Promise.resolve(false);
}

/** Open the system's notification settings, where it has one place for them. */
export function openNotificationSettings(): Promise<boolean> {
  const url = SYSTEM && SETTINGS[SYSTEM];
  return url ? openUrl(url) : Promise.resolve(false);
}
