// How staff reach Claude: the owner's Claude plan (their `claude` login) or an
// API key, and which model: Opus unless the owner picks Sonnet. The owner picks in the browser. The choice lives in
// .env (OFFICE_AUTH, OFFICE_MODEL) and the key in the system's secret store,
// never in a file. A change applies to the next run, with no restart. How a
// Claude Code run starts (`claudeLaunch`), and what a run takes from Claude
// Code's stream, which Grok's follows (`claudeReader`).
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_NAMES,
  drawsLooks,
  home,
  MODELS as AGENT_MODELS,
  OFFICE_ACCOUNT,
  OFFICE_MODEL_VAR,
  officeAgent,
  rulePath,
  toolHome,
  type Agent,
  type ModelUsage
} from '@oddboro/ledger';
import { writeEnv } from '@oddboro/ledger/env';
import { claudeCommand, probe, type Probe } from '@oddboro/ledger/platform';
import type { CliRun, Launch } from './cli.ts';
import { denyRules } from './files.ts';
import { getSecret, setSecret } from './keychain.ts';
import { GROK_FILE_TOOLS } from '../staff/work.ts';
import { configServers, shellEnv, type ResultFacts, type RunEvent } from './launch.ts';
import { runEnv } from './run-env-allow.ts';
import { claudeSandbox } from './sandbox.ts';

