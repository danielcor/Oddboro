// Builds an office from a short spec: which rooms, how big, how many desks,
// the materials and the extras. Claude writes the spec from the owner's
// words, and this turns it into a floor plan and room templates, the same
// shapes the hand-built Main Street uses. The limits live here, in code, so no
// spec can make a floor that breaks the office: too many rooms or desks, a
// seat nobody can reach, a building wider than the screen.
//
// The layout is always the same shape, so it always works:
//
//   back row of rooms, doors down into the main hall
//   main hall
//   front row of rooms between two side halls, doors down into the front hall
//   front hall, with the front door under the lobby
//   the street, with the bus stop staff arrive and leave by
//
// Everything is seeded from the spec, so the preview and the office it
// becomes are the same, tile for tile.
import { composeWorld } from './compose.ts';
import { findPath } from './path.ts';
import { TILE } from './types.ts';
import type {
  Facing,
  FloorPlan,
  PropPlacement,
  RoomTemplate,
  SpriteCatalog,
  World
} from './types.ts';

export const ROOM_KINDS = [
  'office',
  'workspace',
  'lobby',
  'kitchen',
  'break',
  'library',
  'gym',
  'mail'
] as const;
export const WALLS = ['plaster', 'brick', 'teal'] as const;
export const FLOORS = ['oak', 'carpet', 'tile', 'rubber'] as const;
export const SIZES = ['small', 'medium', 'large'] as const;
export const ACCENTS = ['teal', 'rust', 'sage'] as const;
export const GROUNDS = ['park', 'woods', 'meadow'] as const;
export const PLANTS = ['few', 'some', 'lots'] as const;

export type RoomKind = (typeof ROOM_KINDS)[number];
export type Wall = (typeof WALLS)[number];
export type Floor = (typeof FLOORS)[number];
export type Size = (typeof SIZES)[number];
export type Accent = (typeof ACCENTS)[number];
export type Grounds = (typeof GROUNDS)[number];
export type Plants = (typeof PLANTS)[number];

export type RoomSpec = {
  kind: RoomKind;
  name: string;
  size?: Size;
  /** Desks, for a workspace. */
  seats?: number;
  /** One of WALLS, or a wall style the office drew. */
  wall?: string;
  /** One of FLOORS, or a floor the office drew. */
  floor?: string;
  accent?: Accent;
  /** Sprites from EXTRAS, or props the office drew. */
  extras?: string[];
  /** For a workspace: what stands on every desk, from DESK_TOPS or drawn. */
  desk?: string;
  /** The end of its row a room stands at, when the owner says. Left out, the office arranges it. */
  side?: 'west' | 'east';
  /** The row a room stands in, when the owner says. Left out, it goes to the narrower row. */
  row?: 'back' | 'front';
  /** Changes to what the office furnished it with, applied in order after it does. */
  edits?: RoomEdit[];
};

/**
 * One change to a furnished room. An item is named by its id in the room,
 * `sprite#n` (the nth of that sprite), and a tile counts from the room's
 * top-left corner, walls included.
 */
export type RoomEdit =
  | { remove: string }
  | { move: string; to: [number, number]; hand?: true }
  | { add: string; at: [number, number]; variant?: string; hand?: true };

/** The parts of an office outside its rooms. */
export const AREAS = ['halls', 'street', 'grounds'] as const;
export type Area = (typeof AREAS)[number];
/**
 * Changes to what the office put outside its rooms, by area, each in that
 * area's own tiles from its top-left: the halls in the building's (the back
 * wall is row 0), the street's (the sidewalk by the building is row 0), the
 * grounds' (the whole lot). They apply like a room's edits, at the exact tile.
 */
export type AreaEdits = Partial<Record<Area, RoomEdit[]>>;

/** A deck outside the front door, with seats and things along the building. */
export type Porch = { floor?: string; extras?: string[] };

export type OfficeSpec = {
  name: string;
  /** The halls, and every room that does not pick its own. */
  wall: string;
  floor: string;
  grounds: Grounds;
  plants?: Plants;
  porch?: Porch;
  rooms: RoomSpec[];
  /**
   * A theme's own pieces in place of the library's, everywhere: a torch for
   * every floor lamp, a scribe's desk for every desk. Each stands in exactly:
   * same layer, footprint and spots, so staff use it the same way. An empty
   * string leaves the piece out, for one that has no place in the theme.
   */
  swaps?: Record<string, string>;
  /** False for a building with no windows at all, like a dungeon. */
  windows?: boolean;
  /** The wall style the building shows the street, brick unless a theme says. */
  facade?: string;
  /** What changed in the halls, on the street and on the grounds. */
  areas?: AreaEdits;
};

/** Why a sprite cannot stand in for another, in words. Empty when it can. */
export function swapProblems(from: string, to: string, catalog: SpriteCatalog): string[] {
  const a = catalog[from];
  const b = catalog[to];
  // A ground or floor material (the sidewalk, the road) swaps for another floor.
  if (!a && catalog[`floor-${from}`])
    return catalog[`floor-${to}`] ? [] : [`there is no floor "${to}" to swap in for ${from}`];
  if (!a) return [`there is no "${from}" to swap out`];
  // Staff use anything with a spot, and a door is the way in: those get a stand-in.
  if (to === '')
    return a.spots.length || a.tags.includes('door')
      ? [`Odds use ${from}, so it cannot be left out: draw a stand-in for it`]
      : [];
  if (!b) return [`there is no "${to}" to swap in`];
  const out: string[] = [];
  if (a.layer !== b.layer) out.push(`${to} is layer ${b.layer}, and ${from} is ${a.layer}`);
  if (a.footprint.join() !== b.footprint.join())
    out.push(
      `${to} stands on ${b.footprint.join(' x ')} tiles, and ${from} on ${a.footprint.join(' x ')}`
    );
  if (a.walkable !== b.walkable)
    out.push(`${to} and ${from} differ in whether Odds walk over them`);
  const spots = (m: typeof a) =>
    m.spots
      .map((s) => [s.name, s.dx, s.dy, s.facing, s.activity, s.pose].join(' '))
      .sort()
      .join('; ');
  if (spots(a) !== spots(b))
    out.push(`${to} needs the same spots as ${from}: ${spots(a) || 'none'}`);
  return out;
}

/** What a room of each kind is for, in the words the owner and Claude use. */
export const KIND_ABOUT: Record<RoomKind, string> = {
  office: "the owner's office. Odds come to its desk to talk to the owner",
  workspace: 'desks where Odds work. `seats` sets how many',
  lobby: 'the way in, with a reception desk (one work seat) and a couch',
  kitchen: 'counters and a dining table: where Odds eat',
  break: 'a couch, a TV, arcade machines and beanbags: where Odds rest and play',
  library: 'shelves, armchairs and a reading table: where Odds read',
  gym: 'treadmills, weights, a bike and mats: where Odds exercise',
  mail: 'a sorting table where mail and intake come in (one work seat)'
};

/** Extras any room can ask for, and what each one is. */
export const EXTRAS: Record<string, string> = {
  'plant-tall': 'a tall potted plant',
  'plant-fern': 'a fern',
  'plant-small': 'a small plant',
  'lobby-plant-big': 'a big planter',
  'floor-lamp': 'a floor lamp',
  bookshelf: 'a bookshelf',
  'filing-cabinet': 'a filing cabinet',
  'lobby-aquarium': 'an aquarium, 4 tiles wide',
  'library-fireplace': 'a fireplace',
  'library-globe': 'a globe',
  'library-cat': 'a cat',
  'owner-guitar': 'a guitar on a stand',
  'owner-sideboard': 'a sideboard',
  'break-arcade': 'an arcade machine, a place to play',
  'break-tv': 'a TV',
  'break-vending': 'a vending machine',
  'kitchen-cooler': 'a water cooler',
  'kitchen-coffee': 'a coffee machine',
  'gym-bike': 'an exercise bike, a place to exercise',
  'lobby-couch': 'a couch, a place to rest',
  'break-beanbag': 'a beanbag, a place to play',
  rug: 'a rug',
  'art-frame': 'framed art on the wall',
  whiteboard: 'a whiteboard on the wall',
  'wall-clock': 'a clock on the wall',
  'winter-wreath': 'an evergreen holiday wreath with a ribbon on the wall',
  'owner-photos': 'photos on the wall',
  'break-poster': 'a poster on the wall',
  'break-dartboard': 'a dartboard on the wall',
  'library-map': 'a map on the wall',
  'mail-corkboard': 'a corkboard on the wall'
};

/** What a workspace can stand on every desk. Without one, desks alternate the two. */
export const DESK_TOPS: Record<string, string> = {
  'desk-lamp': 'a desk lamp',
  'plant-small': 'a small plant'
};

/** What the office drew for itself, found by its `drawn` tag in the catalog. */
export function drawnIn(catalog: SpriteCatalog = {}) {
  const out = {
    walls: [] as string[],
    floors: [] as string[],
    extras: [] as string[],
    desk: [] as string[]
  };
  for (const [name, m] of Object.entries(catalog)) {
    if (!m.tags.includes('drawn')) continue;
    const wall = /^wall-(.+)-face$/.exec(name);
    const floor = m.layer === 'floor' && /^floor-(.+)$/.exec(name);
    if (wall) out.walls.push(wall[1]);
    else if (floor) out.floors.push(floor[1]);
    else if (m.tags.includes('place-desk')) out.desk.push(name);
    else if (m.tags.some((t) => t.startsWith('place-'))) out.extras.push(name);
  }
  return out;
}

export const LIMITS = {
  rooms: 12,
  /** Of any one kind, apart from workspaces. The office and lobby are one each. */
  perKind: 2,
  workspaces: 4,
  /** Desks across every workspace. */
  seats: 32,
  seatsPerRoom: 12,
  extras: 6,
  /** Per room. Room edits come from Claude, and from a layout saved while the office offered arranging by hand. */
  edits: 200,
  name: 32,
  roomName: 24,
  /** The building, in tiles. */
  width: 110,
  description: 2000
} as const;

const SIZE_STEP: Record<Size, number> = { small: 0, medium: 1, large: 2 };
/** Width and height of each kind of room, small, medium and large, walls included. */
const DIMS: Partial<Record<RoomKind, [number[], number[]]>> = {
  office: [
    [10, 12, 15],
    [9, 10, 12]
  ],
  lobby: [
    [12, 15, 18],
    [9, 10, 12]
  ],
  kitchen: [
    [11, 14, 17],
    [9, 10, 12]
  ]
};
const DEFAULT_DIMS: [number[], number[]] = [
  [10, 13, 17],
  [9, 10, 12]
];
/** A kind's own floor when the room does not pick one. */
const KIND_FLOOR: Partial<Record<RoomKind, Floor>> = {
  gym: 'rubber',
  kitchen: 'tile',
  mail: 'tile'
};
const HALL = 5;
const FRONT_HALL = 6;
const SIDE = 5;
const STREET_ROWS = 10;
const MARGIN: [number, number, number, number] = [18, 10, 18, 6];

