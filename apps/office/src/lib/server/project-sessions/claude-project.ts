import { join, dirname } from 'node:path';
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  rmSync,
  existsSync,
  watch,
  type FSWatcher
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  home,
  STAFF_SERVER,
  PROJECT_RECEIVERS,
  type ProjectSession,
  type ProjectRequest
} from '@oddboro/ledger';
import { pathToFileURL } from 'node:url';
import { AGENT_NAMES } from '@oddboro/ledger/agents';
import { currentSystem, probe } from '@oddboro/ledger/platform';
import { computerWord } from '@oddboro/ledger/system-words';
import { nativeCommand, nativeEnv } from './native.ts';
import { savedClaudeSessions } from './claude-sessions.ts';
type Active = {
  sessionId?: string;
  id?: string;
  kind: string;
  cwd: string;
  name?: string;
  status?: string;
  waitingFor?: string;
};
/**
 * What the owner reads when Claude Code cannot list a project's conversations.
 * The project-sessions route shows a thrown message as it is, so a raw error
 * from starting the command (its path, ENOENT) never reaches the owner.
 * `missing` names the system as it is when the listing fails, not as this file
 * loaded, since a test fakes the system after that.
 */
export const CLAUDE_LIST_FAILED = {
  missing: () => `${AGENT_NAMES.claude} is not installed on this ${computerWord(currentSystem())}.`,
  failed: `${AGENT_NAMES.claude} could not list this project's conversations. Try again.`
};

/**
 * The sessions `claude agents --json` printed, or undefined when it printed
 * anything but a list. Entries that are not objects are left out.
 */
