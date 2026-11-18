// Finding MCP servers a staffer could use, in the office catalog first and
// then the public MCP Registry. Only the search words leave the Mac.
import {
  addConnector,
  AWS_BUILD_ID,
  AWS_READ_ID,
  AWS_SECRETS_ID,
  connector,
  reconfigureConnector,
  type ConnectorRow
} from './office.ts';
import { POSTAL_ID, POSTAL_NAME, POSTAL_URL } from './access-words.ts';
import type { ConnectorConfig, ConnectorKind, connectors } from './schema.ts';

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';

type Env = { name: string; description?: string; isRequired?: boolean; isSecret?: boolean };
type RegistryServer = {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  packages?: {
    registryType?: string;
    identifier?: string;
    version?: string;
    transport?: { type?: string };
    environmentVariables?: Env[];
  }[];
  remotes?: { type?: string; url?: string; headers?: Env[] }[];
};

/** A registry server, turned into what the office needs to run it. */
export type Candidate = {
  registry: string;
  name: string;
  description: string;
  repository?: string;
  kind?: ConnectorKind;
  config?: ConnectorConfig;
  /** Why the office cannot run it yet, when it cannot. */
  unsupported?: string;
};

/** "net.todoist/mcp" reads as "Todoist", "io.github.acme/notes-mcp" as "Notes". */
export function displayName(registry: string): string {
  const [space, server = ''] = registry.split('/');
  const generic = /^(mcp|server|mcp-server)$/i;
  const words = (generic.test(server) ? (space.split('.').pop() ?? space) : server)
    .replace(/(^|-)(mcp|server)(-|$)/gi, ' ')
    .replace(/[-_]+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : registry;
}

function toCandidate(s: RegistryServer): Candidate {
  const base = {
    registry: s.name,
    name: s.title || displayName(s.name),
    description: s.description ?? '',
    repository: s.repository?.url
  };
  for (const p of s.packages ?? []) {
    if (p.transport?.type && p.transport.type !== 'stdio') continue;
    const secrets = (p.environmentVariables ?? [])
      .filter((e) => e.isRequired || e.isSecret)
      .map((e) => e.name);
    const pin = p.version ? p.version : undefined;
    if (p.registryType === 'npm' && p.identifier)
      return {
        ...base,
        kind: 'stdio',
        config: {
          command: 'npx',
          args: ['-y', pin ? `${p.identifier}@${pin}` : p.identifier],
          secrets
        }
      };
    if (p.registryType === 'pypi' && p.identifier)
      return {
        ...base,
        kind: 'stdio',
        config: { command: 'uvx', args: [pin ? `${p.identifier}==${pin}` : p.identifier], secrets }
      };
  }
  for (const r of s.remotes ?? [])
    if (r.url && (r.type === 'streamable-http' || r.type === 'http'))
      return {
        ...base,
        kind: 'http',
        config: {
          url: r.url,
          headers: (r.headers ?? []).filter((h) => h.isSecret || h.isRequired).map((h) => h.name),
          // No key in a header usually means the service signs in with OAuth.
          oauth: !(r.headers ?? []).some((h) => h.isSecret || h.isRequired)
        }
      };
  return {
    ...base,
    unsupported: 'It ships in a form the office cannot run yet (not npm, PyPI or HTTP).'
  };
}

/** A work description such as "Notion pages" need not appear in the registry's server name. */
const hostedProviders = [
  { product: /\bnotion\b/i, registry: 'com.notion/mcp' },
  { product: /\blinear\b/i, registry: 'app.linear/linear' }
];

export async function searchRegistry(query: string, limit = 8): Promise<Candidate[]> {
  const provider = /\s/.test(query) && hostedProviders.find((p) => p.product.test(query));
  for (const search of provider ? [query, provider.registry] : [query]) {
    const url = `${REGISTRY}?version=latest&limit=${limit}&search=${encodeURIComponent(search)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`The MCP Registry answered ${res.status}`);
    const body = (await res.json()) as { servers: { server: RegistryServer }[] };
    if (body.servers.length) return body.servers.map((s) => toCandidate(s.server));
  }
  return [];
}

/** One registry server by its exact name. */
export async function fromRegistry(name: string): Promise<Candidate | undefined> {
  for (const words of [name, name.split('/').pop() ?? name]) {
    const hit = (await searchRegistry(words, 50)).find((c) => c.registry === name);
    if (hit) return hit;
  }
  return undefined;
}

/** GitHub's own hosted MCP server, which signs in with New Altitude's GitHub app (the office's `oauth.ts`). */
export const GITHUB_ID = 'github';
/** Any address on GitHub's MCP server, which an Odd's ask turns into the catalog's GitHub. */
export const GITHUB_ADDRESS = /^https:\/\/api\.githubcopilot\.com\//i;

/**
 * Tools the office connects in its own way, offered by `find_connectors`
 * before the registry and added to the catalog the first time one is asked for.
 * AWS starts once the owner signs in, which fills in its proxy's arguments.
 * GitHub signs in with New Altitude's own app, so an owner pastes no token.
 */
const AWS_PICK =
  'If it is not clear what the owner wants in AWS, ask them before asking for any: use their secrets (AWS Secrets Manager), read their data (AWS, read only), or build in their account (AWS, builder).';

export const BUILT_IN: (typeof connectors.$inferInsert)[] = [
  {
    id: POSTAL_ID,
    name: POSTAL_NAME,
    description:
      'Read incoming physical mail, postal letters and paper mail already scanned in one LegalZoom Virtual Mail inbox. Cannot request a scan, send, forward or shred.',
    kind: 'http',
    config: { url: POSTAL_URL, oauth: true }
  },
  {
    id: AWS_SECRETS_ID,
    name: 'AWS Secrets Manager',
    description: `The names and descriptions of the owner's secrets in AWS Secrets Manager, never their values. Ask for read when the owner wants their AWS secrets used: once it is connected, the owner can also have other tools take their keys from AWS. ${AWS_PICK}`,
    // The office answers it itself (the office's aws.ts), so nothing starts.
    kind: 'stdio',
    config: {}
  },
  {
    id: AWS_READ_ID,
    name: 'AWS, read only',
    description: `Read the owner's Amazon Web Services (AWS) account through AWS's MCP Server: S3, CloudWatch logs, EC2, Lambda and the rest, as a role that cannot change anything or read a secret value. Ask for read when the owner wants you to read data in AWS. ${AWS_PICK}`,
    kind: 'stdio',
    config: { command: 'uvx', args: [], readsByRole: true }
  },
  {
    id: AWS_BUILD_ID,
    name: 'AWS, builder',
    description: `Build in the owner's Amazon Web Services (AWS) account through AWS's MCP Server: create and change S3, Lambda, EC2 and the rest, as a role that cannot change IAM or read a secret value. Ask for write when the owner wants you to build in AWS. ${AWS_PICK}`,
    kind: 'stdio',
    config: { command: 'uvx', args: [] }
  },
  {
    id: GITHUB_ID,
    name: 'GitHub',
    description:
      "The owner's GitHub through GitHub's own MCP server: repositories, code, issues and pull requests. The owner signs in with GitHub on their desk, so never ask for a key or a token, and never tell them to make one. Ask for read to look, write to open issues, comment or change code.",
    kind: 'http',
    config: { url: 'https://api.githubcopilot.com/mcp/', oauth: true }
  }
];

/** A catalog id for a registry name: io.github.acme/notes becomes acme-notes. */
export const connectorId = (registry: string) =>
  registry
    .replace(/^io\.github\./, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A name an HTTP header can have, like Authorization or x-brain-key. */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/**
 * How a hosted server named by its address lets the office in: a sign-in, or
 * a key the owner pastes, sent in the header named here.
 */
export type WayIn = { keyHeader?: string };

/** The config for a hosted server named by its address. */
const byAddress = (url: string, way: WayIn): ConnectorConfig =>
  way.keyHeader ? { url, headers: [way.keyHeader], oauth: false } : { url, oauth: true };

/** The catalog id `ensureConnector` finds or gives `wanted`: an id as it is, or a hosted server's by its https address. */
export function connectorIdFor(wanted: string): string {
  const url = /^https:\/\/\S+$/.test(wanted) ? new URL(wanted) : undefined;
  if (!url) return wanted;
  return url.href === POSTAL_URL ? POSTAL_ID : connectorId(`${url.hostname}${url.pathname}`);
}

/**
 * A catalog connector by id, or a registry server added to the catalog by its
 * name, or a hosted server by its https address. `way` says how a server named
 * by its address lets the office in. Without it, a new one signs in and one
 * already in the catalog stays as it is.
 */
export async function ensureConnector(
  wanted: string,
  way?: WayIn
): Promise<{ connector?: ConnectorRow; problem?: string }> {
  if (way?.keyHeader !== undefined && !HEADER_NAME.test(way.keyHeader))
    return {
      problem: `"${way.keyHeader}" is not a header name. Use letters, digits and dashes, like x-api-key.`
    };
  const url = /^https:\/\/\S+$/.test(wanted) ? new URL(wanted) : undefined;
  const id = connectorIdFor(wanted);
  const own = await connector(id);
  if (own) {
    // One named by its address and not connected yet takes the way in asked for now.
    if (id !== POSTAL_ID && way && own.kind === 'http' && !own.registry && !own.readyAt) {
      const config = byAddress(own.config.url!, way);
      if (JSON.stringify(config) !== JSON.stringify(own.config)) {
        await reconfigureConnector(own.id, config);
        return { connector: { ...own, config } };
      }
    }
    return { connector: own };
  }
  if (!url && wanted.includes('/')) {
    const saved = await connector(connectorId(wanted));
    if (saved?.registry === wanted) return { connector: saved };
  }
  const built = BUILT_IN.find((b) => b.id === id);
  if (built) return { connector: await addConnector(built) };
  if (url)
    // A hosted server the owner named by its address, not in the registry.
    return {
      connector: await addConnector({
        id,
        name: url.hostname.replace(/^(www|mcp|api)\./, ''),
        description: `Hosted MCP server at ${url.origin}${url.pathname}`,
        kind: 'http',
        config: byAddress(url.href, way ?? {})
      })
    };
  const c = await fromRegistry(wanted);
  if (!c) return { problem: `No catalog id or registry server is named "${wanted}".` };
  if (c.unsupported || !c.kind || !c.config)
    return { problem: `The office cannot run ${c.registry}: ${c.unsupported}` };
  return {
    connector: await addConnector({
      id: connectorId(c.registry),
      name: c.name,
      description: c.description,
      kind: c.kind,
      config: c.config,
      registry: c.registry
    })
  };
}
