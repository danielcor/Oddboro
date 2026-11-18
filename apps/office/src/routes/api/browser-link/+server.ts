// A link for the owner's browser, which has no key. When the app's window
// opens an office address in a new window (a file attached in a chat), the
// shell POSTs `{ path }` here with the key in its header, adds the code to the
// address and opens that. The code works once, for that path only, within a
// minute (`mintLink` in app-key.ts). Only the shell asks: the page has no use
// for one.
import { error, json } from '@sveltejs/kit';
import { fromShell, mintLink } from '#lib/server/app-key.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  if (!fromShell(request)) error(403, 'Only the app makes browser links');
  const b = (await request.json().catch(() => ({}))) as { path?: unknown };
  if (typeof b.path !== 'string' || !b.path.startsWith('/')) error(400, 'Name the path');
  return json({ code: mintLink(b.path) });
};
