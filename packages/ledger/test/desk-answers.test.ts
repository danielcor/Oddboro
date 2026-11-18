// What reaches the Odd when the owner answers something on the desk, held to
// its row in OWNER_ANSWERS and GOAL_ANSWERS: each ask kind's yes, no and
// send-back through the function the office answers it with, each way a task
// ends, and a goal's change of status. The office's own code on every
// migration, in an in-memory PGlite (pglite.ts). Run with
// `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { eq, max, sql } from 'drizzle-orm';
import {
  ASK_KINDS,
  asks,
  connectors,
  followUps,
  goals,
  grants,
  jobs,
  ledger,
  owner,
  staff,
  staffGoals,
  tasks,
  threads,
  type AskKind,
  type Step
} from '../src/schema.ts';
import { db } from './pglite.ts';
import { TEMP_IN_APPDATA } from './store-states.ts';

// The owner passed the Act check (act-check.test.ts), so a level ask's yes to
// Act goes through. No name, so the owner is still "the owner".
await db.insert(owner).values({ name: '', actCheckAt: new Date() });
// A home of the test's own, so a folder ask's folder can be given.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'desk-answers-')));
process.env.HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));
const {
  DECISIONS,
  approveCall,
  approveFilter,
  approveReply,
  ask: askRow,
  decideAsk,
  finishTask,
  giveFolder,
  giveTask,
  hire,
  officeActivity,
  raiseAsk,
  task,
  TaskResponseConflict,
  tickStep
} = await import('../src/office.ts');
const { ownerAnswers } = await import('../src/desk-answers.ts');
const { approveGoal, approveHire, approvePlan, updateGoal } = await import('../src/goals.ts');
const { handOff } = await import('../src/hand-offs.ts');
const { HAND_OFF_LIMIT } = await import('../src/threads.ts');
const { MANAGER_ROLE } = await import('../src/managers.ts');
const { GOAL_ANSWERS, OWNER_ANSWERS } = await import('../src/desk-answers.ts');
type AskAnswer = import('../src/desk-answers.ts').AskAnswer;
type Effect = import('../src/desk-answers.ts').Effect;
type Decision = import('../src/office.ts').Decision;

