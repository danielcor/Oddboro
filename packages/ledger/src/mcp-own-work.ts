// Tools for an Odd's own work: its jobs, goals, lessons and description.
import { z } from 'zod';
import {
  DescriptionChanged,
  editOwnJob,
  jobsFor,
  raiseAsk,
  setDescription,
  record,
  roster
} from './office.ts';
import { allGoals, goal, goalDraft, goalsFor, logProgress, updateGoal } from './goals.ts';
import { GOAL_IS_LIVE } from './goal-words.ts';
import {
  APPLIES_TO_MAX,
  CITE_FIRST,
  keepLesson,
  QUOTE_MIN_WORDS,
  usedLesson,
  WHY_REPLACED
} from './lessons.ts';
import { GOAL_STATUSES, type GoalPlanItem } from './schema.ts';
import { describe as describeSchedule } from './time.ts';
import {
  ME,
  me,
  OWNER,
  ZONE,
  has,
  OWNER_WORDS,
  RUN_KEY,
  RAISED_ON,
  approvedArg,
  goAhead,
  revisesArg,
  attachArg,
  attachable,
  jobFiles,
  planFiles,
  scheduleArg,
  missedArg,
  hireFields,
  hireFrom,
  goalText,
  goalFields,
  tool,
  text,
  shortDay
} from './mcp-run.ts';
import './mcp-access.ts';

tool(
  'my_jobs',
  {
    description: `Your own jobs: name, schedule in ${ZONE}, and the steps each run follows.`,
    inputSchema: {}
  },
  async () => {
    const rows = await jobsFor(ME);
    if (!rows.length) return text('You have no jobs.');
    return text(
      rows
        .map(
          (j) =>
            `## ${j.name}\n${describeSchedule(j.schedule)}${j.enabled ? '' : ', paused'}${j.report ? `, reports to ${OWNER}` : ''}, missed runs: ${j.missed}\n\n${j.instructions}${j.files ? `\nScheduled files: ${JSON.stringify(j.files)}` : ''}`
        )
        .join('\n\n')
    );
  }
);

tool(
  'my_goals',
  {
    description: `The goals ${OWNER} set that you serve: why each matters, what done looks like, your part, and how it is going. Work toward them. You see only these.`,
    inputSchema: {}
  },
  async () => {
    const rows = (await goalsFor(ME)).filter((g) => GOAL_IS_LIVE[g.status]);
    return text(
      rows.length ? rows.map((g) => goalText(g)).join('\n\n') : 'You serve no goals yet.'
    );
  }
);

tool(
  'log_progress',
  {
    description: `Say how a goal you serve, or whose thread you lead, is going, once per run that moves it or shows it slipping. One line of evidence, with a number when there is one: "inbox at 14 on Friday, down from 40; a deadline pushed Tuesday's sort to Wednesday". ${OWNER}'s daily report reads these.`,
    inputSchema: {
      goal_id: z.number().int(),
      health: z
        .enum(['on_track', 'slipping', 'blocked'])
        .describe('blocked means it cannot move without something from someone.'),
      note: z.string().min(1).max(300)
    }
  },
  async ({ goal_id, health, note }) => {
    const r = await logProgress(ME, goal_id, health, note);
    return text(typeof r === 'string' ? r : `Logged on goal #${goal_id}.`);
  }
);

if (has('list_goals'))
  tool(
    'list_goals',
    {
      description: `Every goal ${OWNER} set, active first: why, done when, who serves each and their part, and the latest progress.`,
      inputSchema: {}
    },
    async () => {
      const rows = await allGoals();
      return text(rows.length ? rows.map((g) => goalText(g)).join('\n\n') : 'No goals yet.');
    }
  );

if (has('propose_goal'))
  tool(
    'propose_goal',
    {
      description: `Offer ${OWNER} a goal you heard from them, for their yes. It lands on their desk; approving sets it, and then you plan it. One goal per ask, in their words. Never treat a goal as set before they approve it.`,
      inputSchema: {
        ...goalFields,
        heard: z.string().max(600).describe(`What ${OWNER} said that this comes from.`),
        revises: revisesArg
      }
    },
    async (a) => {
      const d = goalDraft({
        title: a.title,
        why: a.why,
        doneWhen: a.done_when,
        horizon: a.horizon,
        due: a.due,
        area: a.area
      });
      if (typeof d === 'string') return text(d);
      const { ask } = await raiseAsk(ME, {
        ...RAISED_ON,
        kind: 'goal',
        title: `Set a goal: ${d.title}`,
        why: a.heard,
        ifApproved: 'The goal is set. I plan who does what and bring you the plan.',
        goal: d,
        revises: a.revises
      });
      return text(`Ask ${ask.id} is on ${OWNER}'s desk.`);
    }
  );

