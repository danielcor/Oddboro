// Weather at the office, shared by the server and the page: the setting the
// owner keeps, the report the server serves, and the words, sky and units the
// page shows. The server fetches it (`#lib/server/weather.ts`); nothing here
// reaches the network.

/** The countries GeoNames has postal codes for, one file each (download.geonames.org/export/zip). */
export const POSTAL_COUNTRIES = [
  'AD',
  'AE',
  'AI',
  'AL',
  'AM',
  'AR',
  'AS',
  'AT',
  'AU',
  'AX',
  'AZ',
  'BD',
  'BE',
  'BG',
  'BM',
  'BR',
  'BY',
  'CA',
  'CC',
  'CH',
  'CL',
  'CN',
  'CO',
  'CR',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DK',
  'DO',
  'DZ',
  'EC',
  'EE',
  'ES',
  'FI',
  'FK',
  'FM',
  'FO',
  'FR',
  'GB',
  'GF',
  'GG',
  'GI',
  'GL',
  'GP',
  'GS',
  'GT',
  'GU',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IM',
  'IN',
  'IO',
  'IS',
  'IT',
  'JE',
  'JP',
  'KE',
  'KR',
  'LI',
  'LK',
  'LT',
  'LU',
  'LV',
  'MA',
  'MC',
  'MD',
  'MH',
  'MK',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MT',
  'MW',
  'MX',
  'MY',
  'NC',
  'NF',
  'NL',
  'NO',
  'NR',
  'NU',
  'NZ',
  'PA',
  'PE',
  'PF',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PT',
  'PW',
  'PY',
  'RE',
  'RO',
  'RS',
  'RU',
  'SE',
  'SG',
  'SI',
  'SJ',
  'SK',
  'SM',
  'TC',
  'TH',
  'TR',
  'UA',
  'US',
  'UY',
  'VA',
  'VI',
  'WF',
  'WS',
  'YT',
  'ZA'
] as const;

export const isPostalCountry = (cc: string): boolean =>
  (POSTAL_COUNTRIES as readonly string[]).includes(cc);

export type Unit = 'C' | 'F';

/** Where the weather comes from. Only this is kept, never the country's file. */
export type WeatherSetting = {
  /** ISO country code, such as US. */
  country: string;
  /** The postal code as the owner typed it. */
  postal: string;
  /** What the code matched, as the owner confirms it: "Seattle, WA 98101". */
  place: string;
  /** Rounded to one decimal, about 11 km. */
  lat: number;
  lon: number;
  unit: Unit;
};

/** What a postal code matched: the place as the owner confirms it, and its rounded coordinates. */
export type PlaceMatch = { code: string; place: string; lat: number; lon: number };

/** What Setup's change answers: the kept setting, or why the code matched nothing. */
export type WeatherChange =
  { setting: WeatherSetting } | { missing: string; suggestion?: PlaceMatch };

/** The countries that read °F. Every other one reads °C until the owner picks. */
export const defaultUnit = (country: string): Unit =>
  ['US', 'LR', 'MM'].includes(country) ? 'F' : 'C';

/** The hour the forecast holds for now, from MET Norway. */
export type WeatherHour = {
  /** The hour's start, as MET Norway gives it (UTC). */
  time: string;
  /** °C. */
  temperature: number | null;
  /** Percent of the sky under cloud. */
  cloud: number | null;
  /** MET Norway's symbol code, such as `partlycloudy_night` or `lightrain`. */
  symbol: string;
};

/** What `GET /api/weather` serves the page. */
export type WeatherView = {
  setting: WeatherSetting | null;
  /** The last good report, kept when a later check fails. */
  report: (WeatherHour & { checkedAt: number }) | null;
  /** Why the last check failed, in plain words. Empty when it worked. */
  problem: string;
  /** When the page should ask again: the forecast's next hour or when it expires. Null when off. */
  next: number | null;
};

/** The skies the pill has an icon for, one per family of MET Norway symbols. */
export const SKIES = [
  'clear-day',
  'clear-night',
  'partly-day',
  'partly-night',
  'cloudy',
  'fog',
  'rain',
  'sleet',
  'snow',
  'thunder'
] as const;
export type Sky = (typeof SKIES)[number];

/** A symbol code's family. Fair counts as partly cloudy; showers count as their kind. */
export function skyOf(symbol: string): Sky {
  const [base, time] = symbol.split('_');
  const night = time === 'night';
  if (base === 'clearsky') return night ? 'clear-night' : 'clear-day';
  if (base === 'fair' || base === 'partlycloudy') return night ? 'partly-night' : 'partly-day';
  if (base === 'fog') return 'fog';
  if (base.includes('thunder')) return 'thunder';
  if (base.includes('sleet')) return 'sleet';
  if (base.includes('snow')) return 'snow';
  if (base.includes('rain')) return 'rain';
  return 'cloudy';
}

/** The floor's look for now: the windows go grey and the sun shafts stop under these skies. */
export const overcast = (sky: Sky): boolean =>
  !['clear-day', 'clear-night', 'partly-day', 'partly-night'].includes(sky);

const BASE_WORDS: Record<string, string> = {
  clearsky: 'Clear',
  fair: 'Fair',
  partlycloudy: 'Partly cloudy',
  cloudy: 'Cloudy',
  fog: 'Fog'
};

/** A symbol code in plain words: `lightrainshowers_day` is "Light rain showers". */
export function conditionWords(symbol: string): string {
  const base = symbol.split('_')[0];
  if (BASE_WORDS[base]) return BASE_WORDS[base];
  // MET Norway spells two of its codes with a double s (lightssleetshowersandthunder).
  const m = /^(light|heavy)?s?(rain|sleet|snow)(showers)?(andthunder)?$/.exec(base);
  if (!m) return 'Cloudy';
  const words = [m[1], m[2], m[3], m[4] && 'and thunder'].filter(Boolean).join(' ');
  return words[0].toUpperCase() + words.slice(1);
}

/** A °C reading in the owner's unit, whole degrees. */
export const shownTemperature = (celsius: number, unit: Unit): number =>
  // Plus zero, never "-0°".
  Math.round(unit === 'F' ? (celsius * 9) / 5 + 32 : celsius) || 0;

/** Whether the page asks the office now: only while it is seen, and only once the answer is due. */
export const askNow = (visible: boolean, now: number, next: number | null): boolean =>
  visible && next !== null && now >= next;
