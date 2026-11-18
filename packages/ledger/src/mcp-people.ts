// Tools about people: pokes, hires, taking items off the desk, leaving the office
// and the office's report.
import { z } from 'zod';
import {
  ask,
  cancelPoke,
  officeActivity,
  raiseAsk,
  schedulePoke,
  staffer,
  task,
  withdrawAsk,
  withdrawTask,
  anyStaffer,
  formerStaff,
  roster,
  waitingPokes
} from './office.ts';
import {
  capabilities,
  folderLines,
  officeHeldIn,
  outsideLines,
  ownToolsSaid
} from './capabilities.ts';
import { AGENT_NAMES } from './agents.ts';
import { currentSystem } from './platform.ts';
import { computerWord } from './system-words.ts';
import { leavesLine, leavingRefused } from './leaving.ts';
import { keepBugDraft } from './bug-drafts.ts';
import { MANAGER_ROLE } from './managers.ts';
import { clockTime, officeAt } from './time.ts';
import {
  ME,
  me,
  OWNER,
  ZONE,
  has,
  OWNER_SAID,
  offered,
  RUN_KEY,
  RAISED_ON,
  revisesArg,
  hireFields,
  hireFrom,
  tool,
  text,
  json,
  refused
} from './mcp-run.ts';
import { raisedNote, placed } from './mcp-desk.ts';
import './mcp-threads.ts';

if (has('poke_owner')) {
  tool(
    'poke_owner',
    {
      description: `Send ${OWNER} a chat message later, once: a check-in after something they planned, or a nudge before it. Write the exact message now, in your voice, short; the office delivers it at that time as a chat from you, with a notification on their ${computerWord(currentSystem())}. Use it when ${OWNER} asks ("check in on me in an hour"), or when your job says to; in_minutes 0 sends it now. One poke per minute: a new one at the same time replaces the old. Not for anything that needs their yes; that is raise_ask.`,
      inputSchema: {
        message: z.string().min(1).max(500).describe(`Exactly what ${OWNER} reads.`),
        at: z.string().optional().describe(`${ZONE}: "18:50" for today, or "2026-11-02 18:50".`),
        in_minutes: z
          .number()
          .int()
          .min(0)
          .max(10_080)
          .optional()
          .describe('Instead of at: how many minutes from now. 0 is now.')
      }
    },
    async ({ message, at, in_minutes }) => {
      const when =
        in_minutes !== undefined
          ? new Date(Date.now() + in_minutes * 60_000)
          : at
            ? officeAt(at)
            : undefined;
      if (!when)
        return text(`Say when: at as "HH:MM" or "YYYY-MM-DD HH:MM" in ${ZONE}, or in_minutes.`);
      try {
        const p = await schedulePoke(ME, when, message);
        return text(`Poke ${p.id} is set for ${clockTime(p.at)} ${ZONE}.`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e));
      }
    }
  );

  tool(
    'my_pokes',
    {
      description: 'Your pokes still to come, with their ids, times and messages.',
      inputSchema: {}
    },
    async () => {
      const rows = await waitingPokes(ME);
      return text(
        rows.length
          ? rows.map((p) => `- #${p.id} ${clockTime(p.at)}: ${p.message}`).join('\n')
          : 'No pokes waiting.'
      );
    }
  );

  tool(
    'cancel_poke',
    {
      description: 'Cancel one of your pokes still to come, by its id from my_pokes.',
      inputSchema: { id: z.number().int() }
    },
    async ({ id }) =>
      text(
        (await cancelPoke(id, ME)) ? `Poke ${id} is cancelled.` : `No waiting poke #${id} of yours.`
      )
  );
}

if (has('propose_hire'))
  tool(
    'propose_hire',
    {
      description: `Propose a new Odd to ${OWNER}. Write the job description to a file in your folder first, then pass its path. It lands on their desk as an ask; approving it opens the hire window filled in with this, and they hire from there. They may edit the file before they hire, so the window reads it then. One hire per ask. For a real person New Altitude offers as a persona, propose them by persona_slug or full name: ${OWNER} adds the real persona from the hire window, and the office never builds a look-alike of a real person. For a hire that serves a goal, use propose_goal_plan instead.${raisedNote}`,
      inputSchema: {
        ...hireFields,
        why: z.string().describe('Why this hire, in one to three sentences.'),
        revises: revisesArg
      }
    },
    async (a) => {
      const on = await placed({});
      if ('problem' in on) return refused(on.problem);
      const hire = hireFrom(a);
      if (typeof hire === 'string') return text(hire);
      const { ask } = await raiseAsk(ME, {
        ...on,
        title: `Hire ${a.name}, ${a.role}`,
        why: a.why,
        ifApproved: 'The hire window opens with this filled in. You hire from there.',
        revises: a.revises,
        hire
      });
      return text(`Ask ${ask.id} is on ${OWNER}'s desk.`);
    }
  );

