// The office's music player: one player for the whole page, so the controls can
// sit in the start panel or on the folded plate without the track restarting.
// Tracks play in a random order, never one of the last few again. A loved track
// comes up twice as often, and a passed one never, unless the owner passed on
// all of them. A new owner's first visit opens on "Good Morning, Neighbor".
// After that the music plays on each visit if the owner left it on. A browser
// keeps a page quiet until the visitor clicks or types, so a play the browser
// refuses waits for that. Every choice here is remembered per viewer.
//
// The player also offers focus noise: a soft pink noise loop in place of the
// songs. The owner switches between the two from the menu on the player's
// icon. The song stays loaded and paused while the noise plays, so switching
// back picks it up where it stopped. The noise plays through Web Audio, since
// an <audio> element that loops leaves a short silence each time it starts
// over. Its audio context exists only once the owner plays the noise, and it
// is suspended whenever the noise stops.
import { FOCUS_NOISE, OPENING, TRACKS, trackSrc } from './tracks.ts';

const ON = 'oddboro.music';
const VOLUME = 'oddboro.volume';
const FOCUS_ON = 'oddboro.music.focus';
const REPEAT = 'oddboro.music.repeat';
const LOVED = 'oddboro.music.loved';
const PASSED = 'oddboro.music.passed';

/** Back restarts the track once it has played this long, in seconds. */
const RESTART_AFTER = 3;

export const music = $state<{
  audio?: HTMLAudioElement;
  /** The track loaded, playing or not. */
  current?: string;
  playing: boolean;
  /** Where the track is and how long it runs, in seconds. */
  time: number;
  duration: number;
  /** 0 to 1. */
  volume: number;
  /** Play the current track again when it ends. */
  repeat: boolean;
  /** Focus noise plays in place of the songs. */
  focus: boolean;
  loved: string[];
  passed: string[];
}>({
  playing: false,
  time: 0,
  duration: 0,
  volume: 0.6,
  repeat: false,
  focus: false,
  loved: [],
  passed: []
});

/** The owner's word on the music: 'on', 'off', or never said. */
let choice: string | null = null;
/** The volume the speaker brings back after a mute. */
let lastVolume = 0.6;
/** The tracks played before this one, oldest first. */
const history: string[] = [];
/** Paused because the app's window went to the tray, so it plays again when the window comes back. */
let hushed = false;

/** Focus noise: one looping buffer through a gain node for the volume. */
const noise: {
  ctx?: AudioContext;
  gain?: GainNode;
  buffer?: Promise<AudioBuffer>;
  source?: AudioBufferSourceNode;
  /** The owner wants it playing, even while the file still loads. */
  wanted: boolean;
} = { wanted: false };

function ids(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    const known = new Set(TRACKS.map((t) => t.id));
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && known.has(x))
      : [];
  } catch {
    return [];
  }
}

try {
  choice = localStorage.getItem(ON);
  const v = Number(localStorage.getItem(VOLUME));
  if (localStorage.getItem(VOLUME) !== null && v >= 0 && v <= 1) music.volume = v;
  if (music.volume > 0) lastVolume = music.volume;
  music.focus = localStorage.getItem(FOCUS_ON) === '1';
  music.repeat = localStorage.getItem(REPEAT) === '1';
  music.loved = ids(localStorage.getItem(LOVED));
  music.passed = ids(localStorage.getItem(PASSED));
} catch {
  // No storage: the defaults hold, and the controls work for this visit.
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window: remembered for this visit only.
  }
}

function choose(on: boolean): void {
  choice = on ? 'on' : 'off';
  remember(ON, choice);
}

export const titleOf = (id: string | undefined): string | undefined =>
  TRACKS.find((t) => t.id === id)?.title;

/** The next track: random, weighted to the loved, skipping the passed and the last few played. */
function pick(): string {
  let pool = TRACKS.map((t) => t.id).filter((id) => !music.passed.includes(id));
  if (!pool.length) pool = TRACKS.map((t) => t.id);
  const recent = new Set([...history, music.current].slice(-Math.min(5, pool.length - 1)));
  const fresh = pool.filter((id) => !recent.has(id));
  if (fresh.length) pool = fresh;
  const weighted = pool.flatMap((id) => (music.loved.includes(id) ? [id, id] : [id]));
  return weighted[Math.floor(Math.random() * weighted.length)];
}

function show(id: string, a: HTMLAudioElement): void {
  music.current = id;
  a.src = trackSrc(id);
  if ('mediaSession' in navigator)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: titleOf(id),
      artist: 'Oddboro'
    });
}

function load(id: string): void {
  const a = music.audio;
  if (!a) return;
  if (music.current && music.current !== id) history.push(music.current);
  if (history.length > 50) history.shift();
  show(id, a);
}

function play(): void {
  if (music.focus) {
    void playNoise();
    return;
  }
  const a = music.audio;
  if (!a) return;
  if (!music.current) load(pick());
  a.volume = music.volume;
  void a.play().then(
    () => (music.playing = true),
    () => {}
  );
}

/** Stops whichever sound plays. A song keeps its place. */
function pause(): void {
  if (music.focus) stopNoise();
  else music.audio?.pause();
  music.playing = false;
}

/** Whether the owner's sound plays, or is on its way to playing. */
function sounding(): boolean {
  return music.focus ? noise.wanted : music.audio?.paused === false;
}

