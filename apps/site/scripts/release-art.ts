// The art on /releases/: one looping GIF per release that has one, built on
// the desk vignette (an Odd typing at its desk), the office's front door, a
// hallway or the gym, and a still of its last frame for visitors who ask for reduced motion. art.ts calls this once per
// theme, with the vignette's layers lit for night or for day, so every
// animation added here comes in both. Every colour added here is the house
// palette's, and `shade` lights it the way the room is lit.
//
//   hello-world   the screen answers the Odd's typing: "HELLO, WORLD!" fills
//                 a speech bubble one letter at a time (0.0.1)
//   stuck-sign-in Ada walks into the shut front door, three times, backs off
//                 and wonders why (0.0.2, the stuck sign-in fix)
//   linux         the screen flashes and a penguin jumps out of it, arcs over
//                 the desk and lands on the floor (0.0.3)
//   locked-door   the open front door's two leaves slide shut together in
//                 front of Ada, she locks it, CLICK, steps back with a
//                 padlock on it and faces the street (0.0.4, the office
//                 takes actions only from its own page)
//   windows       Ada walks an endless hallway, a window in every other
//                 tile: windows, on Windows, on Windows (0.0.5, the Windows
//                 app). The loop has no start: its last frame leads into its
//                 first.
//   hand-off      a relay in the same hall, one pun a hand-off: HAND-OFF!,
//                 HANDS ON!, FOLDER AND WISER, CODEX MARKS THE SPOT, GROK ON!,
//                 LESSON? IT STUCK., NO BRAINER!, BACKSIES! (0.0.6: hand-offs,
//                 folders, Codex and Grok, lessons, keys for hosted tools, and
//                 the Revoke fix)
//   loop          Ada walks the hall, off the end and in again at the start:
//                 UPDATING!, AGAIN?, AND AGAIN?. The fourth time she stops
//                 and turns to you: OUT OF THE LOOP! (0.0.7, the Windows
//                 update that installed itself over and over)
//   gym           Theo jogs round the office's gym: the treadmill, the bike,
//                 curls at the dumbbells, the bar off the rack, and presses
//                 on the bench (0.0.8)
//   personas      inside the lobby, the front doors slide open, smoke pours
//                 in, and Nate, Michele and Sam Frank walk out of it in gold
//                 shades and strike a pose. The camera pushes in on their
//                 faces, the shades come off together, and they walk off,
//                 Michele one way and the other two the other (0.0.9, New
//                 Altitude personas)
//   bug-hunters   a white van marked BUG HUNTERS pulls up in front of the
//                 office, its back doors swing open, and two bug hunters in
//                 yellow suits, hoods, masks and spray tanks hop out and walk
//                 in through the front door (0.0.10, a release of bug fixes)
//   advanced      at the desk, a wall switch marked ADVANCED flips on by
//                 itself (the owner, off screen), the monitor flashes and
//                 grows into a wide terminal titled PROJECTS, and lines of
//                 code type out and scroll while the Odd works (0.0.11,
//                 Claude Code and Codex projects behind Advanced mode)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createImage, drawImage, encodePng, scaleImage, type Image } from '@oddboro/sprites/png';
import { hexToRgba } from '@oddboro/sprites/px';
import { encodeGif, type GifFrame } from './gif.ts';

export type DeskLayers = {
  /** The room, lit, without the Odd. */
  room: Image;
  /** What stands in front of the Odd. */
  front: Image;
  /** The Odd typing, one image per frame, already lit and placed. */
  odd: Image[];
  /** Lights an added sprite the way the room's lamp lights the Odd. */
  shade: (img: Image) => Image;
};

const PALETTE = JSON.parse(
  readFileSync(new URL('../../../packages/sprites/src/palette.json', import.meta.url), 'utf8')
).colors as Record<string, { hex: string }>;

/** The office's front door, shut, and the sidewalk below it. */
export type DoorLayers = {
  /** The street and the building's front, lit, with no Odd. */
  room: Image;
  /** The door, in the room's pixels. */
  door: { x: number; y: number; w: number; h: number };
  /** The door open, lit, the size of `door`, to draw over the shut one. */
  open: Image;
  /** Ada in one sprite frame, like `walk-up-2`, lit, 16 by 32. */
  odd: (frame: string) => Image;
};

/** A hallway that repeats, to walk along forever. */
export type HallLayers = {
  /** The hall, lit, wider than the view on both sides, repeating every `period` pixels. */
  room: Image;
  period: number;
  /** The view's size. It starts one period in. */
  view: { w: number; h: number };
  /** Ada in one sprite frame, like `walk-side-2`, lit, 16 by 32. */
  odd: (frame: string) => Image;
  /** Theo, the same way, for the art that needs a colleague. */
  mate: (frame: string) => Image;
  /** Lights an added sprite the way the hall is lit. */
  shade: (img: Image) => Image;
};

/** A place in the art's pixels: a sprite's top-left corner. */
type Point = { x: number; y: number };

/** The office's gym, packed into one view, with Theo to work out in it. */
export type GymLayers = {
  /** The gym, lit, one image per frame of the treadmill's belt. */
  room: Image[];
  /** The same gym with the bar lifted off the rack. */
  unracked: Image;
  view: { w: number; h: number };
  /** Where Theo stands at each station, as his sprite's top-left. */
  at: Record<'run' | 'cycle' | 'curl' | 'rack' | 'bench', Point>;
  /** The rack's loaded bar, lit, where it rests on the rack, and its middle row. */
  bar: { img: Image; x: number; y: number; mid: number };
  /** Theo in one sprite frame, like `exercise-run-2`, lit, 16 by 32. */
  odd: (frame: string) => Image;
};

/** The three New Altitude personas 0.0.9 brings in. */
export type Persona = 'nate' | 'michele' | 'sam';

/** The lobby seen from inside, facing the front doors, with the personas to walk in. */
export type EntranceLayers = {
  /** The lobby, lit, once for each step of the doors: shut, three sliding, open. */
  room: Image[];
  view: { w: number; h: number };
  /** The doorway's face in the view's pixels, below the wall's cap. */
  door: { x: number; y: number; w: number; h: number };
  /** Each persona in one sprite frame, like `walk-down-2`, lit, 16 by 32. */
  odd: Record<Persona, (frame: string) => Image>;
  /** How far a frame moves the head from where it sits standing, for the shades. */
  head: (frame: string) => [number, number];
  /** Lights an added sprite the way the lobby is lit. */
  shade: (img: Image) => Image;
};

/** The street in front of the office, from the front door down across the near lane. */
export type CurbLayers = {
  /** The building's front, the sidewalk and the near lane, lit, the view's width and taller. */
  room: Image;
  view: { w: number; h: number };
  /** The front door, in the room's pixels. */
  door: { x: number; y: number; w: number; h: number };
  /** The door open, lit, the size of `door`. */
  open: Image;
  /** The near lane's top row, in the room's pixels. */
  lane: number;
  /** A bug hunter in one sprite frame, like `walk-up-2`: suit, boots and gloves, lit, 16 by 32. */
  odd: (frame: string) => Image;
  /** How far a frame moves the head and the torso from where they sit standing. */
  head: (frame: string) => [number, number];
  torso: (frame: string) => [number, number];
  /** Lights an added sprite the way the street is lit. */
  shade: (img: Image) => Image;
};

export type Layers = {
  curb: CurbLayers;
  desk: DeskLayers;
  door: DoorLayers;
  hall: HallLayers;
  gym: GymLayers;
  entrance: EntranceLayers;
};

/** A sprite drawn in palette keys, one character per pixel, `.` see-through. */
function sprite(rows: string[]): Image {
  const img = createImage(rows[0].length, rows.length);
  rows.forEach((row, y) =>
    [...row].forEach((key, x) => {
      if (key !== '.') img.data.set(hexToRgba(PALETTE[key].hex), (y * img.width + x) * 4);
    })
  );
  return img;
}

// The penguin: ink body, paper belly and eyes, amber beak and feet. Wings up
// in the air, at its sides on the ground, and its eyes shut for a blink.
const PENGUIN = [
  '...kkkk...',
  '..kkkkkk..',
  '..k=kk=k..',
  '..kkkkkk..',
  '..kkyykk..',
  '.kk=yy=kk.',
  '.k======k.',
  'kk======kk',
  'kk======kk',
  '.k======k.',
  '.kk====kk.',
  '..kkkkkk..',
  '.yyy..yyy.'
];
const PENGUIN_FLY = PENGUIN.map((r, y) =>
  y === 5 ? 'kkk=yy=kkk' : y === 7 || y === 8 ? '.k======k.' : r
);
const PENGUIN_BLINK = PENGUIN.map((r, y) => (y === 2 ? '..kkkkkk..' : r));

// The screen of the left desk's monitor, in the vignette's pixels.
const SCREEN = { x: 58, y: 22, w: 10, h: 6 };
const FLASH = 'g';

