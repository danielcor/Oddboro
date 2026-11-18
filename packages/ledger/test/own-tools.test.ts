// Run commands, Browse the web and folders the owner gives an Odd: which tool
// follows the switch and which is offered in its place, what each owner change
// records, and which folders are refused at the door. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { AGENTS, COMMANDS_WHY, commandsHow, type Agent } from '../src/agents.ts';
import { eq } from 'drizzle-orm';
import { staff } from '../src/schema.ts';
import { db, sql } from './pglite.ts';
import { TEMP_IN_APPDATA } from './store-states.ts';

// A home of the test's own, with the office's home and code inside it, set
// before office.ts loads: home.ts fixes both at import.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'own-tools-')));
process.env.HOME = HOME;
process.env.ODDBORO_HOME = join(HOME, '.oddboro');
process.env.ODDBORO_CODE = join(HOME, 'code', 'oddboro');
after(() => rmSync(HOME, { recursive: true, force: true }));
const O = await import('../src/office.ts');
const C = await import('../src/capabilities.ts');

/** Makes a folder under the test's home, and gives back its path. */
function folder(...parts: string[]): string {
  const p = join(HOME, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

// Every await comes before the first test: the database closes once the tests end.
await db.insert(staff).values({
  id: 'ziva',
  name: 'Ziva',
  role: 'r',
  variant: 'v',
  portrait: 'p',
  remit: 'r',
  desk: 'd'
});

beforeEach(async () => {
  await sql`delete from ledger`;
});

test('commandsHow per tool and system', () => {
  const want: Record<Agent, Record<'darwin' | 'linux' | 'win32', string>> = {
    claude: { darwin: 'switch', linux: 'never', win32: 'never' },
    codex: { darwin: 'switch', linux: 'switch', win32: 'never' },
    grok: { darwin: 'never', linux: 'never', win32: 'never' },
    gemini: { darwin: 'never', linux: 'never', win32: 'never' }
  };
  // Under a switch locked off, the tool that follows it on that system: Claude
  // Code on a Mac, Codex on Linux, and none on Windows.
  const offers: Record<'darwin' | 'linux' | 'win32', Agent | undefined> = {
    darwin: 'claude',
    linux: 'codex',
    win32: undefined
  };
  for (const agent of AGENTS)
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const how = commandsHow(agent, platform);
      assert.equal(how.state, want[agent][platform], `${agent} on ${platform}`);
      assert.equal(
        'why' in how ? how.why : undefined,
        how.state === 'switch' ? undefined : COMMANDS_WHY[agent]
      );
      // Only a switch locked off offers another tool.
      assert.equal(
        'offer' in how ? how.offer : undefined,
        how.state === 'never' ? offers[platform] : undefined,
        `${agent} on ${platform}`
      );
    }
  assert.deepEqual(COMMANDS_WHY, {
    claude: 'Not tested on this system yet.',
    codex: 'Not safe on Windows yet: Codex cannot keep commands in this Odd’s folders here.',
    grok: "Not with Grok yet: its sandbox can't keep commands off the internet on every system.",
    gemini: 'Not tested with Gemini yet.'
  });
});

const titles = async () =>
  (await sql<{ title: string }>`select title from ledger order by id`).map((r) => r.title);

/** `fn`, run as if the office ran on `platform`. */
async function onPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    await fn();
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
}

