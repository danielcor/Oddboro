// One bus for everything the page should hear about: a table changed (from
// Postgres NOTIFY, whichever process wrote it), a staffer started or stopped
// working, an Odd kept or used a lesson, an Odd handed a colleague work or got
// its result back, the New Altitude sign-in changed, or a persona was signed
// in to or joined the office, or the weather setting changed. /api/events streams it to the page. Nothing
// polls.
import { EventEmitter } from 'node:events';
import {
  LOCAL,
  handOffMark,
  handOffNewsSince,
  lessonMark,
  lessonNewsSince,
  pg,
  type HandOffNews,
  type LessonNews
} from '@oddboro/ledger';
import { listenLocal } from '@oddboro/ledger/local-db';
import type { AccountStatus } from '../account.ts';
import type { Offer } from '../persona.ts';
import type { Work } from '../staff/work.ts';

/** An Odd kept a lesson (`staff` heard it) or used one, for the floor to show over that Odd. */
export type LessonEvent = { type: 'lesson' } & LessonNews;
/** An Odd handed a colleague work, or a result went back: `from` walks over to `to`. */
export type HandOffEvent = { type: 'hand-off' } & HandOffNews;

export type OfficeEvent =
  | { type: 'change'; table: string }
  | {
      type: 'working';
      chatting: string[];
      inProgress: Record<string, Work[]>;
    }
  | { type: 'persona'; slug: string; joined: Offer['joined']; problem?: string }
  | LessonEvent
  | HandOffEvent
  | { type: 'account'; status: AccountStatus }
  /** The owner changed the weather setting: each window asks for it again. */
  | { type: 'weather' };

type Bus = EventEmitter & { listening?: Promise<unknown> };
const g = globalThis as unknown as { officeBus?: Bus };
// One bus per process, even when Vite reloads this module.
export const bus: Bus = (g.officeBus ??= new EventEmitter().setMaxListeners(50));

/**
 * Tells the page each piece of one kind of news since it was last told, one
 * read at a time, from the newest row there when the office started, so a
 * restart tells nothing again. A failed read loses that news rather than tell
 * it twice: the next starts from the newest row.
 */
export function teller<Mark, News>(news: {
  name: string;
  mark: () => Promise<Mark>;
  since: (mark: Mark) => Promise<{ news: News[]; mark: Mark }>;
  event: (n: News) => OfficeEvent;
}): () => void {
  const lost = (e: unknown) => {
    console.error(`${news.name} events:`, e);
    return undefined;
  };
  let told: Promise<Mark | undefined> = news.mark().catch(lost);
  return () => {
    told = told
      .then(async (mark) => {
        const read = await news.since(mark ?? (await news.mark()));
        for (const n of read.news) emit(news.event(n));
        return read.mark;
      })
      .catch(lost);
  };
}

export function listen(): void {
  bus.listening ??= start();
}

function start(): Promise<unknown> {
  const tellLessons = teller({
    name: 'Lesson',
    mark: lessonMark,
    since: lessonNewsSince,
    event: (n) => ({ type: 'lesson', ...n })
  });
  const tellHandOffs = teller({
    name: 'Hand-off',
    mark: handOffMark,
    since: handOffNewsSince,
    event: (n) => ({ type: 'hand-off', ...n })
  });
  const change = (table: string) => {
    bus.emit('event', { type: 'change', table });
    if (table === 'lessons' || table === 'lesson_uses') tellLessons();
    if (table === 'follow_ups') tellHandOffs();
  };
  // The office's own database hears NOTIFY in this process, not over a connection.
  return LOCAL ? Promise.resolve(listenLocal('office', change)) : pg.listen('office', change);
}

export function emit(e: OfficeEvent): void {
  bus.emit('event', e);
}
