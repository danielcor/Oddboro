// Which level a follow-up's run works at, by where the work came from, in an
// office under test (office-under-test.ts). Work that serves a colleague's
// hand-off runs at Draft at most whatever its kind, even after a yes that
// raised the Odd's own level or tools, so a colleague's words never stand in
// for the owner's yes. The one exception is the carry-out of an approval ask:
// the owner said yes to that exact action, so it runs at the Odd's level.
// The owner can let an Odd act on its own on work from colleagues
// (`actsOnHandOffs`): every state runs twice, with that choice off and on, and
// the choice lifts exactly the states marked `lifted`. A no's lesson, a lead's
// pick-up and a thread picked back up stay at Draft either way. Every Odd here
// is at Act when its run starts, so a run held to Draft shows it. A standing
// yes holds in a colleague's hand-off, and in the lead's pick-up of a result,
// only with the choice on. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Level } from '@oddboro/ledger';
import { L, chatOf, gave, odd, runOf, startedBy, type Gave } from './office-under-test.ts';

// The owner passed the Act check (the ledger's act-check.test.ts), so a yes to
// Act goes through. Their name stays as it was.
await L.pg`insert into owner (name, act_check_at) values ('', now())
  on conflict (id) do update set act_check_at = now()`;
const owner = await L.ownerName();
const said = { title: 'Do the thing', why: 'w', ifApproved: 'i' };
const gmailAtAct = { connector: 'gmail', level: 'act' as const };

/** A fresh Odd for one row, so no row's asks or level reach another, with the owner's choice for work from colleagues. */
async function hire(id: string, permission: Level = 'act', acts = false): Promise<string> {
  await L.pg`insert into staff ${L.pg({ ...odd(id, id.toUpperCase()), permission, tools: [], acts_on_hand_offs: acts })}`;
  return id;
}

/** The one follow-up of `kind` for `staffId`. */
async function only(staffId: string, kind: string): Promise<number> {
  const [row] = await L.pg<{ id: number }[]>`
    select id from follow_ups where staff_id = ${staffId} and kind = ${kind}`;
  assert.ok(row, `${staffId} has no ${kind}`);
  return row.id;
}

/** Work Lena hands `to`, whose run already ended waiting on the owner, as one that raised an ask does. */
async function handedTo(to: string): Promise<{ handOffId: number; threadId: number }> {
  const h = await gave('lead', to, { title: `Work for ${to}` });
  const run = await L.startFollowUp(h.id);
  assert.ok(run, `${to}'s hand-off could not start`);
  await L.finishFollowUp(run, `Work for ${to}`, 'waiting', 'Asked the owner.');
  return { handOffId: h.id, threadId: h.thread };
}

/** The owner's yes to `ask`, and the connect task an access ask's yes gives, done. */
async function approve(ask: number): Promise<void> {
  await L.decideAsk(ask, 'approve', null);
  const tasks = await L.pg<{ id: number }[]>`select id from tasks where ask_id = ${ask}`;
  for (const t of tasks) await L.finishTask(t.id, true, null);
}

/** The carry-out a yes to `ask` started. */
async function approved(ask: number): Promise<{ follow: number; ask: number }> {
  await approve(ask);
  return { follow: await startedBy(ask, 'carry_out'), ask };
}

const iterated = async (ask: number) => {
  await L.decideAsk(ask, 'iterate', 'Make it shorter.');
  return { follow: await startedBy(ask, 'rework'), ask };
};

type State = {
  id: string;
  /** What the row sets up, in the table's words. */
  says: string;
  /** The level the run works at with the owner's choice off. */
  ceiling: Level;
  /** With the choice on, the run works at Act. */
  lifted: boolean;
  /** Sets the row up and names the run: a follow-up and its ask, or the Odd's own chat. */
  go: (o: string) => Promise<{ follow: number; ask?: number; also?: number } | 'chat'>;
  /** A line the run's prompt must hold, with `{owner}`, `{ask}` and `{also}` filled in. */
  brief?: string;
  /** The line it must hold instead with the choice on, when that differs. */
  briefOn?: string;
  /** The Odd's level before the row's yes, when the yes is what raises it. */
  from?: Level;
};

