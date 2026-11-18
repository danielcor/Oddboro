import { FILE_MAX } from '#lib/attachments.ts';
import { CHAT_REQUEST_BYTES } from '../staff/chat-input.ts';
// Which requests the office answers. It runs on the owner's computer, where
// any web page the owner opens can send it requests, so `guardOffice` (the
// server's `handle` in hooks.server.ts) checks every request before a route
// sees it:
//
// - In the desktop app, first of all, the request must carry the app's key
//   (app-key.ts): the window's cookie, or the shell's header where the shell
//   calls. A sign-in callback, a run's gateway call, the shell's proof
//   request and a link the shell made for the owner's browser pass without it. No other program on the
//   computer has the key, so none can read the office or act in its name.
//   An office run from source has no key and skips this rule.
// - The request must come from this computer (`fromThisComputer`, in
//   this-computer.ts, which Vite's dev server asks first too). Through
//   Caddy, which on a Mac and Linux listens on every address, the connection
//   is always from 127.0.0.1, so the office reads the address Caddy forwards
//   for (X-Forwarded-For), which Caddy writes itself. A program on this
//   computer can write that header too; this check keeps out other machines,
//   not other programs. Every entry counts, since a Caddy that trusts the
//   client appends to what it sent, and an entry that is not a plain address
//   (a port, brackets, a name, empty) counts as another computer.
// - The Host must be one of the office's own names. A page that points a
//   name of its own at 127.0.0.1 (DNS rebinding) counts as same-origin to the
//   browser, so only the name it asked for gives it away.
// - Anything that is not a read (GET, HEAD, OPTIONS) must come from the
//   owner's own page (`fromOwnerPage`), in every mode. SvelteKit's own check
//   covers form posts only, so the office checks every action itself.
//   The other clients are the app's shell, which reports updates to
//   /api/update and asks for browser links at /api/browser-link with the key
//   (`fromShell`), and an Odd's run, which reaches its outside tools through
//   /api/gateway with the token the office gave that run (`fromRun`).
//
// A plain comparison of Origin with the office's own address would refuse the
// owner's page through Caddy, which reaches the office over http while the
// page is https, so `fromOwnerPage` compares what the browser itself says.
import type { Handle } from '@sveltejs/kit/hooks';
import { IN_APP } from '@oddboro/ledger';
import { BACKUP_MAX_BYTES } from '@oddboro/ledger/office-backup';
import {
  fromShell,
  fromWindow,
  LINK_QUERY,
  OPEN_FROM_APP,
  PROOF_PATH,
  takeLink,
  WINDOW_CSP
} from './app-key.ts';
import { HOSTS } from './hosts.ts';
import { fromRun, GATEWAY_PATH } from './gateway.ts';
import { fromThisComputer, NOT_THIS_COMPUTER } from './this-computer.ts';

/**
 * The names the office answers to, without a port: loopback, its addresses
 * through Caddy, and the app's ORIGIN. Names under .localhost reach only this
 * computer, so no other site can point one at the office.
 */
const NAMES = new Set(
  ['127.0.0.1', '[::1]', 'localhost', ...HOSTS, URL.parse(process.env.ORIGIN ?? '')?.hostname]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase())
);

/** True when the request asked for the office by one of its own names, on any port. */
function toThisOffice(request: Request): boolean {
  // `[::1]:4500` gives `[::1]`. Anything that is not exactly a name and a port matches no name.
  const name = (request.headers.get('host') ?? '').replace(/:\d+$/, '');
  return NAMES.has(name.toLowerCase());
}

/**
 * True when the browser says the request comes from the same origin
 * (Sec-Fetch-Site, which no page can set). A browser or webview that sends no
 * Sec-Fetch-Site passes when its Origin names the host it asked (the Host
 * header), whatever the scheme. With neither, it is refused.
 */
