// A staffer's job description, for the Jobs tab: GET reads it, PUT saves
// the owner's edit. The ledger keeps the old and new versions. When the edit
// came from a changed Claude Code agent file, POST says which of its servers
// Save would ask for, and PUT raises those asks once the text is saved, as a
// hire does (`askForImported`). Never for the Office Manager or a persona.
import { error, json } from '@sveltejs/kit';
import { MANAGER_ROLE, setDescription, staffer } from '@oddboro/ledger';
import { askForImported, serversFrom, sortFor } from '#lib/server/imported-servers.ts';
import type { RequestHandler } from './$types';

/** The Odd, and whether an agent file's servers may become asks for it. */
async function odd(id: string) {
  const who = await staffer(id);
  if (!who) error(404, 'No such Odd');
  return { who, takesFile: who.role !== MANAGER_ROLE && !who.package };
}

export const GET: RequestHandler = async ({ params }) => {
  const { who } = await odd(params.id);
  return json({ text: who.desk });
};

export const POST: RequestHandler = async ({ params, request }) => {
  const b = (await request.json().catch(() => ({}))) as { servers?: unknown };
  const { takesFile } = await odd(params.id);
  if (!takesFile) error(400, 'This Odd does not take an agent file');
  return json(await sortFor(params.id, serversFrom(b.servers)));
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const b = (await request.json().catch(() => ({}))) as {
    text?: unknown;
    was?: unknown;
    servers?: unknown;
  };
  if (typeof b.text !== 'string' || typeof b.was !== 'string') error(400, 'Nothing to save');
  let saved: boolean;
  try {
    saved = await setDescription(params.id, b.text, { owner: true, was: b.was });
  } catch (e) {
    error(409, e instanceof Error ? e.message : String(e));
  }
  const { who, takesFile } = await odd(params.id);
  // Only once the text is saved: a stale save asks for nothing.
  if (saved && takesFile)
    await askForImported(who.id, who.name, serversFrom(b.servers)).catch((e: unknown) =>
      console.error(
        `[description] access asks for ${who.id}: ${e instanceof Error ? e.message : e}`
      )
    );
  return json({ text: who.desk });
};
