// The owner's answer to an ask and to a report, what each answer starts, held
// calls, and taking an ask or a task off the desk.
import { inArray } from 'drizzle-orm';
import { db } from './db.ts';
import type { Tx } from './threads.ts';
import { fixedError } from './errors.ts';
import {
  asks,
  type FolderRequest,
  type HeldCall,
  type ReplyDraft,
  type AskKind
} from './schema.ts';
import { bringBack, leavingRefused, removeOdd } from './leaving.ts';
import { giveStanding } from './standing.ts';
import { oweCatchUp } from './missed-runs.ts';
import { levelAtMost, type FolderAccess } from './access-words.ts';
import type { GmailFilter } from './filter-words.ts';
import { type AskEffect } from './desk-answers.ts';
import type { AskRow, ReportRow } from './office.ts';
import { changeLevel, changeOwnTools, changeTools, staffer } from './office-staff.ts';
import { changeFolder, switchesOff, checkFolder } from './office-folders.ts';
import { record } from './office-ledger.ts';
import { raiseAsk, ask, type Decision, carryOutTogether } from './office-asks.ts';
import { grantAccess } from './office-access.ts';
import { readReport, report } from './office-desk.ts';
import { transitionWork } from './work/apply.ts';
import type { AskEffects } from './work/events.ts';
import type { PerKindInTx } from './work/snapshot.ts';
import { ANSWERED_ALREADY, callResultText, effectsOf } from './work/answers.ts';

export { callResultText };

/**
 * The owner's decision. Approving an access ask grants it and gives the owner the steps
 * to connect; approving any other ask but a hire sends the staffer to carry it
 * out. A hire is approved by hiring, from the hire window. Iterate sends it
 * back with what to change, and needs their words; an ask the office raised
 * itself takes a yes or a no only (`yesOrNo`). A yes to a level ask that
 * puts the Odd at Act takes the owner's choice for work another Odd hands it
 * (`actsOnHandOffs`); left out, the stored choice stays.
 */
export async function decideAsk(
  id: number,
  decision: Decision,
  reason: string | null,
  reportWhenDone = false,
  inChat = false,
  actsOnHandOffs?: boolean
): Promise<boolean> {
  return decide(id, decision, reason, { reportWhenDone, inChat, actsOnHandOffs });
}

/** What approving an ask means, done in the transaction that approves it. */
export type Approval = {
  /**
   * Writes only the entry knows, such as setting a goal: if one fails, the
   * ask stays open, and nothing is recorded or answered.
   */
  perKind?: PerKindInTx[];
  /** The owner answered on the ask's card in its Odd's chat: the run the answer starts replies there. */
  inChat?: boolean;
};

/**
 * Approve a goal, plan or hire ask, and do what approving it means in the
 * transaction that approves it, so the run the answer starts finds all of
 * it: the goal set, the plan's jobs, hire asks and owner task, or the hire
 * serving its goal. Nothing is done when the ask was no longer open, and that
 * returns false.
 */
export async function approveAsk(
  id: number,
  reason: string | null,
  approval: Approval
): Promise<boolean> {
  return decide(id, 'approve', reason, approval);
}

/**
 * The owner sent a reply ask's email, or saved it to Gmail drafts, and Gmail
 * took it: keep their final version with what Gmail did (`reply.sent`), and
 * approve the ask, so the answer goes back where it came from: to its work,
 * or, on no work, to the Odd as an `answered` run. Returns false when the ask
 * was no longer open.
 */
export async function approveReply(id: number, reply: ReplyDraft): Promise<boolean> {
  if (!reply.sent) throw new Error('A reply is approved only once Gmail took it');
  return decide(id, 'approve', null, { reply });
}

/**
 * The owner created a filter ask's Gmail filter, and Gmail took it: keep their
 * final version with what Gmail did (`filter.created`), and approve the ask,
 * so the answer goes back where it came from: to its work, or, on no work, to
 * the Odd as an `answered` run. Returns false when the ask was no longer open.
 */
