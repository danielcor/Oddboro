// One ask. GET adds the owner's closest past decisions, and the ask it reworks. POST
// is their decision: approve, deny, or iterate (send it back with what to
// change), with a reason, and whether a success should reach their desk too.
// Approving a goal ask sets the goal. Approving a plan takes the parts the owner ticked
// (`picks`) and answers with the hire asks it made, for the page to open.
// Approving an access ask answers with the connect task it made, if any, so the
// desk goes straight on to it. A reply is approved only by sending it or saving
// it (`reply/+server.ts`), a filter only by creating it (`filter/+server.ts`),
// and a folder ask only by giving the folder (`folder/+server.ts`). `chat`
// says the owner answered on the ask's card in its Odd's chat, so the run the
// answer starts replies there too. A yes to a level ask for Act takes the
// owner's choice for work another Odd hands that Odd (`actsOnHandOffs`).
import { error, json } from '@sveltejs/kit';
import {
  ActCheckNeeded,
  approveGoal,
  approvePlan,
  ask,
  decideAsk,
  DECISIONS,
  precedent,
  tasksFrom,
  type AskKind,
  type AskRow
} from '@oddboro/ledger';
import { OWNER_ANSWERS, type AskEffect } from '@oddboro/ledger/desk-answers';
import type { RequestHandler } from './$types';

type Yes = (typeof OWNER_ANSWERS.ask)[AskKind]['approve'];
/** The ask kinds whose yes does work of its own (`approval_work`) before the answer goes back. */
type WorksOnYes = {
  [K in AskKind]: (typeof OWNER_ANSWERS.ask)[K]['approve'] extends readonly (infer E)[]
    ? 'approval_work' extends E
      ? K
      : never
    : never;
}[AskKind];

const worksOnYes = (kind: AskKind): kind is WorksOnYes => {
  const yes: Yes = OWNER_ANSWERS.ask[kind].approve;
  return !('by' in yes) && (yes as readonly AskEffect[]).includes('approval_work');
};

/**
 * The work a yes does, one per kind whose row says `approval_work`, so a new
 * one fails the type check here until it says what approving it means.
 */
const APPROVAL_WORK: Record<
  WorksOnYes,
  (a: AskRow, reason: string | null, picks: unknown, inChat: boolean) => Promise<Response>
> = {
  goal: async (a, reason, _, inChat) => {
    await approveGoal(a.id, reason, inChat).catch((e: Error) => error(400, e.message));
    return json({ ok: true });
  },
  plan: async (a, reason, picks, inChat) => {
    const ticked = Array.isArray(picks)
      ? picks.filter((p): p is number => Number.isInteger(p))
      : [];
    const done = await approvePlan(a.id, ticked, reason, inChat).catch((e: Error) =>
      error(400, e.message)
    );
    return json({ ok: true, hires: done.hires });
  }
};

export const GET: RequestHandler = async ({ params }) => {
  const a = await ask(Number(params.id));
  if (!a) error(404, 'No such ask');
  return json({
    ask: a,
    precedent: await precedent(`${a.title}\n${a.why}`),
    revises: a.revises ? ((await ask(a.revises)) ?? null) : null
  });
};

export const POST: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => ({}))) as {
    decision?: unknown;
    reason?: unknown;
    report?: unknown;
    picks?: unknown;
    chat?: unknown;
    actsOnHandOffs?: unknown;
  };
  const decision = DECISIONS.find((d) => d === body.decision);
  if (!decision) error(400, `Say ${DECISIONS.slice(0, -1).join(', ')} or ${DECISIONS.at(-1)}`);
  const a = await ask(Number(params.id));
  if (!a) error(404, 'No such ask');
  if (a.status !== 'open') error(409, 'This ask was already answered');
  const yes: Yes = OWNER_ANSWERS.ask[a.kind].approve;
  if (decision === 'approve' && 'by' in yes) error(400, yes.by);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 2000) : '';
  const inChat = body.chat === true;
  if (decision === 'approve' && worksOnYes(a.kind)) {
    return APPROVAL_WORK[a.kind](a, reason || null, body.picks, inChat);
  }
  let decided;
  try {
    decided = await decideAsk(
      a.id,
      decision,
      reason || null,
      body.report === true,
      inChat,
      typeof body.actsOnHandOffs === 'boolean' ? body.actsOnHandOffs : undefined
    );
  } catch (e) {
    // A yes to Act waits for the owner's Act check, and the ask stays open.
    if (e instanceof ActCheckNeeded) error(409, e.message);
    error(400, e instanceof Error ? e.message : String(e));
  }
  if (!decided) error(409, 'This ask was already answered');
  if (decision === 'approve' && a.access) {
    const task = (await tasksFrom(a.staffId)).find((t) => t.askId === a.id && t.status === 'open');
    return json({ ok: true, task: task ?? null });
  }
  return json({ ok: true });
};
