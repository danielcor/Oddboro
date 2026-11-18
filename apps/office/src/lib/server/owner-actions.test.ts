// Every owner route that changes something is declared in OWNER_ACTIONS, each
// that says it records writes exactly one ledger row of its kind, and each
// that says it may record writes only the kinds it lists, in every state its
// driver tries, and some in at least one. A row that writes none is driven too
// (CHANGES, QUIET), or UNDRIVEN says why it cannot be, so no row goes unchecked
// by default.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { PATCH_KEY, STAFF_PATCH_KEYS } from '@oddboro/ledger/grantable';
import { FLOORS, GROUNDS, WALLS, type OfficeSpec } from '@oddboro/world';
import type { Step } from '@oddboro/ledger';
import { OFFICE_TOOLS } from '@oddboro/ledger/tools';
import {
  L,
  currentOffice,
  folder,
  goal,
  odd,
  onPlatform,
  ownerHome,
  request,
  secrets,
  type Call
} from './office-under-test.ts';
import { fakeNewAltitude, PAT } from './fake-new-altitude.ts';
import { OWNER_ACTIONS, TASK_OPS, type OwnerAction, type Recording } from './owner-actions.ts';

const ROUTES = fileURLToPath(new URL('../../routes', import.meta.url));
const ACTIONS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const STAFF = '/api/staff/[id]';
const TASK = '/api/tasks/[id]';

/** Each route under src/routes with this file (`+server.ts` or `+page.server.ts`), by its route id. */
function routeIds(file: string, dir = ROUTES): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeIds(file, path);
    return name === file ? [`/${relative(ROUTES, dir).split('\\').join('/')}`] : [];
  });
}

/**
 * Every action the owner's page can take, as OWNER_ACTIONS keys them. A GET
 * only reads, unless OWNER_ACTIONS declares it: a page's `load` or a GET
 * handler that changes something is declared by hand, and counts here only
 * while that handler exists.
 */
async function handlers(): Promise<string[]> {
  const declaredGet = (route: string) => `GET ${route}` in OWNER_ACTIONS;
  const exports = async (route: string, file: string) =>
    (await import(join(ROUTES, route, file))) as Record<string, unknown>;
  const keys: string[] = [];
  for (const route of routeIds('+page.server.ts').filter(declaredGet))
    if ('load' in (await exports(route, '+page.server.ts'))) keys.push(`GET ${route}`);
  for (const route of routeIds('+server.ts')) {
    const module = await exports(route, '+server.ts');
    if ('GET' in module && declaredGet(route)) keys.push(`GET ${route}`);
    for (const method of ACTIONS.filter((m) => m in module)) {
      if (method === 'PATCH' && route === STAFF)
        keys.push(
          ...STAFF_PATCH_KEYS.filter((k) => PATCH_KEY[k] !== 'qualifier').map(
            (k) => `PATCH ${STAFF}#${k}`
          )
        );
      else if (method === 'POST' && route === TASK)
        keys.push(...TASK_OPS.map((op) => `POST ${TASK}#${op}`));
      else keys.push(`${method} ${route}`);
    }
  }
  return keys.sort();
}

const managers = L.MANAGERS.filter((m) => m.look);
/** A ready-made manager's look, each used once, so no look is refused as taken. */
function look() {
  const m = managers.shift();
  assert.ok(m?.look, 'no ready-made look is left');
  return { look: m.look, portraitPx: L.managerPortrait(m.id), id: m.id };
}

const spec: OfficeSpec = {
  name: 'Test office',
  wall: WALLS[0],
  floor: FLOORS[0],
  grounds: GROUNDS[0],
  rooms: [
    { kind: 'lobby', name: 'Lobby' },
    { kind: 'office', name: 'Owner' },
    { kind: 'workspace', name: 'Desks', seats: 4 },
    { kind: 'kitchen', name: 'Kitchen' }
  ]
};

const askOf = async (title: string) =>
  (await L.raiseAsk('lead', { title, why: 'w', ifApproved: 'i' })).ask.id;
const accountOf = async (label: string) => (await L.addAccount('claude', label)).id;
/** An outside tool, by its address, at read. */
const tool = (address: string) => ({
  connector: address,
  level: 'read',
  way: { keyHeader: 'x-api-key' }
});
/** `staff` given the tool at `address`, so the office has its connector. */
const grant = (staff: string, address: string) =>
  request('/api/staff/[id]/access', 'POST', { params: { id: staff }, body: tool(address) });
const fileOf = (name: string) => {
  const path = join(L.home(), 'staff', 'sam', name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'Before.\n');
  return { staff: 'sam', path: name, content: 'After.\n', mtime: statSync(path).mtimeMs };
};

/**
 * Work Lead handed on and then parked until task `taskId` ends, as resume_at's
 * `after_task` leaves it: its thread. A task's end wakes such work, so a route
 * that ends a task is driven with one, or a row the wake writes goes unseen.
 */