export async function approveFilter(id: number, filter: GmailFilter): Promise<boolean> {
  if (!filter.created) throw new Error('A filter is approved only once Gmail made it');
  return decide(id, 'approve', null, { filter });
}

/**
 * The office made a call ask's held call on the owner's yes: keep what came
 * back (`call.result`) and approve the ask, which starts the Odd's carry-out
 * run with the result. Returns false when the ask was no longer open.
 */
export async function approveCall(id: number, call: HeldCall): Promise<boolean> {
  if (!call.result) throw new Error('A call is approved only once the office made it');
  return decide(id, 'approve', null, { call });
}

/** Where a held call lands: the run's Odd, and what its own asks carry. */
export type CallPlace = {
  staffId: string;
  /** The run's key, which a thread it is raised on keeps (`raiseAsk`). */
  run: string;
  handOffId?: number;
  threadId?: number;
  via?: string;
};

/**
 * An Odd at Draft called a tool that changes something: the gateway holds
 * the call and it goes on the desk as a `call` ask, showing the exact call,
 * with the Odd's own title and reason (`odd`). The title the office reads from
 * the call itself (`said`, Gmail's count of emails) comes first. The same call
 * still open is not raised twice: the Odd hears the one there.
 */
export async function raiseCall(
  place: CallPlace,
  call: HeldCall,
  service: string,
  odd: { title: string; why: string }
): Promise<{ ask: AskRow; already: boolean }> {
  const { ask, already } = await raiseAsk(place.staffId, {
    kind: 'call',
    title: `${call.said ?? odd.title} in ${service}`,
    why: odd.why,
    ifApproved: `The office makes this exact call to ${service}, and the work carries on with what it returns.`,
    call,
    handOffId: place.handOffId,
    threadId: place.threadId,
    via: place.via,
    run: place.run
  });
  return { ask, already };
}

/** Why the owner's Give access on a folder ask gave nothing, with the status the route answers. */
export type FolderNotGiven = { refused: string; status: 400 | 404 | 409 };

/** A folder `setFolder` refused while approving its ask: the approval rolls back. */
class FolderRefused extends Error {}

/**
 * Make the change a level or office tool ask asked for, in `tx`, with the
 * yes, or neither happens: the Settings tab's own change (`changeLevel`,
 * `changeTools`). A level the Odd already holds or passed stays as it is, so
 * a yes never undoes a higher level set since, and tools already on stay on;
 * either still starts the work. Nothing for any other kind, or when the Odd
 * is gone. A new kind fails the type check here until it says which. A raise
 * to Act takes the owner's choice for work another Odd hands it
 * (`actsOnHandOffs`). The answer's ledger lines come from `settingGranted`,
 * which the loader reads before the claim.
 */
async function grantSetting(tx: Tx, claimed: AskRow, actsOnHandOffs?: boolean): Promise<void> {
  switch (claimed.kind) {
    case 'level': {
      if (!claimed.level) throw fixedError('This ask names no level');
      const before = await staffer(claimed.staffId, tx);
      if (!before || levelAtMost(claimed.level, before.permission)) return;
      await changeLevel(tx, claimed.staffId, claimed.level, actsOnHandOffs);
      return;
    }
    case 'office_tool':
      if (!claimed.officeTools?.length) throw fixedError('This ask names no office tool');
      await changeTools(tx, claimed.staffId, claimed.officeTools, true);
      return;
    case 'approval':
    case 'access':
    case 'hire':
    case 'goal':
    case 'plan':
    case 'hand_offs':
    case 'window':
    case 'reply':
    case 'filter':
    case 'folder':
    case 'switch':
    case 'call':
    case 'remove':
    case 'bring_back':
    case 'catch_up':
    case 'standing':
      return;
    default:
      claimed.kind satisfies never;
  }
}