/** Everything wrong with a spec, in words. Empty when it is good. */
export function checkSpec(spec: OfficeSpec, catalog?: SpriteCatalog): string[] {
  const out: string[] = [];
  const drawn = drawnIn(catalog);
  const walls = [...WALLS, ...drawn.walls];
  const floors = [...FLOORS, ...drawn.floors];
  const isExtra = (e: string) => e in EXTRAS || drawn.extras.includes(e);
  // Any library thing that stands in a room or hangs on its wall can be added
  // by hand: not a tile, a wall style or a person.
  const isPiece = (s: string) => {
    const m = catalog?.[s];
    return (
      !!m &&
      ['object', 'floor', 'wall'].includes(m.layer) &&
      !/^(wall|floor)-/.test(s) &&
      !m.tags.includes('character')
    );
  };
  const checkExtras = (at: string, extras: unknown, porch = false) => {
    if (extras === undefined) return;
    if (!Array.isArray(extras)) return out.push(`${at}: extras must be a list`);
    if (extras.length > LIMITS.extras)
      out.push(`${at}: ${extras.length} extras is over the limit of ${LIMITS.extras}`);
    for (const e of extras)
      if (!isExtra(e)) out.push(`${at}: there is no extra "${e}"`);
      else if (porch && (catalog?.[e]?.footprint[1] ?? 1) > 1)
        out.push(`${at}: "${e}" is more than one tile deep, and the porch is one`);
  };
  const oneOf = <T extends string>(
    list: readonly T[],
    v: unknown,
    what: string,
    optional = false
  ) => {
    if (v === undefined && optional) return;
    if (!list.includes(v as T)) out.push(`${what} "${String(v)}" is not one of ${list.join(', ')}`);
  };
  if (!spec || typeof spec !== 'object') return ['the spec is not an object'];
  if (typeof spec.name !== 'string' || !spec.name.trim()) out.push('the office needs a name');
  else if (spec.name.length > LIMITS.name) out.push(`the name is over ${LIMITS.name} characters`);
  oneOf(walls, spec.wall, 'wall');
  oneOf(floors, spec.floor, 'floor');
  oneOf(GROUNDS, spec.grounds, 'grounds');
  oneOf(PLANTS, spec.plants, 'plants', true);
  oneOf(walls, spec.facade, 'facade', true);
  if (spec.windows !== undefined && typeof spec.windows !== 'boolean')
    out.push('windows is true or false');
  if (spec.swaps !== undefined) {
    if (!spec.swaps || typeof spec.swaps !== 'object' || Array.isArray(spec.swaps))
      out.push('swaps maps a library sprite to the one that stands in for it');
    else if (catalog)
      for (const [from, to] of Object.entries(spec.swaps))
        out.push(...swapProblems(from, String(to), catalog).map((p) => `swap ${from}: ${p}`));
  }
  /** A room's or an area's edits: each a remove, a move or an add, naming what it can. */
  const checkEdits = (at: string, edits: unknown) => {
    if (edits === undefined) return;
    if (!Array.isArray(edits)) out.push(`${at}: edits must be a list`);
    else {
      if (edits.length > LIMITS.edits)
        out.push(`${at}: ${edits.length} edits is over the limit of ${LIMITS.edits}`);
      const tile = (v: unknown) =>
        Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0);
      for (const e of edits as Record<string, unknown>[]) {
        if (!e || typeof e !== 'object') out.push(`${at}: an edit is not an object`);
        else if ('remove' in e) {
          if (typeof e.remove !== 'string') out.push(`${at}: remove names an item, like "rug#1"`);
        } else if ('move' in e) {
          if (typeof e.move !== 'string' || !tile(e.to))
            out.push(`${at}: move names an item and a tile, like {"move": "rug#1", "to": [4, 5]}`);
        } else if ('add' in e) {
          if (typeof e.add !== 'string' || !tile(e.at))
            out.push(
              `${at}: add names a sprite and a tile, like {"add": "plant-tall", "at": [2, 4]}`
            );
          else if (!isExtra(e.add) && !isPiece(e.add))
            out.push(`${at}: there is no "${e.add}" to add`);
        } else out.push(`${at}: an edit is remove, move or add`);
      }
    }
  };
  if (spec.areas !== undefined) {
    if (!spec.areas || typeof spec.areas !== 'object' || Array.isArray(spec.areas))
      out.push('areas maps halls, street or grounds to its edits');
    else
      for (const [k, v] of Object.entries(spec.areas))
        if (!AREAS.includes(k as Area))
          out.push(`there is no area "${k}": halls, street or grounds`);
        else checkEdits(`the ${k}`, v);
  }
  if (spec.porch !== undefined) {
    if (!spec.porch || typeof spec.porch !== 'object') out.push('porch must be an object');
    else {
      oneOf(floors, spec.porch.floor, 'porch floor', true);
      checkExtras('the porch', spec.porch.extras, true);
    }
  }
  if (!Array.isArray(spec.rooms)) return [...out, 'rooms must be a list'];
  if (spec.rooms.length > LIMITS.rooms)
    out.push(`${spec.rooms.length} rooms is over the limit of ${LIMITS.rooms}`);
  const count = (k: RoomKind) => spec.rooms.filter((r) => r?.kind === k).length;
  if (count('office') !== 1) out.push('there must be exactly one office');
  if (count('lobby') !== 1) out.push('there must be exactly one lobby');
  const workspaces = count('workspace');
  if (workspaces < 1) out.push('there must be at least one workspace');
  if (workspaces > LIMITS.workspaces)
    out.push(`${workspaces} workspaces is over the limit of ${LIMITS.workspaces}`);
  for (const k of ROOM_KINDS)
    if (!['office', 'lobby', 'workspace'].includes(k) && count(k) > LIMITS.perKind)
      out.push(`${count(k)} rooms of kind ${k} is over the limit of ${LIMITS.perKind}`);
  let seats = 0;
  spec.rooms.forEach((r, i) => {
    const at = `room ${i + 1}${r?.name ? ` (${r.name})` : ''}`;
    if (!r || typeof r !== 'object') return out.push(`${at} is not an object`);
    oneOf(ROOM_KINDS, r.kind, `${at} kind`);
    oneOf(['west', 'east'], r.side, `${at} side`, true);
    oneOf(['back', 'front'], r.row, `${at} row`, true);
    if ((r.kind === 'office' || r.kind === 'lobby') && (r.side || r.row))
      out.push(
        `${at}: the ${r.kind} always stands in the middle of its row; leave out side and row`
      );
    if (typeof r.name !== 'string' || !r.name.trim()) out.push(`${at} needs a name`);
    else if (r.name.length > LIMITS.roomName)
      out.push(`${at}: the name is over ${LIMITS.roomName} characters`);
    oneOf(SIZES, r.size, `${at} size`, true);
    oneOf(walls, r.wall, `${at} wall`, true);
    oneOf(floors, r.floor, `${at} floor`, true);
    oneOf(ACCENTS, r.accent, `${at} accent`, true);
    if (r.kind === 'workspace') {
      if (!Number.isInteger(r.seats) || r.seats! < 1 || r.seats! > LIMITS.seatsPerRoom)
        out.push(`${at}: seats must be a whole number from 1 to ${LIMITS.seatsPerRoom}`);
      else seats += r.seats!;
    } else if (r.seats !== undefined) out.push(`${at}: only a workspace has seats`);
    if (r.desk !== undefined) {
      if (r.kind !== 'workspace') out.push(`${at}: only a workspace has desks to put things on`);
      else if (!(r.desk in DESK_TOPS) && !drawn.desk.includes(r.desk))
        out.push(`${at}: "${r.desk}" cannot stand on a desk`);
    }
    checkExtras(at, r.extras);
    checkEdits(at, r.edits);
  });
  if (seats > LIMITS.seats) out.push(`${seats} desks is over the limit of ${LIMITS.seats}`);
  return out;
}

// ---------------------------------------------------------------------------
// Furnishing one room

type Item = {
  sprite: string;
  dx: number;
  dy: number;
  variant?: string;
  flip?: boolean;
  /** A frame other than the default, like `side` for a prop against a side wall. */
  frame?: string;
};
/**
 * Props that go together, like a couch and its coffee table. `back` stands
 * against the back wall, `floor` anywhere with a tile of space around it,
 * `wall` hangs on the back wall, `corner` fills a free tile near the front.
 * A `must` piece is what the room is for: the room grows until it fits.
 */
type Piece = {
  place: 'back' | 'floor' | 'wall' | 'corner';
  items: Item[];
  must?: boolean;
  /** The room's centrepiece, like the kitchen table: it goes nearest the middle. */
  center?: boolean;
};

type Spot = { tile: [number, number]; facing: Facing };
type Room = {
  w: number;
  h: number;
  door: number;
  used: Set<number>;
  blocked: Set<number>;
  /** Floor that must stay open: in front of a shelf or a screen, or where someone stands to use a thing. */
  keep: Set<number>;
  /** Where each standing thing's art shows, in pixels, so a tall one never hides a short one. */
  art: [number, number, number, number][];
  wall: Set<number>;
  /**
   * What lies flat on the floor (a rug, a mat) and what stands, by tile, and
   * the flat things' art. Placing by hand may stand a thing on a rug.
   */
  rugs: Set<number>;
  things: Set<number>;
  rugArt: [number, number, number, number][];
  props: PropPlacement[];
  spots: Spot[];
};

/**
 * What a sprite says about how it is used, from its tags. `clear-<n>` keeps
 * n rows open in front of it. `any-side` looks right against any wall, like a
 * plant or a lamp; anything else stands with its front to the room, against a
 * side wall only if it has a `side` frame.
 */
const clearOf = (m: SpriteCatalog[string] | undefined) =>
  Number(m?.tags.find((t) => t.startsWith('clear-'))?.slice(6) ?? 0);
const anySide = (m: SpriteCatalog[string] | undefined) => !!m?.tags.includes('any-side');

const STEP: Record<Facing, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0]
};
const FLIP: Record<Facing, Facing> = { up: 'up', down: 'down', left: 'right', right: 'left' };

/** A sprite in words, without its room kind: "break-vending" reads "vending". */
function pieceWords(sprite: string): string {
  return sprite
    .replace(/^(break|kitchen|library|gym|lobby|mail|owner|street)-/, '')
    .replaceAll('-', ' ');
}

/** Ids for an area's props, `sprite#n` in the order they were placed. */
function withIds(props: PropPlacement[]) {
  const n = new Map<string, number>();
  for (const p of props) {
    const k = (n.get(p.sprite) ?? 0) + 1;
    n.set(p.sprite, k);
    p.id ??= `${p.sprite}#${k}`;
  }
}

/** What an area takes where: floor to stand on, wall to hang on, ground that stays open. */
type AreaRules = {
  /** Where a standing thing may not go, in words: "the sidewalk". */
  ground: string;
  stands: (x: number, y: number) => boolean;
  hangs: (x: number, y: number) => boolean;
  keep: Set<string>;
};

/**
 * An area's edits on its props, in order, each at the exact tile it names. A
 * thing stands on the area's own floor, off what stays open and off other
 * things; one that cannot is left where it was, and the note says why.
 */
