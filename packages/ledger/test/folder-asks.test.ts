// An Odd asks for a folder on this computer with ask_for_folder, and the owner
// gives it from the ask's card. The tool checks the folder as the Settings tab
// does, in the tool server's own process, as the office starts one for each
// run; the owner's Give access gives it through the same change as the
// Settings tab, and only then approves the ask. Two runs asking for one folder
// are twins, as access asks are. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { onThisDisk, STORE_STATES, TEMP_IN_APPDATA } from './store-states.ts';
import { db, sql, toolServer } from './tool-server.ts';

// A home of the test's own, for this process and the tool server's, so a
// folder in it can be given and is shown as ~/...
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'folder-asks-')));
process.env.HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const { asks, followUps, ledger, staff } = await import('../src/schema.ts');
const { eq } = await import('drizzle-orm');
const O = await import('../src/office.ts');

/** Makes a folder under the test's home, and gives back its path. */
function folder(...parts: string[]): string {
  const p = join(HOME, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}
const taxes = folder('Documents', 'Taxes');
const receipts = folder('Documents', 'Taxes', '2026');
folder('.ssh');

await db.insert(staff).values({
  id: 'theo',
  name: 'Theo',
  role: 'Bookkeeper',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft',
  desk: 'You are Theo.'
});

beforeEach(async () => {
  await sql`delete from ledger`;
  await sql`delete from follow_ups`;
  await sql`delete from asks`;
  await db.update(staff).set({ folders: [] }).where(eq(staff.id, 'theo'));
});

/** The first text a tool call returned, and whether it was an error. */
async function call(c: Client, args: Record<string, unknown>) {
  const r = await c.callTool({ name: 'ask_for_folder', arguments: args });
  return {
    text: (r.content as { text: string }[])[0]?.text ?? '',
    error: r.isError === true
  };
}
const theo = (run: string, env: Record<string, string> = {}) =>
  toolServer('theo', { RUN_KEY: run, HOME, ...env });
const folderAsks = () => db.select().from(asks).where(eq(asks.kind, 'folder'));
const row = async (id: number) => (await db.select().from(asks).where(eq(asks.id, id)))[0];
const folders = async () => (await db.select().from(staff).where(eq(staff.id, 'theo')))[0].folders;
const raise = (level: 'read' | 'write', place: { handOffId?: number } = {}) =>
  O.raiseAsk('theo', {
    kind: 'folder',
    title: `Read ${level}`,
    why: 'For the tax return.',
    ifApproved: 'i',
    folder: { path: taxes, level },
    ...place
  }).then((r) => r.ask);

test(
  'the tool refuses a missing, a refused and an already-held folder in the Settings tab words, and puts nothing on the desk',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const c = await theo('k-refuse');
    const missing = await call(c, { path: '~/Nowhere', level: 'read', why: 'w' });
    assert.ok(missing.error && missing.text.endsWith(O.FOLDER_REFUSED.missing), missing.text);
    const home = await call(c, { path: '~', level: 'read', why: 'w' });
    assert.ok(home.error && home.text.endsWith(O.FOLDER_REFUSED.home), home.text);
    const keys = await call(c, { path: '~/.ssh', level: 'read', why: 'w' });
    assert.ok(keys.error && keys.text.endsWith(O.FOLDER_REFUSED.secrets), keys.text);
    const relative = await call(c, { path: 'Documents', level: 'read', why: 'w' });
    assert.ok(relative.error, relative.text);

    await db
      .update(staff)
      .set({ folders: [{ path: taxes, write: true }] })
      .where(eq(staff.id, 'theo'));
    const held = await call(c, { path: '~/Documents/Taxes/2026', level: 'write', why: 'w' });
    assert.ok(held.error && held.text.includes('You already have ~/Documents/Taxes'), held.text);
    assert.deepEqual(await folderAsks(), []);
  }
);

