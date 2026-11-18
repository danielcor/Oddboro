// Makes small zip archives for the tests, the way common tools write them:
// stored or deflated, and with the sizes after the data when asked.
import { crc32, deflateRawSync } from 'node:zlib';

export type Entry = { name: string; text: string; deflate?: boolean; sizesAfter?: boolean };

export function makeZip(entries: Entry[]): Uint8Array<ArrayBuffer> {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.text);
    const data = e.deflate === false ? raw : deflateRawSync(raw);
    const method = e.deflate === false ? 0 : 8;
    const name = Buffer.from(e.name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.sizesAfter ? 8 : 0, 6);
    local.writeUInt16LE(method, 8);
    if (!e.sizesAfter) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const after = Buffer.alloc(e.sizesAfter ? 16 : 0);
    if (e.sizesAfter) {
      after.writeUInt32LE(0x08074b50, 0);
      after.writeUInt32LE(crc, 4);
      after.writeUInt32LE(data.length, 8);
      after.writeUInt32LE(raw.length, 12);
    }
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(e.sizesAfter ? 8 : 0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(at, 42);
    central.push(dir, name);
    parts.push(local, name, data, after);
    at += local.length + name.length + data.length + after.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}
