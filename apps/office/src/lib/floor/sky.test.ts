// What the floor draws for each MET Norway symbol, the lightning's timing,
// and the one pool every falling mark comes from. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FLASH_FADE,
  FLASH_GAP,
  POOL,
  SEED,
  fallRate,
  flashGap,
  flashStep,
  flashes,
  lookOf,
  placeFall,
  skyBand,
  type RGB
} from './sky.ts';

/** Every symbol MET Norway's forecast uses, without its _day, _night or _polartwilight. */
const SYMBOLS = [
  'clearsky', 'fair', 'partlycloudy', 'cloudy', 'fog',
  'lightrain', 'rain', 'heavyrain', 'lightrainshowers', 'rainshowers', 'heavyrainshowers',
  'lightrainandthunder', 'rainandthunder', 'heavyrainandthunder',
  'lightrainshowersandthunder', 'rainshowersandthunder', 'heavyrainshowersandthunder',
  'lightsleet', 'sleet', 'heavysleet', 'lightsleetshowers', 'sleetshowers', 'heavysleetshowers',
  'lightsleetandthunder', 'sleetandthunder', 'heavysleetandthunder',
  'lightssleetshowersandthunder', 'sleetshowersandthunder', 'heavysleetshowersandthunder',
  'lightsnow', 'snow', 'heavysnow', 'lightsnowshowers', 'snowshowers', 'heavysnowshowers',
  'lightsnowandthunder', 'snowandthunder', 'heavysnowandthunder',
  'lightssnowshowersandthunder', 'snowshowersandthunder', 'heavysnowshowersandthunder'
]; // prettier-ignore

test('each symbol falls as its kind, at its strength', () => {
  const pick = (s: string) => {
    const l = lookOf(s)!;
    return [l.fall, l.strength, l.thunder, l.drift, l.haze, l.overcast];
  };
  assert.deepEqual(pick('clearsky_day'), ['none', 0, false, false, false, false]);
  assert.deepEqual(pick('fair_night'), ['none', 0, false, true, false, false]);
  assert.deepEqual(pick('partlycloudy_day'), ['none', 0, false, true, false, false]);
  assert.deepEqual(pick('cloudy'), ['none', 0, false, false, false, true]);
  assert.deepEqual(pick('fog'), ['none', 0, false, false, true, true]);
  assert.deepEqual(pick('lightrain'), ['rain', 1, false, false, false, true]);
  assert.deepEqual(pick('rainshowers_day'), ['rain', 2, false, false, false, true]);
  assert.deepEqual(pick('heavyrain'), ['rain', 3, false, false, false, true]);
  assert.deepEqual(pick('heavysleet'), ['sleet', 3, false, false, false, true]);
  assert.deepEqual(pick('lightsnowshowers_night'), ['snow', 1, false, false, false, true]);
  assert.deepEqual(pick('heavyrainandthunder'), ['rain', 3, true, false, false, true]);
  assert.deepEqual(pick('lightssnowshowersandthunder_day'), ['snow', 1, true, false, false, true]);
  assert.equal(lookOf(undefined), undefined);
});

test('heavier symbols fall thicker and faster, and every one fits the pool', () => {
  const rate = (s: string) => fallRate(lookOf(s)!);
  assert.ok(rate('lightrain').count < rate('rain').count);
  assert.ok(rate('rain').count < rate('heavyrain').count);
  assert.ok(rate('lightrain').speed < rate('heavyrain').speed);
  assert.ok(rate('lightsnow').count < rate('heavysnow').count);
  assert.ok(rate('snow').speed < rate('rain').speed);
  assert.deepEqual(rate('cloudy'), { count: 0, speed: 0 });
  for (const s of SYMBOLS) assert.ok(rate(s).count <= POOL, s);
});

test('placing the fall writes into the same buffers every tick, inside the view', () => {
  const seeds = new Float32Array(POOL * SEED).map((_, i) => ((i * 7919) % 1000) / 1000);
  const out = new Float32Array(POOL * 2);
  const view = [100, 50, 400, 300] as const;
  for (const s of SYMBOLS)
    for (const t of [0, 1.5, 3600.25]) {
      const n = placeFall(seeds, lookOf(s)!, t, view, out);
      assert.equal(out.length, POOL * 2);
      assert.equal(n, fallRate(lookOf(s)!).count);
      for (let i = 0; i < n; i++) {
        assert.ok(out[i * 2] >= 100 && out[i * 2] <= 500, `${s} x`);
        assert.ok(out[i * 2 + 1] >= 50 && out[i * 2 + 1] <= 350, `${s} y`);
      }
    }
});

test('lightning waits 8 to 25 seconds between flashes, never two within 3, and fades in a third of a second', () => {
  assert.equal(flashGap(0), FLASH_GAP[0]);
  assert.equal(flashGap(1), FLASH_GAP[1]);
  assert.ok(FLASH_GAP[0] >= 3);
  assert.ok(FLASH_FADE.length / 12 <= 1 / 3 + 1e-9);
  assert.ok(
    FLASH_FADE.every((a) => a > 0 && a < 0.5),
    'soft, never full white'
  );
  // A long storm at the ambient clock's 12 ticks a second, with a seeded random.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const state = { at: -1, next: 0 };
  const struck: number[] = [];
  for (let tick = 0; tick < 12 * 3600; tick++)
    if (flashStep(state, tick / 12, random)) struck.push(tick / 12);
  assert.ok(struck.length > 100);
  for (let i = 1; i < struck.length; i++) {
    const gap = struck[i] - struck[i - 1];
    assert.ok(gap >= FLASH_GAP[0] - 1 / 12 && gap <= FLASH_GAP[1] + 1 / 12, `gap ${gap}`);
  }
});

test('reduced motion never flashes, and only thunder flashes', () => {
  assert.equal(flashes(lookOf('heavyrainandthunder'), true), false);
  assert.equal(flashes(lookOf('heavyrainandthunder'), false), true);
  assert.equal(flashes(lookOf('heavyrain'), false), false);
  assert.equal(flashes(undefined, false), false);
});

test('the window sky: the clock’s own when clear, grey when overcast, darkest in a storm', () => {
  const noon: RGB = [96, 170, 240];
  assert.deepEqual(skyBand(noon, lookOf('clearsky_day')), noon);
  assert.deepEqual(skyBand(noon, lookOf('cloudy')), [506 / 3, 506 / 3, 506 / 3]);
  const storm = skyBand(noon, lookOf('rainandthunder'))[0];
  const rain = skyBand(noon, lookOf('rain'))[0];
  assert.ok(storm < rain && rain < 506 / 3);
  const partly = skyBand(noon, lookOf('partlycloudy_day'));
  assert.ok(partly[2] < noon[2] && partly[0] > noon[0], 'softer and lighter');
});
