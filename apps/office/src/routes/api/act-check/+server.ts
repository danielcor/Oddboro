// The owner's answers to the Act check (act-check.ts in the ledger), from the
// check the page shows before an Odd's first raise to Act. The office checks
// them, not the page: all right, the pass is kept once, with one ledger line;
// any wrong, nothing changes and their positions come back.
import { error, json } from '@sveltejs/kit';
import { passActCheck } from '@oddboro/ledger';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { answers?: unknown };
  let wrong: number[];
  try {
    ({ wrong } = await passActCheck(b.answers));
  } catch (e) {
    error(400, e instanceof Error ? e.message : String(e));
  }
  return json({ passed: !wrong.length, wrong });
};