const STATES: State[] = [
  {
    id: 's1',
    lifted: true,
    says: "a yes to Act asked for in a colleague's hand-off carries out at Draft, and says so",
    ceiling: 'draft',
    from: 'draft',
    brief:
      "{owner} approved your ask #{ask} for the Act level. Your own work runs at Act from now on; this run serves a colleague's hand-off, so it works at Draft at most.",
    briefOn:
      '{owner} approved your ask #{ask} for the Act level, and this run has it.\n{owner} lets you act on your own on work a colleague hands you, so it runs at Act too.',
    go: async (o) => {
      const { ask } = await L.raiseAsk(o, {
        ...said,
        kind: 'level',
        level: 'act',
        ...(await handedTo(o))
      });
      return approved(ask.id);
    }
  },
  {
    id: 's2',
    lifted: false,
    says: "a yes to Act asked for in the Odd's own chat carries out at Act",
    ceiling: 'act',
    from: 'draft',
    brief: '{owner} approved your ask #{ask} for the Act level, and this run has it.',
    go: async (o) => {
      const { ask } = await L.raiseAsk(o, { ...said, kind: 'level', level: 'act' });
      return approved(ask.id);
    }
  },
  {
    id: 's3',
    lifted: true,
    says: "a yes to an office tool asked for in a colleague's hand-off carries out at Draft",
    ceiling: 'draft',
    go: async (o) => {
      const { ask } = await L.raiseAsk(o, {
        ...said,
        kind: 'office_tool',
        officeTools: ['office_report'],
        ...(await handedTo(o))
      });
      return approved(ask.id);
    }
  },
  {
    id: 's4',
    lifted: true,
    says: "a yes to an outside tool at write asked for in a colleague's hand-off carries out at Draft",
    ceiling: 'draft',
    go: async (o) => {
      const { ask } = await L.raiseAsk(o, { ...said, access: gmailAtAct, ...(await handedTo(o)) });
      return approved(ask.id);
    }
  },
  {
    id: 's5',
    lifted: false,
    says: "a yes to an outside tool asked for in the Odd's own job carries out at its level",
    ceiling: 'act',
    go: async (o) => {
      const { ask } = await L.raiseAsk(o, { ...said, access: gmailAtAct });
      return approved(ask.id);
    }
  },
  {
    id: 's6',
    lifted: false,
    says: "a no with a reason to an ask from a colleague's hand-off is read at Draft",
    ceiling: 'draft',
    go: async (o) => {
      const { ask } = await L.raiseAsk(o, { ...said, ...(await handedTo(o)) });
      await L.decideAsk(ask.id, 'deny', 'Not this week.');
      return { follow: await startedBy(ask.id, 'denied'), ask: ask.id };
    }
  },
  {
    id: 's7',
    lifted: false,
    says: "the Odd's own chat after a yes to Act works at Act",
    ceiling: 'act',
    from: 'draft',
    go: async (o) => {
      const { ask } = await L.raiseAsk(o, { ...said, kind: 'level', level: 'act' });
      await L.decideAsk(ask.id, 'approve', null);
      return 'chat';
    }
  },
  {
    id: 's8',
    lifted: true,
    says: "twin outside tool asks, one from the Odd's own job and one from a colleague's hand-off, carry out once, at Draft",
    ceiling: 'draft',
    brief:
      'This also answers your ask #{also}, which another of your runs raised for the same tool: do that work once, here.',
    go: async (o) => {
      const handed = await handedTo(o);
      const own = await L.raiseAsk(o, { ...said, access: gmailAtAct });
      const twin = await L.raiseAsk(o, { ...said, access: gmailAtAct, ...handed });
      await approve(own.ask.id);
      // The hand-off twin carries out and stands for the plain ask, which starts no run.
      const carries = await L.pg<{ id: number; askId: number }[]>`
        select id, ask_id as "askId" from follow_ups where staff_id = ${o} and kind = 'carry_out'`;
      assert.deepEqual(
        carries.map((c) => c.askId),
        [twin.ask.id]
      );
      return { follow: carries[0].id, ask: twin.ask.id, also: own.ask.id };
    }
  },
  {
    id: 's9',
    lifted: true,
    says: "an ask from a colleague's hand-off sent back to iterate is reworked at Draft",
    ceiling: 'draft',
    go: async (o) => {
      const { ask } = await L.raiseAsk(o, { ...said, access: gmailAtAct, ...(await handedTo(o)) });
      return iterated(ask.id);
    }
  },
  {
    id: 's10',
    lifted: true,
    says: "a task given in a colleague's hand-off is picked up after at Draft",
    ceiling: 'draft',
    go: async (o) => {
      const task = await L.giveTask(o, {
        title: 'Pick a colour',
        why: 'w',
        steps: ['Pick one.'],
        ...(await handedTo(o))
      });
      await L.finishTask(task.id, true, null);
      const [row] = await L.pg<{ id: number }[]>`
        select id from follow_ups where task_id = ${task.id} and kind = 'task_done'`;
      assert.ok(row, `task ${task.id} started no task_done`);
      return { follow: row.id };
    }
  },
  {
    id: 's11',
    lifted: false,
    says: "an ask from the Odd's own job sent back to iterate is reworked at its level",
    ceiling: 'act',
    go: async (o) => iterated((await L.raiseAsk(o, said)).ask.id)
  },
  {
    id: 's12',
    lifted: false,
    says: "a yes to one exact action asked for in a colleague's hand-off carries out at the Odd's level, so it is not held again",
    ceiling: 'act',
    go: async (o) => approved((await L.raiseAsk(o, { ...said, ...(await handedTo(o)) })).ask.id)
  },
  {
    id: 's13',
    lifted: true,
    says: "one exact action asked for in a colleague's hand-off, sent back to iterate, is reworked at Draft",
    ceiling: 'draft',
    go: async (o) => iterated((await L.raiseAsk(o, { ...said, ...(await handedTo(o)) })).ask.id)
  },
  {
    id: 's14',
    lifted: true,
    says: "a colleague's hand-off itself works at Draft, and says so",
    ceiling: 'draft',
    brief: '2. This run works at Draft at most.',
    briefOn:
      '2. {owner} lets you act on your own on work a colleague hands you, so this run works at your level, Act.',
    go: async (o) => ({ follow: (await gave('lead', o, { title: `Work for ${o}` })).id })
  },
  {
    id: 's15',
    lifted: false,
    says: "the Odd's pick-up of a result a colleague hands back works at Draft",
    ceiling: 'draft',
    go: async (o) => {
      const h = await gave(o, 'lead', { title: `Work from ${o}` });
      const run = await L.startFollowUp(h.id);
      assert.ok(run, `${o}'s hand-off could not start`);
      await L.finishFollowUp(run, `Work from ${o}`, 'done', 'Done.');
      return { follow: await only(o, 'handed_back') };
    }
  },
  {
    id: 's16',
    lifted: false,
    says: 'a thread the Odd picks back up works at Draft',
    ceiling: 'draft',
    go: async (o) => {
      const h = await gave(o, 'lead', { title: `More from ${o}` });
      // The owner's no to an ask the Odd raised there wakes it with their words.
      const { ask } = await L.raiseAsk(o, {
        title: `Stop after the first part, ${o}`,
        why: 'It may be enough.',
        ifApproved: 'The work stops there.',
        threadId: h.thread
      });
      await L.decideAsk(ask.id, 'deny', 'Do the next part too.');
      return { follow: await only(o, 'resume') };
    }
  }
];

