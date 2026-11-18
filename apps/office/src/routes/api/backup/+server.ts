// The owner's backup of the office: GET makes the file and sends it as a
// download (`#lib/server/office-backup.ts`). POST closes the line the page
// shows after a restore.
import { json } from '@sveltejs/kit';
import { forgetRestore } from '@oddboro/ledger/office-backup';
import { backupResponse } from '#lib/server/office-backup.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => backupResponse();

export const POST: RequestHandler = () => {
  forgetRestore();
  return json({ ok: true });
};
