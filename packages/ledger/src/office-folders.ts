// The folders outside the office an Odd may read or change, the checks that keep
// a secret store out of every run, and when a folder or switch ask is refused.
import { eq } from 'drizzle-orm';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { db } from './db.ts';
import { accountsHome, CODE, home } from './home.ts';
import { type Db } from './threads.ts';
import { staff } from './schema.ts';
import { AGENT_NAMES, commandsHow } from './agents.ts';
import { currentPlatform } from './platform.ts';
import { SWITCH_NAMES, switchesSaid, type FolderAccess, type OwnSwitch } from './access-words.ts';
import type { StaffRow } from './office.ts';
import { staffer } from './office-staff.ts';
import { record } from './office-ledger.ts';

/**
 * Only the owner gives an Odd a folder outside the office, to read or to read
 * and change, or takes it back (`access` null). A folder given is the path as
 * the owner typed it: `checkFolder` refuses it or gives its real path, which
 * is what is stored. A folder taken back is the path as stored, unchecked, so
 * a folder deleted from the disk can still be taken back. A folder is the same one
 * when its real path is (`real`), so a level change replaces it, even one
 * stored in another case. Folders may sit one inside another, but a folder
 * only to read is refused inside or around one to change
 * (`FOLDER_REFUSED.readInsideChange`, `nestRefused`). A
 * stored folder no run gets (`touchesSecretStore`) carries none, so the owner
 * can give a clean folder inside it. It still counts against a folder that
 * would hold it, which would put the store it was dropped for in a run. A
 * whole drive or system files comes back as a `warning` and changes nothing
 * until the owner accepts it (`accept`). Takes effect on the next run.
 */
export async function setFolder(
  id: string,
  path: string,
  access: FolderAccess | null,
  accept = false
): Promise<{ refused: string } | { warning: string } | undefined> {
  const done = await changeFolder(db, id, path, access, { accept });
  if (!done || 'refused' in done || 'warning' in done) return done;
  await record({ kind: 'access', actor: 'owner', title: done.title });
}

/**
 * The change `setFolder` makes, in `q`, with the ledger title it is written
 * under. Nothing when the Odd is gone or already has the folder so.
 */
async function changeFolder(
  q: Db,
  id: string,
  path: string,
  access: FolderAccess | null,
  owner: { accept: boolean }
): Promise<{ refused: string } | { warning: string } | { title: string } | undefined> {
  const before = await staffer(id, q);
  if (!before) return;
  if (access !== null) {
    const checked = checkFolder(path, owner.accept);
    if ('refused' in checked || 'warning' in checked) return checked;
    path = checked.real;
  }
  const at = real(path);
  const same = (f: { path: string }) => real(f.path) === at;
  const had = before.folders.find(same);
  const write = access === 'write';
  if (access === null ? !had : had?.write === write) return;
  const rest = before.folders.filter((f) => !same(f));
  if (access !== null) {
    const refused = nestRefused(rest, at, write);
    if (refused) return { refused };
  }
  const folders = access === null ? rest : [...rest, { path, write }];
  await q.update(staff).set({ folders }).where(eq(staff.id, id));
  return {
    title:
      access === null
        ? `Took ${shownFolder(path)} from ${before.name}`
        : gaveFolder(before.name, path, access)
  };
}

/** The ledger's words for giving a folder: "Let Theo read ~/Taxes". */
const gaveFolder = (name: string, path: string, access: FolderAccess) =>
  `Let ${name} ${access === 'write' ? 'read and change' : 'read'} ${shownFolder(path)}`;

/**
 * Why a folder at `at` (a real path), to change when `write`, may not sit
 * beside the stored folders `others`, or nothing when it may. Folders may sit
 * one inside another: a run reads them all and changes those to change, as it
 * reads a work's folder and changes only its own part. The one pair refused is
 * a folder only to read inside one to change (`FOLDER_REFUSED.readInsideChange`):
 * every tool lets a run change all of the outer one, so the inner one could
 * not stay read only. A stored folder no run gets (`touchesSecretStore`) still
 * counts against a folder that would hold it, which would put its store in a
 * run (`FOLDER_REFUSED.nested`).
 */
function nestRefused(
  others: { path: string; write: boolean }[],
  at: string,
  write: boolean
): string | undefined {
  for (const f of others) {
    const p = real(f.path);
    if (touchesSecretStore(f.path)) {
      if (within(p, at)) return FOLDER_REFUSED.nested;
      continue;
    }
    if ((within(at, p) && f.write && !write) || (within(p, at) && write && !f.write))
      return FOLDER_REFUSED.readInsideChange;
  }
  return undefined;
}

