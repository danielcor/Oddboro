// One access profile per Odd: what its own tools reach on each system, what a
// handed-over run keeps, what the Odd and the Office Manager are told of it,
// what the hire drawer says of it, the words for levels, and when a run hands
// work on. office_report runs in
// the office tool server (src/mcp.ts) in a process of its own, over the
// office's own database in a throwaway folder (tool-server.ts). Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
// Types only, erased before run, so tool-server.ts still sets the office up first.
import type { Capabilities } from '../src/capabilities.ts';
import type { ConnectorRow } from '../src/office.ts';
import { db, toolServer } from './tool-server.ts';
import { TEMP_IN_APPDATA } from './store-states.ts';

const W = await import('../src/access-words.ts');
const A = await import('../src/agents.ts');
const C = await import('../src/capabilities.ts');
const { connectors, grants, staff, threads } = await import('../src/schema.ts');

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'access-profile-')));
after(() => rmSync(dir, { recursive: true, force: true }));
/** A folder made now, by its real path, as the owner gives one. */
function made(name: string): string {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
}

const kept = made('kept');
const gone = join(dir, 'gone');
const odd = (agent: (typeof A.AGENTS)[number], commands: boolean, web: boolean) => ({
  agent,
  commands,
  web,
  folders: [
    { path: kept, write: true },
    { path: gone, write: false }
  ]
});

// Every await comes before the first test: the database closes once the tests end.
const person = (id: string, name: string, tools: string[]) => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  desk: `You are ${name}.`,
  tools
});
await db.insert(staff).values([
  {
    ...person('mona', 'Mona', ['office_report']),
    role: 'Office Manager',
    web: true,
    folders: [{ path: kept, write: false }]
  },
  // Codex with Run commands on has a shell on a Mac and Linux, so the report
  // fills in whose developer tools it reads.
  { ...person('cody', 'Cody', []), agent: 'codex', commands: true, web: true },
  // Lena hands work on, and leads one thread.
  person('lena', 'Lena', ['hand_off']),
  // Bea's commands reach the internet, unless the office holds the network.
  { ...person('bea', 'Bea', []), commands: true, web: true },
  // Rae reads only, so her write grant is held back and she cannot ask for write.
  person('rae', 'Rae', ['find_connectors', 'ask_for_access'])
]);
await db.insert(connectors).values({
  id: 'notion',
  name: 'Notion',
  description: 'Notes.',
  kind: 'http',
  readyAt: new Date()
});
await db.insert(grants).values({ staffId: 'rae', connectorId: 'notion', level: 'act' });
const rae = await toolServer('rae', { RUN_KEY: 'k-access-profile-rae' });
const manager = await toolServer('mona', { RUN_KEY: 'k-access-profile' });
// Mona has no shell of her own, so only the office's flag tells her run the network is held.
const heldManager = await toolServer('mona', {
  RUN_KEY: 'k-access-profile-held',
  OFFICE_NETWORK_HELD: '1'
});
const [led] = await db
  .insert(threads)
  .values({ title: 'Count the chairs', hubId: 'lena', holderId: 'lena' })
  .returning({ id: threads.id });
/** The tools Lena's run is offered, with raise_ask's arguments, as the office starts it with `env`. */
async function offered(env: Record<string, string>) {
  const { tools } = await (await toolServer('lena', env)).listTools();
  return {
    handOff: tools.some((t) => t.name === 'hand_off'),
    work: 'work' in (tools.find((t) => t.name === 'raise_ask')?.inputSchema.properties ?? {})
  };
}
const runs = {
  offThread: await offered({ RUN_KEY: 'k-lena-chat' }),
  onThread: await offered({ RUN_KEY: 'k-lena-thread', THREAD_ID: String(led.id) }),
  handedOver: await offered({
    RUN_KEY: 'k-lena-hand-off',
    THREAD_ID: String(led.id),
    HAND_OFF_ID: '1'
  })
};