if (has('propose_goal_plan'))
  tool(
    'propose_goal_plan',
    {
      description: [
        `Bring ${OWNER} the plan for one goal, in one ask: Odds already here who take on a part (with a new job or a change to one), new hires for work nobody here fits, and the steps only ${OWNER} can do. They tick the parts to go ahead with; each hire then opens in the hire window. Prefer Odds already here. Write each hire's job description to a file in your folder first.`,
        // A plan always goes on its goal's thread, with the raiser as hub (raiseAsk).
        `Once they approve it, you pick up on the goal and lead the work: you hand each piece to the Odd who does it, and you pick up there again as each hire joins.`
      ].join(' '),
      inputSchema: {
        goal_id: z.number().int(),
        why: z
          .string()
          .describe('The plan in two or three plain sentences: who does what, and why this way.'),
        assign: z
          .array(
            z.object({
              staff: z.string().describe("An Odd's id from office_report."),
              part: z.string().max(400).describe('What this Odd does for the goal, one line.'),
              new_job: z
                .object({
                  name: z.string(),
                  instructions: z.string(),
                  schedule: scheduleArg,
                  report: z.boolean().optional(),
                  missed: missedArg,
                  files: planFiles.optional()
                })
                .optional(),
              change_job: z
                .object({
                  name: z.string().describe('The job name, exactly as it is now.'),
                  new_name: z.string().trim().min(1).max(80).optional(),
                  files: planFiles.optional(),
                  instructions: z.string().optional(),
                  schedule: scheduleArg.optional(),
                  missed: missedArg
                })
                .optional()
            })
          )
          .max(6)
          .optional(),
        hires: z
          .array(
            z.object({
              ...hireFields,
              part: z.string().max(400).describe('What this hire does for the goal, one line.')
            })
          )
          .max(4)
          .optional(),
        owner_steps: z
          .array(z.string())
          .max(8)
          .optional()
          .describe(
            `What only ${OWNER} can do, one action per step, such as signing in to a tool or a choice that is theirs. Never a step that passes work or a request to an Odd: you hand work on with hand_off. They get these as a task.`
          ),
        attach: attachArg,
        revises: revisesArg
      }
    },
    async (a) => {
      const g = await goal(a.goal_id);
      if (!g) return text(`No goal #${a.goal_id}. Check list_goals.`);
      const here = new Set((await roster()).map((s) => s.id));
      const items: GoalPlanItem[] = [];
      for (const x of a.assign ?? []) {
        if (!here.has(x.staff)) return text(`No Odd "${x.staff}". Check office_report.`);
        items.push({
          kind: 'assign',
          staff: x.staff,
          part: x.part,
          job: x.new_job,
          editJob: x.change_job && {
            name: x.change_job.name,
            newName: x.change_job.new_name,
            instructions: x.change_job.instructions,
            schedule: x.change_job.schedule,
            files: x.change_job.files
          }
        });
      }
      for (const h of a.hires ?? []) {
        const hire = hireFrom(h);
        if (typeof hire === 'string') return text(hire);
        items.push({ kind: 'hire', hire, part: h.part });
      }
      if (!items.length) return text('A plan needs at least one Odd or hire.');
      const files = await attachable(a.attach);
      if ('problem' in files) return text(files.problem);
      const { ask } = await raiseAsk(ME, {
        ...RAISED_ON,
        kind: 'plan',
        title: `Plan for: ${g.title}`,
        why: a.why,
        ifApproved:
          'Odds already here take on their part at once. Each hire opens in the hire window, and your steps land on your desk.',
        plan: { goalId: g.id, items, ownerSteps: a.owner_steps },
        revises: a.revises,
        attach: files.paths,
        run: RUN_KEY
      });
      return text(`Ask ${ask.id} is on ${OWNER}'s desk.`);
    }
  );

