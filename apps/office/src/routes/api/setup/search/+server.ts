// The search model, which Setup's ledger search line downloads when the owner
// clicks Download. POST downloads it, checks every file against its pinned
// SHA-256, and answers with the line as it stands once that is done. Then the
// office makes every ledger row's vector again in the background.
import { error, json } from '@sveltejs/kit';
import { reindexLedger } from '@oddboro/ledger';
import { checkSearch } from '@oddboro/ledger/checks';
import { forgetModel } from '@oddboro/ledger/embed';
import { downloadModel } from '@oddboro/ledger/search-model';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
  try {
    await downloadModel();
  } catch (e) {
    error(502, e instanceof Error ? e.message : String(e));
  }
  forgetModel();
  const check = await checkSearch();
  if (check.state === 'ok')
    void reindexLedger().catch((e: unknown) =>
      console.error('office: the ledger re-index stopped:', e)
    );
  return json(check);
};
