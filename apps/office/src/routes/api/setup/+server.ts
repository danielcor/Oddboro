// What the office needs and whether it has it, for the welcome and the Setup
// window: the same checks `npm run setup` runs, with the owner's name and zone.
// POST finishes the welcome under the name the owner gives.
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { error, json } from '@sveltejs/kit';
import {
  activeOffice,
  DATABASE_URL,
  finishWelcome,
  hostEnv,
  IN_APP,
  LINUX,
  LOCAL,
  MAC,
  ownerName,
  roster,
  welcomed,
  zone,
  SYSTEM,
  WINDOWS,
  zoneName
} from '@oddboro/ledger';
import { checkDatabase, checkMachine, type Check } from '@oddboro/ledger/checks';
import { CAN_NOTIFY } from '#lib/server/notify.ts';
import type { RequestHandler } from './$types';

const BUILT_IN: Check = {
  id: 'database',
  name: 'Database',
  state: 'ok',
  found: 'Postgres, built into the office'
};

export const GET: RequestHandler = async () => {
  const [machine, database] = await Promise.all([
    checkMachine(),
    // The office's own database is up whenever this server is, with pgvector
    // and live updates built in.
    LOCAL ? { checks: [BUILT_IN] } : checkDatabase(DATABASE_URL)
  ]);
  const name = await ownerName();
  // The computer's own name for its owner, to offer before they type one: the
  // Mac's full name, the real-name field of the account on Linux, or the
  // account's display name on Windows (local, domain or work account alike).
  const full = await new Promise<string>((done) =>
    MAC
      ? execFile('id', ['-F'], { env: hostEnv() }, (_e, out) => done(String(out ?? '').trim()))
      : LINUX
        ? execFile('getent', ['passwd', userInfo().username], { env: hostEnv() }, (_e, out) =>
            done(
              String(out ?? '')
                .split(':')[4]
                ?.split(',')[0]
                ?.trim() ?? ''
            )
          )
        : WINDOWS
          ? execFile(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                'Add-Type -AssemblyName System.DirectoryServices.AccountManagement; [System.DirectoryServices.AccountManagement.UserPrincipal]::Current.DisplayName'
              ],
              { env: hostEnv(), windowsHide: true, timeout: 10_000 },
              (_e, out) => done(String(out ?? '').trim())
            )
          : done('')
  );
  return json({
    app: IN_APP,
    system: SYSTEM,
    /** Whether the office can show its own notifications here. */
    notify: CAN_NOTIFY,
    suggested: full.split(' ')[0] ?? '',
    checks: [...machine.filter((c) => c.id !== 'docker'), ...database.checks],
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