async function parkedOn(taskId: number, title: string): Promise<number> {
  const h = await L.handOff({
    from: 'lead',
    to: 'paige',
    work: { title, brief: 'Do it.' },
    thread: { title }
  });
  assert.ok('id' in h, JSON.stringify(h));
  await L.pg`update threads set resume_on_task = ${taskId} where id = ${h.thread}`;
  return h.thread;
}
/** Whether the work parked on `thread` woke: no longer parked, and its lead's pick-up waiting. */
async function woke(thread: number): Promise<boolean> {
  const [t] = await L.pg<{ parked: number | null; resumes: number }[]>`
    select resume_on_task as parked,
      (select count(*)::int from follow_ups where kind = 'resume' and thread_id = ${thread}) as resumes
    from threads where id = ${thread}`;
  return t.parked === null && t.resumes > 0;
}

/**
 * Gmail signed in for Paige, and `send` with Gmail answering as a stand-in, so
 * a reply or a filter the owner sends reaches its ledger row.
 */
async function withGmail(send: () => Promise<void>): Promise<void> {
  process.env.ODDBORO_GOOGLE_CLIENT_SECRET = 'a-client-secret-for-tests';
  secrets.set(
    'gmail:oauth',
    JSON.stringify({
      tokens: { access_token: 'ya29.test', refresh_token: '1//test', expires_in: 3600 },
      savedAt: Date.now()
    })
  );
  await L.connectorReady('gmail', ['get_thread'], ['get_thread']);
  await L.pg`insert into grants ${L.pg({ staff_id: 'paige', connector_id: 'gmail', level: 'read' })}
    on conflict do nothing`;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://gmail.googleapis.com/')) return real(input, init);
    return Response.json({ id: 'g-1', labels: [], messages: [], message: { id: 'g-1' } });
  }) as typeof fetch;
  try {
    await send();
  } finally {
    globalThis.fetch = real;
  }
}
const asked = (fields: Omit<Parameters<typeof L.raiseAsk>[1], 'title' | 'why' | 'ifApproved'>) =>
  L.raiseAsk('paige', { title: 'Asked', why: 'w', ifApproved: 'i', ...fields }).then(
    (r) => r.ask.id
  );

/**
 * The route's answer to the page's call: its handler, or for a GET of a page,
 * such as the sign-in callback New Altitude sends the browser back to, its
 * `load`, which reads only the URL.
 */
async function reach(route: string, method: string, call: Call = {}): Promise<unknown> {
  if (method !== 'GET' || !routeIds('+page.server.ts').includes(route))
    return request(route, method, call);
  const page = (await import(join(ROUTES, route, '+page.server.ts'))) as {
    load: (event: { url: URL }) => Promise<unknown>;
  };
  const url = new URL(`http://office${route}`);
  url.search = new URLSearchParams(call.query ?? {}).toString();
  return page.load({ url });
}

// New Altitude on this computer, for the persona routes. It lists three
// made-up personas, so each route that adds one has one the office lacks.
const newAltitude = await fakeNewAltitude();
process.env.ODDBORO_ACCOUNT_SITE = `${newAltitude.origin}/`;
after(() => newAltitude.close());
/** `pat` under another name: its slug, name, part and sprites renamed alike, so its look is its own. */
const personaAs = (slug: string, name: string) =>
  JSON.parse(JSON.stringify(PAT).replaceAll('pat', slug).replaceAll('Pat', name)) as typeof PAT;
newAltitude.odds = [PAT, personaAs('quin', 'Quin'), personaAs('rio', 'Rio')];

/** New Altitude's page at `url` saying yes: the query it sends the browser back to the callback with. */
async function yesAt(url: string): Promise<Record<string, string>> {
  const res = await fetch(url, { redirect: 'manual' });
  return Object.fromEntries(new URL(res.headers.get('location') ?? '').searchParams);
}
/** The callback's page for `query`, by its title. */
const callback = async (query: Record<string, string>) =>
  ((await reach('/account/callback', 'GET', { query })) as { title: string }).title;
/** The owner's Sign in to New Altitude, through to the callback. */
async function signInToNewAltitude(): Promise<void> {
  const res = await request('/api/account', 'POST');
  assert.equal(
    await callback(await yesAt(((await res.json()) as { url: string }).url)),
    'Signed in'
  );
}
/** Add on persona `slug`, with no sign-in kept: the callback's query once New Altitude says yes. */
async function addPersona(slug: string): Promise<Record<string, string>> {
  const res = await request('/api/personas/[slug]', 'POST', { params: { slug } });
  return yesAt(((await res.json()) as { url: string }).url);
}

