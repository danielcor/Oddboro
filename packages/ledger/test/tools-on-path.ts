// Which of some commands a process could start from its PATH, for the tests
// that hold every test process away from the developer's own AI tools
// (test-defaults.test.ts here and in the office). It sits apart from
// test-defaults.ts on purpose: importing the preload would run it, so a test
// suite whose script lost its `--import` would still pass.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Every file on PATH named one of `commands`, bare, `.exe` or `.cmd` (npm's shim on Windows). */
export function toolsOnPath(commands: readonly string[]): string[] {
  const found: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const command of commands) {
      for (const name of [command, `${command}.exe`, `${command}.cmd`]) {
        try {
          // On Windows X_OK checks only that the file is there.
          accessSync(join(dir, name), constants.X_OK);
          found.push(join(dir, name));
        } catch {
          // Not in this folder, or not runnable: look on.
        }
      }
    }
  }
  return found;
}
