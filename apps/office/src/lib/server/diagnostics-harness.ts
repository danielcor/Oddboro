// Test-only: the report tests import it, and no office module does.
// A temp office, a fake door that records every request, and requests
// through the server's real `handle`. Its name does not end in .test.ts, so
// `npm test` never runs it as a test.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { parseEnvelope } from '@sentry/core';

// Kit ships no types for its internal module, so the one function used is
// typed here, from `kit/src/exports/internal/server/event.js`.
const { with_request_store } = (await import('@sveltejs/kit/internal/server' as string)) as {
  with_request_store: <T>(store: unknown, fn: () => T) => T;
};

export type Got = { method: string; url: string; headers: IncomingHttpHeaders; body: string };

/** A server on a free port that records every request, its body gunzipped. */
export async function recorder(): Promise<{ port: number; got: Got[]; close: () => void }> {
  const got: Got[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
      got.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: `${body}`
      });
      res.end('{}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  return { port, got, close: () => server.close() };
}

/**
 * A temp home and settings file, set in the environment before the office's
 * modules load. The database is one nothing listens on (a socket in the temp
 * home, or port 9 on Windows), so a test that queries must start its own; none
 * ever reaches the owner's office.
 */
export function tempOffice(prefix: string): { folder: string; settings: string } {
  const folder = mkdtempSync(join(tmpdir(), `oddboro-${prefix}-`));
  const settings = join(folder, 'settings');
  writeFileSync(settings, '');
  Object.assign(process.env, {
    ODDBORO_HOME: folder,
    ODDBORO_ENV: settings,
    ODDBORO_DB_PORT: '9',
    ODDBORO_LOCAL_DB: '1'
  });
  delete process.env.OFFICE_DIAGNOSTICS;
  delete process.env.ODDBORO_DIAGNOSTICS_DSN;
  return { folder, settings };
}

/** A `sentry-trace` header saying the caller sampled this trace (or not). */
export const traceHeader = (sampled = true) =>
  `${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-${sampled ? 1 : 0}`;

export type Route = (event: RequestEvent) => Response | Promise<Response>;
export type Sent = {
  /** The origin the request reaches the office on: `http://127.0.0.1:4500` unless set. */
  origin?: string;
  route: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  resolve?: Route;
};

/** What the owner's page sends with an action. */
export const PAGE = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4500' };

export const throwing =
  (error: () => unknown): Route =>
  () => {
    throw error();
  };

/**
 * Requests through `handle`: each gives its status, and whether the route
 * ran. Unsampled unless the test says otherwise, so the 0.1 rate never adds
 * a trace a count did not expect.
 */
export function sender(handle: Handle) {
  return async (s: Sent): Promise<{ status: number; ran: boolean }> => {
    const method = s.method ?? 'GET';
    const url = new URL(s.path ?? s.route, s.origin ?? 'http://127.0.0.1:4500');
    const request = new Request(url, {
      method,
      headers: { host: url.host, 'sentry-trace': traceHeader(false), ...s.headers },
      body: method === 'GET' ? undefined : s.body
    });
    // Sentry's handle passes a request with no route id straight through, and
    // reads `locals`.
    const event = {
      request,
      url: new URL(request.url),
      params: {},
      route: { id: s.route },
      locals: {},
      isSubRequest: false,
      getClientAddress: () => '127.0.0.1'
    } as unknown as RequestEvent;
    let ran = false;
    try {
      // Kit's `respond` gives each request a store, which `sequence` reads.
      // `state` is Kit's internal shape, and `sequence` only passes it on.
      const res = await with_request_store({ event, state: {} }, () =>
        handle({
          event,
          resolve: async (e: RequestEvent) => {
            ran = true;
            return (s.resolve ?? (() => new Response('ok')))(e);
          }
        })
      );
      return { status: res.status, ran };
    } catch (e) {
      // A route's `error()` throws; Kit turns it into this status. Anything else is a 500.
      return { status: (e as { status?: number }).status ?? 500, ran };
    }
  };
}

export const ENVELOPE_PATH = '/oddboro/api/0/envelope/';
/** An item as the door got it. Each test reads the payload as its type's shape. */
export type Item = [header: { type: string; item_count?: number }, payload: unknown];
export const items = (got: Got[]): Item[] =>
  got.flatMap((g): readonly Item[] => parseEnvelope(g.body)[1]);
export const ofType = (got: Got[], type: string) => items(got).filter(([h]) => h.type === type);

/** Wait until `done` holds, for reports the SDK sends in several pieces. */
export async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}
