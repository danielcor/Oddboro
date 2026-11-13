// Secrets the owner connects (API keys, sign-ins) live in the system's own
// secret store, never in Postgres or a file. Each secret is named
// "<connector>:<NAME>".
//
// On a Mac in the app, the shell keeps them in the Keychain itself, under the
// service "com.oddboro.office", so only the signed app can read them without
// macOS asking (`useShellSecrets`). The office loads them all once as it
// starts and asks the shell over its own stdin and stdout
// (`apps/desktop/src-tauri/src/secrets.rs`). The first start moves the
// secrets an older version kept under "oddboro" across.
//
// Everywhere else, each system has one entry below, through the tool it
// ships with: the Keychain on a Mac in development through `security`, under
// "oddboro", and on Linux the desktop keyring through `secret-tool`
// (libsecret), which talks to any keyring that speaks the Secret Service
// (GNOME Keyring, KWallet, KeePassXC). Windows ships no command that reads a
// secret back, so there the office keeps them in the Credential Manager
// through the keyring package, loaded only on Windows.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { hostEnv, SYSTEM, type System } from './platform.ts';
import { fixedError } from './errors.ts';

const SERVICE = 'oddboro';

/** One system's secret store. `get` and `remove` throw when there is no such secret. */
type Store = {
  set(account: string, value: string): void;
  get(account: string): string;
  remove(account: string): void;
  /** Throws when the store cannot be reached. */
  check(): void;
};

const read = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    env: hostEnv(),
    stdio: ['ignore', 'pipe', 'ignore']
  });
const quiet = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { env: hostEnv(), stdio: 'ignore' });

/**
 * `security -i` reads one command a line, and runs anything past its 4,095th
 * byte as a command of its own. So no line it gets is longer than this.
 */
const LINE_BYTES = 3900;
/** The second and later pieces of a long value: "<account>#1", "#2" and on. */
const PIECE_NAME = /#\d+$/;