test("a switch or a move that opens or closes commands' internet says so in its Ledger line", async () => {
  const odd = (id: string, o: { agent: Agent; commands: boolean; web: boolean }) => ({
    id,
    name: id,
    role: 'r',
    variant: 'v',
    portrait: 'p',
    remit: 'r',
    desk: 'd',
    ...o
  });
  await db
    .insert(staff)
    .values([
      odd('Nell', { agent: 'claude', commands: true, web: false }),
      odd('Otis', { agent: 'claude', commands: false, web: false }),
      odd('Gale', { agent: 'grok', commands: true, web: true }),
      odd('Wren', { agent: 'claude', commands: false, web: true }),
      odd('Cass', { agent: 'codex', commands: false, web: false }),
      odd('Hale', { agent: 'grok', commands: false, web: true })
    ]);
  await onPlatform('darwin', async () => {
    await O.setOwnTool('Nell', 'web', true);
    await O.setOwnTool('Nell', 'web', false);
    await O.setOwnTool('Otis', 'web', true);
    await O.setAgent('Gale', 'claude');
    // Run commands, with Browse the web already on, opens the internet too.
    await O.setOwnTool('Wren', 'commands', true);
    await O.setOwnTool('Wren', 'commands', false);
    // Codex's commands stay off the internet, so neither its web nor a move to it opens it.
    await O.setOwnTool('Cass', 'web', true);
    await O.setAgent('Hale', 'codex');
  });
  const lines = await sql<{ title: string; body: string }>`
    select title, body from ledger order by id`;
  assert.deepEqual(
    lines.map((l) => [l.title, l.body]),
    [
      ['Let Nell browse the web', O.NETWORK_NOTE.on],
      ['Stopped Nell browsing the web', O.NETWORK_NOTE.off],
      ['Let Otis browse the web', ''],
      ['Moved Gale from Grok to Claude Code', O.NETWORK_NOTE.on],
      ['Let Wren run commands', O.NETWORK_NOTE.on],
      ['Stopped Wren running commands', O.NETWORK_NOTE.off],
      ['Let Cass browse the web', ''],
      ['Moved Hale from Grok to Codex', '']
    ]
  );
  assert.deepEqual(O.NETWORK_NOTE, {
    on: 'Its commands can reach the internet now.',
    off: 'Its commands are off the internet now.',
    held: 'This version of Claude Code refuses to let commands reach the whole internet. Commands keep working, with no network. Restarting the office lifts this.'
  });
});

test("while the office holds the network, a change that would open a Claude Code Odd's commands to the internet says the hold's words", async () => {
  const odd = (id: string, agent: Agent, web: boolean) => ({
    id,
    name: id,
    role: 'r',
    variant: 'v',
    portrait: 'p',
    remit: 'r',
    desk: 'd',
    agent,
    commands: true,
    web
  });
  await db.insert(staff).values([odd('Ivy', 'claude', false), odd('Jude', 'codex', true)]);
  await onPlatform('darwin', async () => {
    await O.holdNetwork();
    try {
      await O.setOwnTool('Ivy', 'web', true);
      await O.setAgent('Jude', 'claude');
      await O.setOwnTool('Ivy', 'web', false);
    } finally {
      O.resetHeldNetwork();
    }
  });
  const lines = await sql<{ title: string; body: string }>`
    select title, body from ledger order by id`;
  assert.deepEqual(
    lines.map((l) => [l.title, l.body]),
    [
      ["Kept Odds' commands off the internet", O.NETWORK_NOTE.held],
      ['Let Ivy browse the web', O.NETWORK_NOTE.held],
      ['Moved Jude from Codex to Claude Code', O.NETWORK_NOTE.held],
      ['Stopped Ivy browsing the web', O.NETWORK_NOTE.off]
    ]
  );
});

test('setOwnTool and setFolder record one line each', { skip: TEMP_IN_APPDATA }, async () => {
  // Ziva is on Claude Code, which follows the switch on a Mac only.
  await onPlatform('darwin', async () => {
    await O.setOwnTool('ziva', 'commands', true);
    await O.setOwnTool('ziva', 'commands', true);
    await O.setOwnTool('ziva', 'commands', false);
  });
  await O.setOwnTool('ziva', 'web', true);
  await O.setOwnTool('ziva', 'web', true);
  await O.setOwnTool('ziva', 'web', false);
  const game = folder('Documents', 'GitHub', 'my-game');
  await O.setFolder('ziva', game, 'read');
  await O.setFolder('ziva', game, 'read');
  await O.setFolder('ziva', game, 'write');
  assert.deepEqual((await O.staffer('ziva'))?.folders, [{ path: game, write: true }]);
  await O.setFolder('ziva', game, null);
  await O.setFolder('ziva', game, null);
  assert.deepEqual(await titles(), [
    'Let Ziva run commands',
    'Stopped Ziva running commands',
    'Let Ziva browse the web',
    'Stopped Ziva browsing the web',
    'Let Ziva read ~/Documents/GitHub/my-game',
    'Let Ziva read and change ~/Documents/GitHub/my-game',
    'Took ~/Documents/GitHub/my-game from Ziva'
  ]);
  const row = await O.staffer('ziva');
  assert.deepEqual([row?.commands, row?.web, row?.folders], [false, false, []]);
});