test(
  'ownTools is what a run reaches: the switch as its tool takes it, the web, the internet only with both, and given folders still on the disk',
  { skip: TEMP_IN_APPDATA },
  () => {
    const on = (who: ReturnType<typeof odd>, platform: NodeJS.Platform) => {
      const o = C.ownTools(who, platform);
      return { commands: o.commands, web: o.web, network: o.network };
    };
    assert.deepEqual(on(odd('claude', true, true), 'darwin'), {
      commands: true,
      web: true,
      network: true
    });
    assert.deepEqual(on(odd('claude', true, false), 'darwin'), {
      commands: true,
      web: false,
      network: false
    });
    // Codex follows the switch on a Mac and Linux. Its walls did not hold the
    // office's own ports with its network on, so its commands stay off it.
    for (const platform of ['darwin', 'linux'] as const) {
      assert.deepEqual(
        on(odd('codex', true, true), platform),
        { commands: true, web: true, network: false },
        platform
      );
      assert.deepEqual(
        on(odd('codex', false, true), platform),
        { commands: false, web: true, network: false },
        platform
      );
    }
    // On Windows its sandbox opened every Odd's folder, so it has no shell whatever is stored.
    assert.deepEqual(on(odd('codex', true, true), 'win32'), {
      commands: false,
      web: true,
      network: false
    });
    // The network follows the table: a tool marked as holding its walls open gets it, with commands on.
    const measured = A.AGENT_PLATFORMS.codex.networkWithWeb;
    A.AGENT_PLATFORMS.codex.networkWithWeb = ['darwin'];
    try {
      assert.equal(on(odd('codex', true, true), 'darwin').network, true);
      assert.equal(on(odd('codex', false, true), 'darwin').network, false);
    } finally {
      A.AGENT_PLATFORMS.codex.networkWithWeb = measured;
    }
    assert.deepEqual(on(odd('grok', true, true), 'darwin'), {
      commands: false,
      web: true,
      network: false
    });
    for (const platform of ['linux', 'win32'] as const)
      assert.deepEqual(
        on(odd('claude', true, true), platform),
        { commands: false, web: true, network: false },
        platform
      );
    assert.deepEqual(C.ownTools(odd('claude', false, false), 'darwin').granted, [
      { path: kept, write: true }
    ]);
  }
);

test('a handed-over run keeps its own commands, web and folders; a write grant waits for the yes', () => {
  const caps: Capabilities = {
    level: 'act',
    remit: '',
    office: [],
    actsOnHandOffs: false,
    outside: [
      {
        connector: { id: 'notion', name: 'Notion', readTools: ['search'] } as ConnectorRow,
        level: 'act',
        standing: [],
        askFirst: []
      }
    ],
    agent: 'claude',
    own: C.ownTools(odd('claude', true, true), 'darwin')
  };
  const run = C.capped(caps, 'draft');
  assert.deepEqual(run.own, caps.own);
  // At Draft a write grant still works, and each change waits for the owner's yes.
  assert.equal(run.outside[0].level, 'act');
  assert.equal(C.capped(caps, 'read').outside[0].level, 'read');
});

/** The line an Odd hears for each own tool it lacks, when it can ask for it. */
const SWITCH = {
  commands: 'No shell: ask {owner} to turn on Run commands with ask_for_switch.',
  web: 'No web: ask {owner} to turn on Browse the web with ask_for_switch.'
};
/** The line another Odd reads about one, naming the owner's control on that Odd's card. */
const switchLinesOf = (whose: string) => ({
  commands: `No shell: {owner} can switch on Run commands in ${whose} Settings tab, under Office.`,
  web: `No web: {owner} can switch on Browse the web in ${whose} Settings tab, under Office.`
});

test('each Odd is told its own tools, and how to get each one it lacks', () => {
  const shell = "a shell confined to your folders and {owner}'s developer tools (read only)";
  const told = (web: string) => ({
    neither: `Your own tools work on files only. ${SWITCH.commands} ${SWITCH.web}`,
    commands: `Your own tools work on files, plus ${shell}, with no network. ${SWITCH.web}`,
    web: `Your own tools work on files, plus ${web}. ${SWITCH.commands}`,
    online: `Your own tools work on files, plus ${shell}, which can reach the internet, and ${web}.`,
    offline: `Your own tools work on files, plus ${shell}, with no network, and ${web}.`
  });
  for (const agent of A.AGENTS) {
    // Gemini's policy allows a write only by its full path, so its Odds are told so.
    const end = agent === 'gemini' ? " Give each file tool the file's full path." : '';
    // Codex's web searches and fetches no page.
    const web = agent === 'codex' ? 'web search' : 'web search and fetch';
    // The words for each tool's lists, with a switch that follows the owner; the table below holds the rest.
    const line = (commands: boolean, web: boolean, network: boolean) =>
      C.ownToolsLine(agent, { commands, commandsHow: { state: 'switch' }, web, network });
    assert.deepEqual(
      {
        neither: line(false, false, false),
        commands: line(true, false, false),
        web: line(false, true, false),
        online: line(true, true, true),
        offline: line(true, true, false)
      },
      Object.fromEntries(Object.entries(told(web)).map(([k, v]) => [k, v + end])),
      agent
    );
  }
});

