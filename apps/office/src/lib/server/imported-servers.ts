// The MCP servers a Claude Code agent file listed, at hire or when the owner
// saves a changed file's instructions on an Odd it already has. Each web
// address, and each name the office's tools already have, becomes an access
// ask at read on the owner's desk, the same ask `ask_for_access` raises.
// Nothing is granted here: the owner says yes or no to each, and a yes gives
// the usual steps to connect it. A server that runs a command is never run or asked for.
import {
  asksFor,
  BUILT_IN,
  catalog,
  connectorIdFor,
  ensureConnector,
  GITHUB_ADDRESS,
  GITHUB_ID,
  grantsFor,
  raiseAsk,
  type AskRow
} from '@oddboro/ledger';
import {
  MOST_SERVERS,
  sortServers,
  type ImportedServer,
  type SortedServers
} from '#lib/staff/claude-agent.ts';

/** The office's tools an agent file's server name can match: its catalog and the ones it connects itself. */
export async function knownTools(): Promise<{ id: string; name: string }[]> {
  const saved = await catalog();
  return [...saved, ...BUILT_IN.filter((b) => !saved.some((c) => c.id === b.id))].map((c) => ({
    id: c.id,
    name: c.name
  }));
}

/** The servers a hire's body sent, checked: a name, and a web address or nothing. */
export function serversFrom(v: unknown): ImportedServer[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, MOST_SERVERS)
    .filter(
      (s): s is { name: string; url?: unknown; command?: unknown } =>
        !!s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string'
    )
    .map((s) => ({
      name: s.name.trim().slice(0, 80),
      ...(typeof s.url === 'string' ? { url: s.url.slice(0, 2000) } : {}),
      // A command is kept only so it sorts as listed, never to run it.
      ...(s.command !== undefined ? { command: '' } : {})
    }))
    .filter((s) => s.name);
}

/** What an ask is for, to the catalog: any address on GitHub's server is the catalog's GitHub, which signs in. */
const wantedBy = (connector: string) => (GITHUB_ADDRESS.test(connector) ? GITHUB_ID : connector);

/**
 * A file's servers sorted for one Odd (`sortServers`). The asks leave out a
 * tool it holds a grant for or has an open ask for, so the same file loaded
 * again asks for nothing twice. A new Odd has neither. An open ask older than
 * its last 30 is missed, and the desk shows the new one as its twin.
 */
export async function sortFor(staffId: string, servers: ImportedServer[]): Promise<SortedServers> {
  const sorted = sortServers(servers, await knownTools());
  if (!sorted.asks.length) return sorted;
  const [granted, asked] = await Promise.all([grantsFor(staffId), asksFor(staffId)]);
  const has = new Set([
    ...granted.map((g) => g.connectorId),
    ...asked
      .filter((a) => a.kind === 'access' && a.status === 'open')
      .map((a) => a.access?.connector)
  ]);
  return {
    ...sorted,
    asks: sorted.asks.filter((a) => !has.has(connectorIdFor(wantedBy(a.connector))))
  };
}

/** Raise one read access ask for each server that asks (`sortFor`). A failed one is logged, never a failed hire or save. */
export async function askForImported(
  staffId: string,
  odd: string,
  servers: ImportedServer[]
): Promise<AskRow[]> {
  if (!servers.length) return [];
  const { asks } = await sortFor(staffId, servers);
  const raised: AskRow[] = [];
  for (const s of asks) {
    try {
      const found = await ensureConnector(wantedBy(s.connector));
      if (!found.connector) throw new Error(found.problem);
      const conn = found.connector;
      const { ask } = await raiseAsk(staffId, {
        title: `Connect ${conn.name} (read)`,
        why: `${odd}'s Claude Code agent file lists the MCP server "${s.name}". Say yes to connect it at read, or no to leave it out.`,
        ifApproved: conn.readyAt
          ? `${odd} can use ${conn.name} at once: you connected it already, so there are no steps.`
          : `You get numbered steps to connect ${conn.name} for ${odd}.`,
        access: { connector: conn.id, level: 'read' }
      });
      raised.push(ask);
    } catch (e) {
      console.error(`[agent file] access ask for ${s.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return raised;
}