/** What sends the page's call to the route under test, counting the ledger either side. */
type Send = (call: Call) => Promise<void>;
/** For each action that records: any rows it needs, then the call that makes it act. */
const TRY: Record<Recording, (send: Send) => Promise<void>> = {
  'POST /api/accounts': (send) => send({ body: { agent: 'claude', label: 'Work' } }),
  'PATCH /api/accounts': async (send) =>
    send({ body: { id: await accountOf('Old'), label: 'New' } }),
  'DELETE /api/accounts': async (send) => send({ body: { id: await accountOf('Gone') } }),
  // A no, then each yes that writes more than its decision: setting a goal,
  // taking a plan, a tool already connected, and letting go an Odd with a task
  // open (its own Odd, so no later row loses one it uses).
  'POST /api/asks/[id]': async (send) => {
    const answer = async (id: number, decision: string, picks?: number[]) =>
      send({ params: { id: String(id) }, body: { decision, picks } });
    await answer(await askOf('Book the hall'), 'deny');
    await answer(
      await asked({
        kind: 'goal',
        goal: { title: 'Plant the beds', horizon: 'week', area: 'Home' }
      }),
      'approve'
    );
    const plan = {
      goalId: await goal('Water the beds'),
      items: [{ kind: 'assign' as const, staff: 'cleo', part: 'The hose.' }]
    };
    await answer(await asked({ kind: 'plan', plan }), 'approve', [0]);
    await grant('lead', 'https://ready.example.net/mcp');
    const [ready] = await L.pg<{ id: string }[]>`
      update connectors set ready_at = now() where id like 'ready-example-net%' returning id`;
    await answer(await asked({ access: { connector: ready.id, level: 'read' } }), 'approve');
    await L.pg`insert into staff ${L.pg(odd('uma', 'Uma'))}`;
    await L.giveTask('uma', { title: 'Sign it', why: 'w', steps: ['Sign'] });
    await answer(await asked({ kind: 'remove', odd: 'uma' }), 'approve');
  },
  'POST /api/asks/[id]/reply': async (send) => {
    const id = await asked({
      kind: 'reply',
      reply: {
        to: ['nate@example.com'],
        cc: [],
        subject: 'Re: Lunch',
        body: 'Yes.',
        summary: 'Nate asks about lunch.'
      }
    });
    await withGmail(() =>
      send({
        params: { id: String(id) },
        body: {
          action: 'draft',
          to: ['nate@example.com'],
          cc: [],
          subject: 'Re: Lunch',
          body: 'Yes.'
        }
      })
    );
  },
  'POST /api/asks/[id]/call': async (send) => {
    const id = await asked({
      kind: 'call',
      call: { connector: 'gmail', tool: 'get_thread', arguments: { thread_id: 't-1' } }
    });
    await withGmail(() => send({ params: { id: String(id) } }));
  },
  'POST /api/asks/[id]/filter': async (send) => {
    const criteria = { from: 'news@shop.example.com' };
    const action = { skipInbox: true };
    const id = await asked({
      kind: 'filter',
      filter: { criteria, action, summary: 'A newsletter every day.' }
    });
    await withGmail(() =>
      send({ params: { id: String(id) }, body: { criteria, action, tidy: false } })
    );
  },
  'POST /api/asks/[id]/folder': (send) =>
    ownerHome(async (home) => {
      const path = join(home, 'asked-for');
      mkdirSync(path);
      const id = await asked({ kind: 'folder', folder: { path, level: 'read' } });
      await send({ params: { id: String(id) }, body: { path, level: 'read' } });
    }),
  'PUT /api/files': (send) => send({ body: fileOf('plan.md') }),
  // After the welcome, which keeps the owner's row: the right answers, the first time.
  'POST /api/act-check': async (send) => {
    await L.setOwnerName(await L.ownerName());
    await send({ body: { answers: [true, true, false] } });
  },
  // After the welcome, which keeps the owner's row; the name stays as it was.
  'PUT /api/setup/advanced': async (send) => {
    await L.setOwnerName(await L.ownerName());
    await send({ body: { on: true } });
    await send({ body: { on: false } });
  },
  'POST /api/goals': (send) => send({ body: { title: 'Grow the garden' } }),
  'PUT /api/goals/[id]': async (send) =>
    send({ params: { id: String(await goal('Paint the fence')) }, body: { status: 'paused' } }),
  'POST /api/goals/[id]/staff': async (send) =>
    send({
      params: { id: String(await goal('Mend the roof')) },
      body: { staff: 'paige', part: 'The tiles.' }
    }),
  'DELETE /api/goals/[id]/staff': async (send) => {
    const id = await goal('Sweep the yard');
    await L.serveGoal('cleo', id, 'The leaves.');
    await send({ params: { id: String(id) }, query: { staff: 'cleo' } });
  },
  'PATCH /api/lessons/[id]': async (send) => {
    const [row] = await L.pg<{ id: number }[]>`
      insert into lessons (staff_id, heard_by, text, quote, how, status)
      values ('sam', 'sam', 'Write short.', 'Write short.', 'said', 'live') returning id`;
    await send({ params: { id: String(row.id) }, body: { text: 'Write shorter.' } });
  },
  'POST /api/office/move-in': (send) => send({ body: { spec, description: 'A test office.' } }),
  'PUT /api/office/design': (send) => {
    // A finished drawing, where the design job keeps it: on the office's global.
    (globalThis as { designJob?: unknown }).designJob = {
      id: 1,
      description: 'A drawn office.',
      lines: [],
      finished: true,
      moveIn: false,
      moved: false,
      result: { spec: { ...spec, name: 'Drawn office' }, art: [] },
      feed: { emit: () => true }
    };
    return send({ body: { moveIn: true } });
  },
  // After a move-in, so there is a sample to go back to.
  'POST /api/office/layouts/[id]': (send) => send({ params: { id: 'sample' } }),
  // Pat's sign-in finished before the welcome, so the welcome adds Pat after
  // the manager: two hire rows.
  'POST /api/onboarding': async (send) => {
    await signInToNewAltitude();
    assert.equal(await callback(await addPersona('pat')), 'Connected');
    await send({ body: { name: 'Tess', zone: 'UTC', manager: { preset: look().id } } });
  },
  // The rows below need the office open, so they come after the welcome.
  // Rio's sign-in finishing in the open office adds Rio. The same page
  // opened again finishes nothing, so it writes nothing.
  'GET /account/callback': async (send) => {
    const query = await addPersona('rio');
    await send({ query });
    await send({ query });
  },
  // Quin's sign-in kept from before the welcome, as after a restart: Add finds
  // it still holds and adds Quin at once.
  'POST /api/personas/[slug]': async (send) => {
    const [{ at }] = await L.pg<{ at: Date }[]>`select welcomed_at as at from owner`;
    await L.pg`update owner set welcomed_at = null`;
    assert.equal(await callback(await addPersona('quin')), 'Connected');
    await L.pg`update owner set welcomed_at = ${at}`;
    await send({ params: { slug: 'quin' } });
    // Quin is here now, so Add again only finds the sign-in still holds.
    await send({ params: { slug: 'quin' } });
  },
  // The list as the office has it changes nothing; then Pat on a newer
  // package, which the sync brings Pat's Odd up to.
  'GET /api/personas': async (send) => {
    await send({});
    newAltitude.odds[0] = { ...PAT, odd: { ...(PAT.odd as object), version: 2 } };
    await send({});
  },
  'PUT /api/rooms': async (send) =>
    send({ body: { room: (await currentOffice()).world.rooms[0].id, name: 'The den' } }),
  'POST /api/staff': async (send) => {
    const l = look();
    await send({
      body: {
        name: 'Hal',
        role: 'Tester',
        remit: 'Tests.',
        desk: 'You are Hal.',
        room: (await currentOffice()).world.rooms[0].id.split('#')[0],
        permission: 'read',
        look: l.look,
        portraitPx: l.portraitPx
      }
    });
  },
  // Odds of their own, so no later row loses an Odd it uses: one with nothing
  // open, whose leaving writes its hire row alone, then one with an ask and a
  // task open, which close with their own rows.
  'DELETE /api/staff/[id]': async (send) => {
    await L.pg`insert into staff ${L.pg([odd('tess', 'Tess'), odd('vic', 'Vic')])}`;
    await send({ params: { id: 'tess' } });
    await L.raiseAsk('vic', { title: 'Open', why: 'w', ifApproved: 'i' });
    await L.giveTask('vic', { title: 'Sign it', why: 'w', steps: ['Sign'] });
    await send({ params: { id: 'vic' } });
  },
  'PATCH /api/staff/[id]#permission': (send) =>
    send({ params: { id: 'sam' }, body: { permission: 'draft' } }),
  'PATCH /api/staff/[id]#agent': (send) =>
    send({ params: { id: 'gus' }, body: { agent: 'claude' } }),
  // The opposite of what Sam holds, since a repeat changes nothing.
  'PATCH /api/staff/[id]#tool': async (send) => {
    const tool = OFFICE_TOOLS.find((t) => !t.always)!.id;
    const on = !(await L.staffer('sam'))!.tools.includes(tool);
    await send({ params: { id: 'sam' }, body: { tool, on } });
  },
  // Claude Code follows Run commands on a Mac only (`commandsHow`), so this
  // row fakes one to reach the switch on any computer.
  'PATCH /api/staff/[id]#commands': (send) =>
    onPlatform('darwin', () => send({ params: { id: 'paige' }, body: { commands: true } })),
  'PATCH /api/staff/[id]#web': (send) => send({ params: { id: 'sam' }, body: { web: true } }),
  'PATCH /api/staff/[id]#folder': (send) =>
    ownerHome(async (home) => {
      mkdirSync(join(home, 'given'));
      await send({ params: { id: 'sam' }, body: { folder: join(home, 'given'), access: 'read' } });
    }),
  'PATCH /api/staff/[id]#effort': (send) =>
    send({ params: { id: 'sam' }, body: { effort: 'high' } }),
  'PATCH /api/staff/[id]#model': (send) =>
    send({ params: { id: 'sam' }, body: { model: L.MODELS.claude[0].id } }),
  'PATCH /api/staff/[id]#account': async (send) =>
    send({ params: { id: 'cleo' }, body: { account: await accountOf('Shared') } }),
  // An Odd of its own at Act, since only one at Act shows the choice.
  'PATCH /api/staff/[id]#actsOnHandOffs': async (send) => {
    await L.pg`insert into staff ${L.pg({ ...odd('ada', 'Ada'), permission: 'act' })}`;
    await send({ params: { id: 'ada' }, body: { actsOnHandOffs: true } });
  },
  // A tool already connected: one not yet connected puts its connect steps on
  // the desk instead, and the owner finishing them is the row (POST /api/tasks/[id]#finish).
  'POST /api/staff/[id]/access': async (send) => {
    await grant('lead', 'https://example.com/mcp');
    await L.pg`update connectors set ready_at = now()`;
    await send({ params: { id: 'sam' }, body: tool('https://example.com/mcp') });
  },
  // Down to Read only, which every level allows, since a repeat changes nothing.
  'PATCH /api/staff/[id]/access': async (send) => {
    await L.pg`insert into grants ${L.pg({ staff_id: 'sam', connector_id: 'google-drive', level: 'act' })}`;
    await send({ params: { id: 'sam' }, body: { connector: 'google-drive', level: 'read' } });
  },
  'DELETE /api/staff/[id]/access': async (send) => {
    await grant('paige', 'https://example.org/mcp');
    const [c] = await L.pg<
      { id: string }[]
    >`select id from connectors where id like 'example-org%'`;
    await send({ params: { id: 'paige' }, query: { connector: c.id } });
    // A tool still connecting, with work parked on its connect task: revoking
    // drops that task, which wakes the work.
    await grant('lead', 'https://parked.example.org/mcp');
    const [p] = await L.pg<{ id: string }[]>`
      select id from connectors where id like 'parked-example-org%'`;
    const [k] = await L.pg<{ id: number }[]>`
      select id from tasks where staff_id = 'lead' and status = 'open' order by id desc limit 1`;
    const thread = await parkedOn(k.id, 'Read the board after it connects');
    await send({ params: { id: 'lead' }, query: { connector: p.id } });
    assert.ok(await woke(thread), 'the work parked on the connect task did not wake');
  },
  'PUT /api/staff/[id]/skills': (send) =>
    send({
      params: { id: 'sam' },
      body: {
        name: 'invoices',
        was: null,
        skill: { description: 'Use for invoices.', text: 'Review the invoice total.' }
      }
    }),
  'PUT /api/staff/[id]/description': async (send) =>
    send({
      params: { id: 'sam' },
      body: { text: 'You are Sam, who tests.', was: (await L.staffer('sam'))!.desk }
    }),
  'PUT /api/staff/[id]/look': (send) => {
    const l = look();
    return send({ params: { id: 'sam' }, body: { look: l.look, portraitPx: l.portraitPx } });
  },
  'PATCH /api/services/[id]': async (send) => {
    await grant('paige', 'https://renamed.example.org/mcp');
    const [c] = await L.pg<
      { id: string }[]
    >`select id from connectors where id like 'renamed-example-org%'`;
    await send({ params: { id: c.id }, body: { name: 'Open Brain' } });
  },
  // A service that dropped a tool and added one since the office last read it.
  'POST /api/services/[id]/tools': async (send) => {
    const sdk = (path: string) =>
      createRequire(import.meta.url).resolve(`@modelcontextprotocol/sdk/${path}`);
    const server = join(folder, 'refresh-server.mjs');
    writeFileSync(
      server,
      `import { McpServer } from ${JSON.stringify(sdk('server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(sdk('server/stdio.js'))};
const server = new McpServer({ name: 'refresh', version: '1.0.0' });
server.registerTool('find', { annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
await server.connect(new StdioServerTransport());
`
    );
    await L.addConnector({
      id: 'refreshed',
      name: 'Refreshed',
      description: 'A stand-in.',
      kind: 'stdio',
      config: { command: process.execPath, args: [server] }
    });
    await L.connectorReady('refreshed', ['search'], ['search']);
    await send({ params: { id: 'refreshed' } });
  },
  // Then a task with work parked on it, finished and then dropped: the work
  // wakes, and the task's end is still the one row.
  'POST /api/tasks/[id]#finish': async (send) => {
    const t = await L.giveTask('lead', { title: 'Sign the form', why: 'w', steps: ['Sign it'] });
    await send({ params: { id: String(t.id) }, body: { op: 'finish', note: 'Done.' } });
    for (const done of [true, false]) {
      const title = done ? 'Sign the lease' : 'Sign the deed';
      const k = await L.giveTask('lead', { title, why: 'w', steps: ['Sign it'] });
      const thread = await parkedOn(k.id, `Move in after ${title}`);
      await send({ params: { id: String(k.id) }, body: { op: 'finish', done, note: 'Done.' } });
      assert.ok(await woke(thread), `the work parked on "${title}" did not wake`);
    }
  }
};