/** A 5-pixel-high capital font, enough for the hello. */
const GLYPHS: Record<string, string[]> = {
  H: ['x.x', 'x.x', 'xxx', 'x.x', 'x.x'],
  E: ['xxx', 'x..', 'xx.', 'x..', 'xxx'],
  L: ['x..', 'x..', 'x..', 'x..', 'xxx'],
  O: ['.x.', 'x.x', 'x.x', 'x.x', '.x.'],
  W: ['x...x', 'x...x', 'x.x.x', 'x.x.x', '.x.x.'],
  R: ['xx.', 'x.x', 'xx.', 'x.x', 'x.x'],
  D: ['xx.', 'x.x', 'x.x', 'x.x', 'xx.'],
  ',': ['.', '.', '.', 'x', 'x'],
  '!': ['x', 'x', 'x', '.', 'x'],
  '?': ['xx.', '..x', '.x.', '...', '.x.'],
  C: ['.xx', 'x..', 'x..', 'x..', '.xx'],
  I: ['xxx', '.x.', '.x.', '.x.', 'xxx'],
  J: ['..x', '..x', '..x', 'x.x', '.x.'],
  K: ['x.x', 'x.x', 'xx.', 'x.x', 'x.x'],
  A: ['.x.', 'x.x', 'xxx', 'x.x', 'x.x'],
  B: ['xx.', 'x.x', 'xx.', 'x.x', 'xx.'],
  F: ['xxx', 'x..', 'xx.', 'x..', 'x..'],
  G: ['.xx', 'x..', 'x.x', 'x.x', '.xx'],
  M: ['x...x', 'xx.xx', 'x.x.x', 'x...x', 'x...x'],
  N: ['x..x', 'xx.x', 'x.xx', 'x..x', 'x..x'],
  P: ['xx.', 'x.x', 'xx.', 'x..', 'x..'],
  S: ['.xx', 'x..', '.x.', '..x', 'xx.'],
  T: ['xxx', '.x.', '.x.', '.x.', '.x.'],
  U: ['x.x', 'x.x', 'x.x', 'x.x', 'xxx'],
  X: ['x.x', 'x.x', '.x.', 'x.x', 'x.x'],
  V: ['x.x', 'x.x', 'x.x', 'x.x', '.x.'],
  '-': ['..', '..', 'xx', '..', '..'],
  '.': ['.', '.', '.', '.', 'x'],
  ' ': ['..', '..', '..', '..', '..']
};
const HELLO = 'HELLO, WORLD!';

const width = (text: string) =>
  [...text].reduce((w, ch, i) => w + GLYPHS[ch][0].length + (i ? 1 : 0), 0);

/**
 * A bubble with the first `shown` letters of `text`, its tail down at column
 * `tail` (its start, unless a bubble near the art's edge moves it).
 */
function bubble(shown: number, text = HELLO, tail = 3): Image {
  const w = width(text) + 6;
  const h = 11;
  const t = tail;
  const rows: string[] = [];
  for (let y = 0; y < h + 3; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const corner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
      const edge = x === 0 || x === w - 1 || y === 0 || y === h - 1;
      if (y < h) row += corner ? '.' : edge ? 'k' : '=';
      // The tail: three rows narrowing toward the bubble's start.
      else if (y === h)
        row += x === t ? 'k' : x === t + 1 || x === t + 2 ? '=' : x === t + 3 ? 'k' : '.';
      else if (y === h + 1) row += x === t ? 'k' : x === t + 1 ? '=' : x === t + 2 ? 'k' : '.';
      else row += x === t || x === t + 1 ? 'k' : '.';
    }
    rows.push(row);
  }
  // Opening the bubble's bottom edge over the tail.
  rows[h - 1] = rows[h - 1].slice(0, t + 1) + '==' + rows[h - 1].slice(t + 3);
  const img = sprite(rows);
  let x = 3;
  [...text].slice(0, shown).forEach((ch) => {
    const glyph = GLYPHS[ch];
    glyph.forEach((row, gy) =>
      [...row].forEach((on, gx) => {
        if (on === 'x') img.data.set(hexToRgba(PALETTE.k.hex), ((3 + gy) * img.width + x + gx) * 4);
      })
    );
    x += glyph[0].length + 1;
  });
  return img;
}

/** One frame: the room, the Odd at frame `t`, what stands in front, then `extra` on top. */
function frame(layers: DeskLayers, t: number, extra: (img: Image) => void): Image {
  const img = createImage(layers.room.width, layers.room.height);
  drawImage(img, layers.room, 0, 0);
  // The Odd types at about 3.7 frames a second: a new pose every third GIF frame.
  drawImage(img, layers.odd[Math.floor(t / 3) % layers.odd.length], 0, 0);
  drawImage(img, layers.front, 0, 0);
  extra(img);
  return img;
}

const DELAY = 9;

function helloWorld(layers: DeskLayers): GifFrame[] {
  const tip = bubble(0);
  const at = { x: SCREEN.x - 2, y: SCREEN.y - tip.height - 1 };
  const frames: GifFrame[] = [];
  // Typing, then a letter a frame, a long hold, and a pause before it loops.
  const shown = [
    ...Array(8).fill(-1),
    ...[...HELLO].map((_, i) => i + 1),
    ...Array(26).fill(HELLO.length),
    ...Array(6).fill(-1)
  ];
  shown.forEach((n, t) =>
    frames.push({
      image: frame(layers, t, (img) => {
        if (n >= 0) drawImage(img, bubble(n), at.x, at.y);
      }),
      delay: DELAY
    })
  );
  // The still: the whole hello.
  frames.push({
    image: frame(layers, 0, (img) => drawImage(img, bubble(HELLO.length), at.x, at.y)),
    delay: 0
  });
  return frames;
}

function linux(layers: DeskLayers): GifFrame[] {
  const stand = layers.shade(sprite(PENGUIN));
  const fly = layers.shade(sprite(PENGUIN_FLY));
  const blink = layers.shade(sprite(PENGUIN_BLINK));
  const flash = sprite(Array(SCREEN.h).fill(FLASH.repeat(SCREEN.w)));
  const from = { x: SCREEN.x, y: SCREEN.y - 4 };
  const to = { x: 80, y: 64 };
  const frames: GifFrame[] = [];
  let t = 0;
  const add = (extra: (img: Image) => void, delay = DELAY) =>
    frames.push({ image: frame(layers, t++, extra), delay });

  for (let i = 0; i < 9; i++) add(() => {});
  // The screen flashes twice.
  for (const on of [true, false, true])
    add((img) => on && drawImage(img, flash, SCREEN.x, SCREEN.y));
  // Out of the screen, up, and over: a parabola from the screen to the floor.
  const STEPS = 11;
  for (let i = 1; i <= STEPS; i++) {
    const s = i / STEPS;
    const x = Math.round(from.x + (to.x - from.x) * s);
    const y = Math.round(from.y + (to.y - from.y) * s - 28 * Math.sin(Math.PI * s));
    add((img) => {
      if (i === 1) drawImage(img, flash, SCREEN.x, SCREEN.y);
      drawImage(img, i % 2 ? fly : stand, x, y);
    });
  }
  // The landing: a squash for a frame, then standing, with one blink.
  const squash = createImage(stand.width, stand.height);
  drawImage(squash, stand, 0, 1);
  add((img) => drawImage(img, squash, to.x, to.y));
  for (let i = 0; i < 28; i++)
    add((img) => drawImage(img, i === 12 || i === 13 ? blink : stand, to.x, to.y));
  // The still: the penguin on the floor beside the desk.
  frames.push({ image: frame(layers, 0, (img) => drawImage(img, stand, to.x, to.y)), delay: 0 });
  return frames;
}

// The bonk: a paper burst, outlined in ink so it shows on a lit door by
// night and on a sunny one by day.
const BONK = sprite(['...k...', '.k.=.k.', '..k=k..', 'k==.==k', '..k=k..', '.k.=.k.', '...k...']);

function stuckSignIn({ room, door, odd }: DoorLayers): GifFrame[] {
  const x = Math.round(door.x + door.w / 2 - 8);
  // Ada's sprite top: at the door, standing on the row below it, and where
  // she starts and ends, a tile and a half back on the sidewalk.
  const at = door.y + door.h - 16;
  const start = at + 24;
  const frames: GifFrame[] = [];
  const add = (pose: string, y: number, extra?: (img: Image) => void) => {
    const img = createImage(room.width, room.height);
    drawImage(img, room, 0, 0);
    drawImage(img, odd(pose), x, y);
    extra?.(img);
    frames.push({ image: img, delay: DELAY });
  };
  const walk = (from: number, to: number) => {
    const steps = Math.ceil(Math.abs(to - from) / 2);
    for (let i = 1; i <= steps; i++)
      add(`walk-up-${Math.floor(i / 2) % 4}`, Math.round(from + ((to - from) * i) / steps));
  };
  const ouch = bubble(1, '!');
  const huh = bubble(1, '?');
  const over = (b: Image, y: number) => (img: Image) => drawImage(img, b, x + 4, y - b.height + 2);
  const bonk = () => {
    add('idle-up-0', at + 4, (img) => drawImage(img, BONK, x + 5, at + 1));
    for (let i = 0; i < 4; i++) add('idle-up-0', at + 4, over(ouch, at + 4));
  };

  for (let i = 0; i < 6; i++) add('idle-up-0', start);
  walk(start, at);
  bonk();
  walk(at + 4, at);
  bonk();
  walk(at + 4, at);
  bonk();
  // Backing off, still facing the door, to where she began.
  walk(at + 4, start);
  for (let i = 0; i < 12; i++) add('idle-up-0', start, over(huh, start));
  // The still: Ada on the sidewalk, wondering.
  const still = createImage(room.width, room.height);
  drawImage(still, room, 0, 0);
  drawImage(still, odd('idle-up-0'), x, start);
  over(huh, start)(still);
  frames.push({ image: still, delay: 0 });
  return frames;
}

// The padlock, hung through both brass pulls: an amber body with a keyhole,
// outlined in ink so it shows on the lit glass by night and by day.
const PADLOCK = sprite([
  '.kkkk.',
  '.k..k.',
  '.k..k.',
  'kkkkkk',
  'kYYYYk',
  'kYkkYk',
  'kYYYYk',
  'kkkkkk'
]);

// The two leaves of the front door, in the door sprite's pixels: the full
// height of the doorway, rows 13 to 30, inside the jamb from column 11 to 36,
// meeting in the middle. Each is 13 columns wide.
const LEAF = { top: 13, bottom: 30, left: 11, right: 36, w: 13 };

/** The door's pixels from `src` at (x, y). */
function doorAt(src: Image, x: number, y: number): Image {
  const w = 48;
  const h = 32;
  const img = createImage(w, h);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * src.width + x) * 4;
    img.data.set(src.data.subarray(s, s + w * 4), r * w * 4);
  }
  return img;
}

/**
 * The door part way shut, over the open doorway: each leaf, whole and full
 * height, slid in from its side of the jamb, `slid` of the way from open (0)
 * to shut (1). The part still in the wall does not show.
 */
