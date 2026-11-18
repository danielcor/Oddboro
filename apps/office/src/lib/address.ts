// The office's address as the server says it stands (`address()` in
// lib/server/address.ts) and as Setup's first card shows it. The page loads
// this file too, so it imports nothing.

/** How the address stands, with the name it uses and the office's own port. */
export type Address = { host: string; port: number } & (
  | {
      state: 'ready';
      url: string;
      /** Served over HTTPS with a certificate this computer trusts. */
      secure: boolean;
      /** Served over HTTPS, waiting only for this computer to trust Caddy's authority. */
      canSecure: boolean;
    }
  | { state: 'own'; installed: boolean }
  | { state: 'shared' }
  | { state: 'blocked'; holder: string }
  /** The office could not look at port 80, so it keeps its port rather than guess. */
  | { state: 'unchecked' }
);

/**
 * The address the card shows. While port 80 is another program's, or the
 * office could not look, the office stays at its own port, which moves with
 * `ODDBORO_PORT`, so the port comes from the server.
 */
export function shownAddress(a: Address): string {
  return a.state === 'blocked' || a.state === 'unchecked' ? `${a.host}:${a.port}` : a.host;
}