/** Start Claude Code with these arguments, wherever this system keeps it. */
export function spawnClaude(
  args: string[],
  opts: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams;
export function spawnClaude(args: string[], opts: SpawnOptions): ChildProcess;
export function spawnClaude(args: string[], opts: SpawnOptions): ChildProcess {
  const [cmd, before] = claudeCommand();
  return spawn(cmd, [...before, ...args], { windowsHide: true, ...opts });
}

export const MODELS = ['opus', 'sonnet'] as const;
export type Model = (typeof MODELS)[number];

export type ClaudeSettings = { auth: 'plan' | 'key'; model: Model };

export function claudeSettings(): ClaudeSettings {
  return {
    auth: process.env.OFFICE_AUTH === 'key' ? 'key' : 'plan',
    model: process.env[OFFICE_MODEL_VAR.claude] === 'sonnet' ? 'sonnet' : 'opus'
  };
}

/** Drawing looks and designing offices need more than Sonnet. */
export const SONNET_CANNOT_DRAW =
  'On Sonnet, the office cannot draw looks or design offices. Pick Opus in Setup.';
/** Whether the office designs offices: on Grok or Codex always, on Claude Code unless it runs on Sonnet. */
export const canDraw = () => officeAgent() !== 'claude' || claudeSettings().model !== 'sonnet';

/**
 * The model the office's own runs, and an Odd with none of its own, use on
 * `agent`, when the office names one: on Claude Code, the id of setup's Opus
 * or Sonnet; on the others, the model their setting names (`OFFICE_MODEL_VAR`).
 */
export function officeModel(agent: Agent): string | undefined {
  if (agent !== 'claude') return process.env[OFFICE_MODEL_VAR[agent]];
  const picked = claudeSettings().model;
  return AGENT_MODELS.claude.find((m) => m.id.includes(picked))?.id;
}

/**
 * The model the page names as the office's on `agent`: the office's own
 * (`officeModel`), else the tool's own default, first in its list. A run
 * passes no model when the office names none, so this is only for showing.
 */
export const shownOfficeModel = (agent: Agent): string | undefined =>
  officeModel(agent) ?? AGENT_MODELS[agent][0]?.id;

/** Whether the office draws an Odd's look from words or a headshot (`drawsLooks`). */
export const officeDrawsLooks = () => drawsLooks(officeAgent(), officeModel(officeAgent()));

/** Why the office does not draw a look, and what to do instead. */
export function cannotDrawLook(): string {
  const agent = officeAgent();
  if (agent === 'claude')
    return 'On Sonnet, the office does not draw looks. Build this one from parts, or pick Opus in Setup.';
  // Only Codex's model is named: naming Grok's or Gemini's here would change
  // what the owner reads.
  const on = agent === 'codex' ? officeModel(agent) : undefined;
  return `${AGENT_NAMES[agent]}${on ? ` on ${on}` : ''} does not draw looks here. Build this one from parts, or run the office on Claude Code or Codex in Setup.`;
}

/** `--model` for a run: always the owner's pick, never Claude Code's own default. */
export function modelArgs(): string[] {
  return ['--model', claudeSettings().model];
}

/**
 * The environment an owner-side launch gets (an install, a sign-in, a version
 * check), since the owner's own setup may need more than an Odd's run, which
 * starts from `runEnv` (run-env-allow.ts) and sets the same two switches
 * below. None of a parent Claude Code session's
 * settings, none of the owner's own CLAUDE.md files, and no auto-memory. Under
 * `--setting-sources user`, a run still loaded the owner's ~/.claude/CLAUDE.md,
 * their instructions to their own Claude, which no Odd should read. Auto-memory
 * wrote each Odd's own notes into the owner's ~/.claude/projects, a second
 * memory beside the office's lessons that the owner never sees. None of the
 * office process's own git variables either (every `GIT_` name, such as
 * `GIT_DIR` or `GIT_CONFIG_PARAMETERS`), since the owner's git settings never
 * shape an Odd's git: a run with a shell gets the office's own (`gitEnv`).
 * Nor `ODDBORO_SECRETS`: only the office itself holds the pipes to the app's
 * Keychain.
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env))
    if (
      k === 'CLAUDECODE' ||
      k.startsWith('CLAUDE_CODE_') ||
      k === 'CLAUDE_CONFIG_DIR' ||
      k.startsWith('GIT_') ||
      k === 'ODDBORO_SECRETS' ||
      // The owner's own AWS settings, like AWS_PROFILE: a tool server runs
      // outside a run's sandbox and could sign in as the owner. The Odds' AWS
      // tool gets its own role's credentials (`toolKeys` in aws.ts).
      k.startsWith('AWS_')
    )
      delete env[k];
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

export type ClaudeAccount = { email?: string; org?: string; plan?: string };

/** One account's Claude Code folder (`CLAUDE_CONFIG_DIR`): its login, its settings and its sessions. */
export const claudeHome = (account: string = OFFICE_ACCOUNT): string => toolHome('claude', account);

/**
 * The account Claude Code is signed in to in `dir`, a folder `claudeHome`
 * names, or the owner's own login on this computer without one. Nothing when
 * it is signed out or too old to say.
 */
export function claudeAccount(dir?: string): Promise<ClaudeAccount | undefined> {
  const [cmd, before] = claudeCommand();
  return new Promise((done) => {
    try {
      readStatus(cmd, before, dir, done);
    } catch {
      // A file this system cannot run (ENOEXEC) throws here, not in the callback: not signed in.
      done(undefined);
    }
  });
}

function readStatus(
  cmd: string,
  before: readonly string[],
  dir: string | undefined,
  done: (a: ClaudeAccount | undefined) => void
): void {
  const signedIn = (r: Probe): ClaudeAccount | undefined => {
    let out: string;
    switch (r.status) {
      // Signed out, it may exit with an error and still print its status.
      case 'ok':
      case 'failed':
        out = r.out;
        break;
      case 'missing':
      case 'timeout':
        return undefined;
      default: {
        const missed: never = r;
        throw new Error(`claude auth status came back as ${JSON.stringify(missed)}`);
      }
    }
    try {
      const s = JSON.parse(out) as {
        loggedIn?: boolean;
        email?: string;
        orgName?: string;
        subscriptionType?: string;
      };
      return s.loggedIn ? { email: s.email, org: s.orgName, plan: s.subscriptionType } : undefined;
    } catch {
      return undefined;
    }
  };
  probe(cmd, [...before, 'auth', 'status'], {
    env: dir ? { ...cleanEnv(), CLAUDE_CONFIG_DIR: dir } : cleanEnv(),
    timeout: 15_000
  }).then(
    (r) => done(signedIn(r)),
    (e: unknown) => {
      // probe rejects only on a wrong argument: logged, and read as signed out, as before.
      console.error("Could not read Claude Code's sign-in:", e);
      done(undefined);
    }
  );
}

/** Each account's sign-in, as last read, for a minute: every run asks before it starts. */
const status = new Map<string, { at: number; account?: ClaudeAccount }>();

/** Who `account`'s Claude Code is signed in as, read at most once a minute unless `fresh`. */
export async function claudeAccountOf(
  account: string = OFFICE_ACCOUNT,
  fresh = false
): Promise<ClaudeAccount | undefined> {
  const dir = claudeHome(account);
  const was = status.get(dir);
  if (!fresh && was && Date.now() - was.at < 60_000) return was.account;
  const now = await claudeAccount(dir);
  status.set(dir, { at: Date.now(), account: now });
  return now;
}

/** Forget an account's sign-in as read, after a sign-in or sign-out changed it. */
export const forgetClaudeAccount = (account: string = OFFICE_ACCOUNT): void =>
  void status.delete(claudeHome(account));

/**
 * The folder a Claude Code run uses for `account`, or nothing for the owner's
 * own login on this computer. Only the Office account, on the Claude plan,
 * before the owner signed it in: an office made before accounts keeps running
 * on the login it had until then, so nothing stops working.
 */
export async function claudeRunHome(account: string = OFFICE_ACCOUNT): Promise<string | undefined> {
  if (account !== OFFICE_ACCOUNT || claudeSettings().auth === 'key') return claudeHome(account);
  return (await claudeAccountOf(account)) ? claudeHome(account) : undefined;
}

let key: string | undefined;
/** The owner's API key, read from the keychain once. */
export function apiKey(): string | undefined {
  return (key ??= getSecret('anthropic', 'API_KEY'));
}

/** Every plugin in the owner's user settings, switched off for staff sessions. */
export function pluginsOff(): Record<string, false> {
  try {
    const user = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as {
      enabledPlugins?: Record<string, boolean>;
    };
    return Object.fromEntries(Object.keys(user.enabledPlugins ?? {}).map((k) => [k, false]));
  } catch {
    return {};
  }
}

/**
 * A Claude Code run's environment: only what `runEnv` lets through, the
 * owner's Claude login or the API key they gave the office, and never a key
 * that leaked in from a parent session.
 */
export function staffEnv(claudeDir?: string): NodeJS.ProcessEnv {
  const env = runEnv('claude');
  delete env.ANTHROPIC_API_KEY;
  if (claudeSettings().auth === 'key') env.ANTHROPIC_API_KEY = apiKey();
  // The account's own Claude Code folder: its login, settings and sessions.
  if (claudeDir) env.CLAUDE_CONFIG_DIR = claudeDir;
  return env;
}

/** Save the owner's choice. A key is tried with one short run before it is kept. */
export async function setClaude(change: {
  model?: Model;
  key?: string;
  auth?: 'plan';
}): Promise<{ ok: true } | { ok: false; problem: string }> {
  if (change.key !== undefined) {
    const value = change.key.trim();
    if (!/^sk-ant-[\w-]{20,}$/.test(value))
      return { ok: false, problem: 'That does not look like an Anthropic API key.' };
    if (!(await keyWorks(value)))
      return { ok: false, problem: 'That key did not work. Check it in the Anthropic Console.' };
    setSecret('anthropic', 'API_KEY', value);
    key = value;
    set('OFFICE_AUTH', 'key');
  }
  if (change.auth === 'plan') set('OFFICE_AUTH', '');
  if (change.model) set('OFFICE_MODEL', change.model);
  return { ok: true };
}

function set(name: string, value: string): void {
  writeEnv({ [name]: value });
  if (value) process.env[name] = value;
  else delete process.env[name];
}

function keyWorks(value: string): Promise<boolean> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...cleanEnv(), ANTHROPIC_API_KEY: value };
    const child = spawnClaude(['-p', '--tools', '', 'Say ok.'], { env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

/** One user message as a stream-json line for Claude Code: its pictures, then its text. */
export function userTurn(text: string, images: { mediaType: string; data: string }[] = []): string {
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          ...images.map((i) => ({
            type: 'image',
            source: { type: 'base64', media_type: i.mediaType, data: i.data }
          })),
          { type: 'text', text }
        ]
      }
    }) + '\n'
  );
}