function editArea(
  name: string,
  props: PropPlacement[],
  edits: RoomEdit[],
  catalog: SpriteCatalog,
  rules: AreaRules,
  notes: string[]
) {
  const layer = (s: string) => catalog[s]?.layer;
  const cells = (p: Pick<PropPlacement, 'sprite' | 'at'>) => {
    const [fw, fh] = catalog[p.sprite]?.footprint ?? [1, 1];
    return Array.from({ length: fw * fh }, (_, k): [number, number] => [
      p.at[0] + (k % fw),
      p.at[1] + Math.floor(k / fw)
    ]);
  };
  const why = (p: Pick<PropPlacement, 'sprite' | 'at'>, others: PropPlacement[]) => {
    const wall = layer(p.sprite) === 'wall';
    const flat = layer(p.sprite) === 'floor';
    for (const [x, y] of cells(p)) {
      if (wall ? !rules.hangs(x, y) : !rules.stands(x, y))
        return wall ? 'would hang off the wall' : `would stand off ${rules.ground}`;
      if (!wall && !flat && rules.keep.has(`${x},${y}`)) return 'would block the way in';
      const under = others.find(
        (q) =>
          (layer(q.sprite) === 'wall') === wall &&
          (layer(q.sprite) === 'floor') === flat &&
          cells(q).some(([qx, qy]) => qx === x && qy === y)
      );
      if (under) return `would ${wall ? 'hang over' : 'stand on'} the ${pieceWords(under.sprite)}`;
    }
    return undefined;
  };
  for (const e of edits) {
    if ('remove' in e) {
      const i = props.findIndex((p) => p.id === e.remove);
      if (i < 0) notes.push(`${name}: there is no ${e.remove} to remove.`);
      else props.splice(i, 1);
    } else if ('move' in e) {
      const p = props.find((q) => q.id === e.move);
      if (!p) {
        notes.push(`${name}: there is no ${e.move} to move.`);
        continue;
      }
      const no = why(
        { sprite: p.sprite, at: e.to },
        props.filter((q) => q !== p)
      );
      if (no) notes.push(`${name}: the ${pieceWords(p.sprite)} ${no}, so it stayed.`);
      else p.at = [...e.to];
    } else {
      const what = pieceWords(e.add);
      const a = `${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}`;
      if (!catalog[e.add]) {
        notes.push(`${name}: there is no ${e.add} to add.`);
        continue;
      }
      const no = why({ sprite: e.add, at: e.at }, props);
      if (no) notes.push(`${name}: ${a} ${no}.`);
      else {
        const n =
          Math.max(
            0,
            ...props.filter((q) => q.sprite === e.add).map((q) => Number(q.id?.split('#')[1] ?? 0))
          ) + 1;
        props.push({
          sprite: e.add,
          at: [...e.at],
          id: `${e.add}#${n}`,
          ...(e.variant ? { variant: e.variant } : {})
        });
      }
    }
  }
}

function rng(seed: string): () => number {
  let a = 1779033703;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 3432918353);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tiles from `at` outward, nearest first, up to `reach` away: an edit lands
 * on the tile it names, or the closest one that fits, as a person would put it.
 */
function nearby([x, y]: [number, number], reach = 3): [number, number][] {
  const out: [number, number][] = [];
  for (let d = 0; d <= reach; d++)
    for (let dy = -d; dy <= d; dy++)
      for (let dx = -d; dx <= d; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === d) out.push([x + dx, y + dy]);
  return out;
}

class Furnisher {
  readonly catalog: SpriteCatalog;
  private accent: Accent | undefined;
  constructor(catalog: SpriteCatalog, accent: Accent | undefined) {
    this.catalog = catalog;
    this.accent = accent;
  }

  /** The accent if the sprite comes in it, otherwise its own colour. */
  tint(sprite: string, accent = this.accent): string | undefined {
    return accent && this.catalog[sprite]?.variants.includes(accent) ? accent : undefined;
  }

  /** The nth colour a sprite comes in, its own first, for rows of the same thing. */
  nth(sprite: string, n: number): string | undefined {
    const all = [undefined, ...(this.catalog[sprite]?.variants ?? [])];
    return all[n % all.length];
  }

  it(sprite: string, dx = 0, dy = 0, opts: { variant?: string; flip?: boolean } = {}): Item {
    return { sprite, dx, dy, variant: opts.variant ?? this.tint(sprite), flip: opts.flip };
  }

  empty(w: number, h: number): Room {
    return {
      w,
      h,
      door: Math.floor((w - 2) / 2),
      used: new Set(),
      blocked: new Set(),
      keep: new Set(),
      art: [],
      wall: new Set(),
      rugs: new Set(),
      things: new Set(),
      rugArt: [],
      props: [],
      spots: []
    };
  }

  /**
   * Where a standing thing's art shows, in room pixels. A tall lamp's shade
   * rises over the tiles behind it; nothing of its own height or less may
   * stand there, or the lamp hides it. Rugs and wall hangings do not count.
   */
  private artBox(
    sprite: string,
    x: number,
    y: number,
    flip?: boolean
  ): [number, number, number, number] | undefined {
    const def = this.catalog[sprite];
    if (!def || def.layer !== 'object' || y < 3) return undefined;
    const ox = flip ? def.width - def.footprint[0] * TILE - def.origin[0] : def.origin[0];
    return [x * TILE - ox, y * TILE - def.origin[1], def.width, def.height];
  }

  /**
   * True when a box and a standing thing's art would mostly hide one of them:
   * more than half the smaller one covered. A lamp in front of a fireplace is
   * fine; a cat behind a lamp's shade is not.
   */
  private hides(
    r: Room,
    [x, y, w, h]: [number, number, number, number],
    overRugs = false
  ): boolean {
    return r.art.some((a) => {
      if (overRugs && r.rugArt.includes(a)) return false;
      const [ax, ay, aw, ah] = a;
      const ow = Math.min(x + w, ax + aw) - Math.max(x, ax);
      const oh = Math.min(y + h, ay + ah) - Math.max(y, ay);
      return ow > 0 && oh > 0 && ow * oh * 2 > Math.min(w * h, aw * ah);
    });
  }

  /**
   * The floor a piece needs open to be used: the rows its `clear-<n>` tag
   * asks for in front of it (to the side it faces, for a side view), and any
   * spot that stands off its footprint, like the tile in front of an arcade.
   */
  private front(p: Piece, x: number, y: number): number[][] {
    const out: number[][] = [];
    for (const i of p.items) {
      const def = this.catalog[i.sprite];
      if (!def || def.layer === 'wall' || i.dy < 0) continue;
      const [fw, fh] = def.footprint;
      const ax = x + i.dx;
      const ay = y + i.dy;
      const n = clearOf(def);
      for (let k = 0; k < n; k++)
        if (i.frame === 'side') {
          const cx = i.flip ? ax - 1 - k : ax + fw + k;
          for (let dy = 0; dy < fh; dy++) out.push([cx, ay + dy]);
        } else for (let dx = 0; dx < fw; dx++) out.push([ax + dx, ay + fh + k]);
      for (const s of def.spots) {
        const sx = ax + (i.flip ? fw - 1 - s.dx : s.dx);
        const sy = ay + s.dy;
        if (s.dx >= fw || s.dy >= fh || s.dx < 0 || s.dy < 0) out.push([sx, sy]);
      }
    }
    return out;
  }

  private cells(p: Piece, x: number, y: number) {
    const out: [number, number][] = [];
    for (const i of p.items) {
      const def = this.catalog[i.sprite];
      if (!def || def.layer === 'wall' || i.dy < 0) continue;
      const [fw, fh] = def.footprint;
      for (let dy = 0; dy < fh; dy++)
        for (let dx = 0; dx < fw; dx++) out.push([x + i.dx + dx, y + i.dy + dy]);
    }
    return out;
  }

  private wallCells(p: Piece, x: number) {
    const out: number[] = [];
    for (const i of p.items) {
      const def = this.catalog[i.sprite];
      if (!def || (def.layer !== 'wall' && i.dy >= 0)) continue;
      for (let dx = 0; dx < def.footprint[0]; dx++) out.push(x + i.dx + dx);
    }
    return out;
  }

  /** Floor a piece may stand on: inside the walls, clear of the back wall and the front row. */
  private inside(r: Room, x: number, y: number) {
    return x >= 1 && x <= r.w - 2 && y >= 3 && y <= r.h - 3;
  }

  /** The way in, from the door gap up two rows, stays clear. */
  private doorway(r: Room, x: number, y: number) {
    return (x === r.door || x === r.door + 1) && y >= r.h - 4;
  }

  /**
   * Whether a piece fits at a tile. `overRugs` is for placing by hand: a
   * standing thing may go on a rug or a mat, and a rug under standing things;
   * only a rug on a rug is refused. The furnisher keeps them apart.
   */
  fits(r: Room, p: Piece, x: number, y: number, pad: boolean, overRugs = false): boolean {
    // Nothing solid stands where another piece needs the floor open.
    const solid = new Set(
      p.items.flatMap((i) => {
        const def = this.catalog[i.sprite];
        if (!def || def.layer !== 'object' || def.walkable || i.dy < 0) return [];
        const [fw, fh] = def.footprint;
        return Array.from(
          { length: fw * fh },
          (_, k) => (y + i.dy + Math.floor(k / fw)) * r.w + x + i.dx + (k % fw)
        );
      })
    );
    for (const k of solid) if (r.keep.has(k)) return false;
    // Nothing stands where it would hide, or be hidden by, something already there.
    for (const i of p.items) {
      if (overRugs && this.catalog[i.sprite]?.layer === 'floor') continue;
      const box = this.artBox(i.sprite, x + i.dx, y + i.dy, i.flip);
      if (box && this.hides(r, box, overRugs)) return false;
    }
    // And what this piece needs open is open, and inside the room.
    for (const [fx, fy] of this.front(p, x, y)) {
      if (fx < 1 || fx > r.w - 2 || fy < 3 || fy > r.h - 2) return false;
      if (r.blocked.has(fy * r.w + fx) || solid.has(fy * r.w + fx)) return false;
    }
    for (const i of p.items) {
      const def = this.catalog[i.sprite];
      if (!def || def.layer === 'wall' || i.dy < 0) continue;
      const taken = !overRugs ? r.used : def.layer === 'floor' ? r.rugs : r.things;
      const [fw, fh] = def.footprint;
      for (let dy = 0; dy < fh; dy++)
        for (let dx = 0; dx < fw; dx++) {
          const [cx, cy] = [x + i.dx + dx, y + i.dy + dy];
          if (!this.inside(r, cx, cy) || this.doorway(r, cx, cy)) return false;
          if (taken.has(cy * r.w + cx)) return false;
          if (pad)
            for (let oy = -1; oy <= 1; oy++)
              for (let ox = -1; ox <= 1; ox++)
                if (r.used.has((cy + oy) * r.w + cx + ox)) return false;
        }
    }
    for (const cx of this.wallCells(p, x))
      if (cx < 1 || cx > r.w - 2 || r.wall.has(cx)) return false;
    return true;
  }

  /** Place a piece, and take it back if it leaves any seat out of reach. */
  put(r: Room, p: Piece, x: number, y: number): boolean {
    const before = {
      used: new Set(r.used),
      blocked: new Set(r.blocked),
      keep: new Set(r.keep),
      art: [...r.art],
      wall: new Set(r.wall),
      rugs: new Set(r.rugs),
      things: new Set(r.things),
      rugArt: [...r.rugArt],
      props: r.props.length,
      spots: r.spots.length
    };
    let group: string | undefined;
    for (const i of p.items) {
      if (!this.catalog[i.sprite]) continue;
      // The next number for this sprite, never one a removed item had.
      const n =
        Math.max(
          0,
          ...r.props
            .filter((q) => q.sprite === i.sprite)
            .map((q) => Number(q.id?.split('#')[1] ?? 0))
        ) + 1;
      const prop: PropPlacement = {
        sprite: i.sprite,
        at: [x + i.dx, y + i.dy],
        ...(i.variant ? { variant: i.variant } : {}),
        ...(i.flip ? { flip: true } : {}),
        ...(i.frame ? { frame: i.frame } : {}),
        id: `${i.sprite}#${n}`
      };
      // Things placed together stay together: a desk, its chair and its lamp.
      if (p.items.length > 1) prop.group = group ??= prop.id;
      r.props.push(prop);
      this.mark(r, prop);
    }
    if (this.reachable(r)) return true;
    Object.assign(r, {
      used: before.used,
      blocked: before.blocked,
      keep: before.keep,
      art: before.art,
      wall: before.wall,
      rugs: before.rugs,
      things: before.things,
      rugArt: before.rugArt
    });
    r.props.length = before.props;
    r.spots.length = before.spots;
    return false;
  }