export function fromOwnerPage(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  // An Origin that is not a URL ("null", from a sandboxed frame) or none at all names no host.
  return URL.parse(request.headers.get('origin') ?? '')?.host === request.headers.get('host');
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Where the shell's header counts, as the key and as the owner's own page. */
const SHELL_PATHS = new Set(['/api/update', '/api/browser-link']);
/**
 * Where a service's sign-in page sends the owner's browser back, which has no
 * key. Each checks its own state, made for one sign-in and spent on use, and
 * an unknown one finishes nothing.
 */
const CALLBACKS = new Set(['/account/callback', '/connect/callback']);

/**
 * The address the request was sent to. Kit gives `handle` another path in
 * two cases: it takes `/__data.json` off a data request, and a remote
 * function call (`/_app/remote/`) names its page in a header the caller
 * writes. So the rules that let a request in without the page's own headers
 * judge this one, which no header can change.
 */
const sentTo = (request: Request): URL => new URL(request.url);

/** In the app: true when the request carries the key, or is one of the few that come without it. */
function carriesKey(request: Request): boolean {
  const url = sentTo(request);
  const path = url.pathname;
  const get = request.method === 'GET';
  return (
    fromWindow(request) ||
    (SHELL_PATHS.has(path) && fromShell(request)) ||
    (get && CALLBACKS.has(path)) ||
    (get && path === PROOF_PATH) ||
    (path.startsWith(`${GATEWAY_PATH}/`) && fromRun(request)) ||
    (get && takeLink(url.searchParams.get(LINK_QUERY), path))
  );
}

const refuse = (message: string) => new Response(message, { status: 403 });

/** For a chunked request, count as it arrives and leave the body for the route. */
async function fits(request: Request, limit: number): Promise<boolean> {
  const length = request.headers.get('content-length');
  if (length !== null) return Number(length) <= limit;
  const reader = request.clone().body!.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      size += value.length;
      if (size > limit) return false;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** The server's `handle`: every request passes here before a route sees it. */
export const guardOffice: Handle = async ({ event, resolve }) => {
  const { request } = event;
  if (IN_APP && !carriesKey(request)) return refuse(OPEN_FROM_APP);
  if (
    !fromThisComputer({
      forwardedFor: request.headers.get('x-forwarded-for'),
      peer: event.getClientAddress()
    })
  )
    return refuse(NOT_THIS_COMPUTER);
  if (!toThisOffice(request)) return refuse('This office answers only at its own address');
  const path = sentTo(request).pathname;
  if (
    READS.has(request.method) ||
    fromOwnerPage(request) ||
    (SHELL_PATHS.has(path) && fromShell(request)) ||
    (path.startsWith(`${GATEWAY_PATH}/`) && fromRun(request))
  ) {
    const chat =
      request.method === 'POST' && /^\/api\/staff\/[a-z0-9-]+\/chat\/?$/.test(event.url.pathname);
    // Uploads use their existing per-file limit. The larger chat limit
    // includes JSON encoding for inline imports, and never widens other actions.
    const upload =
      request.method === 'POST' &&
      /^\/api\/staff\/[a-z0-9-]+\/attachments\/?$/.test(event.url.pathname);
    // A backup to restore is the whole office, checked as it arrives (office-backup.ts).
    const restore = request.method === 'POST' && event.url.pathname === '/api/backup/restore';
    const limit = chat
      ? CHAT_REQUEST_BYTES
      : upload
        ? FILE_MAX
        : restore
          ? BACKUP_MAX_BYTES
          : 512 * 1024;
    if (
      request.body &&
      (chat || upload || restore || process.env.ODDBORO_APP) &&
      !(await fits(request, limit))
    )
      return new Response('That request is too large', { status: 413 });
    const response = await resolve(event);
    const page = /^text\/html/.test(response.headers.get('content-type') ?? '');
    if (IN_APP && page && !response.headers.has('content-security-policy'))
      response.headers.set('content-security-policy', WINDOW_CSP);
    return response;
  }
  return refuse("Only the office's own page can do that");
};