/**
 * A message on stdin for Claude Code: plain text, or a stream-json user turn
 * when it carries pictures or the run reads stream-json (`streamed`).
 */
export function claudeInput(
  message: string,
  images?: { mediaType: string; data: string }[],
  streamed = false
): string {
  return images?.length || streamed ? userTurn(message, images) : message;
}

/**
 * What a Claude Code run needs beyond `CliRun`, which run() in staff.ts works
 * out by an Odd's own rules. Each is optional, since the office's own run
 * (`bare`) needs only `toolDir` and its `pictures`.
 */
export type ClaudeRun = CliRun & {
  /** The account's Claude Code folder (`CLAUDE_CONFIG_DIR`), or none for the owner's own login. */
  toolDir?: string;
  /** A chat that reads stream-json and keeps its input open, so words added while it replies reach it (`turn`). */
  streamed?: boolean;
  /** The office carries the run's files (`FILES_VIA_OFFICE`), so Claude Code gets no file tool of its own. */
  officeFiles?: boolean;
  /** With commands, their temp folder: made as the run starts, removed when it ends. */
  tmp?: string;
  /** The folders `--add-dir` names. */
  workIn?: string[];
  /** The owner's data folder when it is there: commands never write it. */
  data?: string[];
  /** What the run may not write (`deniedEdits` in files.ts). */
  denied?: string[];
  /** Every folder the run reads, its own included: a Read rule each. */
  readable?: string[];
  /** The Read deny rules for what no allow may open, whatever the owner's own settings say. */
  unreadable?: string[];
  /** What commands read in the sandbox: `readable`, less a data folder that is not there. */
  sandboxReads?: string[];
  /** Pictures held in memory, sent in place of `images`, so they never land on disk (the office's own run). */
  pictures?: { mediaType: string; data: string }[];
};

