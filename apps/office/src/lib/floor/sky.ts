// What the floor draws for each of MET Norway's symbols, as plain data and
// arithmetic, so it can be tested without a canvas: what falls and how hard,
// whether it thunders, the sky's colours behind the windows, how far a
// cloudy day dims the scene, and when lightning flashes. The drawing is
// `weather-layer.ts`.
import palette from '@oddboro/sprites/palette.json' with { type: 'json' };
import { overcast, skyOf, type Sky } from '../weather.ts';

export type RGB = [number, number, number];
export type Fall = 'none' | 'rain' | 'sleet' | 'snow';

/** One symbol, as the floor shows it. */
export type Look = {
  sky: Sky;
  fall: Fall;
  /** 1 light, 2 steady, 3 heavy, from the symbol's light or heavy. 0 when nothing falls. */
  strength: 0 | 1 | 2 | 3;
  thunder: boolean;
  /** Clouds drift across the window panes. */
  drift: boolean;
  /** A haze lies over the grounds. */
  haze: boolean;
  /** The windows go grey and no sun shafts fall. */
  overcast: boolean;
};

/** The floor's look for a symbol, or undefined for the clock's own sky. */
export function lookOf(symbol: string | undefined): Look | undefined {
  if (!symbol) return undefined;
  const sky = skyOf(symbol);
  const base = symbol.split('_')[0];
  const fall: Fall = base.includes('sleet')
    ? 'sleet'
    : base.includes('snow')
      ? 'snow'
      : base.includes('rain')
        ? 'rain'
        : 'none';
  const strength =
    fall === 'none' ? 0 : base.startsWith('light') ? 1 : base.startsWith('heavy') ? 3 : 2;
  return {
    sky,
    fall,
    strength,
    // Thunder with nothing named falling still rains.
    thunder: sky === 'thunder',
    drift: sky === 'partly-day' || sky === 'partly-night',
    haze: sky === 'fog',
    overcast: overcast(sky)
  } satisfies Look;
}

/** What falls when thunder names nothing: steady rain. */
export const fallOf = (look: Look): { fall: Fall; strength: 0 | 1 | 2 | 3 } =>
  look.thunder && look.fall === 'none'
    ? { fall: 'rain', strength: 2 }
    : { fall: look.fall, strength: look.strength };

/** Every falling mark the floor ever draws comes from one pool of this size, made once. */
export const POOL = 640;
/** Marks per light, steady and heavy fall. Heavy rain stays well inside the pool. */
const COUNT: Record<Exclude<Fall, 'none'>, [number, number, number]> = {
  rain: [170, 340, 600],
  sleet: [150, 300, 500],
  snow: [140, 280, 480]
};
/** World pixels a second a mark falls: rain by strength, snow drifts. */
const SPEED: Record<Exclude<Fall, 'none'>, [number, number, number]> = {
  rain: [110, 150, 200],
  sleet: [70, 90, 120],
  snow: [12, 16, 22]
};

/** How many marks fall, and how fast. */
export function fallRate(look: Look): { count: number; speed: number } {
  const { fall, strength } = fallOf(look);
  if (fall === 'none' || !strength) return { count: 0, speed: 0 };
  return { count: COUNT[fall][strength - 1], speed: SPEED[fall][strength - 1] };
}

/** Streaks in each window pane, by strength. */
export const paneStreaks = (look: Look): number =>
  fallOf(look).fall === 'none' ? 0 : fallOf(look).strength;

/** Each seed is four numbers in [0, 1): across, down, pace and kind. */
export const SEED = 4;

/**
 * Where each falling mark is at time `t` (seconds), wrapped into the view so
 * every mark is on screen and the field stays fixed to the world as the
 * camera moves. Writes x, y pairs into `out`, never allocating.
 * Snow sways; sleet is half rain, half flakes (a seed's kind under 0.5 is a flake).
 */
