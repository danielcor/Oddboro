// Turns a country and a postal code into a place and rounded coordinates, on
// this computer. Only the country leaves: the office downloads that country's
// GeoNames file (CC BY 4.0), reads it in memory, and keeps nothing of it but
// the one match. Some countries list only the first part of a code (GB SW1A,
// CA M5V, NL 1012), so a code not listed whole matches its listed first part,
// or its longest listed start. Some list only coarse areas (IE, MT, CL, CN,
// AR, BR), so there a code matches the listed one that shares the most of its
// start. Anything else not listed gets the closest code as a suggestion.
import type { PlaceMatch } from '../weather.ts';
import { readZipEntry } from './zip.ts';

/** One line of a GeoNames postal file. */
export type PostalRow = {
  code: string;
  place: string;
  region: string;
  regionCode: string;
  lat: number;
  lon: number;
};

export type PostalLookup = { match: PlaceMatch } | { missing: string; suggestion?: PlaceMatch };

/** Who is asking, as MET Norway's and GeoNames' terms want: the app, its version and where to reach it. */
export const USER_AGENT = `Oddboro/${process.env.ODDBORO_VERSION || 'development'} https://oddboro.com`;
/** The biggest country file is under 2 MB. Anything far past that is not one. */
const MOST_BYTES = 20_000_000;

export const countryName = (country: string): string =>
  new Intl.DisplayNames(['en'], { type: 'region' }).of(country) ?? country;

/** The countries whose files hold only coarse areas. */
const COARSE = ['IE', 'MT', 'CL', 'CN', 'AR', 'BR'];

/** Case, spaces and hyphens do not count: "sw1a 1aa" is SW1A1AA. */
const plain = (code: string) => code.toUpperCase().replace(/[\s-]+/g, '');

/** The part of a full code the country's file lists, where it lists only the first part. */
function firstPart(country: string, code: string): string | undefined {
  // A British inward code is always the last three characters.
  if (['GB', 'GG', 'JE', 'IM'].includes(country))
    return code.length >= 5 ? code.slice(0, -3) : undefined;
  if (country === 'CA') return code.slice(0, 3);
  if (country === 'NL') return code.slice(0, 4);
  return undefined;
}

/** The tab-separated lines of a GeoNames postal file. */
export function parsePostalFile(text: string): PostalRow[] {
  const rows: PostalRow[] = [];
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 11) continue;
    const lat = Number(f[9]);
    const lon = Number(f[10]);
    if (!f[1] || !f[9] || !f[10] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push({ code: f[1], place: f[2], region: f[3], regionCode: f[4], lat, lon });
  }
  return rows;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Every row with one listed code, as one match: the first row's name, the rows' middle. */
function matchOf(rows: PostalRow[]): PlaceMatch {
  const [first] = rows;
  const region = /^[A-Z]{2}$/.test(first.regionCode)
    ? first.regionCode
    : first.region !== first.place
      ? first.region
      : '';
  const name = [first.place, region].filter(Boolean).join(', ');
  return {
    code: first.code,
    place: `${name} ${first.code}`.trim(),
    lat: round(rows.reduce((s, r) => s + r.lat, 0) / rows.length),
    lon: round(rows.reduce((s, r) => s + r.lon, 0) / rows.length)
  };
}

/** Look a typed code up in one country's rows. */
export function findPostal(country: string, typed: string, rows: PostalRow[]): PostalLookup {
  const want = plain(typed);
  if (!want) return { missing: 'Type a postal code.' };
  const byCode = Map.groupBy(rows, (r) => plain(r.code));
  const listed = (code: string | undefined) => (code ? byCode.get(code) : undefined);
  const exact = listed(want) ?? listed(firstPart(country, want));
  if (exact) return { match: matchOf(exact) };
  // The longest listed code the typed one starts with: a coarse area, or a ZIP+4.
  let best = '';
  for (const code of byCode.keys())
    if (code.length >= 2 && code.length > best.length && want.startsWith(code)) best = code;
  if (best) return { match: matchOf(byCode.get(best)!) };
  const near = nearest(want, byCode);
  if (near && COARSE.includes(country) && near.shared >= 2)
    return { match: matchOf(byCode.get(near.code)!) };
  return {
    missing: `No place has the postal code ${typed.trim()}.`,
    suggestion: near && matchOf(byCode.get(near.code)!)
  };
}

/** The listed code that shares the longest start with the typed one, then the nearest in number. */
function nearest(
  want: string,
  byCode: Map<string, PostalRow[]>
): { code: string; shared: number } | undefined {
  const shared = (code: string) => {
    let n = 0;
    while (n < code.length && code[n] === want[n]) n++;
    return n;
  };
  const gap = (code: string) =>
    /^\d+$/.test(code) && /^\d+$/.test(want) ? Math.abs(Number(code) - Number(want)) : 0;
  let best: string | undefined;
  for (const code of byCode.keys()) {
    const s = shared(code);
    if (!s) continue;
    if (!best || s > shared(best) || (s === shared(best) && gap(code) < gap(best))) best = code;
  }
  return best ? { code: best, shared: shared(best) } : undefined;
}

/** Download the country's file from GeoNames, find the code, and keep only the match. */
export async function lookUpPostal(country: string, typed: string): Promise<PostalLookup> {
  let res: Response;
  try {
    res = await fetch(`https://download.geonames.org/export/zip/${country}.zip`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Error('GeoNames did not answer. Try again in a minute.');
  }
  if (res.status === 404)
    return { missing: `GeoNames has no postal codes for ${countryName(country)}.` };
  if (!res.ok) throw new Error(`GeoNames answered ${res.status}. Try again in a minute.`);
  if (Number(res.headers.get('content-length')) > MOST_BYTES)
    throw new Error('The GeoNames file was too big to be a postal list.');
  const text = readZipEntry(new Uint8Array(await res.arrayBuffer()), `${country}.txt`);
  if (!text) throw new Error(`The GeoNames file for ${countryName(country)} held no postal list.`);
  return findPostal(country, typed, parsePostalFile(text.toString('utf8')));
}