const odd = (id: string, name: string, role = 'Tester') => ({
  id,
  name,
  role,
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`
});
// Ada asks, Ivy is her colleague, and Max manages the office.
await db
  .insert(staff)
  .values([odd('ada', 'Ada'), odd('ivy', 'Ivy'), odd('max', 'Max', MANAGER_ROLE)]);
// Every office has Gmail (0009_google): mark it connected.
await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, 'gmail'));

/** A thread Ada leads, with `at` hand-offs used. */
async function thread(at = 0): Promise<number> {
  const [t] = await db
    .insert(threads)
    .values({ title: 'Plan the fair', hubId: 'ada', holderId: 'ada', handOffsUsed: at })
    .returning({ id: threads.id });
  return t.id;
}
async function aGoal(title: string): Promise<number> {
  const [g] = await db.insert(goals).values({ title }).returning({ id: goals.id });
  return g.id;
}

/**
 * Each grant, each tool an Odd uses without asking, and each Odd serving a
 * goal, keyed by the row, as what it shows an Odd got.
 */
async function held(): Promise<Map<string, string>> {
  const granted = await db.select().from(grants);
  const served = await db.select().from(staffGoals);
  return new Map([
    ...granted.map((g) => [`${g.staffId} ${g.connectorId}`, `grant:${g.staffId}`] as const),
    ...granted.flatMap((g) =>
      g.standing.map(
        (t) => [`${g.staffId} ${g.connectorId} ${t}`, `standing:${g.staffId}`] as const
      )
    ),
    ...served.map((s) => [`${s.staffId} goal ${s.goalId}`, `serves:${s.staffId}`] as const)
  ]);
}
type Mark = { followUp: number; notes: Map<number, string | null>; held: Map<string, string> };
async function markNow(): Promise<Mark> {
  const [last] = await db.select({ id: max(followUps.id) }).from(followUps);
  const notes = await db.select({ id: followUps.id, note: followUps.note }).from(followUps);
  return {
    followUp: last?.id ?? 0,
    notes: new Map(notes.map((f) => [f.id, f.note])),
    held: await held()
  };
}
/**
 * The follow-ups an answer reached since `mark`: each new one, and each one
 * waiting since before that an answer joined as a line (`offWorkAnswer`).
 */
async function since(mark: Mark) {
  const ups = await db.select().from(followUps).orderBy(followUps.id);
  return ups.filter((f) => f.id > mark.followUp || f.note !== mark.notes.get(f.id));
}
/**
 * What reached an Odd since `mark`: each follow-up new or joined as `<kind>:<odd>`, each
 * new grant as `grant:<odd>`, each tool it newly uses without asking as
 * `standing:<odd>`, and each Odd newly serving a goal as `serves:<odd>`.
 */
async function reached(mark: Mark): Promise<string[]> {
  const ups = await since(mark);
  const now = await held();
  return [
    ...ups.map((f) => `${f.kind}:${f.staffId}`),
    ...[...now].filter(([key]) => !mark.held.has(key)).map(([, shown]) => shown)
  ].sort();
}

/** Ada's `answered` runs an answer reached since `mark`. */
const heard = async (mark: Mark) =>
  (await since(mark)).filter((f) => f.staffId === 'ada' && f.kind === 'answered');

/** The effects a cell names, as the office reads them. */
const effectsOf = (cell: AskAnswer[Decision]): readonly Effect[] =>
  cell === 'refused' ? [] : 'by' in cell ? cell.then : cell;
const cellOf = (kind: AskKind, decision: Decision) =>
  (OWNER_ANSWERS.ask[kind] as AskAnswer)[decision];

/**
 * Each answer pinned by hand, so a wrong cell in OWNER_ANSWERS fails here
 * rather than moving the office and its test together: the cell as written,
 * and what reaches an Odd when the ask was raised on a thread and on none
 * (left out for a kind always raised on one). An answer to the usage window's
 * ask changes nothing an Odd sees on a no, so only its cell can hold it.
 */
type Pin = { cell: AskAnswer[Decision]; onThread: string[]; onNone?: string[] };
// A no with a reason on no work: the denied run carries the answer, so no answered run goes too.
const NO: Pin = {
  cell: ['answer_back', 'denied_lesson'],
  onThread: ['denied:ada', 'resume:ada'],
  onNone: ['denied:ada']
};
const REWORK: Pin = { cell: ['rework'], onThread: ['rework:ada'], onNone: ['rework:ada'] };
const REFUSED: Pin = { cell: 'refused', onThread: [] };
const PINNED: Record<AskKind, Record<Decision, Pin>> = {
  approval: {
    approve: { cell: ['carry_out'], onThread: ['carry_out:ada'], onNone: ['carry_out:ada'] },
    deny: NO,
    iterate: REWORK
  },
  // Gmail is connected already, so the work that waited on it starts at once.
  access: {
    approve: {
      cell: ['grant_access'],
      onThread: ['carry_out:ada', 'grant:ada'],
      onNone: ['carry_out:ada', 'grant:ada']
    },
    deny: NO,
    iterate: REWORK
  },
  hire: {
    approve: {
      cell: { by: 'Approve a hire by hiring', then: ['answer_back'] },
      onThread: ['resume:ada'],
      onNone: ['answered:ada']
    },
    deny: NO,
    iterate: REWORK
  },
  reply: {
    approve: {
      cell: {
        by: 'Send the reply, or save it to Gmail drafts',
        then: ['answer_back']
      },
      onThread: ['resume:ada'],
      onNone: ['answered:ada']
    },
    deny: NO,
    iterate: REWORK
  },
  filter: {
    approve: {
      cell: {
        by: 'Create the filter from its card on the desk',
        then: ['answer_back']
      },
      onThread: ['resume:ada'],
      onNone: ['answered:ada']
    },
    deny: NO,
    iterate: REWORK
  },
  // The folder went to Ada with the yes, so the work that waited on it starts.
  folder: {
    approve: {
      cell: { by: 'Give the folder from its card on the desk', then: ['give_folder'] },
      onThread: ['carry_out:ada'],
      onNone: ['carry_out:ada']
    },
    deny: NO,
    iterate: REWORK
  },
  // The switches went to Ada with the yes, so the work that waited on them starts.
  switch: {
    approve: { cell: ['turn_on'], onThread: ['carry_out:ada'], onNone: ['carry_out:ada'] },
    deny: NO,
    iterate: REWORK
  },
  // The level went to Ada with the yes, so the work that waited on it starts.
  level: {
    approve: { cell: ['grant_setting'], onThread: ['carry_out:ada'], onNone: ['carry_out:ada'] },
    deny: NO,
    iterate: REWORK
  },
  // The office tools went to Ada with the yes, so the work that waited on them starts.
  office_tool: {
    approve: { cell: ['grant_setting'], onThread: ['carry_out:ada'], onNone: ['carry_out:ada'] },
    deny: NO,
    iterate: REWORK
  },
  // The office made the call with the yes, so the Odd carries on with what it returned.
  call: {
    approve: {
      cell: { by: 'Approve the call from its card on the desk', then: ['carry_out'] },
      onThread: ['carry_out:ada'],
      onNone: ['carry_out:ada']
    },
    deny: NO,
    iterate: REWORK
  },
  goal: {
    approve: {
      cell: ['approval_work', 'answer_back'],
      onThread: ['goal:max', 'resume:ada'],
      onNone: ['goal:max']
    },
    deny: NO,
    iterate: REWORK
  },
  // On its goal's thread, which Max leads; the plan's part makes Ivy serve the goal.
  plan: {
    approve: { cell: ['approval_work', 'answer_back'], onThread: ['resume:max', 'serves:ivy'] },
    deny: { cell: ['answer_back', 'denied_lesson'], onThread: ['denied:ada', 'resume:max'] },
    iterate: { cell: ['rework'], onThread: ['rework:ada'] }
  },
  hand_offs: {
    approve: { cell: ['start_held', 'answer_hand_offs'], onThread: ['hand_off:ivy', 'resume:ada'] },
    deny: { cell: ['answer_hand_offs', 'denied_lesson'], onThread: ['denied:ada', 'resume:ada'] },
    iterate: REFUSED
  },
  window: {
    approve: { cell: ['answer_window'], onThread: ['resume:ada'] },
    deny: { cell: ['answer_window'], onThread: [] },
    iterate: REFUSED
  },
  // Ada asks about another Odd, so the one that leaves or comes back is never Ada.
  remove: {
    approve: {
      cell: ['answer_back', 'odd_leaves'],
      onThread: ['resume:ada'],
      onNone: ['answered:ada']
    },
    deny: NO,
    iterate: REFUSED
  },
  bring_back: {
    approve: {
      cell: ['answer_back', 'odd_returns'],
      onThread: ['resume:ada'],
      onNone: ['answered:ada']
    },
    deny: NO,
    iterate: REFUSED
  },
  // The office raises it on no thread, and a yes owes the job its runs: no Odd hears of it.
  catch_up: {
    approve: { cell: ['catch_up'], onThread: [] },
    deny: { cell: [], onThread: [] },
    iterate: REFUSED
  },
  // The yes puts the tool on Ada's grant, and the answer goes back as any ask's does.
  standing: {
    approve: {
      cell: ['give_standing', 'answer_back'],
      onThread: ['resume:ada', 'standing:ada'],
      onNone: ['answered:ada', 'standing:ada']
    },
    deny: NO,
    iterate: REFUSED
  }
};

type Raised = { id: number };
/** A new Odd for one remove or bring_back ask, at work or gone, so each ask names its own. */
async function another(gone: boolean): Promise<string> {
  const id = `odd-${++raised}`;
  await db.insert(staff).values({ ...odd(id, `Odd ${raised}`), leftAt: gone ? new Date() : null });
  return id;
}
/** Makes each email, filter and folder asked for its own, as the office refuses a second of one. */
let raised = 0;
/** An open ask of each kind, raised as the office raises it, on a thread of Ada's or on none. */
const raise: Record<AskKind, (onThread: boolean) => Promise<Raised>> = {
  approval: async (on) => {
    const threadId = on ? await thread() : undefined;
    const { ask } = await raiseAsk('ada', {
      title: 'Book the hall',
      why: 'w',
      ifApproved: 'i',
      threadId
    });
    return { id: ask.id };
  },
  access: async (on) => {
    const threadId = on ? await thread() : undefined;
    const { ask } = await raiseAsk('ada', {
      title: 'Read Gmail',
      why: 'w',
      ifApproved: 'i',
      access: { connector: 'gmail', level: 'read' },
      threadId
    });
    await db.delete(grants);
    return { id: ask.id };
  },
  hire: async (on) => {
    const threadId = on ? await thread() : undefined;
    const { ask } = await raiseAsk('ada', {
      title: 'Hire a baker',
      why: 'w',
      ifApproved: 'i',
      hire: {
        name: 'Bo',
        role: 'Baker',
        permission: 'draft',
        remit: 'Bakes.',
        jobDescriptionFile: 'baker.md'
      },
      threadId
    });
    return { id: ask.id };
  },
  goal: async (on) => {
    const threadId = on ? await thread() : undefined;
    const { ask } = await raiseAsk('ada', {
      title: 'Run the fair',
      why: 'w',
      ifApproved: 'i',
      kind: 'goal',
      goal: { title: `Run the fair ${Math.random()}`, horizon: 'ongoing', area: 'home' },
      threadId
    });
    return { id: ask.id };
  },
  // A plan always goes on its goal's one thread, which the manager leads.
  plan: async () => {
    const goalId = await aGoal(`Bake sale ${Math.random()}`);
    const { ask } = await raiseAsk('ada', {
      title: 'Plan the bake sale',
      why: 'w',
      ifApproved: 'i',
      kind: 'plan',
      plan: { goalId, items: [{ kind: 'assign', staff: 'ivy', part: 'Bake' }] }
    });
    return { id: ask.id };
  },
  // Past the round's limit, Ada's next hand-off to Ivy waits for the owner.
  hand_offs: async () => {
    const id = await thread(HAND_OFF_LIMIT);
    const r = await handOff({
      from: 'ada',
      to: 'ivy',
      work: { title: 'Ice the cakes', brief: 'Ice them.' },
      thread: { id }
    });
    assert.ok('asked' in r, JSON.stringify(r));
    return { id: r.asked };
  },
  // The usage window's ask holds a thread of Ada's until the owner answers.
  window: async () => {
    const [a] = await db
      .insert(asks)
      .values({ staffId: 'max', kind: 'window', title: 'Keep going?', why: 'w', ifApproved: 'i' })
      .returning({ id: asks.id });
    const id = await thread();
    // Held until the window resets, as the office holds it: a hold always has its reset time.
    await db
      .update(threads)
      .set({ heldBy: a.id, resumeAt: new Date(Date.now() + 3_600_000) })
      .where(eq(threads.id, id));
    return { id: a.id };
  },
  // A yes turns the switch on, so each ask starts with it off.
  switch: async (on) => {
    const threadId = on ? await thread() : undefined;
    await db.update(staff).set({ web: false }).where(eq(staff.id, 'ada'));
    const { ask } = await raiseAsk('ada', {
      kind: 'switch',
      title: 'Turn on Browse the web',
      why: 'w',
      ifApproved: 'i',
      switches: ['web'],
      threadId
    });
    return { id: ask.id };
  },
  // A yes raises Ada, so each ask starts with her at Draft.
  level: async (on) => {
    const threadId = on ? await thread() : undefined;
    await db.update(staff).set({ permission: 'draft' }).where(eq(staff.id, 'ada'));
    const { ask } = await raiseAsk('ada', {
      kind: 'level',
      title: 'Raise Ada from Draft to Act',
      why: 'w',
      ifApproved: 'i',
      level: 'act',
      threadId
    });
    return { id: ask.id };
  },
  // A yes turns the tool on, so each ask starts with Ada holding none.
  office_tool: async (on) => {
    const threadId = on ? await thread() : undefined;
    await db.update(staff).set({ tools: [] }).where(eq(staff.id, 'ada'));
    const { ask } = await raiseAsk('ada', {
      kind: 'office_tool',
      title: 'Turn on Office report',
      why: 'w',
      ifApproved: 'i',
      officeTools: ['office_report'],
      threadId
    });
    return { id: ask.id };
  },
  reply: async (on) => {
    const threadId = on ? await thread() : undefined;
    const { ask } = await raiseAsk('ada', {
      kind: 'reply',
      title: 'Reply to Nate',
      why: 'w',
      ifApproved: 'i',
      reply: {
        inReplyTo: `m-${++raised}`,
        to: ['nate@example.com'],
        cc: [],
        subject: 'Re: Lunch',
        body: 'Yes.',
        summary: 'Nate asks about lunch.'
      },
      threadId
    });
    return { id: ask.id };
  },
  filter: async (on) => {
    const threadId = on ? await thread() : undefined;
    const { ask } = await raiseAsk('ada', {
      kind: 'filter',
      title: 'File the newsletters',
      why: 'w',
      ifApproved: 'i',
      filter: {
        criteria: { from: `news-${++raised}@shop.example.com` },
        action: { skipInbox: true },
        summary: 'A newsletter every day.'
      },
      threadId
    });
    return { id: ask.id };
  },
  folder: async (on) => {
    const threadId = on ? await thread() : undefined;
    const path = join(HOME, `Taxes-${++raised}`);
    mkdirSync(path);
    const { ask } = await raiseAsk('ada', {
      kind: 'folder',
      title: 'Read the taxes',
      why: 'w',
      ifApproved: 'i',
      folder: { path, level: 'read' },
      threadId
    });
    return { id: ask.id };
  },
  call: async (on) => {
    const threadId = on ? await thread() : undefined;
    const { ask } = await raiseAsk('ada', {
      kind: 'call',
      title: 'Use capture in Notes',
      why: 'w',
      ifApproved: 'i',
      call: { connector: 'notes', tool: 'capture', arguments: { n: ++raised } },
      threadId
    });
    return { id: ask.id };
  },
  remove: async (on) => {
    const threadId = on ? await thread() : undefined;
    const odd = await another(false);
    const { ask } = await raiseAsk('ada', {
      kind: 'remove',
      odd,
      title: `Let ${odd} go`,
      why: 'w',
      ifApproved: 'i',
      threadId
    });
    return { id: ask.id };
  },
  bring_back: async (on) => {
    const threadId = on ? await thread() : undefined;
    const odd = await another(true);
    const { ask } = await raiseAsk('ada', {
      kind: 'bring_back',
      odd,
      title: `Bring ${odd} back`,
      why: 'w',
      ifApproved: 'i',
      threadId
    });
    return { id: ask.id };
  },
  // Ada holds Gmail at write, and asks to use one tool of it without asking:
  // a tool of its own, since the office refuses a second ask that covers one.
  standing: async (on) => {
    const threadId = on ? await thread() : undefined;
    await db
      .insert(grants)
      .values({ staffId: 'ada', connectorId: 'gmail', level: 'act' })
      .onConflictDoUpdate({
        target: [grants.staffId, grants.connectorId],
        set: { level: 'act' }
      });
    const { ask } = await raiseAsk('ada', {
      kind: 'standing',
      title: 'Use a tool without asking',
      why: 'w',
      ifApproved: 'i',
      standing: { connector: 'gmail', tools: [`stage_${++raised}`] },
      threadId
    });
    return { id: ask.id };
  },
  // The office's own ask, as askToCatchUp raises it, for a job of Ada's.
  catch_up: async () => {
    const [j] = await db
      .insert(jobs)
      .values({
        staffId: 'ada',
        name: 'Count the cakes',
        instructions: 'Count them.',
        schedule: { every: 'day', at: '09:00' },
        missed: 'record'
      })
      .returning({ id: jobs.id });
    const [a] = await db
      .insert(asks)
      .values({
        staffId: 'ada',
        kind: 'catch_up',
        title: 'Fill 11 missed periods?',
        why: 'w',
        ifApproved: 'i',
        catchUp: { jobId: j.id, times: ['2026-11-01T14:00:00.000Z'] }
      })
      .returning({ id: asks.id });
    return { id: a.id };
  }
};
/** The owner's decision, through the function the office answers each with. */
async function answer(
  kind: AskKind,
  decision: Decision,
  id: number,
  reason: string | null
): Promise<void> {
  const cell = cellOf(kind, decision);
  const asked = await askRow(id);
  const at = new Date().toISOString();
  if (decision === 'approve' && asked?.reply)
    await approveReply(id, { ...asked.reply, sent: { action: 'send', at, gmailId: 'g' } });
  else if (decision === 'approve' && asked?.filter)
    await approveFilter(id, { ...asked.filter, created: { at, gmailId: 'g', tidied: 0 } });
  else if (decision === 'approve' && asked?.call)
    await approveCall(id, { ...asked.call, result: { ok: true, text: 'done', at } });
  else if (decision === 'approve' && asked?.folder) {
    const done = await giveFolder(id, asked.folder.path, asked.folder.level, reason);
    assert.ok('given' in done, JSON.stringify(done));
  } else if (decision === 'approve' && typeof cell === 'object' && 'by' in cell) {
    // As the hire route does: hire the Odd, then approve the ask with it.
    const bo = await hire({
      name: 'Bo',
      role: 'Baker',
      variant: 'a',
      portrait: 'a',
      room: 'workspace',
      permission: 'draft',
      remit: 'Bakes.',
      desk: 'You are Bo.'
    });
    await approveHire(id, bo.id);
  } else if (decision === 'approve' && kind === 'goal') await approveGoal(id, reason);
  else if (decision === 'approve' && kind === 'plan') await approvePlan(id, [0], reason);
  else await decideAsk(id, decision, reason);
}

test("every ask kind's yes, no and send-back has the row pinned here, and reaches the Odd as pinned, on a thread and on none", async (t) => {
  for (const kind of ASK_KINDS)
    for (const decision of DECISIONS) {
      // A yes to a folder ask gives a folder under the temp folder.
      if (kind === 'folder' && decision === 'approve' && TEMP_IN_APPDATA) {
        t.diagnostic(`left out a folder ask's yes: ${TEMP_IN_APPDATA}`);
        continue;
      }
      const pin = PINNED[kind][decision];
      assert.deepEqual(cellOf(kind, decision), pin.cell, `${kind} ${decision}`);
      const places = pin.onNone ? [true, false] : [true];
      for (const onThread of places) {
        const where = `${kind} ${decision} ${onThread ? 'on a thread' : 'on none'}`;
        const want = onThread ? pin.onThread : pin.onNone;
        const { id } = await raise[kind](onThread);
        const mark = await markNow();
        if (pin.cell === 'refused')
          await assert.rejects(answer(kind, decision, id, 'Because.'), /Say yes or no/, where);
        else await answer(kind, decision, id, 'Because.');
        assert.deepEqual(await reached(mark), want, where);
      }
    }
});

