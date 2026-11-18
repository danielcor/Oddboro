// The gateway between an Odd's run and the outside tools it holds. A run
// never gets an outside server's address, key or sign-in: it gets one address
// per tool on the office itself (`/api/gateway/<connector>`) and a token that
// lives only as long as the run. The office holds the keys, connects to the
// real server (`upstream` in access.ts), lists only the tools the grant
// reaches, and refuses a call to any other. Read only reaches the tools that
// pass `readsOnly` now, as the server marks them on this run, and that the
// connector's stored list still names; Read and write reaches every tool. At
// Draft, Read and write still lists every tool, but a call to one that changes
// something goes on the owner's desk instead (`raiseCall`), with the Odd's
// title and reason, which each such tool asks for (`forOwner`): the office makes
// that exact call on their yes (`makeCall`), and the Odd hears the result in a
// new run. A tool the owner lets the Odd use without asking (its standing yes)
// goes straight through, and a call held after it lists it on the desk
// (`before`), so a commit shows the change it applies. At Act every call goes
// through but those to a tool the owner set to ask first, held the same way.
// Each list is the exception to its level (`waitsFor`). The tool a run goes through (Claude Code, Codex, Grok) still gets
// its own per-tool allow list too, so either one alone holds.
import { randomBytes } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import {
  POSTAL_ID,
  grantsFor,
  connector,
  GRANT_LABEL,
  refreshTools,
  OFFICE_URL,
  ownerName,
  raiseCall,
  readsOnly,
  record,
  type CallPlace,
  type ConnectorRow,
  type HeldCall,
  type Level
} from '@oddboro/ledger';
import { heldWordsFor, upstream } from './access.ts';
import type { McpServer } from './launch.ts';
import { ODD_META } from './google/http.ts';
import { postalTools, postalArguments } from './postal.ts';

export const GATEWAY_PATH = '/api/gateway';

/**
 * One outside tool a run holds, its connection made on first use and kept for
 * the run. `waits`: a write grant at Draft, whose changes wait for the owner,
 * except calls to the tools in `standing`, which go through (standing.ts in the
 * ledger). At Act only calls to the tools in `askFirst` wait. `made` keeps the
 * changes that went through without asking since the last held call, so the
 * next one held shows them, and starts again empty.
 * `toldNoStart`: the Ledger already says it could not start in this run.
 */
type Held = {
  pmb?: string;
  level: Level;
  waits: boolean;
  standing: Set<string>;
  askFirst: Set<string>;
  made: { tool: string; arguments: Record<string, unknown> }[];
  client?: Promise<Client>;
  tools?: Promise<Tool[]>;
  toldNoStart?: boolean;
};
/** `place` is where a held call lands; a run with none (a lesson run) changes nothing. */
type GatewayRun = { staffId?: string; held: Map<string, Held>; until: number; place?: CallPlace };

/**
 * Runs going, by token. Each goes when its run ends, or at the latest when its
 * time is up. Kept on the process, not the module: in development Vite reloads
 * the server's code under a running office, and a run the old code opened was
 * refused by the new code's guard (403) until the office restarted.
 */
const runs: Map<string, GatewayRun> = ((
  globalThis as { oddboroGatewayRuns?: Map<string, GatewayRun> }
).oddboroGatewayRuns ??= new Map());

/**
 * Open the gateway for one run: a token, and one server entry per outside
 * tool, each pointing at the office. `ms` is the run's own time limit, after
 * which the token stops working even if the run never said it ended.
 */
export function openGateway(
  grants: {
    connector: ConnectorRow;
    level: Level;
    waits?: boolean;
    standing?: string[];
    askFirst?: string[];
  }[],
  ms: number,
  place?: CallPlace,
  staffId = place?.staffId
): { token: string; servers: Record<string, Extract<McpServer, { type: 'http' }>> } {
  const now = Date.now();
  for (const [t, r] of runs) if (r.until < now) void closeGateway(t);
  const token = randomBytes(32).toString('base64url');
  runs.set(token, {
    held: new Map(
      grants.map((g) => [
        g.connector.id,
        {
          pmb: g.connector.config.pmb,
          level: g.level,
          waits: !!g.waits,
          standing: new Set(g.standing),
          askFirst: new Set(g.askFirst),
          made: []
        }
      ])
    ),
    until: now + ms + 60_000,
    place,
    staffId
  });
  const servers = Object.fromEntries(
    grants.map((g) => [
      g.connector.id,
      {
        type: 'http' as const,
        url: `${OFFICE_URL}${GATEWAY_PATH}/${encodeURIComponent(g.connector.id)}`,
        headers: { Authorization: `Bearer ${token}` }
      }
    ])
  );
  return { token, servers };
}

