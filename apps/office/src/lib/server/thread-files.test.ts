// A file an Odd wrote in a goal's folder, from its reply to the viewer: the
// reply names it by its bare name, the page links that name through the
// office's routes, and the link opens the file, with no thread and no folder
// anywhere the owner reads. Over the office's own database (local-db.ts) in a
// throwaway folder on a free port. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ownerWords } from '../../../../../packages/ledger/test/owner-words.ts';

const folder = mkdtempSync(join(tmpdir(), 'oddboro-thread-files-'));
const port = await new Promise<number>((done) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => done(p));
  });
});
// Set before the office's modules load: they read where everything is as they start.
Object.assign(process.env, {
  ODDBORO_HOME: folder,
  ODDBORO_DB_PORT: String(port),
  // A file that does not exist, so no .env reaches this office.
  ODDBORO_ENV: join(folder, 'none.env'),
  ODDBORO_LOCAL_DB: '1'
});
delete process.env.OFFICE_AUTH;
// The system opener never runs here. The ledger's openFile, which the open
// route reaches, is a stub each test sets, and refuses unless one does.
const platform = await import('@oddboro/ledger/platform');
const noOpener = async (file: string): Promise<boolean> =>
  assert.fail(`${file} reached the opener`);
let opener = noOpener;
mock.module('@oddboro/ledger/platform', {
  namedExports: { ...platform, openFile: (file: string) => opener(file) }
});
const { startLocalDatabase } = await import('@oddboro/ledger/local-db');
const stopDatabase = await startLocalDatabase();
const { bringUpToDate } = await import('@oddboro/ledger/upgrade');
await bringUpToDate();
const L = await import('@oddboro/ledger');
const resolveRoute = await import('../../routes/api/files/resolve/+server.ts');
const fileRoute = await import('../../routes/api/files/+server.ts');
const openRoute = await import('../../routes/api/files/open/+server.ts');
assert.notEqual(L.openFile, platform.openFile, 'the system opener is stubbed before any test');
const { giveIntake, openStaffPage } = await import('./files.ts');
const { askAbout } = await import('../ui/file-links.ts');
const { renderMarkdown } = await import('../ui/markdown.ts');
const { offers, openInBrowser, whose } = await import('../ui/viewer.ts');

after(async () => {
  // Locked folders and files are opened again so the folder can go.
  for (const path of locked) chmodSync(path, 0o755);
  await L.pg.end();
  await stopDatabase();
  rmSync(folder, { recursive: true, force: true });
});

const odd = (id: string, name: string) => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft',
  desk: `You are ${name}.`
});
await L.pg`insert into staff ${L.pg([odd('paige', 'Paige'), odd('lena', 'Lena')])}`;

const put = (path: string, text = 'text', at?: Date): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (at) utimesSync(path, at, at);
  return path;
};
const locked: string[] = [];
const lock = (path: string): void => {
  chmodSync(path, 0o000);
  locked.push(path);
};
const own = (path: string) => join(L.home('staff', 'paige'), path);
const onThread = (id: number, path: string, staff = 'paige') => join(L.threadPart(id, staff), path);
// What the owner reads of a rendered reply. Tags come off until the text stops
// changing, the form CodeQL's check on multi-character sanitising accepts. With
// this pattern one pass already settles, so the loop changes no answer.
const visibleText = (html: string): string => {
  let text = html;
  let before: string;
  do {
    before = text;
    text = text.replace(/<[^>]+>/g, '');
  } while (text !== before);
  return text.trim();
};
mkdirSync(own(''), { recursive: true });

