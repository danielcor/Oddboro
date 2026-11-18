// How a staffer's run starts on Grok instead of Claude Code: the arguments and
// the environment, which run() in staff.ts spawns the grok `grokCommand`
// finds with. Server only.
//
// Grok keeps its sign-in, sessions and sandbox profiles in the office's own
// Grok home (GROK_HOME), never the owner's ~/.grok. The office never edits that
// home's config.toml, which belongs to the sign-in: it switches Grok's reading
// of other tools' setups (Claude's, Cursor's) off through the environment,
// which beats config.toml. The office carries a Grok Odd's files on every
// system (`FILES_VIA_OFFICE`): Grok's own file tools are never given, and the
// office's file tools (files-server.ts in the ledger) are its only way to
// files, so a change to Grok's own tools cannot widen what an Odd reads. Under
// them, on a Mac and on Linux, a sandbox profile the kernel enforces holds the
// whole run as a second wall, built on `strict`: it reads the Odd's folder (the run's cwd),
// node and the tool server's code, Grok's home and the system folders Grok
// needs to start. It writes the Odd's folder, Grok's own temp folder and
// Grok's sessions folder, which holds every Grok Odd's sessions. It adds the
// folders the run reads besides its own (the owner's data folder, its
// thread's or a lead's goals', and the folders the owner gave the Odd) to
// read, and the given folders it may change, and on a thread the Odd's part
// of it, to write.
// Deny rules hold the rest: no Odd reads anything of the kernel's allowance
// but its own folders (`UNREADABLE`), and none writes in Grok's home. A custom
// profile that cannot apply stops Grok from starting, so a run is never left
// unconfined. The profile holds the whole grok process, its own sign-in
// renewal included, so the office renews the sign-in before a run that could
// outlast it (`grokSignedOut`). Where the Mac's Docker socket is a link, the
// run gets a home of its own so Grok's sandbox can start (`runHome`).
// Windows has no Grok sandbox, so there the office's tools are the wall.
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  accountsHome,
  CODE,
  home,
  OFFICE_ACCOUNT,
  OFFICE_MODEL_VAR,
  runsGoing,
  toolHome,
  currentPlatform,
  probe,
  type Effort
} from '@oddboro/ledger';
import type { Launch } from './cli.ts';
import { claudeReader } from './claude.ts';
import { andBelow, denyRules, instructionPaths } from './files.ts';
import { mcpGrant, NOT_SIGNED_IN, replace, sweep, vendorEnv, type RunImage } from './launch.ts';
import { runEnv } from './run-env-allow.ts';
import { onPath } from './on-path.ts';
import { sandboxPaths } from './sandbox-paths.ts';

/**
 * One account's Grok home (`toolHome`) and what Grok keeps in it: its
 * sandbox profiles, its config, each run's agent file (Grok has no
 * --mcp-config), its own temp folder (so it needs none of the temp folders
 * every app shares, `shut`), the sign-in (per xAI account, its tokens, its
 * `email` and when they run out, `expires_at`; Sign out from the page
 * removes it), the leader socket every grok outside a run talks to
 * (Grok's default is ~/.grok/leader.sock, the owner's own Grok, whatever
 * GROK_HOME says), and the home folder a run gets when the Mac's Docker
 * socket is a link (`runHome`).
 */
export function grokHome(account: string = OFFICE_ACCOUNT) {
  const dir = toolHome('grok', account);
  return {
    dir,
    sandbox: join(dir, 'sandbox.toml'),
    config: join(dir, 'config.toml'),
    runs: join(dir, 'runs'),
    temp: join(dir, 'tmp'),
    auth: join(dir, 'auth.json'),
    leader: join(dir, 'leader.sock'),
    home: join(dir, 'home')
  };
}
type GrokHome = ReturnType<typeof grokHome>;
/** Every Grok home there is or was: no run may read or change one. */
const GROK_HOMES = () => [accountsHome(), home('grok')];
/** How long before a run could end its sign-in must still hold, past the run's own time limit. */
const SIGN_IN_MARGIN_MS = 10 * 60_000;
/**
 * The longest a renewal may take before the office stops it. `grok models`
 * took 0.81 s, Node's start-up included (`/usr/bin/time -p grok models` from
 * the office's Grok home, 2026-11-04), and Grok itself waits up to 25 s for
 * its lock on auth.json (`timeout=25000ms` in its log), so a renewal that
 * waited out another's lock still ends inside this.
 */
