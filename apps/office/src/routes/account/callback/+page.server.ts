// Where New Altitude's sign-in page sends the owner back, from the account's
// sign-in or a persona's: the state says which. Trades the code for the
// sign-in; every open office page hears the change on its live line. Every
// failure is a message here, never a throw.
import {
  accountStatus,
  finishAccountSignIn,
  pendingSignIn,
  SignInRefused
} from '#lib/server/account.ts';
import { endPersonaGrants, finishPersonaGrant, personaOf } from '#lib/server/persona.ts';
import { signInRefusal } from '#lib/server/sign-in-refusal.ts';
import type { PageServerLoad } from './$types';

const failed = (message: string) => ({ ok: false, title: 'Not signed in', message });

export const load: PageServerLoad = async ({ url }) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');
  const persona = state ? personaOf(pendingSignIn(state)) : undefined;
  // A persona's sign-in starts at its Add or Reconnect, the account's at Sign in.
  const again = persona
    ? 'Press Add or Reconnect in Oddboro again.'
    : 'Try Sign in again from Oddboro.';
  if (denied) return failed(signInRefusal('New Altitude', denied, again));
  if (!code || !state) return failed(`The sign-in came back without a code. ${again}`);
  try {
    if (persona) {
      await finishPersonaGrant(persona, state, code);
      return {
        ok: true,
        title: 'Connected',
        message: 'Your persona can now work in your office. You can close this tab.'
      };
    }
    const { email } = await finishAccountSignIn(state, code);
    return {
      ok: true,
      title: 'Signed in',
      message: `You are signed in to New Altitude as ${email}. You can close this tab.`
    };
  } catch (e) {
    // An account sign-in New Altitude would not name signs the account out
    // (finishAccountSignIn); each persona's sign-in ends with it, as at the
    // owner's own sign-out. Ending them again when the account was already out
    // changes nothing.
    if (!persona && accountStatus().state === 'out')
      await endPersonaGrants().catch((err) =>
        console.error("[persona] the personas' sign-ins did not end", err)
      );
    if (e instanceof SignInRefused) return failed(e.message);
    console.error(persona ? '[persona]' : '[account]', e);
    return failed(`New Altitude did not finish the sign-in. ${again}`);
  }
};