test('Run commands cannot be stored for a tool that does not follow it, from any caller', async () => {
  const odd = (id: string, agent: Agent, commands: boolean) => ({
    id,
    name: id,
    role: 'r',
    variant: 'v',
    portrait: 'p',
    remit: 'r',
    desk: 'd',
    agent,
    commands
  });
  await db
    .insert(staff)
    .values([odd('Lin', 'claude', false), odd('Gus', 'grok', false), odd('Gil', 'grok', true)]);
  const why = (agent: Agent) => ({ refused: COMMANDS_WHY[agent] });
  await onPlatform('linux', async () => {
    assert.deepEqual(await O.setOwnTool('Lin', 'commands', true), why('claude'));
    assert.deepEqual(await O.setAgent('Gus', 'claude', true), why('claude'));
  });
  await onPlatform('darwin', async () => {
    assert.deepEqual(await O.setOwnTool('Gus', 'commands', true), why('grok'));
    // A repeat of the stored value is refused too, as the owner's click would be.
    assert.deepEqual(await O.setOwnTool('Gil', 'commands', true), why('grok'));
    assert.deepEqual(await O.setOwnTool('Gil', 'commands', false), why('grok'));
    assert.deepEqual(await O.setAgent('Lin', 'grok', true), why('grok'));
  });
  const rows = await sql<{ id: string; agent: string; commands: boolean }>`
    select id, agent, commands from staff where id in ('Lin', 'Gus', 'Gil') order by id`;
  assert.deepEqual(
    rows.map((r) => [r.id, r.agent, r.commands]),
    [
      ['Gil', 'grok', true],
      ['Gus', 'grok', false],
      ['Lin', 'claude', false]
    ]
  );
  assert.deepEqual(await titles(), []);
  // Where the new tool follows the switch, the move and the switch go together.
  await onPlatform('darwin', async () => {
    assert.equal(await O.setAgent('Gus', 'claude', true), undefined);
  });
  const gus = await O.staffer('Gus');
  assert.deepEqual([gus?.agent, gus?.commands], ['claude', true]);
  assert.deepEqual(await titles(), ['Moved Gus from Grok to Claude Code', 'Let Gus run commands']);
});

test(
  'a folder the check refuses is never stored, from any caller, and a folder given is stored by its real path',
  { skip: TEMP_IN_APPDATA },
  async () => {
    await db.insert(staff).values({
      id: 'Fay',
      name: 'Fay',
      role: 'r',
      variant: 'v',
      portrait: 'p',
      remit: 'r',
      desk: 'd'
    });
    folder('.ssh');
    assert.deepEqual(await O.setFolder('Fay', '~/.ssh', 'read'), {
      refused: O.FOLDER_REFUSED.secrets
    });
    assert.deepEqual(await O.setFolder('Fay', join(HOME, '.ssh'), 'write'), {
      refused: O.FOLDER_REFUSED.secrets
    });
    assert.deepEqual(await O.setFolder('Fay', HOME, 'read'), { refused: O.FOLDER_REFUSED.home });
    assert.deepEqual((await O.staffer('Fay'))?.folders, []);
    assert.deepEqual(await titles(), []);
    const notes = folder('notes');
    symlinkSync(notes, join(HOME, 'notes-link'));
    assert.equal(await O.setFolder('Fay', '~/notes-link', 'read'), undefined);
    assert.deepEqual((await O.staffer('Fay'))?.folders, [{ path: notes, write: false }]);
  }
);

