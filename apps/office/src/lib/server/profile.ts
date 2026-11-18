// An Odd as the page gets it, worked out on the server: what its runs reach
// reads the disk (folders still there) and this office's held network, and
// each folder's `~` form and whether it touches a secret store read the home
// folder, none of which the page can do.
import {
  currentPlatform,
  effortFor,
  heldReach,
  MANAGER_ROLE,
  modelFor,
  networkHeld,
  ownTools,
  shownFolder,
  touchesSecretStore,
  webLine,
  type StaffRow
} from '@oddboro/ledger';
import { officeDay } from '@oddboro/ledger/time';
import { lookVersion, type StaffProfile } from '../staff/roster.ts';
import { shownOfficeModel } from './claude.ts';

/**
 * A staff row as the page needs it. The job description stays on the server.
 * A new hire has no guesses of its own; the next office load counts any for every Odd.
 */
export function toProfile(r: StaffRow, guesses = 0): StaffProfile {
  const reach = heldReach(r.agent, ownTools(r, currentPlatform()), networkHeld());
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    office: r.office,
    sprite: r.sprite,
    variant: r.variant,
    portrait: r.portrait,
    hired: officeDay(new Date(r.hiredAt)),
    permission: r.permission,
    actsOnHandOffs: r.actsOnHandOffs,
    agent: r.agent,
    ...(r.account ? { account: r.account } : {}),
    model: modelFor(r.agent, r.model),
    // An Odd with none of its own runs the office's, else its tool's default, first in its list.
    officeModel: shownOfficeModel(r.agent),
    effort: effortFor(r.agent, r.effort, r.role === MANAGER_ROLE, modelFor(r.agent, r.model)),
    tools: r.tools,
    // Every office keeps its manager, so its card offers no Remove.
    ...(r.role === MANAGER_ROLE ? { manager: true as const } : {}),
    commands: r.commands,
    web: r.web,
    webLine: webLine(r.agent, currentPlatform(), reach.held),
    folders: r.folders.map((f) => ({
      ...f,
      shown: shownFolder(f.path),
      touchesStore: touchesSecretStore(f.path)
    })),
    reach,
    remit: r.remit,
    room: r.room,
    guesses,
    look:
      r.look && r.portraitPx
        ? {
            spec: r.look,
            version: lookVersion(r.look, r.portraitPx),
            sheet: `/api/staff/${r.id}/look?v=${lookVersion(r.look, r.portraitPx)}`,
            portrait: `/api/staff/${r.id}/portrait?v=${lookVersion(r.look, r.portraitPx)}`
          }
        : undefined,
    ...(r.package ? { persona: r.package } : {})
  };
}