function leaves(shut: Image, opened: Image, slid: number): Image {
  const img = createImage(opened.width, opened.height);
  drawImage(img, opened, 0, 0);
  const off = Math.round(LEAF.w * (1 - slid));
  for (let i = 0; i < LEAF.w - off; i++) {
    // The leaf's inner edge leads: column i from the jamb shows the shut
    // leaf's column i + off.
    for (const [dx, sx] of [
      [LEAF.left + i, LEAF.left + i + off],
      [LEAF.right - i, LEAF.right - i - off]
    ])
      for (let y = LEAF.top; y <= LEAF.bottom; y++) {
        const src = (y * shut.width + sx) * 4;
        img.data.set(shut.data.subarray(src, src + 4), (y * img.width + dx) * 4);
      }
  }
  return img;
}

function lockedDoor({ room, door, open, odd }: DoorLayers): GifFrame[] {
  const x = Math.round(door.x + door.w / 2 - 8);
  // Ada's sprite top: at the door, half a step back where she waits while it
  // shuts, a step back where the padlock shows over her head, and where she
  // starts, a tile and a half back on the sidewalk.
  const at = door.y + door.h - 16;
  const near = at + 8;
  const back = at + 12;
  const start = at + 24;
  // The pulls sit in the door's columns 21 and 26, rows 22 to 24.
  const lock = { x: door.x + 21, y: door.y + 19 };
  const frames: GifFrame[] = [];
  // The door shut and open.
  const shut = doorAt(room, door.x, door.y);
  const opened = doorAt(open, 0, 0);
  // How far the leaves have slid shut, 0 open to 1 shut.
  let slid = 0;
  let locked = false;
  const scene = (pose: string, y: number, extra?: (img: Image) => void) => {
    const img = createImage(room.width, room.height);
    drawImage(img, room, 0, 0);
    drawImage(img, slid < 1 ? leaves(shut, opened, slid) : shut, door.x, door.y);
    if (locked) drawImage(img, PADLOCK, lock.x, lock.y);
    drawImage(img, odd(pose), x, y);
    extra?.(img);
    return img;
  };
  const add = (pose: string, y: number, extra?: (img: Image) => void) =>
    frames.push({ image: scene(pose, y, extra), delay: DELAY });
  const walk = (from: number, to: number) => {
    const steps = Math.ceil(Math.abs(to - from) / 2);
    for (let i = 1; i <= steps; i++)
      add(`walk-up-${Math.floor(i / 2) % 4}`, Math.round(from + ((to - from) * i) / steps));
  };
  const click = bubble(6, 'CLICK!');
  const over = (b: Image, y: number) => (img: Image) => drawImage(img, b, x + 4, y - b.height + 2);

  for (let i = 0; i < 6; i++) add('idle-up-0', start);
  walk(start, near);
  for (let i = 0; i < 2; i++) add('idle-up-0', near);
  // Both leaves slide together and meet in the middle, quick at first and
  // slowing as they meet.
  for (const s of [0.15, 0.35, 0.55, 0.72, 0.86, 0.95, 1]) {
    slid = s;
    add('idle-up-0', near);
  }
  for (let i = 0; i < 2; i++) add('idle-up-0', near);
  // She steps up and turns the key.
  walk(near, at);
  add('idle-up-0', at);
  locked = true;
  for (let i = 0; i < 8; i++) add('idle-up-0', at, over(click, at));
  // A step back, still facing the door, so the padlock shows.
  walk(at, back);
  for (let i = 0; i < 4; i++) add('idle-up-0', back);
  // Then she turns to face the street and stands by the locked door.
  add('idle-side-0', back);
  for (let i = 0; i < 24; i++) add(`idle-down-${Math.floor(i / 3) % 4}`, back);
  // The still: the door locked, Ada facing the street.
  frames.push({ image: scene('idle-down-0', back), delay: 0 });
  return frames;
}

/**
 * Ada walks along the hallway and the hall slides by: two pixels a frame, a
 * new step every second frame. One period of the hall (two windows, two
 * walls, one lamp) passes in period / 2 frames, a whole number of her walk's
 * cycles, so frame 0 follows the last and the loop runs on with no seam.
 */
function windows({ room, period, view, odd }: HallLayers): GifFrame[] {
  const SPEED = 2;
  const count = period / SPEED;
  if (!Number.isInteger(count) || count % 8)
    throw new Error('windows: the loop must end on a whole step');
  // Ada mid-view, her feet on the middle row of oak.
  const x = Math.round(view.w / 2 - 8);
  const y = view.h - 2 * 16 - 8;
  const shot = (t: number) => {
    const img = createImage(view.w, view.h);
    drawImage(img, room, -(period + t * SPEED), 0);
    drawImage(img, odd(`walk-side-${Math.floor(t / 2) % 4}`), x, y);
    return img;
  };
  const frames: GifFrame[] = [];
  for (let t = 0; t < count; t++) frames.push({ image: shot(t), delay: DELAY });
  // The still: Ada mid-stride in the hall.
  frames.push({ image: shot(0), delay: 0 });
  return frames;
}

// The props passed along the hall in 0.0.6's relay, each outlined in ink so
// it shows on plaster and oak by night and by day.
const FOLDER = sprite(['.kkk....', 'kyyykkkk', 'kyyyyyyk', 'kYYYYYYk', 'kYYYYYYk', 'kkkkkkkk']);
// A book with an X on the cover.
const CODEX = sprite([
  'kkkkkkk',
  'kRRRRRk',
  'kRyRyRk',
  'kRRyRRk',
  'kRyRyRk',
  'kRRRRRk',
  'k=====k',
  'kkkkkkk'
]);
// A brain: two halves, folded, on its stem.
const BRAIN_ROWS = [
  '...kkkkkkk...',
  '..kfFfFkFfkk.',
  '.kfFffFkfFffk',
  'kffFfffkffFfk',
  'kFfffFfkFfffk',
  'kffFffFkffFfk',
  'kfFffffkfFffk',
  '.kffFfFkfffk.',
  '..kkkkkkkkk..',
  '.....kFk.....'
];
const BRAIN = sprite(BRAIN_ROWS);
// The brain lit up, the moment the key goes in.
const BRAIN_LIT = sprite(BRAIN_ROWS.map((r) => r.replace(/f/g, 'g').replace(/F/g, 'G')));
const KEY = sprite(['.kkk....', 'kYyYkkkk', 'ky.yyyyk', 'kYyYkkYk', '.kkk..kk']);
// A sticky note, written on.
const NOTE = sprite([
  'kkkkkkkkk',
  'kyyyyyyyk',
  'kyKKKKyyk',
  'kyyyyyyyk',
  'kyKKKyyyk',
  'kyyyyyyyk',
  'kyKKKKyYk',
  'kyyyyyYYk',
  'kkkkkkkkk'
]);

/**
 * A relay down the 0.0.5 hallway, one pun a hand-off. Ada walks in with a
 * folder and hands it off to Theo, who is hands on, and folder and wiser. A
 * book with an X drops into her hands: Codex marks the spot. Theo hops: Grok
 * on. She sticks a note to the wall: the lesson stuck. A brain turns up in
 * Theo's hands, she tosses a key into it and it lights: no brainer. Then she
 * takes the key back: backsies. They turn to face you. Everything they set
 * down stays where it landed.
 */
