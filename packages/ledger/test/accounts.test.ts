// Accounts: each tool's Office account and the ones the owner adds. Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { staff } from '../src/schema.ts';
import { db } from './pglite.ts';

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'accounts-')));
process.env.HOME = HOME;
process.env.ODDBORO_HOME = join(HOME, '.oddboro');
after(() => rmSync(HOME, { recursive: true, force: true }));
const A = await import('../src/accounts.ts');
const { chatSession, home } = await import('../src/home.ts');

const odd = (id: string, agent: 'claude' | 'grok' | 'codex') => ({
  id,
  name: id,
  role: 'r',
  variant: 'v',
  portrait: 'p',
  remit: 'r',
  desk: 'd',
  agent
});
await db.insert(staff).values([odd('gus', 'grok'), odd('cody', 'codex'), odd('cleo', 'claude')]);
const session = (id: string) => {
  mkdirSync(home('staff', id), { recursive: true });
  writeFileSync(chatSession(id), '{"sessionId":"old"}');
};

test("an office made before accounts keeps its Grok and Codex sign-ins: each home becomes its tool's Office account, moved whole, and their Odds start new sessions", async () => {
  for (const tool of ['grok', 'codex']) {
    mkdirSync(home(tool), { recursive: true });
    writeFileSync(join(home(tool), 'auth.json'), `{"${tool}":true}`);
  }
  ['gus', 'cody', 'cleo'].forEach(session);
  // Before the move, a run still finds the old home.
  assert.equal(A.toolHome('grok', 'office'), home('grok'));
  await A.moveToolHomes();
  for (const tool of ['grok', 'codex'] as const) {
    assert.ok(!existsSync(home(tool)), `${tool}'s old home is still there`);
    const office = join(home('accounts', tool, 'office'));
    assert.equal(readFileSync(join(office, 'auth.json'), 'utf8'), `{"${tool}":true}`);
    assert.equal(A.toolHome(tool, 'office'), office);
  }
  assert.ok(!existsSync(chatSession('gus')) && !existsSync(chatSession('cody')));
  // Claude Code's sessions were never in those homes.
  assert.ok(existsSync(chatSession('cleo')));
  // Once moved, it is left alone.
  await A.moveToolHomes();
  assert.ok(existsSync(join(home('accounts', 'grok', 'office'), 'auth.json')));
});

test("an Odd moves to one of its own tool's accounts, never another tool's, with a new session; removing an account sends its Odds back to Office", async () => {
  const work = await A.addAccount('grok', 'Work');
  const other = await A.addAccount('codex', 'Other');
  assert.ok(existsSync(home('accounts', 'grok', work.id)));
  await assert.rejects(A.addAccount('grok', '   '), /Name the account/);
  session('gus');
  assert.equal(await A.setAccount('gus', work.id), undefined);
  assert.ok(!existsSync(chatSession('gus')), 'the session the old account made would not resume');
  assert.equal(await A.accountOf({ agent: 'grok', account: work.id }), work.id);
  assert.deepEqual(await A.setAccount('gus', other.id), {
    refused: "That is not one of Grok's accounts"
  });
  // An account kept from another tool counts as Office.
  assert.equal(await A.accountOf({ agent: 'claude', account: work.id }), 'office');
  await A.removeAccount(work.id);
  const [gus] = await db
    .select()
    .from(staff)
    .where((await import('drizzle-orm')).eq(staff.id, 'gus'));
  assert.equal(gus.account, null);
  assert.ok(!existsSync(home('accounts', 'grok', work.id)));
  await A.removeAccount(other.id);
});

test('an added account can be renamed, never to nothing', async () => {
  const a = await A.addAccount('codex', 'Work');
  assert.equal((await A.renameAccount(a.id, '  Personal  ')).label, 'Personal');
  assert.equal((await A.account(a.id))?.label, 'Personal');
  await assert.rejects(A.renameAccount(a.id, '   '), /Name the account/);
  await assert.rejects(A.renameAccount('nope', 'X'), /No such account/);
  await A.removeAccount(a.id);
});
