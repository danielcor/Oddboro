// The owner's backup: what goes in and what stays out, a round trip that
// brings the database and the files back, the office saved aside first, and
// the files a restore refuses with nothing changed. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { sourceFiles } from './source-files.ts';

const scratch = mkdtempSync(join(tmpdir(), 'oddboro-office-backup-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
// The office's own .env, never the repo's.
process.env.ODDBORO_ENV = join(scratch, 'office.env');
process.env.ODDBORO_VERSION = '1.2.0';
// Use the throwaway home the ledger makes for this test process.
delete process.env.ODDBORO_HOME;
const { home } = await import('../src/home.ts');
const backup = await import('../src/office-backup.ts');
const { header, padding, END, TarReader } = await import('../src/tar.ts');

const write = (path: string, content: string) => {
  mkdirSync(join(home(), path, '..'), { recursive: true });
  writeFileSync(home(path), content);
};

/** The office's database at `<home>/db` holding `word`, from the run's migrated copy when there is one. */
async function database(word: string): Promise<void> {
  const made = process.env.ODDBORO_TEST_DATABASE;
  const db = await PGlite.create(home('db'), {
    extensions: { vector },
    ...(made && !existsSync(home('db', 'PG_VERSION'))
      ? { loadDataDir: new Blob([readFileSync(`${made}.tar`)]) }
      : {})
  });
  await db.exec('create table if not exists kept (word text)');
  await db.exec('delete from kept');
  await db.query('insert into kept values ($1)', [word]);
  await db.close();
}
async function wordIn(): Promise<string> {
  const db = await PGlite.create(home('db'), { extensions: { vector } });
  const { rows } = await db.query<{ word: string }>('select word from kept');
  await db.close();
  return rows.map((r) => r.word).join(',');
}
/** The running office's dump of its database, as `dumpLocalDatabase` gives it. */
async function dump(): Promise<Buffer> {
  const db = await PGlite.create(home('db'), { extensions: { vector } });
  const tar = Buffer.from(await (await db.dumpDataDir('none')).arrayBuffer());
  await db.close();
  return tar;
}
async function makeBackup(): Promise<Buffer> {
  return Buffer.from(await new Response(backupStreamOf(await dump())).arrayBuffer());
}
const backupStreamOf = (tar: Buffer, migrations = 0) =>
  backup.backupStream(tar, migrations) as unknown as ReadableStream;

/** Every path in a gzipped tar, in order, and the manifest. */
function listing(file: Buffer): { paths: string[]; manifest: Record<string, unknown> } {
  const paths: string[] = [];
  const parts: Buffer[] = [];
  const reader = new TarReader({
    entry: (e) => void paths.push(e.path),
    data: (chunk) => void (paths.length === 1 && parts.push(chunk))
  });
  reader.push(gunzipSync(file));
  reader.finish();
  return { paths, manifest: JSON.parse(Buffer.concat(parts).toString('utf8')) };
}

/** A gzipped tar of the given entries, after a manifest of its own. */
function handMade(
  entries: { path: string; data?: string; type?: string }[],
  manifest: Record<string, unknown> = {}
): Buffer {
  const m = Buffer.from(
    JSON.stringify({
      format: 1,
      version: '1.2.0',
      madeAt: '2026-11-14T10:00:00.000Z',
      migrations: 0,
      parts: ['staff'],
      settings: {},
      ...manifest
    })
  );
  const blocks = [
    header({ path: backup.MANIFEST, kind: 'file', size: m.length }),
    m,
    padding(m.length)
  ];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = header({ path: e.path, kind: 'file', size: data.length });
    if (e.type) {
      // Another kind of entry, with its checksum made again.
      h.write(e.type, 156, 'ascii');
      h.write(' '.repeat(8), 148, 'ascii');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    }
    blocks.push(h, data, padding(data.length));
  }
  blocks.push(END);
  return gzipSync(Buffer.concat(blocks));
}

const from = (bytes: Buffer) =>
  (async function* () {
    // In pieces, as a request's body arrives.
    for (let at = 0; at < bytes.length; at += 4096) yield bytes.subarray(at, at + 4096);
  })();

/** Everything in the home a refused restore must leave as it was. */
function snapshot(): string {
  // Node's own walk, since Windows has no `find` like this one.
  return readdirSync(home(), { recursive: true, encoding: 'utf8' })
    .map((name) => name.split(sep).join('/'))
    .filter((name) => !name.startsWith('db/'))
    .sort()
    .join('\n');
}

/** A fresh office: its home emptied, then its folders, sign-ins and settings. */
function office() {
  for (const n of readdirSync(home())) rmSync(home(n), { recursive: true, force: true });
  write('staff/marshall/chat.jsonl', '{"said":"hello"}\n');
  write('staff/marshall/notes/plan.md', 'the plan');
  write(`threads/7/marshall/${'a-long-folder-name/'.repeat(8)}report.md`, 'a long path');
  write('office/last-look.md', 'a look');
  write('office/runs/run-1/scratch.txt', 'scratch');
  write('data/family.md', 'family');
  write('accounts/claude/office/.claude.json', '{"oauth":"secret"}');
  write('mcp/marshall.json', '{"token":"run-token"}');
  write('gemini/oauth_creds.json', '{}');
  write('backups/pre-1.1.0-20261101T010000Z/db/x', 'old');
  write('version', '1.2.0\n');
  writeFileSync(
    process.env.ODDBORO_ENV!,
    'OFFICE_TIME_ZONE=Europe/London\nOFFICE_AGENT=claude\nDATABASE_URL=postgres://u:pw@h/db\nOFFICE_DIAGNOSTICS=yes\n'
  );
  symlinkSync(home('accounts'), home('staff', 'marshall', 'link-to-accounts'));
}

test('a backup holds the database and the office folders, and leaves sign-ins and scratch out', async () => {
  office();
  await database('first');
  const { paths, manifest } = listing(await makeBackup());

  assert.equal(paths[0], backup.MANIFEST);
  for (const p of [
    'db/PG_VERSION',
    'staff/marshall/chat.jsonl',
    'staff/marshall/notes/plan.md',
    `threads/7/marshall/${'a-long-folder-name/'.repeat(8)}report.md`,
    'office/last-look.md',
    'data/family.md'
  ])
    assert.ok(paths.includes(p), `${p} is missing`);
  for (const p of paths)
    assert.match(p, /^(oddboro-backup\.json|db|staff|threads|office|data)(\/|$)/, `${p} is in`);
  assert.ok(!paths.some((p) => p.startsWith('office/runs')), 'a run scratch folder is in');
  assert.ok(!paths.some((p) => p.includes('link-to-accounts')), 'a link is in');
  assert.equal(manifest.version, '1.2.0');
  assert.deepEqual(manifest.parts, ['staff', 'threads', 'office', 'data']);
  assert.deepEqual(manifest.settings, {
    OFFICE_TIME_ZONE: 'Europe/London',
    OFFICE_AGENT: 'claude'
  });
});

test('a restore brings the database and files back, after saving the office as it was', async () => {
  office();
  await database('first');
  const file = await makeBackup();

  // The office moves on after the backup.
  await database('second');
  write('staff/marshall/notes/plan.md', 'a newer plan');
  write('staff/marshall/notes/new.md', 'made after');
  write('project-sessions/s1/inbox/m.json', '{}');
  writeFileSync(process.env.ODDBORO_ENV!, 'OFFICE_TIME_ZONE=Asia/Tokyo\nDATABASE_URL=keep-me\n');

  const manifest = await backup.stageRestore(from(file));
  assert.equal(manifest.version, '1.2.0');
  // Staged only: the office is as it was until it starts again.
  assert.equal(await wordIn(), 'second');
  assert.equal(readFileSync(home('staff/marshall/notes/plan.md'), 'utf8'), 'a newer plan');

  const saved = backup.applyStagedRestore();
  assert.ok(saved && saved.includes('before-restore-'));
  assert.equal(await wordIn(), 'first');
  assert.equal(readFileSync(home('staff/marshall/notes/plan.md'), 'utf8'), 'the plan');
  assert.ok(!existsSync(home('staff/marshall/notes/new.md')));
  assert.ok(!existsSync(home('project-sessions')), 'a part the backup did not hold stays');
  // Sign-ins and everything else left out stay as they are.
  assert.equal(
    readFileSync(home('accounts/claude/office/.claude.json'), 'utf8'),
    '{"oauth":"secret"}'
  );
  assert.equal(readFileSync(home('version'), 'utf8'), '1.2.0\n');
  const env = readFileSync(process.env.ODDBORO_ENV!, 'utf8');
  assert.match(env, /OFFICE_TIME_ZONE=Europe\/London/);
  assert.match(env, /OFFICE_AGENT=claude/);
  assert.match(env, /DATABASE_URL=keep-me/);

  // The office as it was before, whole.
  assert.equal(readFileSync(join(saved, 'staff/marshall/notes/new.md'), 'utf8'), 'made after');
  assert.equal(readFileSync(join(saved, 'project-sessions/s1/inbox/m.json'), 'utf8'), '{}');
  assert.match(readFileSync(join(saved, '.env'), 'utf8'), /Asia\/Tokyo/);
  assert.ok(existsSync(join(saved, 'db', 'PG_VERSION')));
  assert.ok(!existsSync(home('restore')));
  assert.deepEqual(backup.lastRestore()?.savedAside, saved);
  // Nothing waits for the next start.
  assert.equal(backup.applyStagedRestore(), undefined);
});

test('a restore cut off halfway finishes at the next start', async () => {
  office();
  await database('first');
  const file = await makeBackup();
  await database('second');
  await backup.stageRestore(from(file));
  // As if the office stopped right after moving the staff folder in.
  rmSync(home('staff'), { recursive: true, force: true });
  const { renameSync } = await import('node:fs');
  renameSync(home('restore', 'staff'), home('staff'));

  backup.applyStagedRestore();
  assert.equal(await wordIn(), 'first');
  assert.equal(readFileSync(home('staff/marshall/notes/plan.md'), 'utf8'), 'the plan');
});

test('a file that is not a backup, a damaged one, a newer one, and one reaching outside are refused with nothing changed', async () => {
  office();
  await database('first');
  const good = await makeBackup();
  const before = snapshot();
  const cases: [string, Buffer, RegExp][] = [
    ['plain text', Buffer.from('hello, this is not a backup'), /not an Oddboro backup/],
    ['cut in half', good.subarray(0, Math.floor(good.length / 2)), /damaged/],
    [
      'a byte changed',
      Buffer.from(good.map((b, i) => (i === Math.floor(good.length / 2) ? b ^ 0xff : b))),
      /damaged/
    ],
    ['a newer version', handMade([], { version: '1.3.0' }), /newer version/],
    ['a newer format', handMade([], { format: 2 }), /newer version/],
    ['a newer database', handMade([], { migrations: 99_999_999_999_999 }), /newer version/],
    [
      'a path with ..',
      handMade([{ path: 'staff/../../evil.txt', data: 'x' }]),
      /not an Oddboro backup/
    ],
    ['a full path', handMade([{ path: '/tmp/evil.txt', data: 'x' }]), /not an Oddboro backup/],
    ['a sign-in', handMade([{ path: 'accounts/claude/x', data: 'x' }]), /not an Oddboro backup/],
    ['a link', handMade([{ path: 'staff/link', type: '2' }]), /not an Oddboro backup/],
    ['a hard link', handMade([{ path: 'staff/link', type: '1' }]), /not an Oddboro backup/],
    ['no database', handMade([{ path: 'staff/a.md', data: 'x' }]), /not an Oddboro backup/]
  ];
  for (const [name, bytes, why] of cases) {
    await assert.rejects(backup.stageRestore(from(bytes)), why, name);
    assert.equal(snapshot(), before, `${name} changed the home`);
    assert.ok(!readdirSync(home()).some((n) => n.startsWith('.restore-') || n === 'restore'), name);
  }
  assert.ok(!existsSync(join(home(), '..', 'evil.txt')));
  assert.equal(await wordIn(), 'first');
});

test('every name the office writes at the top of its home is backed up or left out on purpose', () => {
  const known = new Set<string>([
    'db',
    ...backup.BACKED_UP,
    ...Object.keys(backup.LEFT_OUT),
    // The home itself and what accounts.ts builds from accountsHome().
    ''
  ]);
  const found = new Map<string, string>();
  const seen = new Set<string>();
  for (const f of sourceFiles())
    for (const m of f.ast.text.matchAll(/\bhome\(\s*'([^']+)'/g)) {
      seen.add(m[1]);
      if (!known.has(m[1])) found.set(m[1], f.path);
    }
  // The search itself finds the names it should.
  for (const n of ['staff', 'db', 'mcp', 'backups'])
    assert.ok(seen.has(n), `found no home('${n}')`);
  assert.deepEqual([...found], [], 'name each in BACKED_UP or LEFT_OUT in office-backup.ts');
});
