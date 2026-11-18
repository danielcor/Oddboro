// Reading one file out of a zip, as the office reads a GeoNames country file.
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readZipEntry } from './zip.ts';
import { makeZip } from './zip-harness.ts';

const LIST = 'US\t98101\tSeattle\tWashington\tWA\tKing\t033\t\t\t47.6114\t-122.3305\t4\n';

test('reads the named entry, deflated, beside a readme', () => {
  const zip = makeZip([
    { name: 'readme.txt', text: 'GeoNames postal codes' },
    { name: 'US.txt', text: LIST }
  ]);
  assert.equal(readZipEntry(zip, 'US.txt')?.toString(), LIST);
  assert.equal(readZipEntry(zip, 'readme.txt')?.toString(), 'GeoNames postal codes');
});

test('reads a stored entry and one whose sizes follow its data', () => {
  assert.equal(
    readZipEntry(makeZip([{ name: 'US.txt', text: LIST, deflate: false }]), 'US.txt')?.toString(),
    LIST
  );
  assert.equal(
    readZipEntry(makeZip([{ name: 'US.txt', text: LIST, sizesAfter: true }]), 'US.txt')?.toString(),
    LIST
  );
});

test('a missing entry is undefined, and something that is not a zip says so', () => {
  assert.equal(readZipEntry(makeZip([{ name: 'readme.txt', text: 'hi' }]), 'US.txt'), undefined);
  assert.throws(() => readZipEntry(Buffer.from('<html>Not found</html>'), 'US.txt'), {
    message: 'Not a zip archive.'
  });
});