/**
 * The owner gives the folder a folder ask asked for, or a narrower one, at
 * the level they pick: `path` as typed or picked, checked as the Settings tab
 * checks it (`checkFolder`). The folder is given (`changeFolder`, as
 * `setFolder` does) in the transaction that approves the ask, so a refusal
 * leaves the ask open and the folder as it was. One ledger line, in the
 * Settings tab's words, and the approval starts the run that carries the ask
 * out, which finds the folder in its reach. A plain approve is refused
 * (`decide`). A whole drive or system files, which the owner can type there,
 * comes back as a `warning` and changes nothing until they accept it.
 */
export async function giveFolder(
  id: number,
  path: string,
  level: FolderAccess,
  reason: string | null = null,
  accept = false,
  inChat = false
): Promise<
  { given: { path: string; level: FolderAccess } } | { warning: string } | FolderNotGiven
> {
  const a = await ask(id);
  if (!a || a.kind !== 'folder' || !a.folder)
    return { refused: 'No such folder ask.', status: 404 };
  if (a.status !== 'open') return { refused: 'You already answered this ask.', status: 409 };
  const checked = checkFolder(path, accept);
  if ('refused' in checked) return { refused: checked.refused, status: 400 };
  if ('warning' in checked) return checked;
  const given = { path: checked.real, level };
  try {
    const done = await decide(id, 'approve', reason, { folder: { ...a.folder, given }, inChat });
    if (!done) return { refused: 'You already answered this ask.', status: 409 };
  } catch (e) {
    if (e instanceof FolderRefused) return { refused: e.message, status: 400 };
    throw e;
  }
  return { given };
}

/**
 * The owner's answer, or the office's no for an Odd that withdrew its ask,
 * through the work core (`askDecided`). A yes that moves an Odd is refused
 * first, so the ask stays open with the reason. False when the ask was
 * answered already; any other refusal is thrown with its words, which the
 * desk shows the owner. So is the error of what the answer does once it is
 * saved, such as a grant that fails (`carriesAnswer`): the ask stays answered.
 */
async function decide(
  id: number,
  decision: Decision,
  reason: string | null,
  o: Approval & {
    reportWhenDone?: boolean;
    /** A yes that puts the Odd at Act: the owner's choice for work another Odd hands it. */
    actsOnHandOffs?: boolean;
    reply?: ReplyDraft;
    filter?: GmailFilter;
    call?: HeldCall;
    folder?: FolderRequest;
    /**
     * The Odd that raised it left the office (`removeOdd`), or took it off
     * the desk: the office closes it as a no, with this line as the answer
     * that goes back, and no run reads it.
     */
    withdrawn?: string;
  }
): Promise<boolean> {
  const raised = await ask(id);
  if (decision === 'approve' && raised) {
    const move = oddMoveOf(raised.kind);
    const held = move && (await leavingRefused(LEAVING_CHECK[move], raised.odd));
    if (held) throw new Error(held);
  }
  const decided = await transitionWork({
    kind: 'askDecided',
    id,
    decision,
    reason,
    inChat: !!o.inChat,
    reportWhenDone: o.reportWhenDone,
    done: { reply: o.reply, filter: o.filter, call: o.call, folder: o.folder },
    withdrawn: o.withdrawn,
    actsOnHandOffs: o.actsOnHandOffs,
    perKind:
      raised && decision === 'approve'
        ? [...(o.perKind ?? []), ...yesInTx(raised, o.folder, o.actsOnHandOffs)]
        : [],
    effects: ASK_EFFECTS
  });
  if (!('refused' in decided)) return true;
  if (decided.refused === ANSWERED_ALREADY) return false;
  throw new Error(decided.refused);
}

/**
 * What a yes changes in the transaction that closes the ask, by its kind, so
 * a refusal leaves the ask open and nothing changed: the folder given, the
 * switches turned on, the level or office tools granted, the standing yes put
 * on the grant.
 */
