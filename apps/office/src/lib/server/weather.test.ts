// The office's weather: the setting in .env, MET Norway's forecast read for
// the current hour, one cache that honours Expires and If-Modified-Since,
// and the route Setup and the page use. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { WeatherChange, WeatherSetting, WeatherView } from '../weather.ts';
import { makeZip } from './zip-harness.ts';

// The office's settings file for this test alone, named before anything reads it.
const ENV = join(mkdtempSync(join(tmpdir(), 'oddboro-weather-')), '.env');
process.env.ODDBORO_ENV = ENV;
const { currentHour, keepWeatherSetting, parseForecast, weatherSetting, weatherView } =
  await import('./weather.ts');
const route = await import('../../routes/api/weather/+server.ts');
const { bus } = await import('./events.ts');

const SEATTLE: WeatherSetting = {
  country: 'US',
  postal: '98101',
  place: 'Seattle, WA 98101',
  lat: 47.6,
  lon: -122.3,
  unit: 'F'
};
const T0 = Date.parse('2026-11-16T10:30:00Z');
const MIN = 60_000;

/** A compact forecast in MET Norway's shape: one entry an hour from 10:00 UTC. */
function forecast(symbols: string[]) {
  return {
    type: 'Feature',
    properties: {
      timeseries: symbols.map((symbol_code, i) => ({
        time: new Date(Date.parse('2026-11-16T10:00:00Z') + i * 3_600_000)
          .toISOString()
          .replace('.000', ''),
        data: {
          instant: { details: { air_temperature: 9.2 - i, cloud_area_fraction: 96.1 } },
          next_1_hours: { summary: { symbol_code } }
        }
      }))
    }
  };
}

const metHeaders = (expiresIn: number) => ({
  date: new Date(T0).toUTCString(),
  expires: new Date(T0 + expiresIn).toUTCString(),
  'last-modified': 'Mon, 16 Nov 2026 10:12:00 GMT'
});

type Sent = { url: URL; headers: Record<string, string> };
/** Stands in for MET Norway: each reply in turn, and a record of what was asked. */
function met(t: TestContext, replies: (() => Response)[]): Sent[] {
  const sent: Sent[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    sent.push({ url: new URL(url), headers: init.headers as Record<string, string> });
    const reply = replies.shift();
    if (!reply) throw new Error('asked MET Norway once too often');
    return reply();
  });
  return sent;
}

test('the forecast is read for the hour that has started', () => {
  const hours = parseForecast(forecast(['cloudy', 'lightrain', 'rain']));
  assert.equal(hours.length, 3);
  assert.deepEqual(currentHour(hours, T0), {
    time: '2026-11-16T10:00:00Z',
    temperature: 9.2,
    cloud: 96.1,
    symbol: 'cloudy'
  });
  assert.equal(currentHour(hours, T0 + 60 * MIN)?.symbol, 'lightrain');
  // Before the first hour, the first; nothing to read, nothing.
  assert.equal(currentHour(hours, T0 - 120 * MIN)?.symbol, 'cloudy');
  assert.deepEqual(parseForecast({ nothing: true }), []);
});

test('the setting keeps in .env, a # included, and goes with Turn off', () => {
  keepWeatherSetting({ ...SEATTLE, place: 'Flat #2, WA' }, ENV);
  assert.equal(weatherSetting(ENV)?.place, 'Flat #2, WA');
  keepWeatherSetting(null, ENV);
  assert.equal(weatherSetting(ENV), null);
});

test('off, nothing is asked', async (t) => {
  const sent = met(t, []);
  assert.deepEqual(await weatherView(T0, ENV), {
    setting: null,
    report: null,
    problem: '',
    next: null
  });
  assert.equal(sent.length, 0);
});

