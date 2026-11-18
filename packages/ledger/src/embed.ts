// Turns text into a vector inside this process, with the search model the
// owner downloaded in Setup (search-model.ts), so nothing written to the ledger
// or searched for leaves the computer. The model loads once per process, on the
// first text, after its files pass their checksums. Returns null when the model
// is not there, cannot run on this computer, or fails: the row is still
// written and found by its words.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InferenceSession, Tensor } from 'onnxruntime-node';
import {
  mismatched,
  modelDir,
  modelOnDisk,
  MODEL_ID,
  removeModel,
  RUNS_HERE
} from './search-model.ts';
import { wordpiece, type Tokenizer } from './wordpiece.ts';

export { MODEL_ID as EMBED_MODEL };
/** Every vector has this many numbers, the size of the ledger's column. */
export const DIMENSIONS = 768;
/**
 * The most tokens a text is read to, as the office read it before (Ollama's
 * context). Nomic reads up to 8192, but the time grows faster than the text,
 * and a ledger row is short.
 */
const MAX_TOKENS = 2048;

type Model = { session: InferenceSession; tokenizer: Tokenizer; Tensor: typeof Tensor };

/** Why this process could not load the model, for Setup. Empty while it has not failed. */
let failed: '' | 'mismatch' | 'cannot-run' = '';
let loading: Promise<Model | null> | undefined;

export const modelProblem = (): typeof failed => failed;

/** Forget the loaded model and any failure, after a new download. */
export function forgetModel(): void {
  loading = undefined;
  failed = '';
}

async function load(): Promise<Model | null> {
  if (!RUNS_HERE) {
    failed = 'cannot-run';
    return null;
  }
  // A file that changed since the download is refused and removed, so Setup
  // offers the download again.
  if ((await mismatched(modelDir()).catch(() => ['unreadable'])).length) {
    removeModel();
    failed = 'mismatch';
    return null;
  }
  try {
    const ort = await import('onnxruntime-node');
    const [vocab, session] = await Promise.all([
      readFile(join(modelDir(), 'vocab.txt'), 'utf8'),
      // The arena keeps every buffer it ever took. Without it, memory goes back between texts.
      ort.InferenceSession.create(join(modelDir(), 'model_int8.onnx'), {
        enableCpuMemArena: false
      })
    ]);
    return { session, tokenizer: wordpiece(vocab), Tensor: ort.Tensor };
  } catch (e) {
    console.error('office: the search model would not load:', e);
    failed = 'cannot-run';
    return null;
  }
}

/** The model, loaded on first use. Null until it is downloaded, and when it cannot load. */
function model(): Promise<Model | null> {
  if (loading) return loading;
  if (!modelOnDisk()) return Promise.resolve(null);
  loading = load();
  return loading;
}

/** Whether the model is here and loads, loading it if this process has not yet. */
export async function modelReady(): Promise<boolean> {
  return !!(await model());
}

/**
 * Nomic's own recipe: the mean of every token's vector, then layer norm, then
 * scaled to length 1. `hidden` holds `tokens` rows of DIMENSIONS numbers.
 */
export function pool(hidden: ArrayLike<number>, tokens: number): number[] {
  const mean = new Float64Array(DIMENSIONS);
  for (let t = 0; t < tokens; t++)
    for (let d = 0; d < DIMENSIONS; d++) mean[d] += hidden[t * DIMENSIONS + d];
  let avg = 0;
  for (let d = 0; d < DIMENSIONS; d++) avg += mean[d] /= tokens;
  avg /= DIMENSIONS;
  let variance = 0;
  for (let d = 0; d < DIMENSIONS; d++) variance += (mean[d] - avg) ** 2;
  const sd = Math.sqrt(variance / DIMENSIONS + 1e-5);
  const normed = Array.from(mean, (x) => (x - avg) / sd);
  const length = Math.hypot(...normed);
  return normed.map((x) => x / length);
}

/** `document` for text being stored, `query` for text being searched with. */
export async function embed(text: string, as: 'document' | 'query'): Promise<number[] | null> {
  const m = await model();
  if (!m) return null;
  try {
    const ids = m.tokenizer.encode(`search_${as}: ${text}`, MAX_TOKENS);
    const tensor = (fill: (id: number) => number) =>
      new m.Tensor(
        'int64',
        BigInt64Array.from(ids, (id) => BigInt(fill(id))),
        [1, ids.length]
      );
    const out = await m.session.run({
      input_ids: tensor((id) => id),
      token_type_ids: tensor(() => 0),
      attention_mask: tensor(() => 1)
    });
    const hidden = out[m.session.outputNames[0]];
    // Any other size would not fit the column, and a NaN would match nothing.
    if (hidden.dims.at(-1) !== DIMENSIONS || hidden.data.length !== ids.length * DIMENSIONS)
      return null;
    const v = pool(hidden.data as Float32Array, ids.length);
    return v.every(Number.isFinite) ? v : null;
  } catch (e) {
    console.error('office: the search model could not read a text:', e);
    return null;
  }
}