/**
 * Each answer that starts no run of its own when given with no reason. On an
 * ask raised on no thread, the answer itself is the only word the Odd gets.
 */
const NO_RUN_OF_ITS_OWN: readonly (readonly [AskKind, Decision])[] = [
  ['reply', 'approve'],
  ['filter', 'approve'],
  ['hire', 'approve'],
  ['approval', 'deny'],
  ['access', 'deny'],
  ['hire', 'deny'],
  ['goal', 'deny'],
  ['reply', 'deny'],
  ['filter', 'deny'],
  ['folder', 'deny'],
  ['switch', 'deny'],
  ['level', 'deny'],
  ['office_tool', 'deny'],
  ['call', 'deny'],
  ['remove', 'approve'],
  ['remove', 'deny'],
  ['bring_back', 'approve'],
  ['bring_back', 'deny'],
  ['standing', 'deny']
];

test('an answer with no run of its own, a no with no reason among them, to an ask raised on no thread wakes the Odd that raised it once with the answer, and no row is left to name NEW-1715', async () => {
  for (const [kind, decision] of NO_RUN_OF_ITS_OWN) {
    const where = `${kind} ${decision}`;
    const { id } = await raise[kind](false);
    const mark = await markNow();
    await answer(kind, decision, id, null);
    const toAda = (await reached(mark)).filter((r) => r.endsWith(':ada'));
    assert.deepEqual(toAda, ['answered:ada'], where);
    const [woke] = await heard(mark);
    const title = (await askRow(id))?.title ?? '';
    assert.ok(woke?.note?.includes(`"${title}"`), `${where}: ${woke?.note}`);
  }
  const naming = ASK_KINDS.flatMap((kind) =>
    DECISIONS.filter((d) =>
      effectsOf(cellOf(kind, d)).some((e) => typeof e === 'object' && e.none === 'NEW-1715')
    ).map((d) => `${kind} ${d}`)
  );
  assert.deepEqual(naming, []);
});

