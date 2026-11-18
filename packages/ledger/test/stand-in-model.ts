// A stand-in for the search model, so tests run onnxruntime-node for real
// without downloading Nomic's 137 MB file. It is a real ONNX graph with the
// same inputs and output: each token id picks a row of 768 numbers from a
// table (Gather), so every token has a vector and embed.ts pools them as it
// pools Nomic's. Written out as protobuf bytes here, with no ONNX library.
import { createHash } from 'node:crypto';
import type { ModelFile } from '../src/search-model.ts';

const DIMENSIONS = 768;

function varint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v ? byte | 0x80 : byte);
  } while (v);
  return out;
}
const field = (n: number, wire: number) => varint((n << 3) | wire);
const int = (n: number, v: number | bigint) => [...field(n, 0), ...varint(v)];
const bytes = (n: number, b: Uint8Array | number[]) => [...field(n, 2), ...varint(b.length), ...b];
const text = (n: number, s: string) => bytes(n, [...Buffer.from(s)]);

const FLOAT = 1;
const INT64 = 7;

/** A tensor's type and shape, each dimension a size or a name. */
function valueInfo(name: string, type: number, dims: (number | string)[]): number[] {
  const shape = dims.flatMap((d) => bytes(1, typeof d === 'number' ? int(1, d) : text(2, d)));
  const tensor = [...int(1, type), ...bytes(2, shape)];
  return [...text(1, name), ...bytes(2, bytes(1, tensor))];
}

/** The ONNX model: [1, n] token ids in, [1, n, 768] out, a row of the table per token. */
export function standInModel(vocabSize: number): Buffer {
  const table = new Float32Array(vocabSize * DIMENSIONS);
  // Numbers that differ from row to row and place to place, the same every run.
  for (let i = 0; i < table.length; i++) table[i] = Math.sin(i * 12.9898) * 0.5;
  const initializer = [
    ...int(1, vocabSize),
    ...int(1, DIMENSIONS),
    ...int(2, FLOAT),
    ...text(8, 'table'),
    ...bytes(9, new Uint8Array(table.buffer))
  ];
  const node = [
    ...text(1, 'table'),
    ...text(1, 'input_ids'),
    ...text(2, 'last_hidden_state'),
    ...text(4, 'Gather')
  ];
  const graph = [
    ...bytes(1, node),
    ...text(2, 'stand-in'),
    ...bytes(5, initializer),
    ...['input_ids', 'token_type_ids', 'attention_mask'].flatMap((name) =>
      bytes(11, valueInfo(name, INT64, [1, 'tokens']))
    ),
    ...bytes(12, valueInfo('last_hidden_state', FLOAT, [1, 'tokens', DIMENSIONS]))
  ];
  const model = [
    ...int(1, 8),
    ...text(2, 'oddboro-test'),
    ...bytes(7, graph),
    ...bytes(8, int(2, 17))
  ];
  return Buffer.from(model);
}

/** A small uncased vocabulary, one piece a line, with BERT's special tokens. */
export const STAND_IN_VOCAB = [
  '[PAD]',
  '[UNK]',
  '[CLS]',
  '[SEP]',
  '[MASK]',
  ':',
  '.',
  'search',
  '_',
  'document',
  'query',
  'the',
  'owner',
  'approved',
  'budget',
  'denver',
  'office',
  'garden',
  'water',
  '##s'
].join('\n');

/** The stand-in's files, pinned as the real ones are. */
export function standInFiles(): { files: ModelFile[]; contents: Record<string, Buffer> } {
  const contents: Record<string, Buffer> = {
    'model_int8.onnx': standInModel(STAND_IN_VOCAB.split('\n').length),
    'vocab.txt': Buffer.from(STAND_IN_VOCAB)
  };
  const files = Object.entries(contents).map(([name, b]) => ({
    name,
    asset: `stand-in-${name}`,
    bytes: b.length,
    sha256: createHash('sha256').update(b).digest('hex')
  }));
  return { files, contents };
}