/**
 * How a Claude Code run starts. The office's own run (`bare`) has no tools,
 * no MCP server and keeps no session. An Odd's run gets its servers, settings
 * and system prompt in files only the owner can read, in a folder no run
 * reads, removed when the run ends: on the command line, any program on this
 * computer could read the servers' tokens with `ps`, an Odd's own commands
 * included, and the read rules grow with every folder in Claude Code's own
 * `projects`, which on Windows passed the 32,767 characters a command line may
 * hold. With commands, the run's temp folder and the git template in it are
 * made now and removed when the run ends.
 */
export function claudeLaunch(r: ClaudeRun): Launch {
  const env = staffEnv(r.toolDir || undefined);
  const pictures =
    r.pictures ??
    r.images?.map((i) => ({
      mediaType: i.mediaType,
      data: readFileSync(i.path).toString('base64')
    }));
  const stdin = claudeInput(r.input, pictures, r.streamed);
  const stream = { read: claudeReader('claude'), ...(r.streamed ? { turn: userTurn } : {}) };
  if (r.bare)
    return { args: officeArgs(r, !!pictures?.length), env, stdin, done: () => {}, ...stream };
  const files = {
    mcp: home('mcp', `${r.key}.json`),
    settings: home('mcp', `${r.key}.settings.json`),
    prompt: home('mcp', `${r.key}.prompt.md`)
  };
  const denied = r.denied ?? [];
  const settings = () => ({
    permissions: {
      allow: [
        ...(r.readable ?? []).map((p) => `Read(${rulePath(p)}/**)`),
        // Edit rules cover every file-writing tool; Claude Code ignores Write(path).
        ...r.writes.map((w) => `Edit(${rulePath(w)}/**)`),
        ...(r.commands ? ['Bash'] : []),
        ...(r.web ? ['WebSearch', 'WebFetch'] : []),
        ...r.allowed
      ],
      deny: [...(r.unreadable ?? []), ...denied.flatMap((p) => denyRules(['Edit'], rulePath(p)))]
    },
    enabledPlugins: pluginsOff(),
    ...(r.tmp
      ? {
          sandbox: claudeSandbox({
            reads: r.sandboxReads ?? [],
            tmp: r.tmp,
            denyWrite: [...(r.data ?? []), ...denied],
            network: r.network,
            env
          })
        }
      : {})
  });
  const writeFiles = (): (() => void) => {
    mkdirSync(home('mcp'), { recursive: true, mode: 0o700 });
    const mode = { mode: 0o600 };
    writeFileSync(files.mcp, JSON.stringify({ mcpServers: configServers(r.servers) }), mode);
    writeFileSync(files.settings, JSON.stringify(settings()), mode);
    writeFileSync(files.prompt, r.system, mode);
    return () => {
      for (const f of Object.values(files)) rmSync(f, { force: true });
    };
  };
  const args = [
    '-p',
    ...(pictures?.length || r.streamed ? ['--input-format', 'stream-json'] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // With the office carrying its files, no file tool of its own; with no
    // other tool either, an empty list, which Claude Code takes as none.
    '--tools',
    [
      ...(r.officeFiles ? [] : ['Read,Glob,Grep,Write,Edit']),
      ...(r.commands ? ['Bash'] : []),
      ...(r.web ? ['WebSearch,WebFetch'] : [])
    ].join(','),
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    files.mcp,
    '--disable-slash-commands',
    '--settings',
    files.settings,
    ...(r.workIn ?? []).flatMap((p) => ['--add-dir', p]),
    // The Odd's own model, or the office's Opus or Sonnet from setup.
    ...(r.model ? ['--model', r.model] : modelArgs()),
    ...(r.effort ? ['--effort', r.effort] : []),
    '--append-system-prompt-file',
    files.prompt,
    ...(r.resume ? ['--resume', r.resume] : ['--session-id', randomUUID()])
  ];
  const tmp = r.tmp;
  if (!tmp) return { args, env, stdin, done: writeFiles(), ...stream };
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const shell = shellEnv(tmp);
  mkdirSync(shell.GIT_TEMPLATE_DIR, { mode: 0o700 });
  // The office's git and npm settings (`shellEnv`). The office's own node
  // options never reach a run (`runEnv`), so no node a command starts takes them.
  Object.assign(env, { CLAUDE_CODE_TMPDIR: tmp, ...shell });
  const dropFiles = writeFiles();
  return {
    args,
    env,
    stdin,
    done: () => {
      dropFiles();
      rmSync(tmp, { recursive: true, force: true });
    },
    ...stream
  };
}

/**
 * The office's own run: no tools, no MCP server, none of the owner's
 * plugins, and no session kept, so Claude Code keeps no transcript of it.
 */
function officeArgs(r: ClaudeRun, withPictures: boolean): string[] {
  return [
    '-p',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: {} }),
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    '--settings',
    JSON.stringify({ enabledPlugins: pluginsOff() }),
    '--append-system-prompt',
    r.system,
    ...(r.effort ? ['--effort', r.effort] : []),
    ...(r.model ? ['--model', r.model] : modelArgs()),
    ...(withPictures ? ['--input-format', 'stream-json'] : [])
  ];
}

