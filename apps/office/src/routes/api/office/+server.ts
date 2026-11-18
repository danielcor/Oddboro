// Everything the page shows that can change: the staff with the guesses each
// has waiting, the owner's desk, who is
// working and on what, the follow-ups waiting to start, the names the owner gave the rooms, what the owner switched off,
// the pokes that landed and wait unread, the threads a colleague holds for its lead,
// and each service's name.
// The page fetches it once, then
// again on each change event.
import { json } from '@sveltejs/kit';
import {
  desk,
  goalThreads,
  guessesWaiting,
  roomNamesFor,
  roster,
  serviceNames,
  switchedOffIn,
  unreadPokes
} from '@oddboro/ledger';
import { currentOffice } from '#lib/server/space.ts';
import { followUpsWaiting } from '#lib/server/follow-ups.ts';
import { chatting, inProgress } from '#lib/server/staff.ts';
import { toProfile } from '#lib/server/profile.ts';
import { heldThreads } from '#lib/staff/thread-tags.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const office = (await currentOffice()).id;
  const staff = await roster();
  const guesses = await guessesWaiting(staff.map((s) => s.id));
  return json({
    staff: staff.map((s) => toProfile(s, guesses[s.id])),
    desk: await desk(),
    chatting: chatting(),
    inProgress: inProgress(),
    toStart: await followUpsWaiting(),
    roomNames: await roomNamesFor(office),
    switchedOff: await switchedOffIn(office),
    messages: await unreadPokes(),
    threads: heldThreads(await goalThreads()),
    services: await serviceNames()
  });
};