const RENEW_MS = 30_000;

/**
 * What the owner reads when a Grok run cannot start for its sign-in. Grok's
 * own advice, `grok login`, would sign in the owner's ~/.grok instead, so
 * this points to the office's own sign-in, on the page.
 */
export const GROK_SIGN_IN = `Grok ${NOT_SIGNED_IN}`;

/**
 * What the owner reads when Grok's plan has no usage left. Grok's own words
 * carry an upsell link, which the office never passes on.
 */
export const GROK_PLAN_LIMIT =
  "Grok's plan limit is reached; this Odd can't work until it resets or the plan changes.";

/**
 * Node and the code the office's tool server runs from. The sandbox holds
 * that server too, and `strict` reads neither, so the profile lets the kernel
 * read them. Only the packages and their dependencies, never the whole repo,
 * which in development holds the office's secrets file and the owner's data
 * folder. The server gets its database from its environment, so it needs
 * neither, as in the app, whose secrets file sits in the office home.
 */
const SERVER_CODE = [
  dirname(process.execPath),
  ...['packages', 'node_modules'].map((d) => resolve(CODE, d)).filter((d) => existsSync(d))
];

/**
 * What `strict` lets every run read that no Odd needs, shut by the kernel:
 * the owner's ~/Library (mail, messages, browsers), the Mac's /Library (every
 * app's shared files), and /tmp and /var, which hold the temp folders and
 * caches every app shares. A profile can only add to `strict`; its deny list
 * is the one way to take a path away. Each is its real path, since macOS
 * links /tmp and /var into /private, and only if it exists, since on Linux a
 * deny path that cannot be bound stops Grok from starting. /etc stays: Grok
 * refuses to start without it. On Linux, /tmp and /var stay open
 * (`grokShut` in sandbox-paths.ts).
 */
const shut = () => [
  ...new Set(
    [join(homedir(), 'Library'), ...sandboxPaths().grokShut]
      .filter((p) => existsSync(p))
      .map((p) => realpathSync(p))
  )
];

/**
 * What `strict` reads besides the run's cwd and Grok's home, as Grok 1.0.46
 * on macOS logged it (ProfileApplied in its sessions' sandbox-events.jsonl).
 * Grok and node need what `shut` leaves of it to start.
 */
const strictReads = () => [...sandboxPaths().strictReads, join(homedir(), 'Library')];

/**
 * Everything the kernel may let a Grok run read besides the Odd's own
 * folders, which the Odd itself may not: Grok's home (the sign-in, every
 * Odd's sessions, each run's agent file), the tool server's code, and what
 * `strict` reads. A run has no file tool of Grok's own, so these deny rules,
 * on each folder and everything in it, are a further wall should Grok ever
 * give it one.
 */
const UNREADABLE = () => [...GROK_HOMES(), ...SERVER_CODE, ...strictReads()];

/**
 * Every compatibility cell Grok has an environment variable for, switched
 * off, so an Odd never loads the owner's or a folder's Claude or Cursor
 * skills, rules, instruction files, MCP servers or hooks.
 */
const COMPAT_OFF: Record<string, 'false'> = Object.fromEntries(
  ['CLAUDE', 'CURSOR'].flatMap((tool) =>
    ['AGENTS', 'HOOKS', 'MCPS', 'RULES', 'SKILLS'].map((cell) => [
      `GROK_${tool}_${cell}_ENABLED`,
      'false'
    ])
  )
);

/**
 * The cells Grok gives no environment variable for (each tool's sessions, and
 * Codex's hooks and skills), written only into a home that has no config.toml
 * yet. Once the owner signs in, that file is the sign-in's to keep.
 */
const FIRST_CONFIG = `# Oddboro's Grok home. Odds never read the owner's ~/.claude, ~/.cursor or ~/.grok.
[compat.claude]
sessions = false

[compat.cursor]
sessions = false

[compat.codex]
sessions = false
hooks = false
skills = false
`;