test(
  'checkFolder refuses what holds keys, the home, the office and its code, and what holds the home',
  { skip: TEMP_IN_APPDATA },
  () => {
    const R = O.FOLDER_REFUSED;
    // The glob line names its character: the next test reads it.
    const { glob: _glob, ...fixed } = R;
    assert.deepEqual(fixed, {
      missing: 'No such folder.',
      home: 'Pick a folder inside your home, not the whole home.',
      secrets: 'That folder holds your keys or sign-ins.',
      code: "That folder holds Oddboro's own code.",
      nested: "That folder holds one of this Odd's folders that has your keys or sign-ins.",
      readInsideChange:
        "A folder on Can read can't sit inside one on Can write. This Odd can already change everything in it.",
      broad: 'That folder is a whole drive or holds system files. Ask for a narrower one.'
    });
    const refused = (path: string) => O.checkFolder(path);
    for (const s of O.SECRET_STORES) folder(s);
    folder('.ssh', 'keys');
    folder('.oddboro', 'staff');
    folder('code', 'oddboro', 'apps');
    writeFileSync(join(HOME, 'notes.txt'), 'x');

    assert.deepEqual(refused('~/nowhere'), { refused: R.missing });
    assert.deepEqual(refused('~/notes.txt'), { refused: R.missing });
    assert.deepEqual(refused('relative/path'), { refused: R.missing });
    assert.deepEqual(refused('~'), { refused: R.home });
    assert.deepEqual(refused(HOME), { refused: R.home });
    // A folder holding the home holds its secret stores, whether they exist or not.
    assert.deepEqual(refused(tmpdir()), { refused: R.secrets });
    for (const s of O.SECRET_STORES) assert.deepEqual(refused(`~/${s}`), { refused: R.secrets }, s);
    assert.deepEqual(refused('~/.ssh/keys'), { refused: R.secrets });
    assert.deepEqual(refused('~/.oddboro/staff'), { refused: R.secrets });
    assert.deepEqual(refused('~/code'), { refused: R.code });
    assert.deepEqual(refused('~/code/oddboro/apps'), { refused: R.code });

    // A name that only starts like a secret store is not one.
    const sshx = folder('.sshx');
    assert.deepEqual(refused('~/.sshx'), { real: sshx });
    assert.deepEqual(refused(' ~/.sshx/ '), { real: sshx });
  }
);

test(
  'checkFolder refuses a folder whose real path holds a character Codex reads as a glob, naming it, and takes {, } and !',
  { skip: TEMP_IN_APPDATA },
  () => {
    const R = O.FOLDER_REFUSED;
    assert.equal(R.glob('['), "That folder's path has a character an Odd's tool can't take: [");
    folder('Photos [2024]');
    assert.deepEqual(O.checkFolder('~/Photos [2024]'), { refused: R.glob('[') });
    folder('a*b', 'inner');
    assert.deepEqual(O.checkFolder('~/a*b/inner'), { refused: R.glob('*') });
    folder('q?x');
    assert.deepEqual(O.checkFolder('~/q?x'), { refused: R.glob('?') });
    folder('a]b');
    assert.deepEqual(O.checkFolder('~/a]b'), { refused: R.glob(']') });
    const braces = folder('x{y}');
    assert.deepEqual(O.checkFolder('~/x{y}'), { real: braces });
    const bang = folder('i!j');
    assert.deepEqual(O.checkFolder('~/i!j'), { real: bang });
    // A typed path with no such character, whose real path has one.
    symlinkSync(folder('pics [old]'), join(HOME, 'pics'));
    assert.deepEqual(O.checkFolder('~/pics'), { refused: R.glob('[') });
  }
);

test('the secret stores are the ones the office keeps shut', () => {
  assert.deepEqual(O.SECRET_STORES, [
    '.ssh',
    '.aws',
    '.gnupg',
    '.config',
    'Library',
    'AppData',
    '.claude',
    '.claude.json',
    '.google_workspace_mcp',
    '.grok',
    '.codex',
    '.gemini',
    '.docker',
    '.kube',
    '.mozilla',
    '.local/share/keyrings',
    '.pki',
    'snap',
    '.var/app'
  ]);
});

test(
  "checkFolder refuses Docker's and Kubernetes' folders, which hold sign-ins and cluster keys",
  { skip: TEMP_IN_APPDATA },
  () => {
    folder('.docker');
    folder('.kube');
    assert.deepEqual(O.checkFolder('~/.docker'), { refused: O.FOLDER_REFUSED.secrets });
    assert.deepEqual(O.checkFolder('~/.kube'), { refused: O.FOLDER_REFUSED.secrets });
  }
);

/** Each name a project may share with a store: what a project keeps there, and each file only the real store holds. */
const SHARED_NAMES = [
  { store: '.docker', project: 'Dockerfile', marks: ['config.json'] },
  { store: '.kube', project: 'overlay.yaml', marks: ['config'] },
  { store: '.config', project: 'dotnet-tools.json', marks: ['gcloud', 'gh/hosts.yml'] }
];