test("a yes to a hire raised on no work wakes the Odd that proposed it, once, with the owner's note", async () => {
  const { id } = await raise.hire(false);
  // As the hire route does when the owner hired a persona in place of the proposed Odd.
  const bo = await hire({
    name: 'Bo',
    role: 'Baker',
    variant: 'a',
    portrait: 'a',
    room: 'workspace',
    permission: 'draft',
    remit: 'Bakes.',
    desk: 'You are Bo.'
  });
  const mark = await markNow();
  await approveHire(id, bo.id, 'Bo came from the personas instead.');
  assert.deepEqual(
    (await reached(mark)).filter((r) => r.endsWith(':ada')),
    ['answered:ada']
  );
  const [woke] = await heard(mark);
  assert.ok(
    woke?.note?.includes('approved "Hire a baker": Bo came from the personas instead.'),
    `${woke?.note}`
  );
});

test("a plan yes's hire asks, job changes and owner task commit with its answer, so one that fails leaves the plan open and wakes nobody", async () => {
  const goalId = await aGoal('Sell flour');
  // Two jobs of one name, as an Odd can have until the owner renames one, so changing it fails.
  const weigh = {
    staffId: 'ivy',
    name: 'Weigh flour',
    instructions: 'Weigh it.',
    schedule: { every: 'day', at: '09:00' } as const
  };
  await db.insert(jobs).values([weigh, weigh]);
  const { ask } = await raiseAsk('ada', {
    title: 'Plan the flour sale',
    why: 'w',
    ifApproved: 'i',
    kind: 'plan',
    plan: {
      goalId,
      items: [
        {
          kind: 'hire',
          hire: {
            name: 'Bo',
            role: 'Baker',
            permission: 'draft',
            remit: 'Bakes.',
            jobDescriptionFile: 'baker.md'
          },
          part: 'Bakes the samples'
        },
        {
          kind: 'assign',
          staff: 'ivy',
          part: 'Weighs it',
          editJob: { name: weigh.name, instructions: 'Weigh it twice.' }
        }
      ],
      ownerSteps: ['Buy the sacks']
    }
  });
  const mark = await markNow();
  await assert.rejects(approvePlan(ask.id, [0, 1], null), /Two jobs have that name/);
  assert.equal((await askRow(ask.id))?.status, 'open');
  assert.deepEqual(await reached(mark), []);
  const hires = await db.select().from(asks).where(eq(asks.kind, 'hire'));
  assert.deepEqual(
    hires.filter((h) => h.hire?.goal?.id === goalId),
    []
  );
});

