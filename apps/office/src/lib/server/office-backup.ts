// The owner's backup and restore, from Settings and from a new office's
// first card. What a backup holds and how a restore applies are in the
// ledger (`@oddboro/ledger/office-backup`). This file makes the file for the
// page, takes one back, and starts the office again so the restore goes in
// while the database is closed: in the app the shell starts it again within
// a second (apps/desktop, "Restarts Node when it dies"), and under the login
// service launchd, systemd or the task's loop does. An office started by
// hand in a terminal stops, and goes in at its next start.
import { LOCAL, pg } from '@oddboro/ledger';
import { dumpLocalDatabase, startLocalDatabase } from '@oddboro/ledger/local-db';
import {
  backupName,
  backupStream,
  BackupRefused,
  stageRestore
} from '@oddboro/ledger/office-backup';
import { officeDay } from '@oddboro/ledger/time';
import { Readable } from 'node:stream';
import { stopEveryRun } from './run-state.ts';

/** What the page says when the office keeps its records in a database .env names. */
export const OUTSIDE_DATABASE =
  "This office keeps its records in the database your .env names. Backups here cover only the office's own database, so back that one up with its own tools.";

/** The backup as a download: the gzipped tar, named for today in the office's time zone. */
export async function backupResponse(): Promise<Response> {
  if (!LOCAL) return new Response(OUTSIDE_DATABASE, { status: 409 });
  const dump = await dumpLocalDatabase();
  const [row] = await pg<{ at: string | null }[]>`
    select max(created_at)::text as at from drizzle.__drizzle_migrations`;
  const name = backupName(officeDay(new Date()));
  const body = Readable.toWeb(backupStream(dump, Number(row?.at ?? 0))) as ReadableStream;
  return new Response(body, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store'
    }
  });
}

/**
 * Take a backup from the request's body and stage it, then start the office
 * again. A refused file gets its one sentence and changes nothing.
 */
export async function restoreFrom(request: Request): Promise<Response> {
  if (!LOCAL) return new Response(OUTSIDE_DATABASE, { status: 409 });
  if (!request.body) return new Response('Pick a backup file.', { status: 400 });
  try {
    await stageRestore(request.body as unknown as AsyncIterable<Uint8Array>);
  } catch (e) {
    if (e instanceof BackupRefused) return new Response(e.message, { status: 400 });
    throw e;
  }
  startAgainSoon();
  return Response.json({ ok: true });
}

/** After the answer leaves: stop every run, close the database, and end, to be started again. */
function startAgainSoon(): void {
  setTimeout(() => {
    console.log('office: starting again to restore a backup');
    stopEveryRun();
    void startLocalDatabase()
      .then((stop) => stop())
      .catch((e) => console.error('office: closing the database before a restore', e))
      .finally(() => process.exit(0));
  }, 300);
}