/** The run ended: its token stops working and its connections close. */
export async function closeGateway(token: string): Promise<void> {
  const r = runs.get(token);
  runs.delete(token);
  if (!r) return;
  await Promise.all(
    [...r.held.values()].map((h) => h.client?.then((c) => c.close()).catch(() => {}))
  );
}

/** The run a request comes from, by its token, while it is going. */
function runOf(request: Request): GatewayRun | undefined {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  const r = token ? runs.get(token) : undefined;
  return r && r.until >= Date.now() ? r : undefined;
}

/** Whether a request carries a going run's token: the office's guard lets it through to the gateway. */
export const fromRun = (request: Request): boolean => !!runOf(request);

/**
 * Why a connector did not start, in the office's own words. Only the kind of
 * failure is read, never its text: a server's refusal is its response body,
 * which can repeat the key it was sent, so nothing it said reaches the Ledger.
 */
function whyNoStart(e: unknown): string {
  if (e instanceof StreamableHTTPError)
    return e.code === 401 || e.code === 403
      ? "It turned down the office's key or sign-in."
      : 'It answered the office with an error.';
  if (e instanceof McpError && e.code === ErrorCode.ConnectionClosed)
    return 'It stopped before it answered the office.';
  if (e instanceof Error) {
    const { code, syscall } = e as NodeJS.ErrnoException;
    if (syscall?.startsWith('spawn')) return 'The office could not start the program it runs.';
    if (code === 'ERR_INVALID_URL' || e.message === 'fetch failed')
      return 'The office could not reach the address saved for it.';
  }
  return 'The office could not tell why.';
}

/**
 * One Ledger line, the first time this run finds a connector will not start.
 * A line that cannot be written is logged and dropped: the run still gets the
 * connector's own error, as it does with no line at all. Nothing here rejects,
 * so no caller has to wait for it, and none should: the line waits on its vector.
 */
async function tellNoStart(c: ConnectorRow, h: Held, e: unknown): Promise<void> {
  if (h.toldNoStart) return;
  h.toldNoStart = true;
  try {
    await record({
      kind: 'access',
      actor: 'office',
      title: `${c.name} could not start during a run`,
      body: whyNoStart(e)
    });
  } catch (failed) {
    console.error(`No Ledger line for ${c.id} not starting:`, failed);
  }
}

function clientOf(c: ConnectorRow, h: Held): Promise<Client> {
  h.client ??= upstream(c).catch((e: unknown) => {
    h.client = undefined;
    void tellNoStart(c, h, e);
    throw e;
  });
  return h.client;
}

/**
 * Every tool the server lists, once per run. The stored list follows it
 * (`refreshTools`): the owner's page, Read only's reach and each standing yes.
 */
function listed(c: ConnectorRow, h: Held): Promise<Tool[]> {
  h.tools ??= clientOf(c, h)
    .then((client) => client.listTools())
    .then(async (r) => {
      const now = r.tools.map((t) => ({ ...t, readOnly: onlyReads(c, t) }));
      await refreshTools(c.id, now).catch((e: unknown) =>
        console.error(`[gateway] ${c.id} tools not stored`, e)
      );
      return r.tools;
    })
    .catch((e: unknown) => {
      h.tools = undefined;
      throw e;
    });
  return h.tools;
}

/**
 * The tools this grant reaches on this run. Read only reaches a stored read
 * tool the server still marks as reading: one it no longer marks leaves the
 * stored list too, with a line in the Ledger (`refreshTools`), and a new one
 * joins it, from the next run.
 */