// The lead's run reads the plan's hire asks, so they are written in the yes's
// transaction, before that run is queued. The other test fails the plan on a job
// change, which the yes's transaction makes before any hire ask.
test('a plan yes whose hire ask cannot be written leaves the plan open, writes no hire ask and queues no run for its lead', async () => {
  const goalId = await aGoal('Sell rye');
  const { ask } = await raiseAsk('ada', {
    title: 'Plan the rye sale',
    why: 'w',
    ifApproved: 'i',
    kind: 'plan',
    plan: {
      goalId,
      items: [
        {
          kind: 'hire',
          hire: {
            name: 'Cy',
            role: 'Baker',
            permission: 'draft',
            remit: 'Bakes.',
            jobDescriptionFile: 'baker.md'
          },
          part: 'Bakes the loaves'
        }
      ]
    }
  });
  await db.execute(
    sql.raw(
      `create function refuse_hire() returns trigger as $$ begin if new.kind = 'hire' then raise exception 'hire refused'; end if; return new; end $$ language plpgsql`
    )
  );
  await db.execute(
    sql.raw(
      'create trigger refuse_hire before insert on asks for each row execute function refuse_hire()'
    )
  );
  const mark = await markNow();
  try {
    await assert.rejects(approvePlan(ask.id, [0], null), /Failed query: insert into "asks"/);
  } finally {
    await db.execute(sql.raw('drop trigger refuse_hire on asks'));
    await db.execute(sql.raw('drop function refuse_hire()'));
  }
  assert.equal((await askRow(ask.id))?.status, 'open');
  assert.deepEqual(await reached(mark), []);
  const hires = await db.select().from(asks).where(eq(asks.kind, 'hire'));
  assert.deepEqual(
    hires.filter((h) => h.hire?.goal?.id === goalId),
    []
  );
});