test('an Odd is told it can ask for a tool it lacks exactly when it can be had, and never told of a tool it lacks', () => {
  const shell = "a shell confined to your folders and {owner}'s developer tools (read only)";
  type Row = {
    agent: (typeof A.AGENTS)[number];
    platform: NodeJS.Platform;
    commands: boolean;
    web: boolean;
    held?: boolean;
    /** The Odd's name when another Odd reads its line, as in office_report. */
    about?: string;
    hears: string;
  };
  const rows: Row[] = [
    {
      agent: 'claude',
      platform: 'darwin',
      commands: false,
      web: false,
      hears: `Your own tools work on files only. ${SWITCH.commands} ${SWITCH.web}`
    },
    {
      agent: 'claude',
      platform: 'darwin',
      commands: true,
      web: false,
      hears: `Your own tools work on files, plus ${shell}, with no network. ${SWITCH.web}`
    },
    {
      agent: 'claude',
      platform: 'darwin',
      commands: false,
      web: true,
      hears: `Your own tools work on files, plus web search and fetch. ${SWITCH.commands}`
    },
    ...(['linux', 'win32'] as const).flatMap((platform) =>
      // Claude Code's commands are off here whatever is stored, so no switch is offered.
      [false, true].map((commands): Row => ({
        agent: 'claude',
        platform,
        commands,
        web: false,
        hears: `Your own tools work on files only. No shell: Claude Code can't run commands here. ${SWITCH.web}`
      }))
    ),
    // Codex follows the switch on a Mac and Linux, as Claude Code does on a Mac.
    ...(['darwin', 'linux'] as const).flatMap((platform): Row[] => [
      {
        agent: 'codex',
        platform,
        commands: false,
        web: false,
        hears: `Your own tools work on files only. ${SWITCH.commands} ${SWITCH.web}`
      },
      {
        agent: 'codex',
        platform,
        commands: true,
        web: false,
        hears: `Your own tools work on files, plus ${shell}, with no network. ${SWITCH.web}`
      },
      {
        agent: 'codex',
        platform,
        commands: false,
        web: true,
        hears: `Your own tools work on files, plus web search. ${SWITCH.commands}`
      }
    ]),
    // On Windows Codex's commands are off whatever is stored, so no switch is offered.
    ...[false, true].map((commands): Row => ({
      agent: 'codex',
      platform: 'win32',
      commands,
      web: false,
      hears: `Your own tools work on files only. No shell: Codex can't run commands here. ${SWITCH.web}`
    })),
    ...[false, true].map((commands): Row => ({
      agent: 'grok',
      platform: 'darwin',
      commands,
      web: false,
      hears: `Your own tools work on files only. No shell: Grok can't run commands here. ${SWITCH.web}`
    })),
    {
      agent: 'grok',
      platform: 'darwin',
      commands: false,
      web: true,
      hears:
        "Your own tools work on files, plus web search and fetch. No shell: Grok can't run commands here."
    },
    {
      agent: 'gemini',
      platform: 'darwin',
      commands: true,
      web: true,
      hears:
        "Your own tools work on files, plus web search and fetch. No shell: Gemini can't run commands here. Give each file tool the file's full path."
    },
    // Both on where the shell follows the switch: no switch line, as before.
    {
      agent: 'claude',
      platform: 'darwin',
      commands: true,
      web: true,
      hears: `Your own tools work on files, plus ${shell}, which can reach the internet, and web search and fetch.`
    },
    {
      agent: 'codex',
      platform: 'darwin',
      commands: true,
      web: true,
      hears: `Your own tools work on files, plus ${shell}, with no network, and web search.`
    },
    {
      agent: 'claude',
      platform: 'darwin',
      commands: true,
      web: true,
      held: true,
      hears: `Your own tools work on files, plus ${shell}, with no network, and web search and fetch. ${C.NETWORK_HELD_LINE}`
    },
    // Another Odd reads it: every sentence names whose tools, folders and card they are.
    {
      agent: 'claude',
      platform: 'darwin',
      commands: false,
      web: false,
      about: 'Rowan',
      hears:
        "Rowan's own tools work on files only. No shell: {owner} can switch on Run commands in Rowan's Settings tab, under Office. No web: {owner} can switch on Browse the web in Rowan's Settings tab, under Office."
    },
    {
      agent: 'claude',
      platform: 'darwin',
      commands: true,
      web: true,
      held: true,
      about: 'Rowan',
      hears:
        "Rowan's own tools work on files, plus a shell confined to Rowan's folders and {owner}'s developer tools (read only), with no network, and web search and fetch. This version of Claude Code refuses to let Rowan's commands reach the internet, so they have none."
    },
    // The full-path sentence is the Gemini Odd's own instruction, so a reader of its line is not given it.
    {
      agent: 'gemini',
      platform: 'darwin',
      commands: true,
      web: false,
      about: 'Rowan',
      hears:
        "Rowan's own tools work on files only. No shell: Gemini can't run commands here. No web: {owner} can switch on Browse the web in Rowan's Settings tab, under Office."
    }
  ];
  for (const r of rows) {
    const own = C.ownTools(odd(r.agent, r.commands, r.web), r.platform);
    const said = C.ownToolsSaid(r.agent, own, r.held ?? false, r.about).join(' ');
    const row = JSON.stringify({ ...r, hears: undefined });
    assert.equal(said, r.hears, row);
    // The Run commands switch line only where the owner's switch reaches the tool and it is off.
    const lines = r.about === undefined ? SWITCH : switchLinesOf(`${r.about}'s`);
    const switchable = A.commandsHow(r.agent, r.platform).state === 'switch' && !r.commands;
    assert.equal(said.includes(lines.commands), switchable, row);
    assert.equal(said.includes(lines.web), !r.web, row);
    // Read about another Odd, no row speaks to the reader as if the tools were its own.
    assert.doesNotMatch(
      C.ownToolsSaid(r.agent, own, r.held ?? false, 'Rowan').join(' '),
      /\byour\b/i,
      row
    );
  }
});