/** The ledger's rows of each kind, counted. */
async function ledgerCounts(): Promise<Map<string, number>> {
  const rows = await L.pg<{ kind: string; n: number }[]>`
    select kind, count(*)::int as n from ledger group by kind`;
  return new Map(rows.map((r) => [r.kind, r.n]));
}

test('every owner route is declared, each that records writes exactly one ledger row of its kind, and each that may record writes only the kinds it lists, and some in a state that writes', async (t) => {
  assert.deepEqual(await handlers(), Object.keys(OWNER_ACTIONS).sort());
  for (const key of Object.keys(TRY) as Recording[]) {
    await t.test(key, async () => {
      const [method, at] = key.split(' ');
      // What each call wrote, by ledger kind, in the order the driver sent them.
      const wrote: Record<string, number>[] = [];
      await TRY[key](async (call) => {
        const before = await ledgerCounts();
        await reach(at.split('#')[0], method, call);
        const after = await ledgerCounts();
        wrote.push(
          Object.fromEntries(
            [...after]
              .filter(([k, n]) => n !== (before.get(k) ?? 0))
              .map(([k, n]) => [k, n - (before.get(k) ?? 0)])
          )
        );
      });
      assert.notEqual(wrote.length, 0, `${key}'s driver never called the route`);
      // Read as any declaration, so a row declared `none` that writes fails
      // here rather than only at the type check.
      const declared: OwnerAction = OWNER_ACTIONS[key];
      if ('records' in declared)
        for (const rows of wrote)
          assert.deepEqual(rows, { [declared.records]: 1 }, `${key} wrote these rows`);
      else if ('mayRecord' in declared) {
        const listed: readonly string[] = declared.mayRecord;
        for (const rows of wrote)
          assert.deepEqual(
            Object.keys(rows).filter((kind) => !listed.includes(kind)),
            [],
            `${key} wrote ${JSON.stringify(rows)}, which holds a kind it does not list`
          );
        assert.ok(
          wrote.some((rows) => Object.keys(rows).length > 0),
          `${key} wrote no ledger row in any state its driver tried`
        );
      } else assert.fail(`${key} wrote ${JSON.stringify(wrote)}, yet declares no ledger row`);
    });
  }
});