// A transition in its own transaction runs again when Postgres ends it to
// break a deadlock. The plan's write keeps the hire asks it raised in memory,
// so a second run must not hand back the first run's, which rolled back.
test('a plan yes that Postgres ends once to break a deadlock gives back only the hire asks it wrote', async () => {
  const goalId = await aGoal('Sell spelt');
  const hire = (name: string) => ({
    kind: 'hire' as const,
    hire: {
      name,
      role: 'Baker',
      permission: 'draft' as const,
      remit: 'Bakes.',
      jobDescriptionFile: 'baker.md'
    },
    part: 'Bakes the loaves'
  });
  const { ask } = await raiseAsk('ada', {
    title: 'Plan the spelt sale',
    why: 'w',
    ifApproved: 'i',
    kind: 'plan',
    plan: { goalId, items: [hire('Dot'), hire('Eli')] }
  });
  // A sequence is not rolled back, so only the first run is ended.
  const run = async (statements: string[]) => {
    for (const statement of statements) await db.execute(sql.raw(statement));
  };
  await run([
    'create sequence deadlock_once',
    `create function deadlock_once() returns trigger as $$ begin if old.kind = 'plan' and new.status <> 'open' and nextval('deadlock_once') = 1 then raise exception 'deadlock detected' using errcode = 'deadlock_detected'; end if; return new; end $$ language plpgsql`,
    'create trigger deadlock_once before update on asks for each row execute function deadlock_once()'
  ]);
  let given: number[];
  try {
    given = (await approvePlan(ask.id, [0, 1], null)).hires.map((h) => h.id);
  } finally {
    await run([
      'drop trigger deadlock_once on asks',
      'drop function deadlock_once()',
      'drop sequence deadlock_once'
    ]);
  }
  assert.equal((await askRow(ask.id))?.status, 'approved');
  const written = (await db.select().from(asks).where(eq(asks.kind, 'hire')))
    .filter((h) => h.hire?.goal?.id === goalId)
    .map((h) => h.id);
  assert.equal(written.length, 2);
  assert.deepEqual(given, written);
});

