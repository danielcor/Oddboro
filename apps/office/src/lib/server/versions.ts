// Each coding tool's version on this computer, the newest its maker has out,
// and how to update it in one click: what the Your AI tiles, "Runs on" and
// every run read. A tool older than the oldest the office runs
// (`MIN_VERSIONS` in the ledger's agents.ts) is refused before it starts, with
// where to update it, since its own error is a switch it does not know.
//
// The version is read once from `<tool> --version` and again only when the
// tool's file changes, so an update shows at once and nothing is read twice.
// The newest is asked of the tool's maker when a list is read, at most every
// six hours: npm's registry for Claude Code, Codex and Gemini, and Grok's own
// check for Grok. Only the package's name leaves the computer. Server only.
import { realpathSync, statSync } from 'node:fs';
import { AGENT_NAMES, MIN_VERSIONS, olderThan, probe, type Agent } from '@oddboro/ledger';
import { agentCommand } from './agent-sign-in.ts';
import { cleanEnv } from './claude.ts';
import { grokLatest, grokUpdate } from './grok.ts';

/** A version as the tools print it: `codex-cli 0.166.0`, `grok 1.0.70 (...)`, `2.1.318 (Claude Code)`. */
const VERSION = /\d+\.\d+\.\d+/;

/** Each tool's npm package, where its maker publishes it. Grok has none. */
const NPM: Partial<Record<Agent, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli'
};

const read = new Map<Agent, { stamp: string; version?: string }>();

/** The tool's file and when it last changed, so a new install or update reads again. */
function stampOf(cmd: string, before: readonly string[]): string {
  // npm's Claude Code on Windows runs its script under this Node: the script is the tool.
  const file = before.at(-1) ?? cmd;
  try {
    const real = realpathSync(file);
    return `${real}:${statSync(real).mtimeMs}`;
  } catch {
    return file;
  }
}

/** The tool's version on this computer, or nothing when it is not installed or does not say. */
export async function versionOf(agent: Agent): Promise<string | undefined> {
  const command = agentCommand(agent);
  if (!command) return undefined;
  const [cmd, before] = command;
  const stamp = stampOf(cmd, before);
  const was = read.get(agent);
  if (was?.stamp === stamp) return was.version;
  const r = await probe(cmd, [...before, '--version'], { env: cleanEnv(), timeout: 15_000 });
  let version: string | undefined;
  switch (r.status) {
    // A tool that exits with an error may still have printed its version.
    case 'ok':
    case 'failed':
      version = VERSION.exec(r.out)?.[0];
      break;
    case 'missing':
    case 'timeout':
      version = undefined;
      break;
    default: {
      const missed: never = r;
      throw new Error(`${cmd} --version came back as ${JSON.stringify(missed)}`);
    }
  }
  read.set(agent, { stamp, version });
  return version;
}

const SIX_HOURS = 6 * 60 * 60_000;
const newest = new Map<Agent, { at: number; version?: string }>();

/** The newest version the tool's maker has out, or nothing when it cannot be asked. */
export async function latestOf(agent: Agent): Promise<string | undefined> {
  // The office's tests ask no one.
  if (process.env.ODDBORO_NO_LATEST) return undefined;
  const was = newest.get(agent);
  if (was && Date.now() - was.at < SIX_HOURS) return was.version;
  let version: string | undefined;
  try {
    if (agent === 'grok') version = await grokLatest();
    else {
      const res = await fetch(`https://registry.npmjs.org/${NPM[agent]}/latest`, {
        signal: AbortSignal.timeout(5_000)
      });
      if (res.ok)
        version = VERSION.exec(String(((await res.json()) as { version?: unknown }).version))?.[0];
    }
  } catch {
    // Offline or refused: no newest, and no Update offered for it.
  }
  newest.set(agent, { at: Date.now(), version });
  return version;
}

/** What the page shows about a tool's version (in `/api/agents`). */
export type VersionState = {
  version?: string;
  /** The newest out, when it is newer than this one. */
  newer?: string;
  /** Older than the office runs: its runs are refused until it is updated. */
  tooOld?: string;
};

/** A tool's version, the newest out when newer, and the oldest the office runs when this is older. */
export async function versionState(agent: Agent): Promise<VersionState> {
  const [version, latest] = await Promise.all([versionOf(agent), latestOf(agent)]);
  if (!version) return {};
  return {
    version,
    ...(latest && olderThan(version, latest) ? { newer: latest } : {}),
    ...(olderThan(version, MIN_VERSIONS[agent]) ? { tooOld: MIN_VERSIONS[agent] } : {})
  };
}

/** Why a run on this tool cannot start, when it is older than the office runs. */
export async function tooOldLine(agent: Agent, where: string): Promise<string | undefined> {
  const version = await versionOf(agent);
  if (!version || !olderThan(version, MIN_VERSIONS[agent])) return undefined;
  return `${AGENT_NAMES[agent]} ${version} is older than this office runs (${MIN_VERSIONS[agent]} or newer). Update it ${where}.`;
}

/**
 * The command that updates a tool in one click: Claude Code's and Grok's own
 * updaters, which update however they were installed, and npm for Codex and
 * Gemini, which install that way.
 */
export function updateCommand(agent: Agent): {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
} {
  const [cmd, before] = agentCommand(agent) ?? [agent, []];
  if (agent === 'claude') return { cmd, args: [...before, 'update'] };
  if (agent === 'grok') {
    const { args, env } = grokUpdate();
    return { cmd, args: [...before, ...args], env };
  }
  return { cmd: 'npm', args: ['install', '-g', `${NPM[agent]}@latest`] };
}
