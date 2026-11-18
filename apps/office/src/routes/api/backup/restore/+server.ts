// Restore a backup: the file's bytes as the body, checked whole before
// anything changes, then the office starts again to put it in place
// (`#lib/server/office-backup.ts`). A POST from the owner's own page only,
// as every action is (`guardOffice`).
import { restoreFrom } from '#lib/server/office-backup.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request }) => restoreFrom(request);