test("a done or dropped task, a done task with no Odd, and a goal's pause, met or drop have the rows pinned here and reach the Odd as pinned, and a none names its Linear row", async () => {
  assert.deepEqual(OWNER_ANSWERS.task, {
    done: {
      fromAccess: ['carry_out', 'wake_parked'],
      other: ['task_done', 'wake_parked'],
      noOdd: ['wake_parked']
    },
    dropped: ['answer_back', 'wake_parked']
  });
  const steps: Step[] = [{ text: 'Do it', done: false }];
  // A connect task from Ada's access ask.
  const { ask: access } = await raiseAsk('ada', {
    title: 'Read Gmail',
    why: 'w',
    ifApproved: 'i',
    access: { connector: 'gmail', level: 'read' }
  });
  const [connect] = await db
    .insert(tasks)
    .values({ staffId: 'ada', askId: access.id, title: 'Connect Gmail', why: 'w', steps })
    .returning();
  let mark = await markNow();
  await finishTask(connect.id, true, null);
  assert.deepEqual(await reached(mark), ['carry_out:ada']);

  const other = await giveTask('ada', { title: 'Pick a blue', why: 'w', steps: ['Pick one'] });
  mark = await markNow();
  await finishTask(other.id, true, 'Navy.');
  assert.deepEqual(await reached(mark), ['task_done:ada']);

  const [nobodys] = await db
    .insert(tasks)
    .values({ title: 'Water the plants', why: 'w', steps })
    .returning();
  mark = await markNow();
  await finishTask(nobodys.id, true, null);
  assert.deepEqual(await reached(mark), []);

  // A dropped task goes back to the thread it was given on, and on none wakes the Odd that gave it.
  for (const onThread of [true, false]) {
    const threadId = onThread ? await thread() : undefined;
    const t = await giveTask('ada', {
      title: 'Call the baker',
      why: 'w',
      steps: ['Call'],
      threadId
    });
    mark = await markNow();
    await finishTask(t.id, false, 'Not needed.');
    const want = onThread ? ['resume:ada'] : ['answered:ada'];
    assert.deepEqual(await reached(mark), want, onThread ? 'on a thread' : 'on none');
  }

  // Ada serves a goal the owner pauses, meets or drops: nothing reaches her.
  for (const status of ['paused', 'met', 'dropped'] as const) {
    const goalId = await aGoal(`Fair ${status}`);
    await db.insert(staffGoals).values({ staffId: 'ada', goalId, part: 'All of it' });
    mark = await markNow();
    await updateGoal(goalId, { status }, { owner: true });
    assert.deepEqual(await reached(mark), [], status);
    assert.ok(
      GOAL_ANSWERS[status].every((e) => /^NEW-\d+$/.test(e.none)),
      status
    );
  }
});

