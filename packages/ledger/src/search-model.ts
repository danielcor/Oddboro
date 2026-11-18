// The model that lets Odds search the ledger by meaning: Nomic Embed Text
// v1.5, compressed to int8, run inside the office. Nothing comes with the
// office. The owner downloads it from Setup, once, and the office keeps it in
// its home under models/. The files come from Oddboro's own GitHub release,
// each pinned to its size and SHA-256, so a changed or broken file is
// refused, never used. Imports no db.ts, so setup's checks can read it.
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fixedError, isFixedError } from './errors.ts';
import { home } from './home.ts';
import { currentPlatform } from './platform.ts';

/**
 * Where the files come from. They are Hugging Face's nomic-ai/nomic-embed-text-v1.5
 * at revision e9b6763023c676ca8431644204f50c2b100d9aab (onnx/model_int8.onnx
 * and vocab.txt), published unchanged on a pre-release of Oddboro's own.
 */
export const RELEASE = 'https://github.com/New-Altitude/Oddboro/releases/download/models-v1/';

/** The hosts a download may go to: GitHub, and the hosts it sends release files from. */
export const DOWNLOAD_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
];

/** The most redirects one file may take. */
const MAX_REDIRECTS = 5;

export type ModelFile = { name: string; asset: string; bytes: number; sha256: string };

/** Each file the office needs, its name on the release, its size and its SHA-256. */
export const MODEL_FILES: readonly ModelFile[] = [
  {
    name: 'model_int8.onnx',
    asset: 'nomic-embed-text-v1.5-int8.onnx',
    bytes: 137_296_292,
    sha256: 'b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27'
  },
  {
    name: 'vocab.txt',
    asset: 'nomic-embed-text-v1.5-vocab.txt',
    bytes: 231_508,
    sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3'
  }
];

/**
 * Which model made a vector, kept on each ledger row beside it. A row with
 * another value, or none, is one the re-index makes again. It names the
 * Hugging Face revision the files came from, and stays the same while they do.
 */
export const MODEL_ID = 'nomic-embed-text-v1.5:int8:e9b67630';

/** The download's size, as Setup's button says it: "about 140 MB". */
export const MODEL_MB = Math.round(MODEL_FILES.reduce((n, f) => n + f.bytes, 0) / 10_000_000) * 10;

/** The systems onnxruntime-node has a build for. An Intel Mac is not one. */
const RUNNERS = ['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
export const RUNS_HERE = RUNNERS.includes(`${currentPlatform()}-${process.arch}`);

/** The folder the model lives in. */
export const modelDir = (): string => home('models', 'nomic-embed-text-v1.5');

/** Every file is there at its full size. The checksums are read when the model loads. */
export function modelOnDisk(): boolean {
  return MODEL_FILES.every((f) => {
    const s = statSync(join(modelDir(), f.name), { throwIfNoEntry: false });
    return s?.isFile() && s.size === f.bytes;
  });
}

/** A file's SHA-256, read in pieces so the whole file is never held at once. */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The pinned files whose SHA-256 differs from the one in `dir`. */
export async function mismatched(
  dir: string,
  files: readonly ModelFile[] = MODEL_FILES
): Promise<string[]> {
  const bad: string[] = [];
  for (const f of files) if ((await sha256Of(join(dir, f.name))) !== f.sha256) bad.push(f.name);
  return bad;
}

/** Takes the model away, so Setup offers the download again. */
export function removeModel(): void {
  rmSync(modelDir(), { recursive: true, force: true });
}

const PARTIAL = '.download-';
let downloading: Promise<void> | undefined;

/** True while a download runs in this process. */
export const isDownloading = (): boolean => !!downloading;

/** Fetches one URL. `fetch` itself, or the network a test stands in. */
export type FetchUrl = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * Download every file into a folder of its own beside the model's, check each
 * one's size and SHA-256 as it arrives, then move the folder into place in one
 * step. Anything that goes wrong removes that folder, so the office never has
 * half a model. One download runs at a time; a second call waits on the first.
 * `fetchUrl` stands in for the network in a test.
 */
export function downloadModel(
  files: readonly ModelFile[] = MODEL_FILES,
  fetchUrl: FetchUrl = (url, init) => fetch(url, init)
): Promise<void> {
  downloading ??= fetchAll(files, fetchUrl).finally(() => (downloading = undefined));
  return downloading;
}

/**
 * One file from the release. GitHub answers with a redirect to the host that
 * keeps its files. The office follows a redirect only over HTTPS to GitHub's
 * own hosts (`DOWNLOAD_HOSTS`), and refuses one anywhere else.
 */
async function fromRelease(f: ModelFile, fetchUrl: FetchUrl): Promise<Response> {
  const signal = AbortSignal.timeout(30 * 60_000);
  let url = new URL(f.asset, RELEASE);
  for (let hops = 0; ; hops++) {
    if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.includes(url.hostname))
      throw fixedError(
        'The search model download was sent somewhere other than GitHub, so the office kept none of it.'
      );
    const res = await fetchUrl(url, { redirect: 'manual', signal });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!to) return res;
    await res.body?.cancel();
    if (hops === MAX_REDIRECTS)
      throw fixedError('GitHub redirected the search model too many times. Try again later.');
    url = new URL(to, url);
  }
}

async function fetchAll(files: readonly ModelFile[], fetchUrl: FetchUrl): Promise<void> {
  const models = home('models');
  mkdirSync(models, { recursive: true, mode: 0o700 });
  // A download the office stopped in the middle of.
  for (const n of readdirSync(models))
    if (n.startsWith(PARTIAL)) rmSync(join(models, n), { recursive: true, force: true });
  const into = mkdtempSync(join(models, PARTIAL));
  try {
    for (const f of files) await fetchOne(f, join(into, f.name), fetchUrl);
    rmSync(modelDir(), { recursive: true, force: true });
    renameSync(into, modelDir());
  } catch (e) {
    rmSync(into, { recursive: true, force: true });
    throw e;
  }
}

async function fetchOne(f: ModelFile, to: string, fetchUrl: FetchUrl): Promise<void> {
  let res: Response;
  try {
    res = await fromRelease(f, fetchUrl);
  } catch (e) {
    if (isFixedError(e)) throw e;
    throw fixedError('The office could not reach GitHub to download the search model.');
  }
  if (!res.ok || !res.body)
    throw fixedError('GitHub did not send the search model. Try again later.');
  const hash = createHash('sha256');
  let bytes = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      done(bytes > f.bytes ? new Error('too long') : null, chunk);
    }
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream),
      check,
      createWriteStream(to, { mode: 0o600 })
    );
  } catch {
    if (bytes <= f.bytes)
      throw fixedError(
        'The search model stopped downloading partway, so the office kept none of it.'
      );
  }
  if (bytes !== f.bytes || hash.digest('hex') !== f.sha256)
    throw fixedError('The search model did not match its checksum, so the office kept none of it.');
}

/** Whether a partial download is lying in the models folder, for a test. */
export const partialDownloads = (): string[] =>
  existsSync(home('models'))
    ? readdirSync(home('models')).filter((n) => n.startsWith(PARTIAL))
    : [];