for (const s of STATES)
  for (const acts of [false, true])
    test(`${s.id.toUpperCase()}, ${acts ? 'acts on its own' : 'ask me first'}: ${s.says}`, async () => {
      const o = await hire(`${s.id}${acts ? '-on' : ''}`, s.from, acts);
      const started = await s.go(o);
      const who = await L.staffer(o);
      assert.ok(who);
      // At Act when the run starts, so a run held to Draft is told a level below its Odd's.
      assert.equal(who.permission, 'act');
      assert.equal(who.actsOnHandOffs, acts);
      const ceiling = acts && s.lifted ? 'act' : s.ceiling;
      const run: Gave =
        started === 'chat' ? await chatOf(o) : await runOf(started.follow, started.ask);
      assert.equal(run.env.CEILING, ceiling === 'act' ? undefined : ceiling);
      assert.ok(
        run.system.includes(`Your level is ${L.LEVEL_NAME[ceiling]}:`),
        `${s.id} was not told ${ceiling}`
      );
      const brief = acts ? (s.briefOn ?? s.brief) : s.brief;
      if (brief && started !== 'chat') {
        const line = brief
          .replaceAll('{owner}', owner)
          .replace('{ask}', String(started.ask))
          .replace('{also}', String(started.also));
        assert.ok(run.system.includes(line), run.system);
      }
      // The line my_access gives, from the run's own environment as its tool server reads it.
      const access = L.accessInRun(await L.capabilities(who), owner, run.env);
      const capped = `This run serves a colleague's hand-off or was started by the office, so it works at Draft at most, whatever ${owner} has approved.`;
      assert.equal(access.split('\n')[0], L.levelLine(ceiling, owner));
      assert.equal(access.includes(capped), ceiling === 'draft', access);
      // An Odd at Act is told what the owner chose, in every run.
      assert.ok(access.includes(L.handOffsLine(acts, owner)), access);
    });