// The routes take a SvelteKit request event; these handlers read only its request or url.
type ResolveEvent = Parameters<typeof resolveRoute.POST>[0];
type FileEvent = Parameters<typeof fileRoute.GET>[0];
type OpenEvent = Parameters<typeof openRoute.POST>[0];
// The page's own calls, answered by the office's own routes. A route that
// refuses throws, and the page gets that refusal as SvelteKit sends it.
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const request = new Request(`http://office${url}`, init);
  try {
    if (url === '/api/files/open') return await openRoute.POST({ request } as OpenEvent);
    assert.equal(url, '/api/files/resolve');
    return await resolveRoute.POST({ request } as ResolveEvent);
  } catch (e) {
    const { status, body } = e as { status: number; body: { message: string } };
    return Response.json(body, { status });
  }
}) as typeof fetch;
/** What the viewer opens for a link's `data-file`. */
async function open(dataFile: string): Promise<{ path: string; content: string; mtime: number }> {
  const [staff, path] = dataFile.split(':');
  const url = new URL('http://office/api/files');
  url.search = new URLSearchParams({ staff, path }).toString();
  return (await fileRoute.GET({ url } as FileEvent)).json();
}
/** What the owner reads when the viewer cannot open `path`. */
async function refusal(path: string): Promise<string> {
  const url = new URL('http://office/api/files');
  url.search = new URLSearchParams({ staff: 'paige', path }).toString();
  try {
    await fileRoute.GET({ url } as FileEvent);
  } catch (e) {
    return (e as { body: { message: string } }).body.message;
  }
  return assert.fail(`${path} opened`);
}
/** Which of `paths` Paige's text links, by the page's own check. */
async function opens(...paths: string[]): Promise<(string | null)[]> {
  const files = paths.map((path) => ({ staff: 'paige', path }));
  const request = new Request('http://office/api/files/resolve', {
    method: 'POST',
    body: JSON.stringify({ files })
  });
  return (await resolveRoute.POST({ request } as ResolveEvent)).json();
}