/** A run's own tools for an Odd that was stored with this one folder. */
const reachesRuns = (path: string) =>
  C.ownTools(
    { agent: 'claude', commands: false, web: false, folders: [{ path, write: false }] },
    'darwin'
  ).granted.length === 1;

for (const platform of ['darwin', 'linux'] as const)
  test(
    `outside the home on ${platform}, a project's own .docker, .kube or .config is given and reaches runs: the folder, one in it and one holding it`,
    { skip: TEMP_IN_APPDATA },
    () =>
      onPlatform(platform, async () => {
        for (const { store, project } of SHARED_NAMES) {
          const top = outside('app');
          const at = join(top, store);
          mkdirSync(join(at, 'inner'), { recursive: true });
          writeFileSync(join(at, project), '');
          for (const p of [top, at, join(at, 'inner')]) {
            assert.deepEqual(O.checkFolder(p, true), { real: p }, `${store} ${p}`);
            assert.equal(O.touchesSecretStore(p), false, `${store} ${p}`);
            assert.equal(reachesRuns(p), true, `${store} ${p}`);
          }
        }
      })
  );

for (const platform of ['darwin', 'linux'] as const)
  test(
    `outside the home on ${platform}, a real Docker, Kubernetes or sign-in folder is refused whatever the owner accepts, and one already stored reaches no run`,
    { skip: TEMP_IN_APPDATA },
    () =>
      onPlatform(platform, async () => {
        for (const { store, project, marks } of SHARED_NAMES)
          for (const mark of marks) {
            const top = outside('drive');
            const at = join(top, store);
            mkdirSync(join(at, 'inner'), { recursive: true });
            writeFileSync(join(at, project), '');
            mkdirSync(dirname(join(at, mark)), { recursive: true });
            writeFileSync(join(at, mark), '');
            for (const p of [top, at, join(at, 'inner')]) {
              for (const accept of [true, false])
                assert.deepEqual(
                  O.checkFolder(p, accept),
                  { refused: O.FOLDER_REFUSED.secrets },
                  `${store} ${mark} ${p}`
                );
              assert.equal(reachesRuns(p), false, `${store} ${mark} ${p}`);
            }
          }
      })
  );

test(
  "outside the home, the warning still comes first for a project's own .docker, .kube or .config in system files, and only the Accept gives it",
  { skip: TEMP_IN_APPDATA },
  async () => {
    for (const { store, project } of SHARED_NAMES) {
      const top = outside('app');
      mkdirSync(join(top, store));
      writeFileSync(join(top, store, project), '');
      assert.deepEqual(O.checkFolder(top), { warning: O.FOLDER_WARNING }, store);
      assert.deepEqual(await O.setFolder('ziva', top, 'read'), { warning: O.FOLDER_WARNING });
      assert.deepEqual((await O.staffer('ziva'))?.folders, [], store);
      assert.equal(await O.setFolder('ziva', top, 'read', true), undefined, store);
      assert.deepEqual((await O.staffer('ziva'))?.folders, [{ path: top, write: false }], store);
      await O.setFolder('ziva', top, null);
    }
  }
);

test(
  'outside the home, a real store is refused when given and stores nothing, Accept or not',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const top = outside('drive');
    mkdirSync(join(top, '.docker'));
    writeFileSync(join(top, '.docker', 'config.json'), '{}');
    assert.deepEqual(await O.setFolder('ziva', top, 'read', true), {
      refused: O.FOLDER_REFUSED.secrets
    });
    assert.deepEqual((await O.staffer('ziva'))?.folders, []);
  }
);

test(
  'outside the home, a file only named like a store is no store, and a project .claude of settings is still given as the folder itself',
  { skip: TEMP_IN_APPDATA },
  () => {
    for (const store of ['.docker', '.kube', '.config']) {
      const top = outside('app');
      writeFileSync(join(top, store), '');
      assert.deepEqual(O.checkFolder(top, true), { real: top }, store);
    }
    const project = outside('project');
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.json'), '{}');
    assert.deepEqual(O.checkFolder(join(project, '.claude'), true), {
      real: join(project, '.claude')
    });
    assert.equal(reachesRuns(join(project, '.claude')), true);
    // gh's settings without its sign-in file are no store.
    const gh = outside('app');
    mkdirSync(join(gh, '.config', 'gh'), { recursive: true });
    writeFileSync(join(gh, '.config', 'gh', 'config.yml'), '');
    assert.deepEqual(O.checkFolder(gh, true), { real: gh });
  }
);

