// Finding a postal code in a GeoNames country file, on this computer.
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPostal, lookUpPostal, parsePostalFile, type PostalRow } from './postal-codes.ts';
import { makeZip } from './zip-harness.ts';

/** Lines in GeoNames' own shape: country, code, place, region, region code, two more levels, then latitude and longitude. */
const line = (
  cc: string,
  code: string,
  place: string,
  region: string,
  regionCode: string,
  lat: number,
  lon: number
) => [cc, code, place, region, regionCode, '', '', '', '', lat, lon, 4].join('\t');

const US = [
  line('US', '98101', 'Seattle', 'Washington', 'WA', 47.6114, -122.3305),
  line('US', '98104', 'Seattle', 'Washington', 'WA', 47.6036, -122.3256),
  line('US', '98198', 'Seattle', 'Washington', 'WA', 47.3934, -122.3045),
  line('US', '10001', 'New York', 'New York', 'NY', 40.7484, -73.9967)
].join('\n');
const GB = [
  line('GB', 'SW1A', 'London', 'England', 'ENG', 51.5, -0.1333),
  line('GB', 'S1', 'Sheffield', 'England', 'ENG', 53.3807, -1.4702),
  line('GB', 'S12', 'Sheffield', 'England', 'ENG', 53.3415, -1.3888)
].join('\n');
const CA = line('CA', 'M5V', 'Toronto (Harbourfront)', 'Ontario', 'ON', 43.6429, -79.3901);
const NL = [
  line('NL', '1012', 'Amsterdam', 'Noord-Holland', '07', 52.3738, 4.8909),
  line('NL', '1012', 'Amsterdam', 'Noord-Holland', '07', 52.3778, 4.8949)
].join('\n');
const BR = [
  line('BR', '01000-000', 'São Paulo', 'São Paulo', '27', -23.5475, -46.6361),
  line('BR', '20000-000', 'Rio de Janeiro', 'Rio de Janeiro', '21', -22.9028, -43.2075)
].join('\n');

const rows = (text: string): PostalRow[] => parsePostalFile(text);

test('a US ZIP code matches its place, with the state and coordinates to one decimal', () => {
  assert.deepEqual(findPostal('US', '98101', rows(US)), {
    match: { code: '98101', place: 'Seattle, WA 98101', lat: 47.6, lon: -122.3 }
  });
  // A ZIP+4 matches its five digits.
  assert.equal(
    (findPostal('US', '98101-1234', rows(US)) as { match: { code: string } }).match.code,
    '98101'
  );
});

test('a British code matches its outward part, however it is typed', () => {
  for (const typed of ['SW1A 1AA', 'sw1a1aa', 'SW1A'])
    assert.equal(
      (findPostal('GB', typed, rows(GB)) as { match: { place: string } }).match.place,
      'London, England SW1A',
      typed
    );
  // S1 2AB is in S1, not S12: the inward part is always the last three characters.
  assert.equal(
    (findPostal('GB', 'S1 2AB', rows(GB)) as { match: { code: string } }).match.code,
    'S1'
  );
  assert.equal(
    (findPostal('GB', 'S12 4AB', rows(GB)) as { match: { code: string } }).match.code,
    'S12'
  );
});

test('a Canadian code matches its first three characters, and a Dutch one its four digits', () => {
  assert.deepEqual(findPostal('CA', 'm5v 3l9', rows(CA)), {
    match: { code: 'M5V', place: 'Toronto (Harbourfront), ON M5V', lat: 43.6, lon: -79.4 }
  });
  // Two rows for one code: the middle of them.
  assert.deepEqual(findPostal('NL', '1012 AB', rows(NL)), {
    match: { code: '1012', place: 'Amsterdam, Noord-Holland 1012', lat: 52.4, lon: 4.9 }
  });
});

test('in a coarse country a code matches the listed one sharing the most of its start', () => {
  assert.equal(
    (findPostal('BR', '01310-100', rows(BR)) as { match: { place: string } }).match.place,
    'São Paulo 01000-000'
  );
});

test('a code not found says so plainly and offers the closest', () => {
  const found = findPostal('US', '98199', rows(US));
  assert.deepEqual(found, {
    missing: 'No place has the postal code 98199.',
    suggestion: { code: '98198', place: 'Seattle, WA 98198', lat: 47.4, lon: -122.3 }
  });
  assert.deepEqual(findPostal('US', '  ', rows(US)), { missing: 'Type a postal code.' });
});

test("the lookup downloads only the country's file and keeps only the match", async (t) => {
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    asked.push(url);
    assert.match(
      String((init.headers as Record<string, string>)['User-Agent']),
      /^Oddboro\/\S+ https:\/\/oddboro\.com$/
    );
    if (url.endsWith('/XX.zip')) return new Response('Not found', { status: 404 });
    return new Response(
      makeZip([
        { name: 'readme.txt', text: 'GeoNames' },
        { name: 'US.txt', text: US }
      ])
    );
  });
  assert.deepEqual(await lookUpPostal('US', '98104'), {
    match: { code: '98104', place: 'Seattle, WA 98104', lat: 47.6, lon: -122.3 }
  });
  assert.deepEqual(asked, ['https://download.geonames.org/export/zip/US.zip']);
  assert.deepEqual(await lookUpPostal('XX', '1'), {
    missing: 'GeoNames has no postal codes for XX.'
  });
});

test('a GeoNames that does not answer is a plain error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(lookUpPostal('US', '98101'), {
    message: 'GeoNames did not answer. Try again in a minute.'
  });
});