  /**
   * Every seat's way in can be walked to from the door, as the office will
   * walk it: never through the seat itself, since a path only steps onto a
   * seat from its way in.
   */
  reachable(r: Room): boolean {
    const open = (x: number, y: number) =>
      x >= 1 && x <= r.w - 2 && y >= 3 && y <= r.h - 2 && !r.blocked.has(y * r.w + x);
    const walk = (avoid: number) => {
      const seen = new Set<number>([(r.h - 2) * r.w + r.door]);
      const queue: [number, number][] = [[r.door, r.h - 2]];
      while (queue.length) {
        const [x, y] = queue.shift()!;
        for (const [sx, sy] of Object.values(STEP)) {
          const [nx, ny] = [x + sx, y + sy];
          const k = ny * r.w + nx;
          if (k !== avoid && !seen.has(k) && open(nx, ny)) {
            seen.add(k);
            queue.push([nx, ny]);
          }
        }
      }
      return seen;
    };
    return r.spots.every(({ tile: [x, y], facing }) => {
      const [fx, fy] = STEP[facing];
      const sides: [number, number][] = [
        [x + fx, y + fy],
        [x - fx, y - fy],
        [x + fy, y + fx],
        [x - fy, y - fx]
      ];
      const way = sides.find(([ax, ay]) => open(ax, ay));
      return !!way && walk(y * r.w + x).has(way[1] * r.w + way[0]);
    });
  }

  /** What one placed prop holds: its floor or wall, the floor it keeps open, its spots. */
  mark(r: Room, p: PropPlacement) {
    const def = this.catalog[p.sprite];
    if (!def) return;
    const [ax, ay] = p.at;
    const [fw, fh] = def.footprint;
    if (def.layer === 'wall' || ay < 3) {
      for (let dx = 0; dx < fw; dx++) r.wall.add(ax + dx);
      return;
    }
    const flat = def.layer === 'floor';
    const box = this.artBox(p.sprite, ax, ay, p.flip);
    if (box) r.art.push(box);
    if (box && flat) r.rugArt.push(box);
    for (let dy = 0; dy < fh; dy++)
      for (let dx = 0; dx < fw; dx++) {
        r.used.add((ay + dy) * r.w + ax + dx);
        (flat ? r.rugs : r.things).add((ay + dy) * r.w + ax + dx);
        if (def.layer === 'object' && !def.walkable) r.blocked.add((ay + dy) * r.w + ax + dx);
      }
    const item: Item = { sprite: p.sprite, dx: 0, dy: 0, flip: p.flip, frame: p.frame };
    for (const [fx, fy] of this.front({ place: 'floor', items: [item] }, ax, ay))
      r.keep.add(fy * r.w + fx);
    for (const s of def.spots)
      r.spots.push({
        tile: [ax + (p.flip ? fw - 1 - s.dx : s.dx), ay + s.dy],
        facing: p.flip ? FLIP[s.facing] : s.facing
      });
  }

  /** Take out the pieces a theme leaves out, so nothing unseen holds a tile. */
  leaveOut(r: Room, gone: (sprite: string) => boolean) {
    if (!r.props.some((p) => gone(p.sprite))) return;
    r.props = r.props.filter((p) => !gone(p.sprite));
    this.index(r);
  }

  /** Work out what every prop holds again, after one is taken out. */
  private index(r: Room) {
    Object.assign(r, {
      used: new Set(),
      blocked: new Set(),
      keep: new Set(),
      art: [],
      wall: new Set(),
      rugs: new Set(),
      things: new Set(),
      rugArt: []
    });
    r.spots.length = 0;
    for (const p of r.props) this.mark(r, p);
  }

  /**
   * Put one item at a tile, turned to face the room on a side wall. A thing
   * that hangs on a wall goes on the back wall above the tile's column.
   */
  private putAt(r: Room, sprite: string, at: [number, number], extra: Partial<Item>): boolean {
    const def = this.catalog[sprite];
    if (!def) return false;
    const hangs = def.layer === 'wall';
    for (const [tx, ty] of nearby(at)) {
      // A wall hanging only slides along the wall.
      if (hangs && ty !== at[1]) continue;
      const [x, y] = hangs ? [tx, 2] : [tx, ty];
      const piece = this.orient(
        r,
        { place: hangs ? 'wall' : 'corner', items: [{ ...this.it(sprite), ...extra }] },
        x,
        y
      );
      if (piece && this.fits(r, piece, x, y, false, true) && this.put(r, piece, x, y)) return true;
    }
    return false;
  }

  /**
   * What moves with a thing the owner drags, of what was placed with it: what
   * stands on it (a desk's lamp), at its seats (the desk's chair, the kitchen
   * table's), or as a chair facing it (the owner's chair behind their desk).
   * A chair beside it but facing elsewhere stays, and so does a couch placed
   * to face a TV. A rug moves alone: what stands on it is not part of it.
   */
  private attached(r: Room, p: PropPlacement): PropPlacement[] {
    const def = this.catalog[p.sprite];
    if (!p.group || !def || def.layer === 'floor') return [p];
    const [fw, fh] = def.footprint;
    const [ax, ay] = p.at;
    const within = (x: number, y: number) => x >= ax && y >= ay && x < ax + fw && y < ay + fh;
    const on = (q: PropPlacement) => {
      const [x, y] = q.at;
      const seat = this.catalog[q.sprite];
      return (
        within(x, y) ||
        def.spots.some((s) => ax + (p.flip ? fw - 1 - s.dx : s.dx) === x && ay + s.dy === y) ||
        // A chair faces down the room, so what it is for stands on the tile below it.
        (!!seat?.tags.includes('chair') && within(x, y + seat.footprint[1]))
      );
    };
    return [p, ...r.props.filter((q) => q !== p && q.group === p.group && on(q))];
  }

  /** The thing standing on a tile, in words: a rug for a rug, or what stands there. */
  private standing(r: Room, x: number, y: number, flat: boolean): string {
    const p = r.props.find((q) => {
      const def = this.catalog[q.sprite];
      if (!def || def.layer === 'wall' || (def.layer === 'floor') !== flat) return false;
      const [fw, fh] = def.footprint;
      return x >= q.at[0] && y >= q.at[1] && x < q.at[0] + fw && y < q.at[1] + fh;
    });
    return p ? pieceWords(p.sprite) : 'something';
  }

  /**
   * Put a piece exactly where the owner dropped it. Only what keeps the office
   * working is checked: it stands on the room's floor, off the doorway (unless
   * it lies flat, like a rug) and off other things, and every seat can still be reached. The rest (what keeps
   * the floor open, what hides what) is the owner's call. Returns why it
   * cannot go there, or nothing once it is down.
   */
  private byHand(r: Room, p: Piece, [tx, ty]: [number, number]): string | undefined {
    const hangs = p.items.every((i) => this.catalog[i.sprite]?.layer === 'wall');
    const [x, y] = hangs ? [tx, 2] : [tx, ty];
    const piece = this.orient(r, p, x, y) ?? p;
    for (const i of piece.items) {
      const def = this.catalog[i.sprite];
      if (!def) continue;
      const [fw, fh] = def.footprint;
      // What it holds is where it lands: the back wall's rows, or the floor. A
      // pendant hangs over the room, over whatever stands below it.
      const onWall = y + i.dy < 3;
      if (def.layer === 'wall' && !onWall) continue;
      if (onWall) {
        for (let dx = 0; dx < fw; dx++) {
          const cx = x + i.dx + dx;
          if (cx < 1 || cx > r.w - 2) return 'would hang past the end of the wall';
          if (r.wall.has(cx)) return 'would hang over something already on that wall';
        }
        continue;
      }
      const flat = def.layer === 'floor';
      // A rug or a mat is walked over, so it may lie in the doorway.
      for (let dy = 0; dy < fh; dy++)
        for (let dx = 0; dx < fw; dx++) {
          const [cx, cy] = [x + i.dx + dx, y + i.dy + dy];
          if (!this.inside(r, cx, cy)) return "would stand off the room's floor";
          if (!flat && this.doorway(r, cx, cy)) return 'would block the door';
          if ((flat ? r.rugs : r.things).has(cy * r.w + cx))
            return `would stand on the ${this.standing(r, cx, cy, flat)}`;
        }
    }
    return this.put(r, piece, x, y) ? undefined : 'would leave a seat nobody can reach';
  }

  /** A prop and, if it is the first of a group, everything placed with it. */
  private together(r: Room, p: PropPlacement): PropPlacement[] {
    return p.group === p.id ? r.props.filter((q) => q.group === p.id) : [p];
  }

  /** Props as one piece, laid out around the first. One alone turns to face the room on a side wall. */
  private pieceOf(
    set: Pick<PropPlacement, 'sprite' | 'at' | 'variant' | 'flip' | 'frame'>[]
  ): Piece {
    const [lead] = set;
    if (set.length === 1) {
      const hangs = this.catalog[lead.sprite]?.layer === 'wall';
      return {
        place: hangs ? 'wall' : 'corner',
        items: [{ ...this.it(lead.sprite), ...(lead.variant ? { variant: lead.variant } : {}) }]
      };
    }
    return {
      place: 'floor',
      items: set.map((p) => ({
        sprite: p.sprite,
        dx: p.at[0] - lead.at[0],
        dy: p.at[1] - lead.at[1],
        variant: p.variant,
        flip: p.flip,
        frame: p.frame
      }))
    };
  }

  /**
   * Put a set of props down again with its first at a tile, the rest where
   * they stood beside it, keeping their ids. A lone prop on a side wall turns
   * to face the room.
   */
  private putGroup(r: Room, set: PropPlacement[], to: [number, number]): boolean {
    const [lead] = set;
    if (set.length === 1) {
      const ok = this.putAt(r, lead.sprite, to, { variant: lead.variant });
      if (ok) Object.assign(r.props[r.props.length - 1], { id: lead.id, group: lead.group });
      return ok;
    }
    const piece: Piece = {
      place: 'floor',
      items: set.map((p) => ({
        sprite: p.sprite,
        dx: p.at[0] - lead.at[0],
        dy: p.at[1] - lead.at[1],
        variant: p.variant,
        flip: p.flip,
        frame: p.frame
      }))
    };
    const spot = nearby(to).find(
      ([x, y]) => this.fits(r, piece, x, y, false, true) && this.put(r, piece, x, y)
    );
    if (!spot) return false;
    const placed = r.props.slice(-set.length);
    placed.forEach((p, k) => Object.assign(p, { id: set[k].id, group: set[k].group }));
    return true;
  }

