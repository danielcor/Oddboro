// Once, when the office server starts: the certificates this computer trusts
// (`trustSystemCertificates`), the office home closed to other accounts
// (`makeHomePrivate`), the office's own database if .env names
// no other (copied aside first on a new version's first start), the tables
// brought up to date, the update row reset, then the job clock, the follow-up
// watcher, the rest of a ledger re-index if one is owed, one read of the New Altitude personas, and the office's address in
// the owner's Caddy if it uses theirs (never in the app, which has no address).
// Each step's time goes to the log and to /api/health (`#lib/server/health.ts`).
// In the app (ODDBORO_APP) it also quits when the app does: on SIGTERM, once
// the HTTP server has closed, and when the app's stdin pipe closes, which
// happens however the app ends, Force Quit included. The first line on that
// pipe is the app's key, which every request in the app must carry
// (`#lib/server/app-key.ts`); the office waits for it before anything else.
// On a Mac it keeps its secrets through the app's shell, over those same
// pipes (`useShellSecrets`).
// Every route and API request passes `guardOffice` first: in the app only
// with the key, only from this computer, at the office's own names, and
// actions only from the owner's page (`#lib/server/owner-page.ts`).
// Files built into the page (scripts, styles, images) are served before it.
// Then Sentry's handle, which traces the request when the owner said yes to diagnostics.
import { release } from 'node:os';
import { sequence, type ServerInit } from '@sveltejs/kit/hooks';
import { handleErrorWithSentry, sentryHandle } from '@sentry/sveltekit';
import { IN_APP, LOCAL, makeHomePrivate, reindexLedger, whenOddLeaves } from '@oddboro/ledger';
import { home, OFFICE_PORT } from '@oddboro/ledger/home';
import { trustSystemCertificates } from '@oddboro/ledger/certificates';
import { startLocalDatabase } from '@oddboro/ledger/local-db';
import { currentPlatform } from '@oddboro/ledger/platform';
import { useShellSecrets } from '@oddboro/ledger/secrets';
import { bringUpToDate } from '@oddboro/ledger/upgrade';
import { keepAddress } from '#lib/server/address.ts';
import { readKey } from '#lib/server/app-key.ts';
import { startFollowUps } from '#lib/server/follow-ups.ts';
import { markReady, timed } from '#lib/server/health.ts';
import { stopRuns } from '#lib/server/staff.ts';
import { startClock } from '#lib/server/jobs.ts';
import { guardOffice } from '#lib/server/owner-page.ts';
import { syncPersonas } from '#lib/server/persona.ts';
import { loadUpdate, VERSION } from '#lib/server/update.ts';

// The guard first, so a refused request reaches neither Sentry nor a route.
// Kit 3 needs no fetch proxy script; saying so keeps the handle from
// importing `@sveltejs/kit` to find out.
export const handle = sequence(guardOffice, sentryHandle({ injectFetchProxyScript: false }));
export const handleError = handleErrorWithSentry();

// Before anything reaches out: New Altitude, a connector, a model, Sentry.
trustSystemCertificates();

// Listening before the pipe flows, so the key's line is never dropped.
const keyRead = IN_APP ? readKey(process.stdin) : Promise.resolve(true);
if (process.env.ODDBORO_APP) {
  process.on('sveltekit:shutdown', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0)).resume();
}

export const init: ServerInit = async () => {
  console.log(
    `office: ${VERSION || 'development'} on ${currentPlatform()} ${release()} ${process.arch}, Node ${process.version}`
  );
  // In the app, the port and home the office ended up on, beside the shell's
  // own launch line, so the release smoke test can hold the two together
  // (NEW-1694). The log stays on this computer; /api/health leaves the home
  // out, since a bug report carries that and the home names the account.
  if (IN_APP) console.log(`office: port ${OFFICE_PORT}, home ${home()}`);
  // Before the office writes anything there, the database's socket included.
  makeHomePrivate();
  // The key comes first on the pipe, before any answer about secrets.
  if (IN_APP && !(await timed('key', () => keyRead)))
    console.error('office: the app gave no key, so the office answers nothing');
  // In the Mac app the shell keeps the secrets; this process alone asks it.
  await timed('secrets', useShellSecrets);
  if (LOCAL) await timed('database', startLocalDatabase);
  await timed('tables', bringUpToDate);
  // Before the clock: a poke that came due while the app updated still lands.
  await timed('update row', loadUpdate);
  startClock();
  startFollowUps();
  // A re-index the office stopped partway, or one for rows written while the
  // model could not run. Nothing to do, and it does nothing, once every row is done.
  void reindexLedger().catch((e: unknown) =>
    console.error('office: the ledger re-index stopped:', e)
  );
  // An Odd that leaves the office stops what it is running at once.
  whenOddLeaves(stopRuns);
  // Never awaited: an office offline or signed out starts as fast as any.
  void syncPersonas().catch((e) => console.error('[persona] sync at start', e));
  void keepAddress();
  markReady();
};