test('one answer serves every ask until it expires, then the office asks if it changed', async (t) => {
  keepWeatherSetting(SEATTLE, ENV);
  const sent = met(t, [
    () => Response.json(forecast(['cloudy', 'lightrain']), { headers: metHeaders(30 * MIN) }),
    () =>
      new Response(null, {
        status: 304,
        headers: { ...metHeaders(70 * MIN), date: new Date(T0 + 31 * MIN).toUTCString() }
      })
  ]);
  const first = await weatherView(T0, ENV);
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].url.origin + sent[0].url.pathname,
    'https://api.met.no/weatherapi/locationforecast/2.0/compact'
  );
  assert.equal(sent[0].url.search, '?lat=47.6&lon=-122.3');
  assert.match(sent[0].headers['User-Agent'], /^Oddboro\/\S+ https:\/\/oddboro\.com$/);
  assert.equal(sent[0].headers['Accept-Encoding'], 'gzip');
  assert.equal(sent[0].headers['If-Modified-Since'], undefined);
  assert.equal(first.report?.symbol, 'cloudy');
  assert.equal(first.report?.checkedAt, T0);
  // The next ask is due at the next hour or when the answer expires, whichever is first.
  assert.equal(first.next, T0 + 30 * MIN);

  // Before Expires: from the cache, however many windows ask.
  await Promise.all([weatherView(T0 + 10 * MIN, ENV), weatherView(T0 + 29 * MIN, ENV)]);
  assert.equal(sent.length, 1);

  // After: one ask, with If-Modified-Since. Not modified keeps the series and moves on the hour.
  const later = await weatherView(T0 + 31 * MIN, ENV);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].headers['If-Modified-Since'], 'Mon, 16 Nov 2026 10:12:00 GMT');
  assert.equal(later.report?.symbol, 'lightrain');
  assert.equal(later.report?.checkedAt, T0 + 31 * MIN);
  assert.equal(later.problem, '');
  // Expires is read against MET Norway's own clock: 39 minutes after its Date.
  assert.equal(later.next, T0 + 31 * MIN + 39 * MIN);
  keepWeatherSetting(null, ENV);
});

test('a refusal keeps the last report, says why, and backs off', async (t) => {
  keepWeatherSetting(SEATTLE, ENV);
  const sent = met(t, [
    () => Response.json(forecast(['rain', 'rain', 'rain']), { headers: metHeaders(5 * MIN) }),
    () => new Response('slow down', { status: 429 }),
    () => {
      throw new TypeError('fetch failed');
    }
  ]);
  await weatherView(T0, ENV);
  const refused = await weatherView(T0 + 6 * MIN, ENV);
  assert.equal(refused.report?.symbol, 'rain');
  assert.equal(refused.problem, 'MET Norway asked the office to slow down.');
  // An hour before it asks again.
  await weatherView(T0 + 6 * MIN + 59 * MIN, ENV);
  assert.equal(sent.length, 2);
  const down = await weatherView(T0 + 6 * MIN + 61 * MIN, ENV);
  assert.equal(sent.length, 3);
  assert.equal(down.problem, 'MET Norway did not answer.');
  assert.equal(down.report?.symbol, 'rain');
  keepWeatherSetting(null, ENV);
});

test('Setup turns weather on, changes the unit without a lookup, and turns it off', async (t) => {
  const told: string[] = [];
  const hear = (e: { type: string }) => told.push(e.type);
  bus.on('event', hear);
  t.after(() => bus.off('event', hear));
  const US = 'US\t98101\tSeattle\tWashington\tWA\t\t\t\t\t47.6114\t-122.3305\t4\n';
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    asked.push(String(url));
    return new Response(makeZip([{ name: 'US.txt', text: US }]));
  });
  const put = async (body: unknown) => {
    const res = await route.PUT({
      request: new Request('http://office/api/weather', {
        method: 'PUT',
        body: JSON.stringify(body)
      })
    } as Parameters<typeof route.PUT>[0]);
    return (await res.json()) as WeatherChange;
  };

  assert.deepEqual(await put({ country: 'US', postal: '98101', unit: 'F' }), {
    setting: SEATTLE
  });
  assert.deepEqual(asked, ['https://download.geonames.org/export/zip/US.zip']);
  assert.deepEqual(weatherSetting(), SEATTLE);
  assert.deepEqual(told, ['weather']);

  assert.deepEqual(await put({ country: 'US', postal: '98101', unit: 'C' }), {
    setting: { ...SEATTLE, unit: 'C' }
  });
  assert.equal(asked.length, 1);

  assert.deepEqual(await put({ country: 'US', postal: '98109', unit: 'C' }), {
    missing: 'No place has the postal code 98109.',
    suggestion: { code: '98101', place: 'Seattle, WA 98101', lat: 47.6, lon: -122.3 }
  });
  // A code that matched nothing leaves the kept setting alone.
  assert.equal(weatherSetting()?.postal, '98101');

  await assert.rejects(put({ country: 'ZZ', postal: '1', unit: 'C' }), { status: 400 });

  await route.DELETE({} as Parameters<typeof route.DELETE>[0]);
  assert.equal(weatherSetting(), null);
  const off = (await (
    await route.GET({} as Parameters<typeof route.GET>[0])
  ).json()) as WeatherView;
  assert.equal(off.setting, null);
  // Two lookups, for 98101 and 98109, and nothing to MET Norway: no page asked while it was on.
  assert.equal(asked.length, 2);
});