function handOff({ room, period, view, odd, mate, shade }: HallLayers): GifFrame[] {
  // Their sprite tops: feet on the middle row of oak, as in the hallway walk.
  const Y = view.h - 2 * 16 - 8;
  // Where Ada stops, and where Theo stands facing her.
  const A = 34;
  const T = 78;
  // `shade` lights the image it is given, so each theme lights its own copy.
  const lit = (src: Image) => {
    const img = createImage(src.width, src.height);
    drawImage(img, src, 0, 0);
    return shade(img);
  };
  const folder = lit(FOLDER);
  const codex = lit(CODEX);
  const brain = lit(BRAIN);
  const key = lit(KEY);
  const note = lit(NOTE);

  const ada = { x: -16, pose: 'idle-side' };
  const theo = { y: Y, pose: 'idle-side' };
  const holding: { ada?: Image; theo?: Image } = {};
  // What they set down: it stays for the rest of the loop.
  const down: { img: Image; x: number; y: number }[] = [];
  const frames: GifFrame[] = [];

  /** Where a held prop sits: in front of the hands, at chest height. */
  const at = (who: 'ada' | 'theo', img: Image) => ({
    x: who === 'ada' ? ada.x + 11 : T + 5 - img.width,
    y: (who === 'ada' ? Y : theo.y) + 18 - (img.height >> 1)
  });
  /** A pose's frame: idles breathe on the clock, walks name their own step. */
  const pose = (p: string) => (/-\d$/.test(p) ? p : `${p}-${Math.floor(frames.length / 3) % 4}`);
  const shot = (extra?: (img: Image) => void) => {
    const img = createImage(view.w, view.h);
    drawImage(img, room, -period, 0);
    for (const d of down) drawImage(img, d.img, d.x, d.y);
    drawImage(img, odd(pose(ada.pose)), ada.x, Y);
    // Theo faces Ada: his side poses, flipped.
    drawImage(img, mate(pose(theo.pose)), T, theo.y, true);
    for (const who of ['ada', 'theo'] as const) {
      const held = holding[who];
      if (held) drawImage(img, held, at(who, held).x, at(who, held).y);
    }
    extra?.(img);
    return img;
  };
  const add = (extra?: (img: Image) => void, n = 1) => {
    for (let i = 0; i < n; i++) frames.push({ image: shot(extra), delay: DELAY });
  };
  /** A bubble over one of them, kept inside the art with its tail over the head. */
  const say = (text: string, who: 'ada' | 'theo') => {
    const w = width(text) + 6;
    const head = (who === 'ada' ? ada.x : T) + 6;
    const x = Math.max(1, Math.min(view.w - w - 1, head - 3));
    const b = bubble(text.length, text, Math.max(1, Math.min(w - 5, head - x)));
    return (img: Image) => drawImage(img, b, x, Y - b.height + 2);
  };
  /** A prop flying from one place to another over an arc `lift` pixels high. */
  const toss = (
    img: Image,
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps: number,
    lift: number
  ) => {
    for (let i = 1; i <= steps; i++) {
      const s = i / steps;
      const x = Math.round(from.x + (to.x - from.x) * s);
      const y = Math.round(from.y + (to.y - from.y) * s - lift * Math.sin(Math.PI * s));
      add((g) => drawImage(g, img, x, y));
    }
  };
  const pass = (img: Image, from: 'ada' | 'theo', to: 'ada' | 'theo', lift = 8) => {
    const start = at(from, img);
    holding[from] = undefined;
    toss(img, start, at(to, img), 6, lift);
    holding[to] = img;
  };
  const setDown = (who: 'ada' | 'theo', img: Image, x: number) => {
    const start = at(who, img);
    holding[who] = undefined;
    const to = { x, y: Y + 31 - img.height };
    toss(img, start, to, 3, 0);
    down.push({ img, ...to });
  };

  // Ada walks in with the folder.
  holding.ada = folder;
  for (let i = 1; ada.x < A; i++) {
    ada.x += 2;
    ada.pose = `walk-side-${Math.floor(i / 2) % 4}`;
    add();
  }
  ada.pose = 'idle-side';
  add(undefined, 2);
  // Hand-off, hands on.
  add(say('HAND-OFF!', 'ada'), 10);
  pass(folder, 'ada', 'theo');
  add(say('HANDS ON!', 'theo'), 10);
  add(say('FOLDER AND WISER', 'theo'), 16);
  setDown('theo', folder, T - 10);
  add(undefined, 2);
  // Codex drops in from above, X and all.
  toss(codex, { x: at('ada', codex).x, y: -codex.height }, at('ada', codex), 6, 0);
  holding.ada = codex;
  add(say('CODEX MARKS THE SPOT', 'ada'), 18);
  setDown('ada', codex, A + 16);
  add(undefined, 2);
  // Grok on: Theo hops twice.
  const grok = say('GROK ON!', 'theo');
  for (const dy of [0, -2, -4, -2, 0, -2, -4, -2, 0, 0, 0, 0]) {
    theo.y = Y + dy;
    add(grok);
  }
  theo.y = Y;
  // The lesson sticks to the wall, with a bonk.
  holding.ada = note;
  add(undefined, 2);
  const wall = { x: 52, y: 20 };
  holding.ada = undefined;
  toss(note, at('ada', note), wall, 6, 6);
  down.push({ img: note, ...wall });
  add((img) => drawImage(img, BONK, wall.x + 1, wall.y + 1));
  add(say('LESSON? IT STUCK.', 'ada'), 16);
  // A brain in Theo's hands, and the key that opens it.
  holding.theo = brain;
  add(undefined, 4);
  holding.ada = key;
  add(undefined, 2);
  const slot = { x: at('theo', brain).x - 5, y: at('theo', brain).y + 1 };
  holding.ada = undefined;
  toss(key, at('ada', key), slot, 6, 8);
  const keyIn = (img: Image) => drawImage(img, key, slot.x, slot.y);
  holding.theo = BRAIN_LIT;
  add((img) => {
    keyIn(img);
    drawImage(img, BONK, slot.x - 3, slot.y - 2);
  });
  const noBrainer = say('NO BRAINER!', 'theo');
  add((img) => {
    keyIn(img);
    noBrainer(img);
  }, 14);
  // Backsies: the key comes back out, and the brain goes dark.
  holding.theo = brain;
  toss(key, slot, at('ada', key), 6, 8);
  holding.ada = key;
  add(say('BACKSIES!', 'ada'), 12);
  // They turn to face you.
  ada.pose = 'idle-down';
  theo.pose = 'idle-down';
  add(undefined, 14);
  // The still: both facing you, the note on the wall, the folder and the book
  // on the floor, the brain and the key in hand.
  frames.push({ image: shot(), delay: 0 });
  return frames;
}

/**
 * Ada walks the 0.0.5 hallway, off its end and back in at its start, three
 * times, saying UPDATING!, then AGAIN?, then AND AGAIN?. The fourth time she
 * stops halfway, turns to face you and says OUT OF THE LOOP!
 */
function loop({ room, period, view, odd }: HallLayers): GifFrame[] {
  // Her sprite top: feet on the middle row of oak, as in the hallway walk.
  const Y = view.h - 2 * 16 - 8;
  const MID = Math.round(view.w / 2 - 8);
  const ada = { x: -16, pose: 'idle-down-0' };
  const frames: GifFrame[] = [];
  const bubbles = new Map<string, Image>();
  /** A bubble over Ada's head wherever she is, kept inside the art. */
  const say = (text: string) => (img: Image) => {
    if (ada.x < 0 || ada.x > view.w - 16) return;
    const w = width(text) + 6;
    const head = ada.x + 6;
    const x = Math.max(1, Math.min(view.w - w - 1, head - 3));
    const tail = Math.max(1, Math.min(w - 5, head - x));
    const key = `${text}@${tail}`;
    if (!bubbles.has(key)) bubbles.set(key, bubble(text.length, text, tail));
    const b = bubbles.get(key)!;
    drawImage(img, b, x, Y - b.height + 2);
  };
  const shot = (extra?: (img: Image) => void) => {
    const img = createImage(view.w, view.h);
    drawImage(img, room, -period, 0);
    drawImage(img, odd(ada.pose), ada.x, Y);
    extra?.(img);
    return img;
  };
  const add = (extra?: (img: Image) => void, n = 1) => {
    for (let i = 0; i < n; i++) frames.push({ image: shot(extra), delay: DELAY });
  };
  /** Walk from off the start to `to`, two pixels a frame, a new step every second frame. */
  const walk = (to: number, extra?: (img: Image) => void) => {
    ada.x = -16;
    for (let i = 1; ada.x < to; i++) {
      ada.x += 2;
      ada.pose = `walk-side-${Math.floor(i / 2) % 4}`;
      add(extra);
    }
  };

  walk(view.w, say('UPDATING!'));
  walk(view.w, say('AGAIN?'));
  walk(view.w, say('AND AGAIN?'));
  // The fourth time, she stops halfway and turns to you.
  walk(MID);
  for (let i = 0; i < 4; i++) {
    ada.pose = `idle-side-${i}`;
    add();
  }
  const out = say('OUT OF THE LOOP!');
  for (let i = 0; i < 24; i++) {
    ada.pose = `idle-down-${Math.floor(i / 3) % 4}`;
    add(out);
  }
  // The still: Ada facing you, mid-hall, out of the loop.
  frames.push({ image: shot(out), delay: 0 });
  return frames;
}

// Theo's lift poses with his hands somewhere other than at his sides: the row
// of his sprite that a held bar's middle sits on. The seat poses are the lift
// poses sitting down, three rows lower.
const SIT = 3;
const HANDS: Record<string, number> = {
  'exercise-lift-1': 17,
  'exercise-lift-2': 2,
  'exercise-lift-3': 17,
  'seat-lift-1': 17 + SIT,
  'seat-lift-2': 2 + SIT
};

/**
 * Theo works out in the office's gym, jogging from station to station. He
 * runs on the treadmill, pedals the bike and curls at the dumbbells. He jumps
 * to pull the bar off the rack and presses it, carries it to the bench, sits
 * facing you, and presses it again and again.
 */