/** Each table's rows, as one digest per table, so a change to any row shows. */
async function tableDigests(): Promise<Map<string, string>> {
  const tables = await L.pg<{ name: string }[]>`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'`;
  const digests = await Promise.all(
    tables.map(async ({ name }) => {
      const [{ d }] = await L.pg<{ d: string | null }[]>`
        select md5(string_agg(t::text, ',' order by t::text)) as d from ${L.pg(name)} t`;
      return [name, d ?? ''] as const;
    })
  );
  return new Map(digests);
}

/** A task with one step, by its id as the route takes it. */
const taskOf = async (title: string, step: string | Step) =>
  String((await L.giveTask('lead', { title, why: 'w', steps: [step] })).id);

type Key = keyof typeof OWNER_ACTIONS;

/** A waiting poke for Sam, by its id as the route takes it. */
const pokeOf = async (message: string) =>
  String((await L.schedulePoke('sam', new Date(Date.now() + 3_600_000), message)).id);
/** A daily job for Sam, by its id. */
const jobOf = async (name: string) =>
  (
    await L.addJob({
      staffId: 'sam',
      name,
      instructions: 'Check the post.',
      schedule: { every: 'day', at: '09:00' }
    })
  ).id;

/**
 * Actions that write no ledger row but change a row of the office's: any
 * rows each needs, then its call.
 */
