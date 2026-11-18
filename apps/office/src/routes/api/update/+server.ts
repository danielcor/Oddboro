// The app's updates. The shell (apps/desktop) POSTs `{ version, notes }` when
// it has a new version downloaded and checked, `{ checked: true }` when it
// found none, or `{ failed }` when it could not look, and GETs every 30
// seconds until `install` is true. Only the shell may do those: from this
// computer, with the app's key in its header (`fromShell`). The Setup window
// GETs the same answer and POSTs `{ action }`: `check`, `install-now` or
// `install-tonight`. PUT sets the owner's window, `{ start, end }` as HH:MM
// in office time.
import { error, json } from '@sveltejs/kit';
import { isClock } from '@oddboro/ledger';
import { fromShell } from '#lib/server/app-key.ts';
import {
  askShellToCheck,
  checked,
  installWhen,
  ready,
  setWindow,
  status
} from '#lib/server/update.ts';
import type { RequestHandler } from './$types';

const VERSION = /^\d+\.\d+\.\d+$/;

export const GET: RequestHandler = async ({ request }) => json(await status(fromShell(request)));

export const POST: RequestHandler = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as {
    version?: unknown;
    notes?: unknown;
    checked?: unknown;
    failed?: unknown;
    action?: unknown;
  };
  const shell = fromShell(request);
  if (b.version !== undefined || b.checked !== undefined || b.failed !== undefined) {
    if (!shell) error(403, 'Only the app reports updates');
    if (b.version !== undefined) {
      if (typeof b.version !== 'string' || !VERSION.test(b.version))
        error(400, 'Say the version as x.y.z');
      await ready(b.version, typeof b.notes === 'string' ? b.notes.slice(0, 4000) : '');
    } else checked(typeof b.failed === 'string' ? b.failed || 'The check failed' : undefined);
    return json(await status(true));
  }
  if (!['check', 'install-now', 'install-tonight'].includes(b.action as string))
    error(400, 'Say check, install-now or install-tonight');
  try {
    if (b.action === 'check') askShellToCheck();
    else await installWhen(b.action === 'install-now' ? 'now' : 'tonight');
  } catch (e) {
    error(409, e instanceof Error ? e.message : String(e));
  }
  return json(await status());
};

export const PUT: RequestHandler = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { start?: unknown; end?: unknown };
  if (!isClock(b.start) || !isClock(b.end)) error(400, 'Say the window as HH:MM to HH:MM');
  if (b.start === b.end) error(400, 'The window needs a start and a later end');
  await setWindow(b.start, b.end);
  return json(await status());
};
