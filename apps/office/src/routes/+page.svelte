<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { Desk, GoalThread } from '@oddboro/ledger';
  import { TILE, type World } from '@oddboro/world';
  import type { Floor } from '#lib/floor/engine.ts';
  import type { StaffActor, Pop } from '#lib/floor/staff.ts';
  import type { Beat } from '#lib/floor/reveal.ts';
  import type { Stage } from '#lib/ui/onboarding/Onboarding.svelte';
  import WeatherPill from '#lib/ui/WeatherPill.svelte';
  import { askWeather, weather } from '#lib/ui/weather.svelte.ts';
  import FloorControls, { type Light } from '#lib/ui/FloorControls.svelte';
  import { music, musicEnded, startMusic } from '#lib/ui/music.svelte.ts';
  import { chatAbout } from '#lib/ui/chat-about.svelte.ts';
  import type { Activity, StaffProfile } from '#lib/staff/roster.ts';
  import type { HeldThread } from '#lib/staff/thread-tags.ts';
  import {
    floorMode,
    nowIn,
    oddNow,
    railRing,
    readerProps,
    runsChanged,
    tagWords,
    type Snapshot
  } from '#lib/staff/odd-now.ts';
  import { chatRequest, type Delivered } from '#lib/ui/chat-about.svelte.ts';
  import OddsRail, { ODDS_RAIL, ODDS_RAIL_OPEN } from '#lib/ui/OddsRail.svelte';
  import type { Work } from '#lib/staff/work.ts';
  import type { LessonEvent, OfficeEvent } from '#lib/server/events.ts';
  import { account } from '#lib/ui/account.svelte.ts';
  import { personaNews } from '#lib/ui/persona-offers.svelte.ts';
  import { diagnostics } from '#lib/ui/diagnostics.svelte.ts';
  import { serviceNames } from '#lib/ui/service-names.svelte.ts';
  import RestoredNote from '#lib/ui/RestoredNote.svelte';
  import { actCheck } from '#lib/ui/act-check.svelte.ts';
  import {
    advanced,
    close,
    deskRequest,
    open,
    openHire,
    openLessons,
    openProject,
    openReport,
    wins,
    type Win
  } from '#lib/ui/windows.svelte.ts';
  import type { AskRow } from '@oddboro/ledger';
  import SidePanel from '#lib/ui/SidePanel.svelte';
  import { fly } from 'svelte/transition';
  import { placesFor, type Place } from '#lib/staff/places.ts';
  import PixelIcon from '#lib/ui/PixelIcon.svelte';
  import { call, type ApiUrl } from '#lib/ui/api.ts';
  import { setZone, zone, zoneName, zoneShort } from '@oddboro/ledger/time';
  import { LIVE_TABLES, type LiveTable } from '@oddboro/ledger/live-tables';

  // Panels and dialogs that open on a click load when they open, so the first
  // page carries only what shows at start. These three load early as well: the
  // first run's guide beside the floor, and the card and the Desk once it draws.
  const loadOnboarding = () => import('#lib/ui/onboarding/Onboarding.svelte');
  const loadStaffCard = () => import('#lib/ui/StaffCard.svelte');
  const loadDeskDrawer = () => import('#lib/ui/DeskDrawer.svelte');

  let { data } = $props();
  // Every time on the page is in the office's zone, which only the server knows.
  // It is fixed for the life of the page: a new zone takes a restart.
  setZone(untrack(() => data.zone));
  // Whether the office can send reports, whether they need a New Altitude
  // sign-in, and the owner's answer. Answering updates it from then on.
  Object.assign(
    diagnostics,
    untrack(() => data.diagnostics)
  );
  // The New Altitude sign-in. The live line keeps it current from then on.
  account.status = untrack(() => data.account);

  /** `heading` is the room a walking staffer is on its way to. */
  type Tag = {
    id: string;
    name: string;
    activity: Activity;
    heading?: string;
    x: number;
    y: number;
  };
  type Label = { id: string; name: string; x: number; y: number; scale: number; width: number };
  /** A room sign is laid out once at 11px, as it reads at the usual fit, and scales with the floor. */
  const SIGN_ZOOM = 1.5;
  /** Only a preview goes below 1x, and a sign there would be too small to read. */
  const SIGN_MIN_ZOOM = 1;

  let host: HTMLDivElement | undefined = $state();
  let floor: Floor | undefined;
  /** The floor's PixiJS code (floor/index.ts), loaded as the page mounts, before the floor exists. */
  let F: typeof import('#lib/floor/index.ts') | undefined;
  let atlasCatalog: Record<string, unknown> = {};
  let actors: StaffActor[] = [];
  let tags = $state<Tag[]>([]);
  /** Where the floor put each Odd, kept only when one changes activity, so a frame alone changes no Odd's state. */
  let placed = $state<Record<string, Activity>>({});
  let placedKey = '';
  let labels = $state<Label[]>([]);
  /** Who holds each spot, by spot id, so the Send tab can show a place as taken. */
  let held = $state<Record<string, { id: string; name: string }>>({});
  let heldKey = '';
  let selected = $state<string | undefined>();
  let now = $state(new Date());
  let ready = $state(false);
  let floorReady = $state(false);
  let failed = $state<string | undefined>();
  /**
   * The camera follows the staffer whose panel is open. A drag lets go until
   * the owner selects someone again or reopens the panel.
   */
  let letGo = $state(false);
  /** Staff the owner is directing by hand. Nothing else moves them. */
  let manual = $state<Record<string, string>>({});

  // Live office state: the staff, the owner's desk, and who is running a job.
  // svelte-ignore state_referenced_locally
  let staff = $state<StaffProfile[]>(data.staff);
  // svelte-ignore state_referenced_locally
  let desk = $state<Desk>(data.desk);
  // svelte-ignore state_referenced_locally
  let roomNames = $state<Record<string, string>>(data.roomNames);
  /** The lamps, screens and fires the owner switched off, by placed prop id. */
  // svelte-ignore state_referenced_locally
  let switchedOff = $state<string[]>(data.switchedOff);
  /** Pokes that landed and the owner has not read, counted by staffer. */
  // svelte-ignore state_referenced_locally
  let messages = $state<Record<string, number>>(data.messages);
  /** Threads a colleague holds for the Odd that leads them. */
  // svelte-ignore state_referenced_locally
  let threads = $state<HeldThread[]>(data.threads);
  /** False until the owner finishes the welcome, which the office opens on. */
  // svelte-ignore state_referenced_locally
  let welcomed = $state(data.welcomed);
  // Advanced mode as the server says; Setup changes it on this page as the owner answers.
  $effect.pre(() => {
    advanced.on = data.advanced;
  });
  // Whether the owner passed the Act check; passing it on this page sets it from then on.
  $effect.pre(() => {
    if (data.actChecked) actCheck.passed = true;
  });
  // Off, nothing offers Projects, and an open Projects window closes.
  $effect(() => {
    if (!advanced.on) for (const w of wins.list) if (w.kind === 'projects') close(w.id, true);
  });
  /** A new owner's first visit, from the empty lot until their manager says hello. */
  // svelte-ignore state_referenced_locally
  let firstRun = $state(!data.welcomed);
  /** Room signs show once the walls are up. */
  // svelte-ignore state_referenced_locally
  let signs = $state(data.welcomed);
  /** The owner's name as they type it, for the lot at the top of the panel. */
  let lotName = $state('');
  /** The office's name once it stands on the lot. */
  let raisedName = $state<string | undefined>();
  /** The first run is over, and the office's last drawn pieces have not landed yet. */
  let landing = $state(false);
  /** A staffer the camera follows without opening their card: the manager walking in. */
  let following = $state<string | undefined>();
  /** The light on the floor: the office's clock, or held at day or night for this viewer. */
  let light = $state<Light>('auto');
  /** Odds on the floor or stepping off the bus. Any other hire stays off the floor until the bus brings it. */
  const arrived = new Set<string>();
  /** Hires on a bus that has not pulled up yet, so a second sync books no second seat. */
  const riding = new Set<string>();
  /** One bus at a time: a hire made during a ride takes the next one. */
  let busLine = Promise.resolve();
  /**
   * The camera while a hire comes in: held on the whole office while the bus
   * comes (nothing to follow), then on the hire. The owner taking the camera
   * ends it.
   */
  let watching: (() => [number, number] | undefined) | undefined;
  const openSetup = () => open({ id: 'setup', kind: 'setup' });
  /** Each staffer's runs going, or waiting for a slot: every `working` event brings them. */
  let inProgress = $state<Record<string, Work[]>>({});
  /** The Odds replying to the owner in chat: every `working` event brings them. */
  let chatting = $state<string[]>([]);
  /** Each staffer's follow-ups yet to start, read with the office. */
  let toStart = $state<Record<string, Work[]>>({});
  /** A request for the card to open on a tab, from the Odds rail's list. */
  let cardShow = $state<{ id: string; tab: 'work'; n: number } | undefined>();
  /** Bumps when jobs, runs, access, goals, threads or lessons change, so the card's tabs and the Goals and Lessons windows reload. */
  let version = $state(0);
  /** Bumped on a change to the ledger's rows, so the Ledger window searches again. */
  let ledgerVersion = $state(0);
  /** What the page does when each table changes, by the name the event carries. */
  const ON_CHANGE = new Map<string, LiveTable['page']>(
    Object.entries(LIVE_TABLES).map(([table, live]) => [table, live.page])
  );
  /** The start panel is open while it holds windows and the owner has not folded it away. */
  const leftOpen = $derived(wins.shown && wins.list.length > 0);
  const front = $derived(wins.list.find((w) => w.id === wins.active));
  let deskFocus = $state<string | undefined>();
  let notify = $state(false);
  // The two side panels. Widths are remembered per viewer by SidePanel.
  let leftWidth = $state(400);
  let rightWidth = $state(460);
  let rightCollapsed = $state(false);
  let innerWidth = $state(1280);
  /** Below this the panels cover the floor instead of sitting beside it. */
  const wide = $derived(innerWidth > 720);

  // Every Odd is on the rail at the end edge (OddsRail.svelte), not here.
  const SECTIONS = [
    { id: 'desk', label: 'Desk' },
    { id: 'goals', label: 'Goals' },
    { id: 'lessons', label: 'Lessons' },
    { id: 'ledger', label: 'Ledger' },
    { id: 'services', label: 'Services' },
    { id: 'projects', label: 'Projects' },
    { id: 'hire', label: 'Hire' },
    { id: 'office', label: 'Office' }
  ] as const;
  /** The sections the top bar offers: Projects only in Advanced mode. */
  const sections = $derived(SECTIONS.filter((s) => s.id !== 'projects' || advanced.on));

  /** Select a staffer, opening its panel if it was folded away. */
  function select(id: string | undefined) {
    selected = id;
    railAsked = false;
    letGo = false;
    wins.raised = !id;
    if (id) rightCollapsed = false;
  }

  $effect(() => {
    void selected;
    if (!rightCollapsed) letGo = false;
  });

  // "Chat about this" from a report: open that staffer, whose chat takes the draft.
  $effect(() => {
    const id = chatRequest.staff;
    if (!id) return;
    chatRequest.staff = undefined;
    select(id);
  });

  // An item a window put on the desk, such as a service's Change: reload the desk, then open it.
  $effect(() => {
    const focus = deskRequest.focus;
    if (!focus) return;
    deskRequest.focus = undefined;
    void refresh().then(() => openDesk(focus));
  });

  // svelte-ignore state_referenced_locally
  serviceNames.byId = data.services;

  /** The office keeps its own time zone, wherever the screen is. */
  let officeZone = $state(zone());
  const PT = $derived({ timeZone: officeZone });
  const hour = $derived.by(() => {
    const [h, m] = new Intl.DateTimeFormat('en-US', {
      ...PT,
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric'
    })
      .format(now)
      .split(':')
      .map(Number);
    return h + m / 60;
  });
  // The first run shows the lot, then the office as it goes up on it.
  let liveWorld = $state<World | undefined>();
  /** The weather outside, as MET Norway's symbol, unless the viewer holds the floor at day or night. */
  const sky = $derived(
    light === 'auto' && weather.setting && weather.report ? weather.report.symbol : undefined
  );
  /** The hour the floor shows: the office's own, unless the viewer holds it at day or night. */
  const shownHour = $derived(light === 'day' ? 13 : light === 'night' ? 22 : hour);
  const office = $derived(liveWorld ? { ...data.office, world: liveWorld } : data.office);
  /** The name at the top of the panel: the lot, then the office. */
  const plateName = $derived(
    firstRun
      ? (raisedName ?? (lotName.trim() ? `${lotName.trim()}'s Lot` : 'Your Lot'))
      : office.name
  );
  /** The floor with the names the owner gave its rooms. */
  const world = $derived({
    ...office.world,
    rooms: office.world.rooms.map((r) => ({ ...r, name: roomNames[r.id] ?? r.name }))
  });
  const places = $derived(placesFor(world));
  const profile = $derived(staff.find((p) => p.id === selected));
  /** Screen space each panel takes from the floor, margin included. */
  // The first run's cards live in the start panel too.
  const leftSpace = $derived((leftOpen || firstRun) && wide ? leftWidth + 16 : 0);
  /** An Odd's panel is open (not folded away). */
  const cardOpen = $derived(!!profile && !rightCollapsed);
  /** ⌘K while a card is open brings the rail back over it, until an Odd is picked or the list closes. */
  let railAsked = $state(false);
  /**
   * The Odds rail, beside the floor once the office has an Odd. It slides off
   * the screen while an Odd's panel is open, and back when it closes or folds.
   */
  const showRail = $derived(!firstRun && staff.length > 0 && (!cardOpen || railAsked));
  const rightSpace = $derived(
    (showRail && !cardOpen ? ODDS_RAIL + 16 : 0) + (cardOpen && wide ? rightWidth + 8 : 0)
  );
  /** The Odds rail is wide now: hovered, in the keyboard's path, or opened with ⌘K. */
  let railOpen = $state(false);
  /**
   * Projects in front widens the start panel to the Odd's panel, else to the
   * Odds rail: px kept free at the end edge, 8 of them a gap. While the rail
   * is wide, the panel steps back to its edge, so every Odd stays in view.
   */
  const projectsReach = $derived.by(() => {
    if (!wide || !leftOpen || front?.kind !== 'projects') return undefined;
    if (cardOpen) return rightWidth + 24;
    if (showRail) return (railOpen ? ODDS_RAIL_OPEN : ODDS_RAIL) + 24;
    return 16;
  });
  /** The Odd's panel slides in from the screen's edge (the left in a right-to-left page). */
  const fromEdge = (far = 48) => ({
    x: (getComputedStyle(document.documentElement).direction === 'rtl' ? -1 : 1) * far,
    duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200
  });
  const selectedActivity = $derived(tags.find((t) => t.id === selected)?.activity ?? 'home');
  const clock = $derived(
    now.toLocaleTimeString('en-US', { ...PT, hour: 'numeric', minute: '2-digit' })
  );
  /** The office as the page holds it, which every screen's words for an Odd come from. */
  const snapshot = $derived.by((): Snapshot => {
    // An Odd the floor still shows after it left keeps its tag until the floor drops it.
    const ids = [...new Set([...staff.map((p) => p.id), ...Object.keys(placed)])];
    return {
      ids,
      inProgress,
      toStart,
      chatting,
      desk,
      staff,
      messages,
      threads,
      // An Odd not on the floor yet reads as at home, as the card always read it.
      activity: Object.fromEntries(ids.map((id) => [id, placed[id] ?? 'home'])),
      nameOf: (id) => staff.find((s) => s.id === id)?.name ?? id
    };
  });
  /** Every Odd's state, derived once, so the floor, the rail, the card and the chat agree. */
  const oddsNow = $derived(oddNow(snapshot));
  /** Each Odd on the floor, to the room it walks to, if any. */
  const headings = $derived(Object.fromEntries(tags.map((t) => [t.id, t.heading])));

  // The While you were away card counts once, however many jobs it lists.
  const deskCount = $derived(
    desk.asks.length +
      desk.tasks.length +
      desk.reports.length +
      desk.projectWork.length +
      (desk.away.length ? 1 : 0)
  );

  /** Rooms a new hire can work in: any with a place to work, read or sort mail. */
  const hireRooms = $derived.by(() => {
    const out = new Map<string, string>();
    for (const r of world.rooms) {
      const id = r.id.split('#')[0];
      const works = office.world.spots.some(
        (s) => s.room === r.id && ['work', 'intake', 'read'].includes(s.activity)
      );
      if (works && !out.has(id)) out.set(id, r.name);
    }
    return [...out].map(([id, name]) => ({ id, name }));
  });

  // Idle staff wander between these, mostly working, with real breaks.
  const IDLE_WEIGHTS: Partial<Record<Activity, number>> = {
    work: 6,
    read: 2,
    intake: 1,
    play: 2,
    rest: 1,
    eat: 1,
    exercise: 1
  };

  /** How long a free staffer stays at each thing once it gets there, in seconds: [least, most]. */
  const STAY: Partial<Record<Activity, [number, number]>> = {
    work: [60, 180],
    read: [40, 120],
    intake: [40, 90],
    play: [30, 90],
    rest: [40, 120],
    eat: [30, 75],
    exercise: [45, 120]
  };
  const stayFor = (a: Activity) => {
    const [least, most] = STAY[a] ?? [30, 90];
    return (least + Math.random() * (most - least)) * 1000;
  };

  /** Where a walking staffer is headed: a colleague it visits, the room's name, or home for the way out. */
  function headingOf(a: StaffActor): string | undefined {
    if (a.visiting) return a.visiting.profile.name;
    const to = a.destination;
    if (!to) return undefined;
    if (to.activity === 'home') return 'Home';
    return world.rooms.find((r) => r.id === to.room)?.name;
  }

  function pickActivity(available: Set<string>, current: Activity): Activity {
    const options = (Object.entries(IDLE_WEIGHTS) as [Activity, number][]).filter(
      ([a]) => available.has(a) && a !== current
    );
    if (!options.length) return current;
    let r = Math.random() * options.reduce((n, [, w]) => n + w, 0);
    for (const [a, w] of options) if ((r -= w) <= 0) return a;
    return options[0][0];
  }

  /** What a staffer running a job does in its room: work, sort mail, or read. */
  function jobActivity(p: StaffProfile): Activity {
    for (const a of ['work', 'intake', 'read'] as Activity[])
      if (office.world.spots.some((s) => s.activity === a && s.room.startsWith(`${p.room}#`)))
        return a;
    return 'work';
  }

  /**
   * The mode the office puts each staffer in: outside the owner's door, at
   * its job, or free. The ticker reads it each frame, so it is worked out
   * only when an Odd's state changes.
   */
  const floorModes = $derived(
    Object.fromEntries(staff.map((p) => [p.id, floorMode(oddsNow[p.id], jobActivity(p))]))
  );

  const taken = (except?: StaffActor) => {
    const off = new Set(switchedOff);
    return new Set([
      ...(actors
        .filter((a) => a !== except)
        .map((a) => a.spotId)
        .filter(Boolean) as string[]),
      // Nobody works at a desk whose screen the owner switched off.
      ...office.world.spots.filter((s) => s.activity === 'work' && off.has(s.obj)).map((s) => s.id)
    ]);
  };

  // What the owner switched off shows on the floor. Anyone working at a screen
  // that just went dark gets up for another desk, or something else to do.
  let shownOff = new Set<string>();
  $effect(() => {
    const off = new Set(switchedOff);
    if (!floorReady || !floor) return;
    for (const obj of new Set([...off, ...shownOff])) floor.setSwitch(obj, !off.has(obj));
    const dark = [...off].filter((o) => !shownOff.has(o));
    shownOff = off;
    const spots = office.world.spots;
    for (const a of actors) {
      const at = a.spotId;
      if (!at || !dark.some((o) => at.startsWith(`${o}/`))) continue;
      if (!a.assign(a.activity, spots, taken(a)))
        a.assign(pickActivity(new Set(spots.map((s) => s.activity)), a.activity), spots, taken(a));
    }
  });

  /** Switch a lamp, screen or fire. The floor changes at once; the ledger keeps it. */
  function flip(obj: string) {
    const on = switchedOff.includes(obj);
    switchedOff = on ? switchedOff.filter((o) => o !== obj) : [...switchedOff, obj];
    call('/api/switches', { obj, on }, 'PUT').catch(() => refresh());
  }

  let start: [number, number] = [1, 1];
  /** The drawn look each staffer wears, once its frames have loaded. */
  const wearing: Record<string, string | undefined> = {};

  /** False until the first sync, which is the office opening. */
  let opened = false;

  /** One sync at a time, so a quick pair of changes never adds a staffer twice. */
  let syncing = Promise.resolve();
  function syncActors(): Promise<void> {
    syncing = syncing.then(syncNow, syncNow);
    return syncing;
  }

  /** Load drawn looks, then put new hires on the floor and take leavers off it. */
  async function syncNow() {
    if (!floor) return;
    for (const p of staff) wearing[p.id] = await F!.loadLook(floor.atlas, p).catch(() => undefined);
    const w = office.world;
    for (const a of actors.filter((a) => !staff.some((p) => p.id === a.profile.id))) a.destroy();
    actors = actors.filter((a) => staff.some((p) => p.id === a.profile.id));
    // A redraw: the staffer changes clothes where they stand.
    for (const a of actors) a.wear(wearing[a.profile.id]);
    const boarding: string[] = [];
    for (const p of staff) {
      if (actors.some((a) => a.profile.id === p.id) || !atlasCatalog[p.sprite]) continue;
      if (firstRun && !arrived.has(p.id)) continue;
      // Every hire after the office opened, an Odd or a persona, comes by bus.
      if (opened && !arrived.has(p.id)) {
        if (!riding.has(p.id)) boarding.push(p.id);
        riding.add(p.id);
        continue;
      }
      arrived.add(p.id);
      const a = new F!.StaffActor(floor, p, start);
      a.wear(wearing[p.id]);
      a.sprite.on('pointertap', () => select(p.id));
      if (opened) a.assign('work', w.spots, taken(a));
      else {
        // The office is opening: everyone is already somewhere, each in a
        // different spot, instead of all walking in from the lobby at once.
        const want = floorModes[p.id];
        forced[p.id] = want;
        const free = new Set(w.spots.map((s) => s.activity));
        if (!a.assign(want ?? pickActivity(free, 'home'), w.spots, taken(a)))
          a.assign('work', w.spots, taken(a));
        a.arrive();
      }
      actors.push(a);
    }
    opened = true;
    if (boarding.length) busLine = busLine.then(() => ride(boarding));
  }

  /**
   * The bus brings hires in: it pulls up at the stop, they step off and walk
   * to work, and it drives on. As on the first run, the camera shows the
   * whole office while the bus comes, then steps in on the first hire as it
   * gets off and follows it to its spot, unless the owner takes the camera. Nothing waits on
   * them, so each is on the floor, and can be tapped, from the moment it
   * steps off.
   */
  async function ride(ids: string[]) {
    if (!floor || !F) return;
    const bus = F.bus(floor);
    watching = () => undefined;
    floor.overview();
    await bus.arrive();
    bus.open();
    await new Promise((r) => setTimeout(r, 800));
    for (const id of ids) {
      riding.delete(id);
      arrived.add(id);
    }
    await syncActors();
    const hire = actors.find((a) => a.profile.id === ids[0]);
    // Then the hire, to its spot, if the camera is still the ride's.
    const follow = (): [number, number] | undefined => {
      if (hire?.moving && hire.visible) return [hire.x, hire.y - TILE];
      if (watching === follow) watching = undefined;
    };
    if (watching) watching = follow;
    await new Promise((r) => setTimeout(r, 2500));
    await bus.leave();
  }

  /** The mode the office puts a staffer in: outside the owner's door, at its job, or free. */
  const forced: Record<string, Activity | undefined> = {};

  let refreshing: Promise<void> | undefined;
  let seen = new Set<string>();
  const keys = (d: Desk) =>
    new Set([
      ...d.asks.map((a) => `ask-${a.id}`),
      ...d.tasks.map((t) => `task-${t.id}`),
      ...d.reports.map((r) => `report-${r.id}`)
    ]);

  /** Fetch the office once per burst of changes. */
  function refresh(): Promise<void> {
    return (refreshing ??= (async () => {
      await new Promise((r) => setTimeout(r, 50));
      refreshing = undefined;
      const next = await call<{
        staff: StaffProfile[];
        desk: Desk;
        chatting: string[];
        inProgress: Record<string, Work[]>;
        toStart: Record<string, Work[]>;
        roomNames: Record<string, string>;
        switchedOff: string[];
        messages: Record<string, number>;
        threads: HeldThread[];
        services: Record<string, string>;
      }>('/api/office');
      const fresh = [...keys(next.desk)].filter((k) => !seen.has(k));
      if (
        notify &&
        fresh.length &&
        document.visibilityState !== 'visible' &&
        'Notification' in window
      ) {
        const first = [...next.desk.asks, ...next.desk.tasks, ...next.desk.reports].find((i) =>
          fresh.some((k) => k.endsWith(`-${i.id}`))
        );
        new Notification(`${keys(next.desk).size} waiting on you in ${office.name}`, {
          body: first?.title ?? 'Something new is on your desk.'
        });
      }
      seen = keys(next.desk);
      staff = next.staff;
      desk = next.desk;
      chatting = next.chatting;
      inProgress = next.inProgress;
      toStart = next.toStart;
      roomNames = next.roomNames;
      switchedOff = next.switchedOff;
      messages = next.messages;
      threads = next.threads;
      serviceNames.byId = next.services;
    })());
  }

  function setNotify(on: boolean) {
    notify = on;
    try {
      localStorage.setItem('oddboro.notify', on ? '1' : '');
    } catch {
      // Private window: the switch lasts this visit only.
    }
    if (on && 'Notification' in window && Notification.permission === 'default')
      void Notification.requestPermission();
  }

  /** Fold the panel away. Its windows stay open behind it. */
  function hide() {
    wins.shown = false;
  }

  async function openDesk(focus?: string) {
    // Cleared first, so asking for the item already open still brings it back.
    deskFocus = undefined;
    open({ id: 'desk', kind: 'desk' });
    await tick();
    deskFocus = focus;
  }

  /**
   * Something a staffer delivered, from its chat: on the desk while it waits,
   * else a report on its own. False when there is nothing to open.
   */
  function openDelivered(staffId: string, d: Delivered): boolean {
    const waiting = (rows: { id: number }[]) => {
      const found = rows.some((r) => r.id === d.id);
      if (found) void openDesk(`${d.kind}-${d.id}`);
      return found;
    };
    switch (d.kind) {
      case 'ask':
        return waiting(desk.asks);
      case 'task':
        return waiting(desk.tasks);
      case 'report':
        if (!waiting(desk.reports)) openReport({ id: d.id, staff: staffId, title: d.title });
        return true;
      default: {
        const missed: never = d.kind;
        throw new Error(`Nothing opens a ${String(missed)}`);
      }
    }
  }

  /** A thread from the Goals window: the oldest thing it waits on, else its hub's chat, which shows it as a card. */
  function openThread(t: GoalThread) {
    const first = t.waiting[0];
    if (!(first && openDelivered(t.hubId, first))) select(t.hubId);
  }

  /** A section's button: brings its window forward, or folds the panel when it already is. */
  function toggle(id: (typeof SECTIONS)[number]['id']) {
    if (leftOpen && front?.kind === id) return hide();
    if (id === 'desk') return void openDesk();
    if (id === 'ledger') return open({ id: 'ledger', kind: 'ledger' });
    if (id === 'projects') return openProject();
    if (id === 'services') return open({ id: 'services', kind: 'services' });
    if (id === 'goals') return open({ id: 'goals', kind: 'goals' });
    if (id === 'lessons') return openLessons();
    if (id === 'office') return open({ id: 'office', kind: 'office' });
    const hire = wins.list.findLast((w) => w.kind === 'hire');
    if (hire) open(hire);
    else openHire();
  }

  function hireProposal(a: AskRow) {
    if (a.hire) openHire({ askId: a.id, staff: a.staffId, proposal: a.hire });
  }

  /** An approved goal plan's hires, each in its own hire window, the first in front. */
  function planHires(hires: AskRow[]) {
    for (const a of [...hires].reverse()) hireProposal(a);
  }

  function winTitle(w: Win): string {
    if (w.kind === 'desk') return 'Desk';
    if (w.kind === 'ledger') return 'Ledger';
    if (w.kind === 'projects') return 'Projects';
    if (w.kind === 'services') return 'Services';
    if (w.kind === 'goals') return 'Goals';
    if (w.kind === 'lessons') return 'Lessons';
    if (w.kind === 'office') return wins.titles[w.id] ?? 'Office';
    if (w.kind === 'setup') return welcomed ? 'Setup' : 'Welcome';
    if (w.kind === 'file') return w.file.path.split('/').pop() ?? w.file.path;
    if (w.kind === 'report') return w.report.title;
    return wins.titles[w.id] ?? (w.from ? `Hire ${w.from.proposal.name}` : 'New hire');
  }

  /** The icon over an Odd that keeps a lesson, or uses one. */
  const LESSON_POP: Record<LessonEvent['kind'], Pop> = { kept: 'notebook', used: 'note' };

  onMount(() => {
    let disposed = false;
    seen = keys(desk);
    // A new owner's first visit opens on its own song; later visits play if the owner left the music on.
    startMusic(firstRun);
    try {
      notify = localStorage.getItem('oddboro.notify') === '1';
      const held = localStorage.getItem('oddboro.light');
      if (held === 'day' || held === 'night') light = held;
    } catch {
      // No storage: notifications stay off.
    }
    // The page's one clock. The weather rides on it: asked only when due and only while seen.
    void askWeather();
    const timer = setInterval(() => {
      now = new Date();
      void askWeather();
    }, 15_000);
    const catchUp = () => void askWeather();
    document.addEventListener('visibilitychange', catchUp);

    // One live line from the server. Changes arrive as they happen.
    const events = new EventSource('/api/events' satisfies ApiUrl);
    events.onmessage = (m) => {
      const e = JSON.parse(m.data) as OfficeEvent;
      if (e.type === 'account') {
        account.status = e.status;
        return;
      }
      if (e.type === 'weather') return void askWeather(true);
      if (e.type === 'working') {
        // Every tool call a staffer makes updates its work in progress; only
        // a run starting or ending reloads the card's tabs.
        const before = oddsNow;
        inProgress = e.inProgress;
        chatting = e.chatting;
        if (runsChanged(before, oddsNow)) version++;
        return;
      }
      // Whoever handed work on, or did it, walks over to the other and back.
      if (e.type === 'hand-off') {
        const to = actors.find((a) => a.profile.id === e.to);
        if (to) actors.find((a) => a.profile.id === e.from)?.visit(to);
        return;
      }
      if (e.type === 'lesson') {
        actors.find((a) => a.profile.id === e.staff)?.pop(LESSON_POP[e.kind]);
        return;
      }
      // Only the persona offers hear this: the floor meets a persona Odd, or
      // sees it go quiet, through the staff table's change, as any hire.
      if (e.type === 'persona') return void personaNews(e);
      const page = e.table === 'chat' ? ['version'] : (ON_CHANGE.get(e.table) ?? []);
      // A move into another layout rebuilds the whole floor.
      // During the first run, and until its last drawn pieces land, the floor
      // already shows the office being moved into.
      if (page.includes('reload')) return firstRun || landing ? void refresh() : location.reload();
      if (page.includes('refresh')) refresh();
      if (page.includes('version')) version++;
      if (page.includes('ledger')) ledgerVersion++;
    };

    // The first run's guide shows as soon as the floor does, so fetch both at once.
    if (firstRun) loadOnboarding().catch(() => {});
    (async () => {
      try {
        F = await import('#lib/floor/index.ts');
        const atlas = await F.sharedAtlas(office.catalog);
        await F.addArt(atlas, office.art);
        if (disposed || !host) return;
        atlasCatalog = atlas.catalog;
        floor = await F.Floor.create(host, office.world, atlas);
        floor.setHour(shownHour);
        floor.setWeather(sky);
        // Dev only: lets a browser console poke at the floor.
        if (import.meta.env.DEV) (window as unknown as { floor: Floor }).floor = floor;
        start = arrival(office.world);
        if (firstRun) F.hideBuilding(floor);
        // Land on the whole office, centred on the floor the panels leave showing.
        floor.viewOffsetX = centreOffset();
        floor.viewCover = leftSpace + rightSpace;
        floor.overview(false);
        void syncActors();

        // Name tags and room signs move only when the floor draws.
        floor.onRender = () => {
          const holding = actors.filter((a) => a.spotId);
          const key = holding.map((a) => `${a.spotId}=${a.profile.id}`).join('|');
          if (key !== heldKey) {
            heldKey = key;
            held = Object.fromEntries(
              holding.map((a) => [a.spotId!, { id: a.profile.id, name: a.profile.name }])
            );
          }
          tags = actors
            .filter((a) => a.sprite.visible)
            .map((a) => {
              // A tag rises over an icon playing on the head, and settles once it ends.
              const p = floor!.toScreen(a.head.x, a.head.y - a.tagLift);
              return {
                id: a.profile.id,
                name: a.profile.name,
                activity: a.activity,
                heading: headingOf(a),
                ...p
              };
            });
          const at = tags.map((t) => `${t.id}=${t.activity}`).join('|');
          if (at !== placedKey) {
            placedKey = at;
            placed = Object.fromEntries(tags.map((t) => [t.id, t.activity]));
          }
          // A sign scales with the floor, so it sits on the same spot of the wall at
          // the same size against the room at every zoom, and never runs past the room.
          const scale = floor!.scale / SIGN_ZOOM;
          labels = world.rooms
            .filter((r) => signs && r.sign !== false && floor!.scale >= SIGN_MIN_ZOOM)
            .map((r) => {
              const p = floor!.toScreen((r.x + 1) * TILE, (r.y + 0.6) * TILE);
              return { id: r.id, name: r.name, scale, width: (r.w - 2) * TILE * SIGN_ZOOM, ...p };
            });
        };

        floor.onRelease = () => {
          letGo = true;
          watching = undefined;
        };
        floor.onTap = flip;
        floor.onShelf = () => openLessons('all');

        // Each free staffer's own clock: it starts when the staffer gets
        // somewhere, so nobody gets up at the same moment as everyone else.
        const leaveAt: Record<string, number> = {};
        floor.app.ticker.add((t) => {
          const dt = Math.min(0.05, t.deltaMS / 1000);
          // The floor can change under the ticker on the first run, so read it fresh.
          const w = office.world;
          const available = new Set(w.spots.map((s) => s.activity));
          for (const a of actors) a.update(dt);
          // Real state first: an open ask or task puts a staffer outside
          // the owner's door, and a running job puts it to work in its room.
          // A staffer visiting a colleague finishes the trip first.
          for (const a of actors) {
            const id = a.profile.id;
            if (manual[id] || a.onTrip) continue;
            const want = floorModes[id];
            if (want !== forced[id]) {
              forced[id] = want;
              a.assign(want ?? 'work', w.spots, taken(a));
            }
          }
          const now = performance.now();
          for (const a of actors) {
            const id = a.profile.id;
            if (manual[id] || forced[id] || a.moving || a.onTrip) {
              delete leaveAt[id];
              continue;
            }
            leaveAt[id] ??= now + stayFor(a.activity);
            if (now < leaveAt[id]) continue;
            delete leaveAt[id];
            a.assign(pickActivity(available, a.activity), w.spots, taken(a));
          }
          if (!floor) return;
          const lead = following
            ? actors.find((a) => a.profile.id === following)
            : selected && !rightCollapsed && !letGo
              ? actors.find((a) => a.profile.id === selected)
              : undefined;
          // Centre the camera on the floor left between the two panels, and fit the office there.
          floor.viewOffsetX = centreOffset();
          floor.viewCover = leftSpace + rightSpace;
          if (watching) {
            const seen = watching();
            if (seen) floor.focus(seen[0], seen[1]);
          } else if (lead && lead.visible) floor.focus(lead.x, lead.y - TILE);
          floor.updateDoors(actors.filter((a) => a.visible).flatMap((a) => a.steps));
        });
        ready = true;
        floorReady = true;
        // The card and the Desk are the panels opened most. Fetch them once,
        // after the floor is up, so they open at once. A failed fetch here
        // stays quiet: it is only a head start.
        setTimeout(() => {
          loadStaffCard().catch(() => {});
          loadDeskDrawer().catch(() => {});
        }, 0);
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      }
    })();

    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', catchUp);
      events.close();
      for (const a of actors) a.destroy();
      floor?.destroy();
    };
  });

  /** Screen pixels to shift the camera by, to centre it on the floor between the two panels. */
  function centreOffset(): number {
    const rtl = document.documentElement.dir === 'rtl';
    return ((leftSpace - rightSpace) / 2) * (rtl ? -1 : 1);
  }

  /** Fit: the whole office in the room the panels leave, and stop following anyone. */
  function fitFloor() {
    letGo = true;
    floor?.overview();
  }

  /** Where staff arrive: the home spot by the bus stop, or the bottom edge nearest the middle. */
  function arrival(w: World): [number, number] {
    const exit = w.spots.find((s) => s.activity === 'home');
    if (exit) return exit.tile;
    let at: [number, number] = w.spots[0]?.tile ?? [1, 1];
    let best = -Infinity;
    for (let i = 0; i < w.walkable.length; i++) {
      if (!w.walkable[i]) continue;
      const x = i % w.width;
      const y = Math.floor(i / w.width);
      const score = y * 100 - Math.abs(x - w.width / 2);
      if (score > best) {
        best = score;
        at = [x, y];
      }
    }
    return at;
  }

  /** What the first run asks of the floor, while the cards and captions run the story. */
  const stage: Stage = {
    bus: () => (floor && F ? F.bus(floor) : undefined),
    async build(next: World, name: string, onBeat: (b: Beat) => void, art) {
      if (!floor || !F) return;
      // Art drawn for this office goes in the atlas before the floor asks for it.
      if (art?.sheet) await F.addArt(floor.atlas, art.sheet, art.catalog);
      signs = false;
      floor.swap(next, { fit: true });
      liveWorld = next;
      start = arrival(next);
      // The swap keeps the owner's view, gliding out only if the building would not fit.
      F.hideBuilding(floor);
      await F.raise(floor, onBeat);
      signs = true;
      raisedName = name;
      floor.invalidate();
    },
    async walkIn(id: string, skip: Promise<void>) {
      arrived.add(id);
      await refresh();
      await syncActors();
      const a = actors.find((x) => x.profile.id === id);
      if (!a || !floor) return;
      manual = { ...manual, [id]: 'chat' };
      following = id;
      chatStart(id);
      // Skip: at the owner's desk at once, the end of the walk without walking it.
      void skip.then(() => {
        a.arrive();
        floor?.invalidate();
      });
      const ticker = floor.app.ticker;
      await new Promise<void>((done) => {
        const check = () => {
          if (a.moving) return;
          ticker.remove(check);
          done();
        };
        ticker.add(check);
      });
      following = undefined;
    },
    async reload() {
      await invalidateAll();
      liveWorld = undefined;
      landing = false;
    },
    finish(id: string) {
      firstRun = false;
      landing = true;
      welcomed = true;
      // Their card opens on the chat, where the hello is waiting.
      chatAbout(id, '');
    },
    zone(z: string) {
      setZone(z);
      officeZone = z;
    },
    name(n: string) {
      lotName = n;
    }
  };

  /** Send a staffer to a place: a spot there nobody else holds. A full place takes nobody. */
  function send(id: string, place: Place) {
    const actor = actors.find((a) => a.profile.id === id);
    if (!actor) return;
    const others = taken(actor);
    const spot = place.spots.find((s) => !others.has(s.id));
    if (spot && actor.sendTo(spot)) manual = { ...manual, [id]: place.key };
  }

  // Talking with a staffer brings them to the owner's office. When the chat goes
  // quiet for a minute they go back to what they were doing, unless the owner
  // sent them somewhere.
  const chatTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  function chatStart(id: string) {
    clearTimeout(chatTimers[id]);
    if (manual[id] && manual[id] !== 'chat') return;
    const actor = actors.find((a) => a.profile.id === id);
    if (!actor) return;
    // At the owner's desk if it is free, else outside their door: never on top of
    // someone already there.
    const near = (activity: string) => activity === 'talk' || activity === 'wait';
    const here = office.world.spots.find((s) => s.id === actor.spotId);
    if (here && near(here.activity)) return;
    const others = taken(actor);
    const free = (activity: string) =>
      office.world.spots.find((s) => s.activity === activity && !others.has(s.id));
    const spot = free('talk') ?? free('wait');
    if (spot && actor.sendTo(spot)) manual = { ...manual, [id]: 'chat' };
  }
  function chatEnd(id: string) {
    clearTimeout(chatTimers[id]);
    chatTimers[id] = setTimeout(() => {
      if (manual[id] === 'chat') backToSchedule(id);
    }, 60_000);
  }

  function backToSchedule(id: string) {
    manual = Object.fromEntries(Object.entries(manual).filter(([k]) => k !== id));
    forced[id] = undefined;
    const actor = actors.find((a) => a.profile.id === id);
    actor?.assign('work', office.world.spots, taken(actor));
  }

  /** A waiting staffer's tag opens its first item on the desk. */
  function tagClick(id: string) {
    // A message waiting: open their chat, where it is.
    if (messages[id]) return chatAbout(id, '');
    const a = desk.asks.find((x) => x.staffId === id);
    const t = desk.tasks.find((x) => x.staffId === id);
    if (a || t) void openDesk(a ? `ask-${a.id}` : `task-${t!.id}`);
    else select(id);
  }

  /** The room the owner is renaming, and the name as the owner types it. */
  let renaming = $state<string | undefined>();
  let roomDraft = $state('');
  let roomProblem = $state('');

  function startRename(l: Label) {
    renaming = l.id;
    roomDraft = l.name;
    roomProblem = '';
  }

  async function saveRename() {
    const id = renaming;
    if (!id) return;
    const was = world.rooms.find((r) => r.id === id)?.name;
    if (roomDraft.trim() === was) return void (renaming = undefined);
    try {
      const r = await call<{ name: string }>('/api/rooms', { room: id, name: roomDraft }, 'PUT');
      roomNames = { ...roomNames, [id]: r.name };
      renaming = undefined;
      floor?.invalidate();
    } catch (e) {
      roomProblem = e instanceof Error ? e.message : String(e);
    }
  }

  function renameKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    renaming = undefined;
  }

  /** Bumps to open the Odds list on the rail with the cursor in its search. */
  let findAgent = $state(0);

  function onkey(e: KeyboardEvent) {
    // Cmd+K finds an Odd from anywhere, the box included.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !firstRun) {
      e.preventDefault();
      railAsked = true;
      findAgent++;
      return;
    }
    const el = e.target as HTMLElement | null;
    if (el?.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'd' || e.key === 'D') toggle('desk');
  }

  $effect(() => {
    const h = shownHour;
    if (floorReady) floor?.setHour(h);
  });

  $effect(() => {
    const s = sky;
    if (floorReady) floor?.setWeather(s);
  });

  $effect(() => {
    const l = light;
    try {
      localStorage.setItem('oddboro.light', l);
    } catch {
      // Private window: held for this visit only.
    }
  });

  // The end of the first run is a change too: the Odds it held back walk on then.
  $effect(() => {
    void staff;
    void firstRun;
    if (floorReady) void syncActors();
  });
