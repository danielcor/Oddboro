// The app's key. In the desktop app (ODDBORO_APP) the office answers only
// requests that carry it, so no other program on the computer can read the
// office or act in the owner's name (`guardOffice` in owner-page.ts).
//
// The shell makes a fresh random key every time it starts this server and
// keeps it in memory. It hands it over as the first line on the server's
// stdin, a pipe only the two of them hold, and this server keeps it in memory
// too. A key that leaks once its server is gone opens nothing. It is
// never in a file, the environment, a command line, a URL or a log line: any
// program running as the owner can read another's environment (`ps -E`).
//
// Three things carry it back:
// - The app's window: an HttpOnly, SameSite=Strict session cookie the shell
//   sets in the webview before it opens the office. No page script can read it.
// - The shell's own requests (`/api/update`, `/api/browser-link`): a header.
// - The owner's own browser has no key. When the window opens an office
//   address there (a file attached in a chat), the shell asks for a link that
//   works once, for that path only, within a minute (`mintLink`).
//
// Before the shell trusts a server on the port, the server proves it holds
// the key (`proof`): it answers a fresh nonce with HMAC-SHA256(key,
// "oddboro-proof:" + nonce). A program that took the port cannot, so the
// window never sends it the cookie.
//
// An office run from source (npm run dev, setup, the login service) has no
// key and keeps the other rules alone.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';

/** The first line the shell writes on the server's stdin: this, then the key. */
export const KEY_LINE = 'oddboro:key ';
/** The cookie the shell sets in the app's window. */
export const KEY_COOKIE = 'oddboro-key';
/** The header the shell's own requests carry. */
export const KEY_HEADER = 'x-oddboro-key';
/** The query a link for the owner's browser carries. */
export const LINK_QUERY = 'oddboro-link';
/** How long a link for the owner's browser works, once. */
export const LINK_MS = 60_000;
/** Where the shell asks the server to prove it holds the key. */
export const PROOF_PATH = '/api/proof';
/** What the proof signs before the nonce, so the answer is good for nothing else. */
const PROOF_LABEL = 'oddboro-proof:';
/** What a request without the key gets: a browser shows it as a plain page. */
export const OPEN_FROM_APP = 'This office opens only in the Oddboro app. Open Oddboro to see it.';

/** 32 random bytes as hex, as the shell makes it. */
const SHAPE = /^[0-9a-f]{64}$/;
/** How long the server waits for the key before it starts without one, refusing everything. */
const KEY_WAIT_MS = 10_000;

let key: Buffer | undefined;

/**
 * Reads the key from the first line on `input`, the server's stdin. Resolves
 * true once it has one, and false when the first line is not a key, the pipe
 * closes, or nothing comes within 10 seconds. Nothing else comes on the pipe
 * until the office asks the shell something (secrets.ts), which it does only
 * after this.
 */
export function readKey(input: Readable, waitMs = KEY_WAIT_MS): Promise<boolean> {
  return new Promise((done) => {
    let held = '';
    const finish = (line?: string) => {
      input.off('data', take);
      input.off('close', closed);
      clearTimeout(timer);
      const sent = line?.startsWith(KEY_LINE) ? line.slice(KEY_LINE.length).trim() : '';
      key = SHAPE.test(sent) ? Buffer.from(sent) : undefined;
      done(!!key);
    };
    const take = (chunk: Buffer | string) => {
      held += chunk.toString();
      const end = held.indexOf('\n');
      if (end >= 0) finish(held.slice(0, end));
      // A first line this long is no key.
      else if (held.length > 1024) finish();
    };
    const closed = () => finish();
    const timer = setTimeout(finish, waitMs);
    input.on('data', take);
    input.once('close', closed);
  });
}

/**
 * The answer to the shell's nonce: HMAC-SHA256 under the key of the label
 * and the nonce, as hex. Undefined while there is no key, or for anything but
 * 64 hex digits, the nonce's shape. It says nothing of the key itself.
 */
export function proof(nonce: string): string | undefined {
  if (!key || !SHAPE.test(nonce)) return undefined;
  return createHmac('sha256', key)
    .update(PROOF_LABEL + nonce)
    .digest('hex');
}

/** True when `sent` is the key, compared in constant time. False while there is none. */
function isKey(sent: string | null | undefined): boolean {
  if (!key || !sent) return false;
  const given = Buffer.from(sent);
  return given.length === key.length && timingSafeEqual(given, key);
}

/** Every value of the cookie `name` in a Cookie header. */
function cookies(header: string | null, name: string): string[] {
  return (header ?? '').split(';').flatMap((part) => {
    const at = part.indexOf('=');
    return at > 0 && part.slice(0, at).trim() === name ? [part.slice(at + 1).trim()] : [];
  });
}

/** True when the request comes from the app's window: its cookie holds the key. */
export const fromWindow = (request: Request): boolean =>
  cookies(request.headers.get('cookie'), KEY_COOKIE).some(isKey);

/** True when the request comes from the app's shell: its header holds the key. */
export const fromShell = (request: Request): boolean => isKey(request.headers.get(KEY_HEADER));

const links = new Map<string, { path: string; until: number }>();

/** A link's path as the office reads a request's: percent-encoded, no query. */
const pathOf = (path: string) => new URL(path, 'http://office').pathname;

/** A code that lets the owner's browser GET `path` once, within a minute. */
export function mintLink(path: string, now = Date.now()): string {
  for (const [code, l] of links) if (l.until < now) links.delete(code);
  const code = randomBytes(32).toString('base64url');
  links.set(code, { path: pathOf(path), until: now + LINK_MS });
  return code;
}

/** True when `code` was made for `path` and is fresh. Asking spends it, whatever the answer. */
export function takeLink(code: string | null, path: string, now = Date.now()): boolean {
  const l = code ? links.get(code) : undefined;
  if (!l) return false;
  links.delete(code!);
  return l.until >= now && l.path === path;
}

/**
 * The window's page may load and connect only to the office itself, data and
 * blob addresses, and https. A cookie names a host but no port, so without
 * this a picture in an Odd's reply at another port on 127.0.0.1 would carry
 * the key to whatever program listens there.
 */
export const WINDOW_CSP = [
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "form-action 'self'"
].join('; ');