test(
  "in the home, .docker, .kube and .config are refused by name with no sign-in in them, and a project's own inside the home is given",
  { skip: TEMP_IN_APPDATA },
  () => {
    for (const store of ['.docker', '.kube', '.config']) {
      const at = folder(store, 'inner');
      for (const accept of [true, false]) {
        assert.deepEqual(O.checkFolder(`~/${store}`, accept), {
          refused: O.FOLDER_REFUSED.secrets
        });
        assert.deepEqual(O.checkFolder(at, accept), { refused: O.FOLDER_REFUSED.secrets });
      }
      assert.equal(reachesRuns(at), false, store);
      const project = folder('Projects', 'app');
      mkdirSync(join(project, store), { recursive: true });
      assert.deepEqual(O.checkFolder(project), { real: project }, store);
    }
  }
);

test(
  'on a Mac, checkFolder refuses a secret store or the office typed in another case',
  { skip: process.platform !== 'darwin' && "only a Mac's disk ignores case" },
  () => {
    folder('.ssh');
    folder('.claude');
    folder('.oddboro');
    folder('Library', 'Keychains');
    for (const typed of ['~/.SSH', '~/LIBRARY', '~/library/Keychains', '~/.CLAUDE', '~/.Oddboro'])
      assert.deepEqual(O.checkFolder(typed), { refused: O.FOLDER_REFUSED.secrets }, typed);
  }
);

test(
  'checkFolder refuses a link into a secret store, and a folder holding where one leads',
  { skip: TEMP_IN_APPDATA },
  () => {
    folder('.ssh');
    symlinkSync(join(HOME, '.ssh'), join(HOME, 'x'));
    assert.deepEqual(O.checkFolder('~/x'), { refused: O.FOLDER_REFUSED.secrets });
    // A secret store that is itself a link, as a dotfiles folder makes one.
    rmSync(join(HOME, '.gnupg'), { recursive: true, force: true });
    symlinkSync(folder('dots', 'gnupg'), join(HOME, '.gnupg'));
    assert.deepEqual(O.checkFolder('~/dots'), { refused: O.FOLDER_REFUSED.secrets });
    // A folder that only holds a `.ssh` of its own is not a secret store.
    const project = folder('project');
    folder('project', '.ssh');
    assert.deepEqual(O.checkFolder('~/project'), { real: project });
  }
);