const CHANGES: Partial<Record<Key, (send: Send) => Promise<void>>> = {
  'POST /api/staff/[id]/pokes': async (send) => {
    await L.pg`insert into pokes (staff_id, at, message, status)
      values ('sam', now(), 'How did the call go?', 'sent')`;
    await send({ params: { id: 'sam' } });
  },
  'PUT /api/update': (send) => send({ body: { start: '01:00', end: '03:00' } }),
  'POST /api/setup': async (send) => send({ body: { name: await L.ownerName() } }),
  'POST /api/tasks/[id]#tick': async (send) =>
    send({
      params: { id: await taskOf('Tick a step', 'Tick it') },
      body: { op: 'tick', index: 0 }
    }),
  'POST /api/tasks/[id]#untick': async (send) => {
    const id = await taskOf('Untick a step', 'Untick it');
    await L.tickStep(Number(id), 0);
    await send({ params: { id }, body: { op: 'untick', index: 0 } });
  },
  'POST /api/tasks/[id]#choose': async (send) => {
    const action = { kind: 'choice' as const, options: ['Red', 'Blue'] };
    const id = await taskOf('Pick a colour', { text: 'Pick one', done: false, action });
    await send({ params: { id }, body: { op: 'choose', index: 0, answer: 'Blue' } });
  },
  // A persona Odd of its own, so signing out has one to make quiet.
  'DELETE /api/account': async (send) => {
    const persona = { slug: 'sol', version: 1, disclosure: 'Sol is made up.' };
    await L.pg`insert into staff ${L.pg(odd('sol', 'Sol'))}`;
    await L.pg`update staff set package = ${JSON.stringify(persona)}::jsonb where id = 'sol'`;
    await send({});
  },
  'DELETE /api/pokes/[id]': async (send) => send({ params: { id: await pokeOf('Cancel me.') } }),
  'POST /api/pokes/[id]': async (send) => send({ params: { id: await pokeOf('Say it now.') } }),
  // Paused, then gone: a run would start Sam's tool.
  'POST /api/jobs/[id]': async (send) => {
    const id = String(await jobOf('Post'));
    await send({ params: { id }, body: { op: 'update', enabled: false } });
    await send({ params: { id }, body: { op: 'delete' } });
  },
  'POST /api/staff/[id]/jobs': (send) =>
    send({
      params: { id: 'sam' },
      body: {
        name: 'Bins',
        instructions: 'Put the bins out.',
        schedule: { every: 'day', at: '19:00' }
      }
    }),
  'DELETE /api/jobs/away': async (send) => {
    await L.pg`update jobs set skipped_at = now() where id = ${await jobOf('Missed')}`;
    await send({});
  },
  'POST /api/reports/[id]': async (send) => {
    await L.addReport('sam', 'The week', 'All quiet.');
    const [r] = await L.pg<{ id: number }[]>`select max(id)::int as id from reports`;
    await send({ params: { id: String(r.id) } });
  },
  'PUT /api/switches': async (send) => {
    const light = (await currentOffice()).world.lights[0];
    assert.ok(light, 'the office has no lamp to switch');
    await send({ body: { obj: light.obj, on: false } });
  },
  // Rio, whom the persona rows added.
  'DELETE /api/personas/[slug]': (send) => send({ params: { slug: 'rio' } })
};

