// What a run does by the coding tool it runs on: how a run on Claude Code,
// Grok, Codex or Gemini starts (claude.ts, grok.ts, codex.ts, gemini.ts), and
// why a run ended early. Server only.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  AGENT_NAMES,
  COMMANDS_WHY,
  OFFICE_MODEL_VAR,
  type Agent,
  type Effort
} from '@oddboro/ledger';
import { deniedEdits } from './files.ts';
import { claudeLaunch, type ClaudeRun } from './claude.ts';
import {
  configServers,
  type McpServer,
  type ResultFacts,
  type RunEvent,
  type RunImage
} from './launch.ts';
import { GROK_PLAN_LIMIT, GROK_SIGN_IN, grokLaunch, grokSignedOut } from './grok.ts';
import { codexLaunch, codexReader, codexSignedOut } from './codex.ts';
import { geminiKeyMissing, geminiLaunch, geminiReader } from './gemini.ts';

/**
 * How one run starts: the tool's arguments, environment and input, and what
 * to remove once it ends. `read` turns a line of a tool's own stream into
 * what the run takes from it (`drive` in drive.ts). `ownGroup`: the tool has a shell, whose
 * commands may outlive it, so the run is a process group of its own, and that
 * group and the group of every process under it stop when the run ends or
 * times out (`stopGroups`).
 */
export type Launch = {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
  done: () => void;
  read: (e: Record<string, unknown>) => RunEvent[];
  /** How words added to a run while it replies are written to its input, for a tool that takes them. */
  turn?: (text: string) => string;
  ownGroup?: true;
};

/** What a run needs, whatever its tool: an Odd's from run() in staff.ts, the office's own from runAsOffice. */
export type CliRun = {
  /** The run's key (`runsGoing`). */
  key: string;
  staffId: string;
  /** The Odd's folder, the run's cwd. */
  dir: string;
  /** The folders the run reads besides its own: the owner's data folder, its thread's or those of the goals a lead's chat leads, and the folders the owner gave the Odd. */
  reads: string[];
  /** On a thread: the Odd's own part of it. */
  part?: string;
  /** The folders the run writes: its own, on a thread its part of it, and the folders the owner gave the Odd to change. */
  writes: string[];
  /** The folders the owner gave the Odd to change, some of `writes`, empty if none: only there are git's usual places never written (`repoRunPaths`). */
  granted: string[];
  /** The owner's Browse the web switch: the tool's own web search and fetch. */
  web: boolean;
  /** A shell, decided in run() from commandsHow; a launch whose tool cannot hold it refuses. */
  commands: boolean;
  /** Whether those commands reach the internet (commandsOnline, less a held network). */
  network: boolean;
  /** The file the owner edited, by its path inside `dir`, which a run reading that edit may not write. */
  edited?: string;
  system: string;
  /** The catch-up preface and the message. */
  input: string;
  /** The session to resume, else a new one. */
  resume?: string;
  servers: Record<string, McpServer>;
  /** The MCP tools the run may call, as access() names them for Claude Code (`mcp__server` or `mcp__server__tool`). */
  allowed: string[];
  /** The longest the run may take before the office cuts it. */
  timeoutMs: number;
  /** Pictures sent with the message: an office run's (`runAsOffice`), or those the owner attached in a Codex Odd's chat. */
  images?: RunImage[];
  /** An office run: no tools to read with, and no MCP. */
  bare?: boolean;
  /** How hard the model thinks: an Odd's level (`effortFor`) or an office run's. */
  effort?: Effort;
  /** The Odd's own model (`modelFor`); without one, the office's. */
  model?: string;
  /** The account whose home the tool runs with (`accountOf`): Office for an office run. */
  account: string;
};

/**
 * How a run starts on each tool. Every one has an entry, so a new tool fails
 * the type check until it is handled. Each takes a `ClaudeRun`, whose added
 * fields only Claude Code reads, so one call serves every tool. A tool that
 * cannot start says why instead (`refused`), and so
 * does one handed a run its tool cannot hold, Grok or Gemini with commands
 * and Codex without, first, so a change to `commandsHow` alone fails the run
 * rather than silently dropping or adding the shell.
 */