tool(
  'keep_lesson',
  {
    description: `Remember a correction from ${OWNER}, so they never give it twice. Call it once when they correct your work or say how they want something done from now on, in chat, or in their answer to something you raised: "too long", "always copy Sam", "never book before 9". It works only in a chat, a run carrying ${OWNER}'s note on an ask or a task, or a run reading their edit to one of your files; in any other run it refuses, so tell them in your reply instead. Not for an instruction about this one piece of work only. ${OWNER} sees it in your chat as "I'll remember: ..." with Undo, so do not repeat it to them. It goes live in every later run at once when they said it; a lesson you inferred waits for their Keep.`,
    inputSchema: {
      lesson: z
        .string()
        .min(1)
        .max(240)
        .describe(
          'One plain sentence, written as what you will do: "Keep reports to three lines."'
        ),
      quote: z
        .string()
        .min(1)
        .max(400)
        .describe(
          `${OWNER}'s exact words it comes from, copied, not reworded: at least ${QUOTE_MIN_WORDS} words in a row.`
        ),
      how: z
        .enum(['said', 'inferred'])
        .describe(
          `said: their words state it as a rule. inferred: you are reading a rule into a one-off fix.`
        ),
      scope: z
        .enum(['me', 'everyone'])
        .default('me')
        .describe(
          `me, unless their words say it is for every Odd ("all of you", "everyone", "the whole office"), or they are saying how the office should work for them (how much to do without checking, what to hear about): those are for every Odd.`
        ),
      applies_to: z
        .string()
        .max(APPLIES_TO_MAX)
        .optional()
        .describe(
          `Where it applies, in a few plain words: "reports", "team emails", "family plans". Set it whenever their words or what they were correcting limit the lesson: said about a report, about emails, about family plans. Leave it out only when they meant everything you write.`
        ),
      replaces: z
        .number()
        .int()
        .optional()
        .describe('The id of a lesson of yours this one changes or corrects.'),
      why_replaced: z
        .enum(WHY_REPLACED)
        .optional()
        .describe(
          `Needed with replaces, and only then. missed: ${OWNER} corrected something the old lesson already covered, so they had to say it again. refined: ${OWNER} changed or narrowed what they want.`
        )
    }
  },
  async (a) => {
    const kept = await keepLesson(ME, {
      text: a.lesson,
      quote: a.quote,
      how: a.how,
      scope: a.scope,
      appliesTo: a.applies_to,
      replaces: a.replaces,
      whyReplaced: a.why_replaced,
      ownerWords: OWNER_WORDS
    });
    if ('problem' in kept) return text(kept.problem);
    const missed =
      a.why_replaced === 'missed'
        ? ` In your reply, say in one line that ${OWNER} told you this before and you missed it.`
        : '';
    return text(
      kept.status === 'live'
        ? `Lesson #${kept.id} is live from now on.${missed}`
        : `Lesson #${kept.id} waits for ${OWNER}'s Keep in your chat${OWNER_WORDS?.from === 'edit' ? `, as every lesson read from an edit does, and it is for you only` : a.how === 'said' ? `: the quote is not ${QUOTE_MIN_WORDS} or more of their words, word for word, from this run, so it counts as inferred` : ''}. Until they keep it, do not tell them you will do it from now on.${missed} Carry on with the work.`
    );
  }
);

tool(
  'used_lesson',
  {
    description: `Tell the office a lesson from "What ${OWNER} has taught you" changed this run's work. Call it once per lesson per run, only when the work would have come out different without it.`,
    inputSchema: { id: z.number().int() }
  },
  async ({ id }) => {
    const l = await usedLesson(id, ME);
    if (!l) return text(`Lesson #${id} is not a live lesson of yours.`);
    return text(
      l.uses <= CITE_FIRST
        ? `Noted. Say so in your reply, in one line, naming what you did and when ${OWNER} asked, like "Kept it to three lines, as you asked on ${shortDay(l.createdAt)}."`
        : 'Noted. No need to mention it.'
    );
  }
);

