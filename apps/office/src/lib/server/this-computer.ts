// Whether a request comes from this computer, the office's first rule (why it
// reads X-Forwarded-For is in owner-page.ts). Two doors ask it: `guardOffice`
// for every route, and under `vite dev` the `onlyThisComputer` plugin in
// vite.config.ts, which runs before Vite's own routes and its live-reload
// websocket. The config loads this file, so it imports only `node:net`.
import { isIPv4 } from 'node:net';

/** What the office answers a request from another computer, at either door. */
export const NOT_THIS_COMPUTER = 'This office answers only its own computer';

/**
 * True when the connection (`peer`) and every entry of the X-Forwarded-For
 * header (`forwardedFor`) are loopback (127.0.0.0/8, ::1, ::ffff:127.x).
 */
export function fromThisComputer({
  forwardedFor,
  peer
}: {
  forwardedFor: string | null | undefined;
  peer: string;
}): boolean {
  const hops = forwardedFor?.split(',') ?? [];
  return [peer, ...hops].every((hop) => {
    const address = hop.trim().toLowerCase();
    const v4 = address.replace(/^::ffff:/, '');
    return address === '::1' || (isIPv4(v4) && v4.startsWith('127.'));
  });
}
