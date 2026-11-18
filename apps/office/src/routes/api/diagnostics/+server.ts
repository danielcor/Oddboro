// The owner's answer about error and trace reports. PUT `{ answer }`, yes or
// no, keeps it in the office's settings file and in this process, so the
// gate (`#lib/server/diagnostics.ts`) honours it from the next report on.
import { OFFICE_LOG } from '@oddboro/ledger';
import { supportReport } from '#lib/server/support-report.js';
import { error, json } from '@sveltejs/kit';
import { writeEnv } from '@oddboro/ledger/env';
import { answerFrom } from '#lib/diagnostics.ts';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request }) => {
  const body: unknown = await request.json().catch(() => undefined);
  const answer = answerFrom(body && typeof body === 'object' && 'answer' in body && body.answer);
  if (answer === 'unasked') error(400, 'Answer yes or no');
  writeEnv({ OFFICE_DIAGNOSTICS: answer });
  process.env.OFFICE_DIAGNOSTICS = answer;
  return json({ answer });
};

/** Save a local support report even when online reporting is off. */
export const GET: RequestHandler = async () => {
  const file = process.env.ODDBORO_LOG || OFFICE_LOG;
  return new Response(await supportReport(file, process.env.ODDBORO_VERSION || 'development'), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="oddboro-support.txt"',
      'cache-control': 'no-store'
    }
  });
};