// Taking its own open asks and tasks off the owner's desk, only in a chat, on
// the owner's own words. A withdrawn ask is a no by the office: its line goes
// back where it came from, and no run reads it for a lesson (`withdrawAsk`).
if (offered('withdraw'))
  tool(
    'withdraw',
    {
      description: `Take your own open asks and tasks off ${OWNER}'s desk, when ${OWNER} told you so in this chat: "clear your asks", "drop that task". Nothing it would have done happens, and a held call is never made. Use it only on ${OWNER}'s word, never to tidy up on your own; to change an item, raise a new one that revises it instead. The ids are in "Still on ${OWNER}'s desk from you", or my_asks.`,
      inputSchema: {
        asks: z.array(z.number().int()).max(200).optional().describe('Your open asks to take off.'),
        tasks: z
          .array(z.number().int())
          .max(200)
          .optional()
          .describe('Your open tasks for them to take off.')
      }
    },
    async ({ asks: askIds = [], tasks: taskIds = [] }) => {
      if (!askIds.length && !taskIds.length) return refused('Name the asks or tasks to take off.');
      // Offered only in a chat (`inChat` on its row), where the office sets OWNER_SAID.
      const line = `${me.name} took it off your desk, as you said in chat: "${OWNER_SAID!.slice(0, 300)}"`;
      const gone: string[] = [];
      const left: string[] = [];
      // Whether it was still open is the withdrawal's own answer, read under its
      // locks, so one the owner answered meanwhile is never reported taken off.
      for (const id of new Set(askIds)) {
        const mine = (await ask(id))?.staffId === ME;
        (mine && (await withdrawAsk(id, line)) ? gone : left).push(`ask ${id}`);
      }
      for (const id of new Set(taskIds)) {
        const mine = (await task(id))?.staffId === ME;
        (mine && (await withdrawTask(id, line)) ? gone : left).push(`task ${id}`);
      }
      return text(
        [
          gone.length ? `Took off ${OWNER}'s desk: ${gone.join(', ')}.` : 'Nothing was taken off.',
          left.length ? `Not yours or not open, so left as it is: ${left.join(', ')}.` : ''
        ]
          .filter(Boolean)
          .join(' ')
      );
    }
  );

// A bug report about Oddboro, only in a chat (`inChat` on its row). The office
// puts the draft on this run's reply when the run ends (bug-drafts.ts), and
// the owner's File this opens it in the report form. It files nothing.
if (offered('draft_bug_report'))
  tool(
    'draft_bug_report',
    {
      description: `Draft a bug report about Oddboro itself, when ${OWNER} asks you to report a bug in this chat. Give a short title and the details: what happened, what they expected, and anything that helps fix it, such as the error. Under your reply, ${OWNER} gets File this, which opens the report form with your draft for them to review and edit. Nothing is filed until they choose there, so tell them to click File this. A second call in the same reply replaces the first draft.`,
      inputSchema: {
        // The report form's limits (TITLE_LIMIT and BODY_LIMIT in the office's bug-report.ts).
        title: z.string().trim().min(1).max(256).describe('One line that names the bug.'),
        body: z
          .string()
          .trim()
          .min(1)
          .max(65536)
          .describe('The details, in plain words. Markdown is fine.')
      }
    },
    async ({ title, body }) => {
      // The office sets RUN_KEY for every run; with none, no reply could carry the draft.
      if (!RUN_KEY)
        return {
          ...text('Nothing was drafted. This run has no reply to put it on.'),
          isError: true
        };
      keepBugDraft(ME, RUN_KEY, { title, body });
      return text(
        `Drafted. ${OWNER} sees a File this bug report button under your reply, which opens the draft for them to review. Nothing is filed yet.`
      );
    }
  );

// Leaving the office (leaving.ts). Each only in a chat, on the owner's own
// words (`inChat` on its row in tools.ts), and each only raises an ask: the
// Odd leaves or comes back on the owner's yes alone.
const leaveNote = `It lands on ${OWNER}'s desk as an ask, and nothing happens until they say yes. Use it only when ${OWNER} told you so in this chat, never on your own.`;

if (offered('leave_office'))
  tool(
    'leave_office',
    {
      description: `${OWNER} told you to leave the office: ask them to confirm. On their yes you leave at once: off the floor, your jobs off, and what you have open on their desk withdrawn. Your history stays, and the ${MANAGER_ROLE} can bring you back. ${leaveNote}`,
      inputSchema: {
        why: z
          .string()
          .max(600)
          .describe(
            `What ${OWNER} said, in their words, and anything they should know before you go.`
          )
      }
    },
    async ({ why }) => {
      const held = await leavingRefused('remove', ME);
      if (held) return refused(held);
      const { ask } = await raiseAsk(ME, {
        ...RAISED_ON,
        kind: 'remove',
        odd: ME,
        title: `Let ${me.name} go from the office`,
        why,
        ifApproved: leavesLine(me.name)
      });
      return text(
        `Ask ${ask.id} is on ${OWNER}'s desk. Tell them you go once they say yes there, and not before.`
      );
    }
  );