test(
  'the tool refuses a folder the owner could not give beside one the Odd has',
  { skip: TEMP_IN_APPDATA },
  async () => {
    await db
      .update(staff)
      .set({ folders: [{ path: receipts, write: false }] })
      .where(eq(staff.id, 'theo'));
    const r = await call(await theo('k-nested'), {
      path: taxes,
      level: 'write',
      why: 'w'
    });
    assert.ok(r.error && r.text.endsWith(O.FOLDER_REFUSED.readInsideChange), r.text);
    assert.deepEqual(await folderAsks(), []);
  }
);

test(
  'an Odd may ask to change a folder inside one it may read, and the yes gives it beside that one',
  { skip: TEMP_IN_APPDATA },
  async () => {
    await db
      .update(staff)
      .set({ folders: [{ path: taxes, write: false }] })
      .where(eq(staff.id, 'theo'));
    const c = await theo('k-inner');
    const r = await call(c, { path: receipts, level: 'write', why: 'w' });
    assert.ok(!r.error, r.text);
    const [a] = await folderAsks();
    assert.deepEqual(await O.giveFolder(a.id, receipts, 'write'), {
      given: { path: receipts, level: 'write' }
    });
    assert.deepEqual(await folders(), [
      { path: taxes, write: false },
      { path: receipts, write: true }
    ]);
    // Read only inside it stays covered by the folder it already reads.
    const covered = await call(c, { path: receipts, level: 'read', why: 'w' });
    assert.ok(covered.error && covered.text.includes('You already have'), covered.text);
  }
);

test(
  'the tool raises one folder ask with the real path, and refuses a repeat from the same place',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const c = await theo('k-raise');
    const r = await call(c, { path: '~/Documents/Taxes/', level: 'read', why: 'For the return.' });
    assert.ok(!r.error, r.text);
    const [a] = await folderAsks();
    assert.deepEqual(a.folder, { path: taxes, level: 'read' });
    assert.equal(a.title, 'Read ~/Documents/Taxes');
    const again = await call(c, { path: taxes, level: 'read', why: 'w' });
    assert.ok(again.error && again.text.includes(`revises: ${a.id}`), again.text);
    assert.equal((await folderAsks()).length, 1);
  }
);

test(
  'Give access gives the folder with one ledger line, approves the ask and starts the run that needs it',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const a = await raise('write');
    const done = await O.giveFolder(a.id, '~/Documents/Taxes', 'write');
    assert.deepEqual(done, { given: { path: taxes, level: 'write' } });
    assert.deepEqual(await folders(), [{ path: taxes, write: true }]);
    const approved = await row(a.id);
    assert.equal(approved.status, 'approved');
    assert.deepEqual(approved.folder?.given, { path: taxes, level: 'write' });
    const lines = await db.select().from(ledger);
    assert.deepEqual(
      lines.map((l) => l.title),
      ['Let Theo read and change ~/Documents/Taxes']
    );
    const runs = await db.select().from(followUps);
    assert.deepEqual(
      runs.map((f) => [f.kind, f.askId]),
      [['carry_out', a.id]]
    );
    assert.deepEqual(await O.giveFolder(a.id, taxes, 'write'), {
      refused: 'You already answered this ask.',
      status: 409
    });
  }
);

test(
  'the owner narrows the folder and the level before giving it',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const a = await raise('write');
    await O.giveFolder(a.id, receipts, 'read');
    assert.deepEqual(await folders(), [{ path: receipts, write: false }]);
    assert.deepEqual((await row(a.id)).folder, {
      path: taxes,
      level: 'write',
      given: { path: receipts, level: 'read' }
    });
  }
);

test(
  'a folder the Settings tab would refuse leaves the ask open and gives nothing',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const a = await raise('read');
    const home = await O.giveFolder(a.id, HOME, 'read');
    assert.deepEqual(home, { refused: O.FOLDER_REFUSED.home, status: 400 });
    await db
      .update(staff)
      .set({ folders: [{ path: receipts, write: false }] })
      .where(eq(staff.id, 'theo'));
    const nested = await O.giveFolder(a.id, taxes, 'write');
    assert.deepEqual(nested, { refused: O.FOLDER_REFUSED.readInsideChange, status: 400 });
    assert.equal((await row(a.id)).status, 'open');
    assert.deepEqual(await folders(), [{ path: receipts, write: false }]);
    assert.deepEqual(await db.select().from(ledger), []);
  }
);