/**
 * Actions that change none of the office's records: any rows each needs, then
 * its call, which must leave every table as it was.
 */
const QUIET: Partial<Record<Key, (send: Send) => Promise<void>>> = {
  'POST /api/account': (send) => send({}),
  'POST /api/client-log': (send) => send({ body: { kind: 'boot', message: '/ in a test' } }),
  'PUT /api/diagnostics': (send) => send({ body: { answer: 'no' } }),
  'DELETE /api/weather': (send) => send({}),
  'POST /api/files/resolve': (send) =>
    send({ body: { files: [{ staff: 'sam', path: 'plan.md' }] } }),
  'POST /api/staff/[id]/description': (send) =>
    send({ params: { id: 'sam' }, body: { servers: [] } }),
  'POST /api/looks/parts': (send) => send({ body: { look: L.MANAGERS.find((m) => m.look)!.look } }),
  // The owner's page has no run's token, so the gateway turns it away.
  'POST /api/gateway/[connector]': (send) => send({ params: { connector: 'gmail' } }),
  'DELETE /api/gateway/[connector]': (send) => send({ params: { connector: 'gmail' } })
};

const AI = "Starts an Odd's AI tool or an outside service, which this office cannot run.";
const AWS = 'Signs in to AWS, or reads from it, which this office cannot reach.';
/** Rows no driver reaches, and why. A new row needs a driver or a reason here. */
const UNDRIVEN: Partial<Record<Key, string>> = {
  'PUT /api/agents': 'Installs or signs in an AI tool on this computer.',
  'POST /api/agents/[tool]': 'Installs or signs in an AI tool on this computer.',
  'PUT /api/agents/[tool]': 'Installs or signs in an AI tool on this computer.',
  'DELETE /api/agents/[tool]': 'Removes an AI tool from this computer.',
  'POST /api/diagnostics/envelope':
    'A test office has no report address, so it drops the envelope and changes nothing; no driver is written yet.',
  'POST /api/files/open': 'Opens the system browser.',
  'POST /api/folders/pick': "Opens the system's folder picker.",
  'PUT /api/weather': "Downloads a country's postal codes from GeoNames.",
  'POST /api/looks': AI,
  'POST /api/office/design': AI,
  'POST /api/staff/draft': AI,
  'POST /api/staff/[id]/chat': AI,
  'PATCH /api/staff/[id]/chat': 'Adds to a reply while it runs, and none runs here.',
  'DELETE /api/staff/[id]/chat': 'Stops a reply while it runs, and none runs here.',
  'POST /api/staff/[id]/bug-reports': "Files on GitHub with the owner's own GitHub CLI.",
  'POST /api/staff/[id]/attachments':
    "Takes the file's bytes with its name in a header, which `request` cannot send; it keeps the file on disk, in no table.",
  'POST /api/project-sessions': 'Talks to a native terminal session over its socket.',
  'POST /api/services/[id]': 'Opens a connect task for an AWS tool.',
  'POST /api/setup/address': "Sets up the office's address with Caddy on port 80.",
  'PUT /api/setup/claude': 'Installs or signs in Claude Code.',
  'POST /api/setup/claude': 'Installs or signs in Claude Code.',
  'DELETE /api/setup/claude': 'Signs Claude Code out.',
  'POST /api/setup/notify': 'Shows a system notification.',
  'POST /api/setup/search': "Downloads the search model from Oddboro's GitHub release.",
  'POST /api/backup':
    "Removes a file in the office's home and touches no table; no driver is written yet.",
  'POST /api/backup/restore':
    'Takes a backup file as its body and restarts the office, which `request` cannot send or survive.',
  'POST /api/browser-link':
    "Only the app's shell, with its key in a header, asks for one, and `request` sends no headers.",
  'POST /api/update':
    "Only the app's shell, with its token, reports an update; an install needs one reported.",
  'GET /connect/callback': "Finishes a hosted server's sign-in, which needs one started with it.",
  'POST /api/tasks/[id]#start-response':
    'Needs a task with a reference file and a response set up; no driver is written yet.',
  'POST /api/tasks/[id]#response':
    'Needs a task with a reference file and a response set up; no driver is written yet.',
  'POST /api/tasks/[id]#oauth': "Starts a hosted server's sign-in.",
  'POST /api/tasks/[id]#secret': "Keeps the owner's key in the system's secret store.",
  'POST /api/tasks/[id]#tools': 'Asks the server for its tools.',
  'POST /api/tasks/[id]#confirm-tools': 'Needs the tools the server listed.',
  'POST /api/tasks/[id]#postal-inboxes': 'Reads the mailboxes a LegalZoom sign-in reaches.',
  'POST /api/tasks/[id]#postal-select': 'Needs the mailboxes a LegalZoom sign-in reached.',
  'POST /api/tasks/[id]#aws-current': AWS,
  'POST /api/tasks/[id]#aws-sign-in': AWS,
  'POST /api/tasks/[id]#aws-roles': AWS,
  'POST /api/tasks/[id]#aws-choose': AWS,
  'POST /api/tasks/[id]#aws-secrets-connected': AWS,
  'POST /api/tasks/[id]#aws-secret-names': AWS,
  'POST /api/tasks/[id]#aws-secret-keys': AWS,
  'POST /api/tasks/[id]#aws-secret': AWS
};