/** Starts the noise loop. A browser that keeps the page quiet leaves it waiting for the first click. */
async function playNoise(): Promise<void> {
  noise.wanted = true;
  const ctx = (noise.ctx ??= new AudioContext());
  if (!noise.gain) {
    noise.gain = ctx.createGain();
    noise.gain.connect(ctx.destination);
  }
  noise.gain.gain.value = music.volume;
  try {
    noise.buffer ??= fetch(FOCUS_NOISE)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b));
    const buffer = await noise.buffer;
    await ctx.resume();
    if (!noise.wanted || noise.source || !music.focus) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(noise.gain);
    source.start();
    noise.source = source;
    music.playing = true;
  } catch {
    // The file did not load: the next play tries again.
    noise.buffer = undefined;
  }
}

/** Stops the noise and suspends its audio context, so nothing runs while it is quiet. */
function stopNoise(): void {
  noise.wanted = false;
  noise.source?.stop();
  noise.source?.disconnect();
  noise.source = undefined;
  void noise.ctx?.suspend();
}

/** The Mac's media keys and Control Center play, pause and skip tracks too. */
function mediaKeys(): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => {
    if (!music.playing) togglePlay();
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    if (music.playing) togglePlay();
  });
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', back);
}

/**
 * The desktop app says when its window goes to the tray and when it comes
 * back (`oddboro:hidden`, `oddboro:shown`, from apps/desktop/src-tauri/src/main.rs).
 * With the window gone there is no control to stop the music, so it pauses,
 * and it picks up again when the window returns. The owner's on or off stays
 * as it was. A browser tab never hears either.
 */
function hushWhileHidden(): void {
  window.addEventListener('oddboro:hidden', () => {
    if (!music.playing) return;
    hushed = true;
    pause();
  });
  window.addEventListener('oddboro:shown', () => {
    if (!hushed) return;
    hushed = false;
    play();
  });
}

/**
 * On page load: a first visit plays the opening track, a later one plays if
 * the owner left the music on. Now if the browser lets it, else at the first
 * click or key.
 */
export function startMusic(firstRun: boolean): void {
  if (!music.audio) return;
  mediaKeys();
  hushWhileHidden();
  if (choice === 'off' || (!firstRun && choice !== 'on')) return;
  if (!music.focus) load(firstRun && !music.passed.includes(OPENING) ? OPENING : pick());
  play();
  const first = () => {
    if (!music.playing && choice !== 'off') play();
  };
  window.addEventListener('pointerdown', first, { once: true });
  window.addEventListener('keydown', first, { once: true });
}

export function togglePlay(): void {
  hushed = false;
  if (music.playing) {
    pause();
    choose(false);
    return;
  }
  choose(true);
  if (music.volume === 0) setVolume(lastVolume);
  play();
}

/** A new random track, playing. */
export function next(): void {
  if (music.focus) return;
  load(pick());
  choose(true);
  play();
}

/** The start of this track, or the one before it if this one only just began. */
export function back(): void {
  if (music.focus) return;
  const a = music.audio;
  if (!a) return;
  const before = history.pop();
  if (a.currentTime > RESTART_AFTER || !before) {
    if (before) history.push(before);
    a.currentTime = 0;
  } else {
    show(before, a);
  }
  choose(true);
  play();
}

/** Switches between the songs and focus noise, keeping the owner's play or pause. */
export function setFocus(focus: boolean): void {
  if (focus === music.focus) return;
  const wasPlaying = sounding();
  pause();
  music.focus = focus;
  remember(FOCUS_ON, focus ? '1' : '0');
  if (wasPlaying) play();
}

export function toggleRepeat(): void {
  music.repeat = !music.repeat;
  remember(REPEAT, music.repeat ? '1' : '0');
}

export function toggleLove(): void {
  const id = music.current;
  if (!id) return;
  music.loved = music.loved.includes(id)
    ? music.loved.filter((x) => x !== id)
    : [...music.loved, id];
  music.passed = music.passed.filter((x) => x !== id);
  remember(LOVED, JSON.stringify(music.loved));
  remember(PASSED, JSON.stringify(music.passed));
}

/** Pass on the current track: the player moves on, and the shuffle leaves it out. Again takes it back. */
export function togglePass(): void {
  const id = music.current;
  if (!id) return;
  const passing = !music.passed.includes(id);
  music.passed = passing ? [...music.passed, id] : music.passed.filter((x) => x !== id);
  music.loved = music.loved.filter((x) => x !== id);
  remember(PASSED, JSON.stringify(music.passed));
  remember(LOVED, JSON.stringify(music.loved));
  if (!passing) return;
  const wasPlaying = music.playing;
  load(pick());
  if (wasPlaying) play();
}

/** The seek bar. */
export function seek(t: number): void {
  const a = music.audio;
  if (!a || !music.duration) return;
  a.currentTime = Math.max(0, Math.min(music.duration, t));
  music.time = a.currentTime;
}

/** The volume slider. All the way down silences the music without stopping it. */
export function setVolume(v: number): void {
  music.volume = Math.max(0, Math.min(1, v));
  if (music.volume > 0) lastVolume = music.volume;
  remember(VOLUME, String(music.volume));
  if (music.audio) music.audio.volume = music.volume;
  if (noise.gain) noise.gain.gain.value = music.volume;
}

/** The speaker: silence the music, or bring back the volume it had. */
export function toggleMute(): void {
  setVolume(music.volume > 0 ? 0 : lastVolume);
}

/** A track came to its end: again on repeat, else the next one. */
export function musicEnded(): void {
  const a = music.audio;
  if (music.repeat && a) {
    a.currentTime = 0;
    play();
    return;
  }
  load(pick());
  play();
}