test('a plain approve is refused', async () => {
  const a = await raise('read');
  await assert.rejects(O.decideAsk(a.id, 'approve', null), /Give the folder/);
  assert.equal((await row(a.id)).status, 'open');
  assert.deepEqual(await folders(), []);
});

test(
  'two runs asking for one folder are twins: the desk shows the first, and giving it answers both',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const first = await raise('write');
    const twin = await raise('read', { handOffId: 7 });
    const shown = (await O.desk()).asks.map((x) => x.id);
    assert.ok(shown.includes(first.id) && !shown.includes(twin.id), 'the twin waits behind it');
    await O.giveFolder(first.id, taxes, 'write');
    assert.equal((await row(twin.id)).status, 'approved');
    const runs = await db.select().from(followUps);
    assert.deepEqual(
      runs.map((f) => f.askId),
      [twin.id],
      'one run, the hand-off twin, does the work'
    );
  }
);

test('an ask for more than the first is no twin', async () => {
  const read = await raise('read');
  const write = await raise('write', { handOffId: 8 });
  const shown = (await O.desk()).asks.map((x) => x.id);
  assert.ok(shown.includes(read.id) && shown.includes(write.id));
});

test('Deny and Iterate work as for any ask', async () => {
  const a = await raise('read');
  await O.decideAsk(a.id, 'deny', 'Not that folder.');
  assert.equal((await row(a.id)).status, 'denied');
  assert.deepEqual(await folders(), []);
  const b = await raise('read');
  await O.decideAsk(b.id, 'iterate', 'Only the 2026 folder.');
  assert.equal((await row(b.id)).status, 'revise');
  const runs = await db.select().from(followUps);
  assert.deepEqual(
    runs.map((f) => [f.kind, f.askId]),
    [
      ['denied', a.id],
      ['rework', b.id]
    ]
  );
});

/** A folder outside the test's home, under the system's temp folder: system files on a Mac and Linux. */
function outside(): string {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'folder-asks-out-')));
  after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}

test(
  'the tool refuses a whole drive or system files: only the owner may give one',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const r = await call(await theo('k-broad'), { path: outside(), level: 'read', why: 'w' });
    assert.ok(r.error && r.text.endsWith(O.FOLDER_REFUSED.broad), r.text);
    assert.deepEqual(await folderAsks(), []);
  }
);

test(
  'giving a whole drive or system files warns and changes nothing, and the Accept gives it',
  { skip: TEMP_IN_APPDATA },
  async () => {
    const a = await raise('read');
    const out = outside();
    assert.deepEqual(await O.giveFolder(a.id, out, 'read'), { warning: O.FOLDER_WARNING });
    assert.equal((await row(a.id)).status, 'open');
    assert.deepEqual(await folders(), []);
    assert.deepEqual(await db.select().from(ledger), []);
    assert.deepEqual(await O.giveFolder(a.id, out, 'read', null, true), {
      given: { path: out, level: 'read' }
    });
    assert.deepEqual(await folders(), [{ path: out, write: false }]);
  }
);

// One tool server per place, so the table fits under the suite's limit. Each
// row clears the desk first, since two rows ask for the same folder.
for (const where of ['in the home', 'outside the home'] as const)
  test(
    `the tool answers every state of a secret store as the Settings tab does, ${where}`,
    { skip: TEMP_IN_APPDATA },
    async (t) => {
      const c = await theo(`k-states-${where}`);
      for (const s of STORE_STATES.filter((row) => onThisDisk(row) && !row.homeOnly))
        await t.test(s.state, async () => {
          await sql`delete from asks`;
          const p = s.make(where === 'in the home' ? HOME : outside(), HOME);
          const r = await call(c, { path: p, level: 'read', why: 'w' });
          // A temp folder holds no store, and is system files on a Mac and Linux.
          const refusal = s.refused
            ? O.FOLDER_REFUSED.secrets
            : where === 'outside the home' && O.FOLDER_REFUSED.broad;
          if (refusal) {
            assert.ok(r.error && r.text.endsWith(refusal), r.text);
            assert.deepEqual(await folderAsks(), []);
          } else {
            assert.ok(!r.error, r.text);
            assert.deepEqual(
              (await folderAsks()).map((a) => a.folder),
              [{ path: p, level: 'read' }]
            );
          }
        });
    }
  );

