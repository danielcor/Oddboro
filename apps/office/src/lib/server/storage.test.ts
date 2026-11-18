// The Storage tab's list of an Odd's folder (`listStorage` and its route).
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { L, odd } from './office-under-test.ts';

const { readStaffFile } = await import('./files.ts');
const { listStorage, oddStorage } = await import('./storage.ts');
const route = await import('../../routes/api/staff/[id]/storage/+server.ts');
type RouteEvent = Parameters<typeof route.GET>[0];
const outside = mkdtempSync(join(tmpdir(), 'oddboro-storage-outside-'));
after(() => rmSync(outside, { recursive: true, force: true }));

/** An Odd's folder with what it made, the office's own files, hidden ones and links out. */
function oddFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'oddboro-storage-'));
  mkdirSync(join(root, 'notes'));
  mkdirSync(join(root, 'made', 'drafts'), { recursive: true });
  writeFileSync(join(root, 'notes', 'intake.md'), 'Hello');
  writeFileSync(join(root, 'made', 'plan.md'), 'A plan');
  writeFileSync(join(root, 'made', 'drafts', 'one.md'), 'One');
  // The office's own, the instruction files and hidden ones never show.
  for (const name of L.OFFICE_FILE_NAMES) writeFileSync(join(root, name), '{}');
  writeFileSync(join(root, 'CLAUDE.md'), 'Instructions');
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), '{}');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.env'), 'SECRET=1');
  // A link leads out of the folder: neither listed nor followed.
  writeFileSync(join(outside, 'private.txt'), 'Outside the folder');
  symlinkSync(outside, join(root, 'away'));
  symlinkSync(join(outside, 'private.txt'), join(root, 'notes', 'private.txt'));
  return root;
}