/**
 * Claude Code's name for a tool Grok names: a file tool by GROK_FILE_TOOLS,
 * and search_tool, which finds an MCP tool before Grok calls it, ToolSearch.
 */
function grokTool(name: string): string {
  if (Object.hasOwn(GROK_FILE_TOOLS, name))
    return GROK_FILE_TOOLS[name as keyof typeof GROK_FILE_TOOLS];
  return name === 'search_tool' ? 'ToolSearch' : name;
}

/**
 * The tools one line of Claude Code's stream names, by Claude Code's names,
 * as the floor is told them. Grok streams in the same shape with its own
 * names (`grokTool`), and calls every MCP tool through use_tool, which names
 * it as server__tool: that call shows once, from the whole message, the way
 * Claude Code names one, mcp__server__tool.
 */
export function streamTools(agent: Agent, e: Record<string, unknown>): string[] {
  if (e.type === 'stream_event') {
    const ev = e.event as { type: string; content_block?: { type: string; name?: string } };
    if (
      ev.type !== 'content_block_start' ||
      ev.content_block?.type !== 'tool_use' ||
      ev.content_block.name === 'use_tool'
    )
      return [];
    const name = ev.content_block.name ?? 'a tool';
    return [agent === 'grok' ? grokTool(name) : name];
  }
  if (e.type !== 'assistant') return [];
  const blocks = (e.message as { content?: unknown } | undefined)?.content;
  return (Array.isArray(blocks) ? blocks : []).flatMap((b: unknown) => {
    const block = b as { name?: unknown; input?: { tool_name?: unknown } };
    return block.name === 'use_tool' && typeof block.input?.tool_name === 'string'
      ? [`mcp__${block.input.tool_name}`]
      : [];
  });
}

