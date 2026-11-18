// Where Oddboro keeps the owner's office, where its own code lives, and the
// port it answers on. A release sets these from the app (apps/desktop); in
// development they fall back to ~/.oddboro, this repo and port 4500.
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentPlatform } from './platform.ts';

/**
 * True inside the Mac app (apps/desktop), which opens the office in its own
 * window: no web address, no Caddy.
 */
export const IN_APP = process.env.ODDBORO_APP === '1';

/**
 * Under `node --test`, which sets NODE_TEST_CONTEXT in every test process and
 * its children. A test once wrote the owner's real office, so under test the
 * office never falls back to ~/.oddboro or the live office's port.
 */
const UNDER_TEST = !!process.env.NODE_TEST_CONTEXT;

/** The owner's office: the database, staff folders, sign-ins and data. */
const HOME = process.env.ODDBORO_HOME || (UNDER_TEST ? undefined : join(homedir(), '.oddboro'));
/** Under test with no ODDBORO_HOME: a folder of its own, made on first use, removed at exit. */
let testHome: string | undefined;
function officeHome(): string {
  if (HOME) return HOME;
  if (!testHome) {
    const made = mkdtempSync(join(tmpdir(), 'oddboro-test-'));
    process.on('exit', () => rmSync(made, { recursive: true, force: true }));
    testHome = made;
  }
  return testHome;
}
export const home = (...parts: string[]): string => join(officeHome(), ...parts);

/**
 * Make the office home private, as the office starts: only the owner's account
 * may open it, so no other account on this computer reads the database, the
 * sign-ins or the Odds' files, or reaches the database's socket (db.ts). An
 * older version left the home at 755, so an existing one closes too.
 * Nothing inside needs a mode of its own: no account reaches a file through a
 * folder it cannot open, so PGlite's files at 666 stay as they are.
 * On Windows chmod only sets the read-only flag, so the office leaves it: by
 * default the home sits in the owner's profile, which Windows keeps from other
 * accounts. A home set elsewhere with ODDBORO_HOME keeps that folder's access.
 */
export function makeHomePrivate(): void {
  mkdirSync(officeHome(), { recursive: true, mode: 0o700 });
  if (currentPlatform() !== 'win32') chmodSync(officeHome(), 0o700);
}

/** Every account's folder: each coding tool's sign-ins, one folder each (accounts.ts). */
export const accountsHome = (): string => home('accounts');
/** One account's folder: the home its tool runs with (`GROK_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`). */
export const accountHome = (tool: string, account: string): string =>
  home('accounts', tool, account);

/**
 * The office's own files at the top of an Odd's folder, by what each holds:
 * the chat log (staff.ts), the chat's run session, a persona's session at
 * its door (persona-door.ts), the bug report a chat run drafted
 * (bug-drafts.ts), and its update request (chat-updates.ts). Each writer takes its name from here, so an
 * Odd never mails one, the Storage tab never lists one, and a replay never
 * names one as a change (`OFFICE_FILE_NAMES`).
 */
export const OFFICE_FILES = {
  chat: 'chat.jsonl',
  session: 'session.json',
  personaSession: 'persona-session.json',
  bugDraft: 'bug-draft.json',
  updateRequest: 'update-request.json'
} as const;
export const OFFICE_FILE_NAMES: readonly string[] = Object.values(OFFICE_FILES);

// A Mac's and Windows's disks read `Chat.jsonl` as `chat.jsonl`, so case does not count.
const lowerOfficeFiles = OFFICE_FILE_NAMES.map((n) => n.toLowerCase());
/**
 * Whether a file is one of the office's own, given as the path from the Odd's
 * real folder to the file's real path. Only that path decides, since a link
 * to the folder, a full path or another letter case names the same file by
 * another name. A path below the top never matches.
 */
export const isOfficeFile = (realInside: string): boolean =>
  lowerOfficeFiles.includes(realInside.toLowerCase());

// A Mac's disk opens an accented name in either Unicode form, and the real path
// gives the form it stored, so both sides are compared composed.
const asNamed = (p: string): string =>
  normalize(p).normalize('NFC').replace(/\\/g, '/').toLowerCase();
/**
 * Whether a file an Odd named by a path inside its folder really is there:
 * `realInside` is the path from the folder's real path to the file's. A link
 * on the way names another file, perhaps a hidden one or one outside the
 * folder, so an email and a hand-off carry only a file where it really is.
 */
export function isWhereNamed(file: { realInside: string; named: string }): boolean {
  const real = asNamed(file.realInside);
  // win32's reading, since it also takes a posix full path: on Windows
  // `relative()` gives a file on another drive as `D:\...`, never `..`.
  if (win32.isAbsolute(file.realInside) || real.split('/')[0] === '..') return false;
  return real === asNamed(file.named);
}

/** An Odd's one chat session, which every chat resumes (staff.ts). */
export const chatSession = (id: string): string => home('staff', id, OFFICE_FILES.session);

/** The code: this repo in development, the app's Resources/server folder in a release. */
export const CODE = process.env.ODDBORO_CODE || fileURLToPath(new URL('../../..', import.meta.url));

/** The office's own port, and on Windows the database's inside it (db.ts). */
export const OFFICE_PORT = Number(process.env.ODDBORO_PORT) || 4500;
export const OFFICE_URL = `http://127.0.0.1:${OFFICE_PORT}`;
export const DATABASE_PORT = Number(process.env.ODDBORO_DB_PORT) || (UNDER_TEST ? 54399 : 54329);

/** The staff tool server beside this file: mcp.ts in development, mcp.js in a release. */
export const STAFF_SERVER = fileURLToPath(
  new URL(`./mcp${extname(fileURLToPath(import.meta.url))}`, import.meta.url)
);
/** The office's file tools beside this file (files-server.ts): how a run reads and changes files. */
export const FILES_SERVER = fileURLToPath(
  new URL(`./files-server${extname(fileURLToPath(import.meta.url))}`, import.meta.url)
);
