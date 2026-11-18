// Hire a staffer, in the look drawn for them. The new row reaches the page
// through the change stream, and the staffer walks in from the lobby. Hiring
// from a proposed hire approves that ask, gives the hire its copy of the
// owner's intake, and links it to the goal it was proposed for. The first job
// comes with the hire, so the new staffer knows it when it says hello in its
// chat and gets started on its first day (`firstDay`). A hire with no job says
// hello and then runs only when it is handed work: one serving a goal gets its
// first piece from the goal's lead, whom approving the hire wakes. The tool it
// runs on, the account it signs in with there, its model and how hard it
// thinks are stored with the row, so its hello and every run after go through
// them. Left out, each is the office's. The MCP servers an imported Claude
// Code agent file listed become access asks, never access (`askForImported`).
import { error, json } from '@sveltejs/kit';
import {
  account as accountRow,
  ACT_CHECK_NEEDED,
  actCheckPassed,
  addJob,
  AGENT_NAMES,
  agentsOn,
  approveHire,
  ask,
  currentPlatform,
  EFFORT_ORDER,
  effortsOf,
  hire,
  MISSED_RUNS,
  MODELS,
  OFFICE_ACCOUNT,
  officeAgent,
  offeredAgent,
  parseLevel
} from '@oddboro/ledger';
import { parseSchedule } from '#lib/server/schedule.ts';
import { firstDay } from '#lib/server/staff.ts';
import { askForImported, serversFrom } from '#lib/server/imported-servers.ts';
import { giveIntake } from '#lib/server/files.ts';
import { currentOffice } from '#lib/server/space.ts';
import { drawnFrom, problemsWith } from '#lib/server/looks.ts';
import { toProfile } from '#lib/server/profile.ts';
import { LIMITS } from '#lib/staff/roster.ts';
import type { RequestHandler } from './$types';

type Body = Partial<Record<'name' | 'role' | 'room' | 'permission' | 'remit' | 'desk', string>> & {
  tools?: unknown;
  agent?: unknown;
  account?: unknown;
  model?: unknown;
  effort?: unknown;
  askId?: unknown;
  look?: unknown;
  portraitPx?: unknown;
  newParts?: unknown;
  /** At Act, the owner's choice for work another Odd hands the hire. */
  actsOnHandOffs?: unknown;
  /** The MCP servers its imported Claude Code agent file listed: each that asks becomes an access ask. */
  servers?: unknown;
  job?: {
    name?: unknown;
    instructions?: unknown;
    schedule?: unknown;
    report?: unknown;
    missed?: unknown;
  };
};

export const POST: RequestHandler = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as Body;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = text(b.name, LIMITS.name);
  const role = text(b.role, LIMITS.role);
  const remit = text(b.remit, LIMITS.remit);
  const desk = text(b.desk, LIMITS.desk);
  const drawn = drawnFrom(b);
  const office = await currentOffice();
  const rooms = new Set(office.world.rooms.map((r) => r.id.split('#')[0]));
  const room = text(b.room, 60);
  const permission = parseLevel(b.permission);
  if (!name || !role || !remit || !desk)
    error(400, 'Fill in the name, role, remit and job description');
  if (!drawn) error(400, 'Draw them first');
  const problems = await problemsWith(drawn);
  if (problems.length) error(400, problems.join('; '));
  if (!rooms.has(room)) error(400, 'Pick a room on the floor');
  if (!permission) error(400, 'Pick read, draft or act');
  // A hire at Act waits for the owner's Act check (`hire` refuses it too).
  if (permission === 'act' && !(await actCheckPassed())) error(409, ACT_CHECK_NEEDED);
  // Left out, the hire runs on the column's default, Claude Code.
  const agent = b.agent === undefined ? undefined : offeredAgent(b.agent, currentPlatform());
  if (b.agent !== undefined && !agent)
    error(400, `Pick ${agentsOn(currentPlatform()).join(' or ')}`);
  // Checked against the tool it will run on before anything is made, as the Model tab checks a change.
  const on = agent ?? officeAgent();
  const model = typeof b.model === 'string' && b.model ? b.model : null;
  if (model && !MODELS[on].some((m) => m.id === model))
    error(400, `${AGENT_NAMES[on]} has no model called ${model}`);
  const effort = EFFORT_ORDER.find((e) => e === b.effort) ?? null;
  if (b.effort != null && (!effort || !effortsOf(on, model).includes(effort)))
    error(400, `${AGENT_NAMES[on]} does not think at that level`);
  const account = typeof b.account === 'string' && b.account !== OFFICE_ACCOUNT ? b.account : null;
  if (account && (await accountRow(account))?.agent !== on)
    error(400, `That is not one of ${AGENT_NAMES[on]}'s accounts`);
  const jobName = text(b.job?.name, 80);
  const jobSteps = text(b.job?.instructions, 8000);
  const jobSchedule = b.job ? parseSchedule(b.job.schedule) : null;
  if (b.job && (!jobName || !jobSteps)) error(400, 'Give the first job a name and say what to do');
  if (b.job && !jobSchedule) error(400, 'Say how often the first job runs');
  const from = typeof b.askId === 'number' ? await ask(b.askId) : undefined;
  if (from && (from.kind !== 'hire' || from.status !== 'open'))
    error(400, 'That proposal is no longer open');
  const tools = Array.isArray(b.tools)
    ? b.tools.filter((t): t is string => typeof t === 'string')
    : undefined;
  let row;
  try {
    // The atlas names stay as a fallback; the drawn look is what shows.
    row = await hire({
      name,
      office: office.name,
      role,
      remit,
      desk,
      room,
      permission,
      agent,
      account,
      model,
      effort,
      sprite: 'staff',
      variant: 'look',
      portrait: 'look',
      tools,
      look: drawn.look,
      portraitPx: drawn.portraitPx,
      newParts: drawn.newParts,
      actsOnHandOffs: b.actsOnHandOffs === true
    });
  } catch (e) {
    error(400, e instanceof Error ? e.message : String(e));
  }
  if (b.job && jobSchedule)
    await addJob({
      staffId: row.id,
      name: jobName,
      instructions: jobSteps,
      schedule: jobSchedule,
      report: b.job.report === true,
      missed: MISSED_RUNS.find((m) => m === b.job?.missed)
    });
  // Asked before its first day, so the hire finds them on the desk and does not ask again.
  await askForImported(row.id, row.name, serversFrom(b.servers)).catch((e: unknown) =>
    console.error(`[hire] access asks for ${row.id}: ${e instanceof Error ? e.message : e}`)
  );
  // The hire is made, so what fails after this is logged, not a failed hire. A
  // goal gone since leaves the proposal open on the desk: the hire does not serve it.
  if (from?.hire?.intakeFile)
    await giveIntake(from.staffId, from.hire.intakeFile, row.id).catch((e: unknown) =>
      console.error(`[hire] intake for ${row.id}: ${e instanceof Error ? e.message : e}`)
    );
  // Approved last: the answer wakes the goal's lead to hand the hire its first
  // piece, so the hire must already hold its intake. Approving links the goal.
  if (from)
    await approveHire(from.id, row.id).catch((e: unknown) =>
      console.error(
        `[hire] proposal ${from.id} for ${row.id}: ${e instanceof Error ? e.message : e}`
      )
    );
  // Not awaited: the hire window closes now, and the hello lands in the chat it opens.
  void firstDay(row.id).catch((e: unknown) =>
    console.error(`[hire] first day for ${row.id}: ${e instanceof Error ? e.message : e}`)
  );
  return json(toProfile(row));
};