function gym({ room, unracked, view, at, bar, odd }: GymLayers): GifFrame[] {
  const theo = { ...at.run, pose: 'exercise-run-0', flip: false, bob: 0 };
  // The treadmill's belt frame while Theo runs on it, and whether the bar is
  // on the rack or in his hands.
  let belt = 0;
  let racked = true;
  const frames: GifFrame[] = [];

  /** A seat pose: the lift pose's top half, dropped as sitting drops him, over sit-down's legs. */
  const seats = new Map<string, Image>();
  const look = (pose: string) => {
    if (!pose.startsWith('seat-')) return odd(pose);
    if (!seats.has(pose)) {
      const top = odd(pose.replace('seat-', 'exercise-'));
      const legs = odd('sit-down-0');
      const img = createImage(top.width, top.height);
      const row = top.width * 4;
      img.data.set(top.data.subarray(0, 23 * row), SIT * row);
      img.data.set(legs.data.subarray(26 * row), 26 * row);
      seats.set(pose, img);
    }
    return seats.get(pose)!;
  };
  const shot = () => {
    const img = createImage(view.w, view.h);
    drawImage(img, racked ? room[belt % room.length] : unracked, 0, 0);
    const y = theo.y + theo.bob;
    drawImage(img, look(theo.pose), theo.x, y, theo.flip);
    if (!racked)
      drawImage(
        img,
        bar.img,
        theo.x + 8 - (bar.img.width >> 1),
        y + (HANDS[theo.pose] ?? HANDS['exercise-lift-1']) - bar.mid
      );
    return img;
  };
  const add = (n = 1) => {
    for (let i = 0; i < n; i++) frames.push({ image: shot(), delay: DELAY });
  };
  /** Jog to each point in turn, one way at a time, four pixels a frame, a new stride every frame. */
  const jog = (...to: Point[]) => {
    for (const p of to)
      while (theo.x !== p.x || theo.y !== p.y) {
        const step = frames.length % 4;
        if (theo.x !== p.x) {
          const dx = Math.sign(p.x - theo.x) * Math.min(4, Math.abs(p.x - theo.x));
          theo.x += dx;
          theo.flip = dx < 0;
          theo.pose = `exercise-run-${step}`;
        } else {
          const dy = Math.sign(p.y - theo.y) * Math.min(4, Math.abs(p.y - theo.y));
          theo.y += dy;
          theo.flip = false;
          theo.pose = `walk-${dy < 0 ? 'up' : 'down'}-${step}`;
        }
        add();
      }
  };
  /** Carry the bar to each point, chest high, two pixels a frame, bobbing with each step. */
  const carry = (...to: Point[]) => {
    theo.pose = 'exercise-lift-1';
    for (const p of to)
      while (theo.x !== p.x || theo.y !== p.y) {
        if (theo.x !== p.x) theo.x += Math.sign(p.x - theo.x) * Math.min(2, Math.abs(p.x - theo.x));
        else theo.y += Math.sign(p.y - theo.y) * Math.min(2, Math.abs(p.y - theo.y));
        theo.bob = (frames.length >> 1) % 2;
        add();
      }
    theo.bob = 0;
  };

  // The treadmill: running in place, the belt turning under him.
  for (let i = 0; i < 28; i++) {
    belt = i;
    theo.pose = `exercise-run-${i % 4}`;
    add();
  }
  belt = 0;
  // Off the back of the treadmill and onto the bike.
  jog({ x: at.run.x, y: at.cycle.y }, at.cycle);
  for (let i = 0; i < 28; i++) {
    theo.pose = `exercise-cycle-${i % 4}`;
    add();
  }
  // Up to the dumbbells, and curls.
  jog({ x: at.cycle.x, y: at.curl.y }, at.curl);
  theo.flip = false;
  for (let i = 0; i < 30; i++) {
    theo.pose = Math.floor(i / 3) % 2 ? 'exercise-lift-1' : 'exercise-lift-0';
    add();
  }
  // Along to the rack. He turns, reaches, and jumps to pull the bar off.
  jog(at.rack);
  theo.flip = false;
  theo.pose = 'idle-down-0';
  add();
  theo.pose = 'exercise-lift-2';
  add(2);
  racked = false;
  theo.y -= 3;
  add();
  theo.y += 3;
  add();
  // Down to his chest, a strain, and up.
  theo.pose = 'exercise-lift-1';
  add(3);
  theo.pose = 'exercise-lift-3';
  for (const dx of [1, -1, 1, -1]) {
    theo.x += dx;
    add();
  }
  theo.pose = 'exercise-lift-2';
  add(14);
  theo.pose = 'exercise-lift-1';
  add(3);
  theo.pose = 'exercise-lift-2';
  add(8);
  // He carries the bar to the bench and sits on its end, facing you, a beat
  // before he presses.
  theo.pose = 'exercise-lift-1';
  add(2);
  carry({ x: at.rack.x, y: at.bench.y }, at.bench);
  theo.pose = 'seat-lift-1';
  add(17);
  // Up it goes, then twice more, and he holds it there.
  theo.pose = 'seat-lift-2';
  add(6);
  for (let rep = 0; rep < 2; rep++) {
    theo.pose = 'seat-lift-1';
    add(3);
    theo.pose = 'seat-lift-2';
    add(4);
  }
  add(8);
  // The still: Theo on the bench with the bar up.
  frames.push({ image: shot(), delay: 0 });
  return frames;
}

// Big square shades in thick gold frames, wider than the face, worn over each
// persona's own eyes: black lenses with a grey glint, which flashes white when
// they strike their pose. Facing you they sit on rows 9 to 12 of the sprite,
// clear of the mouth; side on, on the near side of the face.
const SHADES: Record<'down' | 'side', { top: number; rows: string[] }> = {
  down: {
    top: 9,
    rows: [
      '..YYYYY..YYYYY..', //
      '..YkkMYYYYkkMY..',
      '..YkkkY..YkkkY..',
      '...YYY....YYY...'
    ]
  },
  side: {
    top: 9,
    rows: [
      '........YYYYY...', //
      '......YYYkkMY...',
      '........YkkkY...',
      '.........YYY....'
    ]
  }
};
const shadesFor = (dir: 'down' | 'side', glint: boolean) =>
  sprite(SHADES[dir].rows.map((r) => (glint ? r.replaceAll('M', '=') : r)));

/** One puff of smoke: where its middle is, how big it is and will get, and where it drifts. */
type Puff = { x: number; y: number; r: number; max: number; vx: number; vy: number };

function personas({ room, view, door, odd, head, shade }: EntranceLayers): GifFrame[] {
  const frames: GifFrame[] = [];
  const everyone: Persona[] = ['michele', 'nate', 'sam'];
  /** Which of the lobby's lit images shows: 0 shut to 4 open. */
  let doors = 0;
  // Where each persona's sprite stands, the frame it shows, whether it faces
  // left, and its shades: how many rows they have slipped down the nose, or
  // null once they are off. They start in the doorway, hidden by the smoke.
  const sill = door.y + door.h - 32;
  const at = (x: number, y: number) => ({
    x,
    y,
    pose: 'idle-down-0',
    flip: false,
    glint: false,
    shades: 0 as number | null
  });
  const cast: Record<Persona, ReturnType<typeof at>> = {
    michele: at(door.x + 4, sill + 4),
    nate: at(door.x + 8, sill + 6),
    sam: at(door.x + 12, sill + 4)
  };
  // Front to back as they stand: whoever is further down the view is drawn last.
  const order = () => [...everyone].sort((a, b) => cast[a].y - cast[b].y);
  let shown = false;

  // The camera: how far it has zoomed in, and the point it centres on.
  const cam = { z: 1, cx: view.w / 2, cy: view.h / 2 };
  /** The part of the view the camera shows, in the view's pixels. */
  const frameOf = () => {
    const w = view.w / cam.z;
    const h = view.h / cam.z;
    const x = Math.max(0, Math.min(view.w - w, cam.cx - w / 2));
    const y = Math.max(0, Math.min(view.h - h, cam.cy - h / 2));
    return { x, y, w, h };
  };
  /** The view through the camera, each pixel the one under it, so pixels stay hard. */
  const zoom = (img: Image) => {
    if (cam.z === 1) return img;
    const f = frameOf();
    const out = createImage(view.w, view.h);
    for (let y = 0; y < view.h; y++)
      for (let x = 0; x < view.w; x++) {
        const sx = Math.min(view.w - 1, Math.floor(f.x + x / cam.z));
        const sy = Math.min(view.h - 1, Math.floor(f.y + y / cam.z));
        const i = (sy * view.w + sx) * 4;
        out.data.set(img.data.subarray(i, i + 4), (y * view.w + x) * 4);
      }
    return out;
  };

  // The smoke: puffs born in the doorway that swell as they roll into the
  // lobby, then thin away. A fixed seed, so every build draws the same smoke.
  const puffs: Puff[] = [];
  let seed = 9;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % 10000) / 10000;
  const puff = () =>
    puffs.push({
      x: door.x + 5 + rand() * (door.w - 10),
      y: door.y + 4 + rand() * (door.h - 8),
      r: 2 + rand() * 2,
      max: 7 + rand() * 8,
      vx: (rand() - 0.5) * 3.4,
      vy: 0.3 + rand() * 0.7
    });
  /** Move the smoke a frame: puffs drift and swell, or shrink when it clears. */
  const drift = (clearing: boolean) => {
    for (const p of puffs) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.94;
      p.vy *= 0.95;
      p.r = clearing ? p.r - 0.45 : Math.min(p.max, p.r + 0.5);
    }
    for (let i = puffs.length - 1; i >= 0; i--) if (puffs[i].r <= 0.5) puffs.splice(i, 1);
  };
  /**
   * The smoke as one lit layer: a white core, a pale grey ring, and a
   * dithered edge, all a little see-through, so whoever walks in it shows
   * through faintly.
   */
  const SMOKE = { core: 0.85, ring: 0.8, edge: 0.6 };
  const smoke = () => {
    const img = createImage(view.w, view.h);
    const tone = (key: string, a: number) => {
      const c = hexToRgba(PALETTE[key].hex);
      c[3] = Math.round(255 * a);
      return c;
    };
    const core = tone('=', SMOKE.core);
    const ring = tone('a', SMOKE.ring);
    const edge = tone('A', SMOKE.edge);
    for (const p of [...puffs].sort((a, b) => a.y - b.y)) {
      const r = p.r;
      for (let y = Math.max(0, Math.floor(p.y - r)); y <= Math.min(view.h - 1, p.y + r); y++)
        for (let x = Math.max(0, Math.floor(p.x - r)); x <= Math.min(view.w - 1, p.x + r); x++) {
          const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) / r;
          if (d > 1) continue;
          const i = (y * view.w + x) * 4;
          if (d < 0.55) img.data.set(core, i);
          else if (d < 0.85) {
            if (img.data[i + 3] === 0 || img.data[i + 3] === edge[3]) img.data.set(ring, i);
          } else if ((x + y) % 2 === 0 && img.data[i + 3] === 0) img.data.set(edge, i);
        }
    }
    return shade(img);
  };

  const shot = () => {
    const img = createImage(view.w, view.h);
    drawImage(img, room[doors], 0, 0);
    if (shown)
      for (const who of order()) {
        const c = cast[who];
        drawImage(img, odd[who](c.pose), c.x, c.y, c.flip);
        const dir = c.pose.includes('-side-')
          ? 'side'
          : c.pose.includes('-up-')
            ? undefined
            : 'down';
        if (dir && c.shades !== null) {
          const [hx, hy] = head(c.pose);
          drawImage(
            img,
            shade(shadesFor(dir, c.glint)),
            c.x + (c.flip ? -hx : hx),
            c.y + hy + SHADES[dir].top + c.shades,
            c.flip
          );
        }
      }
    if (puffs.length) drawImage(img, smoke(), 0, 0);
    return zoom(img);
  };
  const add = (n = 1, step?: () => void) => {
    for (let i = 0; i < n; i++) {
      step?.();
      frames.push({ image: shot(), delay: DELAY });
    }
  };

  // A quiet lobby, then the doors slide open.
  add(8);
  for (const d of [1, 2, 3, 4]) {
    doors = d;
    add(2);
  }
  // Smoke rolls in through the open doors, and swells.
  add(18, () => {
    puff();
    puff();
    puff();
    drift(false);
  });
  // Out of it they walk: Nate down the middle, Michele and Sam a step behind
  // him, either side, close. A pixel a frame, a new stride every other frame.
  shown = true;
  const marks: Record<Persona, Point & { wait: number }> = {
    nate: { x: door.x + 8, y: view.h - 40, wait: 0 },
    michele: { x: door.x + 8 - 20, y: view.h - 43, wait: 5 },
    sam: { x: door.x + 8 + 20, y: view.h - 43, wait: 5 }
  };
  const arrived = (who: Persona) => cast[who].x === marks[who].x && cast[who].y === marks[who].y;
  let t = 0;
  while (!everyone.every(arrived)) {
    add(1, () => {
      if (t < 26) {
        puff();
        if (t < 10) puff();
      }
      drift(t > 34);
      for (const who of everyone) {
        const c = cast[who];
        const m = marks[who];
        if (t < m.wait || arrived(who)) {
          c.pose = 'idle-down-0';
          continue;
        }
        // Down a pixel each frame, and across in step, so each lands at once.
        const rows = m.y - c.y;
        if (rows > 0) c.y += 1;
        const cols = m.x - c.x;
        if (cols && (rows <= 0 || Math.abs(cols) >= rows || (t + who.length) % 2 === 0))
          c.x += Math.sign(cols);
        c.pose = `walk-down-${(t >> 1) % 4}`;
      }
      t++;
    });
  }
  // They stop, and on the beat strike a pose: Michele's hands behind her
  // head, Nate's on his hips, and Sam raises the roof. A hop, then they hold
  // it, and the light catches each pair of shades in turn.
  for (const c of Object.values(cast)) c.pose = 'idle-down-0';
  add(3, () => drift(true));
  const POSES: Record<Persona, string> = {
    michele: 'exercise-stretch-0',
    nate: 'exercise-lift-0',
    sam: 'exercise-lift-2'
  };
  for (const who of everyone) {
    cast[who].pose = POSES[who];
    cast[who].y -= 2;
  }
  add(2, () => drift(true));
  for (const c of Object.values(cast)) c.y += 2;
  for (let i = 0; i < 12; i++)
    add(1, () => {
      drift(true);
      everyone.forEach((who, k) => (cast[who].glint = i >= 2 + k * 3 && i < 4 + k * 3));
    });
  // Still posing, the camera pushes in to twice the size, on their faces.
  const close = { cx: view.w / 2, cy: marks.nate.y + 16 };
  const from = { cx: cam.cx, cy: cam.cy };
  for (const z of [1.1, 1.22, 1.36, 1.5, 1.64, 1.78, 1.9, 2])
    add(1, () => {
      drift(true);
      const k = z - 1;
      cam.z = z;
      cam.cx = from.cx + (close.cx - from.cx) * k;
      cam.cy = from.cy + (close.cy - from.cy) * k;
    });
  // Arms down, and all at once the shades come off: a quick slip down the
  // nose, then a flick up and away. Then they stand there, faces bare,
  // breathing.
  for (const c of Object.values(cast)) c.pose = 'idle-down-0';
  add(3, () => drift(true));
  for (const n of [2, -4, null])
    add(1, () => {
      drift(true);
      for (const c of Object.values(cast)) c.shades = n;
    });
  let breath = 0;
  add(16, () => {
    drift(true);
    for (const c of Object.values(cast)) c.pose = `idle-down-${(breath >> 2) % 4}`;
    breath++;
  });
  const still = frames.at(-1)!.image;
  // Then off they go, out of the camera's frame: Michele to the left, Nate
  // and Sam to the right, two pixels a frame, a new stride every frame.
  cast.michele.flip = true;
  for (const c of Object.values(cast)) c.pose = 'idle-side-0';
  add(2, () => drift(true));
  const gone = (who: Persona) => {
    const f = frameOf();
    return cast[who].x + 16 <= f.x || cast[who].x >= f.x + f.w;
  };
  t = 0;
  while (!everyone.every(gone)) {
    add(1, () => {
      drift(true);
      for (const who of everyone) {
        if (gone(who)) continue;
        cast[who].x += who === 'michele' ? -2 : 2;
        cast[who].pose = `walk-side-${t % 4}`;
      }
      t++;
    });
  }
  add(4, () => drift(true));
  // The still: the three of them close up, shades off.
  frames.push({ image: still, delay: 0 });
  return frames;
}