export function placeFall(
  seeds: Float32Array,
  look: Look,
  t: number,
  view: readonly [number, number, number, number],
  out: Float32Array
): number {
  const { count, speed } = fallRate(look);
  const { fall } = fallOf(look);
  const [vx, vy, vw, vh] = view;
  const n = Math.min(count, out.length / 2, seeds.length / SEED);
  for (let i = 0; i < n; i++) {
    const s = i * SEED;
    const pace = 0.8 + 0.4 * seeds[s + 2];
    const flake = fall === 'snow' || (fall === 'sleet' && seeds[s + 3] < 0.5);
    const v = flake && fall === 'sleet' ? speed * 0.4 : speed;
    const fy = seeds[s + 1] * 4096 + t * v * pace;
    const sway = flake ? Math.sin(t * 1.3 + seeds[s + 2] * 6.283) * 3 : 0;
    // Rain slants a little toward the start edge as it falls.
    const fx = seeds[s] * 4096 - (flake ? t * v * 0.15 : t * v * pace * 0.3) + sway;
    out[i * 2] = Math.round(vx + ((((fx - vx) % vw) + vw) % vw));
    out[i * 2 + 1] = Math.round(vy + ((((fy - vy) % vh) + vh) % vh));
  }
  return n;
}

/** Seconds between lightning flashes: 8 to 25, at random. Never under 3, the most a flash may come. */
export const FLASH_GAP: [number, number] = [8, 25];
export const flashGap = (random: number): number =>
  FLASH_GAP[0] + Math.min(Math.max(random, 0), 1) * (FLASH_GAP[1] - FLASH_GAP[0]);

/**
 * A flash's brightness at each tick of the 12 a second ambient clock: soft,
 * and gone in a third of a second.
 */
export const FLASH_FADE = [0.24, 0.15, 0.08, 0.03] as const;

/** Lightning's state: the fade step showing (-1 for none) and when the next flash is due. */
export type FlashState = { at: number; next: number };

/**
 * One tick of the lightning: move the fade on, and flash when one is due.
 * Returns whether a flash starts now. A new flash waits a fresh 8 to 25
 * seconds, so two never come within 3 seconds.
 */
export function flashStep(s: FlashState, now: number, random: () => number): boolean {
  if (s.next === 0) s.next = now + flashGap(random());
  if (s.at >= 0) s.at = s.at + 1 < FLASH_FADE.length ? s.at + 1 : -1;
  if (s.at >= 0 || now < s.next) return false;
  s.at = 0;
  s.next = now + flashGap(random());
  return true;
}

/** Whether this look flashes at all. Never under reduced motion. */
export const flashes = (look: Look | undefined, reducedMotion: boolean): boolean =>
  !!look?.thunder && !reducedMotion;

/** A colour from the house palette, as RGB. */
export function paletteRgb(key: keyof typeof palette.colors): RGB {
  const hex = palette.colors[key].hex;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
}

/** The palette's colours the weather draws with. */
export const WEATHER_COLOURS = {
  /** Rain, splashes, the haze, and streaks in the panes. */
  rain: paletteRgb('m'),
  /** Rain over pale stone, the street and pavement, where the light grey would vanish. */
  rainOnStone: paletteRgb('M'),
  /** Snow, the clouds in the panes and settled snow. */
  snow: paletteRgb('='),
  /** Lightning, and rain that catches a street lamp. */
  flash: paletteRgb('l')
};

const luma = (c: RGB) => (c[0] + c[1] + c[2]) / 3;
const mix = (a: RGB, b: RGB, t: number): RGB =>
  [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * t) as RGB;

/**
 * One band of the sky behind the windows, from the clock's colour: partly
 * cloudy softened toward grey and lighter, every overcast sky grey at the
 * hour's brightness, darker under rain or snow, darkest in a storm.
 */
export function skyBand(c: RGB, look: Look | undefined): RGB {
  if (!look || look.sky === 'clear-day' || look.sky === 'clear-night') return c;
  const grey: RGB = [luma(c), luma(c), luma(c)];
  // Partly cloudy keeps enough blue that the white clouds crossing the panes read.
  if (look.drift) return mix(mix(c, grey, 0.25), WEATHER_COLOURS.snow, 0.05);
  const dark = look.thunder ? 0.6 : look.fall !== 'none' ? 0.82 : 1;
  return grey.map((v) => v * dark) as RGB;
}

/** How much the weather dims the whole scene by day: a grey day is a little darker. */
export function dimOf(look: Look | undefined): number {
  if (!look || !look.overcast) return 1;
  if (look.thunder) return 0.7;
  if (look.fall === 'rain' || look.fall === 'sleet') return 0.82;
  return 0.9;
}