</script>

<svelte:window onkeydown={onkey} bind:innerWidth />

<svelte:head>
  <title
    >{firstRun ? 'Welcome' : `${deskCount ? `(${deskCount}) ` : ''}${office.name}`} · Oddboro</title
  >
</svelte:head>

<main class="fixed inset-0 overflow-clip">
  <div
    bind:this={host}
    class="absolute inset-0 transition-opacity duration-700"
    class:opacity-0={!ready}
  ></div>

  <!-- Room signs and name tags ride above the floor. -->
  <div class="pointer-events-none absolute inset-0">
    {#each labels as l (l.id)}
      <div
        class="absolute origin-top-left flex items-center gap-[0.5em] font-pixel text-[11px] tracking-[0.2em] whitespace-nowrap text-ink/55 uppercase"
        style="transform: translate({l.x}px, {l.y}px) scale({l.scale}) translateY(-50%); max-inline-size: {l.width}px"
      >
        {#if renaming === l.id}
          <form
            class="pointer-events-auto flex flex-col gap-1"
            novalidate
            onsubmit={(e) => {
              e.preventDefault();
              void saveRename();
            }}
          >
            <input
              class="rename w-[16em] rounded bg-night/80 px-1.5 py-0.5 font-pixel tracking-[0.2em] text-ink uppercase outline-none"
              aria-label="Room name"
              maxlength="40"
              {@attach (n) => n.select()}
              bind:value={roomDraft}
              onkeydown={renameKey}
              onblur={() => void saveRename()}
            />
            {#if roomProblem}
              <span class="font-sans text-xs tracking-normal text-coral normal-case"
                >{roomProblem}</span
              >
            {/if}
          </form>
        {:else}
          <span class="min-w-0 truncate">{l.name}</span>
          <button
            class="pointer-events-auto -m-1 p-1 opacity-70 hover:text-ink hover:opacity-100 focus-visible:text-ink focus-visible:opacity-100"
            aria-label={`Rename ${l.name}`}
            title="Rename"
            onclick={() => startRename(l)}><PixelIcon name="pencil" /></button
          >
        {/if}
      </div>
    {/each}
    {#each tags as t (t.id)}
      {@const isWaiting = railRing(oddsNow[t.id])}
      {@const words = tagWords(oddsNow[t.id], t.heading)}
      <button
        class="tag pointer-events-auto absolute flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap"
        class:active={selected === t.id}
        class:waiting={isWaiting}
        style="transform: translate(calc({t.x}px - 50%), calc({t.y}px - 100% - 6px))"
        onclick={() => tagClick(t.id)}
      >
        <span class="font-medium text-ink">{t.name}</span>
        <span class="max-w-64 truncate {isWaiting ? 'text-ember' : 'text-muted'}" title={words}
          >{words}</span
        >
      </button>
    {/each}
  </div>

  {#snippet plate(open: boolean)}
    <div class="flex items-start gap-3 {open ? 'border-b border-hairline p-3' : ''}">
      <div class="min-w-0 flex-1">
        <div class="text-[10px] tracking-[0.22em] text-sea uppercase">Oddboro</div>
        <!-- A long name clips with an ellipsis. The clock keeps its place. -->
        <div class="flex items-baseline gap-2">
          <span
            class="min-w-0 truncate font-pixel text-2xl leading-tight max-sm:text-xl"
            title={plateName}>{plateName}</span
          >
          <span
            class="shrink-0 text-base font-semibold whitespace-nowrap text-ink tabular-nums"
            title={`${office.name} keeps ${zoneName()}`}
            >{clock} <span class="text-xs font-medium text-muted">{zoneShort()}</span></span
          >
        </div>
        <div class="text-xs text-muted max-sm:hidden" class:hidden={firstRun}>
          {data.computer} ·
          <button class="underline underline-offset-2 hover:text-ink" onclick={openSetup}
            >Setup</button
          >
        </div>
        {#if data.restored && !firstRun}
          <RestoredNote restored={data.restored} />
        {/if}
      </div>
      {#if open && !firstRun}
        <button
          class="rounded-full px-2 py-1 text-muted hover:text-ink"
          aria-label="Fold the panel away"
          title="Fold away. Open windows stay open."
          onclick={hide}>✕</button
        >
      {/if}
    </div>
    <!-- The command center's buttons arrive with the office, once the first run is over. -->
    <div class="flex flex-wrap gap-1.5 {open ? 'px-3 pt-2' : 'mt-2'}" class:hidden={firstRun}>
      {#each sections as sec (sec.id)}
        {@const pressed = leftOpen && front?.kind === sec.id}
        <button
          class="rounded-full px-3 py-1 text-xs whitespace-nowrap {pressed
            ? 'bg-sea/25 text-ink'
            : 'bg-raise text-muted hover:text-ink'}"
          aria-pressed={pressed}
          onclick={() => toggle(sec.id)}
          >{sec.label}{#if sec.id === 'desk' && deskCount}<span class="ms-1 text-ember"
              >{deskCount}</span
            >{/if}{#if wins.list.some((w) => w.kind === sec.id && wins.busy[w.id])}<span
              class="busy ms-1.5"
              aria-label="drawing"
            ></span>{/if}</button
        >
      {/each}
      {#if !leftOpen && wins.list.length}
        <button
          class="rounded-full bg-raise px-3 py-1 text-xs whitespace-nowrap text-ink hover:bg-sea/20"
          onclick={() => (wins.shown = true)}
          >{wins.list.length} open{#if Object.values(wins.busy).some(Boolean)}<span
              class="busy ms-1.5"
              aria-label="drawing"
            ></span>{/if}</button
        >
      {/if}
    </div>
  {/snippet}

  <audio
    bind:this={music.audio}
    preload="auto"
    onplay={() => (music.playing = true)}
    onpause={() => {
      if (!music.focus) music.playing = false;
    }}
    ontimeupdate={(e) => (music.time = e.currentTarget.currentTime)}
    ondurationchange={(e) => (music.duration = e.currentTarget.duration || 0)}
    onended={musicEnded}
  ></audio>

  <!-- The start side: the office plate, which opens into a full-height bar
       holding the desk, the ledger, or hiring. The first run keeps it away. -->
  {#if firstRun}
    <!-- The first run happens here, so the owner meets the command center first. -->
    <SidePanel
      side="start"
      label="Welcome"
      bind:width={leftWidth}
      min={340}
      max={Math.max(760, Math.round(innerWidth * 0.4))}
      storageKey="oddboro.panel.start"
    >
      <div class="flex h-full min-h-0 flex-col">
        {@render plate(true)}
        {#if floorReady}
          {#await loadOnboarding() then { default: Onboarding }}
            <Onboarding {stage} sample={data.sample} />
          {/await}
        {/if}
        <div class="mt-auto border-t border-hairline px-3 py-2">
          <FloorControls bind:light onfit={fitFloor} onzoom={(d) => floor?.zoomBy(d)} />
        </div>
      </div>
    </SidePanel>
  {:else if leftOpen}
    <SidePanel
      side="start"
      label="Office panel"
      bind:width={leftWidth}
      min={340}
      max={Math.max(760, Math.round(innerWidth * 0.4))}
      storageKey="oddboro.panel.start"
      onTop={wins.raised}
      reach={projectsReach}
    >
      <div class="flex h-full min-h-0 flex-col">
        <div class="pb-2">{@render plate(true)}</div>
        <!-- One tab per open window. Every window stays mounted, so each keeps its place. -->
        <div
          class="flex gap-1 overflow-x-auto border-t border-hairline px-2 pt-2"
          role="tablist"
          aria-label="Open windows"
        >
          {#each wins.list as w (w.id)}
            <div
              class="flex shrink-0 items-center rounded-t-lg {wins.active === w.id
                ? 'bg-raise text-ink'
                : 'text-muted hover:text-ink'}"
            >
              <button
                role="tab"
                aria-selected={wins.active === w.id}
                class="flex max-w-44 items-center gap-1.5 truncate py-1.5 ps-2.5 pe-1 text-xs"
                onclick={() => {
                  wins.active = w.id;
                  wins.raised = true;
                }}
                >{#if wins.busy[w.id]}<span class="busy" aria-label="drawing"></span>{/if}{winTitle(
                  w
                )}{#if w.kind === 'desk' && deskCount}<span class="text-ember">{deskCount}</span
                  >{/if}{#if wins.dirty[w.id]}<span class="text-ember" aria-label="unsaved">•</span
                  >{/if}</button
              >
              <button
                class="px-1.5 py-1.5 text-[10px] text-faint hover:text-coral"
                aria-label={`Close ${winTitle(w)}`}
                onclick={() => close(w.id)}>✕</button
              >
            </div>
          {/each}
        </div>
        <div class="min-h-0 flex-1 border-t border-hairline">
          {#each wins.list as w (w.id)}
            <div class="h-full min-h-0" class:hidden={wins.active !== w.id} role="tabpanel">
              <!-- Each window's code loads when it first opens. -->
              {#if w.kind === 'desk'}
                {#await loadDeskDrawer() then { default: DeskDrawer }}
                  <DeskDrawer
                    {desk}
                    {staff}
                    focus={deskFocus}
                    onhire={hireProposal}
                    onplan={planHires}
                    onstaff={select}
                  />
                {/await}
              {:else if w.kind === 'goals'}
                {#await import('#lib/ui/GoalsPanel.svelte') then { default: GoalsPanel }}
                  <GoalsPanel {staff} {version} onthread={openThread} />
                {/await}
              {:else if w.kind === 'lessons'}
                {#await import('#lib/ui/LessonsLibrary.svelte') then { default: LessonsLibrary }}
                  <LessonsLibrary {staff} {version} bind:filter={w.filter} />
                {/await}
              {:else if w.kind === 'ledger'}
                {#await import('#lib/ui/LedgerPanel.svelte') then { default: LedgerPanel }}
                  <LedgerPanel {staff} version={ledgerVersion} />
                {/await}
              {:else if w.kind === 'projects'}
                {#await import('#lib/ui/ProjectSessions.svelte') then { default: ProjectSessions }}
                  <ProjectSessions {staff} {version} ask={w.ask} />
                {/await}
              {:else if w.kind === 'services'}
                {#await import('#lib/ui/ServicesPanel.svelte') then { default: ServicesPanel }}
                  <ServicesPanel {staff} {version} onstaff={select} />
                {/await}
              {:else if w.kind === 'setup'}
                {#await import('#lib/ui/Welcome.svelte') then { default: Welcome }}
                  <Welcome
                    office={office.name}
                    {welcomed}
                    ondesign={() => open({ id: 'office', kind: 'office' })}
                    onhire={() => openHire()}
                    onmeet={(id) => select(id)}
                    ondone={() => {
                      welcomed = true;
                      close(w.id, true);
                    }}
                    {notify}
                    onnotify={setNotify}
                  />
                {/await}
              {:else if w.kind === 'office'}
                <!-- Loaded when opened: it draws with PixiJS, which the first page leaves out. -->
                {#await import('#lib/ui/OfficeDesigner.svelte') then { default: OfficeDesigner }}
                  <OfficeDesigner
                    id={w.id}
                    catalog={office.catalog}
                    staffCount={staff.length}
                    current={office.name}
                  />
                {/await}
              {:else if w.kind === 'hire'}
                {#await import('#lib/ui/HireDrawer.svelte') then { default: HireDrawer }}
                  <HireDrawer
                    id={w.id}
                    rooms={hireRooms}
                    from={w.from}
                    onhired={(p) => {
                      close(w.id, true);
                      refresh();
                      select(p.id);
                    }}
                    ondone={() => {
                      close(w.id, true);
                      refresh();
                    }}
                  />
                {/await}
              {:else if w.kind === 'report'}
                {#await import('#lib/ui/ReportView.svelte') then { default: ReportView }}
                  <ReportView report={w.report} {staff} />
                {/await}
              {:else}
                {#await import('#lib/ui/FileViewer.svelte') then { default: FileViewer }}
                  <FileViewer
                    id={w.id}
                    file={w.file}
                    nameOf={(id) => staff.find((p) => p.id === id)?.name ?? id}
                  />
                {/await}
              {/if}
            </div>
          {/each}
        </div>
        <!-- The music keeps its place and size while Projects widens the panel. -->
        <div class="border-t border-hairline px-3 py-2">
          <div style="max-inline-size: {leftWidth - 24}px">
            <FloorControls bind:light onfit={fitFloor} onzoom={(d) => floor?.zoomBy(d)} />
          </div>
        </div>
      </div>
    </SidePanel>
  {:else}
    <header
      class="glass absolute start-4 top-4 rounded-2xl px-4 py-3 max-sm:start-3 max-sm:px-3 max-sm:py-2"
    >
      {@render plate(false)}
      <div class="mt-2 border-t border-hairline pt-2">
        <FloorControls bind:light onfit={fitFloor} onzoom={(d) => floor?.zoomBy(d)} />
      </div>
    </header>
  {/if}

  <!-- The desk pill, centred on the floor between the two panels, and the
       weather at its end once the owner turns weather on. Projects covers the
       floor, and the plate's Desk button carries the count. -->
  <div
    class="pointer-events-none absolute top-4 flex justify-center max-sm:top-24"
    class:hidden={firstRun || projectsReach !== undefined}
    style="inset-inline: {leftSpace}px {rightSpace}px"
  >
    <!-- The weather hangs off the desk pill's end, so the desk pill keeps its centre. -->
    <div class="relative">
      <button
        class="glass pointer-events-auto flex w-fit items-center gap-2 rounded-full px-4 py-2 text-sm"
        class:desk-due={deskCount > 0}
        onclick={() => toggle('desk')}
        aria-keyshortcuts="D"
      >
        {#if deskCount}
          <span
            class="flex size-5 items-center justify-center rounded-full bg-ember font-pixel text-xs text-night"
            >{deskCount}</span
          >
          <span class="text-ink">waiting on you</span>
        {:else}
          <span class="text-muted">Desk clear</span>
        {/if}
      </button>
      <div class="absolute start-full top-0 ms-2">
        <WeatherPill onsetup={openSetup} />
      </div>
    </div>
  </div>

  <!-- The end side: every Odd on the rail, and the picked one's panel beside it.
       Folding the panel (») leaves the rail, where the Odd's avatar opens it again. -->
  {#if showRail}
    <!-- Fills the screen so the rail keeps its place while it slides toward the edge. -->
    <div class="pointer-events-none absolute inset-0 z-20" transition:fly={fromEdge(80)}>
      <OddsRail
        {staff}
        nowOf={nowIn(oddsNow)}
        {headings}
        selected={profile && !rightCollapsed ? selected : undefined}
        find={findAgent}
        searching={railAsked}
        onleave={() => (railAsked = false)}
        onselect={select}
        onchat={(id) => chatAbout(id, '')}
        onwiden={(w) => (railOpen = w)}
      />
    </div>
  {/if}
  {#if profile && !rightCollapsed}
    <SidePanel
      side="end"
      label="Selected Odd"
      bind:width={rightWidth}
      inset={0}
      min={360}
      max={1000}
      storageKey="oddboro.panel.end"
    >
      {#key profile.id}
        <div class="h-full" in:fly={fromEdge()}>
          {#await loadStaffCard() then { default: StaffCard }}
            <StaffCard
              {...readerProps(snapshot, oddsNow, profile.id, planHires)}
              {profile}
              activity={selectedActivity}
              {version}
              show={cardShow?.id === profile.id ? cardShow : undefined}
              {places}
              manual={!!manual[profile.id]}
              sentTo={manual[profile.id]}
              {held}
              onsend={(place) => send(profile.id, place)}
              onschedule={() => backToSchedule(profile.id)}
              onchatstart={() => chatStart(profile.id)}
              onchatend={() => chatEnd(profile.id)}
              oncollapse={() => (rightCollapsed = true)}
              onclose={() => select(undefined)}
              onitem={(d) => openDelivered(profile.id, d)}
            />
          {/await}
        </div>
      {/key}
    </SidePanel>
  {/if}

  {#if failed}
    <div class="absolute inset-0 grid place-items-center p-6">
      <div class="glass max-w-md rounded-2xl p-6">
        <div class="font-pixel text-xl">The office did not open</div>
        <p class="mt-2 text-sm text-muted">{failed}</p>
        <ol class="mt-4 list-decimal space-y-1 ps-5 text-sm text-muted">
          <li>Run <code class="text-ink">npm run sprites</code> from the repo root.</li>
          <li>Reload this page.</li>
        </ol>
      </div>
    </div>
  {:else if !ready}
    <div class="absolute inset-0 grid place-items-center">
      <div class="font-pixel text-lg text-muted">
        {firstRun ? 'Welcome' : `Opening ${office.name}`}
      </div>
    </div>
  {/if}
  {#if actCheck.asking}
    {#await import('#lib/ui/ActCheck.svelte') then { default: ActCheck }}<ActCheck />{/await}
  {/if}
  {#if actCheck.choosing}
    {#await import('#lib/ui/HandOffChoice.svelte') then { default: HandOffChoice }}
      <HandOffChoice name={actCheck.choosing} />
    {/await}
  {/if}
</main>

<style>
  .rename {
    box-shadow: 0 0 0 1px var(--color-sea);
    font-size: inherit;
  }
  .tag {
    background: rgb(11 13 23 / 0.72);
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08);
    backdrop-filter: blur(6px);
  }
  .tag.active {
    box-shadow:
      0 0 0 1px var(--color-sea),
      0 0 14px rgb(47 179 166 / 0.45);
  }
  .tag.waiting {
    box-shadow:
      0 0 0 1px var(--color-ember),
      0 0 14px rgb(242 180 90 / 0.45);
  }
  .desk-due {
    box-shadow:
      var(--shadow-float),
      0 0 0 1px var(--color-ember);
  }
  /* A window still drawing: a pixel square that blinks. */
  .busy {
    display: inline-block;
    inline-size: 6px;
    block-size: 6px;
    background: var(--color-sea);
    animation: busy 0.8s steps(1) infinite;
  }
  @keyframes busy {
    50% {
      opacity: 0.25;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .busy {
      animation: none;
    }
  }
</style>
