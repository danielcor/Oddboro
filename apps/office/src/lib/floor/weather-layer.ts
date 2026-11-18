// The weather on the floor, over whatever office is loaded. It reads only the
// world's own data: the windows the engine found (sprites tagged `window`),
// the cells and the room and hall boxes, which say what is outdoors (any
// cell in no indoor room or hall, and no wall), and the outdoor lamps.
//
// Two containers: `back` sits behind the walls with the window skies, for
// what shows through the panes (drifting clouds, rain, a flash); `front`
// lies over the floor, for what falls on the grounds (rain, sleet, snow,
// splashes), a fog haze, settled snow and lightning. Every falling mark
// comes from one pool made once (`POOL`); a step moves the marks it needs
// and hides the rest, and never allocates. Marks are wrapped into the view,
// so none is ever off screen. The engine calls `step` on its 12 a second
// ambient clock; a still sky (clear, cloudy, fog, settled snow that is not
// changing) changes nothing, so the floor draws nothing for it.
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { TILE, type PlacedLight, type World } from '@oddboro/world';
import {
  FLASH_FADE,
  POOL,
  flashStep,
  SEED,
  WEATHER_COLOURS,
  fallOf,
  fallRate,
  flashes,
  paneStreaks,
  placeFall,
  type Look,
  type RGB
} from './sky.ts';

type Box = { x: number; y: number; w: number; h: number };
type View = [number, number, number, number];

const toHex = (rgb: readonly number[]) =>
  (Math.round(rgb[0]) << 16) | (Math.round(rgb[1]) << 8) | Math.round(rgb[2]);
const tinted = (c: RGB, tint: RGB): number => toHex(c.map((v, i) => v * tint[i]));

/** A small texture of white pixels, which a sprite's tint colours from the palette. */
function pixels(w: number, h: number, on: [number, number][]): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  for (const [x, y] of on) ctx.fillRect(x, y, 1, 1);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

let art: Record<'drop' | 'long' | 'flake' | 'big' | 'splash' | 'cloud' | 'bolt' | 'pane', Texture>;
/** The weather's pixel art, made once for every floor. */
function shapes() {
  art ??= {
    drop: pixels(2, 4, [
      [1, 0],
      [1, 1],
      [0, 2],
      [0, 3]
    ]),
    long: pixels(3, 7, [
      [2, 0],
      [2, 1],
      [1, 2],
      [1, 3],
      [1, 4],
      [0, 5],
      [0, 6]
    ]),
    flake: pixels(1, 1, [[0, 0]]),
    big: pixels(2, 2, [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ]),
    splash: pixels(3, 2, [
      [1, 0],
      [0, 1],
      [2, 1]
    ]),
    cloud: pixels(7, 3, [
      [2, 0],
      [3, 0],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
      [6, 2]
    ]),
    // prettier-ignore
    bolt: pixels(5, 12, [[3, 0], [3, 1], [2, 2], [2, 3], [1, 4], [2, 5], [3, 5], [3, 6], [2, 7], [2, 8], [1, 9], [1, 10], [0, 11]]),
    pane: pixels(1, 3, [
      [0, 0],
      [0, 1],
      [0, 2]
    ])
  };
  return art;
}

const PANE_POOL = 120;
const SPLASH_POOL = 40;

