// What the office tells a test or a bug report about itself: each startup
// step and how long it took (also written as an `office:` line, which the
// app's shell keeps in office.log), how many pages hold the live line, and
// how many errors pages have reported. GET /api/health serves it, and
// POST /api/client-log brings the page's own reports here.

import { homedir } from 'node:os';

/** At most this many page lines a minute, so a page stuck in a loop cannot fill the log. */
export const PAGE_LINES_PER_MINUTE = 30;
const PAGE_LINE_MAX = 600;

const steps: Record<string, number> = {};
let readyMs: number | undefined;
let pages = 0;
let pageErrors = 0;
let minute = 0;
let pageLines = 0;

/** Runs one startup step and records how long it took. */
export async function timed<T>(name: string, step: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  let result: T;
  try {
    result = await step();
  } catch (e) {
    console.error(`office: ${name} failed`);
    throw e;
  }
  steps[name] = Math.round(performance.now() - started);
  console.log(`office: ${name} in ${steps[name]} ms`);
  return result;
}

/**
 * In the app, one line per setup check the page asked for: `office: setup
 * <id> ok`, or `fail` for anything not ok. Only the check's id and whether it
 * passed, never what it found, so the log names no path, version or account.
 * The release smoke test reads them, since the app's office answers it
 * nothing without the app's key. Written only when a request computes the
 * checks, never on a timer.
 */
export function logSetup(
  checks: { id: string; state: string }[],
  inApp = process.env.ODDBORO_APP === '1'
): void {
  if (!inApp) return;
  for (const c of checks)
    console.log(
      `office: setup ${c.id.replace(/[^a-z0-9-]/gi, '')} ${c.state === 'ok' ? 'ok' : 'fail'}`
    );
}

/** The office answers from here on. Node's own start counts too. */
export function markReady(): void {
  readyMs = Math.round(process.uptime() * 1000);
  console.log(`office: ready ${readyMs} ms after Node started`);
}

export function pageOpened(): void {
  pages++;
}

export function pageClosed(): void {
  pages = Math.max(0, pages - 1);
}

/**
 * One `page:` line, cut short. `oddboro:` is what the app's shell watches
 * stdout for (notifications, Keychain requests, Check now), so a page can
 * never say it.
 */
export function pageLine(kind: string, text: string): string {
  return `page: ${kind} ${defused(text).slice(0, PAGE_LINE_MAX)}`;
}

const defused = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/oddboro:/gi, 'oddboro_')
    .trim();

const RUN_ERROR_MAX = 200;

/**
 * The log's line for a run that failed or was stopped: the Odd, the kind of
 * run, and only the first line of what went wrong, cut short, with the home
 * folder as `~`. Never the owner's message or the Odd's reply. Logs go into
 * bug reports, and a tool's error can name a file under the home folder.
 */
export function runEndLine(
  odd: string,
  kind: string,
  r: { text: string; interrupted?: true },
  home = homedir()
): string {
  const text = home ? r.text.replaceAll(home, '~') : r.text;
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const why = defused(first).slice(0, RUN_ERROR_MAX) || 'no reason given';
  return `office: ${defused(odd)}'s ${kind} run ${r.interrupted ? 'stopped' : 'failed'}: ${why}`;
}

/** A page's report: counted if an error, logged unless this minute's lines are spent. */
export function pageReport(
  kind: 'boot' | 'error',
  text: string,
  now = Date.now()
): { logged: boolean } {
  if (kind === 'error') pageErrors++;
  const thisMinute = Math.floor(now / 60_000);
  if (thisMinute !== minute) {
    minute = thisMinute;
    pageLines = 0;
  }
  if (++pageLines > PAGE_LINES_PER_MINUTE) return { logged: false };
  console.log(pageLine(kind, text));
  return { logged: true };
}

export function health() {
  return {
    version: process.env.ODDBORO_VERSION || 'development',
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    readyMs: readyMs ?? null,
    steps: { ...steps },
    pages,
    pageErrors
  };
}
