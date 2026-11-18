// The office's music: one entry per file in static/audio/, as `<id>.m4a`, with
// the name the owner sees. New Altitude holds every track, so LICENSE-ASSETS
// keeps the folder out of the Apache license. The files carry a title tag and
// nothing else.

export type Track = { id: string; title: string };

export const TRACKS: Track[] = [
  { id: 'good-morning-neighbor', title: 'Good Morning, Neighbor' },
  { id: 'early-bus', title: 'Early Bus' },
  { id: 'porch-light', title: 'Porch Light' },
  { id: 'first-coffee', title: 'First Coffee' },
  { id: 'second-coffee', title: 'Second Coffee' },
  { id: 'long-way-round', title: 'The Long Way Round' },
  { id: 'around-the-block', title: 'Around the Block' },
  { id: 'last-bus-home', title: 'Last Bus Home' },
  { id: 'running-late', title: 'Running Late' },
  { id: 'window-seat', title: 'Window Seat' },
  { id: 'open-window', title: 'Open Window' },
  { id: 'nothing-urgent', title: 'Nothing Urgent' },
  { id: 'kettle-on', title: 'Kettle On' },
  { id: 'two-oclock', title: "Two O'Clock" },
  { id: 'long-lunch', title: 'Long Lunch' },
  { id: 'garden-path', title: 'Garden Path' },
  { id: 'watering-the-ferns', title: 'Watering the Ferns' },
  { id: 'swivel-chair', title: 'Swivel Chair' },
  { id: 'puzzle-box', title: 'Puzzle Box' },
  { id: 'loose-ends', title: 'Loose Ends' },
  { id: 'quiet-floor', title: 'Quiet Floor' },
  { id: 'blinds-up', title: 'Blinds Up' },
  { id: 'sticky-notes', title: 'Sticky Notes' },
  { id: 'filing-day', title: 'Filing Day' },
  { id: 'lunch-walk', title: 'Lunch Walk' }
];

/** A new owner's first visit opens on this one. */
export const OPENING = 'good-morning-neighbor';

export const trackSrc = (id: string): string => `/audio/${id}.m4a`;

/**
 * Filtered pink noise for concentration, a 32 second loop. It plays on its
 * own, outside the shuffle. Made with ffmpeg alone, no recording: 34 seconds
 * of noise, filtered, then the last 2 crossfaded into the first 2, so the end
 * runs straight into the start.
 *
 *   ffmpeg -f lavfi -i 'anoisesrc=color=pink:amplitude=0.30:sample_rate=24000:seed=104729:duration=35'
 *     -filter_complex '[0:a]highpass=f=70,lowpass=f=2200,atrim=start=1:end=35,asetpts=PTS-STARTPTS,
 *       asplit=2[s1][s2];[s1]atrim=start=2:end=34,asetpts=PTS-STARTPTS[a];
 *       [s2]atrim=start=0:end=2,asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=2:c1=qsin:c2=qsin[out]'
 *     -map '[out]' -ac 1 -c:a aac -b:a 48k -movflags +faststart -map_metadata -1 focus-noise.m4a
 */
export const FOCUS_NOISE = '/sounds/focus-noise.m4a';