if (has('update_goal'))
  tool(
    'update_goal',
    {
      description: `Change a goal: mark it met, paused, dropped or active again, or reword it. When ${OWNER} asks in chat, do it at once. Outside a chat, only to carry out an ask they approved, passing its id. To propose it, raise_ask first.`,
      inputSchema: {
        goal_id: z.number().int(),
        status: z.enum(GOAL_STATUSES).optional(),
        title: goalFields.title.optional(),
        why: goalFields.why,
        done_when: goalFields.done_when,
        horizon: goalFields.horizon.optional(),
        due: goalFields.due,
        approved_ask: approvedArg
      }
    },
    async (a) => {
      const go = await goAhead(a.approved_ask);
      if ('problem' in go) return text(go.problem);
      const g = await goal(a.goal_id);
      if (!g) return text(`No goal #${a.goal_id}.`);
      const patch = Object.fromEntries(
        Object.entries({
          status: a.status,
          title: a.title,
          why: a.why,
          doneWhen: a.done_when,
          horizon: a.horizon,
          due: a.due
        }).filter(([, v]) => v !== undefined)
      );
      if (!Object.keys(patch).length) return text('Say what to change.');
      if ('said' in go)
        await record({
          kind: 'decision',
          actor: 'owner',
          title: `Asked ${me.name} in chat: change the goal "${g.title}"`,
          body: go.said
        });
      await updateGoal(g.id, patch, { staffId: ME, askId: 'askId' in go ? go.askId : undefined });
      return text(`Goal #${g.id} is changed.`);
    }
  );

if (has('edit_my_job'))
  tool(
    'edit_my_job',
    {
      description: `Change one of your own jobs: its name, steps, scheduled files, schedule, whether it reports to ${OWNER}, or what it does with runs it missed. When ${OWNER} asks for a change in chat, make it at once, worded the way they asked, then tell them what changed. Outside a chat, only to carry out an ask they approved, passing its id. To propose a change, raise_ask with the exact new steps first.`,
      inputSchema: {
        job: z.string().describe('The job name, exactly as my_jobs lists it.'),
        new_name: z.string().trim().min(1).max(80).optional(),
        files: jobFiles
          .nullable()
          .optional()
          .describe(
            'For recurring work on a thread you already serve. Null returns the job to independent work.'
          ),
        instructions: z.string().optional().describe('The full new steps, numbered.'),
        schedule: scheduleArg.optional(),
        report: z.boolean().optional(),
        missed: missedArg,
        approved_ask: approvedArg
      }
    },
    async ({ job, new_name, instructions, schedule, report, missed, files, approved_ask }) => {
      const go = await goAhead(approved_ask);
      if ('problem' in go) return text(go.problem);
      const j = await editOwnJob(
        ME,
        job,
        { name: new_name, instructions, schedule, report, missed, files },
        go
      );
      return text(j ? `Changed "${j.name}".` : `You have no job named "${job}". Check my_jobs.`);
    }
  );

/**
 * The job description this run last read: the one it began with, then each
 * one it saved or was shown. A save from it stops if the text changed since,
 * so the Odd never overwrites a newer edit by the owner.
 */
let myDescription = me.desk;

if (has('edit_my_description'))
  tool(
    'edit_my_description',
    {
      description: `Rewrite your own job description: the text that tells you who you are and how you work, which every run starts from. When ${OWNER} asks for a change in chat, make it at once, then tell them what changed. Outside a chat, only to carry out an ask they approved, passing its id. Pass the whole new description, keeping every part they did not ask to change. It takes effect from your next run.`,
      inputSchema: {
        description: z.string().min(1).max(20_000).describe('The full new job description.'),
        approved_ask: approvedArg
      }
    },
    async ({ description, approved_ask }) => {
      const go = await goAhead(approved_ask);
      if ('problem' in go) return text(go.problem);
      try {
        const changed = await setDescription(ME, description, { go, was: myDescription });
        myDescription = description.trim();
        return text(
          changed
            ? 'Your job description is changed. It applies from your next run.'
            : 'That is your job description already. Nothing changed.'
        );
      } catch (e) {
        if (!(e instanceof DescriptionChanged)) throw e;
        myDescription = e.current;
        return {
          ...text(
            `Nothing changed. Your job description changed since this run began, so your edit would undo the newer one. Here it is now:\n\n${e.current}\n\nMake your change on this text and pass the whole of it again.`
          ),
          isError: true
        };
      }
    }
  );