// A Draft Odd with a standing yes on one tool of a write grant. In its own
// chat the tool goes without asking. In a colleague's hand-off it does only
// when the owner lets it act on its own there; otherwise each call waits for
// the owner's yes, as any call at Draft does. The run's prompt, its tools and
// its my_access all read the same capabilities (`handedOver`), so the prompt
// shows what the gateway holds.
const stands = `Except stage: ${owner} lets you use that one without asking, so a call goes straight through.`;
async function standingOdd(
  id: string,
  acts: boolean,
  permission: Level = 'draft'
): Promise<string> {
  await hire(id, permission, acts);
  await L.addConnector({
    id: `notes-${id}`,
    name: 'Notes',
    description: 'Notes for tests.',
    kind: 'http',
    config: { url: 'http://127.0.0.1:9/mcp' },
    readTools: ['read_note'],
    tools: ['read_note', 'stage', 'publish'],
    readyAt: new Date()
  });
  await L.pg`insert into grants (staff_id, connector_id, level, standing)
    values (${id}, ${`notes-${id}`}, 'act', ${['stage']})`;
  return id;
}

for (const acts of [false, true])
  test(`a standing yes in a colleague's hand-off ${acts ? 'holds when the Odd acts on its own there' : 'waits for the yes when the owner asks first'}`, async () => {
    const o = await standingOdd(`standing${acts ? '-on' : ''}`, acts);
    const who = await L.staffer(o);
    assert.ok(who);
    // Its own chat: the standing yes holds, whatever the choice.
    assert.ok((await chatOf(o)).system.includes(stands));
    const h = await gave('lead', o, { title: `Notes for ${o}` });
    const run = await runOf(h.id);
    // The run still loads the tool, so a call to it reaches the gateway.
    assert.ok(JSON.stringify(run.mcp).includes(`notes-${o}`), JSON.stringify(run.mcp));
    assert.equal(run.system.includes(stands), acts, run.system);
    const access = L.accessInRun(await L.capabilities(who), owner, run.env);
    assert.equal(access.includes(stands), acts, access);
  });

// The lead's pick-up of a colleague's result reads the colleague's words too.
// It stays at Draft either way; its standing yeses follow the owner's choice,
// as a hand-off's do. The Odd is at Act, where the owner makes the choice, and
// the pick-up's Draft cap is what puts its standing yes in play.
for (const acts of [false, true])
  test(`a standing yes in the lead's pick-up of a result ${acts ? 'holds when the Odd acts on its own on work from colleagues' : 'waits for the yes when the owner asks first'}`, async () => {
    const o = await standingOdd(`pick-up${acts ? '-on' : ''}`, acts, 'act');
    const who = await L.staffer(o);
    assert.ok(who);
    const h = await gave(o, 'lead', { title: `Notes from ${o}` });
    const done = await L.startFollowUp(h.id);
    assert.ok(done, `${o}'s hand-off could not start`);
    await L.finishFollowUp(done, `Notes from ${o}`, 'done', 'Done.');
    const run = await runOf(await only(o, 'handed_back'));
    // Draft either way: the choice never lifts a pick-up's level.
    assert.equal(run.env.CEILING, 'draft');
    assert.ok(JSON.stringify(run.mcp).includes(`notes-${o}`), JSON.stringify(run.mcp));
    assert.equal(run.system.includes(stands), acts, run.system);
    const access = L.accessInRun(await L.capabilities(who), owner, run.env);
    assert.equal(access.includes(stands), acts, access);
  });