test("the Odd is told the card's own tab, section and switch names, and office_report names whose card it is", () => {
  const off = C.ownTools(odd('claude', false, false), 'darwin');
  const [line] = C.ownToolsSaid('claude', off, false);
  // The words come from the constants the Settings tab shows (AccessTab reads OFFICE_SECTION and SWITCH_NAMES).
  for (const name of Object.values(W.SWITCH_NAMES))
    assert.ok(line.includes(`turn on ${name} with ask_for_switch.`), line);
  assert.doesNotMatch(line, /Settings tab/);
  const [rowans] = C.ownToolsSaid('claude', off, false, 'Rowan');
  assert.ok(
    rowans.includes("can switch on Browse the web in Rowan's Settings tab, under Office."),
    rowans
  );
  assert.doesNotMatch(rowans, /your Settings tab/);
});

test("find_connectors and ask_for_access each say they are not for the Odd's own tools", async () => {
  const { tools } = await rae.listTools();
  for (const name of ['find_connectors', 'ask_for_access']) {
    const description = tools.find((t) => t.name === name)?.description ?? '';
    assert.ok(description.includes(W.NOT_OWN_TOOLS), `${name}: ${description}`);
  }
});

test('raise_ask sends an outside tool to ask_for_access, a folder to ask_for_folder and the two switches to my_access', async () => {
  const { tools } = await rae.listTools();
  const description = tools.find((t) => t.name === 'raise_ask')?.description ?? '';
  const { commands, web } = W.SWITCH_NAMES;
  assert.ok(
    description.includes('For an outside tool, use ask_for_access.') &&
      description.includes(
        `For a folder on this computer, use ask_for_folder; for ${commands} or ${web}, see my_access;`
      ),
    description
  );
});

