// Tools for the ledger and the desk: searching, asks and tasks for the owner.
import { z } from 'zod';
import { asksFor, giveTask, raiseAsk, searchLedger, tasksFrom } from './office.ts';
import { askReplaced, SAID_AS, taskSaid } from './desk-answers.ts';
import { parseLevel, SWITCH_NAMES } from './access-words.ts';
import { notLed, recentThreads, threadsOn } from './threads.ts';
import { goalWork, goalWorkRefused } from './goal-work.ts';
import { projectConnections, projectWork, requestProject } from './project-sessions.ts';
import {
  ME,
  me,
  OWNER,
  has,
  OWNER_SAID,
  offered,
  THREAD_ID,
  RUN_KEY,
  VIA,
  RAISED_ON,
  HANDS_OFF,
  revisesArg,
  attachArg,
  attachable,
  tool,
  text,
  json,
  line,
  refused
} from './mcp-run.ts';

// Connections are granted one at a time by the owner. An Odd can never
// start a native process or type terminal keys through these tools.
if (offered('my_project_sessions'))
  tool(
    'my_project_sessions',
    {
      description:
        'See the project conversations the owner shared with you and the status and answers of your assignments.',
      inputSchema: {}
    },
    async () => {
      const sessions = await projectConnections(ME);
      return json(
        await Promise.all(
          sessions.map(async (s) => ({
            id: s.id,
            title: s.title,
            provider: s.agent,
            work: (await projectWork(s.id))
              .filter((r) => r.staffId === ME)
              .map((r) => ({ id: r.id, state: r.state, answer: r.answer }))
          }))
        )
      );
    }
  );
if (offered('send_project_work'))
  tool(
    'send_project_work',
    {
      description:
        'Give a shared native project session an assignment. Use a fresh UUID per assignment and reuse it on a retry. It waits for the owner to send it, unless the owner lets you send to that session without asking and you are at Act. Its result comes back as a report.',
      inputSchema: {
        session: z.string().uuid(),
        key: z.string().uuid(),
        prompt: z.string().trim().min(1).max(64000)
      }
    },
    async (a) => {
      if ((parseLevel(process.env.CEILING) ?? me.permission) === 'read')
        return refused('This run can only read project work.');
      const row = await requestProject({
        id: a.key,
        sessionId: a.session,
        prompt: a.prompt,
        staffId: ME,
        threadId: THREAD_ID,
        draft: (parseLevel(process.env.CEILING) ?? me.permission) !== 'act'
      });
      return json({ id: row.id, state: row.state });
    }
  );
if (has('search_ledger'))
  tool(
    'search_ledger',
    {
      description: `Search the office ledger: every decision ${OWNER} made, all work done by Odds or by ${OWNER}, and reports. It searches by meaning when available, otherwise by keywords. No matches does not mean the office has no record: try fewer words, or an empty query for the newest rows, before asking ${OWNER} to repeat information. Check it before raising an ask or giving ${OWNER} a task.`,
      inputSchema: {
        query: z
          .string()
          .describe('What you are looking for, in plain words. Empty for the newest rows.'),
        kind: z.enum(['decision', 'work', 'report', 'hire', 'access']).optional(),
        who: z.string().optional().describe('An Odd\'s id, or "owner".'),
        limit: z.number().int().min(1).max(50).optional()
      }
    },
    async ({ query, kind, who, limit }) => {
      const rows = await searchLedger(query, { kind, actor: who, limit });
      return text(
        rows.length
          ? rows.map((r) => `${line(r)}\n  ${r.body.slice(0, 400)}`).join('\n')
          : 'Nothing found.'
      );
    }
  );

