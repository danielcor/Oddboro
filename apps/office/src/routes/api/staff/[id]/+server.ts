// DELETE lets the Odd go from the office: the owner's Remove on its card,
// after the page's own confirm (`removeOdd` in the ledger). It is soft: the
// Office Manager can bring it back, with the owner's yes.
// PATCH changes a staffer's permission level, coding tool, account, model or thinking level, grant or remove one
// office tool, switch Run commands or Browse the web, give or take back a
// folder outside the office, or change what happens when another Odd hands it
// work (`actsOnHandOffs`), which a move up to Act also takes with it. Only the owner does this, from the card. A move
// to another tool can turn Run commands on with it: the one click the Access
// tab offers under a switch the Odd's own tool cannot follow.
import { error, json } from '@sveltejs/kit';
import {
  ActCheckNeeded,
  currentPlatform,
  agentsOn,
  offeredAgent,
  parseLevel,
  removeOdd,
  setAgent,
  setEffort,
  setModel,
  setAccount,
  setFolder,
  setOwnTool,
  setActsOnHandOffs,
  setPermission,
  setTool,
  staffer,
  EFFORT_ORDER,
  type Effort
} from '@oddboro/ledger';
import type { StaffPatchKey } from '@oddboro/ledger/grantable';
import { isBusy } from '#lib/server/staff.ts';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ params, request }) => {
  const who = await staffer(params.id);
  if (!who) error(404, 'No such Odd');
  // A new key goes in STAFF_PATCH_KEYS first, where PATCH_KEY classes it.
  const b = (await request.json().catch(() => ({}))) as Partial<Record<StaffPatchKey, unknown>>;
  if (typeof b.tool === 'string') {
    if (typeof b.on !== 'boolean') error(400, 'Say whether to grant or remove it');
    try {
      await setTool(params.id, b.tool, b.on);
    } catch (e) {
      error(400, e instanceof Error ? e.message : String(e));
    }
    return json({ ok: true });
  }
  // Before the commands branch: a move that turns commands on is checked
  // against the tool it moves to, not the one it leaves (`setAgent`).
  if (b.agent !== undefined) {
    // Only a tool whose sandbox held on this system (`AGENT_PLATFORMS`).
    const agent = offeredAgent(b.agent, currentPlatform());
    if (!agent) error(400, `Pick ${agentsOn(currentPlatform()).join(' or ')}`);
    // A chat still replying would save its session after the move, for a tool that cannot resume it.
    if (isBusy(params.id)) error(409, 'Wait for the reply to finish, then switch.');
    const moved = await setAgent(
      params.id,
      agent,
      typeof b.commands === 'boolean' ? b.commands : undefined
    );
    if (moved) error(400, moved.refused);
    return json({ ok: true });
  }
  // Like a tool, each of these takes effect on the Odd's next run, so none waits for a reply.
  if (b.account !== undefined) {
    if (b.account !== null && typeof b.account !== 'string') error(400, 'Pick an account');
    // A chat still replying would save its session after the move, in the folder it left.
    if (isBusy(params.id)) error(409, 'Wait for the reply to finish, then switch.');
    const set = await setAccount(params.id, b.account);
    if (set) error(400, set.refused);
    return json({ ok: true });
  }
  if (b.model !== undefined) {
    if (b.model !== null && typeof b.model !== 'string') error(400, 'Pick a model');
    const set = await setModel(params.id, b.model);
    if (set) error(400, set.refused);
    return json({ ok: true });
  }
  if (b.effort !== undefined) {
    const effort = EFFORT_ORDER.find((e) => e === b.effort);
    if (!effort) error(400, `Pick ${EFFORT_ORDER.join(', ')}`);
    const set = await setEffort(params.id, effort as Effort);
    if (set) error(400, set.refused);
    return json({ ok: true });
  }
  if (typeof b.commands === 'boolean') {
    const set = await setOwnTool(params.id, 'commands', b.commands);
    if (set) error(400, set.refused);
    return json({ ok: true });
  }
  if (typeof b.web === 'boolean') {
    await setOwnTool(params.id, 'web', b.web);
    return json({ ok: true });
  }
  if (typeof b.folder === 'string') {
    // Taken back by the path as stored, so a folder deleted from the disk can still go.
    if (b.access === null) {
      await setFolder(params.id, b.folder, null);
      return json({ ok: true });
    }
    if (b.access !== 'read' && b.access !== 'write') error(400, 'Pick read or write');
    // A whole drive or system files comes back as a warning, given nothing,
    // until the owner presses Accept, which sends `accept`.
    const set = await setFolder(params.id, b.folder, b.access, b.accept === true);
    if (set && 'refused' in set) error(400, set.refused);
    if (set) return json({ warning: set.warning });
    return json({ ok: true });
  }
  const acts = typeof b.actsOnHandOffs === 'boolean' ? b.actsOnHandOffs : undefined;
  if (b.permission === undefined && acts !== undefined) {
    const set = await setActsOnHandOffs(params.id, acts);
    if (set) error(400, set.refused);
    return json({ ok: true });
  }
  const permission = parseLevel(b.permission);
  if (!permission) error(400, 'Pick read, draft or act');
  try {
    // A move up to Act takes the owner's choice for work from colleagues; left out, the stored one stays.
    await setPermission(params.id, permission, acts);
  } catch (e) {
    // Act waits for the owner's Act check; the page shows it on this answer.
    if (e instanceof ActCheckNeeded) error(409, e.message);
    throw e;
  }
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params }) => {
  if (!(await staffer(params.id))) error(404, 'No such Odd');
  const left = await removeOdd(params.id);
  if (left) error(400, left.refused);
  return json({ ok: true });
};