export async function reachable(c: ConnectorRow, h: Held): Promise<Tool[]> {
  const tools = await listed(c, h);
  if (c.id === POSTAL_ID) return postalTools(tools).filter((t) => c.readTools.includes(t.name));
  // A tool whose own permissions only read (AWS read only's role) holds itself.
  if (h.level === 'act' || c.config.readsByRole) return tools;
  return tools.filter((t) => c.readTools.includes(t.name) && readsOnly(t));
}

/** Whether a call to a tool that changes something waits for the owner: at Draft unless it has a standing yes, at Act only if they set it to ask first. */
const waitsFor = (h: Held, name: string): boolean =>
  h.waits ? !h.standing.has(name) : h.askFirst.has(name);

const refusal = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }]
});

/** Whether a call to `t` changes nothing: the tool only reads, or the service's own role holds it to reading. */
const onlyReads = (c: ConnectorRow, t: Tool): boolean => !!c.config.readsByRole || readsOnly(t);

/**
 * At Draft, the words the Odd gives a call that will be held, for the owner's
 * desk: a short title and why it makes the call. The gateway adds both to each
 * tool that changes something (`forOwner`), and `hold` takes them out before
 * the call is held, so the service never gets them.
 */
const TITLE = 'oddboro_title';
const WHY = 'oddboro_why';
/** The longest title the desk takes; a longer one is cut. */
const TITLE_MAX = 80;

/** A tool as a run at Draft lists it: one that changes something also takes `TITLE` and `WHY`. */
function forOwner(t: Tool, c: ConnectorRow, owner: string): Tool {
  const schema = t.inputSchema;
  const kept = `The office shows it to ${owner} and never sends it to ${c.name}.`;
  return {
    ...t,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        [TITLE]: {
          type: 'string',
          description: `What this call does, in a few plain words for ${owner}'s desk, such as "Book the intro call with Gabriel on Wed at 9 AM". Under ${TITLE_MAX} characters. ${kept}`
        },
        [WHY]: {
          type: 'string',
          description: `Why you make this call, for ${owner} to read on their desk before it is made: what it changes and why, in one or two plain sentences written to them. ${kept}`
        }
      },
      required: [...(schema.required ?? []), TITLE, WHY]
    }
  };
}

const words = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Hold one call that changes something for the owner's yes: it goes on their
 * desk as a call ask, with the Odd's title and reason, and the run hears that
 * nothing has happened yet. A call missing either is refused, and nothing is held.
 */
async function hold(
  c: ConnectorRow,
  name: string,
  given: Record<string, unknown>,
  place: CallPlace | undefined,
  h: Held
): Promise<CallToolResult> {
  if (!place)
    return refusal(
      `This run only reads, so it cannot ask to use ${name}. Say what you would change in your reply.`
    );
  const owner = await ownerName();
  const { [TITLE]: titled, [WHY]: said, ...args } = given;
  const title = words(titled);
  const why = words(said);
  if (!title || !why)
    return refusal(
      `Nothing was held. Call ${name} again with ${TITLE}, what it does in a few plain words, and ${WHY}, why you make it in one or two plain sentences, both for ${owner}, who reads them on their desk.`
    );
  const read = await heldWordsFor(c, name, args);
  // The calls since the last held one go on this card, and the next card
  // starts from here. Taken now, so a call made while this one is raised
  // waits for the next card.
  const before = h.made;
  h.made = [];
  let raised: Awaited<ReturnType<typeof raiseCall>> | undefined;
  try {
    raised = await raiseCall(
      place,
      {
        connector: c.id,
        tool: name,
        arguments: args,
        ...(read ? { said: read.title, shown: read.items } : {}),
        ...(before.length ? { before } : {})
      },
      c.name,
      {
        title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title,
        why
      }
    );
  } finally {
    // Not raised, or the same call was already on the desk with its own list:
    // these wait for the next card.
    if (!raised || raised.already) h.made = [...before, ...h.made];
  }
  const { ask, already } = raised;
  return {
    content: [
      {
        type: 'text',
        text: `${already ? `This exact call is already on ${owner}'s desk as ask ${ask.id}` : `Held for ${owner}'s yes as ask ${ask.id}`}. Nothing has changed in ${c.name} yet. ${owner} sees this exact call on their desk. If they approve it, the office makes it, and you carry on in a new run with what it returned. Do not call it again, and do not say it is done. Carry on with anything that does not need it, then say in your reply what waits on their yes.`
      }
    ]
  };
}

