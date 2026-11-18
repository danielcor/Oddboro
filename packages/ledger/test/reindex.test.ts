// Ledger search with and without the search model, and the one re-index pass
// once it arrives: every row gets a vector from this model once, a pass the
// office stopped picks up where it left off, and words find rows until it is
// done. A stand-in embed.ts makes each text's vector from its first word.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { ledger } from '../src/schema.ts';
import { db, sql } from './pglite.ts';

const WORDS = ['garden', 'budget', 'dentist', 'laptop', 'flight'];
/** A vector of length 1 that points at the text's first word, if it knows it. */
function vectorFor(text: string): number[] {
  const v = Array(768).fill(0.001);
  const at = WORDS.findIndex((w) => text.toLowerCase().includes(w));
  v[at < 0 ? 767 : at] = 1;
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}

let onDisk = false;
/** The texts the stand-in made a vector for, in order. */
const made: string[] = [];
/** The model stops reading after this many texts, as if the office stopped. */
let stopAfter = Infinity;
const realEmbed = await import('../src/embed.ts');
mock.module('../src/embed.ts', {
  namedExports: {
    ...realEmbed,
    EMBED_MODEL: 'stand-in',
    embed: async (text: string) => {
      if (!onDisk || made.length >= stopAfter) return null;
      made.push(text);
      return vectorFor(text);
    }
  }
});
const realModel = await import('../src/search-model.ts');
mock.module('../src/search-model.ts', {
  namedExports: { ...realModel, modelOnDisk: () => onDisk }
});
const O = await import('../src/office.ts');

const titles = Array.from({ length: 70 }, (_, i) => `${WORDS[i % WORDS.length]} entry ${i}`);
// The rows of an office from before: some with Ollama's vectors, some with none.
await db.insert(ledger).values(
  titles.map((title, i) => ({
    kind: 'decision' as const,
    actor: 'owner',
    title,
    embedding: i % 2 ? vectorFor('flight') : null
  }))
);
const byModel = async () =>
  (
    await sql<{ m: string | null; n: number }>`
    select embedding_model as m, count(*)::int as n from ledger group by 1 order by 1`
  ).map((r) => [r.m, r.n]);

test('with no model, a row is written with no vector and found by its words', async () => {
  await O.record({ kind: 'decision', actor: 'owner', title: 'laptop battery ordered' });
  const [row] = await db.select().from(ledger).where(eq(ledger.title, 'laptop battery ordered'));
  assert.equal(row.embedding, null);
  assert.equal(row.embeddingModel, null);
  const found = await O.searchLedger('battery');
  assert.deepEqual(
    found.map((r) => r.title),
    ['laptop battery ordered']
  );
  assert.equal(await O.reindexLedger(), 0, 'no model, no pass');
  assert.deepEqual(made, []);
});

test('a pass the office stops picks up where it left off, and words find rows meanwhile', async () => {
  onDisk = true;
  stopAfter = 30;
  assert.equal(await O.reindexLedger(), 30);
  assert.deepEqual(await byModel(), [
    ['stand-in', 30],
    [null, 41]
  ]);
  // Until every row has its vector, a search goes by words.
  const before = made.length;
  assert.deepEqual(
    (await O.searchLedger('entry 64')).map((r) => r.title),
    ['flight entry 64']
  );
  assert.equal(made.length, before, 'no query vector while the pass is owed');

  stopAfter = Infinity;
  assert.equal(await O.reindexLedger(), 41);
  assert.deepEqual(await byModel(), [['stand-in', 71]]);
  // Each row once, oldest first.
  assert.equal(made.length, 71);
  assert.equal(new Set(made).size, 71);
  assert.equal(made[0], titles[0]);
  assert.equal(await O.reindexLedger(), 0, 'a second pass has nothing to do');
});

test('once every row has its vector, a search goes by meaning, and a new row has one from the start', async () => {
  await O.record({ kind: 'decision', actor: 'owner', title: 'Garden hose for the roses' });
  const [row] = await db.select().from(ledger).where(eq(ledger.title, 'Garden hose for the roses'));
  assert.equal(row.embeddingModel, 'stand-in');
  // Words would find the garden rows alone; meaning ranks every row, the garden ones first.
  const found = await O.searchLedger('garden', { limit: 100 });
  assert.equal(found.length, 72, 'every row is compared');
  assert.ok(
    found.slice(0, 15).every((r) => /garden/i.test(r.title)),
    'the garden rows first'
  );
  assert.ok(made.includes('garden'), 'the query had a vector');
});