/**
 * Why an Odd may not ask for `path` (a real path from `checkFolder`) at
 * `level`, or nothing when it may: it has that folder, or one holding it,
 * at that level or above; or the owner could not give it beside the folders
 * it has (`nestRefused`, as in `setFolder`). A stored folder
 * no run gets (`touchesSecretStore`) never covers what is asked for, so the
 * Odd is never told that a folder it does not get covers it, and a clean
 * folder inside one can be asked for. It still counts against a folder that
 * would hold it, which would put the store it was dropped for in a run.
 */
export function folderAskRefused(
  who: Pick<StaffRow, 'folders'>,
  path: string,
  level: FolderAccess
): string | undefined {
  const at = real(path);
  const held = who.folders.filter((f) => !touchesSecretStore(f.path));
  const covers = held.find((f) => within(at, real(f.path)) && (f.write || level === 'read'));
  if (covers)
    return `You already have ${shownFolder(covers.path)} (${covers.write ? 'read and change' : 'read only'}), which covers it.`;
  return nestRefused(
    who.folders.filter((f) => real(f.path) !== at),
    at,
    level === 'write'
  );
}

/**
 * Why an Odd may not ask for `wanted`, or nothing when it may: each is on
 * already, or its tool on this system never runs commands (`commandsHow`), in
 * the Settings tab's words. One already on is left out of the ask
 * (`switchesOff`), so only all of them on refuses.
 */
export function switchAskRefused(
  who: Pick<StaffRow, 'agent' | 'commands' | 'web'>,
  wanted: readonly OwnSwitch[]
): string | undefined {
  const how = commandsHow(who.agent, currentPlatform());
  if (wanted.includes('commands') && how.state === 'never')
    return `${SWITCH_NAMES.commands} is not open to an Odd on ${AGENT_NAMES[who.agent]} here: ${how.why}`;
  if (!switchesOff(who, wanted).length) return `You already have ${switchesSaid(wanted)} on.`;
}

/** The switches in `wanted` that are off for this Odd. */
export const switchesOff = (
  who: Pick<StaffRow, 'commands' | 'web'>,
  wanted: readonly OwnSwitch[]
): OwnSwitch[] => wanted.filter((s) => !who[s]);

/**
 * Secret stores, by name, each with how it is found anywhere but the top of
 * the home, where the name alone is enough (`touchesSecretStore`). An empty
 * list means the name alone everywhere. A list names what marks the real
 * store, for a name a project may use for its own files (`.ssh`, `.aws`,
 * `.gnupg`, `.claude`, `.codex`, `.docker`, `.kube`, `.config`) or an ordinary
 * word (`Library`, `AppData`): a key, a sign-in, a tool's history or a
 * cluster's keys, or a Mac user's keychain and cookies, which `/Library` has
 * none of, so that system folder stays a warning. `.ssh` and `.aws` leave out
 * `config` on purpose, since a project may well hold one.
 *
 * Linux keeps its browsers' and keyrings' secrets in folders of their own:
 * Firefox's profiles in `.mozilla`, the desktop's keyrings in
 * `.local/share/keyrings`, Chrome's certificate store in `.pki`, and the
 * profiles of a browser installed by snap or Flatpak under `snap` and
 * `.var/app`. A key may be a path under the home, written with `/`: the deny
 * lists join the whole key to the home, and a folder is a store by its own
 * name, the key's last segment. Only the keyrings are listed under `.local`,
 * not `.local` itself, because `~/.local/bin` holds tools a run must reach. A
 * folder that holds a store is still refused, so `~/.local` is.
 *
 * Where the check stops (`inOrHoldsStore`): the folder, the folders above it
 * and each key's path below it. A store deeper than that, or under another
 * name, is not found, and a `.ssh` with only custom-named keys and no
 * `known_hosts` is given anywhere but the top of the home.
 */