// The bug hunters' van, nose to the right like the bus: a white box van with
// a lower cab, a red stripe, and six columns spare at the rear for its back
// door to swing into. Its lettering is stamped on below.
const VAN_ROWS = [
  '.......kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk............',
  '......k=====================================k...........',
  '......k=====================================k...........',
  '......kqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqk...........',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPk...........',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPk...........',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPkkkkkkk.....',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPk======k....',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPkkccccCck...',
  '......kRPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPkkcccccCck..',
  '......kRPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPkkccccckCck.',
  '......kRPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPkkkkkkkkkkk.',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPkPPPPPPPPPPk',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPqP55PPPPPPlk',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPqPPPPPPPPPLk',
  '......kPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPqPPPPPPPPPPk',
  '......kRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRqRRRRRRRRRRk',
  '......kRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRqRRRRRRRRRRk',
  '......5PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPqPPPPPPPPPPk',
  '......5qqqqqkkkkkqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkkkkkqqqq5',
  '......5qqqqkkkkkkkqqqqqqqqqqqqqqqqqqqqqqqqqqqkkkkkkkqqq5',
  '......kkkkkkK555KkkkkkkkkkkkkkkkkkkkkkkkkkkkkkK555Kkkkkk',
  '...........kK5k5Kk...........................kK5k5Kk....',
  '...........kK555Kk...........................kK555Kk....',
  '............kKKKk.............................kKKKk.....',
  '.......______kkk_______________________________kkk_____.',
  '.......________________________________________________.'
];
// The open back door, swung out flat beside the box: its outer face, a
// window, and its hinge on the rear edge.
const VAN_DOOR = [
  '.kkkkk',
  'k====k',
  'kPPPPk',
  'kkkkkk',
  'kcccck',
  'kcccck',
  'kkkkkk',
  ...Array(10).fill('kPPPPk'),
  'kqqqqk',
  'kqqqqk',
  'kkkkkk'
];
// The logo: a bug in a red ring, struck through.
const NO_BUG = ['.RRR.', 'RRk.R', 'RkRkR', 'R.kRR', '.RRR.'];

/** `rows` with `glyphs` stamped in `key` at (x, y), and `art` (palette keys) where it is not `.`. */
function stamp(rows: string[], at: { x: number; y: number }, art: string[]): string[] {
  return rows.map((row, y) => {
    const line = art[y - at.y];
    if (!line) return row;
    return [...row]
      .map((c, x) => (line[x - at.x] && line[x - at.x] !== '.' ? line[x - at.x] : c))
      .join('');
  });
}
/** Text in the 5-pixel font as rows of `key`, one column between letters. */
function lettering(text: string, key: string): string[] {
  return [0, 1, 2, 3, 4].map((y) =>
    [...text].map((ch) => GLYPHS[ch][y].replaceAll('x', key)).join('.')
  );
}
const VAN_SIDE = (() => {
  let rows = stamp(VAN_ROWS, { x: 16, y: 4 }, NO_BUG);
  rows = stamp(rows, { x: 23, y: 4 }, lettering('BUG', 'k'));
  return stamp(rows, { x: 12, y: 10 }, lettering('HUNTERS', 'k'));
})();
// The wheels turn: the hub's dark spot moves round between frames.
const VAN_ROLL = VAN_SIDE.map((r, y) => (y === 22 ? r.replaceAll('kK5k5Kk', 'kKk5kKk') : r));
const VAN_OPEN = stamp(VAN_SIDE, { x: 0, y: 1 }, VAN_DOOR);

// A bug hunter's hood, visor and mask, drawn over the head from row 3, by
// facing: a yellow hood, a dark visor with a glint, and a respirator with a
// filter each side. From behind it is all hood.
const HOOD: Record<'down' | 'up' | 'side', string[]> = {
  down: [
    '....kkkkkkkk....',
    '...kyyyyyyyyk...',
    '..kyyyyyyyyyYk..',
    '..kyykkkkkkkYk..',
    '..kykKmKKKKKkk..',
    '..kykKKKKKmKkk..',
    '..kyYkkkkkkkYk..',
    '..kYkk5MM5kkYk..',
    '..kYkMk55kMk9k..',
    '..k9kMk55kMk9k..',
    '...k9kkkkkk9k...',
    '....kk9999kk....',
    '....kYYYYYYk....'
  ],
  up: [
    '....kkkkkkkk....',
    '...kyyyyyyyyk...',
    '..kyyyyyyyyyYk..',
    '..kyyyyyyyyyYk..',
    '..kYyyyyyyyyYk..',
    '..kYyyyyyyyYYk..',
    '..kYYyyyyyYY9k..',
    '..k9YYYYYYYY9k..',
    '..k9YYYYYYYY9k..',
    '..k99YYYYYY99k..',
    '...k99YYYY99k...',
    '....kk9999kk....',
    '....kYYYYYYk....'
  ],
  side: [
    '....kkkkkkk.....',
    '...kyyyyyyyk....',
    '..kyyyyyyyyyk...',
    '..kyyyyyykkkkk..',
    '..kyyyyykKmKKk..',
    '..kYyyyykKKKMk..',
    '..kYyyyyykkkkk..',
    '..kYyyyyk5MMk...',
    '..k9Yyyyk55MMk..',
    '..k9YYYYk5MMk...',
    '...k99YYYkkk....',
    '....kk999kk.....',
    '.....kYYYYk.....'
  ]
};
// The spray tank on a hunter's back, from row 15: seen from behind, side on
// (behind the shoulder), and from the front only its straps show.
const TANK: Record<'down' | 'up' | 'side', string[]> = {
  down: ['................', '.....k....k.....', '.....k....k.....', '.....k....k.....'],
  up: [
    '.....kkkkkk.....',
    '....kMrRRR8k....',
    '....kmrRRR8k....',
    '....kMrRRR8k....',
    '....kMrRRR8k....',
    '....kMrRRR8k....',
    '....kMrRRR8k....',
    '.....kkkkkk.....'
  ],
  side: ['..kkk...', '.krR8k..', '.krR8k..', '.krR8k..', '.krR8k..', '.krR8k..', '..kkk...']
};