  /**
   * The owner's changes to a furnished room, in order. A change that would
   * leave a seat out of reach, block what needs the floor open, or name
   * something not there is left out, and the note says so.
   */
  edit(r: Room, edits: RoomEdit[], room: string, notes: string[]) {
    const named = (id: string) => r.props.findIndex((p) => p.id === id);
    for (const e of edits) {
      if ('remove' in e) {
        const at = named(e.remove);
        if (at < 0) notes.push(`${room}: there is no ${e.remove} to remove.`);
        else {
          const gone = new Set(this.together(r, r.props[at]));
          r.props = r.props.filter((p) => !gone.has(p));
          this.index(r);
        }
      } else if ('move' in e) {
        const at = named(e.move);
        if (at < 0) {
          notes.push(`${room}: there is no ${e.move} to move.`);
          continue;
        }
        const lead = r.props[at];
        const set = e.hand ? this.attached(r, lead) : this.together(r, lead);
        const before = [...r.props];
        r.props = r.props.filter((p) => !set.includes(p));
        this.index(r);
        const why = e.hand
          ? this.byHand(r, this.pieceOf(set), e.to)
          : this.putGroup(r, set, e.to)
            ? undefined
            : `does not fit at or near ${e.to.join(', ')}`;
        if (why) {
          r.props = before;
          this.index(r);
          const name = e.hand ? `the ${pieceWords(lead.sprite)}` : lead.id;
          notes.push(`${room}: ${name} ${why}, so it stayed.`);
        } else if (e.hand) {
          // Keep the ids it had. What moved together is now its own group, led
          // by the thing dragged, and leaves behind the group it came from.
          r.props.slice(-set.length).forEach((p, k) => {
            p.id = set[k].id;
            if (set.length > 1) p.group = lead.id;
            else delete p.group;
          });
        }
      } else {
        const what = e.hand ? pieceWords(e.add) : e.add.replaceAll('-', ' ');
        const a = `${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}`;
        const extra = e.variant ? { variant: e.variant } : {};
        if (e.hand) {
          const why = this.byHand(r, this.pieceOf([{ sprite: e.add, at: e.at, ...extra }]), e.at);
          if (why) notes.push(`${room}: ${a} ${why}.`);
        } else if (!this.putAt(r, e.add, e.at, extra))
          notes.push(`${room}: ${a} does not fit at or near ${e.at.join(', ')}.`);
      }
    }
  }

  /** Where a piece of each kind tries to go, best first. */
  private candidates(r: Room, p: Piece, n: number): [number, number][] {
    const out: [number, number][] = [];
    const xs = Array.from({ length: r.w }, (_, i) => i);
    // Alternate sides, so a room fills evenly instead of from the left.
    const side = n % 2 === 0 ? xs : [...xs].reverse();
    if (p.place === 'back') for (const x of side) out.push([x, 3]);
    else if (p.place === 'wall') {
      const mid = Math.floor(r.w / 2);
      const byMiddle = [...xs].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
      for (const x of n % 2 === 0 ? byMiddle : side) out.push([x, 2]);
    } else if (p.place === 'corner') {
      for (let y = r.h - 3; y >= 3; y--) for (const x of [1, r.w - 2]) out.push([x, y]);
      for (const x of side) out.push([x, 3]);
    } else for (let y = 4; y <= r.h - 3; y++) for (const x of side) out.push([x, y]);
    return out;
  }

  /**
   * A corner piece against a side wall turns to face the room: a prop that
   * looks right from any side stays as it is, one with a side view shows it
   * (mirrored on the east wall), and one with only a front cannot go there.
   */
  private orient(r: Room, p: Piece, x: number, y: number): Piece | undefined {
    const onSide = p.place === 'corner' && y > 3 && (x === 1 || x === r.w - 2);
    if (!onSide) return p;
    const items: Item[] = [];
    for (const i of p.items) {
      const def = this.catalog[i.sprite];
      if (anySide(def)) items.push(i);
      else if (def?.frames.includes('side'))
        items.push({ ...i, frame: 'side', flip: x === r.w - 2 });
      else return undefined;
    }
    return { ...p, items };
  }

  /**
   * How good a spot is, higher better: a tile of room around it, so things
   * against a wall do not crowd each other, and for the room's centrepiece,
   * the middle of the room. Candidate order decides the rest, which keeps a
   * group like armchairs where it reads best. More space than a tile counts
   * for nothing: chasing it pushes everything to the edges.
   */
  private score(r: Room, p: Piece, x: number, y: number): number {
    const cells = this.cells(p, x, y);
    if (!cells.length) return 0;
    let room = 1;
    for (const [cx, cy] of cells)
      for (const k of r.blocked) {
        const d = Math.max(Math.abs((k % r.w) - cx), Math.abs(Math.floor(k / r.w) - cy)) - 1;
        if (d < room) room = Math.max(0, d);
      }
    if (!p.center) return room;
    const [mx, my] = [r.w / 2, (3 + r.h - 2) / 2];
    const [sx, sy] = cells.reduce(([a, b], [cx, cy]) => [a + cx, b + cy], [0, 0]);
    const off = Math.hypot(sx / cells.length + 0.5 - mx, sy / cells.length + 0.5 - my);
    return room - off / 2;
  }

  place(r: Room, p: Piece, n: number): boolean {
    const pad = p.place === 'floor' || p.place === 'corner';
    const ranked: { q: Piece; x: number; y: number; s: number }[] = [];
    for (const [x, y] of this.candidates(r, p, n)) {
      const q = this.orient(r, p, x, y);
      if (q && this.fits(r, q, x, y, pad))
        ranked.push({ q, x, y, s: this.score(r, q, x, y) - ranked.length * 1e-6 });
    }
    ranked.sort((a, b) => b.s - a.s);
    for (const { q, x, y } of ranked) if (this.put(r, q, x, y)) return true;
    return false;
  }
}

/** The pieces a room of each kind is made of, most important first. */
function recipe(f: Furnisher, spec: RoomSpec): Piece[] {
  const n = SIZE_STEP[spec.size ?? 'medium'];
  const it = f.it.bind(f);
  const back = (...items: Item[]): Piece => ({ place: 'back', items });
  const floor = (...items: Item[]): Piece => ({ place: 'floor', items });
  const wall = (sprite: string): Piece => ({ place: 'wall', items: [it(sprite)] });
  const corner = (sprite: string): Piece => ({ place: 'corner', items: [it(sprite)] });
  const must = (p: Piece): Piece => ({ ...p, must: true });
  const center = (p: Piece): Piece => ({ ...p, center: true });
  const out: Piece[] = [];
  switch (spec.kind) {
    case 'office':
      out.push(
        wall('art-frame'),
        back(it('bookshelf')),
        back(it('plant-tall')),
        wall('wall-clock'),
        corner('floor-lamp'),
        corner('plant-fern')
      );
      if (n >= 1) out.push(back(it('owner-sideboard')));
      break;
    case 'lobby':
      out.push(
        center(must(floor(it('lobby-couch'), it('rug', 0, 1)))),
        back(it('lobby-plant-big')),
        back(it('lobby-coat-rack')),
        corner('floor-lamp'),
        corner('plant-tall')
      );
      if (n >= 2) out.push(back(it('lobby-aquarium')));
      break;
    case 'kitchen': {
      const counter = back(
        it('kitchen-counter-end'),
        it('kitchen-counter', 1),
        it('kitchen-counter-sink', 2),
        it('kitchen-counter', 4),
        it('kitchen-counter-end', 5, 0, { flip: true }),
        it('kitchen-kettle'),
        it('kitchen-microwave', 1),
        it('kitchen-coffee', 4),
        it('kitchen-cabinet', 0, -1),
        it('kitchen-shelf', 2, -1),
        it('kitchen-mat', 2, 1)
      );
      const table = (k: number) =>
        must(
          floor(
            ...[0, 1, 2, 3].map((x) =>
              it('kitchen-chair', x, 0, { variant: f.nth('kitchen-chair', x + k) })
            ),
            it('kitchen-table', 0, 1),
            it('kitchen-fruit-bowl', 1, 1),
            it('kitchen-pendant', 1, 1),
            it('kitchen-pendant', 2, 1)
          )
        );
      out.push(must(counter), back(it('kitchen-fridge')), center(table(0)));
      if (n >= 2) out.push(table(1));
      out.push(
        corner('kitchen-cooler'),
        back(it('plant-tall')),
        corner('bin'),
        corner('plant-fern')
      );
      break;
    }
    case 'break':
      out.push(
        // Somewhere to watch: the TV against the back wall, a couch facing it
        // three rows out, with the two rows between kept open.
        must(back(it('break-tv', 1), it('break-couch-back', 0, 3))),
        must(back(it('break-arcade', 0, 0, { variant: undefined }))),
        floor(
          it('rug', 0, 1),
          it('break-beanbag', 1, 1),
          it('break-beanbag', 2, 2, { variant: f.nth('break-beanbag', 1) })
        ),
        back(it('break-vending')),
        back(it('break-fridge')),
        wall('break-poster'),
        wall('break-dartboard'),
        corner('floor-lamp'),
        back(it('plant-tall'))
      );
      if (n >= 1) out.push(back(it('break-arcade', 0, 0, { variant: f.nth('break-arcade', 1) })));
      break;
    case 'library':
      out.push(
        must(
          floor(it('library-chair', 1), it('library-table', 0, 1), it('library-bankers-lamp', 2, 1))
        ),
        must(back(it('library-window-seat'))),
        back(it('library-shelf')),
        back(it('library-shelf-b'), it('library-ladder', 1)),
        center(
          floor(
            it('library-rug', 0, 0),
            it('library-armchair', 1, 1),
            it('library-side-table', 2, 1),
            it('library-lamp', 2, 1),
            it('library-armchair', 3, 1, { variant: f.nth('library-armchair', 1) }),
            it('library-books', 0, 2)
          )
        ),
        wall('library-map'),
        corner('floor-lamp'),
        corner('plant-fern')
      );
      if (n >= 1) out.push(back(it('library-fireplace')), back(it('library-globe')));
      if (n >= 2)
        out.push(
          floor(it('library-chair', 1), it('library-table', 0, 1), it('library-bankers-lamp', 2, 1))
        );
      break;
    case 'gym':
      out.push(
        must(back(it('gym-treadmill'))),
        must(back(it('gym-dumbbells'))),
        floor(it('gym-mat'), it('gym-mat', 2, 0, { variant: f.nth('gym-mat', 1) })),
        floor(it('gym-bike')),
        wall('gym-mirror'),
        wall('gym-wall-light'),
        back(it('gym-cooler')),
        wall('gym-poster'),
        wall('gym-wall-light'),
        corner('plant-tall'),
        corner('gym-bottle')
      );
      if (n >= 1) out.push(back(it('gym-treadmill')), back(it('gym-rack')));
      if (n >= 2) out.push(floor(it('gym-bench'), it('gym-kettlebells', 2, 1)));
      break;
    case 'mail':
      out.push(
        center(must(floor(it('mail-sort-table')))),
        back(it('mail-pigeonholes')),
        back(it('mail-printer')),
        back(it('mail-parcels')),
        wall('mail-corkboard'),
        wall('wall-clock'),
        floor(it('mail-cart')),
        corner('bin'),
        corner('floor-lamp'),
        corner('plant-fern')
      );
      if (n >= 1) out.push(back(it('mail-box-stack')));
      break;
    case 'workspace':
      out.push(
        wall('whiteboard'),
        back(it('bookshelf')),
        wall('art-frame'),
        back(it('plant-tall')),
        wall('wall-clock'),
        corner('filing-cabinet'),
        corner('floor-lamp'),
        corner('plant-fern')
      );
      break;
  }
  for (const e of spec.extras ?? []) out.push(extraPiece(f, e));
  return out;
}

/**
 * The library pieces the office furnishes each part of a building with, by
 * room kind, then the halls and the street: what a theme can swap or leave out.
 */
