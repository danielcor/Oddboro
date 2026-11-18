// One file out of a zip archive, with Node's own zlib. Enough for a GeoNames
// country file: a few entries, stored or deflated, no zip64, no encryption.
// The central directory gives each entry's sizes, so an entry written with a
// data descriptor (sizes after the data) reads the same.
import { inflateRawSync } from 'node:zlib';

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The named entry's bytes, or undefined when the archive has no such entry. Throws on a damaged archive. */
export function readZipEntry(zip: Uint8Array, name: string): Buffer | undefined {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is the last 22 bytes, unless a comment of up to 64 KiB follows it.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('Not a zip archive.');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== CENTRAL) throw new Error('The zip archive is damaged.');
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const skip = nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const entry = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + skip;
    if (entry !== name) continue;
    if (buf.readUInt32LE(local) !== LOCAL) throw new Error('The zip archive is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    if (method === 0) return Buffer.from(data);
    if (method !== 8) throw new Error(`The zip archive packs ${name} in a way this cannot read.`);
    const out = inflateRawSync(data);
    if (out.length !== size) throw new Error('The zip archive is damaged.');
    return out;
  }
  return undefined;
}
