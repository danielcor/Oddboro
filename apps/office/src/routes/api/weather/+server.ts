// Weather at the office. GET serves the setting and the current hour from the
// office's one cache (`#lib/server/weather.ts`). PUT, from Setup's Weather
// section, looks the postal code up on this computer and turns weather on;
// the same country and code again only change the unit. DELETE turns it off.
// Each change tells every window on the live line.
import { error, json } from '@sveltejs/kit';
import { emit } from '#lib/server/events.ts';
import { lookUpPostal } from '#lib/server/postal-codes.ts';
import { keepWeatherSetting, weatherSetting, weatherView } from '#lib/server/weather.ts';
import { isPostalCountry, type WeatherChange, type WeatherSetting } from '#lib/weather.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => json(await weatherView());

export const PUT: RequestHandler = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const country = typeof b.country === 'string' ? b.country.toUpperCase() : '';
  const postal = typeof b.postal === 'string' ? b.postal.trim() : '';
  const unit = b.unit;
  if (!isPostalCountry(country)) error(400, 'GeoNames has no postal codes for that country.');
  if (!postal || postal.length > 12) error(400, 'Type a postal code.');
  if (unit !== 'C' && unit !== 'F') error(400, 'Say C or F.');
  const kept = weatherSetting();
  let setting: WeatherSetting;
  if (kept && kept.country === country && kept.postal === postal) setting = { ...kept, unit };
  else {
    let found;
    try {
      found = await lookUpPostal(country, postal);
    } catch (e) {
      error(502, e instanceof Error ? e.message : 'GeoNames did not answer.');
    }
    if ('missing' in found) return json(found satisfies WeatherChange);
    const { place, lat, lon } = found.match;
    setting = { country, postal, place, lat, lon, unit };
  }
  keepWeatherSetting(setting);
  emit({ type: 'weather' });
  return json({ setting } satisfies WeatherChange);
};

export const DELETE: RequestHandler = async () => {
  keepWeatherSetting(null);
  emit({ type: 'weather' });
  return json({ ok: true });
};
