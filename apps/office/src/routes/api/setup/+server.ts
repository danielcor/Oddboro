// What the office needs and whether it has it, for the welcome and the Setup
// window: the same checks `npm run setup` runs, with the owner's name and zone.
// POST finishes the welcome under the name the owner gives.
import { userInfo } from 'node:os';
import { error, json } from '@sveltejs/kit';
import {
  activeOffice,
  currentSystem,
  DATABASE_URL,
  finishWelcome,
  IN_APP,
  LOCAL,
  ownerName,
  probe,
  roster,
  welcomed,
  zone,
  zoneName,
  type Probe,
  type System
} from '@oddboro/ledger';
import { checkDatabase, checkMachine, type Check } from '@oddboro/ledger/checks';
import { logSetup } from '#lib/server/health.ts';
import { CAN_NOTIFY, canOpenNotifySettings } from '#lib/server/notify.ts';
import type { RequestHandler } from './$types';

const BUILT_IN: Check = {
  id: 'database',
  name: 'Database',
  state: 'ok',
  found: 'Postgres, built into the office'
};

/**
 * The computer's own name for its owner, to offer before they type one: the
 * Mac's full name, the real-name field of the account on Linux, or the
 * account's display name on Windows (local, domain or work account alike).
 * Each prints the name alone.
 */
const FULL_NAME: Record<System, () => Promise<Probe>> = {
  mac: () => probe('id', ['-F']),
  linux: async () => {
    const r = await probe('getent', ['passwd', userInfo().username]);
    // The fifth field of the account's line, up to its first comma.
    return r.status === 'ok' ? { ...r, out: r.out.split(':')[4]?.split(',')[0] ?? '' } : r;
  },
  windows: () =>
    probe(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.DirectoryServices.AccountManagement; [System.DirectoryServices.AccountManagement.UserPrincipal]::Current.DisplayName'
      ],
      { timeout: 10_000 }
    )
};

/** The owner's full name as this computer has it, or nothing when it cannot say. */
async function fullName(): Promise<string> {
  const system = currentSystem();
  if (!system) return '';
  const r = await FULL_NAME[system]();
  switch (r.status) {
    case 'ok':
      return r.out.trim();
    case 'failed':
    case 'missing':
    case 'timeout':
      return '';
    default: {
      const missed: never = r;
      throw new Error(`The owner's name came back as ${JSON.stringify(missed)}`);
    }
  }
}

export const GET: RequestHandler = async () => {
  const [machine, database] = await Promise.all([
    checkMachine(),
    // The office's own database is up whenever this server is, with pgvector
    // and live updates built in.
    LOCAL ? { checks: [BUILT_IN] } : checkDatabase(DATABASE_URL)
  ]);
  const name = await ownerName();
  const full = await fullName();
  const checks = [...machine.filter((c) => c.id !== 'docker'), ...database.checks];
  logSetup(checks);
  return json({
    app: IN_APP,
    /** Whether the office keeps its own database, which is what a backup covers. */
    ownDatabase: LOCAL,
    system: currentSystem(),
    /** Whether the office can show its own notifications here. */
    notify: CAN_NOTIFY,
    /** Whether this system has a notification settings page to open. */
    notifySettings: canOpenNotifySettings(),
    suggested: full.split(' ')[0] ?? '',
    checks,
    owner: name === 'the owner' ? '' : name,
    zone: zone(),
    zoneName: zoneName(),
    welcomed: await welcomed(),
    sample: !(await activeOffice()),
    staff: (await roster()).map((p) => ({ id: p.id, name: p.name, role: p.role }))
  });
};

export const POST: RequestHandler = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) error(400, 'Say what your Odds should call you');
  await finishWelcome(name);
  return json({ ok: true });
};