test('the hire drawer names Run commands only where the owner can switch it, and always the Office section', () => {
  const both =
    "Optional. You can give tools and switch on Run commands or Browse the web on their Settings tab, under Office, later. They'll ask you when a job needs one.";
  const web =
    "Optional. You can give tools and switch on Browse the web on their Settings tab, under Office, later. They'll ask you when a job needs one.";
  const rows: [(typeof A.AGENTS)[number], NodeJS.Platform, string][] = [
    ['claude', 'darwin', both],
    ['codex', 'darwin', both],
    ['codex', 'linux', both],
    ['codex', 'win32', web],
    ['grok', 'darwin', web],
    ['grok', 'linux', web],
    ['grok', 'win32', web],
    ['claude', 'linux', web],
    ['claude', 'win32', web]
  ];
  for (const [agent, platform, line] of rows)
    assert.equal(
      A.hireToolsLine(A.commandsHow(agent, platform).state),
      line,
      `${agent} on ${platform}`
    );
  // Before the page has the tools, it does not know the switch is there.
  assert.equal(A.hireToolsLine(undefined), web);
});

test('the line under Browse the web says what its commands do with it', () => {
  const opens =
    'Search and read web pages. With Run commands on, its commands can reach the internet too.';
  assert.equal(A.webLine('claude', 'darwin', false), opens);
  assert.equal(
    A.webLine('claude', 'darwin', true),
    'Search and read web pages. This version of Claude Code keeps its commands off the internet.'
  );
  assert.equal(A.webLine('claude', 'linux', false), 'Search and read web pages.');
  assert.equal(A.webLine('grok', 'darwin', false), 'Search and read web pages.');
  assert.equal(A.webLine('gemini', 'darwin', false), 'Search and read web pages.');
  for (const platform of ['darwin', 'linux'] as const)
    assert.equal(
      A.webLine('codex', platform, false),
      "Search the web. Codex's commands stay off the internet.",
      platform
    );
  // Codex runs no commands on Windows, so there is nothing to say of them.
  assert.equal(A.webLine('codex', 'win32', false), 'Search the web.');
  // The line follows the table, either way.
  const measured = {
    codex: A.AGENT_PLATFORMS.codex.networkWithWeb,
    claude: A.AGENT_PLATFORMS.claude.networkWithWeb
  };
  A.AGENT_PLATFORMS.codex.networkWithWeb = ['darwin'];
  A.AGENT_PLATFORMS.claude.networkWithWeb = [];
  try {
    assert.equal(
      A.webLine('codex', 'darwin', false),
      'Search the web. With Run commands on, its commands can reach the internet too.'
    );
    assert.equal(
      A.webLine('claude', 'darwin', false),
      "Search and read web pages. Claude Code's commands stay off the internet."
    );
  } finally {
    A.AGENT_PLATFORMS.codex.networkWithWeb = measured.codex;
    A.AGENT_PLATFORMS.claude.networkWithWeb = measured.claude;
  }
});

test('the level words, order and parser come from one list', () => {
  assert.deepEqual(W.LEVELS, ['read', 'draft', 'act']);
  assert.equal(W.parseLevel('act'), 'act');
  assert.equal(W.parseLevel('nope'), undefined);
  assert.equal(W.parseLevel(undefined), undefined);
  assert.ok(W.levelAtMost('read', 'draft'));
  assert.ok(W.levelAtMost('act', 'act'));
  assert.ok(!W.levelAtMost('act', 'draft'));
  assert.deepEqual(W.LEVEL_LABEL, {
    read: 'Reads and reports',
    draft: 'Drafts for your yes',
    act: 'Acts on its own'
  });
  assert.deepEqual(W.LEVEL_NAME, { read: 'Read', draft: 'Draft', act: 'Act' });
  assert.deepEqual(W.GRANT_LABEL, { read: 'Read only', act: 'Read and write' });
  assert.deepEqual(W.FOLDER_LABEL, { read: 'Can read', write: 'Can read and change' });
  assert.deepEqual(W.FOLDER_SAID, { read: 'read only', write: 'read and change' });
});

test('a run hands off, and is told the threads it leads, by one rule', () => {
  for (const held of [true, false])
    for (const thread of [true, false])
      for (const handOff of [true, false])
        for (const lesson of [true, false]) {
          const tools = held ? ['hand_off'] : [];
          const tool = held && !handOff && !lesson;
          assert.deepEqual(
            C.handsOff(tools, { thread, handOff, lesson }),
            { tool, leads: tool && !thread },
            JSON.stringify({ held, thread, handOff, lesson })
          );
        }
});