function yesInTx(
  a: AskRow,
  folder: FolderRequest | undefined,
  actsOnHandOffs: boolean | undefined
): PerKindInTx[] {
  const given = a.kind === 'folder' ? folder?.given : undefined;
  const effects: PerKindInTx[] = [];
  if (given)
    effects.push({
      name: 'folder',
      run: async (tx) => {
        // `giveFolder` checked this path with the owner's Accept, so no warning comes back.
        const changed = await changeFolder(tx, a.staffId, given.path, given.level, {
          accept: true
        });
        if (changed && 'refused' in changed) throw new FolderRefused(changed.refused);
      }
    });
  // Only the switches still off, so one already on is never refused, as the Settings tab would refuse it.
  if (a.kind === 'switch')
    effects.push({
      name: 'switches',
      run: async (tx) => {
        const odd = await staffer(a.staffId, tx);
        if (!odd) return;
        const changed = await changeOwnTools(tx, a.staffId, {
          which: switchesOff(odd, a.switches ?? []),
          on: true
        });
        if (changed && 'refused' in changed)
          throw fixedError(
            "This Odd's tool cannot run commands here. Move it to another tool on its Settings tab first"
          );
      }
    });
  if (effectsOf(a.kind, 'approve').includes('grant_setting'))
    effects.push({
      name: 'setting',
      run: async (tx) => {
        await grantSetting(tx, a, actsOnHandOffs);
      }
    });
  if (effectsOf(a.kind, 'approve').includes('give_standing'))
    effects.push({
      name: 'standing',
      run: async (tx) => {
        await giveStanding(tx, a);
      }
    });
  return effects;
}

/** The I/O an answer does after its commit, as the office does it. */
const ASK_EFFECTS: AskEffects = {
  grantAccess,
  pointAsksAtConnector: async (ids, access) => {
    await db.update(asks).set({ access }).where(inArray(asks.id, ids));
  },
  carryOutTogether,
  oweCatchUp,
  removeOdd,
  bringBack
};

/**
 * What `leavingRefused` checks before a yes that moves an Odd, by the move.
 * Any kind whose yes makes that move gets the same check.
 */
const LEAVING_CHECK = {
  odd_leaves: 'remove',
  odd_returns: 'bring_back'
} as const satisfies Partial<
  Record<Extract<AskEffect, string>, Parameters<typeof leavingRefused>[0]>
>;

/** The move the owner's yes to an ask of this kind makes, from its row in `OWNER_ANSWERS`. */
function oddMoveOf(kind: AskKind): keyof typeof LEAVING_CHECK | undefined {
  return effectsOf(kind, 'approve').find(
    (e): e is keyof typeof LEAVING_CHECK => typeof e === 'string' && Object.hasOwn(LEAVING_CHECK, e)
  );
}

/**
 * The Odd that raised an open ask left the office, or took it off the desk
 * with its `withdraw` tool, or the usage window an ask was about reset
 * (`windowAsksDue`): the office closes it as a no, and `line` goes back
 * where the ask came from, to a hand-off's lead or the thread's hub. Nobody
 * reads it for a lesson. False when the owner answered it first.
 */
export async function withdrawAsk(id: number, line: string): Promise<boolean> {
  return decide(id, 'deny', line, { withdrawn: line });
}

/**
 * The Odd that gave the owner an open task left the office, or took the task
 * off the desk with its `withdraw` tool: the office drops it, and it ends as a
 * dropped task does, `line` going back where it came from. False when the
 * owner ended it first.
 */
export async function withdrawTask(id: number, line: string): Promise<boolean> {
  const ended = await transitionWork({
    kind: 'taskEnded',
    id,
    ended: 'withdrawn',
    note: line,
    inChat: false
  });
  if (!('refused' in ended)) return true;
  if (ended.refused === ANSWERED_ALREADY) return false;
  throw new Error(ended.refused);
}

/**
 * The owner replied in chat about a report: it leaves their desk, and the ledger
 * keeps what they said, so the staff can find how they judged it later.
 */
export async function replyToReport(id: number, note: string): Promise<ReportRow> {
  const r = await report(id);
  if (!r) throw fixedError('No such report');
  if (!r.readAt) await readReport(id);
  await record({
    kind: 'decision',
    actor: 'owner',
    title: `Feedback on: ${r.title}`,
    reason: note
  });
  return r;
}
