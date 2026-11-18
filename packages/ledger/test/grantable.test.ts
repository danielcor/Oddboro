// What the owner can grant (OWNER_GRANTS): each line an Odd hears when it
// lacks a grant, said through each function the list names, and the values a
// hire starts with (HIRE_DEFAULTS). hire() writes rows, so pglite.ts stands in
// for the database. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './pglite.ts';

const { getTableColumns } = await import('drizzle-orm');
const { LEVELS, officeSection } = await import('../src/access-words.ts');
// Through `say` only (below), so each call is noted: the bare names stay out of scope.
const C = await import('../src/capabilities.ts');
const { OWNER_ANSWERS } = await import('../src/desk-answers.ts');
const G = await import('../src/grantable.ts');
const { hire, officeAgent } = await import('../src/office.ts');
const { GRANTABLE_TOOLS, isGrantable } = await import('../src/tools.ts');
const { hireManager, MANAGERS } = await import('../src/managers.ts');
const { staff } = await import('../src/schema.ts');
type Capabilities = import('../src/capabilities.ts').Capabilities;
type GrantKind = import('../src/grantable.ts').GrantKind;
type Hearer = import('../src/grantable.ts').Hearer;

const where = officeSection('your');
/** A Claude Code Odd on a Mac with both switches off and no folder. */
const bare = {
  commands: false,
  commandsHow: { state: 'switch' },
  web: false,
  network: false
} as const;
/** A Draft Odd holding a write grant, which its level holds back. */
const heldBack: Capabilities = {
  level: 'draft',
  remit: '',
  office: [],
  actsOnHandOffs: false,
  agent: 'claude',
  own: { ...bare, granted: [] },
  outside: [
    {
      connector: { id: 'notion', name: 'Notion', readTools: ['search'] },
      level: 'act',
      heldBack: 'above its level',
      standing: [] as string[],
      askFirst: [] as string[]
    } as Capabilities['outside'][number]
  ]
};

/**
 * The functions in `Hearer` a ledger test can call. house() is the office's,
 * and its own test holds the line it says (house.test.ts). A new Hearer fails
 * the type check here until it is listed or named as the office's.
 */
const SAYERS = {
  accessInRun: C.accessInRun,
  askAboveLevel: C.askAboveLevel,
  outsideLines: C.outsideLines,
  ownToolsLine: C.ownToolsLine
} satisfies Record<Exclude<Hearer, 'house'>, unknown>;
type Say = typeof SAYERS;
/** `SAYERS`, each adding its own name to `called` as it is called. */
function noting(called: Set<Hearer>): Say {
  const note = <F extends (...a: never[]) => unknown>(name: keyof Say, f: F): F =>
    // The wrapper takes and returns exactly what `f` does, so it is an F.
    ((...a: Parameters<F>) => (called.add(name), f(...a))) as F;
  return {
    accessInRun: note('accessInRun', SAYERS.accessInRun),
    askAboveLevel: note('askAboveLevel', SAYERS.askAboveLevel),
    outsideLines: note('outsideLines', SAYERS.outsideLines),
    ownToolsLine: note('ownToolsLine', SAYERS.ownToolsLine)
  };
}

/**
 * For each grant, what an Odd lacking it hears through each function the
 * list names, called through `say` so the test sees which, and what one
 * holding it hears instead. Keyed by GrantKind, so a new grant fails the type
 * check here until it says how it is heard.
 */