if (offered('remove_odd')) {
  // Listed here, as bring_back_odd lists the Odds that left, so the tool names
  // no other tool the Odd may not hold to find an id.
  const here = (await roster()).filter((p) => p.id !== ME && p.role !== MANAGER_ROLE);
  tool(
    'remove_odd',
    {
      description: `${OWNER} told you to let another Odd go: ask them to confirm. On their yes it leaves at once: off the floor, its jobs off, its open work handed back or withdrawn. Its history stays${offered('bring_back_odd') ? ', and you can bring it back with bring_back_odd' : ''}. Never the ${MANAGER_ROLE}. ${leaveNote} ${
        here.length
          ? `Odds you can ask about: ${here.map((p) => `${p.id} (${p.name}, ${p.role})`).join('; ')}.`
          : 'No other Odd works here.'
      }`,
      inputSchema: {
        odd: z.string().describe('The id of the Odd to let go, from the list above.'),
        why: z.string().max(600).describe(`What ${OWNER} said, in their words.`)
      }
    },
    async ({ odd, why }) => {
      const held = await leavingRefused('remove', odd);
      if (held) return refused(held);
      const who = (await staffer(odd))!;
      const { ask } = await raiseAsk(ME, {
        ...RAISED_ON,
        kind: 'remove',
        odd,
        title: `Let ${who.name} go from the office`,
        why,
        ifApproved: leavesLine(who.name)
      });
      return text(
        `Ask ${ask.id} is on ${OWNER}'s desk. ${who.name} goes once they say yes there, and not before.`
      );
    }
  );
}

if (offered('bring_back_odd')) {
  const gone = await formerStaff();
  tool(
    'bring_back_odd',
    {
      description: `${OWNER} told you to bring back an Odd that left the office: ask them to confirm. On their yes it comes back as it was, with its jobs on again. What it had open when it left stays closed. ${leaveNote} ${
        gone.length
          ? `Odds that left, latest first: ${gone.map((p) => `${p.id} (${p.name}, ${p.role})`).join('; ')}.`
          : 'No Odd has left this office.'
      }`,
      inputSchema: {
        odd: z.string().describe('The id of the Odd to bring back, from the list above.'),
        why: z.string().max(600).describe(`What ${OWNER} said, in their words.`)
      }
    },
    async ({ odd, why }) => {
      const held = await leavingRefused('bring_back', odd);
      if (held) return refused(held);
      const who = (await anyStaffer(odd))!;
      const { ask } = await raiseAsk(ME, {
        ...RAISED_ON,
        kind: 'bring_back',
        odd,
        title: `Bring ${who.name} back to the office`,
        why,
        ifApproved: `${who.name} comes back as it was: its job description, tools, folders, lessons and files, with its jobs on again.`
      });
      return text(
        `Ask ${ask.id} is on ${OWNER}'s desk. ${who.name} comes back once they say yes there, and not before.`
      );
    }
  );
}

if (has('office_report'))
  tool(
    'office_report',
    {
      description: `Everything the office did in a window: each Odd with its remit, its level (read, draft or act), its tool and what its own tools reach, its folders, the office tools it holds beyond the ones every Odd has, its outside tools (each with what it reaches, or why a run leaves it out), and its jobs and runs, asks open and decided, and tasks for ${OWNER} open and done. For the daily report. followUps is the work owed after ${OWNER} answered: carrying out an approved ask, reworking one they sent back, hearing their answer to something an Odd raised, or picking up after a task they finished, each with its outcome (done, failed, waiting on ${OWNER}, or null while still to do). Each run has a trigger: 'schedule' means its timer started it, 'manual' means ${OWNER} pressed Run now. For shared files, lastVerified records the timed file operations the office checked. A run summary alone never verifies a file, its claims, or delivery. Judge a job's timing by its schedule runs only; a manual run at any hour is expected. Every time is ${ZONE}, like the schedules.`,
      inputSchema: { hours: z.number().int().min(1).max(168).default(24) }
    },
    async ({ hours }) => {
      const activity = await officeActivity(new Date(Date.now() - hours * 3_600_000));
      const people = new Map((await roster()).map((p) => [p.id, p]));
      const staff = await Promise.all(
        activity.staff.map(async (s) => {
          const who = people.get(s.id);
          if (!who) return s;
          const caps = await capabilities(who);
          return {
            ...s,
            remit: caps.remit,
            level: caps.level,
            runsOn: AGENT_NAMES[caps.agent],
            // As the Odd's own my_access says it, the office's held network included.
            // Another Odd reads it, so it names whose tools, folders and Settings tab.
            ownTools: ownToolsSaid(caps.agent, caps.own, officeHeldIn(process.env), who.name)
              .join(' ')
              .replaceAll('{owner}', OWNER),
            folders: folderLines(caps.own),
            officeTools: caps.office,
            outsideTools: outsideLines(caps, OWNER, who.name)
          };
        })
      );
      return json({ ...activity, staff });
    }
  );