export function libraryPieces(): Record<string, string[]> {
  const f = new Furnisher({}, undefined);
  const own: Partial<Record<RoomKind, string[]>> = {
    office: ['owner-chair', 'owner-desk', 'desk-lamp', 'rug'],
    lobby: ['lobby-reception', 'chair-front'],
    workspace: ['desk', 'desk-lamp', 'plant-small', 'chair']
  };
  const out: Record<string, string[]> = {};
  for (const kind of ROOM_KINDS) {
    const pieces = recipe(f, { kind, name: kind, size: 'large' }).flatMap((p) =>
      p.items.map((i) => i.sprite)
    );
    out[kind] = [...new Set([...(own[kind] ?? []), ...pieces])];
  }
  out.halls = ['owner-bench', 'plant-tall', 'floor-lamp', 'plant-fern'];
  out.grounds = [...new Set(Object.values(GROUND_PROPS).flatMap((g) => g.pick.map(([s]) => s)))];
  out['ground (floors)'] = [
    'sidewalk',
    'curb',
    'asphalt',
    'asphalt-line',
    'crosswalk',
    'curb-far',
    'grass'
  ];
  out.street = [
    'street-shop-window',
    'street-front-door',
    'street-sconce',
    'street-lamp',
    'street-tree',
    'street-bench',
    'street-bike-rack',
    'street-bus-shelter',
    'street-bus-sign',
    'street-coffee-cart',
    'street-hydrant',
    'street-mailbox',
    'street-newsbox',
    'street-planter'
  ];
  return out;
}

function extraPiece(f: Furnisher, sprite: string): Piece {
  const item = f.it(sprite);
  // A drawn prop says where it goes.
  const place = f.catalog[sprite]?.tags.find((t) => t.startsWith('place-'))?.slice(6);
  if (place === 'back' || place === 'floor' || place === 'corner' || place === 'wall')
    return { place, items: [item] };
  if (
    /^(art-frame|whiteboard|wall-clock|owner-photos|break-poster|break-dartboard|library-map|mail-corkboard)$/.test(
      sprite
    )
  )
    return { place: 'wall', items: [item] };
  if (/^(plant-|floor-lamp|library-cat|kitchen-cooler|filing-cabinet)/.test(sprite))
    return { place: 'corner', items: [item] };
  if (/^(rug|lobby-couch|gym-bike|break-beanbag|library-globe)$/.test(sprite))
    return { place: 'floor', items: [item] };
  return { place: 'back', items: [item] };
}

/** The office's desk, chair, lamp and rug, at the top of the room, in the middle. */
function ownerDesk(f: Furnisher, r: Room): boolean {
  const piece: Piece = {
    place: 'floor',
    items: [
      f.it('owner-chair', 1, 0),
      f.it('owner-desk', 0, 1),
      f.it('desk-lamp', 0, 1),
      f.it('rug', 0, 2)
    ]
  };
  const x = Math.floor((r.w - 3) / 2);
  return f.fits(r, piece, x, 3, false) && f.put(r, piece, x, 3);
}

/** The reception desk, in front of the back wall with a row to sit down from. */
function reception(f: Furnisher, r: Room): boolean {
  const piece: Piece = {
    place: 'floor',
    items: [f.it('lobby-reception'), f.it('chair-front', 1, 0, { variant: f.tint('chair') })]
  };
  for (const x of [r.w - 5, r.w - 6, 3, 2, Math.floor(r.w / 2)])
    if (f.fits(r, piece, x, 5, false) && f.put(r, piece, x, 5)) return true;
  return false;
}

/** Where desks go across a room: three tiles apart, either side of the way in. */
function deskColumns(w: number): number[] {
  const door = Math.floor((w - 2) / 2);
  const xs: number[] = [];
  let x = 2;
  while (x + 1 <= w - 3) {
    // A desk would crowd the way in: carry on past it.
    if (x + 1 >= door - 1 && x <= door + 2) x = door + 3;
    else {
      xs.push(x);
      x += 3;
    }
  }
  return xs;
}

/** Rows of desks either side of the way in. */
function desks(f: Furnisher, r: Room, seats: number, top?: string): boolean {
  const xs = deskColumns(r.w);
  let placed = 0;
  for (let y = 4; placed < seats && y + 2 <= r.h - 2; y += 3)
    for (const x of xs) {
      if (placed >= seats) break;
      const piece: Piece = {
        place: 'floor',
        items: [
          f.it('desk', 0, 0, { variant: f.nth('desk', placed) }),
          top
            ? f.it(top, 0, 0, { variant: f.nth(top, placed) })
            : placed % 2 === 0
              ? f.it('desk-lamp', 0, 0, { variant: f.nth('desk-lamp', placed / 2) })
              : f.it('plant-small', 0, 0, { variant: f.nth('plant-small', placed) }),
          f.it('chair', 1, 1, { variant: f.nth('chair', placed) })
        ]
      };
      if (f.fits(r, piece, x, y, false) && f.put(r, piece, x, y)) placed++;
    }
  return placed === seats;
}

/** A workspace's size for its desks: as many to a row as fit, up to six. */
function workspaceDims(seats: number, size: Size): [number, number] {
  const rows = Math.ceil(seats / 6);
  const perRow = Math.ceil(seats / rows);
  let w = perRow * 3 + 4;
  while (deskColumns(w).length < perRow) w++;
  return [w + SIZE_STEP[size] * 2, Math.max(3 * rows + 6, DEFAULT_DIMS[1][SIZE_STEP[size]])];
}

function baseDims(spec: RoomSpec): [number, number] {
  const size = spec.size ?? 'medium';
  if (spec.kind === 'workspace') return workspaceDims(spec.seats ?? 4, size);
  const [ws, hs] = DIMS[spec.kind] ?? DEFAULT_DIMS;
  return [ws[SIZE_STEP[size]], hs[SIZE_STEP[size]]];
}

/** Furnish a room at a size. Undefined when what the room is for does not fit. */
function furnish(spec: RoomSpec, w: number, h: number, catalog: SpriteCatalog): Room | undefined {
  const f = new Furnisher(catalog, spec.accent);
  const r = f.empty(w, h);
  if (spec.kind === 'office' && !ownerDesk(f, r)) return undefined;
  if (spec.kind === 'lobby' && !reception(f, r)) return undefined;
  if (spec.kind === 'workspace' && !desks(f, r, spec.seats ?? 4, spec.desk)) return undefined;
  recipe(f, spec).forEach((p, i) => {
    if (!f.place(r, p, i) && p.must) r.w = -1;
  });
  return r.w < 0 ? undefined : r;
}

/** The smallest size, from the base up, that a room's must-haves fit in. */
function fitDims(spec: RoomSpec, catalog: SpriteCatalog): [number, number] | undefined {
  let [w, h] = baseDims(spec);
  for (let grow = 0; grow < 8; grow++) {
    if (furnish(spec, w, h, catalog)) return [w, h];
    if (grow % 2 === 0) w += 2;
    else h += 1;
  }
  return undefined;
}

/** A room's map. `outside` says its back wall is the building's, where windows go. */
function roomMap(r: Room, outside: boolean): string[] {
  const rows: string[][] = Array.from({ length: r.h }, (_, y) =>
    Array.from({ length: r.w }, (_, x) =>
      x === 0 || x === r.w - 1 || y < 3 || y === r.h - 1 ? 'W' : '.'
    )
  );
  rows[r.h - 1][r.door] = '.';
  rows[r.h - 1][r.door + 1] = '.';
  // Windows in pairs along an outside back wall, wherever nothing hangs. A
  // back wall onto the hall is inside the building: no windows, no sun.
  for (let x = 2; outside && x + 1 <= r.w - 3;) {
    if (!r.wall.has(x) && !r.wall.has(x + 1)) {
      rows[1][x] = rows[1][x + 1] = rows[2][x] = rows[2][x + 1] = 'N';
      x += 4;
    } else x++;
  }
  return rows.map((row) => row.join(''));
}

// ---------------------------------------------------------------------------
// The building

export type Built = {
  plan: FloorPlan;
  /** What the office changed from the spec to make it fit, in words. */
  notes: string[];
  templates: Record<string, RoomTemplate>;
  /** Room template id to the room's kind, for sending staff to the right rooms. */
  kinds: Record<string, RoomKind>;
  problems: string[];
};

const ROOM_ID: Record<RoomKind, string> = {
  office: 'owner-office',
  workspace: 'workspace',
  lobby: 'lobby',
  kitchen: 'kitchen',
  break: 'break-room',
  library: 'library',
  gym: 'gym',
  mail: 'mail-room'
};