/** A folder outside the test's home, made now, by its real path. */
function outside(...parts: string[]): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')));
  after(() => rmSync(top, { recursive: true, force: true }));
  const p = join(top, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

test(
  'checkFolder gives a folder outside the home, warning first when it sits in system files',
  { skip: TEMP_IN_APPDATA },
  () => {
    assert.equal(
      O.FOLDER_WARNING,
      "This folder is a whole drive or holds system files, so an Odd could reach everything inside it. We don't recommend giving it."
    );
    // The system's temp folder is in /private (a Mac) or /tmp (Linux): system files.
    const out = outside('projects', 'game');
    assert.deepEqual(O.checkFolder(out), { warning: O.FOLDER_WARNING });
    assert.deepEqual(O.checkFolder(out, true), { real: out });
    // A folder in the home never warns, wherever the home sits.
    const inHome = folder('Projects', 'game');
    assert.deepEqual(O.checkFolder(inHome), { real: inHome });
  }
);

test(
  'outside the home, checkFolder refuses a secret store by what it holds, in the folder, above it and one level down',
  { skip: TEMP_IN_APPDATA },
  () => {
    const R = O.FOLDER_REFUSED;
    const keys = outside('keys');
    mkdirSync(join(keys, '.ssh'));
    writeFileSync(join(keys, '.ssh', 'id_ed25519'), '');
    assert.deepEqual(O.checkFolder(keys, true), { refused: R.secrets });
    assert.deepEqual(O.checkFolder(join(keys, '.ssh'), true), { refused: R.secrets });

    // A coding tool's home by its sign-in or history, at the top or above.
    const drive = outside('drive');
    mkdirSync(join(drive, '.codex', 'sessions'), { recursive: true });
    writeFileSync(join(drive, '.codex', 'auth.json'), '{}');
    assert.deepEqual(O.checkFolder(drive, true), { refused: R.secrets });
    assert.deepEqual(O.checkFolder(join(drive, '.codex', 'sessions'), true), {
      refused: R.secrets
    });
    const claude = outside('claude-home');
    mkdirSync(join(claude, '.claude'));
    writeFileSync(join(claude, '.claude', 'history.jsonl'), '');
    assert.deepEqual(O.checkFolder(claude, true), { refused: R.secrets });

    // A project's own .claude or .codex of settings is no store.
    const project = outside('project');
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.json'), '{}');
    mkdirSync(join(project, '.codex'));
    writeFileSync(join(project, '.codex', 'config.toml'), '');
    assert.deepEqual(O.checkFolder(project, true), { real: project });

    // Deeper than one level is not looked at: the site's page says so.
    const deep = outside('deep');
    mkdirSync(join(deep, 'backup', '.ssh'), { recursive: true });
    writeFileSync(join(deep, 'backup', '.ssh', 'id_ed25519'), '');
    assert.deepEqual(O.checkFolder(deep, true), { real: deep });
  }
);

test(
  'outside the home, every secret store is refused and kept from runs: the folder, one in it and one holding it',
  { skip: TEMP_IN_APPDATA },
  () => {
    const R = O.FOLDER_REFUSED;
    for (const [store, marks] of Object.entries(O.STORE_MARKS))
      // Each mark alone, so a list that lost one fails; no marks is the name alone.
      for (const mark of marks.length ? marks : [undefined]) {
        const top = outside('drive');
        const at = join(top, store);
        if (store === '.claude.json') writeFileSync(at, '{}');
        else {
          mkdirSync(join(at, 'inner'), { recursive: true });
          if (mark) {
            mkdirSync(dirname(join(at, mark)), { recursive: true });
            writeFileSync(join(at, mark), '');
          }
          assert.deepEqual(O.checkFolder(at, true), { refused: R.secrets }, store);
          assert.deepEqual(O.checkFolder(join(at, 'inner'), true), { refused: R.secrets }, store);
          assert.equal(O.touchesSecretStore(at), true, store);
        }
        assert.deepEqual(O.checkFolder(top, true), { refused: R.secrets }, store);
        // A folder stored before the store was there reaches no run.
        assert.equal(O.touchesSecretStore(top), true, store);
      }
  }
);

test(
  "outside the home, an ordinary folder named Library or AppData with no one's sign-ins in it is not a secret store",
  { skip: TEMP_IN_APPDATA },
  () => {
    for (const store of ['Library', 'AppData']) {
      const top = outside('photos');
      mkdirSync(join(top, store, 'Keychains'), { recursive: true });
      assert.deepEqual(O.checkFolder(top, true), { real: top }, store);
      assert.deepEqual(O.checkFolder(join(top, store), true), { real: join(top, store) }, store);
      assert.equal(O.touchesSecretStore(top), false, store);
    }
  }
);

test(
  'setFolder warns on a whole drive or system files and stores nothing, and the Accept gives it',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const out = outside('wide');
    assert.deepEqual(await O.setFolder('ziva', out, 'read'), { warning: O.FOLDER_WARNING });
    assert.deepEqual((await O.staffer('ziva'))?.folders, []);
    assert.deepEqual(await titles(), []);
    assert.equal(await O.setFolder('ziva', out, 'read', true), undefined);
    assert.deepEqual((await O.staffer('ziva'))?.folders, [{ path: out, write: false }]);
    assert.equal((await titles()).length, 1);
  }
);