function agentList(out: string): Active[] | undefined {
  let list: unknown;
  try {
    list = JSON.parse(out);
  } catch {
    // The caller tells the owner the listing failed; the parser's own words
    // would show them a raw SyntaxError.
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  return list.filter((a): a is Active => typeof a === 'object' && a !== null);
}

/** The Claude Code sessions running in `folder`, from `claude agents --json`. */
async function claudeAgents(folder: string): Promise<Active[]> {
  const [exe, prefix] = nativeCommand('claude');
  const r = await probe(exe, [...prefix, 'agents', '--json', '--cwd', folder], {
    env: nativeEnv(),
    cwd: folder,
    timeout: 10000,
    maxBuffer: 4_000_000
  });
  switch (r.status) {
    case 'ok': {
      const list = agentList(r.out);
      if (!list) throw new Error(CLAUDE_LIST_FAILED.failed);
      return list;
    }
    case 'missing':
      throw new Error(CLAUDE_LIST_FAILED.missing());
    case 'failed':
    case 'timeout':
      throw new Error(CLAUDE_LIST_FAILED.failed);
    default: {
      const missed: never = r;
      throw new Error(`claude agents came back as ${JSON.stringify(missed)}`);
    }
  }
}

export async function claudeProjects(folder: string) {
  const [history, processes] = await Promise.all([
    savedClaudeSessions(folder),
    claudeAgents(folder)
  ]);
  const active = processes.filter((a) => a.cwd === folder && a.sessionId);
  const rows = new Map(
    history
      .filter((h) => !h.cwd || h.cwd === folder)
      .map((h) => [
        h.sessionId,
        {
          id: h.sessionId,
          title: h.title,
          updated: h.lastModified,
          live: false,
          job: ''
        }
      ])
  );
  for (const a of active)
    rows.set(a.sessionId!, {
      id: a.sessionId!,
      title: a.name || rows.get(a.sessionId!)?.title || 'Claude Code',
      updated: rows.get(a.sessionId!)?.updated || Date.now(),
      live: true,
      job: a.id || ''
    });
  return [...rows.values()].sort((a, b) => b.updated - a.updated);
}
const jsonFile = (p: string, data: unknown) => {
  const tmp = p + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, p);
};
const boxOf = (s: ProjectSession) => home('project-sessions', s.id, 'inbox');
export function prepareClaude(s: ProjectSession) {
  const root = home('project-sessions', s.id),
    market = join(root, 'market'),
    plugin = join(market, 'plugin'),
    box = boxOf(s);
  mkdirSync(box, { recursive: true, mode: 0o700 });
  mkdirSync(join(market, '.claude-plugin'), { recursive: true, mode: 0o700 });
  const ledger = dirname(dirname(STAFF_SERVER));
  cpSync(join(ledger, 'project-plugin'), plugin, { recursive: true });
  // Claude keys installed plugins by name. Two live conversations in one
  // project must keep distinct helpers even after both plugins are reloaded.
  const manifest = join(plugin, '.claude-plugin', 'plugin.json');
  const pluginName = 'oddboro-project-' + s.id;
  jsonFile(manifest, { ...JSON.parse(readFileSync(manifest, 'utf8')), name: pluginName });
  const ext = STAFF_SERVER.endsWith('.ts') ? '.ts' : '.js';
  const link = {
    command: process.execPath,
    args: [join(ledger, 'src', 'project-session-tools' + ext), box, s.nativeId, s.folder]
  };
  jsonFile(join(plugin, '.mcp.json'), { mcpServers: { oddboro_project: link } });
  // The shell line is fixed; paths and session identity live in the adjacent
  // launcher file as quoted JavaScript data, never as shell input.
  writeFileSync(
    join(plugin, 'start-watch.mjs'),
    'process.argv.push(' +
      JSON.stringify(box) +
      ',' +
      JSON.stringify(s.nativeId) +
      ',' +
      JSON.stringify(s.folder) +
      '); await import(' +
      JSON.stringify(pathToFileURL(join(ledger, 'src', 'project-watch' + ext)).href) +
      ');\n'
  );
  // The monitor runs in a POSIX shell, including Git Bash on Windows.
  // Desktop installs can have a bundled Node without a node on the PATH.
  const node = process.execPath.replaceAll('\\', '/').replaceAll("'", "'\\''");
  mkdirSync(join(plugin, 'monitors'), { recursive: true });
  jsonFile(join(plugin, 'monitors', 'monitors.json'), [
    {
      name: 'office-work',
      command: "'" + node + "'" + ' "${CLAUDE_PLUGIN_ROOT}/start-watch.mjs"',
      description: 'Work from your connected Oddboro office'
    }
  ]);
  jsonFile(join(market, '.claude-plugin', 'marketplace.json'), {
    name: 'oddboro-' + s.id,
    owner: { name: 'Oddboro' },
    plugins: [
      {
        name: pluginName,
        source: './plugin',
        description: 'Connect this project session to your office.'
      }
    ]
  });
  return { plugin, market, box };
}
/** Each send checks both live receivers, with no prompt leaving before they answer. */
export async function checkClaudeReceiver(s: ProjectSession) {
  const box = boxOf(s),
    key = randomUUID();
  const replies = PROJECT_RECEIVERS.map((receiver) => join(box, key + '.' + receiver));
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (replies.every((file) => existsSync(file))) resolve();
      };
      watcher = watch(box, check);
      watcher.on('error', reject);
      timer = setTimeout(
        () =>
          reject(
            new Error(
              'Claude’s office plugin is not ready. In Details, connect the plugin and reload it in this conversation, then retry. Nothing was sent.'
            )
          ),
        30_000
      );
      jsonFile(join(box, 'probe.json'), { key });
      check();
    });
  } finally {
    watcher?.close();
    clearTimeout(timer);
    for (const file of [join(box, 'probe.json'), ...replies]) rmSync(file, { force: true });
  }
}
export function postClaude(s: ProjectSession, r: ProjectRequest) {
  jsonFile(join(boxOf(s), 'offer.json'), { id: r.id, prompt: r.prompt });
}
/** Keep a correction against its original assignment until Claude acknowledges it. */
export function correctClaude(s: ProjectSession, id: string, prompt: string) {
  const box = boxOf(s),
    file = join(box, 'correction.json');
  if (JSON.parse(readFileSync(join(box, 'offer.json'), 'utf8')).id !== id)
    throw new Error('That assignment has ended.');
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    if (old.id === id && !existsSync(join(box, old.key + '.correction-read')))
      throw new Error('Claude has not picked up the previous correction yet.');
  }
  jsonFile(file, { id, key: randomUUID(), prompt });
}
export function clearClaude(s: ProjectSession, id: string) {
  const file = join(boxOf(s), 'offer.json');
  if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).id === id) rmSync(file);
}
export function hearClaude(
  s: ProjectSession,
  read: (id: string, answer?: string) => Promise<void>,
  corrected: (id: string) => void,
  failure: (e: unknown) => void
): FSWatcher {
  const box = boxOf(s);
  const check = (name: string) => {
    if (/^[0-9a-f-]{36}\.correction-read$/.test(name)) {
      try {
        corrected(JSON.parse(readFileSync(join(box, name), 'utf8')).id);
      } catch (e) {
        failure(e);
      }
      return;
    }
    const m = /^([0-9a-f-]{36})\.(accepted|reply)$/.exec(name);
    if (!m) return;
    try {
      const body = JSON.parse(readFileSync(join(box, name), 'utf8'));
      void read(m[1], m[2] === 'reply' ? body.answer : undefined).catch(failure);
    } catch (e) {
      failure(e);
    }
  };
  const w = watch(box, (_event, name) => {
    if (name) check(name);
  });
  // A reply published while the office was down must still reach its request.
  const offer = join(box, 'offer.json');
  if (existsSync(offer)) {
    const { id } = JSON.parse(readFileSync(offer, 'utf8'));
    for (const suffix of ['accepted', 'reply'])
      if (existsSync(join(box, id + '.' + suffix))) check(id + '.' + suffix);
  }
  return w;
}