/** Turn a spec into a floor plan and its rooms. Check the spec first. */
export function buildOffice(spec: OfficeSpec, catalog: SpriteCatalog): Built {
  const problems: string[] = [];
  // The street and grounds take a seed of their own, from what shapes them, so
  // changing a room never moves a tree. Rooms furnish without chance.
  const random = rng(JSON.stringify([spec.grounds, spec.porch ?? null, spec.plants ?? null]));
  const fitted = spec.rooms.map((r) => ({ spec: r, dims: fitDims(r, catalog) }));
  for (const f of fitted)
    if (!f.dims) problems.push(`${f.spec.name}: what a ${f.spec.kind} needs does not fit`);
  if (problems.length)
    return { plan: emptyPlan(spec), notes: [], templates: {}, kinds: {}, problems };

  // The office sits in the middle of the back row and the lobby in the middle
  // of the front. The rest go to the row the spec names, or else the shorter
  // one, nearest the middle first, east then west, in the order the spec lists
  // them. A room pinned to a side goes after the rest, at that end of its row.
  type Placed = { spec: RoomSpec; w: number; h: number };
  type Row = { west: Placed[]; mid: Placed[]; east: Placed[] };
  const back: Row = { west: [], mid: [], east: [] };
  const front: Row = { west: [], mid: [], east: [] };
  const all = (row: Row) => [...row.west].reverse().concat(row.mid, row.east);
  const width = (row: Placed[]) => row.reduce((n, r) => n + r.w - 1, 1);
  const rowFor = (s: RoomSpec) =>
    s.row === 'back'
      ? back
      : s.row === 'front'
        ? front
        : width(all(back)) <= width(all(front)) + 2 * (SIDE - 1)
          ? back
          : front;
  const placed = (f: (typeof fitted)[number]) => ({ spec: f.spec, w: f.dims![0], h: f.dims![1] });
  for (const f of fitted)
    if (f.spec.kind === 'office') back.mid.push(placed(f));
    else if (f.spec.kind === 'lobby') front.mid.push(placed(f));
  const rest = fitted.filter((f) => f.spec.kind !== 'office' && f.spec.kind !== 'lobby');
  for (const f of rest.filter((f) => !f.spec.side)) {
    const row = rowFor(f.spec);
    (row.east.length <= row.west.length ? row.east : row.west).push(placed(f));
  }
  for (const f of rest.filter((f) => f.spec.side)) rowFor(f.spec)[f.spec.side!].push(placed(f));
  const backRow = all(back);
  const frontRow = all(front);

  // Square the building off: both rows as wide as the wider, every room in a
  // row as tall as the tallest.
  const B = Math.max(width(backRow), width(frontRow) + 2 * (SIDE - 1));
  const stretch = (row: Placed[], target: number) => {
    for (let i = 0; width(row) < target; i++) row[i % row.length].w++;
  };
  stretch(backRow, B);
  stretch(frontRow, B - 2 * (SIDE - 1));
  if (B > LIMITS.width)
    problems.push(
      `the building comes out ${B} tiles wide, over the limit of ${LIMITS.width}: fewer or smaller rooms`
    );
  const Hb = Math.max(...backRow.map((r) => r.h));
  const Hf = frontRow.length ? Math.max(...frontRow.map((r) => r.h)) : 7;
  for (const r of backRow) r.h = Hb;
  for (const r of frontRow) r.h = Hf;

  const templates: Record<string, RoomTemplate> = {};
  const kinds: Record<string, RoomKind> = {};
  const rooms: FloorPlan['rooms'] = [];
  const props: PropPlacement[] = [];
  const doors: { x: number; y: number; kind: RoomKind }[] = [];
  const taken = new Map<string, number>();
  const notes: string[] = [];
  // Where each room stands in the building, walls and all: the halls are what is left.
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const stamp = (p: Placed, x: number, y: number, outside: boolean) => {
    rects.push({ x, y, w: p.w, h: p.h });
    const room = furnish(p.spec, p.w, p.h, catalog);
    if (!room) {
      problems.push(`${p.spec.name}: what a ${p.spec.kind} needs does not fit`);
      return;
    }
    const furnisher = new Furnisher(catalog, p.spec.accent);
    // What the theme leaves out goes before any edit, or it would hold its tiles unseen.
    if (spec.swaps) furnisher.leaveOut(room, (s) => spec.swaps![s] === '');
    if (p.spec.edits?.length) furnisher.edit(room, p.spec.edits, p.spec.name, notes);
    const base = ROOM_ID[p.spec.kind];
    const n = (taken.get(base) ?? 0) + 1;
    taken.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    templates[id] = {
      id,
      name: p.spec.name.trim(),
      wall: `wall-${p.spec.wall ?? spec.wall}`,
      // A kind's own floor (the kitchen's tile) is the plain office's; a theme keeps its own.
      floor: p.spec.floor ?? (spec.swaps ? undefined : KIND_FLOOR[p.spec.kind]) ?? spec.floor,
      map: roomMap(room, outside),
      props: room.props
    };
    kinds[id] = p.spec.kind;
    rooms.push({ room: id, at: [x, y] });
    doors.push({ x: x + room.door, y: y + p.h - 1, kind: p.spec.kind });
  };

  let x = 0;
  for (const r of backRow) {
    stamp(r, x, 0, spec.windows !== false);
    x += r.w - 1;
  }
  x = SIDE - 1;
  // The front row's back wall shares its top row with the hall's last, the
  // way the back row's front wall shares the hall's first: one wall, not two.
  const frontY = Hb + HALL - 2;
  for (const r of frontRow) {
    stamp(r, x, frontY, false);
    x += r.w - 1;
  }

  const hallFloor = spec.floor === 'rubber' ? 'oak' : spec.floor;
  const mainY = Hb - 1;
  const frontHallY = frontY + Hf - 1;
  const southY = frontHallY + FRONT_HALL - 1;
  const halls: FloorPlan['halls'] = [
    { at: [0, mainY], size: [B, HALL], floor: hallFloor, wall: `wall-${spec.wall}` },
    { at: [0, frontHallY], size: [B, FRONT_HALL], floor: hallFloor, wall: 'wall-brick' },
    { at: [0, mainY], size: [SIDE, southY - mainY], floor: hallFloor, wall: `wall-${spec.wall}` },
    {
      at: [B - SIDE, mainY],
      size: [SIDE, southY - mainY],
      floor: hallFloor,
      wall: `wall-${spec.wall}`
    }
  ];

  // Staff wait for the owner on a bench in the hall, beside the office door.
  const office = doors.find((d) => d.kind === 'office');
  const bench = office ? office.x + 3 : 0;
  if (office) props.push({ sprite: 'owner-bench', at: [bench, mainY + 1] });

  // Plants and lamps along each hall's back row, clear of every door.
  const every = { few: 14, some: 9, lots: 6 }[spec.plants ?? 'some'];
  // Each row runs along the foot of a row of rooms, where a south wall's face
  // covers the floor: only things at least two tiles tall stand in front of it.
  const HALL_DECOR = ['plant-tall', 'floor-lamp', 'plant-fern', 'plant-small'].filter(
    (s) => (catalog[s]?.height ?? 0) >= 2 * TILE
  );
  let k = 0;
  for (const [y, from, to] of [
    [mainY + 1, 1, B - 2],
    [frontHallY + 1, SIDE, B - SIDE - 1]
  ] as const)
    for (let hx = from + 1; hx <= to - 1; hx += every) {
      const near = doors.some((d) => Math.abs(d.x - hx) <= 2 || Math.abs(d.x + 1 - hx) <= 2);
      const onBench = y === mainY + 1 && hx >= bench - 1 && hx <= bench + 2;
      if (near || onBench) continue;
      if (HALL_DECOR.length)
        props.push({ sprite: HALL_DECOR[k++ % HALL_DECOR.length], at: [hx, y] });
    }

  // The front door, under the lobby's door, then the street.
  const lobby = doors.find((d) => d.kind === 'lobby');
  const doorX = lobby?.x ?? Math.floor(B / 2);
  templates['front-door'] = {
    id: 'front-door',
    name: 'Front door',
    sign: false,
    wall: 'wall-brick',
    floor: hallFloor,
    map: ['DD'],
    props: [{ sprite: 'street-front-door', at: [0, 0] }]
  };
  rooms.push({ room: 'front-door', at: [doorX, southY] });
  props.push(
    { sprite: 'street-sconce', at: [doorX - 1, southY] },
    { sprite: 'street-sconce', at: [doorX + 2, southY] }
  );
  for (let wx = 3; wx + 1 < B - 2; wx += 9)
    if (wx + 1 < doorX - 2 || wx > doorX + 3)
      props.push({ sprite: 'street-shop-window', at: [wx, southY] });

  // The owner's changes outside the rooms, each area in its own tiles. What a
  // theme leaves out goes first, so it never holds a tile unseen.
  const left = (list: PropPlacement[]) => {
    const out = list.filter((p) => spec.swaps?.[p.sprite] !== '');
    withIds(out);
    return out;
  };
  const inRoom = (x: number, y: number) =>
    rects.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
  const hallProps = left(props.splice(0));
  props.push(...hallProps);
  if (spec.areas?.halls?.length) {
    const keep = new Set<string>();
    for (const d of doors) keep.add(`${d.x},${d.y + 1}`).add(`${d.x + 1},${d.y + 1}`);
    keep.add(`${doorX},${southY - 1}`).add(`${doorX + 1},${southY - 1}`);
    editArea(
      'Halls',
      props,
      spec.areas.halls,
      catalog,
      {
        ground: "the hall's floor",
        stands: (x, y) => x >= 1 && x <= B - 2 && y > mainY && y < southY && !inRoom(x, y),
        hangs: (x, y) => y === southY && x >= 1 && x <= B - 2 && (x < doorX || x > doorX + 1),
        keep
      },
      notes
    );
  }

  const streetY = southY + 1;
  templates.street = street(B, doorX, random, spec.porch, catalog);
  const road = templates.street;
  road.props = left(road.props);
  if (spec.areas?.street?.length)
    editArea(
      'Street',
      road.props,
      spec.areas.street,
      catalog,
      {
        ground: 'the sidewalk',
        stands: (x, y) => '.p'.includes(road.map[y]?.[x] ?? 'x'),
        hangs: () => false,
        keep: new Set([0, 1].flatMap((y) => [`${doorX},${y}`, `${doorX + 1},${y}`]))
      },
      notes
    );
  rooms.push({ room: 'street', at: [0, streetY] });

  const [ml, mt, mr, mb] = MARGIN;
  const total: [number, number] = [B + ml + mr, streetY + STREET_ROWS + mt + mb];
  templates.grounds = grounds(spec.grounds, total, [ml, mt, B, streetY], random);
  const land = templates.grounds;
  land.props = left(land.props);
  if (spec.areas?.grounds?.length) {
    const built = (x: number, y: number) =>
      x >= ml && x < ml + B && y >= mt && y < mt + streetY + STREET_ROWS;
    editArea(
      'Grounds',
      land.props,
      spec.areas.grounds,
      catalog,
      {
        ground: 'the open ground',
        stands: (x, y) => '.s'.includes(land.map[y]?.[x] ?? 'x') && !built(x, y),
        hangs: () => false,
        keep: new Set()
      },
      notes
    );
  }

  const plan: FloorPlan = {
    id: 'office',
    name: spec.name.trim(),
    grounds: { room: 'grounds', margin: MARGIN },
    halls,
    rooms,
    props
  };
  // A theme's stand-ins take the place of library pieces everywhere, rooms,
  // halls and street alike. They match exactly, so nothing else moves.
  const swaps = spec.swaps ?? {};
  const swap = (p: PropPlacement) => {
    const to = swaps[p.sprite];
    if (!to || !catalog[to]) return;
    p.sprite = to;
    if (p.variant && !catalog[to].variants.includes(p.variant)) delete p.variant;
  };
  const kept = (p: PropPlacement) => swaps[p.sprite] !== '';
  // Floors and ground materials swap too: cobbles for the sidewalk.
  const ground = (name: string) =>
    swaps[name] && catalog[`floor-${swaps[name]}`] ? swaps[name] : name;
  // The outside of the building takes the theme's facade in place of brick.
  const facade = spec.facade ? `wall-${spec.facade}` : undefined;
  const outside = (wall: string) => (facade && wall === 'wall-brick' ? facade : wall);
  if (Object.keys(swaps).length || facade) {
    for (const t of Object.values(templates)) {
      (t.props = t.props.filter(kept)).forEach(swap);
      t.floor = ground(t.floor);
      t.wall = outside(t.wall);
      if (t.materials)
        t.materials = Object.fromEntries(
          Object.entries(t.materials).map(([k, v]) => [k, ground(v)])
        );
    }
    if (plan.props) (plan.props = plan.props.filter(kept)).forEach(swap);
    for (const h of plan.halls ?? []) {
      h.floor = ground(h.floor);
      if (h.wall) h.wall = outside(h.wall);
    }
  }
  return { plan, notes, templates, kinds, problems };
}

function emptyPlan(spec: OfficeSpec): FloorPlan {
  return { id: 'office', name: spec.name, rooms: [] };
}

const STREET_MATERIALS = {
  c: 'curb',
  a: 'asphalt',
  l: 'asphalt-line',
  x: 'crosswalk',
  f: 'curb-far',
  g: 'grass'
};