test(
  "setFolder and an Odd's ask refuse only a folder to read inside one to change",
  { skip: TEMP_IN_APPDATA },
  async () => {
    const outer = folder('nest', 'outer');
    const inner = folder('nest', 'outer', 'inner');
    const refused = { refused: O.FOLDER_REFUSED.readInsideChange };
    const set = (folders: { path: string; write: boolean }[]) =>
      db.update(staff).set({ folders }).where(eq(staff.id, 'ziva'));
    const has = async () => (await O.staffer('ziva'))?.folders;
    const level = (write: boolean) => (write ? 'write' : 'read');
    // Every pair, given in either order: only read inside change is refused.
    for (const outerWrite of [false, true])
      for (const innerWrite of [false, true])
        for (const innerFirst of [false, true]) {
          const pair = [
            { path: outer, write: outerWrite },
            { path: inner, write: innerWrite }
          ];
          const [first, second] = innerFirst ? [pair[1], pair[0]] : pair;
          const say = JSON.stringify({ outerWrite, innerWrite, innerFirst });
          await set([first]);
          const done = await O.setFolder('ziva', second.path, level(second.write));
          if (outerWrite && !innerWrite) {
            assert.deepEqual(done, refused, say);
            assert.deepEqual(await has(), [first], say);
          } else {
            assert.equal(done, undefined, say);
            assert.deepEqual(await has(), [first, second], say);
          }
        }
    // The Settings tab adds a folder at read, then the owner switches it:
    // outer at read, inner added at read, inner switched to write.
    await set([]);
    assert.equal(await O.setFolder('ziva', outer, 'read'), undefined);
    assert.equal(await O.setFolder('ziva', inner, 'read'), undefined);
    assert.equal(await O.setFolder('ziva', inner, 'write'), undefined);
    assert.deepEqual(await has(), [
      { path: outer, write: false },
      { path: inner, write: true }
    ]);
    // A level change that would leave read inside change is refused and changes nothing.
    await set([
      { path: outer, write: false },
      { path: inner, write: false }
    ]);
    assert.deepEqual(await O.setFolder('ziva', outer, 'write'), refused);
    await set([
      { path: outer, write: true },
      { path: inner, write: true }
    ]);
    assert.deepEqual(await O.setFolder('ziva', inner, 'read'), refused);
    assert.equal((await has())?.length, 2);
    // An Odd's ask follows the same rule; one a held folder covers says so.
    const who = (folders: { path: string; write: boolean }[]) => ({ folders });
    assert.equal(
      O.folderAskRefused(who([{ path: outer, write: false }]), inner, 'write'),
      undefined
    );
    assert.equal(O.folderAskRefused(who([{ path: inner, write: true }]), outer, 'read'), undefined);
    assert.equal(
      O.folderAskRefused(who([{ path: inner, write: false }]), outer, 'read'),
      undefined
    );
    assert.match(
      O.folderAskRefused(who([{ path: outer, write: false }]), inner, 'read') ?? '',
      /You already have/
    );
    assert.equal(
      O.folderAskRefused(who([{ path: inner, write: false }]), outer, 'write'),
      O.FOLDER_REFUSED.readInsideChange
    );
  }
);

// node:path follows the real system, so onPlatform cannot make Windows read these paths.
const MAC_AND_LINUX_PATHS = process.platform === 'win32' && 'the paths here are a Mac and Linux';

test(
  "broadFolder goes by the office's system: /boot is system files on Linux and nothing on a Mac",
  { skip: MAC_AND_LINUX_PATHS },
  async () => {
    await onPlatform('linux', async () => assert.equal(O.broadFolder('/boot/grub'), true));
    await onPlatform('darwin', async () => assert.equal(O.broadFolder('/boot/grub'), false));
  }
);

test(
  'broadFolder is a whole drive or volume, or system files, and never a folder in the home',
  { skip: MAC_AND_LINUX_PATHS },
  () => {
    // broadFolder takes a real path, as checkFolder gives it: /bin is a link on Ubuntu.
    for (const p of ['/', '/usr', '/usr/local/share', '/bin'])
      assert.equal(O.broadFolder(existsSync(p) ? realpathSync.native(p) : p), true, p);
    assert.equal(O.broadFolder('/Volumes/Data'), true);
    assert.equal(O.broadFolder('/mnt/d'), true);
    assert.equal(O.broadFolder('/media/ada/disk'), true);
    assert.equal(O.broadFolder('/run/media/ada/disk'), true);
    for (const p of ['/Volumes/Data/Projects', '/mnt/d/projects', '/opt/projects', '/srv/site'])
      assert.equal(O.broadFolder(p), false, p);
    assert.equal(O.broadFolder(folder('Projects')), false);
  }
);
