// What a Grok, Codex or Gemini run (grok.ts, codex.ts, gemini.ts) does the
// same way as it starts: files replaced in one step, files a run that died
// with the office left behind cleared away, an environment with nothing of the
// office's own keys or node options in it, TOML values, and the MCP grants
// read from access()'s names. The git and npm environment of every run with a
// shell, Claude Code's too. What run() in staff.ts takes from a tool's own
// stream, how a run with a shell stops, and where a run refused for its
// sign-in points the owner. Server only.
import { execFileSync } from 'node:child_process';
import { readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentPlatform,
  hostEnv,
  modelSection,
  runsGoing,
  type ModelUsage
} from '@oddboro/ledger';
import { cleanEnv } from './claude.ts';

/** Where the owner signs a tool in for the office: beside the Odd's "Runs on" picker. */
export const SIGN_IN_WHERE = `on ${modelSection("this Odd's")}`;
/** What a run refused for its tool's sign-in says after the tool's name. */
export const NOT_SIGNED_IN = `is not signed in for this office. Sign in ${SIGN_IN_WHERE}.`;

/** A TOML value: what Codex's `-c` takes after `key=`, and what a config.toml or policy.toml holds. */
export type Toml = string | number | boolean | readonly Toml[] | { readonly [key: string]: Toml };

/**
 * A TOML basic string. JSON's is one, except that TOML also refuses a raw
 * U+007F and an escaped lone surrogate, which JSON leaves raw and escapes, so
 * a lone surrogate becomes U+FFFD first and U+007F is escaped.
 */
const tomlString = (s: string) => JSON.stringify(s.toWellFormed()).replaceAll('\x7f', '\\u007f');

/** One value as TOML. A quoted key is any key. */
export function toml(v: Toml): string {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `[${v.map(toml).join(', ')}]`;
  return `{ ${Object.entries(v)
    .map(([k, x]) => `${tomlString(k)} = ${toml(x)}`)
    .join(', ')} }`;
}

/**
 * One MCP server a run gets, as `access()` in staff.ts builds it: the
 * office's tool server, a command the run starts, and each outside tool at
 * the office's gateway (gateway.ts), with the run's token as its header. A
 * run never gets an outside server itself, so a new kind of connector
 * changes `upstream` in access.ts, not this.
 */
export type McpServer =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

/**
 * A run's servers as Claude Code's `--mcp-config` and Grok's agent file take
 * them. Neither config has ever named a command's kind (each reads a server
 * with no `type` as one), so the kind stays the office's own word and the
 * file a run gets does not change.
 */
export function configServers(
  servers: Record<string, McpServer>
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, configServer(s)]));
}

function configServer(s: McpServer): Record<string, unknown> {
  switch (s.type) {
    case 'http':
      return s;
    case 'stdio': {
      const { type, ...command } = s;
      return command;
    }
    default: {
      // A kind with no case here fails the type check; the cast only names it.
      const missed: never = s;
      throw new Error(`No way to write a ${(missed as McpServer).type} server into a run's config`);
    }
  }
}

/**
 * One MCP grant as access() names it for Claude Code: `mcp__office` is the
 * whole server, `mcp__c__t` one tool of server `c`.
 */
export function mcpGrant(allowed: string): { server: string; tool?: string } {
  const name = allowed.replace(/^mcp__/, '');
  const at = name.indexOf('__');
  return at < 0 ? { server: name } : { server: name.slice(0, at), tool: name.slice(at + 2) };
}

/** A picture the office sends with one message, from a file it kept. */
export type RunImage = { path: string; mediaType: string };

/** What run() takes from one line of a tool's own stream (`read` on a `Launch` in cli.ts). */
export type RunEvent =
  | { type: 'session'; id: string }
  | { type: 'tool'; name: string }
  /** One whole message of the reply. */
  | { type: 'message'; text: string }
  | { type: 'usage'; usage: ModelUsage }
  /** The turn finished; its reply is the last message. */
  | { type: 'done' }
  | { type: 'failed'; message: string }
  /** Something went wrong that the run may still finish past. */
  | { type: 'error'; message: string };

