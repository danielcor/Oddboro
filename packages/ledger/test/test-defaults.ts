// Every test process starts away from the developer's own world: a home of
// its own, and a PATH that holds node and the system's own folders only. So no
// test finds the developer's claude, grok, codex or gemini, or their settings,
// unless it puts a stand-in there itself. Both test scripts load this with
// `--import`, so it runs in the runner and in each test process before any
// test module. A test that sets its own HOME or PATH later still wins.
//
// It imports only Node's own modules. A preload that loaded the office's code
// (platform.ts, say) would load it before a test's `mock.module`, and that
// test would get the real module instead of its stand-in. So it reads
// process.platform itself rather than platform.ts's SYSTEM.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const made: string[] = [];
process.on('exit', () => {
  for (const folder of made) rmSync(folder, { recursive: true, force: true });
});
const tempFolder = (prefix: string): string => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  made.push(folder);
  return folder;
};

// homedir() reads HOME on a Mac and Linux, and USERPROFILE on Windows.
const home = tempFolder('oddboro-test-home-');
process.env.HOME = home;
process.env.USERPROFILE = home;

/** Node's own folder may hold npm-installed tools, so on a Mac and Linux PATH gets node alone. */
function nodeOnly(): string {
  if (process.platform === 'win32') {
    // A link on Windows needs a privilege most accounts lack, so its own folder.
    return dirname(process.execPath);
  }
  const folder = tempFolder('oddboro-test-node-');
  symlinkSync(process.execPath, join(folder, 'node'));
  return folder;
}

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const systemFolders =
  process.platform === 'win32'
    ? [
        join(systemRoot, 'System32'),
        systemRoot,
        join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
      ]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
process.env.PATH = [nodeOnly(), ...systemFolders].join(delimiter);