// In a chat, the threads this Odd works on and does not lead (`threadsOn`):
// what the owner asks there about one goes to its lead with tell_lead.
const workingOn = offered('tell_lead') ? await threadsOn(ME) : [];
const goalRule = await goalWork(ME, workingOn);
// A hub in a run on no thread, such as a chat or a job, names the thread an ask
// or task is for, or null, so what it raises about a thread lands there.
const leading = HANDS_OFF.leads ? await recentThreads(ME) : [];
/** The arguments raise_ask and give_owner_a_task take for where what they raise goes. */
const raisedArgs = {
  ...(leading.length
    ? {
        work: z
          .number()
          .int()
          .nullable()
          // Optional, so a run whose session kept this tool's older form, with
          // no work, can still raise it: left out reads as for none of them.
          .optional()
          .describe(
            `The number of work you lead, as your instructions number it, when this is for it: it goes on that work, and ${OWNER}'s answer brings you back there. null, or left out, when it is for none of them.`
          )
      }
    : {})
};
/** What each tool `placed` checks for an ask or task adds to its description, in a chat that offers tell_lead. */
const raisedNote = !workingOn.length
  ? ''
  : goalRule
    ? ` Not in this chat: you have no job of your own, so what ${OWNER} asks of you here is a goal's work, which goes to ${goalRule.leads.join(' or ')} with tell_lead.`
    : ` Never for work another Odd leads that you are on: pass ${OWNER}'s words to its lead with tell_lead.`;

/**
 * Where an ask or task this run raises goes, from its arguments, or why it may
 * not go at all, so a goal's work goes to its lead. raise_ask,
 * give_owner_a_task, ask_for_access and propose_hire check it, and hand_off
 * when it would open a thread. Three tools that reach the desk do not, since
 * none can carry a goal's work off its thread: reconnect_access restores a
 * tool the owner already gave this Odd, which all its work needs; propose_goal
 * offers a new goal, which nobody leads yet; and propose_goal_plan always goes
 * on its goal's one thread (`raiseAsk`).
 */
async function placed(a: {
  work?: number | null;
}): Promise<{ problem: string } | { handOffId?: number; threadId?: number; run?: string }> {
  // A thread it leads is its own work, never a colleague's goal work.
  if (a.work !== undefined && a.work !== null) {
    const problem = await notLed({ hubId: ME, threadId: a.work });
    // Only a lead's run naming its thread keeps its key there: a colleague's run
    // on a thread must never hold the lead's pick-ups (`waitsOnOwnRun`).
    return problem ? { problem } : { threadId: a.work, run: RUN_KEY };
  }
  if (goalRule) return { problem: goalWorkRefused(goalRule, OWNER) };
  return RAISED_ON;
}

tool(
  'raise_ask',
  {
    description: `Ask ${OWNER} to approve something. It lands on their desk and they approve, deny, or send it back with what to change, maybe with a reason. Use it for anything that needs their yes. One decision per ask, worded as the exact action: if they approve, you carry it out at once in a new run, with only the ask to go on. The reply lists their closest past decisions: if one matches and gave no reason, tell ${OWNER} that a reason would let Odds handle these without asking next time. For an outside tool, use ask_for_access. When this proposal will carry out the work, set connect_only on its access requests so each connection does not also start that work. For a folder on this computer, use ask_for_folder; for ${SWITCH_NAMES.commands} or ${SWITCH_NAMES.web}, see my_access; and for a new Odd, use propose_hire.${raisedNote}`,
    inputSchema: {
      title: z
        .string()
        .max(140)
        .describe(
          'What you want, as one short line: "Unsubscribe you from the airline sale emails".'
        ),
      why: z.string().describe('Why, in one to three plain sentences.'),
      if_approved: z.string().describe('What happens next if they say yes.'),
      attach: attachArg,
      revises: revisesArg,
      ...raisedArgs
    }
  },
  async ({ title, why, if_approved, attach, revises, ...where }) => {
    const on = await placed(where);
    if ('problem' in on) return refused(on.problem);
    const files = await attachable(attach);
    if ('problem' in files) return text(files.problem);
    const { ask, precedent } = await raiseAsk(ME, {
      ...on,
      title,
      why,
      ifApproved: if_approved,
      revises,
      via: VIA,
      attach: files.paths
    });
    return text(
      `Ask ${ask.id} is on ${OWNER}'s desk. Check my_asks later for their decision.\n` +
        (precedent.length
          ? `\n${OWNER}'s closest past decisions:\n${precedent.map(line).join('\n')}`
          : `\n${OWNER} has decided nothing like this before.`)
    );
  }
);

