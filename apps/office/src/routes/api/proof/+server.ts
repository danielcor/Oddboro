// The app's shell asks here, before it trusts the server on the port, that
// the server holds the key it gave this start of Node: `GET ?nonce=<64 hex
// digits>`, answered with HMAC-SHA256 of the key, a label and the nonce
// (`proof` in app-key.ts). It passes the guard without the key, since the
// shell sends none until the server has proved itself. The answer says
// nothing of the key, and is good for nothing but this.
import { error } from '@sveltejs/kit';
import { proof } from '#lib/server/app-key.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
  const answer = proof(url.searchParams.get('nonce') ?? '');
  if (!answer) error(400, 'Send a nonce of 64 hex digits, to an office in the app');
  return new Response(answer, {
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }
  });
};
