// The app's updates, from the office's side. The shell (apps/desktop) finds a
// new version, downloads and checks it, then tells this server
// (`POST /api/update`) and asks every 30 seconds whether to install it. This
// file decides: at the start of the owner's window, or now when they press
// Install now, and only once the Odds are held and no run is active. When
// the rules are in `@oddboro/ledger/update-window`.
import {
  holding,
  markDown,
  markUp,
  nextWindowStart,
  setInstallAt,
  setReadyUpdate,
  setUpdateWindow,
  timeToInstall,
  updateRow,
  chatUpdateStatus,
  type UpdateRow
} from '@oddboro/ledger';
import { fixedError } from '@oddboro/ledger/errors';
import { currentDesign } from './design-job.ts';
import { emit } from './events.ts';
import { runsActive } from './staff.ts';

/** The app's version, which the shell passes. Unset in development. */
export const VERSION = process.env.ODDBORO_VERSION ?? '';
/** True when a shell that installs updates started this server: a release build of the app. */
export const MANAGED = process.env.ODDBORO_UPDATES === '1';

/** The last check the shell reported, kept only while this server runs. */
export type Checked = { at: string; result: 'none' | 'ready' | 'failed'; problem?: string };

const g = globalThis as unknown as {
  appUpdate?: { row?: UpdateRow; checked?: Checked; asked?: string };
};
const state = (g.appUpdate ??= {});

/** Once, as the server starts: forget whatever was ready, and note a return from an update. */
export async function loadUpdate(): Promise<void> {
  state.row = await markUp();
}

/** The row as this server last wrote it. Only this server writes it. */
const row = () => state.row;

/** True from 15 minutes before a ready update installs. The job clock and follow-ups start nothing new. */
export function held(now = new Date()): boolean {
  return holding(row()?.installAt, now);
}

/** When a ready update installs, if one is ready. */
export function installsAt(): Date | undefined {
  return row()?.installAt ?? undefined;
}

/** When the app last went down for an update and came back, for a poke's grace. */
export function downtime(): { from: Date | null; to: Date | null } {
  return { from: row()?.downAt ?? null, to: row()?.upAt ?? null };
}

/** The shell has a version ready. It installs in the owner's next window, unless they already said now. */
export async function ready(version: string, notes: string): Promise<void> {
  const r = row() ?? (await updateRow());
  const keep = r.readyVersion === version && r.installAt;
  const installAt = keep || nextWindowStart(new Date(), r.windowStart, r.windowEnd);
  state.checked = { at: new Date().toISOString(), result: 'ready' };
  state.asked = undefined;
  state.row = await setReadyUpdate(version, notes, installAt);
}

/** The shell checked and found nothing new, or could not check. */
export function checked(problem?: string): void {
  state.checked = {
    at: new Date().toISOString(),
    result: problem ? 'failed' : 'none',
    ...(problem ? { problem: problem.slice(0, 300) } : {})
  };
  state.asked = undefined;
  emit({ type: 'change', table: 'app_update' });
}

/** The owner pressed Install now, or Install tonight. */
export async function installWhen(when: 'now' | 'tonight'): Promise<void> {
  const r = row() ?? (await updateRow());
  if (!r.readyVersion) throw fixedError('No update is ready');
  const now = new Date();
  state.row = await setInstallAt(
    when === 'now' ? now : nextWindowStart(now, r.windowStart, r.windowEnd)
  );
}

/** The owner's window. A ready update that waits for it moves with it. */
export async function setWindow(start: string, end: string): Promise<void> {
  state.row = await setUpdateWindow(start, end);
  const r = state.row;
  const now = new Date();
  if (r.readyVersion && r.installAt && r.installAt > now)
    state.row = await setInstallAt(nextWindowStart(now, start, end));
}

/** Ask the shell to check now. It reads this line from the server's stdout. */
export function askShellToCheck(): void {
  if (!MANAGED) throw fixedError('Only the desktop app checks for updates');
  state.asked = new Date().toISOString();
  process.stdout.write('oddboro:update-check\n');
  emit({ type: 'change', table: 'app_update' });
}

/** True while any Odd or the office itself is running something. */
function active(): boolean {
  const design = currentDesign();
  return runsActive() || (!!design && !design.finished);
}

/**
 * What the shell and the Setup window see. `install` turns true once the time
 * has come, the Odds are held and nothing runs, or 20 minutes past it. When
 * the shell is the one asking and the answer is yes, the app goes down now.
 */
export async function status(shell = false) {
  const r = row() ?? (await updateRow());
  const now = new Date();
  const install = !!r.readyVersion && timeToInstall(r.installAt, now, active());
  if (install && shell) state.row = await markDown();
  return {
    ready: !!r.readyVersion,
    version: r.readyVersion,
    notes: r.readyNotes,
    installAt: r.installAt?.toISOString() ?? null,
    install,
    holding: !!r.readyVersion && held(now),
    current: VERSION || 'development',
    managed: MANAGED,
    window: { start: r.windowStart, end: r.windowEnd },
    checked: state.checked ?? null,
    checking: !!state.asked
  };
}

export type UpdateStatus = Awaited<ReturnType<typeof status>>;

/** A chat reads the same status as Setup, without release-note text. */
export const updateForChat = async () => chatUpdateStatus.parse(await status());