export const STORE_MARKS: Record<string, string[]> = {
  '.ssh': [
    'id_rsa',
    'id_ecdsa',
    'id_ecdsa_sk',
    'id_ed25519',
    'id_ed25519_sk',
    'id_dsa',
    'authorized_keys',
    'known_hosts'
  ],
  '.aws': ['credentials', 'sso', 'cli/cache', 'login'],
  '.gnupg': ['private-keys-v1.d', 'secring.gpg', 'pubring.kbx'],
  '.config': ['gcloud', 'gh/hosts.yml'],
  Library: ['Keychains/login.keychain-db', 'Cookies'],
  AppData: ['Roaming', 'Local'],
  '.claude': ['.credentials.json', 'history.jsonl', 'projects'],
  '.claude.json': [],
  '.google_workspace_mcp': [],
  '.grok': ['auth.json', 'sessions'],
  '.codex': ['auth.json', 'sessions'],
  '.gemini': ['oauth_creds.json', 'google_accounts.json'],
  '.docker': ['config.json'],
  '.kube': ['config'],
  '.mozilla': ['firefox'],
  '.local/share/keyrings': ['login.keyring', 'user.keystore'],
  '.pki': ['nssdb'],
  snap: ['firefox', 'chromium'],
  '.var/app': ['org.mozilla.firefox', 'com.google.Chrome', 'org.chromium.Chromium']
};

/**
 * The secret stores' names: keys, sign-ins and settings in the home folder,
 * including those other apps on this computer keep there, like the Google
 * Workspace MCP server's, Docker's registry sign-ins and Kubernetes' cluster
 * keys, and each coding tool's own home. AppData is where Windows apps keep
 * theirs. No run reads them (`unreadable` in the office's staff.ts), and no
 * folder given to an Odd holds or sits in one (`checkFolder`).
 */
export const SECRET_STORES: string[] = Object.keys(STORE_MARKS);

/** What the owner reads when a folder cannot be given to an Odd. */
export const FOLDER_REFUSED = {
  missing: 'No such folder.',
  home: 'Pick a folder inside your home, not the whole home.',
  secrets: 'That folder holds your keys or sign-ins.',
  code: "That folder holds Oddboro's own code.",
  nested: "That folder holds one of this Odd's folders that has your keys or sign-ins.",
  readInsideChange:
    "A folder on Can read can't sit inside one on Can write. This Odd can already change everything in it.",
  /** What an Odd reads when it asks for a whole drive or system files: only the owner may give one. */
  broad: 'That folder is a whole drive or holds system files. Ask for a narrower one.',
  glob: (char: string) => `That folder's path has a character an Odd's tool can't take: ${char}`
} as const;

/**
 * What the owner reads before giving a whole drive or system files
 * (`broadFolder`), with Accept and Cancel. Only their Accept gives it.
 */
export const FOLDER_WARNING =
  "This folder is a whole drive or holds system files, so an Odd could reach everything inside it. We don't recommend giving it.";

/**
 * Whether `p` is a secret store by `STORE_MARKS`. By its own folder's name, a
 * key's last segment, so `keyrings` anywhere is `.local/share/keyrings`.
 */
function marksStore(p: string): boolean {
  const name = basename(p).toLowerCase();
  const marks = Object.entries(STORE_MARKS).find(
    ([store]) => basename(store).toLowerCase() === name
  )?.[1];
  return !!marks && existsSync(p) && (!marks.length || marks.some((m) => existsSync(join(p, m))));
}

/**
 * Whether `p` is in a secret store or holds one directly (`STORE_MARKS`).
 * Below `p` only each key's own path is looked at, so giving one is never a
 * walk of a whole drive, and a store renamed to another folder name cannot be
 * found at all.
 */
function inOrHoldsStore(p: string): boolean {
  for (let at = p; dirname(at) !== at; at = dirname(at)) if (marksStore(at)) return true;
  return Object.keys(STORE_MARKS).some((name) => marksStore(join(p, name)));
}

/** The system's own folders on each system, by real path where one exists. */
function systemFolders(): string[] {
  const env = process.env;
  const list =
    currentPlatform() === 'win32'
      ? [
          env.SystemRoot ?? 'C:\\Windows',
          env.ProgramFiles ?? 'C:\\Program Files',
          env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          env.ProgramData ?? 'C:\\ProgramData'
        ]
      : currentPlatform() === 'darwin'
        ? ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/private', '/dev']
        : [
            ...['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot'],
            ...['/var', '/proc', '/sys', '/dev', '/run', '/root', '/tmp']
          ];
  return list.map(real);
}

/**
 * Whether `p` (a real path) is a whole drive or volume, or is in or holds the
 * system's own folders: what the owner is warned about before giving
 * (`FOLDER_WARNING`), and an Odd may not ask for. A folder in the home is
 * never one, wherever the home sits.
 */