/** What one Grok run needs from run(). */
type GrokRun = {
  /** The run's key (`runsGoing`), which names its agent file and, on a thread, its profile. */
  key: string;
  /** The account whose Grok home the run uses (accounts.ts). */
  account: string;
  staffId: string;
  /** The Odd's folder, the run's cwd. */
  dir: string;
  /** The folders the run reads besides its own: the owner's data folder, its thread's or those of the goals a lead's chat leads, and the folders the owner gave the Odd. */
  reads: string[];
  /** On a thread: the Odd's own part of it, which names the run's own profile. */
  part?: string;
  /** The folders the run writes: its own (the cwd), and any of its part of a thread and the folders the owner gave the Odd to change. */
  writes: string[];
  /** The paths the run may not write (`deniedEdits`). */
  deniedEdits: string[];
  system: string;
  message: string;
  /** The session to resume, else a new one with `newSession` as its id. */
  resume?: string;
  newSession: string;
  servers: Record<string, unknown>;
  /** The MCP tools the run may call, as access() names them for Claude Code (`mcp__server` or `mcp__server__tool`). */
  allowed: string[];
  /** The owner's Browse the web switch: Grok's web_search and web_fetch. */
  web: boolean;
  /** Pictures sent ahead of the message (an office run only). */
  images?: RunImage[];
  /** An office run: no file or web tools, only the message and its pictures. */
  bare?: boolean;
  /** How hard the model thinks, as `--reasoning-effort`: an Odd's level or an office run's. */
  effort?: Effort;
  /** The Odd's own model; without one, the office's (`OFFICE_GROK_MODEL`) or the tool's default. */
  model?: string;
};

/**
 * The run's message, in a file beside its agent file, for `--prompt-file`: on
 * the command line, a long message or a picture passed the 32,767 characters
 * Windows allows. A `.txt` file is plain text. A `.json` file is ACP content
 * blocks, each picture an `image` block of base64 and its type, then the
 * message (both measured on Grok 1.0.77: Grok reads blocks only from `.json`).
 * Only the owner may read it, and it goes when the run ends.
 */
function promptFile(h: GrokHome, key: string, message: string, images: RunImage[] = []): string {
  for (const end of PROMPT_ENDS) sweep(h.runs, end, key);
  if (!images.length) {
    const file = join(h.runs, `${key}${PROMPT_ENDS[0]}`);
    replace(file, message);
    return file;
  }
  const blocks = [
    ...images.map((i) => ({
      type: 'image',
      data: readFileSync(i.path).toString('base64'),
      mimeType: i.mediaType
    })),
    { type: 'text', text: message }
  ];
  const file = join(h.runs, `${key}${PROMPT_ENDS[1]}`);
  replace(file, JSON.stringify(blocks));
  return file;
}
const PROMPT_ENDS = ['.prompt.txt', '.prompt.json'] as const;

/** Grok reads its message from its prompt file, so its launch has no input (`LAUNCHES.grok` in cli.ts). */
type GrokLaunch = Omit<Launch, 'stdin'>;

/** A sandbox profile, kept in the Grok home's sandbox.toml. */
type Profile = { readOnly: string[]; readWrite: string[]; deny: string[] };

/** A profile's block in sandbox.toml. JSON strings are TOML basic strings. */
function profileToml(name: string, p: Profile): string {
  return [
    `[profiles.${name}]`,
    'extends = "strict"',
    `read_only = ${JSON.stringify(p.readOnly)}`,
    `read_write = ${JSON.stringify(p.readWrite)}`,
    `deny = ${JSON.stringify(p.deny)}`
  ].join('\n');
}

/**
 * Put one profile in sandbox.toml, which only the office writes, one block per
 * profile. A run on no thread uses its Odd's profile, under the same name every
 * time, since Grok refuses a resumed chat under another name; it takes a
 * changed profile under the same one (measured). Each run writes that profile
 * as it starts: a lead's chat with its goals' folders, the Odd's jobs and
 * follow-ups without them. Grok reads the profile once, as it starts, so a job
 * starting in the moment a chat does can leave that chat without its goals'
 * folders. A thread's profile is the run's own: it goes once no run with its
 * key is going. All of it happens in one tick, so runs starting side by side
 * cannot drop each other's profile.
 */