/**
 * Which Odd a call is for, told only to the office's own Google servers
 * (`ODD_META`), never to an outside one. The call is built here, so whatever
 * `_meta` the run sent never passes.
 */
const forOdd = (c: ConnectorRow, staffId: string | undefined) =>
  c.kind === 'builtin' && staffId ? { _meta: { [ODD_META]: staffId } } : {};

/**
 * The owner said yes to a held call: the office makes that exact call, as
 * the run would have, and returns what came back. A failure to reach the
 * service throws, so the ask stays open to try again; a tool that answers
 * with an error is a result like any other.
 */
export async function makeCall(
  call: HeldCall,
  /** The Odd whose call it was. */
  staffId: string
): Promise<NonNullable<HeldCall['result']>> {
  const c = await connector(call.connector);
  if (!c) throw new Error('That service is no longer in the office');
  if (c.id === POSTAL_ID) throw new Error('Physical mail has no approval actions.');
  const client = await upstream(c);
  try {
    const r = (await client.callTool(
      { name: call.tool, arguments: call.arguments, ...forOdd(c, staffId) },
      undefined,
      { timeout: 5 * 60_000 }
    )) as CallToolResult;
    const text = r.content
      .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
      .join('\n')
      .trim();
    return { ok: !r.isError, text: text || '(no words came back)', at: new Date().toISOString() };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Answer one request from a run's tool to the outside tool `id`. */
export async function gateway(request: Request, id: string): Promise<Response> {
  const run = runOf(request);
  if (!run) return new Response('This run has ended, or never started', { status: 401 });
  const h = run.held.get(id);
  const c = h && (await connector(id));
  if (!h || !c) return new Response('This run does not hold that tool', { status: 403 });

  if (
    id === POSTAL_ID &&
    (!run.staffId ||
      !c.readyAt ||
      !c.config.pmb ||
      c.config.pmb !== h.pmb ||
      !(await grantsFor(run.staffId)).some((g) => g.connectorId === id && g.level === 'read'))
  )
    return new Response('This run no longer has access to this mailbox', { status: 403 });

  const server = new Server(
    { name: `oddboro-gateway-${id}`, version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await reachable(c, h);
    if (!h.waits && !h.askFirst.size) return { tools };
    const owner = await ownerName();
    return {
      tools: tools.map((t) => (onlyReads(c, t) || !waitsFor(h, t.name) ? t : forOwner(t, c, owner)))
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = (await reachable(c, h)).find((t) => t.name === name);
    if (!tool)
      return refusal(
        h.level === 'act'
          ? `${c.name} has no tool named ${name}.`
          : `${name} is not one you may use. Your ${c.name} access is ${GRANT_LABEL.read}, which reaches only the tools ${c.name} marks as only reading. Ask the owner for ${GRANT_LABEL.act} if the work needs it.`
      );
    // A change waits for the owner's yes on their desk: at Draft unless the
    // owner lets this Odd use the tool without asking, at Act only if they set
    // it to ask first. At Draft a run with no place (a lesson run) changes
    // nothing, standing yes or not.
    const args = req.params.arguments ?? {};
    if (!onlyReads(c, tool)) {
      if (waitsFor(h, name) || (h.waits && !run.place)) return hold(c, name, args, run.place, h);
      h.made.push({ tool: name, arguments: args });
    }
    const client = await clientOf(c, h);
    // As long as the run itself may take: the run's own time limit ends it first.
    return (await client.callTool(
      {
        name,
        arguments:
          id === POSTAL_ID
            ? postalArguments(c.config.pmb!, req.params.arguments)
            : req.params.arguments,
        ...forOdd(c, run.place?.staffId)
      },
      undefined,
      { timeout: Math.max(60_000, run.until - Date.now()) }
    )) as CallToolResult;
  });
  // A new server and transport per request, with no session: the run's state
  // (its token, connections and tool list) lives here, not in the transport.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