/** The street along the front: sidewalk, the road with a crossing at the door, the far side. */
function street(
  w: number,
  door: number,
  random: () => number,
  porch?: Porch,
  catalog: SpriteCatalog = {}
): RoomTemplate {
  const row = (ch: string, cross?: string) =>
    Array.from({ length: w }, (_, x) =>
      cross && (x === door || x === door + 1) ? cross : ch
    ).join('');
  const map = [
    row('.'),
    row('.'),
    row('.'),
    row('c'),
    row('a', 'x'),
    row('l', 'x'),
    row('a', 'x'),
    row('f'),
    row('.'),
    row('g')
  ];
  const used = new Set<string>();
  const props: PropPlacement[] = [];
  const put = (sprite: string, x: number, y: number, fw = 1) => {
    if (x < 0 || x + fw > w) return false;
    for (let i = -1; i <= fw; i++) if (used.has(`${x + i},${y}`)) return false;
    for (let i = 0; i < fw; i++) used.add(`${x + i},${y}`);
    props.push({ sprite, at: [x, y] });
    return true;
  };
  // The door's own row stays clear, so the way in is never blocked.
  for (let i = -1; i <= 2; i++) used.add(`${door + i},0`).add(`${door + i},2`);
  // A porch decks the two rows of sidewalk outside the door. Its things stand
  // along the building, and the row in front of them stays clear to walk.
  const deck = porch ? [Math.max(0, door - 5), Math.min(w - 1, door + 6)] : undefined;
  if (deck) {
    for (const y of [0, 1])
      map[y] = [...map[y]].map((c, x) => (x >= deck[0] && x <= deck[1] ? 'p' : c)).join('');
    // The sidewalk in front of it stays open too, so trees do not crowd it.
    for (let x = deck[0] - 1; x <= deck[1] + 1; x++) used.add(`${x},1`).add(`${x},2`);
  }
  // The bus stop first: staff come and go by it, so it must find a place.
  // Its roof stands over the sidewalk behind it, so that stays clear too.
  for (const x of [door + 9, door - 12, door + 5, door - 8, 1, w - 5])
    if (put('street-bus-shelter', x, 2, 3)) {
      for (let i = -1; i <= 3; i++) used.add(`${x + i},0`);
      put('street-bus-sign', x + 3, 2);
      break;
    }
  if (deck) {
    // Nearest the door first, a tile apart.
    const xs = Array.from({ length: deck[1] - deck[0] + 1 }, (_, i) => deck[0] + i).sort(
      (a, b) => Math.abs(a - door - 0.5) - Math.abs(b - door - 0.5)
    );
    for (const e of porch!.extras ?? []) {
      const fw = catalog[e]?.footprint[0] ?? 1;
      xs.find((x) => x + fw - 1 <= deck[1] && put(e, x, 0, fw));
    }
  } else {
    put('street-planter', door - 3, 0);
    put('street-planter', door + 4, 0);
  }
  put('street-mailbox', door - 6, 2);
  put('street-newsbox', door - 5, 2);
  for (let x = 2; x < w - 2; x += 10) put('street-lamp', x, 2);
  for (let x = 6; x < w - 3; x += 10) if (random() < 0.7) put('street-tree', x, 2, 2);
  for (let x = 4; x < w - 3; x += 8) {
    if (random() < 0.6) put('street-tree', x, 8, 2);
    else put('street-lamp', x + 1, 8);
  }
  if (random() < 0.5) put('street-coffee-cart', door + 6, 0, 2);
  put('street-bike-rack', door - 10, 0, 2);
  put('street-bench', Math.max(1, door - 16), 2, 2);
  put('street-hydrant', door + 15, 2);
  return {
    id: 'street',
    name: 'Street',
    sign: false,
    outdoor: true,
    wall: 'wall-brick',
    floor: 'sidewalk',
    materials: deck ? { ...STREET_MATERIALS, p: porch!.floor ?? 'oak' } : STREET_MATERIALS,
    map,
    props
  };
}

const GROUND_PROPS: Record<Grounds, { odds: number; pick: [string, number, number][] }> = {
  park: {
    odds: 0.07,
    pick: [
      ['park-tree', 2, 3],
      ['park-tree-small', 1, 3],
      ['park-bush', 1, 3],
      ['park-bush-large', 2, 2],
      ['park-flowers', 1, 4],
      ['park-tuft', 1, 4],
      ['park-rock', 1, 1]
    ]
  },
  woods: {
    odds: 0.12,
    pick: [
      ['park-pine', 2, 4],
      ['park-pine-large', 2, 3],
      ['park-tree-large', 2, 2],
      ['park-fern', 1, 3],
      ['park-stump', 1, 1],
      ['park-mushrooms', 1, 2],
      ['park-log', 2, 1]
    ]
  },
  meadow: {
    odds: 0.08,
    pick: [
      ['park-tuft', 1, 6],
      ['park-flowers', 1, 6],
      ['park-tree-small', 1, 1],
      ['park-sapling', 1, 1],
      ['park-rock', 1, 1]
    ]
  }
};

/**
 * Land around the building, in world coordinates: the road carries on to the
 * edges and the rest is grass, planted by the spec's grounds.
 */
function grounds(
  kind: Grounds,
  [w, h]: [number, number],
  [ml, mt, bw, streetY]: [number, number, number, number],
  random: () => number
): RoomTemplate {
  const sy = mt + streetY;
  const road: Record<number, string> = {
    0: 's',
    1: 's',
    2: 's',
    3: 'c',
    4: 'a',
    5: 'l',
    6: 'a',
    7: 'f',
    8: 's'
  };
  const map = Array.from({ length: h }, (_, y) => (road[y - sy] ?? '.').repeat(w));
  // Keep a tile of grass clear around the building and the street.
  const clear = (x: number, y: number) =>
    !(x >= ml - 1 && x <= ml + bw && y >= mt - 1 && y <= sy + STREET_ROWS) &&
    !(y >= sy - 1 && y <= sy + 9);
  const { odds, pick } = GROUND_PROPS[kind];
  const bag = pick.flatMap(([s, fw, weight]) =>
    Array.from({ length: weight }, () => [s, fw] as const)
  );
  const used = new Set<number>();
  const props: PropPlacement[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 2; x++) {
      if (random() >= odds) continue;
      const [sprite, fw] = bag[Math.floor(random() * bag.length)];
      const cells = Array.from({ length: fw }, (_, i) => x + i);
      if (!cells.every((cx) => clear(cx, y) && clear(cx, y + 1))) continue;
      if (cells.some((cx) => [-1, 0, 1].some((oy) => used.has((y + oy) * w + cx)))) continue;
      for (const cx of cells) used.add(y * w + cx);
      props.push({ sprite, at: [x, y] });
    }
  return {
    id: 'grounds',
    name: 'Grounds',
    sign: false,
    outdoor: true,
    wall: 'wall-brick',
    floor: 'grass',
    materials: { s: 'sidewalk', c: 'curb', a: 'asphalt', l: 'asphalt-line', f: 'curb-far' },
    map,
    props
  };
}

// ---------------------------------------------------------------------------
// Checking the result

/** Everything wrong with a built office, in words: missing art, a seat nobody can reach. */
export function checkWorld(world: World, staff = 0): string[] {
  const out: string[] = [];
  if (world.missing.length) out.push(`missing art: ${world.missing.join(', ')}`);
  const home = world.spots.find((s) => s.activity === 'home');
  if (!home) return [...out, 'there is no bus stop for Odds to come and go by'];
  if (!world.spots.some((s) => s.activity === 'talk')) out.push("the office has no owner's desk");
  if (!world.spots.some((s) => s.activity === 'wait')) out.push('there is nowhere to wait');
  const unreached = world.spots.filter(
    (s) =>
      s !== home &&
      (!s.approach ||
        !findPath(world.walkable, world.width, home.approach ?? home.tile, s.tile, {
          enter: s.approach
        }))
  );
  for (const s of unreached.slice(0, 5)) out.push(`nobody can reach ${s.prop} in ${s.room}`);
  const seats = world.spots.filter((s) => ['work', 'intake', 'read'].includes(s.activity)).length;
  if (seats < staff) out.push(`${seats} work seats is fewer than the ${staff} Odds`);
  return out;
}

/** One size down for every room that has one: the rest of the building first, desks last. */
function smaller(spec: OfficeSpec): { spec: OfficeSpec; shrunk: string[] } | undefined {
  const down = (s: Size | undefined): Size | undefined =>
    s === 'large' ? 'medium' : s === 'small' ? undefined : 'small';
  for (const desks of [false, true]) {
    const shrunk: string[] = [];
    const rooms = spec.rooms.map((r) => {
      if ((r.kind === 'workspace') !== desks || !down(r.size)) return r;
      shrunk.push(r.name);
      return { ...r, size: down(r.size) };
    });
    if (shrunk.length) return { spec: { ...spec, rooms }, shrunk };
  }
  return undefined;
}

/**
 * The site before the building goes up: the plan's street and grounds, with
 * plain grass where the building will stand. A new owner's first floor.
 */
export function lotOf(
  plan: FloorPlan,
  templates: Record<string, RoomTemplate>
): { plan: FloorPlan; templates: Record<string, RoomTemplate> } {
  const street = plan.rooms.find((r) => r.room === 'street');
  const boxes = [
    ...plan.rooms
      .filter((r) => r !== street && templates[r.room])
      .map((r) => {
        const t = templates[r.room];
        return [r.at[0], r.at[1], Math.max(...t.map.map((row) => row.length)), t.map.length];
      }),
    ...(plan.halls ?? []).map((h) => [...h.at, ...h.size])
  ];
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.min(street?.at[1] ?? Infinity, Math.max(...boxes.map((b) => b[1] + b[3])));
  // Grass on exactly the tiles the building takes, so the grounds keep the rest.
  const grid = Array.from({ length: Math.max(0, y1 - y0) }, () =>
    Array<string>(Math.max(0, x1 - x0)).fill(' ')
  );
  const mark = (x: number, y: number) => {
    if (y >= y0 && y < y1 && x >= x0 && x < x1) grid[y - y0][x - x0] = '.';
  };
  for (const r of plan.rooms)
    if (r !== street)
      templates[r.room]?.map.forEach((row, dy) =>
        [...row].forEach((ch, dx) => ch !== ' ' && mark(r.at[0] + dx, r.at[1] + dy))
      );
  for (const h of plan.halls ?? [])
    for (let y = h.at[1]; y < h.at[1] + h.size[1]; y++)
      for (let x = h.at[0]; x < h.at[0] + h.size[0]; x++) mark(x, y);
  const lot: RoomTemplate = {
    id: 'lot',
    name: 'Lot',
    sign: false,
    outdoor: true,
    wall: 'wall-brick',
    floor: 'grass',
    map: grid.map((row) => row.join('')),
    props: []
  };
  return {
    plan: {
      ...plan,
      halls: [],
      props: [],
      rooms: [...(street ? [street] : []), { room: 'lot', at: [x0, y0] }]
    },
    templates: {
      ...templates,
      lot,
      // The street keeps its own things. What serves the office comes with it:
      // the shop fronts and door lamps, the coffee cart, the bike rack.
      ...(street && templates[street.room]
        ? {
            [street.room]: {
              ...templates[street.room],
              props: templates[street.room].props.filter((p) => !WITH_THE_OFFICE.has(p.sprite))
            }
          }
        : {})
    }
  };
}

const WITH_THE_OFFICE = new Set([
  'street-shop-window',
  'street-sconce',
  'street-front-door',
  'street-coffee-cart',
  'street-bike-rack'
]);

/**
 * Build and check in one go: the plan, its rooms, the world, and every
 * problem. A building too wide for the limit comes down a size at a time
 * before it counts as a problem, and the notes say which rooms shrank.
 */
export function generateOffice(
  spec: OfficeSpec,
  catalog: SpriteCatalog,
  staff = 0
): Built & { world?: World } {
  const problems = checkSpec(spec, catalog);
  if (problems.length)
    return { plan: emptyPlan(spec), notes: [], templates: {}, kinds: {}, problems };
  let built = buildOffice(spec, catalog);
  const notes: string[] = [];
  for (let next = smaller(spec); next && built.problems.some((p) => p.includes('tiles wide'));) {
    notes.push(`To fit the building, ${next.shrunk.join(', ')} came down a size.`);
    built = buildOffice(next.spec, catalog);
    next = smaller(next.spec);
  }
  built.notes = [...notes, ...built.notes];
  if (built.problems.length) return built;
  try {
    const world = composeWorld(built.plan, built.templates, catalog, { actors: false });
    return { ...built, world, problems: checkWorld(world, staff) };
  } catch (e) {
    return { ...built, problems: [e instanceof Error ? e.message : String(e)] };
  }
}
