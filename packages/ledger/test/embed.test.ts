// embed.ts with a stand-in model (stand-in-model.ts): onnxruntime-node runs
// for real, on a small graph pinned the way the real files are, so nothing is
// downloaded. search-model-real.test.ts runs Nomic's own file when it is here.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { standInFiles } from './stand-in-model.ts';

const real = await import('../src/search-model.ts');
const { files, contents } = standInFiles();
mock.module('../src/search-model.ts', {
  namedExports: {
    ...real,
    MODEL_FILES: files,
    modelOnDisk: () =>
      files.every(
        (f) => statSync(join(real.modelDir(), f.name), { throwIfNoEntry: false })?.size === f.bytes
      ),
    mismatched: (dir: string) => real.mismatched(dir, files)
  }
});
const { embed, forgetModel, modelProblem, DIMENSIONS } = await import('../src/embed.ts');

function place(change: (name: string, b: Buffer) => Buffer = (_, b) => b) {
  mkdirSync(real.modelDir(), { recursive: true });
  for (const [name, b] of Object.entries(contents))
    writeFileSync(join(real.modelDir(), name), change(name, Buffer.from(b)));
}

test('with no model there is no vector, and nothing is wrong', async () => {
  assert.equal(await embed('the owner approved the budget', 'document'), null);
  assert.equal(modelProblem(), '');
});

test('a model file that does not match its checksum is refused and removed', async () => {
  // The same size, one byte changed.
  place((name, b) => {
    if (name === 'vocab.txt') b[b.length - 1] ^= 1;
    return b;
  });
  assert.equal(await embed('the owner approved the budget', 'document'), null);
  assert.equal(modelProblem(), 'mismatch');
  assert.ok(!existsSync(real.modelDir()), 'nothing of it is kept');
});

test('a 768-number vector of length 1, the same each time, made in this process', async () => {
  forgetModel();
  place();
  const v = await embed('the owner approved the budget', 'document');
  assert.ok(v);
  assert.equal(v.length, DIMENSIONS);
  assert.ok(v.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9, 'scaled to length 1');
  assert.deepEqual(await embed('the owner approved the budget', 'document'), v, 'the same twice');
  assert.notDeepEqual(
    await embed('the owner approved the budget', 'query'),
    v,
    'a query is told apart'
  );
  assert.notDeepEqual(await embed('garden water', 'document'), v, 'and another text');
  assert.equal(modelProblem(), '');
});