// How far past the threshold a hunter walks before the lobby's dark takes them.
const DEPTH = 8;
// The still: one hunter side on in the mask, the other walking off, the van behind.
const STILL_AT = 52;

/**
 * 0.0.10, a release of bug fixes. A white van marked BUG HUNTERS drives up
 * the near lane and stops past the crossing. Its back door swings open and two
 * bug hunters hop out, one after the other, in yellow suits with hoods, masks
 * and spray tanks. They walk to the front door side by side, the view tilting
 * up with them, the door slides open, and in they go. It slides shut behind
 * them.
 */
function bugHunters({
  room,
  view,
  door,
  open,
  lane,
  odd,
  head,
  torso,
  shade
}: CurbLayers): GifFrame[] {
  const frames: GifFrame[] = [];
  const van = {
    side: shade(sprite(VAN_SIDE)),
    roll: shade(sprite(VAN_ROLL)),
    open: shade(sprite(VAN_OPEN))
  };
  const hoods = {
    down: shade(sprite(HOOD.down)),
    up: shade(sprite(HOOD.up)),
    side: shade(sprite(HOOD.side))
  };
  const tanks = {
    down: shade(sprite(TANK.down)),
    up: shade(sprite(TANK.up)),
    side: shade(sprite(TANK.side))
  };
  const shut = doorAt(room, door.x, door.y);
  const opened = doorAt(open, 0, 0);
  // The doorway the hunters step through, inside the jamb, in the room's pixels.
  const doorway = {
    x0: door.x + LEAF.left,
    x1: door.x + LEAF.right,
    y0: door.y + LEAF.top,
    y1: door.y + LEAF.bottom
  };

  // The van's wheels sit on the lane where the bus's do, and it stops with
  // its nose at the view's edge, its back by the crossing.
  const vanY = lane + 13 - 24;
  const stop = view.w - VAN_SIDE[0].length;
  const car = { x: -VAN_SIDE[0].length, img: van.side };
  let slid = 1;
  // The view's top in the room: it starts at the bottom, on the street.
  let cam = room.height - view.h;

  type Hunter = { x: number; y: number; pose: string; flip: boolean; out: boolean };
  // Feet on the road beside the van's back door.
  const kerbY = vanY + 24 - 30;
  const hunters: Hunter[] = [0, 1].map(() => ({
    x: 0,
    y: kerbY,
    pose: 'idle-side-0',
    flip: true,
    out: false
  }));

  /** A hunter, suited up: the tank behind (or, facing you, its straps in front), then the hood. */
  const suited = (h: Hunter) => {
    const dir = h.pose.includes('-side-') ? 'side' : h.pose.includes('-up-') ? 'up' : 'down';
    const img = createImage(16, 32);
    const [tx, ty] = torso(h.pose);
    const [hx, hy] = head(h.pose);
    if (dir === 'side') drawImage(img, tanks.side, tx, 15 + ty);
    drawImage(img, odd(h.pose), 0, 0);
    if (dir !== 'side') drawImage(img, tanks[dir], tx, 15 + ty);
    drawImage(img, hoods[dir], hx, 3 + hy);
    return img;
  };

  const shot = () => {
    const img = createImage(room.width, room.height);
    drawImage(img, room, 0, 0);
    drawImage(img, slid < 1 ? leaves(shut, opened, slid) : shut, door.x, door.y);
    // Whoever has stepped over the threshold shows only through the doorway,
    // darker the further into the lobby they go.
    const sill = door.y + door.h;
    const inside = (h: Hunter) => h.out && h.y + 30 < sill;
    for (const h of hunters.filter(inside)) {
      const body = suited(h);
      const dim = 1 - (0.75 * (sill - h.y - 30)) / DEPTH;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 16; x++) {
          const rx = h.x + x;
          const ry = h.y + y;
          if (rx < doorway.x0 || rx > doorway.x1 || ry < doorway.y0 || ry > doorway.y1) continue;
          const i = (y * 16 + (h.flip ? 15 - x : x)) * 4;
          if (!body.data[i + 3]) continue;
          const o = (ry * room.width + rx) * 4;
          for (let c = 0; c < 3; c++) img.data[o + c] = Math.round(body.data[i + c] * dim);
        }
    }
    // Front to back: the van, then the hunters on the sidewalk, lowest last.
    drawImage(img, car.img, car.x, vanY);
    for (const h of [...hunters].filter((h) => h.out && !inside(h)).sort((a, b) => a.y - b.y))
      drawImage(img, suited(h), h.x, h.y, h.flip);
    const out = createImage(view.w, view.h);
    drawImage(out, img, 0, -Math.round(cam));
    return out;
  };
  const add = (n = 1, step?: () => void) => {
    for (let i = 0; i < n; i++) {
      step?.();
      frames.push({ image: shot(), delay: DELAY });
    }
  };

  // A quiet street.
  add(6);
  // The van drives in, slowing to a stop, its wheels turning.
  const from = car.x;
  const STEPS = 26;
  for (let i = 1; i <= STEPS; i++)
    add(1, () => {
      const s = i / STEPS;
      car.x = Math.round(from + (stop - from) * (1 - (1 - s) * (1 - s)));
      car.img = i < STEPS && (i >> 1) % 2 ? van.roll : van.side;
    });
  car.img = van.side;
  add(5);
  // The back door swings open.
  car.img = van.open;
  add(3);

  // The hunters' marks: either side of the doorway's middle, on the sidewalk
  // a step below the door, then through it.
  const mid = door.x + door.w / 2 - 8;
  const cols = [mid - 6, mid + 6];
  const below = door.y + door.h - 30 + 10;
  const gone = door.y + door.h - 30 - DEPTH;
  // Each hunter: hop down from the back of the van, walk along the road to
  // their column, then up the sidewalk and in. The second follows nine
  // frames behind the first.
  type Leg = { x?: number; y?: number };
  const plans: Leg[][] = cols.map((x) => [{ x }, { y: below }, { y: gone }]);
  const starts = [0, 9];
  const stepOf = hunters.map(() => 0);
  const legOf = hunters.map(() => 0);
  const hop = [-3, -2, 0];
  let t = 0;
  const done = () => hunters.every((_, k) => legOf[k] >= plans[k].length);
  const dooring = () => Math.min(...hunters.map((h) => (h.out ? h.y : Infinity)));
  while (!done()) {
    add(1, () => {
      hunters.forEach((h, k) => {
        const s = t - starts[k];
        if (s < 0) return;
        if (s < hop.length) {
          // Out of the back door and down onto the road.
          h.out = true;
          h.x = car.x + 6 - 14;
          h.y = kerbY + hop[s];
          h.pose = 'idle-side-0';
          h.flip = true;
          return;
        }
        const at = (leg: Leg) => (leg.x ?? h.x) === h.x && (leg.y ?? h.y) === h.y;
        while (plans[k][legOf[k]] && at(plans[k][legOf[k]])) legOf[k]++;
        const leg = plans[k][legOf[k]];
        if (!leg) return;
        if (leg.x !== undefined && h.x !== leg.x) {
          h.flip = leg.x < h.x;
          h.x += Math.sign(leg.x - h.x) * Math.min(2, Math.abs(leg.x - h.x));
          h.pose = `walk-side-${(stepOf[k]++ >> 1) % 4}`;
        } else if (leg.y !== undefined && h.y !== leg.y) {
          h.y += Math.sign(leg.y - h.y) * Math.min(2, Math.abs(leg.y - h.y));
          h.flip = false;
          h.pose = `walk-up-${(stepOf[k]++ >> 1) % 4}`;
        }
        if (at(leg)) legOf[k]++;
      });
      // The door slides open as the first of them nears it.
      const lead = dooring();
      if (lead < below + 14 && slid > 0) slid = Math.max(0, slid - 0.2);
      // The view tilts up with the first of them, a pixel or two a frame.
      const want = Math.max(0, Math.min(room.height - view.h, lead + 16 - view.h / 2 - 8));
      if (cam > want) cam = Math.max(want, cam - 2);
      t++;
    });
  }
  for (const h of hunters) h.out = false;
  add(3);
  // The door slides shut behind them.
  for (const s of [0.15, 0.35, 0.55, 0.72, 0.86, 0.95, 1]) {
    slid = s;
    add();
  }
  add(14);
  frames.push({ image: frames[STILL_AT].image, delay: 0 });
  return frames;
}

/** Writes `text` in the 5-pixel font into `img` at x, y, in palette key `key`. */
function print(img: Image, text: string, x: number, y: number, key: string): void {
  const rgba = hexToRgba(PALETTE[key].hex);
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    glyph.forEach((row, gy) =>
      [...row].forEach((on, gx) => {
        const px = x + gx;
        const py = y + gy;
        if (on === 'x' && px >= 0 && py >= 0 && px < img.width && py < img.height)
          img.data.set(rgba, (py * img.width + px) * 4);
      })
    );
    x += glyph[0].length + 1;
  }
}

/** A filled box in palette key `key`, clipped to `img`. */
function box(img: Image, x: number, y: number, w: number, h: number, key: string): void {
  const rgba = hexToRgba(PALETTE[key].hex);
  for (let py = Math.max(0, y); py < Math.min(img.height, y + h); py++)
    for (let px = Math.max(0, x); px < Math.min(img.width, x + w); px++)
      img.data.set(rgba, (py * img.width + px) * 4);
}

// The wall switch beside the window, its label above it, and the terminal
// the left desk's monitor grows into, in the vignette's pixels.
const SWITCH = { x: 106, y: 10 };
const ADVANCED = 'ADVANCED';
const TERMINAL = { x: 26, y: 2, w: 62, h: 31 };
const TITLE = 'PROJECTS';

