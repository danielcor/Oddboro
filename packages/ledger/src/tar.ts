// A plain tar, only as much of it as an office backup needs: folders and
// files, each named by a path, in the POSIX (ustar) layout any tar tool
// reads. A path too long for the header's 100 bytes goes before its entry
// in a PAX record, as GNU and BSD tar write it. Reading is strict: a link, a
// device or anything else that is not a file or a folder is refused, so a
// backup can only ever lay down files.
const BLOCK = 512;
/** The longest path a reader takes, and the largest PAX record it holds. */
const PATH_MAX = 4096;
const PAX_MAX = 64 * 1024;

export type TarEntry = { path: string; kind: 'file' | 'dir'; size?: number };

/** Why a tar could not be read: it is cut off or garbled, or it holds what a backup never does. */
export class TarProblem extends Error {
  readonly kind: 'damaged' | 'foreign';
  constructor(kind: 'damaged' | 'foreign', message: string) {
    super(message);
    this.kind = kind;
  }
}

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, '0')}\0`;

function block(name: string, type: string, size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.write(' '.repeat(8), 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\x0000', 257, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/** One PAX record, "<length> path=<value>\n", whose length counts its own digits. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let n = Buffer.byteLength(body);
  while (`${n + String(n).length}`.length !== String(n).length) n++;
  return Buffer.from(`${n + String(n).length}${body}`);
}

/** The zero bytes that fill a file's data out to whole blocks. */
export const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Two empty blocks end a tar. */
export const END = Buffer.alloc(BLOCK * 2);

/** The header blocks for one entry. A file's data and its padding follow. */
export function header(entry: TarEntry, mtime = Math.floor(Date.now() / 1000)): Buffer {
  const name = entry.kind === 'dir' ? `${entry.path}/` : entry.path;
  const type = entry.kind === 'dir' ? '5' : '0';
  const mode = entry.kind === 'dir' ? 0o700 : 0o600;
  const size = entry.kind === 'dir' ? 0 : (entry.size ?? 0);
  if (Buffer.byteLength(name) <= 100) return block(name, type, size, mode, mtime);
  const pax = paxRecord('path', name);
  return Buffer.concat([
    block('PaxHeader', 'x', pax.length, 0o600, mtime),
    pax,
    padding(pax.length),
    block(name.slice(0, 99), type, size, mode, mtime)
  ]);
}

const text = (h: Buffer, at: number, length: number) => {
  const field = h.subarray(at, at + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString('utf8');
};

function number(h: Buffer, at: number, length: number): number {
  const field = text(h, at, length).trim();
  if (!/^[0-7]+$/.test(field)) throw new TarProblem('damaged', 'A header number is not octal.');
  return parseInt(field, 8);
}

/** The path a PAX record set gives, if any. Other keys are left alone. */
function paxPath(records: Buffer): string | undefined {
  let path: string | undefined;
  let at = 0;
  while (at < records.length) {
    const space = records.indexOf(0x20, at);
    const length = Number(records.subarray(at, space).toString('ascii'));
    if (space < 0 || !Number.isInteger(length) || length <= 0 || at + length > records.length)
      throw new TarProblem('damaged', 'A PAX record is garbled.');
    const record = records.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    // A size or link set here would change how the entry reads: never in a backup.
    if (['size', 'linkpath'].includes(record.slice(0, eq)))
      throw new TarProblem('foreign', `A PAX record sets ${record.slice(0, eq)}.`);
    at += length;
  }
  return path;
}

/**
 * Reads a tar one chunk at a time, as it arrives. `entry` hears each file or
 * folder before its data, `data` each piece of a file's data in order, and
 * `finish` checks the tar ended where it should.
 */
export class TarReader {
  private on: { entry: (e: Required<TarEntry>) => void; data: (chunk: Buffer) => void };
  private held: Buffer = Buffer.alloc(0);
  private state: 'header' | 'data' | 'pax' | 'skip' | 'end' = 'header';
  private left = 0;
  private skipAfter = 0;
  private pax: Buffer[] = [];
  private paxName: string | undefined;

  constructor(on: TarReader['on']) {
    this.on = on;
  }

  push(chunk: Buffer): void {
    this.held = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    for (;;) {
      if (this.state === 'end') return void (this.held = Buffer.alloc(0));
      if (this.state === 'data' || this.state === 'pax' || this.state === 'skip') {
        if (!this.held.length && this.left) return;
        const take = this.held.subarray(0, this.left);
        this.held = this.held.subarray(take.length);
        this.left -= take.length;
        if (this.state === 'data' && take.length) this.on.data(take);
        if (this.state === 'pax') this.pax.push(take);
        if (this.left) return;
        if (this.state === 'pax') this.paxName = paxPath(Buffer.concat(this.pax));
        this.state = this.skipAfter ? 'skip' : 'header';
        this.left = this.skipAfter;
        this.skipAfter = 0;
        continue;
      }
      if (this.held.length < BLOCK) return;
      const h = this.held.subarray(0, BLOCK);
      this.held = this.held.subarray(BLOCK);
      if (h.every((b) => b === 0)) {
        this.state = 'end';
        continue;
      }
      this.readHeader(Buffer.from(h));
    }
  }

  private readHeader(h: Buffer): void {
    const want = number(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== want) throw new TarProblem('damaged', 'A header checksum does not match.');
    const type = String.fromCharCode(h[156] || 0x30);
    const size = number(h, 124, 12);
    if (type === 'x') {
      if (size > PAX_MAX) throw new TarProblem('damaged', 'A PAX record is too long.');
      this.state = 'pax';
      this.pax = [];
      this.left = size;
      this.skipAfter = padding(size).length;
      return;
    }
    if (type !== '0' && type !== '5')
      throw new TarProblem('foreign', `An entry is of type ${JSON.stringify(type)}.`);
    const prefix = text(h, 345, 155);
    const path = this.paxName ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    this.paxName = undefined;
    if (Buffer.byteLength(path) > PATH_MAX) throw new TarProblem('damaged', 'A path is too long.');
    const kind = type === '5' ? 'dir' : 'file';
    this.on.entry({ path: path.replace(/\/+$/, ''), kind, size: kind === 'dir' ? 0 : size });
    if (kind === 'dir') return;
    this.state = 'data';
    this.left = size;
    this.skipAfter = padding(size).length;
    if (!size) {
      this.state = 'header';
      this.skipAfter = 0;
    }
  }

  /** Throws unless the tar ended with its empty blocks and nothing was left half read. */
  finish(): void {
    if (this.state !== 'end') throw new TarProblem('damaged', 'The tar ends early.');
  }
}
