// The system's own folder picker, opened by the office on the owner's
// computer, for the Folders tab of an Odd's Access. The office runs on that
// computer, so its dialog opens on the owner's screen: on a Mac AppleScript's
// `choose folder`, on Windows the Forms folder dialog in PowerShell, on Linux
// zenity, or kdialog when zenity is not there. A cancel picks nothing. Where
// no dialog can open (Linux with neither tool, or no screen), the owner types
// the path instead and the page says why. The picked path goes through the
// same checks as a typed one (`checkFolder`), so the picker widens nothing.
// One picker at a time, closed after five minutes. Server only.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { currentPlatform, hostEnv } from '@oddboro/ledger/platform';
import { onPath } from './on-path.ts';

export type Picked = { path: string } | { cancelled: true } | { unavailable: string };

/** The dialog closes on its own after this long, as a cancel. */
const WAIT_MS = 5 * 60_000;

/** Windows' folder dialog, on a topmost owner so it opens in front of the browser. Its prompt comes in through the environment, never the script. */
const WINDOWS_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = $env:ODDBORO_PICK_PROMPT',
  '$d.ShowNewFolderButton = $true',
  '$d.SelectedPath = [Environment]::GetFolderPath("UserProfile")',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
  "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
].join('; ');

type Dialog = { cmd: string; args: string[]; env?: NodeJS.ProcessEnv };

/** The command that opens this system's folder picker, or why there is none. */
export function pickerCommand(prompt: string): Dialog | { unavailable: string } {
  const home = homedir();
  if (currentPlatform() === 'darwin') {
    const cmd = onPath('osascript');
    if (!cmd) return { unavailable: 'This Mac has no osascript to open a folder picker.' };
    // The prompt is an argument, never part of the script.
    return {
      cmd,
      args: [
        '-e',
        'on run argv',
        '-e',
        'activate',
        '-e',
        'POSIX path of (choose folder with prompt (item 1 of argv) default location (path to home folder))',
        '-e',
        'end run',
        prompt
      ]
    };
  }
  if (currentPlatform() === 'win32') {
    const cmd = onPath('powershell');
    if (!cmd) return { unavailable: 'This computer has no PowerShell to open a folder picker.' };
    return {
      cmd,
      args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT],
      env: { ODDBORO_PICK_PROMPT: prompt }
    };
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    return { unavailable: 'The office has no screen here to open a folder picker on.' };
  const zenity = onPath('zenity');
  if (zenity)
    return {
      cmd: zenity,
      args: ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${home}/`]
    };
  const kdialog = onPath('kdialog');
  if (kdialog) return { cmd: kdialog, args: ['--getexistingdirectory', home, '--title', prompt] };
  return { unavailable: 'Install zenity or kdialog to pick a folder here.' };
}

let open = false;

/** Whether a picker is open now: a second one waits for the first to close. */
export const pickerOpen = () => open;

/**
 * Open the folder picker and wait for the owner. The path they picked, as
 * the system spells it, or a cancel, or why no picker can open here.
 */
export async function pickFolder(prompt: string): Promise<Picked> {
  const dialog = pickerCommand(prompt);
  if ('unavailable' in dialog) return dialog;
  open = true;
  try {
    const out = await new Promise<string>((done) => {
      try {
        execFile(
          dialog.cmd,
          dialog.args,
          {
            env: { ...hostEnv(), ...dialog.env },
            timeout: WAIT_MS,
            windowsHide: true,
            encoding: 'utf8'
          },
          // A cancel ends with an error (exit 1 on a Mac, zenity and kdialog) or nothing printed.
          (e, stdout) => done(e ? '' : String(stdout))
        );
      } catch {
        done('');
      }
    });
    const path = out.replace(/\r?\n$/, '');
    if (!path.trim()) return { cancelled: true };
    // AppleScript ends a folder with "/": the folder itself, as a typed path would name it.
    return { path: path.length > 1 ? path.replace(/[\\/]+$/, '') || path : path };
  } finally {
    open = false;
  }
}