export function broadFolder(p: string): boolean {
  if (within(p, real(homedir()))) return false;
  const up = dirname(p);
  const root =
    up === p ||
    ['/Volumes', '/mnt', '/media'].includes(up) ||
    ['/media', '/run/media'].includes(dirname(up));
  return root || systemFolders().some((s) => within(p, s) || within(s, p));
}

/**
 * The characters Codex 0.166 refuses in a folder's path, since it reads them
 * as a glob and takes a glob only to deny; it refuses both ways of escaping
 * one too (`\\[` and `[[]`), so no Odd's run could start with such a folder.
 * Refused for every Odd, since an Odd can move to Codex later. `{` and `}`
 * stay allowed: Codex 0.166 takes them (measured twice), and Claude Code's
 * sandbox reads `{` as a plain character.
 */
export const GLOB = /[*?[\]]/;

/**
 * A path by its real one when it exists, so it compares with a real path. The
 * system's own realpath spells each name as the disk keeps it, so on a Mac's
 * disk, which ignores case, `~/.SSH` and `~/.ssh` come out the same.
 */
const real = (p: string): string => (existsSync(p) ? realpathSync.native(p) : p);

/** Whether `p` is `parent` or sits inside it. A Windows disk ignores case. */
export function within(p: string, parent: string): boolean {
  const [a, b] =
    currentPlatform() === 'win32' ? [p.toLowerCase(), parent.toLowerCase()] : [p, parent];
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** A path as the owner reads it, the home folder written `~`. */
export function shownFolder(path: string): string {
  for (const h of new Set([homedir(), real(homedir())]))
    if (within(path, h)) return `~${path.slice(h.length)}`;
  return path;
}

/**
 * Whether the folder at `path`, by its real path, is a secret store at the
 * top of the home (`SECRET_STORES`, by name) or the office's own accounts
 * folder, where each tool's sign-ins live (`accountsHome`), sits in one or
 * holds one, or anywhere else is, sits in or directly holds a store found by
 * what it holds (`inOrHoldsStore`). `checkFolder` refuses such a folder as it
 * is given, and `ownTools` leaves out one stored before its store was listed,
 * or written past `setFolder`, so no run is given it. By real path, so on a
 * disk that ignores case `~/.SSH` is `~/.ssh`.
 */
export function touchesSecretStore(path: string): boolean {
  const p = real(path);
  const h = real(homedir());
  const known = [...SECRET_STORES.map((s) => join(h, s)), accountsHome()].some((s) => {
    const store = real(s);
    return within(p, store) || within(store, p);
  });
  return known || inOrHoldsStore(p);
}

/**
 * Whether `path`, as the owner typed it, may be given to an Odd, and its real
 * path when it may. Any folder on the computer but the home itself, and one
 * that holds or sits in a secret store (`touchesSecretStore`), the office's
 * own home or Oddboro's code: those would let an Odd past the office's walls,
 * so no Accept gives them. A deny inside a folder a run reads is not held by
 * every tool, so a folder that holds one is refused at the door. A real path
 * with a character Codex cannot take (`GLOB`) is refused too, by the real
 * path, since that is what a run is given. A whole drive or system files
 * (`broadFolder`) comes back as a `warning` until the owner accepts it
 * (`accept`). Only the ways a folder is given call this, so a folder given
 * before a rule was added is not checked again, but for the secret stores,
 * which every run checks again (`touchesSecretStore`).
 */
export function checkFolder(
  path: string,
  accept = false
): { real: string } | { refused: string } | { warning: string } {
  const typed = path.trim();
  const expanded = /^~(?=$|[\\/])/.test(typed) ? join(homedir(), typed.slice(1)) : typed;
  if (!isAbsolute(expanded) || !existsSync(expanded)) return { refused: FOLDER_REFUSED.missing };
  const p = real(expanded);
  if (!statSync(p).isDirectory()) return { refused: FOLDER_REFUSED.missing };
  const h = real(homedir());
  if (p === h) return { refused: FOLDER_REFUSED.home };
  const either = (q: string) => within(p, q) || within(q, p);
  if (touchesSecretStore(p) || either(real(home()))) return { refused: FOLDER_REFUSED.secrets };
  if (either(real(CODE))) return { refused: FOLDER_REFUSED.code };
  const glob = GLOB.exec(p)?.[0];
  if (glob) return { refused: FOLDER_REFUSED.glob(glob) };
  if (!accept && broadFolder(p)) return { warning: FOLDER_WARNING };
  return { real: p };
}

export { changeFolder, gaveFolder };
