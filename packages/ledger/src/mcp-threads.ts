// Tools for threads: handing work on, parking it, and telling the lead.
import { z } from 'zod';
import { roster } from './office.ts';
import { goalsFor } from './goals.ts';
import { handOff } from './hand-offs.ts';
import { parkOnTask } from './task-parking.ts';
import { HAND_OFF_LIMIT, handOffsWord, parkThread, PASS_ONLY_WORK, tellLead } from './threads.ts';
import { THREADS_DIR } from './work-paths.ts';
import { MAIL_FILES_MAX } from './mail-attachments.ts';
import { FOLDER, heldTools, lacking, toolNames, WEB, type Tool } from './sharing.ts';
import { clockTime, officeAt } from './time.ts';
import {
  ME,
  OWNER,
  ZONE,
  OWNER_SAID,
  OWNER_FILES,
  THREAD_ID as threadIdOfRun,
  RUN_KEY,
  HANDS_OFF,
  filesForHandOff,
  attachedForLead,
  tool,
  text,
  notHanded,
  notParked
} from './mcp-run.ts';
import { workingOn, placed } from './mcp-desk.ts';
import './mcp-own-work.ts';

// An imported binding does not narrow inside closures; this local one does, as in one file.
const THREAD_ID = threadIdOfRun;