/** A word on a `security -i` line: in double quotes, with `\` and `"` escaped. */
export function securityWord(text: string): string {
  if (/[\r\n\0]/.test(text)) throw new Error('A secret for the Keychain cannot hold a line break.');
  return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * The `security -i` lines that save `value` as `account`, one piece a line,
 * so the value is never on a command line, where every process could see it.
 */
export function saveLines(account: string, value: string): string[] {
  const line = (i: number, piece: string) =>
    `add-generic-password -U -s ${securityWord(SERVICE)} -a ${securityWord(i ? `${account}#${i}` : account)} -w ${securityWord(piece)}`;
  const room = (i: number) => LINE_BYTES - Buffer.byteLength(line(i, ''));
  const lines: string[] = [];
  let piece = '';
  let used = 0;
  // By code point, so a piece never splits a character.
  for (const ch of value) {
    const bytes = Buffer.byteLength(ch) + (ch === '\\' || ch === '"' ? 1 : 0);
    if (used + bytes > room(lines.length)) {
      lines.push(line(lines.length, piece));
      piece = '';
      used = 0;
    }
    piece += ch;
    used += bytes;
  }
  lines.push(line(lines.length, piece));
  return lines;
}

/**
 * One item's value. `security -g` prints it as `password: "<text>"`, or as
 * `password: 0x<hex>  "<escaped>"` when any byte is not plain ASCII; `-w`
 * gives that hex alone, which cannot be told from a value of hex digits.
 */
export function readPassword(said: string): string {
  const line = said.split('\n').find((l) => l.startsWith('password: '));
  if (line === undefined) throw new Error('security said no password');
  const rest = line.slice('password: '.length);
  const hex = /^0x([0-9A-Fa-f]*)\s/.exec(rest);
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8');
  return rest.startsWith('"') ? rest.slice(1, rest.lastIndexOf('"')) : '';
}

const readPiece = (account: string) => {
  const done = spawnSync(
    'security',
    ['find-generic-password', '-s', SERVICE, '-a', account, '-g'],
    {
      encoding: 'utf8',
      env: hostEnv(),
      stdio: ['ignore', 'ignore', 'pipe']
    }
  );
  if (done.status !== 0) throw new Error(`No secret named ${account}`);
  return readPassword(done.stderr);
};
/** Removes pieces from `from` on, until one is missing. */
const dropPieces = (account: string, from: number) => {
  for (let i = from; ; i++) {
    try {
      quiet('security', ['delete-generic-password', '-s', SERVICE, '-a', `${account}#${i}`]);
    } catch {
      return;
    }
  }
};

/** The Keychain through `security`: development, and the move from it in the app. */
const keychain: Store = {
  set(account, value) {
    const lines = saveLines(account, value);
    // stderr stays shut: what security says about a bad line can quote it.
    execFileSync('security', ['-i'], {
      env: hostEnv(),
      input: `${lines.join('\n')}\n`,
      stdio: ['pipe', 'ignore', 'ignore']
    });
    dropPieces(account, lines.length);
  },
  get(account) {
    let value = readPiece(account);
    for (let i = 1; ; i++) {
      try {
        value += readPiece(`${account}#${i}`);
      } catch {
        return value;
      }
    }
  },
  remove(account) {
    quiet('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
    dropPieces(account, 1);
  },
  check: () => quiet('security', ['default-keychain'])
};

const secretService: Store = {
  // secret-tool reads the value on stdin, so it never shows in the process list.
  set: (account, value) => {
    execFileSync(
      'secret-tool',
      ['store', '--label', `Oddboro ${account}`, 'service', SERVICE, 'account', account],
      { env: hostEnv(), input: value, stdio: ['pipe', 'ignore', 'pipe'] }
    );
  },
  // secret-tool prints the value as stored and fails when there is none.
  get: (account) => read('secret-tool', ['lookup', 'service', SERVICE, 'account', account]),
  remove: (account) => {
    secretService.get(account);
    quiet('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
  },
  // A search that finds nothing still succeeds; one with no keyring to ask fails.
  check: () => quiet('secret-tool', ['search', 'service', SERVICE])
};

type Entry = {
  setSecret(secret: Uint8Array): void;
  getSecret(): number[] | null;
  deletePassword(): boolean;
};
type Keyring = { Entry: new (service: string, account: string) => Entry };

/**
 * The Credential Manager holds at most 2,560 bytes in one credential, and a
 * sign-in's saved JSON can run longer. So a value goes in as UTF-8 in pieces:
 * the first credential holds how many pieces there are, a line break, then
 * the first piece; the rest follow as "<account>#1", "#2" and on.
 */
const PIECE = 2048;
function credentialManager(): Store {
  const { Entry } = createRequire(import.meta.url)('@napi-rs/keyring') as Keyring;
  const entry = (account: string, i: number) => new Entry(SERVICE, i ? `${account}#${i}` : account);
  const read = (account: string, i: number) => {
    const bytes = entry(account, i).getSecret();
    if (!bytes) throw new Error(`No secret named ${account}`);
    return Buffer.from(bytes);
  };
  /** Removes pieces from `from` on, until one is missing. */
  const drop = (account: string, from: number) => {
    for (let i = from; entry(account, i).deletePassword(); i++);
  };
  return {
    set(account, value) {
      const bytes = Buffer.from(value, 'utf8');
      const count = Math.max(1, Math.ceil(bytes.length / PIECE));
      for (let i = count - 1; i >= 0; i--) {
        const piece = bytes.subarray(i * PIECE, (i + 1) * PIECE);
        entry(account, i).setSecret(i ? piece : Buffer.concat([Buffer.from(`${count}\n`), piece]));
      }
      drop(account, count);
    },
    get(account) {
      const first = read(account, 0);
      const nl = first.indexOf(10);
      const count = Number(first.subarray(0, nl));
      const pieces = [first.subarray(nl + 1)];
      for (let i = 1; i < count; i++) pieces.push(read(account, i));
      return Buffer.concat(pieces).toString('utf8');
    },
    remove(account) {
      read(account, 0);
      drop(account, 0);
    },
    // Reading a name that is not there answers null; a store that cannot be reached throws.
    check: () => void entry('check', 0).getSecret()
  };
}

const STORES: Record<System, (() => Store) | undefined> = {
  mac: () => keychain,
  linux: () => secretService,
  windows: credentialManager
};
/**
 * This system's store, or none when it has none or it would not load. A
 * process the office starts in the app on a Mac (`ODDBORO_SECRETS=office`,
 * the staff tool server) gets none: only the office reaches the Keychain,
 * through the shell, so a read here finds nothing and a write never lands in
 * the old store where any program could read it.
 */
let store = ((): Store | undefined => {
  if (process.env.ODDBORO_SECRETS === 'office') return undefined;
  try {
    return SYSTEM ? STORES[SYSTEM]?.() : undefined;
  } catch {
    return undefined;
  }
})();

type Ask =
  | { op: 'list' | 'legacy' }
  | { op: 'set'; account: string; value: string }
  | { op: 'remove'; account: string };
type Answer = {
  id: number;
  ok: boolean;
  error?: string;
  secrets?: Record<string, string>;
  accounts?: string[];
};

/**
 * Asks the app's shell over a pair of pipes: a line
 * `oddboro:secret {"id":n,"op":...}` out, and one JSON line back with that
 * id. The shell never logs either. When the pipe closes, every question
 * still out fails.
 */
export function shellAsker(input: Readable, output: Writable): (ask: Ask) => Promise<Answer> {
  let last = 0;
  const waiting = new Map<number, (answer: Answer) => void>();
  createInterface({ input })
    .on('line', (line) => {
      let answer: Answer;
      try {
        answer = JSON.parse(line) as Answer;
      } catch {
        return;
      }
      waiting.get(answer.id)?.(answer);
      waiting.delete(answer.id);
    })
    .on('close', () => {
      for (const [id, done] of waiting) done({ id, ok: false, error: 'the app closed the pipe' });
      waiting.clear();
    });
  return (ask) =>
    new Promise((done) => {
      const id = ++last;
      waiting.set(id, done);
      output.write(`oddboro:secret ${JSON.stringify({ id, ...ask })}\n`);
    });
}

/**
 * The shell's Keychain, held in memory. A change lands in memory at once and
 * goes to the shell after; a change the shell could not make is logged, by
 * the secret's name only. The office runs on the app's signed Node, so no
 * other program can read its memory.
 */
function shellStore(ask: (ask: Ask) => Promise<Answer>, secrets: Map<string, string>): Store {
  const send = (change: Ask & { account: string }) =>
    void ask(change).then((answer) => {
      if (!answer.ok)
        console.error(
          `secrets: the Keychain did not ${change.op} ${change.account}: ${answer.error}`
        );
    });
  return {
    set(account, value) {
      secrets.set(account, value);
      send({ op: 'set', account, value });
    },
    get(account) {
      const value = secrets.get(account);
      if (value === undefined) throw new Error(`No secret named ${account}`);
      return value;
    },
    remove(account) {
      if (!secrets.delete(account)) throw new Error(`No secret named ${account}`);
      send({ op: 'remove', account });
    },
    check() {}
  };
}

/**
 * Moves each secret an older version kept through `security` into the
 * shell's Keychain, with no prompt: `security` reads its own items silently.
 * An old item goes only once the shell has saved its value, so a failure
 * leaves it for the next start.
 */
async function moveLegacy(ask: (ask: Ask) => Promise<Answer>, secrets: Map<string, string>) {
  const legacy = await ask({ op: 'legacy' });
  if (!legacy.ok) {
    console.error(`secrets: could not list the old Keychain items: ${legacy.error}`);
    return;
  }
  const accounts = (legacy.accounts ?? []).filter((a) => !PIECE_NAME.test(a));
  if (!accounts.length) return;
  let moved = 0;
  for (const account of accounts) {
    try {
      // One already here was moved before, and may have changed since.
      if (!secrets.has(account)) {
        const value = keychain.get(account);
        const saved = await ask({ op: 'set', account, value });
        if (!saved.ok) continue;
        secrets.set(account, value);
      }
      keychain.remove(account);
      moved++;
    } catch {
      // Left where it is, for the next start.
    }
  }
  const left = accounts.length - moved;
  console.log(
    `secrets: moved ${moved} of ${accounts.length} into the app's Keychain` +
      (left ? `; ${left} stay for the next start` : '')
  );
}

/**
 * In the app on a Mac (`ODDBORO_SECRETS=shell`), keep secrets through the
 * shell from now on. Only the office server calls this: it owns the pipes.
 * Its child processes, such as the staff tool server, inherit nothing but the
 * `security` store. With the shell unable to read the Keychain, the office
 * keeps that store and says so.
 */
export async function useShellSecrets(
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Promise<void> {
  if (process.env.ODDBORO_SECRETS !== 'shell') return;
  const ask = shellAsker(input, output);
  const listed = await ask({ op: 'list' });
  if (!listed.ok) {
    console.error(
      `secrets: the app could not read the Keychain, so using security: ${listed.error}`
    );
    return;
  }
  const secrets = new Map(Object.entries(listed.secrets ?? {}));
  store = shellStore(ask, secrets);
  await moveLegacy(ask, secrets);
}

export function setSecret(connector: string, name: string, value: string): void {
  if (!store) throw fixedError('This system has no secret store the office can use yet.');
  store.set(`${connector}:${name}`, value);
}

export function getSecret(connector: string, name: string): string | undefined {
  try {
    return store?.get(`${connector}:${name}`) || undefined;
  } catch {
    return undefined;
  }
}

/** Remove a secret; true when there was one. */
export function deleteSecret(connector: string, name: string): boolean {
  try {
    store?.remove(`${connector}:${name}`);
    return !!store;
  } catch {
    return false;
  }
}

/** Whether this computer has a secret store the office can use, and why not when it has none. */
export function secretStore(): { ok: true } | { ok: false; problem: string } {
  if (!store) return { ok: false, problem: 'not found on this system' };
  try {
    store.check();
    return { ok: true };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return { ok: false, problem: missing ? 'not installed' : 'did not answer' };
  }
}