// The code the terminal types: each line its words' lengths, and the key of
// each word. A line starting with '>' is a prompt.
const CODE: [string, number[]][] = [
  ['>y', [5, 7]],
  ['GG', [4, 9, 3]],
  ['gG', [6, 4, 8]],
  ['GyG', [3, 5, 10]],
  ['GG', [7, 6]],
  ['>y', [4, 6, 3]],
  ['gGG', [5, 3, 7]],
  ['GG', [9, 4]],
  ['yGg', [3, 8, 5]],
  ['>y', [6, 5]],
  ['GgG', [4, 4, 9]],
  ['GG', [8, 5]]
];

/** The wall switch: its lamp red when off and green when on, and its lever down, halfway or up. */
function wallSwitch(state: 'off' | 'half' | 'on'): Image {
  const knob = { off: 7, half: 6, on: 4 }[state];
  const rows = ['kkkkkkk', 'kmmmmmk', `km${state === 'on' ? 'vv' : 'RR'}mmk`, 'kmmmmmk'];
  for (let y = 4; y <= 7; y++)
    rows.push(y === knob || (state === 'half' && y === 5) ? 'kmm=mmk' : 'kmm5mmk');
  rows.push('kkkkkkk');
  return sprite(rows);
}

/** The terminal `w` by `h`, `lines` lines of its code typed and the next one `words` words in. */
function terminal(w: number, h: number, lines: number, words: number, cursor: boolean): Image {
  const img = createImage(w, h);
  box(img, 0, 0, w, h, 'k');
  box(img, 1, 1, w - 2, 7, 'T');
  box(img, 1, 8, w - 2, h - 9, '7');
  if (w >= width(TITLE) + 4 && h >= 9) print(img, TITLE, (w - width(TITLE)) >> 1, 2, '=');
  // Each line is 1 pixel of words with 2 of space; the newest at the bottom.
  const PITCH = 3;
  const fit = Math.max(0, Math.floor((h - 11) / PITCH));
  const shown = CODE.slice(0, lines + 1).map(
    (l, i) => [l, i === lines ? words : l[1].length] as [[string, number[]], number]
  );
  const first = Math.max(0, shown.length - fit);
  shown.slice(first).forEach(([[keys, lens], n], row) => {
    const y = 10 + row * PITCH;
    let x = 3;
    if (keys[0] === '>') {
      box(img, x, y, 2, 1, 'y');
      x += 4;
    }
    const wordKeys = keys[0] === '>' ? keys.slice(1) : keys;
    for (let i = 0; i < n; i++) {
      box(img, x, y, lens[i], 1, wordKeys[i] ?? 'G');
      x += lens[i] + 2;
    }
    if (cursor && row === shown.length - 1 - first) box(img, x, y - 1, 2, 3, 'g');
  });
  return img;
}

function advanced(layers: DeskLayers): GifFrame[] {
  const frames: GifFrame[] = [];
  let t = 0;
  const label = layers.shade(
    (() => {
      const w = width(ADVANCED) + 4;
      const img = createImage(w, 9);
      box(img, 0, 0, w, 9, 'k');
      box(img, 1, 1, w - 2, 7, '=');
      print(img, ADVANCED, 2, 2, 'k');
      return img;
    })()
  );
  const labelAt = { x: SWITCH.x + 3 - (label.width >> 1), y: 0 };
  if (labelAt.x < TERMINAL.x + TERMINAL.w + 2)
    throw new Error('advanced: the label runs under the terminal');
  const plates = {
    off: layers.shade(wallSwitch('off')),
    half: layers.shade(wallSwitch('half')),
    on: layers.shade(wallSwitch('on'))
  };
  const flash = sprite(Array(SCREEN.h).fill(FLASH.repeat(SCREEN.w)));
  const add = (plate: Image, extra: (img: Image) => void = () => {}, delay = DELAY) =>
    frames.push({
      image: frame(layers, t++, (img) => {
        drawImage(img, label, labelAt.x, labelAt.y);
        drawImage(img, plate, SWITCH.x, SWITCH.y);
        extra(img);
      }),
      delay
    });

  // The Odd works; the switch is off.
  for (let i = 0; i < 12; i++) add(plates.off);
  // The switch flips on.
  add(plates.half);
  for (let i = 0; i < 4; i++) add(plates.on);
  // The monitor flashes twice.
  for (const on of [true, false, true, false])
    add(plates.on, (img) => on && drawImage(img, flash, SCREEN.x, SCREEN.y));
  // The screen grows into the terminal.
  const GROW = 7;
  for (let i = 1; i <= GROW; i++) {
    const s = i / GROW;
    const w = Math.round(SCREEN.w + (TERMINAL.w - SCREEN.w) * s);
    const h = Math.round(SCREEN.h + (TERMINAL.h - SCREEN.h) * s);
    const x = Math.round(SCREEN.x + (TERMINAL.x - SCREEN.x) * s);
    const y = Math.round(SCREEN.y + (TERMINAL.y - SCREEN.y) * s);
    add(plates.on, (img) => drawImage(img, terminal(w, h, 0, 0, false), x, y));
  }
  // The code types out, a word a frame, and scrolls.
  const at = (img: Image, lines: number, words: number, cursor: boolean) =>
    drawImage(img, terminal(TERMINAL.w, TERMINAL.h, lines, words, cursor), TERMINAL.x, TERMINAL.y);
  for (let line = 0; line < CODE.length; line++) {
    const n = CODE[line][1].length;
    for (let word = CODE[line][0][0] === '>' ? 0 : 1; word <= n; word++)
      add(plates.on, (img) => at(img, line, word, true));
  }
  // It waits for more, the cursor blinking.
  for (let i = 0; i < 16; i++)
    add(plates.on, (img) => at(img, CODE.length - 1, CODE.at(-1)![1].length, i % 4 < 2));
  // The still: the terminal full of code, the switch on.
  frames.push({
    image: frame(layers, 0, (img) => {
      drawImage(img, label, labelAt.x, labelAt.y);
      drawImage(img, plates.on, SWITCH.x, SWITCH.y);
      at(img, CODE.length - 1, CODE.at(-1)![1].length, true);
    }),
    delay: 0
  });
  return frames;
}

/**
 * Every release's art. `share` is the GIF frame, counted from 0, that becomes
 * the link preview while that release is the newest one, and `shareLight` is
 * whether that frame is drawn by night or by day. The owner picks both when
 * the art is made; there is no default.
 */
const ART: {
  name: string;
  frames: (layers: Layers) => GifFrame[];
  share: number;
  shareLight: 'night' | 'day';
}[] = [
  // The whole hello in its bubble.
  { name: 'hello-world', frames: (l) => helloWorld(l.desk), share: 30, shareLight: 'night' },
  // Ada backed off on the sidewalk, wondering.
  { name: 'stuck-sign-in', frames: (l) => stuckSignIn(l.door), share: 55, shareLight: 'night' },
  // The penguin standing on the floor, by day, where his ink shows.
  { name: 'linux', frames: (l) => linux(l.desk), share: 30, shareLight: 'day' },
  // Ada facing the street beside the locked door, by night, where the glass glows.
  { name: 'locked-door', frames: (l) => lockedDoor(l.door), share: 60, shareLight: 'night' },
  // Ada mid-hall among the windows, by day, where the sky shows.
  { name: 'windows', frames: (l) => windows(l.hall), share: 0, shareLight: 'day' },
  // Theo's brain lit with Ada's key in it: no brainer.
  { name: 'hand-off', frames: (l) => handOff(l.hall), share: 158, shareLight: 'night' },
  // Ada facing you mid-hall, by day: out of the loop.
  { name: 'loop', frames: (l) => loop(l.hall), share: 270, shareLight: 'day' },
  // Theo on the bench with the bar up.
  { name: 'gym', frames: (l) => gym(l.gym), share: 197, shareLight: 'day' },
  // The three of them in their pose, by day, the light on Michele's shades.
  { name: 'personas', frames: (l) => personas(l.entrance), share: 97, shareLight: 'day' },
  // By day, a hunter side on in the mask beside the van, BUG HUNTERS in full.
  { name: 'bug-hunters', frames: (l) => bugHunters(l.curb), share: STILL_AT, shareLight: 'day' },
  // The terminal full of code, the switch on.
  { name: 'advanced', frames: (l) => advanced(l.desk), share: 70, shareLight: 'night' }
];

// The link preview's size, and the ink it sits on.
const CARD = { w: 1200, h: 630 };

/** One frame, scaled up by whole pixels and centred on ink, at the preview's size. */
function shareCard(img: Image): Image {
  const scale = Math.min(Math.floor(CARD.w / img.width), Math.floor(CARD.h / img.height));
  const card = createImage(CARD.w, CARD.h);
  const ink = hexToRgba(PALETTE.k.hex);
  for (let p = 0; p < CARD.w * CARD.h; p++) card.data.set(ink, p * 4);
  const big = scaleImage(img, scale);
  drawImage(card, big, (CARD.w - big.width) >> 1, (CARD.h - big.height) >> 1);
  return card;
}

/**
 * Writes <name>.gif and its still, <name>.png, into `dir`, for one theme. In
 * the light an animation picks for its link preview, it also writes
 * <name>-share.png into `shareDir`, the same folder in both themes.
 */
export function writeReleaseArt(
  layers: Layers,
  dir: string,
  theme: 'night' | 'day',
  shareDir: string
): void {
  mkdirSync(dir, { recursive: true });
  for (const art of ART) {
    const frames = art.frames(layers);
    const gif = frames.slice(0, -1);
    if (!Number.isInteger(art.share) || art.share < 0 || art.share >= gif.length)
      throw new Error(`${art.name}: share frame ${art.share} is not one of its ${gif.length}`);
    writeFileSync(join(dir, `${art.name}.gif`), encodeGif(gif));
    writeFileSync(join(dir, `${art.name}.png`), encodePng(frames.at(-1)!.image));
    if (theme === art.shareLight) {
      mkdirSync(shareDir, { recursive: true });
      writeFileSync(
        join(shareDir, `${art.name}-share.png`),
        encodePng(shareCard(gif[art.share].image))
      );
    }
    console.log(`${relative(process.cwd(), join(dir, art.name))}.gif: ${gif.length} frames`);
  }
}