if (HANDS_OFF.tool) {
  const colleagues = (await roster()).filter((s) => s.id !== ME);
  const serving = await goalsFor(ME);
  const held = await heldTools([ME, ...colleagues.map((c) => c.id)]);
  /** One of this Odd's tools as its colleague line names it: "the web", "your folder ~/x", "your Gmail". */
  const yours = (t: Tool) =>
    t.id === WEB ? t.name : t.id.startsWith(FOLDER) ? `your folder ${t.name}` : `your ${t.name}`;
  /** Each colleague's line, with the tools of this Odd's it lacks. */
  const lines = colleagues.map((c) => {
    const lacks = lacking(held, c.id, [ME]);
    return `- ${c.id}: ${c.name}, ${c.role}. ${c.remit}${lacks.length ? ` Lacks ${toolNames(lacks.map(yours))}.` : ''}${c.package ? ' Their replies come from New Altitude, so what you hand them leaves this computer.' : ''}${c.permission === 'act' && c.actsOnHandOffs ? ` ${OWNER} lets them act on their own on work you hand them.` : ''}`;
  });
  tool(
    'hand_off',
    {
      description: [
        `Hand a colleague a piece of work their job covers. They start on it at once, in a run of their own, and when they finish, you pick up in a fresh run with their result. Do not wait for it: finish this run.`,
        THREAD_ID
          ? `It goes on work ${THREAD_ID}, the work this run is on.`
          : `A hand-off starts work you lead: each time work comes back you pick the next step in a fresh run, and you may hand on again in it, set a time to pick it back up, or ask ${OWNER}. Those runs see the work, not this conversation, so put what ${OWNER} asked for in request, with every later step and condition. For more of the same as work you lead, even finished work, set continue_work instead: it keeps that work's folder, files and history, and finished work reopens for a new round.`,
        `A round of work takes up to ${HAND_OFF_LIMIT} hand-offs. The one after that waits: the office asks ${OWNER} whether the work keeps going. A yes starts that hand-off as you wrote it, the first of another round, and a no stops the work.`,
        `Write the brief for them: what to do, why, and what to send back. Give them everything they need and nothing more: pass on details about ${OWNER}'s family, or anything from a goal they do not serve, only when their job covers it.`,
        `Describe the work and the result you need, never which tools to use: each colleague may run on another coding tool, with tools of its own.`,
        `Never copy anything from a tool the colleague lacks (the list below says which of yours) into the brief or the folder without ${OWNER}'s yes. If the work needs it, raise_ask first, naming the tool and what goes to whom, and hand off once they say yes.`,
        `Their run works at Draft at most and cannot hand on, so they can prepare, research and draft, but anything outward goes to ${OWNER} as an ask. The list says who ${OWNER} lets act on their own on work you hand them instead. Your pick-up works at Draft at most too.`,
        colleagues.length ? `Your colleagues:\n${lines.join('\n')}` : 'You have no colleagues yet.'
      ].join('\n\n'),
      inputSchema: {
        to: z.string().describe("The colleague's id, from the list."),
        title: z.string().min(1).max(120).describe('This piece of the work, in one line.'),
        brief: z
          .string()
          .min(1)
          .max(4000)
          .describe('What to do, why, and what to send back. Name any files in files.'),
        files: z
          .array(z.string())
          .max(MAIL_FILES_MAX)
          .optional()
          .describe(
            `Files the work needs: one in your folder, by its path inside it or its full path, or one in the folder of work you are on, from ${THREADS_DIR}/. Pictures and files ${OWNER} attached in chat are in attachments/ in your folder. They land in this work for your colleague. Never one from a tool your colleague lacks, without ${OWNER}'s yes.`
          ),
        request: z
          .string()
          .min(1)
          .max(600)
          .optional()
          .describe(
            `When this starts new work: what ${OWNER} asked for, in full, with any later steps or conditions (a pause, who checks it). Your later runs on the work see this. Defaults to title.`
          ),
        goal: z
          .number()
          .int()
          .optional()
          .describe(
            'When this starts new work: the id of a goal you serve that it is for, if any.'
          ),
        // A run on a thread hands on in it, so only a run on none may name one, or open one.
        ...(THREAD_ID
          ? {}
          : {
              continue_work: z
                .number()
                .int()
                .optional()
                .describe(
                  `The number of work you lead, as your instructions number it, when this is more of it. Leave out request and goal: it keeps its own. Leave this out for new work.`
                )
            })
      }
    },
    async ({ to, title, brief, files, request, goal, continue_work }) => {
      if (continue_work !== undefined && (request !== undefined || goal !== undefined))
        return notHanded(
          `Work ${continue_work} keeps its own request and goal. Leave out request and goal, put what is new in the brief, and call hand_off again.`
        );
      if (goal !== undefined && !serving.some((g) => g.id === goal))
        return notHanded(
          `Goal #${goal} is not one you serve. Leave goal out, or name one you serve, and call hand_off again.`
        );
      const on = THREAD_ID ?? continue_work;
      if (on === undefined) {
        const opens = await placed({});
        if ('problem' in opens) return notHanded(opens.problem);
      }
      const picked = await filesForHandOff(files ?? [], on);
      if ('problem' in picked) return notHanded(picked.problem);
      const r = await handOff({
        from: ME,
        to,
        work: { title, brief, ...(picked.here.length ? { files: picked.here } : {}) },
        thread: on !== undefined ? { id: on } : { title: request ?? title, goalId: goal },
        run: RUN_KEY,
        carry: picked.carry
      });
      if ('problem' in r) return notHanded(r.problem);
      const name = colleagues.find((c) => c.id === to)?.name ?? to;
      // Held, not refused: the ask keeps it, so the lead must not hand it on again.
      if ('asked' in r)
        return text(
          `This round of work ${r.thread} has taken its ${HAND_OFF_LIMIT} hand-offs, so "${title}" waits on ${OWNER}'s answer to ask #${r.asked}. On a yes it goes to ${name} exactly as you wrote it, as the first hand-off of a new round, and you pick up in a fresh run when they finish. On a no the work stops, and you hear so. There is nothing more for you to do for it: do not hand it on again. Say so, and finish this run.`
        );
      // Named by colleague and title, as the thread's steps are: a follow-up's id
      // means nothing to the Odd or to the owner.
      return text(
        [
          `Handed "${title}" to ${name}, on work ${r.thread}. They start now. You pick up in a fresh run when they finish.`,
          `${handOffsWord(r.left)} left this round.`
        ].join('\n')
      );
    }
  );

  if (THREAD_ID)
    tool(
      'resume_at',
      {
        description: `Pick work ${THREAD_ID} back up at a time you set, or when a task ends: the office starts a fresh run of yours on it then, with its history. Use it when the next step has to wait for a time, or for a task on ${OWNER}'s desk on other work, not for a colleague or for ${OWNER} on this work. A new time or task replaces the old. Then finish this run.`,
        inputSchema: {
          at: z.string().optional().describe(`${ZONE}: "18:50" for today, or "2026-11-02 18:50".`),
          in_minutes: z
            .number()
            .int()
            .min(1)
            .max(10_080)
            .optional()
            .describe('Instead of at: how many minutes from now.'),
          after_task: z
            .number()
            .int()
            .optional()
            .describe(
              `Instead of a time: the number of a task on ${OWNER}'s desk, on other work, that you gave or that is on work you are on. You pick this work up when they finish it or drop it.`
            )
        }
      },
      async ({ at, in_minutes, after_task }) => {
        if (after_task !== undefined) {
          if (at !== undefined || in_minutes !== undefined)
            return notParked('Give after_task alone, or a time alone, not both.');
          const parked = await parkOnTask(ME, THREAD_ID, after_task);
          if ('problem' in parked) return notParked(parked.problem);
          return text(
            `Work ${THREAD_ID} picks back up when ${OWNER} finishes or drops "${parked.title}".`
          );
        }
        const when =
          in_minutes !== undefined
            ? new Date(Date.now() + in_minutes * 60_000)
            : at
              ? officeAt(at)
              : undefined;
        if (!when)
          return text(`Say when: at as "HH:MM" or "YYYY-MM-DD HH:MM" in ${ZONE}, or in_minutes.`);
        if (when.getTime() <= Date.now()) return text('That time has passed. Pick a later one.');
        const set = await parkThread(ME, THREAD_ID, when);
        return text(
          set
            ? `Work ${THREAD_ID} picks back up at ${clockTime(set)} ${ZONE}.`
            : `Work ${THREAD_ID} has ended, or is not work you lead.`
        );
      }
    );
}