const HEARD: Record<GrantKind, (say: Say) => void> = {
  commands: (say) => {
    const lacks = 'No shell: ask {owner} to turn on Run commands with ask_for_switch.';
    assert.equal(
      G.OWNER_GRANTS.commands.missing({ agent: 'claude', how: { state: 'switch' } }),
      lacks
    );
    // Another Odd reading the line cannot ask for this Odd: it is told the owner's control.
    assert.equal(
      G.OWNER_GRANTS.commands.missing({ agent: 'claude', how: { state: 'switch' }, where }),
      'No shell: {owner} can switch on Run commands in your Settings tab, under Office.'
    );
    assert.ok(say.ownToolsLine('claude', bare).includes(lacks));
    // A tool that never follows the switch is never offered it.
    const grok = { ...bare, commandsHow: { state: 'never', why: '' } } as const;
    const never = "No shell: Grok can't run commands here.";
    assert.equal(G.OWNER_GRANTS.commands.missing({ agent: 'grok', how: grok.commandsHow }), never);
    assert.ok(say.ownToolsLine('grok', grok).includes(never));
    assert.doesNotMatch(say.ownToolsLine('claude', { ...bare, commands: true }), /No shell/);
  },
  web: (say) => {
    const lacks = 'No web: ask {owner} to turn on Browse the web with ask_for_switch.';
    assert.equal(G.OWNER_GRANTS.web.missing({}), lacks);
    assert.equal(
      G.OWNER_GRANTS.web.missing({ where }),
      'No web: {owner} can switch on Browse the web in your Settings tab, under Office.'
    );
    assert.ok(say.ownToolsLine('claude', bare).includes(lacks));
    assert.doesNotMatch(say.ownToolsLine('claude', { ...bare, web: true }), /No web/);
  },
  folders: (say) => {
    const lacks = 'When a job needs a folder outside the office, ask with ask_for_folder.';
    assert.equal(G.OWNER_GRANTS.folders.missing(), lacks);
    assert.ok(
      say
        .accessInRun(heldBack, 'Sam', {})
        .split('\n')
        .includes(`Sam has given you no folders. ${lacks}`)
    );
    const given = {
      ...heldBack,
      own: { ...heldBack.own, granted: [{ path: '/tmp', write: false }] }
    };
    assert.ok(!say.accessInRun(given, 'Sam', {}).includes(lacks));
  },
  office_tools: (say) => {
    const lacks =
      'Sam grants other office tools in your Settings tab, under Office; when a job needs one, ask for it with ask_for_office_tool.';
    assert.equal(G.OWNER_GRANTS.office_tools.missing({ owner: 'Sam', where }), lacks);
    assert.ok(say.accessInRun(heldBack, 'Sam', {}).split('\n').includes(lacks));
    // One office tool still not given is enough to hear it.
    const lacksOne = { ...heldBack, office: GRANTABLE_TOOLS.slice(1) };
    assert.ok(say.accessInRun(lacksOne, 'Sam', {}).split('\n').includes(lacks));
    const holdsAll = { ...heldBack, office: [...GRANTABLE_TOOLS] };
    assert.ok(!say.accessInRun(holdsAll, 'Sam', {}).includes('grants other office tools'));
  },
  // house() is in the office, which a ledger test cannot import: its own
  // test holds this line (house.test.ts).
  outside_tools: () => {
    const has = (held: string[]) => (t: string) => held.includes(t);
    const said = (held: string[]) => G.OWNER_GRANTS.outside_tools.missing({ has: has(held) });
    assert.equal(
      said(['ask_for_access', 'find_connectors']),
      ' For more outside tools, call find_connectors, then ask_for_access.'
    );
    assert.equal(said(['ask_for_access']), ' For more outside tools, call ask_for_access.');
    assert.equal(said([]), '');
  },
  level: (say) => {
    // The Odd itself asks for its level; another Odd reading about it (office_report)
    // cannot ask for it, so it is told where the owner sets it.
    const yours = 'When a job needs a higher level, ask Sam for it with ask_for_level.';
    const rowans = "Sam sets Rowan's level on Rowan's Settings tab, under Model.";
    assert.equal(G.OWNER_GRANTS.level.missing({ owner: 'Sam' }), yours);
    assert.equal(G.OWNER_GRANTS.level.missing({ owner: 'Sam', whose: "Rowan's" }), rowans);
    assert.ok(say.outsideLines(heldBack, 'Sam')[0].endsWith(` ${yours}`));
    assert.ok(say.outsideLines(heldBack, 'Sam', 'Rowan')[0].endsWith(` ${rowans}`));
    assert.ok(say.askAboveLevel('draft', 'write', 'Sam').includes(` ${yours} `));
    // At its level the grant loads, and no route is said.
    const holds = { ...heldBack, level: 'act' as const };
    holds.outside = [{ ...heldBack.outside[0], heldBack: undefined }];
    assert.doesNotMatch(say.outsideLines(holds, 'Sam')[0], /ask_for_level/);
  }
};

test('an Odd lacking each grantable capability hears its line, word for word, through each function that says it, and one holding it does not; a capability with no line names its Linear row', () => {
  for (const kind of G.GRANT_KINDS) {
    const g = G.OWNER_GRANTS[kind];
    // A grant with a line is heard somewhere; one with none is heard nowhere.
    assert.equal(typeof g.missing === 'function', g.heard.length > 0, kind);
    const called = new Set<Hearer>();
    HEARD[kind](noting(called));
    assert.deepEqual(
      [...called].sort(),
      g.heard.filter((h) => h !== 'house').sort(),
      `${kind} is heard through exactly the functions its row names`
    );
  }
});