export class WeatherLayer {
  readonly back = new Container();
  readonly front = new Container();
  private look: Look | undefined;
  private reduced = false;
  private windows: Box[] = [];
  private world: World | undefined;
  /** Per tile: 0 indoors, 1 grass or water outdoors, 2 a hard surface outdoors (splashes land there). */
  private ground: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  /** Per tile: lit by an outdoor lamp at night. */
  private lamplit: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private seeds = new Float32Array(POOL * SEED);
  private placed = new Float32Array(POOL * 2);
  private marks: Sprite[] = [];
  private splashes: Sprite[] = [];
  private panes: Sprite[] = [];
  private bolt: Sprite;
  private haze = new Graphics();
  private cover = new Graphics();
  private flashOut = new Graphics();
  private flashIn = new Graphics();
  /** The colours for now: the palette's, times the night's tint. */
  private colour = { rain: 0, stone: 0, snow: 0, lit: 0, cloud: 0 };
  private night = false;
  /** Seconds since the floor started, for the fall; frozen under reduced motion. */
  private last = 0;
  private flash = { at: -1, next: 0 };
  /** The step the drifting clouds last moved on. */
  private drifted = -1;
  /** Settled snow, 0 to 1: builds while it snows, fades after. */
  private settled = 0;
  private settledShown = 0;
  /** The last step moved something: the next still one must hide it once. */
  private moving = false;

  constructor() {
    const s = shapes();
    for (let i = 0; i < POOL; i++) this.marks.push(new Sprite(s.drop));
    for (let i = 0; i < SPLASH_POOL; i++) this.splashes.push(new Sprite(s.splash));
    for (let i = 0; i < PANE_POOL; i++) this.panes.push(new Sprite(s.pane));
    this.bolt = new Sprite(s.bolt);
    for (const g of [...this.marks, ...this.splashes, ...this.panes, this.bolt]) g.visible = false;
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = Math.random();
    this.flashOut.blendMode = this.flashIn.blendMode = 'add';
    this.flashOut.visible = this.flashIn.visible = false;
    this.haze.visible = this.cover.visible = false;
    this.back.addChild(...this.panes, this.flashIn);
    this.front.addChild(
      this.haze,
      this.cover,
      ...this.splashes,
      ...this.marks,
      this.flashOut,
      this.bolt
    );
  }

  /** How many marks the layer holds. It never makes more. */
  get poolSize(): number {
    return this.marks.length + this.splashes.length + this.panes.length;
  }

