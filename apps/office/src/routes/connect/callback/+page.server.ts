// Where a hosted server's sign-in page sends the owner back. Trades the code for
// tokens; the steps on their desk tick themselves.
import { finishSignIn } from '#lib/server/oauth.ts';
import { signInRefusal } from '#lib/server/sign-in-refusal.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');
  const failed = (message: string) => ({ ok: false, title: 'Not connected', message });
  if (denied) return failed(signInRefusal('The service', denied, 'Try Sign in again.'));
  if (!code || !state) return failed('The sign-in came back without a code. Try Sign in again.');
  try {
    await finishSignIn(state, code);
    return {
      ok: true,
      title: 'Connected',
      message: 'You can close this tab. The step on your desk ticked itself.'
    };
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
};