test('a file named in a reply that the Odd wrote in two goal folders links by its bare name and opens the newer one', async () => {
  // The older goal's folder holds the newer file: the Odd went back to it.
  put(onThread(7, 'plan.md'), 'The first plan.', new Date(Date.now() - 3_600_000));
  put(onThread(3, 'plan.md'), 'The plan as it is now.');
  const reply = 'The plan is in `plan.md`, ready for you.';

  const first = renderMarkdown(reply, 'paige');
  assert.doesNotMatch(first.html, /<a /, 'no link before the office says the name opens');
  await askAbout(first.unknown);
  const { html } = renderMarkdown(reply, 'paige');

  const link = html.match(
    /<a href="#" data-file="([^"]+)" title="([^"]+)"><code>([^<]+)<\/code><\/a>/
  );
  assert.ok(link, html);
  assert.deepEqual(link.slice(1), ['paige:plan.md', 'Open plan.md', 'plan.md']);
  const visible = visibleText(html);
  assert.equal(visible, 'The plan is in plan.md, ready for you.');
  assert.doesNotMatch(html, /thread|\/[37]\//i, 'no thread, number or folder in the page');

  const opened = await open(link[1]);
  assert.equal(opened.content, 'The plan as it is now.');
  assert.equal(opened.path, 'plan.md', 'the viewer shows the bare name');
});

test("the owner's save of a thread file lands in that file, and the Ledger names it by its bare name", async () => {
  const file = put(onThread(4, 'menu.md'), 'Soup.');
  const { mtime } = await open('paige:menu.md');
  const request = new Request('http://office/api/files', {
    method: 'PUT',
    body: JSON.stringify({ staff: 'paige', path: 'menu.md', content: 'Soup and bread.', mtime })
  });
  const saved = await (await fileRoute.PUT({ request } as FileEvent)).json();
  assert.equal(saved.path, 'menu.md');
  assert.equal(readFileSync(file, 'utf8'), 'Soup and bread.');
  const [row] = await L.pg<{ title: string }[]>`select title from ledger order by id desc limit 1`;
  assert.equal(row.title, "Edited Paige's menu.md");
});

test("the Odd's own folder comes first, and one name two files there share opens nothing", async () => {
  put(own('notes/list.md'), 'Mine.');
  put(onThread(3, 'list.md'), 'On the thread.');
  put(own('a/twice.md'));
  put(own('b/twice.md'));
  put(onThread(3, 'twice.md'));
  assert.deepEqual(await opens('list.md', 'twice.md'), ['notes/list.md', null]);
  assert.equal((await open('paige:list.md')).content, 'Mine.');
});

test("a thread file opens only by its bare name, only from the Odd's own part, and never through a link", async () => {
  const outside = put(join(folder, 'elsewhere', 'secret.md'));
  put(onThread(3, 'drafts/deep.md'));
  put(onThread(3, 'only-lena.md', 'lena'));
  symlinkSync(outside, onThread(3, 'pointer.md'));
  mkdirSync(L.threadFolder(9), { recursive: true });
  symlinkSync(dirname(outside), L.threadPart(9, 'paige'));
  assert.deepEqual(
    await opens(
      'drafts/deep.md',
      'only-lena.md',
      'pointer.md',
      'secret.md',
      '../elsewhere/secret.md'
    ),
    [null, null, null, null, null]
  );
  assert.equal((await opens('deep.md'))[0], 'deep.md', 'deeper in its part, by bare name');
});

test('a thread file over the size limit, or not text, opens nothing', async () => {
  put(onThread(3, 'big.md'), 'x'.repeat(1_000_001));
  put(onThread(3, 'bin.md'), 'a\0b');
  assert.deepEqual(await opens('big.md', 'bin.md'), [null, null]);
});

test('a thread folder that is itself a link is never searched', async () => {
  const outside = join(folder, 'outside-thread');
  put(join(outside, 'paige', 'escaped.md'), 'Outside the office.');
  symlinkSync(outside, L.threadFolder(31));
  assert.deepEqual(await opens('escaped.md'), [null]);
});

test("a folder the office may not read hides only what is in it, and the owner's error names no folder", async () => {
  put(onThread(21, 'locked/hidden.md'));
  lock(dirname(onThread(21, 'locked/hidden.md')));
  put(onThread(22, 'still-here.md'), 'Still here.');
  assert.equal((await open('paige:still-here.md')).content, 'Still here.');

  lock(put(onThread(22, 'sealed.md')));
  const said = await refusal('sealed.md');
  assert.equal(said, 'Could not open the file');
  assert.equal(await refusal('../threads/22/paige/nothing.md'), 'No file at nothing.md');
});

/** Open `path` as Paige's page with a stub opener, and what the opener got, or the refusal. */
async function openPage(path: string): Promise<string[][] | string> {
  const opener = mock.fn(async (_file: string) => true);
  try {
    await openStaffPage('paige', path, opener);
  } catch (e) {
    assert.equal(opener.mock.callCount(), 0, 'nothing opens when it is refused');
    return (e as Error).message;
  }
  return opener.mock.calls.map((c) => c.arguments);
}

/**
 * The owner's click on a page's Open in browser button, through the open
 * route, with an opener that opens (or not, `opens`): the answer, and every
 * path the opener got.
 */
async function click(
  path: string,
  { staff = 'paige', opens = true } = {}
): Promise<{ status: number; message?: string; got: string[] }> {
  const got: string[] = [];
  opener = async (file) => {
    got.push(file);
    return opens;
  };
  const request = new Request('http://office/api/files/open', {
    method: 'POST',
    body: JSON.stringify({ staff, path })
  });
  try {
    return { status: (await openRoute.POST({ request } as OpenEvent)).status, got };
  } catch (e) {
    const { status, body } = e as { status: number; body: { message: string } };
    return { status, message: body.message, got };
  } finally {
    opener = noOpener;
  }
}

test("the Open in browser button opens the page through the route, and the opener gets only the page's real path", async () => {
  const page = put(onThread(8, 'quiz.html'));
  assert.deepEqual(await click('quiz.html'), { status: 200, got: [realpathSync(page)] });
});

test('a page that does not open tells the owner so by its bare name, never by a path', async () => {
  const page = put(own('cards.html'));
  assert.deepEqual(await click('cards.html', { opens: false }), {
    status: 404,
    message: 'Could not open cards.html in your browser',
    got: [realpathSync(page)]
  });
  // An Odd whose folder is gone fails with an error that names the folder, which only the log gets.
  await L.pg`insert into staff ${L.pg(odd('gone', 'Gone'))}`;
  const said = await click('cards.html', { staff: 'gone' });
  assert.deepEqual(said, { status: 404, message: 'Could not open the page', got: [] });
});

test("a page over the viewer's size limit still links with its button and opens in the browser, while the viewer refuses it", async () => {
  const big = put(own('big-game.html'), 'x'.repeat(2_000_000));
  const reply = 'Play `big-game.html`.';
  await askAbout(renderMarkdown(reply, 'paige').unknown);
  const { html } = renderMarkdown(reply, 'paige');
  assert.match(html, /<a href="#" data-file="paige:big-game\.html"/);
  assert.match(html, /<button type="button" data-page="paige:big-game\.html"/);
  assert.deepEqual(await click('big-game.html'), { status: 200, got: [realpathSync(big)] });
  assert.equal(await refusal('big-game.html'), 'big-game.html is too big to open here');
});

test('a page an Odd built opens in the browser by its bare name, the newest of that name, as its one real path', async () => {
  put(onThread(5, 'game.html'), 'old', new Date(Date.now() - 3_600_000));
  const newest = put(onThread(6, 'game.html'), 'new');
  assert.deepEqual(await openPage('game.html'), [[realpathSync(newest)]]);
  const index = put(own('site/index.htm'));
  assert.deepEqual(await openPage('site/index.htm'), [[realpathSync(index)]]);
});

test("a page outside the Odd's folders, through a link, by a full path or not a page never opens", async () => {
  const outside = put(join(folder, 'elsewhere', 'trap.html'));
  const mine = put(own('mine.html'));
  put(own('notes.md'));
  symlinkSync(outside, own('pointer.html'));
  symlinkSync(own('notes.md'), own('notes.html'));
  assert.equal(await openPage('../../elsewhere/trap.html'), 'No file at trap.html');
  assert.equal(await openPage(outside), 'No file at trap.html');
  assert.equal(await openPage(mine), 'No file at mine.html', 'a full path, even to its own file');
  assert.equal(await openPage('pointer.html'), 'No file at pointer.html');
  assert.equal(await openPage('notes.md'), 'notes.md is not a page');
  assert.equal(await openPage('notes.html'), 'notes.html is not a page');
});

test('a name with .html anywhere but at its end is not a page', async () => {
  put(own('x.html.terminal'));
  put(own('page.html.txt'));
  assert.equal(await openPage('x.html.terminal'), 'x.html.terminal is not a page');
  assert.equal(await openPage('page.html.txt'), 'page.html.txt is not a page');
});

test('a page named in a reply links to the viewer with an Open in browser button beside it', async () => {
  put(onThread(6, 'board.html'));
  put(onThread(6, 'board-notes.md'));
  const reply = 'Play `board.html`, rules in `board-notes.md`.';
  await askAbout(renderMarkdown(reply, 'paige').unknown);
  const { html } = renderMarkdown(reply, 'paige');
  assert.match(
    html,
    /<a href="#" data-file="paige:board\.html" title="Open board\.html"><code>board\.html<\/code><\/a><button type="button" data-page="paige:board\.html" class="open-page">Open in browser<\/button>/
  );
  assert.equal(html.match(/<button/g)?.length, 1, 'only the page gets a button');
  const visible = visibleText(html);
  assert.equal(visible, 'Play board.htmlOpen in browser, rules in board-notes.md.');
  ownerWords(visible);
});

// A lead hands the owner what a colleague built in a goal's folder: Lena leads
// the goal's work, Paige serves the goal, and Kai is on neither.
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
await L.pg`insert into staff ${L.pg(odd('kai', 'Kai'))}`;
const [goal] = await L.pg<
  { id: number }[]
>`insert into goals (title) values ('A game') returning id`;
await L.pg`insert into staff_goals (staff_id, goal_id, part) values ('paige', ${goal.id}, 'Builds it')`;
const newThread = async (hub: string, goalId: number | null = null) =>
  (
    await L.pg<{ id: number }[]>`insert into threads (title, goal_id, hub_id, holder_id)
      values ('Work', ${goalId}, ${hub}, ${hub}) returning id`
  )[0].id;
const gameWork = await newThread('lena', goal.id);
const kaisWork = await newThread('kai');
const inWork = (id: number, path: string) => join(L.threadFolder(id), path);
const workName = (id: number, path: string) => `threads/${id}/${path}`;

const servers: InstanceType<typeof Client>[] = [];
after(() => Promise.all(servers.map((c) => c.close())));
/** Lena's office tool server, as the office starts it for her run on the goal's work. */
async function lenasTools() {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const env = Object.fromEntries(
    [
      'PATH',
      'ODDBORO_HOME',
      'ODDBORO_DB_PORT',
      'ODDBORO_ENV',
      'DATABASE_URL',
      'ODDBORO_LOCAL_DB'
    ].map((k) => [k, process.env[k] ?? ''])
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../../../../packages/ledger/src/mcp.ts', import.meta.url))],
      env: { ...env, STAFF_ID: 'lena', THREAD_ID: String(gameWork), RUN_KEY: 'k-lena' },
      stderr: 'ignore'
    })
  );
  servers.push(client);
  return client;
}
/** Lena gives the owner a result task with `attach`: what the tool said, and the desk's attachments for it. */
/** How many result tasks Lena gave: each gets its own title, since a repeat is refused. */
let results = 0;
async function resultTask(...attach: string[]) {
  results += 1;
  const r = await (
    await lenasTools()
  ).callTool({
    name: 'give_owner_a_task',
    arguments: {
      title: `Try the game, take ${results}`,
      why: 'It is built.',
      steps: ['Play it.'],
      attach
    }
  });
  const text = (r.content as { text: string }[])[0].text;
  const id = Number(/^Task (\d+) /.exec(text)?.[1]);
  return { text, files: (await L.desk()).attachments.filter((f) => f.taskId === id) };
}