test("Storage lists what an Odd kept in its own folder, folders first, and never the office's own files (a persona's session among them), hidden ones or a link out", () => {
  assert.ok(L.OFFICE_FILE_NAMES.includes('persona-session.json'));
  const root = oddFolder();
  try {
    const { entries, capped } = listStorage(root);
    assert.equal(capped, false);
    assert.deepEqual(
      entries.map((e) => `${e.dir ? 'dir ' : ''}${e.path}`),
      [
        'dir made',
        'dir made/drafts',
        'made/drafts/one.md',
        'made/plan.md',
        'dir notes',
        'notes/intake.md'
      ]
    );
    assert.equal(entries.find((e) => e.path === 'made/plan.md')?.size, 6);
    // A same-named file further in is the Odd's own, not the office's.
    writeFileSync(join(root, 'notes', 'chat.jsonl'), '{}');
    assert.ok(listStorage(root).entries.some((e) => e.path === 'notes/chat.jsonl'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Storage stops at its cap and says so, and a folder that is not there lists nothing', () => {
  const root = oddFolder();
  try {
    const { entries, capped } = listStorage(root, 3);
    assert.equal(entries.length, 3);
    assert.equal(capped, true);
    assert.deepEqual(listStorage(join(root, 'nowhere')), { entries: [], capped: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Storage route lists an Odd's own folder, and names no folder for an Odd that is not there", async () => {
  const dir = L.home('staff', 'cleo');
  mkdirSync(join(dir, 'made'), { recursive: true });
  writeFileSync(join(dir, 'made', 'storage-test.md'), 'Kept');
  try {
    const res = await route.GET({ params: { id: 'cleo' } } as RouteEvent);
    const body = (await res.json()) as {
      entries: { path: string }[];
      capped: boolean;
      cap: number;
    };
    assert.ok(body.entries.some((e) => e.path === 'made/storage-test.md'));
    assert.equal(body.cap, 5000);
    for (const id of ['nobody', '../cleo', 'Cleo'])
      await assert.rejects(
        async () => route.GET({ params: { id } } as RouteEvent),
        (e: unknown) => (e as { status?: number }).status === 404
      );
  } finally {
    rmSync(join(dir, 'made', 'storage-test.md'), { force: true });
  }
});

let oddCount = 0;
/** A fresh Odd of its own, so no test sees another's folders. */
async function newOdd(): Promise<string> {
  const id = `odd-${++oddCount}`;
  await L.pg`insert into staff ${L.pg(odd(id, `Odd ${oddCount}`))}`;
  mkdirSync(L.home('staff', id), { recursive: true });
  return id;
}
/** A thread led by `hub`, with `colleagues` handed work on it. */
async function thread(title: string, hub: string, ...colleagues: string[]): Promise<number> {
  const [{ id }] = await L.pg<{ id: number }[]>`
    insert into threads (title, hub_id, holder_id) values (${title}, ${hub}, ${hub}) returning id`;
  for (const c of colleagues)
    await L.pg`insert into follow_ups (staff_id, kind, thread_id, outcome, done_at) values (${c}, 'hand_off', ${id}, 'done', now())`;
  return id;
}
const put = (path: string, text = 'made'): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const files = (w: { entries: { path: string; dir: boolean }[] }) =>
  w.entries.filter((e) => !e.dir).map((e) => e.path);

test('an Odd with no threads gets its own folder and no shared work, exactly as before', async () => {
  const id = await newOdd();
  put(join(L.home('staff', id), 'notes', 'a.md'));
  const body = await (await route.GET({ params: { id } } as RouteEvent)).json();
  assert.deepEqual(body, { ...listStorage(L.home('staff', id)), work: [], cap: 5000 });
});

test("Storage shows an Odd's parts of two threads, newest first, by title, each file by the name the viewer opens", async () => {
  const id = await newOdd();
  const colleague = await newOdd();
  put(join(L.home('staff', id), 'notes', 'own.md'));
  const older = await thread('Older work', id);
  const newer = await thread('Newer work', colleague, id);
  put(join(L.threadPart(older, id), 'sims', 'index.html'), 'older page');
  put(join(L.threadPart(newer, id), 'plan.md'), 'newer plan');

  const res = await oddStorage(id);
  assert.deepEqual(
    res.entries.map((e) => e.path),
    ['notes', 'notes/own.md']
  );
  assert.deepEqual(
    res.work.map((w) => [w.title, w.root]),
    [
      ['Newer work', `threads/${newer}/${id}`],
      ['Older work', `threads/${older}/${id}`]
    ]
  );
  assert.deepEqual(res.work.map(files), [
    [`threads/${newer}/${id}/plan.md`],
    [`threads/${older}/${id}/sims/index.html`]
  ]);
  assert.equal((await readStaffFile(id, res.work[1].entries[1].path)).content, 'older page');
  assert.equal(res.capped, false);

  // The route gives the same, with no number in any field the page shows.
  const body = await (await route.GET({ params: { id } } as RouteEvent)).json();
  assert.deepEqual(body.work, res.work);
  for (const w of body.work as { title: string; root: string; entries: unknown[] }[])
    assert.deepEqual(Object.keys(w).sort(), ['entries', 'root', 'title']);
});

test('a closed thread the Odd worked on is still listed, and still opens', async () => {
  const id = await newOdd();
  const t = await thread('Done work', id);
  await L.pg`update threads set status = 'done', ended_at = now() where id = ${t}`;
  put(join(L.threadPart(t, id), 'done.md'), 'finished');
  const { work } = await oddStorage(id);
  assert.deepEqual(work.map(files), [[`threads/${t}/${id}/done.md`]]);
  assert.equal((await readStaffFile(id, `threads/${t}/${id}/done.md`)).content, 'finished');
});

test('a thread folder or a part that is a link is neither listed nor followed, and nor is a link in a part', async () => {
  const id = await newOdd();
  const away = join(outside, 'thread-away');
  put(join(away, id, 'secret.md'));
  const linkedThread = await thread('Linked thread', id);
  mkdirSync(dirname(L.threadFolder(linkedThread)), { recursive: true });
  symlinkSync(away, L.threadFolder(linkedThread));
  const linkedPart = await thread('Linked part', id);
  mkdirSync(L.threadFolder(linkedPart), { recursive: true });
  symlinkSync(join(away, id), L.threadPart(linkedPart, id));
  const real = await thread('Real part', id);
  put(join(L.threadPart(real, id), 'kept.md'));
  symlinkSync(join(away, id, 'secret.md'), join(L.threadPart(real, id), 'pointer.md'));
  symlinkSync(join(away, id), join(L.threadPart(real, id), 'gone'));

  const { work, capped } = await oddStorage(id);
  assert.deepEqual(
    work.map((w) => w.title),
    ['Real part']
  );
  assert.deepEqual(work.map(files), [[`threads/${real}/${id}/kept.md`]]);
  assert.equal(capped, false);
});

test('the folder of threads being a link lists no shared work', async () => {
  const id = await newOdd();
  const t = await thread('Behind a link', id);
  put(join(L.threadPart(t, id), 'kept.md'));
  const threads = L.home('threads');
  const aside = join(outside, 'threads-aside');
  renameSync(threads, aside);
  symlinkSync(aside, threads);
  try {
    assert.deepEqual((await oddStorage(id)).work, []);
  } finally {
    rmSync(threads);
    renameSync(aside, threads);
  }
});

test('hidden and instruction files in a part are not listed, and a part with nothing shown is left out', async () => {
  const id = await newOdd();
  const shown = await thread('Has a file', id);
  const part = L.threadPart(shown, id);
  put(join(part, 'plan.md'));
  put(join(part, '.env'), 'SECRET=1');
  put(join(part, 'CLAUDE.md'));
  put(join(part, '.claude', 'settings.json'));
  put(join(part, 'deep', '.hidden', 'x.md'));
  put(join(part, 'deep', 'AGENTS.md'));
  const empty = await thread('Only hidden', id);
  put(join(L.threadPart(empty, id), '.claude', 'settings.json'));

  const { work } = await oddStorage(id);
  assert.deepEqual(
    work.map((w) => w.title),
    ['Has a file']
  );
  assert.deepEqual(
    work[0].entries.map((e) => e.path),
    [`threads/${shown}/${id}/deep`, `threads/${shown}/${id}/plan.md`]
  );
});

test('a folder with no thread, a part of a thread the Odd is off and an odd folder name are left out, and use none of the cap', async () => {
  const id = await newOdd();
  const colleague = await newOdd();
  const on = await thread('On it', id);
  put(join(L.threadPart(on, id), 'mine.md'));
  // A folder for a thread the office has no row for.
  put(join(L.threadFolder(987654), id, 'orphan.md'));
  // A newer thread it left, its part still on the disk.
  const left = await thread('Left it', colleague);
  for (const n of [1, 2, 3]) put(join(L.threadPart(left, id), `left-${n}.md`));
  // Names a thread's folder never has.
  put(join(L.home('threads', `00${on}`, id), 'zeros.md'));
  put(join(L.home('threads', 'notes', id), 'words.md'));
  put(join(L.home('threads', '99999999999', id), 'big.md'));

  const { work, capped, entries } = await oddStorage(id, 1);
  assert.equal(entries.length, 0);
  assert.deepEqual(work.map(files), [[`threads/${on}/${id}/mine.md`]]);
  assert.equal(capped, false, 'one file fits a cap of one');
});

test("the cap covers an Odd's shared work and its own entries together, shared work first, and says so", async () => {
  const id = await newOdd();
  put(join(L.home('staff', id), 'a.md'));
  put(join(L.home('staff', id), 'b.md'));
  const t = await thread('Shared', id);
  put(join(L.threadPart(t, id), 'one.md'));
  put(join(L.threadPart(t, id), 'two.md'));

  const under = await oddStorage(id, 4);
  assert.equal(under.capped, false, 'own plus shared exactly equal to the cap');
  assert.equal(under.work[0].entries.length, 2);
  assert.equal(under.entries.length, 2);

  // Own over what is left: every shared entry listed, own cut, capped.
  const over = await oddStorage(id, 3);
  assert.equal(over.capped, true);
  assert.deepEqual(over.work.map(files), [
    [`threads/${t}/${id}/one.md`, `threads/${t}/${id}/two.md`]
  ]);
  assert.equal(over.entries.length, 1);

  // Full on shared work alone: stops there, says so, no own entries.
  const full = await oddStorage(id, 1);
  assert.equal(full.capped, true);
  assert.deepEqual(full.work.map(files), [[`threads/${t}/${id}/one.md`]]);
  assert.deepEqual(full.entries, []);
});

test('a folder in shared work uses the cap, so own files get only what is left', async () => {
  const id = await newOdd();
  put(join(L.home('staff', id), 'a.md'));
  put(join(L.home('staff', id), 'b.md'));
  const t = await thread('Shared', id);
  put(join(L.threadPart(t, id), 'm', 'one.md'));

  const { entries, work, capped } = await oddStorage(id, 3);
  assert.deepEqual(work.map(files), [[`threads/${t}/${id}/m/one.md`]]);
  assert.equal(work[0].entries.length, 2, 'the folder is an entry too');
  assert.equal(entries.length, 1);
  assert.equal(capped, true);
});

test('an Odd over the cap on its own folder, with no threads, says it is capped', async () => {
  const id = await newOdd();
  for (const name of ['a.md', 'b.md', 'c.md']) put(join(L.home('staff', id), name));
  const { entries, work, capped } = await oddStorage(id, 2);
  assert.equal(entries.length, 2);
  assert.deepEqual(work, []);
  assert.equal(capped, true);
});

test('an own folder and shared work each under the cap are both complete and not capped', async () => {
  const id = await newOdd();
  put(join(L.home('staff', id), 'a.md'));
  const t = await thread('Shared', id);
  put(join(L.threadPart(t, id), 'one.md'));
  const { entries, work, capped } = await oddStorage(id, 3);
  assert.equal(entries.length, 1);
  assert.deepEqual(work.map(files), [[`threads/${t}/${id}/one.md`]]);
  assert.equal(capped, false);
});

test('the cap counts down across parts, so a later part gets only what is left', async () => {
  const id = await newOdd();
  const older = await thread('Older', id);
  const newer = await thread('Newer', id);
  for (const t of [older, newer])
    for (const name of ['one.md', 'two.md']) put(join(L.threadPart(t, id), name));

  const { work, capped } = await oddStorage(id, 3);
  assert.equal(capped, true);
  assert.deepEqual(work.map(files), [
    [`threads/${newer}/${id}/one.md`, `threads/${newer}/${id}/two.md`],
    [`threads/${older}/${id}/one.md`]
  ]);
});

test('an Odd with an empty own folder and one thread gets its shared work', async () => {
  const id = await newOdd();
  const t = await thread('Only shared', id);
  put(join(L.threadPart(t, id), 'one.md'));
  const { entries, work } = await oddStorage(id);
  assert.deepEqual(entries, []);
  assert.equal(work[0].title, 'Only shared');
});