test('dropping a task given on no work wakes the Odd that gave it, once, with the drop and the note', async () => {
  const t = await giveTask('ada', { title: 'Book the van', why: 'w', steps: ['Book it'] });
  const mark = await markNow();
  assert.equal(await finishTask(t.id, false, 'not now'), true);
  assert.deepEqual(await reached(mark), ['answered:ada']);
  const woke = await heard(mark);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].kind, 'answered');
  assert.match(woke[0].note ?? '', /dropped "Book the van": not now/);
});

// The office's task route shows the owner this error's words; a false would read
// as "This task was already answered" and hide that the response is not saved.
test('finishing a task whose response the owner has not saved rejects as a response conflict, and the task stays open', async () => {
  const t = await giveTask('ada', {
    title: 'Word the notice',
    why: 'w',
    steps: ['Read it'],
    response: 'Draft'
  });
  await assert.rejects(finishTask(t.id, true, null, { responseVersion: 1 }), (e: unknown) => {
    assert.ok(e instanceof TaskResponseConflict, String(e));
    assert.equal(e.message, 'Review and save your response before marking this task done.');
    return true;
  });
  assert.equal((await task(t.id))?.status, 'open');
});

test("only a choice step's answer counts as what the owner said", () => {
  const steps: Step[] = [
    {
      text: 'Paste the key',
      done: true,
      action: { kind: 'secret', connector: 'c', name: 'n' },
      answer: 'From AWS: the-secret'
    },
    { text: 'Pick one', done: true, action: { kind: 'choice', options: ['Navy'] }, answer: 'Navy' }
  ];
  assert.deepEqual(ownerAnswers(steps), [{ step: 'Pick one', answer: 'Navy' }]);
});

test("the office report says what the owner answered on a finished task, and a finished task's ledger row opens with it", async () => {
  const since = new Date();
  const answered = await giveTask('ada', {
    title: 'Choose a shade',
    why: 'w'.repeat(600),
    steps: [{ text: 'Pick one', done: false, action: { kind: 'choice', options: ['Navy'] } }]
  });
  await tickStep(answered.id, 0, 'Navy');
  await finishTask(answered.id, true, null);
  const silent = await giveTask('ada', { title: 'Sweep the yard', why: 'w', steps: ['Sweep'] });
  await finishTask(silent.id, true, null);

  const { done } = (await officeActivity(since)).tasksForOwner;
  assert.equal(done.find((t) => t.title === 'Choose a shade')?.answer, 'Pick one: Navy');
  const none = done.find((t) => t.title === 'Sweep the yard');
  assert.ok(none && !('answer' in none), 'a task with nothing said has no answer key');

  const [row] = await db.select().from(ledger).where(eq(ledger.taskId, answered.id));
  assert.ok(row.body?.startsWith('Pick one Navy'), row.body ?? '');
});