/** A file replaced in one step, so the tool never reads it half written. */
export function replace(path: string, content: string | Uint8Array, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

/**
 * Remove what each run named `<key><suffix>` in `dir` once no run with that
 * key is going (`runsGoing`), files and folders alike: what a run that died
 * with the office left behind goes at the next run. `starting` is the key of
 * the run getting ready now, which is not in `runsGoing` until it spawns.
 */
export function sweep(dir: string, suffix: string, starting: string): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue;
    const key = name.slice(0, name.length - suffix.length);
    if (key !== starting && !runsGoing.has(key))
      rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/**
 * The office's clean environment (`cleanEnv`) for an owner-side launch of a
 * tool another company makes (an install, a sign-in, an update; a run starts
 * from `runEnv` instead): no Anthropic key, no variable of that tool's own (`prefixes`) from
 * the office's environment, and no node options, since a preload the office's
 * node was started with sits outside the tool's sandbox and node refuses to
 * start the tool server when it cannot read it.
 */
export function vendorEnv(prefixes: readonly string[]): NodeJS.ProcessEnv {
  const env = cleanEnv();
  delete env.ANTHROPIC_API_KEY;
  delete env.NODE_OPTIONS;
  for (const k of Object.keys(env)) if (prefixes.some((p) => k.startsWith(p))) delete env[k];
  return env;
}

/**
 * The git environment of every run with a shell (`shellEnv` carries it with
 * npm's settings); its names alone let git's settings past the sandbox's
 * secret filter (`OFFICE_GIT` in sandbox.ts). The owner's git settings never
 * shape an Odd's git: the sandbox shuts the home they sit in, and git that
 * cannot read `~/.gitconfig` exits 128. So no global config, and the two files git
 * otherwise reads under `~/.config/git` (`ignore`, `attributes`) point at
 * nothing, which leaves no "unable to access" warning. These are env config,
 * which outranks a repository's own, so a repository's `core.excludesFile`
 * is ignored for Odds; its `.gitignore` still works. No `XDG_CONFIG_HOME`:
 * Claude Code reads its own config from there, and `GIT_CONFIG_GLOBAL`
 * already keeps git from `$XDG_CONFIG_HOME/git/config`. `GIT_TEMPLATE_DIR` is
 * an empty folder in the run's own temp folder (`temp`), which the caller
 * makes before the run and removes with that folder, so `git init` copies no
 * sample hooks: a Codex Odd's repository in a subfolder of its own folder
 * starts with none. For Claude Code it matters only if Claude Code later
 * lets git write a `.git/config`, which its sandbox refuses today (2.1.318),
 * so `git init` stops there first; its sandbox refuses every write under a
 * `.git/hooks` too, and git stops when it cannot copy one.
 */
export function gitEnv(temp: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TEMPLATE_DIR: join(temp, 'git-template'),
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.attributesFile',
    GIT_CONFIG_VALUE_1: '/dev/null'
  };
}

/**
 * The environment every run's commands get, for Claude Code's launch env and
 * Codex's one `shell_environment_policy.set` alike, from this one place so
 * the two cannot drift: the office's git settings (`gitEnv`), and npm's cache
 * in the run's temp folder (`temp`), since the sandbox shuts `~/.npm` to
 * writes. npm's user and global configs name files that are never made, so
 * neither the owner's `~/.npmrc` nor the `etc/npmrc` beside the node that
 * runs npm, either of which may hold a registry token, is read.
 */
export function shellEnv(temp: string): Record<string, string> {
  return {
    ...gitEnv(temp),
    npm_config_cache: join(temp, 'npm'),
    npm_config_userconfig: join(temp, 'npmrc'),
    npm_config_globalconfig: join(temp, 'npmrc-global')
  };
}

/**
 * Stop a tool started in a process group of its own (`detached`), and the
 * group of every process under it. Codex runs each shell command in a group
 * of its own (measured on codex-cli 0.166.0), so stopping the tool's group
 * alone leaves a command that was still running when the run timed out. A
 * process that already left the tree (its parent ended, so launchd took it)
 * is not found here.
 */
export function stopGroups(pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  if (currentPlatform() === 'win32') {
    try {
      execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { env: hostEnv(), windowsHide: true, stdio: 'ignore' }
      );
    } catch {
      // The run may already have exited.
    }
    return;
  }
  const groups = new Set([pid]);
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
      encoding: 'utf8',
      env: hostEnv()
    })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number));
    const under = new Set([pid]);
    // Once pids wrap, a child can come before its parent in the list, so go round until nothing is added.
    for (let added = true; added;) {
      added = false;
      for (const [p, parent, group] of rows)
        if (under.has(parent) && !under.has(p)) {
          under.add(p);
          groups.add(group);
          added = true;
        }
    }
  } catch {
    // Without ps the tool's own group still stops below; only its commands' groups are missed.
  }
  for (const group of groups)
    try {
      process.kill(-group, signal);
    } catch {
      // That group is gone already: nothing is left to stop.
    }
}