test('every staff PATCH key is the control of the grant it is classed as, a run setting, or a qualifier a control names', () => {
  const named = new Map<string, GrantKind>();
  for (const kind of G.GRANT_KINDS) {
    const c = G.OWNER_GRANTS[kind].control;
    if ('patch' in c) for (const key of c.patch) named.set(key, kind);
  }
  for (const key of G.STAFF_PATCH_KEYS) {
    const is = G.PATCH_KEY[key];
    if (is === 'run setting') assert.ok(!named.has(key), key);
    else if (is === 'qualifier') assert.ok(named.has(key), key);
    else assert.equal(named.get(key), is, key);
  }
});

test('a grant the owner gives through an ask says what approving it does, from the desk answers', () => {
  for (const kind of G.GRANT_KINDS) {
    const g = G.OWNER_GRANTS[kind];
    const { route } = g;
    assert.equal('ask' in route, 'approving' in g, kind);
    if (!('ask' in route)) continue;
    // What the grant says approving does is the desk's own cell for that ask.
    const approve = OWNER_ANSWERS.ask[route.ask].approve;
    assert.equal(g.approving, 'then' in approve ? approve.then : approve, kind);
  }
  // A grant an Odd can ask for says how.
  assert.deepEqual(G.OWNER_GRANTS.commands.route, { ask: 'switch' });
  assert.deepEqual(G.OWNER_GRANTS.web.route, { ask: 'switch' });
  assert.deepEqual(G.OWNER_GRANTS.folders.route, { ask: 'folder' });
  assert.deepEqual(G.OWNER_GRANTS.level.route, { ask: 'level' });
  assert.deepEqual(G.OWNER_GRANTS.office_tools.route, { ask: 'office_tool' });
});

test('a hire with nothing picked starts from every one of HIRE_DEFAULTS, and a manager from its own: Draft, with exactly its tools', async () => {
  // Every default, so one that the schema or hire() does not read fails here.
  // The cast holds: HIRE_DEFAULTS.staff is an object literal with only its typed keys.
  const defaults = Object.keys(G.HIRE_DEFAULTS.staff) as (keyof typeof G.HIRE_DEFAULTS.staff)[];
  const columns = getTableColumns(staff);
  for (const key of defaults)
    assert.deepEqual(columns[key].default, G.HIRE_DEFAULTS.staff[key], `${key}'s column default`);

  const row = await hire({
    name: 'Quinn',
    role: 'Tester',
    variant: 'a',
    portrait: 'a',
    room: 'workspace',
    remit: 'Tests.',
    desk: 'You are Quinn.'
  });
  for (const key of defaults)
    assert.deepEqual(row[key], G.HIRE_DEFAULTS.staff[key], `${key} on the hired row`);
  assert.deepEqual(
    { agent: row.agent, account: row.account, model: row.model, effort: row.effort },
    { agent: officeAgent(), account: null, model: null, effort: null }
  );
  // Each grant the list says a hire starts with, the hired Odd holds, and no other.
  const holds: Record<GrantKind, boolean> = {
    commands: row.commands,
    web: row.web,
    folders: row.folders.length > 0,
    office_tools: row.tools.some(isGrantable),
    outside_tools: (await C.capabilities(row)).outside.length > 0,
    level: LEVELS.includes(row.permission)
  };
  for (const kind of G.GRANT_KINDS)
    assert.equal(G.OWNER_GRANTS[kind].atHire, holds[kind], `${kind} at hire`);

  const manager = await hireManager({ preset: MANAGERS[0].id });
  const hired = { permission: manager.permission, tools: manager.tools };
  assert.deepEqual(hired, G.HIRE_DEFAULTS.manager);
  // Word for word, not from HIRE_DEFAULTS: a manager at Act would act
  // without the owner's yes (hard rule 4), so its level and tools change
  // here on purpose or not at all.
  assert.deepEqual(hired, {
    permission: 'draft',
    tools: [
      'see_office',
      'search_ledger',
      'give_owner_a_task',
      'find_connectors',
      'ask_for_access',
      'edit_my_job',
      'edit_my_description',
      'hand_off',
      'poke_owner',
      'office_report',
      'propose_hire',
      'list_goals',
      'propose_goal',
      'propose_goal_plan',
      'update_goal',
      'remove_odd',
      'bring_back_odd'
    ]
  });
});