/** The tables each call changed, in the order the driver sent them. A refused call still counts. */
async function tablesChanged(key: string, act: (send: Send) => Promise<void>): Promise<string[][]> {
  const [method, at] = key.split(' ');
  const changed: string[][] = [];
  await act(async (call) => {
    const before = await tableDigests();
    try {
      await reach(at.split('#')[0], method, call);
    } finally {
      const after = await tableDigests();
      changed.push([...after.keys()].filter((k) => after.get(k) !== before.get(k)));
    }
  });
  assert.notEqual(changed.length, 0, `${key}'s driver never called the route`);
  return changed;
}

test('each row that writes no ledger row but changes the office changes a table and writes no ledger row, in every call its driver sends', async (t) => {
  for (const [key, act] of Object.entries(CHANGES)) {
    await t.test(key, async () => {
      for (const changed of await tablesChanged(key, act)) {
        assert.notDeepEqual(changed, [], `${key} changed no table`);
        assert.ok(!changed.includes('ledger'), `${key} wrote a ledger row, and is classed as none`);
        assert.ok(
          !('notAnAction' in OWNER_ACTIONS[key as Key]),
          `${key} changed ${changed.join(', ')}, yet is classed as changing none of the office's records`
        );
      }
    });
  }
});

test('each row classed as changing nothing leaves every table as it was', async (t) => {
  for (const [key, act] of Object.entries(QUIET)) {
    await t.test(key, async () => {
      assert.ok('notAnAction' in OWNER_ACTIONS[key as Key], `${key} is not classed notAnAction`);
      for (const changed of await tablesChanged(key, act))
        assert.deepEqual(
          changed,
          [],
          `${key} changed ${changed.join(', ')}, yet is classed as changing none of the office's records`
        );
    });
  }
});

test('every owner row is driven, or says why it cannot be', () => {
  const driven = new Set([...Object.keys(TRY), ...Object.keys(CHANGES), ...Object.keys(QUIET)]);
  const unaccounted = Object.keys(OWNER_ACTIONS).filter((k) => !driven.has(k) && !(k in UNDRIVEN));
  assert.deepEqual(unaccounted, [], 'these rows have no driver and no reason in UNDRIVEN');
  const both = Object.keys(UNDRIVEN).filter((k) => driven.has(k));
  assert.deepEqual(both, [], 'these rows are driven, so UNDRIVEN should not list them');
});