function setProfile(h: GrokHome, name: string, p: Profile): void {
  const blocks = new Map<string, string>();
  const text = existsSync(h.sandbox) ? readFileSync(h.sandbox, 'utf8') : '';
  for (const block of text.split(/^(?=\[profiles\.)/m)) {
    const found = /^\[profiles\.([^\]]+)\]/.exec(block)?.[1];
    if (!found) continue;
    if (found.startsWith('run-') && !runsGoing.has(found.slice(4))) continue;
    blocks.set(found, block.trim());
  }
  blocks.set(name, profileToml(name, p));
  const next = [...blocks.values()].join('\n\n') + '\n';
  if (next !== text) replace(h.sandbox, next, 0o644);
}

/** `mcp__office` and `mcp__c__t`, as Grok's `MCPTool(office__*)` and `MCPTool(c__t)`. */
function mcpRule(allowed: string): string {
  const { server, tool } = mcpGrant(allowed);
  return `MCPTool(${server}__${tool ?? '*'})`;
}

/** Every tool that changes a file's contents, since Edit may not cover Write. */
const EDITS = ['Edit', 'Write'];

/**
 * The agent file that gives the run its MCP servers and its system prompt.
 * Its frontmatter is YAML, and a JSON object is YAML. With `prompt_mode:
 * extend`, its body is added to Grok's own prompt, as `--rules` adds it, and
 * a resumed session keeps its first run's, as with `--rules` (both measured
 * on Grok 1.0.77). On the command line, the prompt helped pass the 32,767
 * characters Windows allows. It holds the connectors' secrets, so only the
 * owner may read it, and it goes when the run ends. A file a run that died
 * with the office left behind goes at the next Grok run.
 */
function agentFile(
  h: GrokHome,
  key: string,
  servers: Record<string, unknown>,
  system: string
): string {
  mkdirSync(h.runs, { recursive: true, mode: 0o700 });
  sweep(h.runs, '.md', key);
  const file = join(h.runs, `${key}.md`);
  // Grok takes a list here, one `{name: server}` per entry, and refuses to start on a map.
  const list = Object.entries(servers).map(([name, server]) => ({ [name]: server }));
  replace(
    file,
    `---\nname: odd\ndescription: An Oddboro staffer's run\nprompt_mode: extend\nmcpServers: ${JSON.stringify(list)}\n---\n${system}\n`
  );
  return file;
}

/** The Docker socket every Grok sandbox denies, which OrbStack, Colima and Rancher Desktop make a link. */
const DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * The home folder (HOME) a sandboxed Grok run gets, or none to keep the
 * owner's. Grok denies a fixed list of container sockets in every sandbox,
 * and refuses to start when one is a link to a path not on that list: on a
 * Mac with OrbStack, `/var/run/docker.sock` leads to
 * `~/.orbstack/run/docker.sock`, so every Grok run failed (issue #52, Grok
 * 1.0.77). The list's `~/.docker/run/docker.sock` follows HOME (measured). So
 * when the socket is a link, the run's home is a folder in Grok's home whose
 * `.docker/run` leads to the folder the link leads to: the link's target is
 * then on Grok's list, Grok starts, and its sandbox still denies the socket.
 * The owner's own `~/.docker` is never touched. A target not named
 * `docker.sock` cannot go on the list this way, so that run keeps the owner's
 * home and Grok's own refusal.
 */
export function runHome(h: GrokHome, socket = DOCKER_SOCKET): string | undefined {
  let target: string;
  try {
    if (!lstatSync(socket).isSymbolicLink()) return undefined;
    target = resolve(dirname(socket), readlinkSync(socket));
  } catch {
    // No socket: nothing for Grok to refuse.
    return undefined;
  }
  if (basename(target) !== 'docker.sock') return undefined;
  const link = join(h.home, '.docker', 'run');
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  let now: string | undefined;
  try {
    now = readlinkSync(link);
  } catch {
    // No link yet.
  }
  if (now !== dirname(target)) {
    // Made beside it and renamed over it, so a run starting meanwhile never finds it missing.
    const next = `${link}.${process.pid}`;
    rmSync(next, { force: true });
    symlinkSync(dirname(target), next);
    renameSync(next, link);
  }
  return h.home;
}

