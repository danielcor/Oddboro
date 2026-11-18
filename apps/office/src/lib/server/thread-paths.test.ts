// A full path into a thread's folder, from an Odd's text to the viewer, through
// the office's own routes and `workFile`: it opens for the Odd whose part holds
// it, while that Odd is on the thread, and the owner reads only its bare name.
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { L, odd } from './office-under-test.ts';

const { readStaffFile, openStaffPage } = await import('./files.ts');
const { askAbout } = await import('../ui/file-links.ts');
const { renderMarkdown } = await import('../ui/markdown.ts');
const resolveRoute = await import('../../routes/api/files/resolve/+server.ts');
type ResolveEvent = Parameters<typeof resolveRoute.POST>[0];
// The page's one call, answered by the office's own route.
globalThis.fetch = (async (_url: string, init: RequestInit) =>
  resolveRoute.POST({
    request: new Request('http://office/api/files/resolve', init)
  } as ResolveEvent)) as typeof fetch;

await L.pg`insert into staff ${L.pg([odd('vera', 'Vera'), odd('jax', 'Jax'), odd('rex', 'Rex')])}`;

async function thread(hub: string, ...colleagues: string[]): Promise<number> {
  const [{ id }] = await L.pg<{ id: number }[]>`
    insert into threads (title, hub_id, holder_id) values ('A piece of work', ${hub}, ${hub}) returning id`;
  for (const c of colleagues)
    await L.pg`insert into follow_ups (staff_id, kind, thread_id, outcome, done_at) values (${c}, 'hand_off', ${id}, 'done', now())`;
  return id;
}
const put = (id: number, staff: string, path: string, text: string): string => {
  const file = `${L.threadPart(id, staff)}/${path}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
/** `text` as the page shows it once the office has answered. */
async function rendered(text: string, staff?: string): Promise<string> {
  await askAbout(renderMarkdown(text, staff).unknown);
  return renderMarkdown(text, staff).html.trim();
}
const fullPath = (id: number, staff: string, path: string) =>
  `/Users/Shared/.oddboro/threads/${id}/${staff}/${path}`;
const dataFile = (html: string): string => {
  const m = /data-file="([^"]+)"/.exec(html);
  assert.ok(m, html);
  return m[1];
};

test('a full path Vera wrote to her own part links, with its button, and opens that file', async () => {
  const id = await thread('vera');
  put(id, 'vera', 'm/index.html', '<p>Built</p>');
  const html = await rendered(`Here: ${fullPath(id, 'vera', 'm/index.html')}`, 'vera');
  assert.match(html, /title="Open index\.html">index\.html<\/a>/);
  assert.match(html, /Open in browser/);
  assert.equal(dataFile(html), `vera:threads/${id}/vera/m/index.html`);
  const opened = await readStaffFile('vera', `threads/${id}/vera/m/index.html`);
  assert.equal(opened.content, '<p>Built</p>');
});

test("Jax writing the full path of Vera's page links it, and opens Vera's page", async () => {
  const id = await thread('vera', 'jax');
  const file = put(id, 'vera', 'site/index.html', "<p>Vera's</p>");
  const html = await rendered(`\`${fullPath(id, 'vera', 'site/index.html')}\``, 'jax');
  assert.equal(dataFile(html), `vera:threads/${id}/vera/site/index.html`);
  const got: string[] = [];
  await openStaffPage('vera', `threads/${id}/vera/site/index.html`, async (f) => {
    got.push(f);
    return true;
  });
  assert.deepEqual(got, [realpathSync(file)]);
});

test('a thread path naming an Odd who is not on that thread stays text, and nothing opens', async () => {
  const id = await thread('vera');
  put(id, 'rex', 'notes.md', 'Rex was never on this.');
  const path = fullPath(id, 'rex', 'notes.md');
  assert.equal(await rendered(`See ${path}`, 'vera'), `<p>See ${path}</p>`);
  await assert.rejects(readStaffFile('rex', `threads/${id}/rex/notes.md`));
});

test('a thread that is closed or done still opens, since workFile has no status filter', async () => {
  const id = await thread('vera');
  put(id, 'vera', 'report.md', 'All done.');
  await L.pg`update threads set status = 'done', ended_at = now() where id = ${id}`;
  const html = await rendered(`\`${fullPath(id, 'vera', 'report.md')}\``, 'vera');
  assert.equal(dataFile(html), `vera:threads/${id}/vera/report.md`);
  assert.equal((await readStaffFile('vera', `threads/${id}/vera/report.md`)).content, 'All done.');
});

for (const name of ['my page.html', 'page (1).html', 'a&b.html', 'a#b.html', 'caf\u00e9.html'])
  test(`a file: link naming ${name} opens that file through the office's own route`, async () => {
    const id = await thread('vera');
    put(id, 'vera', name, `<p>${name}</p>`);
    const url = fullPath(id, 'vera', name).split('/').map(encodeURIComponent).join('/');
    const html = await rendered(`[a](file://${url})`, 'vera');
    const opens = dataFile(html).replaceAll('&amp;', '&');
    assert.equal(opens, `vera:threads/${id}/vera/${name}`);
    const opened = await readStaffFile('vera', opens.slice('vera:'.length));
    assert.equal(opened.content, `<p>${name}</p>`);
  });

test("an address that climbs out with an encoded step opens nothing, in a thread or in an Odd's own folder", async () => {
  const id = await thread('vera');
  put(id, 'vera', 'kept.md', 'Kept.');
  mkdirSync(L.home('staff', 'jax'), { recursive: true });
  writeFileSync(L.home('staff', 'jax', 'secret.md'), 'Not for Vera.');
  const home = '/Users/Shared/.oddboro';
  for (const [path, html] of [
    [`${home}/threads/${id}/vera/%2e%2e/%2e%2e/%2e%2e/staff/jax/secret.md`, undefined],
    [`${home}/threads/${id}/vera/..%2Fsecret.md`, undefined],
    [`${home}/staff/vera/%2e%2e/jax/secret.md`, '<p>a</p>'],
    [`${home}/staff/vera/..%2Fjax/secret.md`, undefined]
  ] as const)
    assert.equal(
      await rendered(`[a](file://${path})`, 'vera'),
      html ?? `<p>[a](file://${path})</p>`,
      path
    );
});