// Only in a chat (`inChat` on its row), and only for threads this Odd works on
// and does not lead: their words reach the lead as theirs, and the Odd's own
// only as its reading.
if (workingOn.length)
  tool(
    'tell_lead',
    {
      description: `Pass what ${OWNER} just told you about work you are on to the Odd who leads it, which picks it back up with their words. Copy the part of their message about that work exactly: it goes as theirs.${OWNER_FILES.length ? ` Every file they attached to it goes too, into your part of that work's folder.` : ''} Then tell ${OWNER} you passed it on. ${PASS_ONLY_WORK} The work you are on:\n${workingOn.map((t) => `- ${t.id}: ${t.title}, led by ${t.lead}`).join('\n')}`,
      inputSchema: {
        work: z.number().int().describe('The number of the work, from the list.'),
        words: z
          .string()
          .min(1)
          .max(4000)
          .describe(`The part of ${OWNER}'s message about this work, copied exactly.`),
        reading: z
          .string()
          .min(1)
          .max(600)
          .describe(
            'What you understood them to mean, in your own words. The lead reads it as yours, never as theirs.'
          )
      }
    },
    async ({ work, words, reading }) => {
      const r = await tellLead({
        staffId: ME,
        threadId: work,
        // `inChat` offers it only where the office sets OWNER_SAID. With none,
        // no words match, so tellLead refuses and nothing reaches the lead.
        said: OWNER_SAID ?? '',
        words,
        reading,
        exchange: process.env.CHAT_EXCHANGE || undefined,
        files: await attachedForLead()
      });
      if ('problem' in r) return text(r.problem);
      const files = r.files ?? [];
      const went = files.filter((f) => 'at' in f).length;
      const left = files.flatMap((f) => ('why' in f ? [`${f.named}, since ${f.why}`] : []));
      return text(
        [
          `Passed to ${r.lead}, who picks work ${work} back up with ${OWNER}'s words.`,
          ...(went ? [`The ${went === 1 ? 'file' : `${went} files`} they attached went too.`] : []),
          ...(left.length ? [`Did not go: ${left.join('; ')}. Tell ${OWNER} so.`] : [])
        ].join(' ')
      );
    }
  );
