import {
  actCheckPassed,
  advancedMode,
  currentSystem,
  desk,
  goalThreads,
  guessesWaiting,
  roomNamesFor,
  roster,
  serviceNames,
  switchedOffIn,
  unreadPokes,
  welcomed,
  zone
} from '@oddboro/ledger';
import { lastRestore } from '@oddboro/ledger/office-backup';
import { computerWord } from '@oddboro/ledger/system-words';
import { accountStatus } from '#lib/server/account.ts';
import { keepAddress } from '#lib/server/address.ts';
import { diagnosticsState } from '#lib/server/diagnostics.ts';
import { currentOffice } from '#lib/server/space.ts';
import { toProfile } from '#lib/server/profile.ts';
import { heldThreads } from '#lib/staff/thread-tags.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  // The owner's Caddy may have dropped the office's site since: put it back.
  void keepAddress();
  const first = !(await welcomed());
  // A new owner arrives at an empty lot; the office goes up on it as they finish.
  const office = await currentOffice({ lot: first });
  const staff = await roster();
  const guesses = await guessesWaiting(staff.map((s) => s.id));
  return {
    office,
    // The sample office, to move into if the owner's own does not come out.
    sample: first ? (await currentOffice()).world : undefined,
    staff: staff.map((s) => toProfile(s, guesses[s.id])),
    desk: await desk(),
    roomNames: await roomNamesFor(office.id),
    switchedOff: await switchedOffIn(office.id),
    messages: await unreadPokes(),
    // So the first paint already keeps a lead waiting on a colleague at its desk.
    threads: heldThreads(await goalThreads()),
    /** Each service's name by its id, for the lines saying what an Odd is doing. */
    services: await serviceNames(),
    zone: zone(),
    /** What the header calls this computer. */
    computer: `Your ${computerWord(currentSystem())}`,
    welcomed: !first,
    /** Whether the owner turned on Advanced mode, which shows Projects. */
    advanced: await advancedMode(),
    /** Whether the owner passed the Act check, so the page asks it before a first raise to Act. */
    actChecked: await actCheckPassed(),
    diagnostics: diagnosticsState(),
    /** The backup this start restored, until the owner closes its line. */
    restored: lastRestore(),
    account: accountStatus()
  };
};