export const LAUNCHES: Record<Agent, (r: ClaudeRun) => Promise<Launch | { refused: string }>> = {
  claude: async (r) => claudeLaunch(r),
  grok: async (r) => {
    if (r.commands) return { refused: COMMANDS_WHY.grok };
    const signedOut = await grokSignedOut(r.timeoutMs, r.account);
    if (signedOut) return { refused: signedOut };
    return {
      ...grokLaunch({
        key: r.key,
        account: r.account,
        staffId: r.staffId,
        dir: r.dir,
        reads: r.reads,
        part: r.part,
        writes: r.writes,
        deniedEdits: deniedEdits(r),
        system: r.system,
        message: r.input,
        resume: r.resume,
        newSession: randomUUID(),
        servers: configServers(r.servers),
        allowed: r.allowed,
        web: r.web,
        images: r.images,
        bare: r.bare,
        effort: r.effort,
        model: r.model
      }),
      // Grok reads its message from a file (--prompt-file), never from input.
      stdin: ''
    };
  },
  codex: async (r) => {
    const signedOut = codexSignedOut(r.account);
    if (signedOut) return { refused: signedOut };
    return {
      ...codexLaunch({
        key: r.key,
        account: r.account,
        dir: r.dir,
        reads: r.reads,
        writes: r.writes,
        edited: r.edited && join(r.dir, r.edited),
        system: r.system,
        input: r.input,
        resume: r.resume,
        servers: r.servers,
        allowed: r.allowed,
        web: r.web,
        commands: r.commands,
        network: r.network,
        images: r.images,
        effort: r.effort,
        model: r.model
      }),
      read: codexReader(r.model ?? process.env[OFFICE_MODEL_VAR.codex] ?? 'codex'),
      // Only a shell leaves processes behind.
      ...(r.commands ? { ownGroup: true as const } : {})
    };
  },
  gemini: async (r) => {
    if (r.images?.length)
      return {
        refused:
          'Gemini cannot receive pictures in this office. Use a text file or choose another tool.'
      };
    if (r.commands) return { refused: COMMANDS_WHY.gemini };
    const missing = geminiKeyMissing();
    if (missing) return { refused: missing };
    return {
      ...geminiLaunch({
        key: r.key,
        dir: r.dir,
        reads: r.reads,
        writes: r.writes,
        granted: r.granted,
        edited: r.edited,
        system: r.system,
        input: r.input,
        resume: r.resume,
        servers: r.servers,
        allowed: r.allowed,
        web: r.web
      }),
      read: geminiReader(Object.keys(r.servers)),
      // Its MCP servers are processes of their own, which stop with the run.
      ownGroup: true
    };
  }
};

/**
 * Grok's words when its plan has no usage left: the line its stream ends a
 * run with, and the error code under it (`subscription:free-usage-exhausted`
 * in its log's turn.terminal_failure), both from the walk on 2026-11-04.
 */
const GROK_PLAN_SPENT = /reached your .*usage limit|usage-exhausted/i;

/**
 * Grok's refusal when a container socket its sandbox denies is a link to a
 * path off its own list (Grok 1.0.77, issue #52). `runHome` in grok.ts clears
 * it for a Docker socket that leads to a `docker.sock`; this catches the rest.
 */
const GROK_SOCKET_LINK = /runtime-socket deny path (\S+): endpoint is a symlink/;

/**
 * What the owner reads when Grok refuses its sandbox for a socket link: what
 * is wrong, and the one change that keeps the work going, for an Odd on its
 * Settings tab, for the office's own runs in Setup.
 */
function grokSocketLink(socket: string, office: boolean): string {
  const steps = office
    ? ['To keep the office working:', '1. Open Setup.', '2. Under Your AI, pick another tool.']
    : [
        'To keep this Odd working:',
        "1. Open this Odd's Settings tab.",
        '2. Under Model, pick another tool.'
      ];
  return [
    `Grok can't start on this computer. Its sandbox won't run while ${socket} is a link to a place Grok doesn't know, which some container apps set up. The office never runs Grok without its sandbox.`,
    steps.join('\n'),
    'Or wait for a Grok update that fixes this.'
  ].join('\n\n');
}

/**
 * Why a tool stopped before its result: the office's own words for a failure
 * it knows, else the exit code and the last two lines the tool wrote.
 * `office`: an office run, which no Odd's Settings tab changes.
 */
export function stoppedWhy(
  agent: Agent,
  code: number | null,
  stderr: string,
  office = false
): string {
  const socket = agent === 'grok' ? GROK_SOCKET_LINK.exec(stderr)?.[1] : undefined;
  if (socket) return grokSocketLink(socket, office);
  return `${AGENT_NAMES[agent]} stopped (exit ${code}). ${stderr.trim().split('\n').slice(-2).join(' ')}`;
}

/**
 * Why a run ended without its result, in the tool's own words when it gave
 * any. Grok's own advice for an office Grok home nobody signed in to,
 * `grok login`, would sign in the owner's ~/.grok instead, so that one points
 * to the office's own sign-in, on the page (`GROK_SIGN_IN`). Its plan limit carries
 * an upsell link, so that one is the office's own words (`GROK_PLAN_LIMIT`).
 */
export function endedEarly(agent: Agent, r: ResultFacts): string {
  const said = r.errors.join(' ');
  if (agent === 'grok' && /^Not signed in\b/.test(said)) return GROK_SIGN_IN;
  if (agent === 'grok' && GROK_PLAN_SPENT.test(said)) return GROK_PLAN_LIMIT;
  return `The session ended early (${r.subtype})${said ? `: ${said}` : '.'}`;
}