/**
 * A stored folder and what is asked for beside it, under the row's own folder.
 * `store`, when set, is the folder holding keys that keeps a run from `has`.
 * `ask` and `give` are the refusals, left out when the Odd can have the folder.
 */
type StoredState = {
  state: string;
  has: string;
  store?: string;
  /** The owner clicked Remove on `has` first. */
  removed?: true;
  asked: string;
  ask?: 'secrets' | 'covered' | 'nested';
  give?: 'secrets' | 'nested';
};
const STORED_STATES: StoredState[] = [
  {
    state: 'a clean subfolder of a folder dropped for holding a store can be had',
    has: 'proj',
    store: 'proj/.kube',
    asked: 'proj/src'
  },
  {
    state: 'the dropped folder itself is still refused for holding keys',
    has: 'proj',
    store: 'proj/.kube',
    asked: 'proj',
    ask: 'secrets',
    give: 'secrets'
  },
  {
    state:
      'a subfolder of an ordinary stored folder is still covered for an ask, and the owner can give it',
    has: 'proj',
    asked: 'proj/src',
    ask: 'covered'
  },
  {
    state: 'a folder holding an ordinary stored folder can be had, both to read',
    has: 'proj/pkg',
    asked: 'proj'
  },
  {
    state: 'a folder holding a dropped child is refused nested',
    has: 'proj/pkg',
    store: 'proj/pkg/.kube',
    asked: 'proj',
    ask: 'nested',
    give: 'nested'
  },
  {
    state: 'a folder that held a dropped child can be had after Remove',
    has: 'proj/pkg',
    store: 'proj/pkg/.kube',
    removed: true,
    asked: 'proj'
  },
  {
    state: 'a clean subfolder of a dropped folder can be had after Remove, as before',
    has: 'proj',
    store: 'proj/.kube',
    removed: true,
    asked: 'proj/src'
  }
];

test(
  "a stored folder no run gets counts only against a folder that would hold it, for an Odd's asks and the owner's gives",
  { skip: TEMP_IN_APPDATA },
  async (t) => {
    const c = await theo('k-stored');
    for (const [i, s] of STORED_STATES.entries()) {
      const at = (p: string) => folder(`stored-${i}`, p);
      const asked = at(s.asked);
      const refusal = {
        secrets: O.FOLDER_REFUSED.secrets,
        nested: O.FOLDER_REFUSED.nested,
        covered: `You already have ${O.shownFolder(at(s.has))}`
      };
      const place = async () => {
        if (s.store) writeFileSync(join(at(s.store), 'config'), '');
        await sql`delete from asks`;
        await db
          .update(staff)
          .set({ folders: [{ path: at(s.has), write: false }] })
          .where(eq(staff.id, 'theo'));
        if (s.removed) {
          await O.setFolder('theo', at(s.has), null);
          assert.deepEqual(await folders(), []);
        }
      };
      await t.test(`${s.state}: as an ask`, async () => {
        await place();
        const r = await call(c, { path: asked, level: 'read', why: 'w' });
        if (s.ask) {
          assert.ok(r.error && r.text.includes(refusal[s.ask]), r.text);
          assert.deepEqual(await folderAsks(), []);
        } else {
          assert.ok(!r.error, r.text);
          const [a] = await folderAsks();
          assert.deepEqual(await O.giveFolder(a.id, asked, 'read'), {
            given: { path: asked, level: 'read' }
          });
        }
      });
      await t.test(`${s.state}: as the owner's give`, async () => {
        await place();
        const done = await O.setFolder('theo', asked, 'read');
        if (s.give) {
          assert.deepEqual(done, { refused: refusal[s.give] });
          assert.deepEqual(await folders(), [{ path: at(s.has), write: false }]);
        } else {
          assert.equal(done, undefined);
          assert.ok((await folders()).some((f) => f.path === asked));
        }
      });
    }
  }
);