test('a run off its threads hands off and names which thread it raises for, a run on one only hands off there, and a handed-over run hands nothing on', () => {
  assert.deepEqual(runs, {
    offThread: { handOff: true, work: true },
    onThread: { handOff: true, work: false },
    handedOver: { handOff: false, work: false }
  });
});

test("office_report says where a colleague's level is set on that Odd's card, and ask_for_access above the level tells the Odd to ask with ask_for_level", async () => {
  const r = await manager.callTool({ name: 'office_report', arguments: {} });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
  const report = JSON.parse(text) as { staff: { id: string; outsideTools?: string[] }[] };
  assert.deepEqual(report.staff.find((s) => s.id === 'rae')?.outsideTools, [
    "Notion (read and write): held back. It needs the Draft level or higher, and the current level is Read. It works again once the owner raises it. the owner sets Rae's level on Rae's Settings tab, under Model."
  ]);
  const asked = await rae.callTool({
    name: 'ask_for_access',
    arguments: { connector: 'notion', level: 'write', why: 'To file the notes.' }
  });
  assert.deepEqual(asked.content, [
    { type: 'text', text: C.askAboveLevel('read', 'write', 'the owner') }
  ]);
});

/** Each Odd's own tools line in the office_report `client` gets, by id. */
async function ownToolsReported(client: typeof manager): Promise<Record<string, unknown>> {
  const r = await client.callTool({ name: 'office_report', arguments: {} });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
  const report = JSON.parse(text) as { staff: { id: string; ownTools?: unknown }[] };
  return Object.fromEntries(report.staff.map((s) => [s.id, s.ownTools]));
}

test(
  "office_report applies the office's held network to each Claude Code Odd it lists, whoever asks, and leaves a Codex Odd as it is",
  // Claude Code's Run commands follows the switch on a Mac only, so only there can Bea's commands reach the internet.
  { skip: process.platform !== 'darwin' && 'Run commands runs on a Mac only' },
  async () => {
    const [open, held] = [await ownToolsReported(manager), await ownToolsReported(heldManager)];
    // Another Odd reads the report, so each line names whose tools and folders they are.
    const shell = "a shell confined to Bea's folders and the owner's developer tools (read only)";
    assert.equal(
      open.bea,
      `Bea's own tools work on files, plus ${shell}, which can reach the internet, and web search and fetch.`
    );
    assert.equal(
      held.bea,
      `Bea's own tools work on files, plus ${shell}, with no network, and web search and fetch. This version of Claude Code refuses to let Bea's commands reach the internet, so they have none.`
    );
    assert.equal(held.cody, open.cody);
    assert.equal(held.mona, open.mona);
  }
);

test(
  "office_report lists each Odd's tool, own tools and folders",
  { skip: TEMP_IN_APPDATA },
  async () => {
    const r = await manager.callTool({ name: 'office_report', arguments: {} });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
    const report = JSON.parse(text) as { staff: Record<string, unknown>[] };
    const mona = report.staff.find((s) => s.id === 'mona');
    assert.ok(mona, text);
    assert.deepEqual(
      [mona.runsOn, mona.ownTools, mona.folders],
      [
        'Claude Code',
        // Another Odd reads the report, so it names whose tools and card they are.
        process.platform === 'darwin'
          ? "Mona's own tools work on files, plus web search and fetch. No shell: the owner can switch on Run commands in Mona's Settings tab, under Office."
          : "Mona's own tools work on files, plus web search and fetch. No shell: Claude Code can't run commands here.",
        [`${kept} (read only)`]
      ]
    );
    const cody = report.staff.find((s) => s.id === 'cody');
    assert.ok(cody, text);
    // With no owner's name set, the office calls them "the owner". Codex has
    // no shell on Windows, so there its line names no one.
    assert.equal(
      cody.ownTools,
      process.platform === 'win32'
        ? "Cody's own tools work on files, plus web search. No shell: Codex can't run commands here."
        : "Cody's own tools work on files, plus a shell confined to Cody's folders and the owner's developer tools (read only), with no network, and web search."
    );
  }
);
