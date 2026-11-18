// The page's weather: what the office served last, shared by the pill and
// Setup. The page asks the office only while it is seen, and only once the
// office's answer says the next is due (`next`); the office answers from its
// own cache until MET Norway's answer expires. A hidden page asks nothing and
// catches up when it is seen again. The page's own clock and its
// visibilitychange call `askWeather`; a change in Setup, here or in another
// window, comes on the live line and asks at once.
import { askNow, type WeatherChange, type WeatherSetting, type WeatherView } from '#lib/weather.ts';
import { call } from './api.ts';

export const weather = $state<WeatherView>({
  setting: null,
  report: null,
  problem: '',
  // Ask once as the page opens.
  next: 0
});

let asking = false;

/** Ask the office when the answer is due and the page is seen. `soon` makes it due now. */
export async function askWeather(soon = false): Promise<void> {
  if (soon) weather.next = 0;
  if (asking || !askNow(document.visibilityState === 'visible', Date.now(), weather.next)) return;
  asking = true;
  try {
    Object.assign(weather, await call<WeatherView>('/api/weather'));
  } catch (e) {
    // The office itself did not answer: keep what is shown, and try again in five minutes.
    weather.problem = e instanceof Error ? e.message : String(e);
    weather.next = Date.now() + 5 * 60_000;
  } finally {
    asking = false;
  }
}

/** Turn weather on, or change its place or unit. Throws with the office's message. */
export async function setWeather(
  country: string,
  postal: string,
  unit: WeatherSetting['unit']
): Promise<WeatherChange> {
  const change = await call<WeatherChange>('/api/weather', { country, postal, unit }, 'PUT');
  if ('setting' in change) {
    // A new place shows nothing of the old one's weather.
    if (change.setting.place !== weather.setting?.place) weather.report = null;
    weather.setting = change.setting;
    void askWeather(true);
  }
  return change;
}

export async function weatherOff(): Promise<void> {
  await call('/api/weather', undefined, 'DELETE');
  Object.assign(weather, { setting: null, report: null, problem: '', next: null });
}
