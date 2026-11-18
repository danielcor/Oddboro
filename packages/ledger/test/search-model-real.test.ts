// Nomic's own model, the file the office downloads, when a folder holding it
// is named in ODDBORO_TEST_SEARCH_MODEL (its model_int8.onnx and vocab.txt).
// Skipped otherwise, as in CI: no test downloads 137 MB.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { embed } from '../src/embed.ts';
import { MODEL_FILES, modelDir } from '../src/search-model.ts';

const from = process.env.ODDBORO_TEST_SEARCH_MODEL;
const here = !!from && MODEL_FILES.every((f) => existsSync(join(from, f.name)));

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

test('the real model finds a ledger entry by its meaning', { skip: !here }, async () => {
  mkdirSync(modelDir(), { recursive: true });
  for (const f of MODEL_FILES) symlinkSync(join(from!, f.name), join(modelDir(), f.name));
  const entries = [
    'Approved the quarterly budget for the Denver office, with travel cut by a third.',
    'Moved the dentist appointment for the kids to Tuesday at 4 pm.',
    'Chose Postgres over SQLite for the customer database because of concurrent writes.'
  ];
  const vectors = await Promise.all(entries.map((e) => embed(e, 'document')));
  for (const v of vectors) {
    assert.ok(v);
    assert.equal(v.length, 768);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  }
  const q = await embed("when is the children's dental visit?", 'query');
  assert.ok(q);
  const scores = vectors.map((v) => dot(q, v!));
  assert.equal(scores.indexOf(Math.max(...scores)), 1);
  assert.deepEqual(await embed(entries[0], 'document'), vectors[0], 'the same vector twice');
});
