// Linux keeps its browsers' and keyrings' secrets in folders of their own. None
// of them can be given to an Odd, and neither can a folder that holds one, but
// the tools under `~/.local/bin` still can. The office's
// launch-contract.test.ts holds that no run reads them. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import './pglite.ts';
import { TEMP_IN_APPDATA } from './store-states.ts';

// A home of the test's own, with the office's home and code inside it, set
// before office.ts loads: home.ts fixes both at import.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'secret-stores-')));
process.env.HOME = HOME;
process.env.ODDBORO_HOME = join(HOME, '.oddboro');
process.env.ODDBORO_CODE = join(HOME, 'code', 'oddboro');
after(() => rmSync(HOME, { recursive: true, force: true }));
const O = await import('../src/office.ts');

/** Makes the file at `path` under the test's home, with the folders it sits in. */
function file(path: string): void {
  const at = join(HOME, path);
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, '');
}

test(
  "a Linux browser's or keyring's folder cannot be given to an Odd, nor can one holding it, and ~/.local/bin still can",
  { skip: TEMP_IN_APPDATA },
  () => {
    file('.mozilla/firefox/profiles.ini');
    file('.local/share/keyrings/login.keyring');
    file('.pki/nssdb/cert9.db');
    file('snap/firefox/common/x');
    file('.var/app/org.mozilla.firefox/x');
    file('.local/bin/claude');
    const refused = { refused: O.FOLDER_REFUSED.secrets };
    for (const path of [
      '~/.mozilla',
      '~/.mozilla/firefox',
      '~/.local',
      '~/.local/share',
      '~/.local/share/keyrings',
      '~/.pki',
      '~/snap',
      '~/snap/firefox',
      '~/.var',
      '~/.var/app',
      '~/.var/app/org.mozilla.firefox'
    ])
      assert.deepEqual(O.checkFolder(path), refused, path);
    assert.deepEqual(O.checkFolder('~/.local/bin'), { real: join(HOME, '.local', 'bin') });
  }
);

test(
  'a folder named like a Linux store, anywhere, is one only when it holds what marks the store',
  { skip: TEMP_IN_APPDATA },
  () => {
    file('work/keyrings/notes.txt');
    file('work/app/main.ts');
    file('copy/keyrings/user.keystore');
    assert.deepEqual(O.checkFolder('~/work'), { real: join(HOME, 'work') });
    assert.deepEqual(O.checkFolder('~/work/app'), { real: join(HOME, 'work', 'app') });
    assert.deepEqual(O.checkFolder('~/copy/keyrings'), { refused: O.FOLDER_REFUSED.secrets });
  }
);