/**
 * The run's servers, each the office starts with the owner's home, since a
 * tool server finds the office's own folders and the keychain through HOME,
 * which a Grok run may move (`runHome`).
 */
function ownersHome(servers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) => {
      const server = s as { command?: unknown; env?: Record<string, string> };
      return [name, server.command ? { ...server, env: { ...server.env, HOME: homedir() } } : s];
    })
  );
}

/**
 * Get a Grok run ready: its home, its sandbox profile and agent file, and the
 * arguments and environment to start `grok` with. `done` removes what only
 * this run used.
 */
export function grokLaunch(r: GrokRun): GrokLaunch {
  const h = grokHome(r.account);
  grokHomeReady(h);
  const sandbox = r.part ? `run-${r.key}` : `odd-${r.staffId}`;
  // Grok has no sandbox on Windows: the office's file tools are the wall there.
  const kernel = currentPlatform() !== 'win32';
  if (kernel)
    setProfile(h, sandbox, {
      // The office's file server runs inside the sandbox, so the kernel reads and writes what it may.
      readOnly: [...SERVER_CODE, ...r.reads],
      // `strict` already writes the cwd, the Odd's own folder.
      readWrite: [h.temp, ...r.writes.filter((w) => w !== r.dir)],
      deny: [...instructionPaths(r.writes), ...shut()].flatMap(andBelow)
    });
  const agent = agentFile(h, r.key, ownersHome(r.servers), r.system);
  const prompt = promptFile(h, r.key, r.message, r.images);
  const model = r.model ?? process.env[OFFICE_MODEL_VAR.grok];
  const args = [
    '--prompt-file',
    prompt,
    '--output-format',
    'streaming-messages-json',
    '--include-partial-messages',
    ...(kernel ? ['--sandbox', sandbox] : []),
    '--agent',
    agent,
    '--permission-mode',
    'dontAsk',
    '--no-subagents',
    '--no-auto-update',
    // No file tool of Grok's own: the office's (its `files` MCP server) are
    // the way to files. Grok's web tools with Browse the web on, its MCP tools
    // (search_tool, use_tool), and no image tool. Never a shell: its launch
    // refuses a run with commands (`LAUNCHES.grok` in cli.ts), since Grok's
    // sandbox keeps a command off the network on Linux only. Grok has no "no
    // tools": an empty list gave a 1.0.62 run every tool, its shell too, which
    // dontAsk refused, and a refused call ended the turn before the answer
    // (seen 2026-11-05). So every run gets todo_write, which touches no file.
    '--tools',
    ['todo_write', ...(r.web && !r.bare ? ['web_search', 'web_fetch'] : [])].join(','),
    ...(r.effort ? [`--reasoning-effort=${r.effort}`] : []),
    ...UNREADABLE()
      .flatMap((p) => denyRules(['Read'], p))
      .flatMap((rule) => ['--deny', rule]),
    // Further walls should Grok ever give a run a file tool of its own: dontAsk
    // refuses every edit no rule allows, and these deny Grok's home, whose
    // sessions folder the kernel lets a run write, and the instruction files.
    ...[...GROK_HOMES(), ...r.deniedEdits]
      .flatMap((p) => denyRules(EDITS, p))
      .flatMap((rule) => ['--deny', rule]),
    ...r.allowed.map(mcpRule).flatMap((rule) => ['--allow', rule]),
    // In a sandbox that keeps the network off, Grok 1.0.77 asks before every
    // fetch, and a headless run that cannot ask ends the turn (seen 2026-11-11).
    // Browse the web on is the owner's yes. web_search never asks.
    ...(r.web && !r.bare ? ['--allow', 'web_fetch'] : []),
    ...(model ? ['-m', model] : []),
    ...(r.resume ? ['-r', r.resume] : ['-s', r.newSession])
  ];
  // web_fetch is off in every other grok the office starts (`grokEnv`).
  const env = grokEnv(h, runEnv('grok'));
  if (r.web) env.GROK_WEB_FETCH = '1';
  const runsIn = kernel ? runHome(h) : undefined;
  if (runsIn) env.HOME = runsIn;
  return {
    args,
    env,
    done: () => {
      rmSync(agent, { force: true });
      rmSync(prompt, { force: true });
    },
    // Grok streams in Claude Code's shape, naming its own tools.
    read: claudeReader('grok')
  };
}

