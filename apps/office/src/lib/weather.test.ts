// The weather's words, skies and units, and when the page asks. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  askNow,
  conditionWords,
  defaultUnit,
  overcast,
  shownTemperature,
  skyOf
} from './weather.ts';

test("MET Norway's symbols fall into the pill's skies", () => {
  const cases: [string, string][] = [
    ['clearsky_day', 'clear-day'],
    ['clearsky_night', 'clear-night'],
    ['clearsky_polartwilight', 'clear-day'],
    ['fair_night', 'partly-night'],
    ['partlycloudy_day', 'partly-day'],
    ['cloudy', 'cloudy'],
    ['fog', 'fog'],
    ['lightrain', 'rain'],
    ['rainshowers_day', 'rain'],
    ['heavysleet', 'sleet'],
    ['lightssleetshowersandthunder_night', 'thunder'],
    ['snow', 'snow'],
    ['heavyrainandthunder', 'thunder']
  ];
  for (const [symbol, sky] of cases) assert.equal(skyOf(symbol), sky, symbol);
});

test('the floor goes overcast for cloud, fog and anything falling, never for a clear or partly cloudy sky', () => {
  assert.deepEqual(
    (['clear-day', 'clear-night', 'partly-day', 'partly-night'] as const).map(overcast),
    [false, false, false, false]
  );
  assert.deepEqual((['cloudy', 'fog', 'rain', 'sleet', 'snow', 'thunder'] as const).map(overcast), [
    true,
    true,
    true,
    true,
    true,
    true
  ]);
});

test('symbols read as plain words', () => {
  assert.equal(conditionWords('lightrain'), 'Light rain');
  assert.equal(conditionWords('clearsky_night'), 'Clear');
  assert.equal(conditionWords('partlycloudy_day'), 'Partly cloudy');
  assert.equal(conditionWords('heavyrainshowersandthunder_day'), 'Heavy rain showers and thunder');
  assert.equal(
    conditionWords('lightssnowshowersandthunder_night'),
    'Light snow showers and thunder'
  );
  assert.equal(conditionWords('sleet'), 'Sleet');
});

test('°F for the countries that use it, and whole degrees', () => {
  assert.deepEqual(['US', 'LR', 'MM', 'GB', 'CA'].map(defaultUnit), ['F', 'F', 'F', 'C', 'C']);
  assert.equal(shownTemperature(9.2, 'C'), 9);
  assert.equal(shownTemperature(9.2, 'F'), 49);
  assert.equal(Object.is(shownTemperature(-0.4, 'C'), 0), true);
});

test('a hidden page asks nothing, and a seen one asks only when the answer is due', () => {
  assert.equal(askNow(false, 1000, 0), false);
  assert.equal(askNow(true, 1000, 0), true);
  assert.equal(askNow(true, 1000, 2000), false);
  // Off: nothing to ask until Setup turns it on.
  assert.equal(askNow(true, 1000, null), false);
});
