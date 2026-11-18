// The office's weather: the owner's setting, kept in the office's .env, and
// one cache of MET Norway's forecast (CC BY 4.0) for every window and the app.
// Nothing is asked until the owner turns weather on in Setup. The office asks
// MET Norway only when a page asks it and the last answer has expired, as
// MET Norway's terms want: never before its Expires time, with
// If-Modified-Since, gzip, a User-Agent that names Oddboro, and backing off
// when it says no. Each answer serves its current hour from the kept series.
import { ENV_FILE, readEnv, writeEnv } from '@oddboro/ledger/env';
import { USER_AGENT } from './postal-codes.ts';
import {
  isPostalCountry,
  type WeatherHour,
  type WeatherSetting,
  type WeatherView
} from '../weather.ts';

const KEY = 'OFFICE_WEATHER';
const MINUTE = 60_000;
/** Hours of forecast kept: enough to cover a long gap between checks. */
const KEPT_HOURS = 48;

type Cache = {
  /** The coordinates asked about. A new place starts a new cache. */
  where: string;
  hours: WeatherHour[];
  /** When MET Norway last answered with a forecast or "not modified". */
  checkedAt: number;
  lastModified?: string;
  /** Not before this time: MET Norway's Expires, or a back-off after a failure. */
  until: number;
  problem: string;
  failures: number;
  /** The request in flight: every window asking at once shares it. */
  asking?: Promise<void>;
};
let cache: Cache | undefined;

/** The owner's setting, or null while weather is off. */
export function weatherSetting(file = ENV_FILE): WeatherSetting | null {
  const raw = readEnv(file)[KEY];
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as WeatherSetting;
    const ok =
      isPostalCountry(s.country) &&
      typeof s.postal === 'string' &&
      typeof s.place === 'string' &&
      Number.isFinite(s.lat) &&
      Number.isFinite(s.lon) &&
      (s.unit === 'C' || s.unit === 'F');
    return ok ? s : null;
  } catch {
    return null;
  }
}

/** Keep the setting, or clear it with null. A `#` would start a comment in .env, so it goes escaped. */
export function keepWeatherSetting(s: WeatherSetting | null, file = ENV_FILE): void {
  writeEnv({ [KEY]: s ? JSON.stringify(s).replaceAll('#', '\\u0023') : '' }, file);
  if (!s) cache = undefined;
}

/** The forecast's series, cut to what the office shows. */
export function parseForecast(body: unknown): WeatherHour[] {
  const series = (body as { properties?: { timeseries?: unknown } })?.properties?.timeseries;
  if (!Array.isArray(series)) return [];
  type Entry = {
    time?: unknown;
    data?: {
      instant?: { details?: { air_temperature?: unknown; cloud_area_fraction?: unknown } };
      next_1_hours?: { summary?: { symbol_code?: unknown } };
      next_6_hours?: { summary?: { symbol_code?: unknown } };
    };
  };
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hours: WeatherHour[] = [];
  for (const e of series.slice(0, KEPT_HOURS) as Entry[]) {
    const symbol =
      e.data?.next_1_hours?.summary?.symbol_code ?? e.data?.next_6_hours?.summary?.symbol_code;
    if (
      typeof e.time !== 'string' ||
      !Number.isFinite(Date.parse(e.time)) ||
      typeof symbol !== 'string'
    )
      continue;
    const d = e.data?.instant?.details;
    hours.push({
      time: e.time,
      temperature: num(d?.air_temperature),
      cloud: num(d?.cloud_area_fraction),
      symbol
    });
  }
  return hours;
}

/** The hour the series holds for now: the last one started, or the first when none has. */
export function currentHour(hours: WeatherHour[], now: number): WeatherHour | undefined {
  let pick = hours[0];
  for (const h of hours) {
    if (Date.parse(h.time) > now) break;
    pick = h;
  }
  return pick;
}

/**
 * When the answer may be asked for again. MET Norway's Expires, moved by the
 * gap between its clock and this one, and never under a minute.
 */
function expiry(res: Response, now: number): number {
  const expires = Date.parse(res.headers.get('expires') ?? '');
  const date = Date.parse(res.headers.get('date') ?? '');
  const at = Number.isFinite(expires)
    ? Number.isFinite(date)
      ? now + expires - date
      : expires
    : now + 30 * MINUTE;
  return Math.max(at, now + MINUTE);
}

function failed(c: Cache, now: number, problem: string, refused = false): void {
  c.failures++;
  // Ten minutes, doubling to six hours; an hour, doubling, when MET Norway refused or asked to slow down.
  const first = refused ? 60 * MINUTE : 10 * MINUTE;
  c.until = now + Math.min(first * 2 ** (c.failures - 1), 6 * 60 * MINUTE);
  c.problem = problem;
}

async function check(c: Cache, s: WeatherSetting, now: number): Promise<void> {
  const url = new URL('https://api.met.no/weatherapi/locationforecast/2.0/compact');
  url.searchParams.set('lat', s.lat.toFixed(1));
  url.searchParams.set('lon', s.lon.toFixed(1));
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' };
  if (c.lastModified && c.hours.length) headers['If-Modified-Since'] = c.lastModified;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    return failed(c, now, 'MET Norway did not answer.');
  }
  if (res.status === 429) return failed(c, now, 'MET Norway asked the office to slow down.', true);
  if (res.status === 403) return failed(c, now, 'MET Norway refused the request.', true);
  if (res.status === 304) {
    Object.assign(c, { until: expiry(res, now), checkedAt: now, problem: '', failures: 0 });
    return;
  }
  if (!res.ok) return failed(c, now, `MET Norway answered ${res.status}.`);
  const hours = parseForecast(await res.json().catch(() => undefined));
  if (!hours.length) return failed(c, now, 'MET Norway sent no forecast the office could read.');
  Object.assign(c, {
    hours,
    lastModified: res.headers.get('last-modified') ?? undefined,
    until: expiry(res, now),
    checkedAt: now,
    problem: '',
    failures: 0
  });
}

/** What the page shows: the setting and the current hour, asking MET Norway first only when due. */
export async function weatherView(now = Date.now(), file = ENV_FILE): Promise<WeatherView> {
  const setting = weatherSetting(file);
  if (!setting) {
    cache = undefined;
    return { setting: null, report: null, problem: '', next: null };
  }
  const where = `${setting.lat.toFixed(1)},${setting.lon.toFixed(1)}`;
  if (cache?.where !== where)
    cache = { where, hours: [], checkedAt: 0, until: 0, problem: '', failures: 0 };
  const c = cache;
  if (now >= c.until)
    await (c.asking ??= check(c, setting, now).finally(() => (c.asking = undefined)));
  const hour = currentHour(c.hours, now);
  const nextHour = c.hours.map((h) => Date.parse(h.time)).find((t) => t > now);
  return {
    setting,
    report: hour ? { ...hour, checkedAt: c.checkedAt } : null,
    problem: c.problem,
    next: Math.max(Math.min(c.until, nextHour ?? Infinity), now + MINUTE)
  };
}