  /** Learn a new world: what is outdoors, its windows and lamps. Builds the haze and snow shapes once. */
  setWorld(world: World, windows: Box[]) {
    this.world = world;
    this.windows = windows;
    const { width: W, height: H } = world;
    const indoor = new Uint8Array(W * H);
    for (const r of [...world.rooms.filter((r) => !r.outdoor), ...world.halls])
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++)
          if (x >= 0 && y >= 0 && x < W && y < H) indoor[y * W + x] = 1;
    this.ground = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const c = world.cells[i];
      if (indoor[i] || c.kind === 'wall') continue;
      const soft = c.kind === 'void' || c.material === 'grass' || c.material === 'water';
      this.ground[i] = soft ? 1 : 2;
    }
    this.lamplit = lamps(world.lights, W, H);
    // The haze thins toward the building: by each outdoor tile's distance to the nearest indoor one.
    const near = distance(this.ground, W, H);
    this.haze.clear();
    this.cover.clear();
    this.flashOut.clear();
    const M = 48 * TILE;
    // The meadow past the grounds' edge, all of it outdoors and far from the building.
    for (const [x, y, w, h] of [
      [-M, -M, W * TILE + 2 * M, M],
      [-M, H * TILE, W * TILE + 2 * M, M],
      [-M, 0, M, H * TILE],
      [W * TILE, 0, M, H * TILE]
    ]) {
      this.haze.rect(x, y, w, h).fill({ color: 0xffffff, alpha: 0.32 });
      this.cover.rect(x, y, w, h).fill(0xffffff);
      this.flashOut.rect(x, y, w, h).fill(0xffffff);
    }
    // One rect per run of outdoor tiles in a row (per run of one haze level for the haze).
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        const i = y * W + x;
        if (!this.ground[i]) {
          x++;
          continue;
        }
        const level = Math.min(4, near[i]);
        let end = x;
        while (end < W && this.ground[y * W + end] && Math.min(4, near[y * W + end]) === level)
          end++;
        this.haze
          .rect(x * TILE, y * TILE, (end - x) * TILE, TILE)
          .fill({ color: 0xffffff, alpha: 0.06 + level * 0.065 });
        x = end;
      }
      x = 0;
      while (x < W) {
        if (!this.ground[y * W + x]) {
          x++;
          continue;
        }
        let end = x;
        while (end < W && this.ground[y * W + end]) end++;
        // Settled snow lies on the grass and paths, not on the water.
        this.cover.rect(x * TILE, y * TILE, (end - x) * TILE, TILE).fill(0xffffff);
        this.flashOut.rect(x * TILE, y * TILE, (end - x) * TILE, TILE).fill(0xffffff);
        x = end;
      }
    }
    this.flashIn.clear();
    for (const w of windows) this.flashIn.rect(w.x, w.y, w.w, w.h).fill(0xffffff);
  }

  /** Whether a world point is outdoors. Past the grounds' edge is the meadow, outdoors. */
  private outdoors(x: number, y: number): 0 | 1 | 2 {
    const W = this.world?.width ?? 0;
    const H = this.world?.height ?? 0;
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return 1;
    return this.ground[ty * W + tx] as 0 | 1 | 2;
  }

  /**
   * The sky and the hour changed: the colours, the haze, which pool each mark
   * draws from. `tint` is the night's tint, 0 to 1 a channel; `night` lights
   * the rain under street lamps.
   */
  setLook(look: Look | undefined, tint: RGB, night: boolean, reduced: boolean) {
    this.look = look;
    this.reduced = reduced;
    this.night = night;
    // Snow and the clouds stay readable at night: they catch what light there is.
    const soft: RGB = tint.map((v) => Math.max(v, 0.45)) as RGB;
    this.colour = {
      rain: tinted(WEATHER_COLOURS.rain, soft),
      stone: tinted(WEATHER_COLOURS.rainOnStone, soft),
      snow: tinted(WEATHER_COLOURS.snow, soft),
      lit: toHex(WEATHER_COLOURS.flash),
      cloud: tinted(WEATHER_COLOURS.snow, soft)
    };
    this.haze.visible = !!look?.haze;
    this.haze.tint = this.colour.rain;
    this.cover.tint = this.colour.snow;
    this.flashOut.tint = this.flashIn.tint = toHex(WEATHER_COLOURS.flash);
    const s = shapes();
    const { fall, strength } = look ? fallOf(look) : { fall: 'none', strength: 0 };
    for (let i = 0; i < POOL; i++) {
      const m = this.marks[i];
      const flake = fall === 'snow' || (fall === 'sleet' && this.seeds[i * SEED + 3] < 0.5);
      m.texture = flake
        ? this.seeds[i * SEED + 2] > 0.7
          ? s.big
          : s.flake
        : strength === 1
          ? s.drop
          : s.long;
      m.tint = flake ? this.colour.snow : this.colour.rain;
      m.alpha = flake ? 0.95 : 0.75;
      m.visible = false;
    }
    for (const p of this.panes) {
      p.texture = look?.drift ? s.cloud : s.pane;
      p.tint = look?.drift ? this.colour.cloud : this.colour.rain;
      p.alpha = look?.drift ? 1 : 0.7;
      p.visible = false;
    }
    for (const sp of this.splashes) {
      sp.tint = this.colour.stone;
      sp.alpha = 0.5;
      sp.visible = false;
    }
    if (!flashes(look, reduced)) this.flash = { at: -1, next: 0 };
    this.drifted = -1;
    this.moving = true;
  }

  /**
   * One tick of the ambient clock. Moves what falls and drifts, runs the
   * lightning, settles snow. Returns whether anything on screen changed.
   */
  step(now: number, view: View): boolean {
    const dt = Math.min(1, Math.max(0, now - this.last));
    this.last = now;
    const look = this.look;
    let changed = this.settle(look, dt);
    const { count } = look ? fallRate(look) : { count: 0 };
    const moves = !!look && (count > 0 || look.drift || flashes(look, this.reduced));
    if (!moves && !this.moving) return changed;
    // One more step after the sky stops moving, to hide what it drew.
    const hide = !moves;
    this.moving = moves;
    // Under reduced motion the marks hold still: the time stays at nought,
    // and only a camera move, which draws anyway, places them again.
    const t = this.reduced ? 0 : now;
    const fell = this.fall(look, t, view);
    const panes = this.inPanes(look, t, view);
    const flash = this.lightning(look, now, view);
    if (!this.reduced) changed ||= fell || panes;
    return changed || flash || hide;
  }

  private fall(look: Look | undefined, t: number, view: View): boolean {
    const n = look ? placeFall(this.seeds, look, t, view, this.placed) : 0;
    const lit = this.night;
    for (let i = 0; i < POOL; i++) {
      const m = this.marks[i];
      if (i >= n) {
        m.visible = false;
        continue;
      }
      const x = this.placed[i * 2];
      const y = this.placed[i * 2 + 1];
      const out = this.outdoors(x, y);
      m.visible = out > 0;
      if (!out) continue;
      m.x = x;
      m.y = y;
      if (m.texture === art.flake || m.texture === art.big) continue;
      // At night, rain under a street lamp catches its light. Over pale stone it is darker.
      const W = this.world?.width ?? 0;
      const under =
        lit &&
        x >= 0 &&
        y >= 0 &&
        x < W * TILE &&
        this.lamplit[Math.floor(y / TILE) * W + Math.floor(x / TILE)] === 1;
      m.tint = under ? this.colour.lit : out === 2 ? this.colour.stone : this.colour.rain;
    }
    // Splashes: a few flecks on hard ground, each where a drop lands, for one tick.
    const rainy = look && fallOf(look).fall !== 'snow' && !this.reduced;
    let k = 0;
    if (rainy)
      for (let i = 0; i < n && k < SPLASH_POOL; i += 3) {
        const x = this.placed[i * 2];
        const y = this.placed[i * 2 + 1] + 6;
        if (this.outdoors(x, y) !== 2 || (i + Math.floor(t * 12)) % 5) continue;
        const sp = this.splashes[k++];
        sp.x = x - 1;
        sp.y = y;
        sp.visible = true;
      }
    for (; k < SPLASH_POOL; k++) this.splashes[k].visible = false;
    return n > 0;
  }

  /** Rain streaks or drifting clouds in each window pane on screen. */
  private inPanes(look: Look | undefined, t: number, view: View): boolean {
    const per = look ? (look.drift ? 1 : paneStreaks(look)) : 0;
    const [vx, vy, vw, vh] = view;
    let k = 0;
    if (per)
      for (const [wi, w] of this.windows.entries()) {
        if (w.x + w.w < vx || w.x > vx + vw || w.y + w.h < vy || w.y > vy + vh) continue;
        for (let j = 0; j < per && k < PANE_POOL; j++) {
          const p = this.panes[k++];
          const seed = this.seeds[((wi * 3 + j) % POOL) * SEED];
          if (look!.drift) {
            // A cloud crossing the pane, a pixel every two seconds, all in step.
            const span = Math.max(1, w.w - 7);
            p.x = w.x + (Math.floor(seed * span + t / 2) % span);
            p.y = w.y + 2 + Math.floor(seed * Math.max(1, w.h / 2 - 3));
          } else {
            const span = Math.max(1, w.h - 3);
            p.x = w.x + 2 + Math.floor(seed * Math.max(1, w.w - 4));
            p.y = w.y + (Math.floor(seed * span + t * 24) % span);
          }
          p.visible = true;
        }
      }
    for (; k < PANE_POOL; k++) this.panes[k].visible = false;
    if (!per) return false;
    if (!look!.drift) return true;
    const step = Math.floor(t / 2);
    const moved = step !== this.drifted;
    this.drifted = step;
    return moved;
  }

  /** A soft flash every 8 to 25 seconds, over a third of a second, and now and then a bolt. */
  private lightning(look: Look | undefined, now: number, view: View): boolean {
    const was = this.flashOut.visible || this.bolt.visible;
    if (!flashes(look, this.reduced)) {
      this.flashOut.visible = this.flashIn.visible = this.bolt.visible = false;
      return was;
    }
    if (flashStep(this.flash, now, Math.random)) this.strike(view);
    const a = this.flash.at >= 0 ? FLASH_FADE[this.flash.at] : 0;
    this.flashOut.visible = this.flashIn.visible = a > 0;
    this.flashOut.alpha = a;
    this.flashIn.alpha = a * 1.6;
    this.bolt.visible &&= this.flash.at >= 0 && this.flash.at < 2;
    return a > 0 || was;
  }

  /** Light the scene; one flash in three draws a bolt over the grounds. */
  private strike(view: View, bolt = Math.random() < 0.34) {
    this.bolt.visible = false;
    if (!bolt) return;
    const [vx, vy, vw, vh] = view;
    for (let i = 0; i < 12; i++) {
      const x = Math.round(vx + Math.random() * vw);
      const y = Math.round(vy + Math.random() * vh * 0.5);
      if (this.outdoors(x, y + 12) !== 1) continue;
      this.bolt.position.set(x, y);
      this.bolt.visible = true;
      return;
    }
  }

  /**
   * Settled snow builds over 15 minutes while it snows and fades over 30
   * after. It changes the floor only when its shade changes a step.
   */
  private settle(look: Look | undefined, dt: number): boolean {
    const snowing = !!look && fallOf(look).fall === 'snow';
    if (!snowing && this.settled === 0) return false;
    this.settled = Math.min(1, Math.max(0, this.settled + (snowing ? dt / 900 : -dt / 1800)));
    const shown = Math.round(this.settled * 40) / 40;
    if (shown === this.settledShown) return false;
    this.settledShown = shown;
    this.cover.alpha = shown * 0.3;
    this.cover.visible = shown > 0;
    return true;
  }

  /** For a screenshot or a test: snow that has lain for this long already. */
  settleFor(fraction: number) {
    this.settled = this.settledShown = fraction;
    this.cover.alpha = fraction * 0.3;
    this.cover.visible = fraction > 0;
  }

  /** For a screenshot: flash now. */
  flashNow(view: View) {
    if (!flashes(this.look, this.reduced)) return;
    this.flash = { at: 0, next: this.last + 8 };
    this.strike(view, true);
    this.flashOut.visible = this.flashIn.visible = true;
    this.flashOut.alpha = FLASH_FADE[0];
    this.flashIn.alpha = FLASH_FADE[0] * 1.6;
  }
}

/** Per tile: 1 where an outdoor lamp's light falls, within half its reach. */
function lamps(lights: PlacedLight[], W: number, H: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(W * H);
  for (const l of lights) {
    if (!l.outdoor) continue;
    const r = (l.radius * 0.5) / TILE;
    const cx = l.x / TILE;
    const cy = l.y / TILE;
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++)
        if (x >= 0 && y >= 0 && x < W && y < H && (x - cx) ** 2 + (y - cy) ** 2 <= r * r)
          out[y * W + x] = 1;
  }
  return out;
}

/** Each outdoor tile's distance in tiles to the nearest indoor one, by a sweep both ways. */
function distance(ground: Uint8Array, W: number, H: number): Uint16Array {
  const d = new Uint16Array(W * H).fill(9999);
  for (let i = 0; i < W * H; i++) if (!ground[i]) d[i] = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y) d[i] = Math.min(d[i], d[i - W] + 1);
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y < H - 1) d[i] = Math.min(d[i], d[i + W] + 1);
    }
  return d;
}