/**
 * A reader of one run's Claude Code stream (`--output-format stream-json`),
 * which Grok's follows (`agent` names its tools). It reports what the stream
 * says and decides nothing: a `result` line that is not a plain success
 * (`subtype: 'success'` with no `is_error: true`) ends the run `failed` with
 * that line's facts, and each caller reads them by its own rule. Each piece of
 * streamed text is a `delta`, and a new turn after text starts with a blank
 * line, so the turns read apart.
 */
export function claudeReader(
  agent: Extract<Agent, 'claude' | 'grok'>
): (e: Record<string, unknown>) => RunEvent[] {
  let session: string | undefined;
  let streamed = '';
  const delta = (text: string): RunEvent => {
    streamed += text;
    return { type: 'delta', text };
  };
  return (e) => {
    const events: RunEvent[] = [];
    if (typeof e.session_id === 'string' && e.session_id !== session) {
      session = e.session_id;
      events.push({ type: 'session', id: session });
    }
    if (e.type === 'rate_limit_event') events.push({ type: 'plan', info: e.rate_limit_info });
    // Claude Code's own shape for it, which the ledger's usage reads as it is.
    if (e.type === 'result' && e.modelUsage)
      events.push({ type: 'usage', usage: e.modelUsage as ModelUsage });
    for (const name of streamTools(agent, e)) events.push({ type: 'tool', name });
    if (e.type === 'stream_event') {
      const ev = e.event as { type: string; delta?: { type: string; text?: string } };
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text)
        events.push(delta(ev.delta.text));
      else if (ev.type === 'message_start' && streamed && !streamed.endsWith('\n\n'))
        events.push(delta('\n\n'));
    } else if (e.type === 'result') {
      const text = e.result == null ? undefined : String(e.result);
      if (e.subtype === 'success' && e.is_error !== true) events.push({ type: 'done', text });
      else {
        const result: ResultFacts = {
          subtype: String(e.subtype),
          isError: e.is_error === true,
          text,
          errors: (Array.isArray(e.errors) ? e.errors : []).filter(
            (x): x is string => typeof x === 'string'
          )
        };
        events.push({ type: 'failed', message: text ?? result.subtype, result });
      }
    }
    return events;
  };
}
