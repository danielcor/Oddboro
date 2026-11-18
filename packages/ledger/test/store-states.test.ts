// Every state of the folder check for secret stores, on each system the
// harness can fake (the office's system, not `path`, which stays this
// machine's): what `checkFolder` answers with the Accept and without, what
// `touchesSecretStore` says, and what a run is then given. Each row has a
// fresh home. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import './pglite.ts';
import {
  MARK_STATES,
  onThisDisk,
  STORE_STATES,
  TEMP_IN_APPDATA,
  type StoreState
} from './store-states.ts';

// The home for the office's home and code, fixed as office.ts loads. Each row
// sets HOME to one of its own, since `homedir()` reads it live.
const FIXED = realpathSync(mkdtempSync(join(tmpdir(), 'store-states-')));
process.env.HOME = FIXED;
process.env.ODDBORO_HOME = join(FIXED, '.oddboro');
process.env.ODDBORO_CODE = join(FIXED, 'code', 'oddboro');
after(() => rmSync(FIXED, { recursive: true, force: true }));
const O = await import('../src/office.ts');
const C = await import('../src/capabilities.ts');

function onPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    fn();
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
}

/** A new folder under the system's temp folder, by its real path, gone after `fn`. */
function inFreshFolder(prefix: string, fn: (p: string) => void): void {
  const p = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try {
    fn(p);
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
}

/** Whether a run on `platform` is given `path`, stored for an Odd before the store was there. */
const reachesRuns = (path: string, platform: NodeJS.Platform) =>
  C.ownTools(
    { agent: 'claude', commands: false, web: false, folders: [{ path, write: false }] },
    platform
  ).granted.length === 1;

function judge(s: StoreState, p: string, platform: NodeJS.Platform): void {
  if (s.refused)
    for (const accept of [true, false])
      assert.deepEqual(O.checkFolder(p, accept), { refused: O.FOLDER_REFUSED.secrets });
  else {
    assert.deepEqual(O.checkFolder(p, true), { real: p });
    // Without the Accept a folder in system files still warns first: that is
    // `broadFolder`'s to say, and no store's business.
    assert.deepEqual(
      O.checkFolder(p),
      O.broadFolder(p) ? { warning: O.FOLDER_WARNING } : { real: p }
    );
  }
  assert.equal(O.touchesSecretStore(p), s.refused);
  assert.equal(reachesRuns(p, platform), !s.refused);
}

for (const platform of ['darwin', 'linux', 'win32'] as const)
  for (const where of ['in the home', 'outside the home'] as const)
    for (const s of [...STORE_STATES, ...MARK_STATES]) {
      if (where === 'outside the home' && s.homeOnly) continue;
      test(
        `on ${platform}, ${where}: ${s.state}`,
        {
          skip:
            (!onThisDisk(s) && 'only a disk that ignores case has this state') || TEMP_IN_APPDATA
        },
        () =>
          inFreshFolder('store-states-home-', (home) => {
            const before = process.env.HOME;
            process.env.HOME = home;
            try {
              onPlatform(platform, () => {
                if (where === 'in the home') judge(s, s.make(home, home), platform);
                else
                  inFreshFolder('store-states-out-', (out) =>
                    judge(s, s.make(out, home), platform)
                  );
              });
            } finally {
              process.env.HOME = before;
            }
          })
      );
    }
