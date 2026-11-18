// Which tables tell the page they changed, and what the page does when one
// does. Every table in the schema has a row, so a new table fails the type
// check here until it says. The trigger itself goes in a migration by hand;
// `test/live-tables.test.ts` holds each row to the database. Imports types
// only, so the page reads it too.
import type { PgTable } from 'drizzle-orm/pg-core';
import type * as schema from './schema.ts';

type Schema = typeof schema;
/** The name of every table the schema exports. */
export type TableName = {
  [K in keyof Schema]: Schema[K] extends PgTable<infer T> ? T['name'] : never;
}[keyof Schema];

/**
 * - `trigger`: `all` NOTIFYs `office` on every insert, update and delete,
 *   `update` on updates only, and `none` says why the page needs no word.
 * - `page`: what the page does on the word. `refresh` reads the office again,
 *   `version` reloads what the open cards and windows show, `ledger` reloads
 *   the Ledger window only, and `reload` reloads the whole page.
 */
export type LiveTable = {
  trigger: 'all' | 'update' | { none: string };
  page: readonly ('refresh' | 'version' | 'ledger' | 'reload')[];
};

export const LIVE_TABLES: Record<TableName, LiveTable> = {
  project_requests: { trigger: 'all', page: ['refresh', 'version'] },
  project_sessions: { trigger: 'all', page: ['version'] },
  staff: { trigger: 'all', page: ['refresh'] },
  // Once the office is up, every change is the owner's own call on the page, and
  // the list that made it reads the accounts again (agent-tools.svelte.ts).
  accounts: { trigger: 'all', page: [] },
  goals: { trigger: 'all', page: ['version'] },
  staff_skills: {
    trigger: {
      none: "Written only by the owner on the Odd's info page, which reads its list again after each change."
    },
    page: []
  },
  staff_goals: { trigger: 'all', page: ['version'] },
  goal_progress: { trigger: 'all', page: ['version'] },
  asks: { trigger: 'all', page: ['refresh', 'version'] },
  tasks: { trigger: 'all', page: ['refresh', 'version'] },
  reports: { trigger: 'all', page: ['refresh', 'version'] },
  // Read with the ask or task they belong to.
  attachments: { trigger: 'all', page: [] },
  pokes: { trigger: 'all', page: ['refresh', 'version'] },
  lessons: { trigger: 'all', page: ['refresh', 'version'] },
  lesson_uses: { trigger: 'all', page: ['version'] },
  ledger: { trigger: 'all', page: ['ledger'] },
  connectors: { trigger: 'all', page: ['refresh', 'version'] },
  grants: { trigger: 'all', page: ['version'] },
  // A job that skipped a run shows on the desk (`desk().away`), so the page reads the office again.
  jobs: { trigger: 'all', page: ['refresh', 'version'] },
  threads: { trigger: 'all', page: ['refresh', 'version'] },
  // The office's own listener starts each new follow-up (follow-ups.ts). The
  // page reads the office again, for those waiting to start under In progress.
  follow_ups: { trigger: 'all', page: ['refresh'] },
  runs: { trigger: 'all', page: ['version'] },
  parts: {
    trigger: { none: 'Saved only with a look, by hire() or setLook(), which write staff too.' },
    page: []
  },
  usage: { trigger: 'all', page: ['version'] },
  owner: {
    trigger: {
      none: "Written only by the owner's own welcome and Setup on the page (finishWelcome, setAdvancedMode), never by an Odd."
    },
    page: []
  },
  plan_limits: { trigger: 'all', page: ['version'] },
  // The first run and the landing of its last drawn pieces refresh instead; the page keeps that rule.
  offices: { trigger: 'update', page: ['reload'] },
  art: {
    trigger: { none: 'Saved with a layout before the move into it, which updates offices.' },
    page: []
  },
  office_rooms: {
    trigger: { none: 'Written in the move between layouts, which updates offices.' },
    page: []
  },
  room_names: { trigger: 'all', page: ['refresh'] },
  switched_off: { trigger: 'all', page: ['refresh'] },
  // The Setup window's updates section listens for it itself.
  app_update: { trigger: 'all', page: [] }
};