/**
 * The newest Grok xAI has out, from Grok's own check (`grok update --check
 * --json`) on the office's home and leader socket, or nothing when it cannot
 * say.
 */
export async function grokLatest(): Promise<string | undefined> {
  const h = grokHome();
  grokHomeReady(h);
  const r = await probe(
    grokCommand() ?? 'grok',
    ['update', '--check', '--json', '--leader-socket', h.leader],
    { cwd: h.dir, env: grokEnv(h), timeout: 15_000 }
  );
  let out: string;
  switch (r.status) {
    // Grok may exit with an error and still print its answer.
    case 'ok':
    case 'failed':
      out = r.out;
      break;
    case 'missing':
    case 'timeout':
      return undefined;
    default: {
      const missed: never = r;
      throw new Error(`Grok's update check came back as ${JSON.stringify(missed)}`);
    }
  }
  try {
    const v = (JSON.parse(out) as { latestVersion?: unknown }).latestVersion;
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Update Grok to xAI's newest with its own updater, where xAI's installer put
 * it, as Install does: with no GROK_ setting, so Grok's own home. With the
 * office's home, `grok update` put the new grok in that home's `bin` and left
 * the one the office runs as it was (seen 2026-11-05).
 */
export function grokUpdate(): { args: string[]; env: NodeJS.ProcessEnv } {
  return { args: ['update'], env: vendorEnv(['GROK_', 'XAI_']) };
}

/**
 * The grok the office starts: the one on PATH, else the one in xAI's install
 * folder, ~/.grok/bin, where its installer puts it (`GROK_BIN_DIR`'s default).
 * When no folder on PATH could take its link, the installer only adds that
 * folder to the shell's PATH, which the office, started before, never reads;
 * so a Grok installed from the page runs without a restart. HOME is read on
 * each call, as PATH is, so a test can point it away from the Mac's own.
 */
export function grokCommand(): string | undefined {
  const found = onPath('grok');
  if (found) return found;
  const installed = join(
    homedir(),
    '.grok',
    'bin',
    currentPlatform() === 'win32' ? 'grok.exe' : 'grok'
  );
  try {
    accessSync(installed, constants.X_OK);
    return installed;
  } catch {
    // No grok there either, or one that cannot run: Grok is not installed.
    return undefined;
  }
}

/**
 * The office's Grok home, shut to everyone but the owner, with its temp
 * folder and a config.toml if it had none. Runs and the sign-in use it.
 */
function grokHomeReady(h: GrokHome): void {
  mkdirSync(h.dir, { recursive: true, mode: 0o700 });
  chmodSync(h.dir, 0o700);
  mkdirSync(h.temp, { recursive: true, mode: 0o700 });
  if (!existsSync(h.config)) replace(h.config, FIRST_CONFIG);
}

/**
 * The browser sign-in to the office's Grok home, which the page starts
 * (agent-sign-in.ts). Outside any sandbox, so it names the home's own leader
 * socket, never the owner's.
 */
export function grokSignIn(account: string = OFFICE_ACCOUNT): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const h = grokHome(account);
  grokHomeReady(h);
  return { args: ['login', '--oauth', '--leader-socket', h.leader], env: grokEnv(h) };
}

/**
 * The environment every `grok` the office starts gets: the office's Grok
 * home, and no key or setup of the office's own. A run starts from `base`,
 * its `runEnv`; the sign-in, its renewal and the version check from the
 * owner-side `vendorEnv`.
 */
function grokEnv(h: GrokHome, base = vendorEnv(['GROK_', 'XAI_'])): NodeJS.ProcessEnv {
  return Object.assign(base, COMPAT_OFF, {
    GROK_HOME: h.dir,
    TMPDIR: h.temp,
    GROK_MEMORY: '0',
    GROK_SUBAGENTS: '0',
    GROK_WORKFLOWS: '0',
    GROK_WEB_FETCH: '0',
    // Less of an Odd's work leaves the Mac than Grok sends by default.
    GROK_TELEMETRY_ENABLED: 'false',
    GROK_TELEMETRY_TRACE_UPLOAD: 'false'
  });
}

/** The accounts in the office's Grok sign-in, none when the home has no sign-in file Grok can read. */
function accounts(h: GrokHome): unknown[] {
  try {
    const auth: unknown = JSON.parse(readFileSync(h.auth, 'utf8'));
    return Object.values(auth && typeof auth === 'object' ? auth : {});
  } catch {
    // No file, or one half written: no account to show, and nothing to renew.
    return [];
  }
}

/**
 * Who the office's Grok home is signed in as, for the page: undefined with
 * no account in its sign-in, else the first account's email when it has one.
 */
export function grokAccount(account: string = OFFICE_ACCOUNT): { email?: string } | undefined {
  const all = accounts(grokHome(account));
  if (!all.length) return undefined;
  const email = all
    .map((a) => (a as { email?: unknown } | null)?.email)
    .find((e): e is string => typeof e === 'string');
  return email ? { email } : {};
}

/**
 * When the office's Grok sign-in runs out, as epoch ms: the latest
 * `expires_at` among its accounts. None when the home has no sign-in file
 * Grok can read, or no `expires_at` in it: the run then starts, and Grok's
 * own stream says "Not signed in" (`endedEarly` in cli.ts).
 */
function signInEnds(h: GrokHome): number | undefined {
  const ends = accounts(h)
    .map((account: unknown) =>
      Date.parse(String((account as { expires_at?: unknown })?.expires_at))
    )
    .filter((t) => !Number.isNaN(t));
  return ends.length ? Math.max(...ends) : undefined;
}

/** The renewal going now in each home, which every run starting meanwhile on it waits on. */
const renewing = new Map<string, Promise<void>>();

/**
 * Renew the sign-in outside any sandbox. Grok has no command made for it, and
 * `grok models` renews an expired sign-in on disk as it starts (measured on
 * Grok 1.0.46: auth.refresh.success, then auth update disk written). It
 * exits 0 and prints "You are not authenticated." whether it renewed or not,
 * so its caller reads `expires_at` again rather than trust its output. A
 * grok that cannot start here cannot start the run either, which says so.
 * Runs starting together share one renewal, so grok renews once for them. One
 * past RENEW_MS is killed, since a grok that ignores SIGTERM would hold every
 * run back with no word to the owner.
 */
function renew(h: GrokHome): Promise<void> {
  const going = renewing.get(h.dir);
  if (going) return going;
  // Outside the sandbox, so on the home's own leader socket, never the owner's.
  // How it ended does not matter: the caller reads `expires_at` either way.
  const next = probe(grokCommand() ?? 'grok', ['models', '--leader-socket', h.leader], {
    cwd: h.dir,
    env: grokEnv(h),
    timeout: RENEW_MS,
    killSignal: 'SIGKILL'
  })
    .then(() => {})
    .finally(() => renewing.delete(h.dir));
  renewing.set(h.dir, next);
  return next;
}

/**
 * Why a Grok run that may last `lastsMs` cannot start for its sign-in, else
 * nothing. Grok renews its own sign-in, but the profile holds the whole grok
 * process and keeps it from writing auth.json (measured), so a renewal inside
 * a run lives only in that run's memory. Once the stored sign-in ran out,
 * every run then waited on 401s, which its stream never shows, until the
 * office cut it 20 minutes later. So a sign-in that could run out before the
 * run ends is renewed first, and a run whose sign-in has still run out is
 * refused at once.
 */
export async function grokSignedOut(
  lastsMs: number,
  account: string = OFFICE_ACCOUNT
): Promise<string | undefined> {
  const h = grokHome(account);
  const ends = signInEnds(h);
  if (ends === undefined || ends > Date.now() + lastsMs + SIGN_IN_MARGIN_MS) return undefined;
  await renew(h);
  const renewed = signInEnds(h);
  return renewed !== undefined && renewed > Date.now() ? undefined : GROK_SIGN_IN;
}
