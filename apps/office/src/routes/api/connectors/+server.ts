// Tools a staffer could be given: the office catalog, plus the public MCP
// Registry when there is a search.
import { json } from '@sveltejs/kit';
import { BUILT_IN, catalog, GOOGLE, POSTAL_ID, searchRegistry } from '@oddboro/ledger';
import { knownTools } from '#lib/server/imported-servers.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const saved = await catalog();
  const own = [
    ...saved,
    ...BUILT_IN.filter((b) => b.id === POSTAL_ID && !saved.some((c) => c.id === b.id)).map((b) => ({
      ...b,
      config: b.config ?? {},
      readyAt: null
    }))
  ].map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    kind: c.kind,
    ready: !!c.readyAt,
    /** A hosted server named by its address, so the owner picks how it lets the office in. */
    byAddress: c.id !== POSTAL_ID && c.kind === 'http' && !c.registry,
    keyHeader: c.config.oauth ? undefined : c.config.headers?.[0],
    /** A Google connector's product, its plain name and signed-in address, so the owner can add another account. */
    google: c.config.google
      ? {
          product: c.config.google,
          name: GOOGLE[c.config.google].name,
          account: c.config.account
        }
      : undefined
  }));
  let registry: Awaited<ReturnType<typeof searchRegistry>> = [];
  let problem: string | undefined;
  if (q)
    try {
      registry = (await searchRegistry(q)).filter(
        (c) => !saved.some((o) => o.registry === c.registry || o.id === c.registry)
      );
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  // Every tool a name in an imported agent file can match, so the hire window sorts as the hire does.
  return json({ catalog: own, registry, problem, known: await knownTools() });
};