tool(
  'my_asks',
  {
    description: `Your asks and how ${OWNER} decided each, with their reason when they gave one.`,
    inputSchema: {}
  },
  async () => {
    const rows = await asksFor(ME);
    if (!rows.length) return text('You have raised no asks.');
    return text(
      rows
        .map((a) =>
          askReplaced(a)
            ? `- #${a.id} REPLACED: ${a.title}`
            : `- #${a.id} ${a.status === 'revise' ? 'SENT BACK' : a.status.toUpperCase()}: ${a.title}${a.reason ? ` (${a.status === 'revise' ? 'change' : 'reason'}: ${a.reason})` : a.status === 'open' ? '' : ' (no reason given)'}`
        )
        .join('\n')
    );
  }
);

tool(
  'my_tasks',
  {
    description: `Each task you gave ${OWNER} and how it ended, with what they said on it.`,
    inputSchema: {}
  },
  async () => {
    const rows = await tasksFrom(ME);
    if (!rows.length) return text('You have given no tasks.');
    return text(
      rows
        .map((t) => {
          const said = t.status === 'open' ? '' : taskSaid(t);
          return `- #${t.id} ${(t.status === 'open' ? 'open' : SAID_AS[t.status]).toUpperCase()}: ${t.title}${said ? ` (${said})` : ''}`;
        })
        .join('\n')
    );
  }
);

if (has('give_owner_a_task'))
  tool(
    'give_owner_a_task',
    {
      description: `Give ${OWNER}, the human operator, a task: something only they can do. A question with one answer needs no steps: give just the title and why, and they type the answer where it arrives. Steps are numbered and each is one action, written so anyone can follow them without guessing: name the button, the place, the exact thing. When a step opens a page, give its full address (https://mail.google.com/...), which the owner clicks; when they type or paste something, put exactly that in \`backticks\`, which the owner copies with one click (In the From box, type \`dmarc@example.com\`). If they must choose, pass choices and the task ends with them, e.g. for 'Should this kind of email reach you?' pass ['Yes, keep sending these', 'No, filter these out']. When you need their words, pass response, never a file for them to fill in. Starting text in response is only for a task whose job is to edit that text, such as a draft list, and then the title names what to edit (Correct the client list). A question gets an empty response, or none, so they type the answer: never prefill it with other text you hold. Attach files they should only read. Never write steps to connect or reconnect a tool: ask_for_access and reconnect_access give the office's own.${raisedNote}`,
      inputSchema: {
        title: z.string().max(140),
        why: z
          .string()
          .describe(
            `Why only the owner can do this, after checking your notes, relevant Ledger entries and shared work. Name the relevant colleague you considered and why they cannot do it. If there is no suitable colleague, say so. ${HANDS_OFF.tool ? 'Work a colleague can do goes through hand_off.' : 'If you cannot hand work to a suitable colleague, explain the access limit rather than treating it as owner-only work.'}`
          ),
        steps: z
          .array(z.string())
          .max(12)
          .optional()
          .describe(
            'One action per step. No "and then". A page to open as its full address; anything to type or paste in `backticks`. Leave out for a question with one answer.'
          ),
        response: z
          .string()
          .max(64000)
          .optional()
          .describe(
            'Starting text only when the task is to edit it, and the title says so. Empty, or left out, for a question.'
          ),
        choices: z.array(z.string()).min(2).max(4).optional(),
        attach: attachArg,
        ...raisedArgs
      }
    },
    async ({ title, why, steps, response, choices, attach, ...where }) => {
      const on = await placed(where);
      if ('problem' in on) return refused(on.problem);
      const files = await attachable(attach);
      if ('problem' in files) return text(files.problem);
      const all = [
        ...(steps ?? []).map((s) => ({ text: s, done: false })),
        ...(choices
          ? [
              {
                text: 'Choose one.',
                done: false,
                action: { kind: 'choice' as const, options: choices }
              }
            ]
          : [])
      ];
      const t = await giveTask(ME, {
        title,
        why,
        steps: all,
        response,
        attach: files.paths,
        via: VIA,
        ownerSaid: OWNER_SAID,
        ...on
      });
      return text(`Task ${t.id} is on ${OWNER}'s desk. The ledger records it when they finish it.`);
    }
  );

export { workingOn, raisedArgs, raisedNote, placed };