test('a result task with a page a colleague built in the goal folder shows Open in browser in the viewer, which opens that one page', async () => {
  const game = put(inWork(gameWork, 'paige/game/index.html'), '<p>The game</p>');
  // The same name everywhere else Lena or Paige keeps files.
  put(join(L.home('staff', 'lena'), 'index.html'), 'Lena');
  put(own('index.html'), 'Paige');
  put(inWork(kaisWork, 'paige/game/index.html'), 'Another');
  const name = workName(gameWork, 'paige/game/index.html');

  const { text, files } = await resultTask(name);
  assert.match(text, /^Task \d+ is on/);
  assert.equal(files.length, 1);
  const file = { staff: files[0].staffId, path: files[0].path };
  assert.deepEqual(offers(file), { shown: 'index.html', edit: false, browser: true });

  const got: string[] = [];
  opener = async (f) => {
    got.push(f);
    return true;
  };
  try {
    await openInBrowser(file);
  } finally {
    opener = noOpener;
  }
  assert.deepEqual(got, [realpathSync(game)]);
  assert.equal((await open(`${file.staff}:${file.path}`)).content, '<p>The game</p>');

  // Named so in Lena's reply, it links by its bare name too.
  const reply = `Play \`${name}\`.`;
  await askAbout(renderMarkdown(reply, 'lena').unknown);
  const { html } = renderMarkdown(reply, 'lena');
  assert.equal(visibleText(html), 'Play index.htmlOpen in browser.');
  assert.doesNotMatch(html.replace(/data-(file|page)="[^"]*"/g, ''), /threads|\/\d+\//);

  const { mtime } = await open(`${file.staff}:${file.path}`);
  const request = new Request('http://office/api/files', {
    method: 'PUT',
    body: JSON.stringify({ ...file, content: 'Changed', mtime })
  });
  await assert.rejects(async () => fileRoute.PUT({ request } as FileEvent), {
    status: 409,
    body: { status: 409, message: 'index.html opens here to read only' }
  });
  assert.equal(readFileSync(game, 'utf8'), '<p>The game</p>');
});

test('a Markdown file attached from the goal folder gets no Open in browser button, and one in the Odd folder stays editable', async () => {
  put(inWork(gameWork, 'paige/rules.md'), 'Rules.');
  put(join(L.home('staff', 'lena'), 'notes/answers.md'), 'Answers.');
  const { files } = await resultTask(workName(gameWork, 'paige/rules.md'), 'notes/answers.md');
  assert.deepEqual(
    files.map((f) => offers({ staff: f.staffId, path: f.path })),
    [
      { shown: 'rules.md', edit: false, browser: false },
      { shown: 'notes/answers.md', edit: true, browser: false }
    ]
  );
});

test("the viewer calls a goal-folder file Lena attached Paige's file, and one in Lena's folder hers, naming no thread or folder", () => {
  const names: Record<string, string> = { lena: 'Lena', paige: 'Paige' };
  const name = (id: string) => names[id] ?? id;
  const work = whose({ staff: 'lena', path: workName(gameWork, 'paige/game/rules.md') }, name);
  assert.equal(work, "Paige's file");
  ownerWords(work);
  assert.doesNotMatch(work, /\d|\//, 'a number or a folder path');
  assert.equal(
    whose({ staff: 'lena', path: 'notes/answers.md' }, name),
    "Lena's folder · notes/answers.md"
  );
});

test('a file outside the folders an Odd reads is refused when it attaches it and when the owner opens it', async () => {
  const outside = put(join(folder, 'elsewhere', 'trap.html'));
  put(inWork(kaisWork, 'kai/kais.html'));
  const real = put(inWork(gameWork, 'paige/real.html'));
  symlinkSync(outside, inWork(gameWork, 'paige/out.html'));
  symlinkSync(L.threadFolder(kaisWork), inWork(gameWork, 'paige/hop'));
  symlinkSync(outside, join(L.home('staff', 'lena'), 'out.html'));
  const names = [
    workName(kaisWork, 'kai/kais.html'),
    workName(gameWork, `../${kaisWork}/kai/kais.html`),
    workName(gameWork, 'paige/../../../elsewhere/trap.html'),
    realpathSync(real),
    workName(gameWork, 'paige/out.html'),
    workName(gameWork, 'paige/hop/kai/kais.html'),
    'out.html'
  ];
  for (const name of names) {
    const { text, files } = await resultTask(name);
    assert.match(text, /^No file at .* that you can attach/, name);
    assert.equal(files.length, 0);
    const { status, got } = await click(name, { staff: 'lena' });
    assert.deepEqual({ status, got }, { status: 404, got: [] }, name);
  }
});

test('a name with a thread number too big for any thread is refused as no such file when attached and when opened', async () => {
  const name = workName(99_999_999_999, 'paige/a.html');
  const { text, files } = await resultTask(name);
  assert.match(text, /^No file at .* that you can attach/);
  assert.equal(files.length, 0);
  const { status, got } = await click(name, { staff: 'lena' });
  assert.deepEqual({ status, got }, { status: 404, got: [] });
});

test('an Odd that no longer serves the goal opens nothing from its folder', async () => {
  const left = put(inWork(gameWork, 'lena/left.html'));
  const name = workName(gameWork, 'lena/left.html');
  assert.deepEqual(await click(name, { staff: 'paige' }), {
    status: 200,
    got: [realpathSync(left)]
  });
  await L.pg`delete from staff_goals where staff_id = 'paige'`;
  try {
    assert.equal((await click(name, { staff: 'paige' })).status, 404);
  } finally {
    await L.pg`insert into staff_goals (staff_id, goal_id, part) values ('paige', ${goal.id}, 'Builds it')`;
  }
});

// Folders the owner gave Paige, beside the office's own folder.
const projects = join(folder, 'projects');
const site = join(projects, 'site');
const give = (folders: { path: string; write: boolean }[]) =>
  L.pg`update staff set folders = ${JSON.stringify(folders)}::jsonb where id = 'paige'`;
/** The owner's save through the files route, and its refusal if it has one. */
async function save(path: string, mtime: number): Promise<string> {
  const request = new Request('http://office/api/files', {
    method: 'PUT',
    body: JSON.stringify({ staff: 'paige', path, content: 'Changed.', mtime })
  });
  try {
    await fileRoute.PUT({ request } as FileEvent);
  } catch (e) {
    return (e as { body: { message: string } }).body.message;
  }
  return 'saved';
}

test("a full path into a folder the owner gave links by that folder's name, opens to read only, and opens in the browser", async () => {
  const page = put(join(site, 'index.html'), '<h1>Site</h1>');
  const plan = put(join(site, 'docs', 'plan.md'), 'Plan.');
  await give([{ path: site, write: true }]);
  try {
    assert.deepEqual(await opens(page, `~/${relative(homedir(), plan)}`), [
      'folders/site/index.html',
      'folders/site/docs/plan.md'
    ]);
    const reply = `Built ${page}, with the plan in \`${plan}\`.`;
    await askAbout(renderMarkdown(reply, 'paige').unknown);
    const html = renderMarkdown(reply, 'paige').html;
    assert.match(html, /data-file="paige:folders\/site\/index\.html"/);
    assert.equal(
      visibleText(html),
      'Built site/index.htmlOpen in browser, with the plan in site/docs/plan.md.'
    );
    const opened = await open('paige:folders/site/docs/plan.md');
    assert.equal(opened.content, 'Plan.');
    assert.deepEqual(offers({ staff: 'paige', path: 'folders/site/docs/plan.md' }), {
      shown: 'site/docs/plan.md',
      edit: false,
      browser: false
    });
    assert.equal(
      whose({ staff: 'paige', path: 'folders/site/docs/plan.md' }, () => 'Paige'),
      'Your folder · site/docs/plan.md'
    );
    assert.equal(
      await save('folders/site/docs/plan.md', opened.mtime),
      'plan.md opens here to read only'
    );
    assert.equal(readFileSync(plan, 'utf8'), 'Plan.');
    assert.deepEqual(await openPage('folders/site/index.html'), [[realpathSync(page)]]);
  } finally {
    await give([]);
  }
});

test('a file in a given folder never opens through a link out, from outside it, or once the folder is taken back', async () => {
  const page = put(join(site, 'index.html'));
  const beside = put(join(projects, 'beside.md'));
  const secret = put(join(folder, 'elsewhere', 'given-secret.md'));
  symlinkSync(secret, join(site, 'out.md'));
  symlinkSync(dirname(secret), join(site, 'away'));
  await give([{ path: site, write: false }]);
  try {
    assert.deepEqual(
      await opens(
        join(site, 'out.md'),
        join(site, 'away', 'given-secret.md'),
        beside,
        join(site, '..', 'beside.md'),
        'folders/site/../beside.md',
        'folders/site/out.md',
        secret
      ),
      [null, null, null, null, null, null, null]
    );
    assert.equal(await refusal(secret), 'No file at given-secret.md');
    assert.deepEqual(await opens(page), ['folders/site/index.html']);
    await give([]);
    assert.deepEqual(await opens(page, 'folders/site/index.html'), [null, null]);
  } finally {
    await give([]);
  }
});

test("two given folders with one name, or a drive's top, name nothing, and a file in two given folders goes by the inner one", async () => {
  const page = put(join(site, 'index.html'));
  const twin = join(folder, 'other', 'site');
  put(join(twin, 'index.html'));
  const beside = put(join(projects, 'beside.md'));
  try {
    await give([
      { path: site, write: false },
      { path: twin, write: false }
    ]);
    assert.deepEqual(await opens(page, 'folders/site/index.html'), [null, null]);
    await give([
      { path: projects, write: false },
      { path: site, write: false }
    ]);
    assert.deepEqual(await opens(page, beside), [
      'folders/site/index.html',
      'folders/projects/beside.md'
    ]);
    await give([{ path: '/', write: false }]);
    assert.deepEqual(await opens(page), [null]);
  } finally {
    await give([]);
  }
});

test("a given folder its runs no longer get, holding keys or gone from the disk, opens nothing, says why by its name alone and gives no hire's intake", async () => {
  const oldMac = join(folder, 'old-mac');
  const notes = put(join(oldMac, 'notes.md'), 'From the old Mac.');
  put(join(oldMac, 'plan.md'), 'The old plan.');
  const keys = join(oldMac, '.ssh');
  put(join(keys, 'known_hosts'), 'host key');
  put(own('folders/old-mac/notes.md'), "Paige's own notes.");
  const page = put(join(site, 'index.html'));
  const gone = join(folder, 'gone');
  try {
    await give([
      { path: oldMac, write: false },
      { path: site, write: false },
      // In a store and gone from the disk: no refusal below names it or fails on it.
      { path: join(keys, 'gone'), write: false }
    ]);
    // By its full path and by its name in the office, the folder's name alone.
    assert.equal(
      await refusal(notes),
      'notes.md is in old-mac, which holds keys or sign-ins, so Paige no longer gets it.'
    );
    assert.equal(
      await refusal('folders/old-mac/plan.md'),
      'plan.md is in old-mac, which holds keys or sign-ins, so Paige no longer gets it.'
    );
    assert.equal(await refusal(join(oldMac, 'missing.md')), 'No file at missing.md');
    assert.equal(await refusal('folders/old-mac/missing.md'), 'No file at missing.md');
    assert.deepEqual(await opens(notes, page), [null, 'folders/site/index.html']);
    assert.equal((await open('paige:folders/site/index.html')).path, 'folders/site/index.html');
    await giveIntake('paige', 'folders/old-mac/notes.md', 'lena');
    assert.equal(
      readFileSync(join(L.home('staff', 'lena'), 'notes', 'intake.md'), 'utf8'),
      "Paige's own notes."
    );
    rmSync(keys, { recursive: true });
    assert.deepEqual(await opens(notes), ['folders/old-mac/notes.md']);
    await give([
      { path: site, write: false },
      { path: gone, write: false }
    ]);
    assert.deepEqual(await opens(page, join(gone, 'notes.md'), 'folders/gone/notes.md'), [
      'folders/site/index.html',
      null,
      null
    ]);
  } finally {
    await give([]);
  }
});
