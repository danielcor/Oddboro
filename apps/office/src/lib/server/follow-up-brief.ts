// What a staffer is told, for each kind of follow-up. One case per kind, and
// no default, so a new kind of follow-up fails the type check here until it
// says what its run is told.
import {
  callResultText,
  clockTime,
  FOLDER_SAID,
  goalWhen,
  home,
  LEVEL_NAME,
  officeToolsSaid,
  shownFolder,
  SWITCH_NAMES,
  switchesSaid,
  zoneName
} from '@oddboro/ledger';
import type { AskRow, FollowUpRow, GoalRow, Level, TaskRow, Unparked } from '@oddboro/ledger';
import { flat, ownerAnswers, pickedUpLine } from '@oddboro/ledger/desk-answers';
import { workPath } from '@oddboro/ledger/work-paths';
import { filterWords } from '@oddboro/ledger/filters';
import { ACT_WRITE } from './house.ts';

/**
 * The wait this run's start ended (`startFollowUp`). The run is told, or it
 * would trust a park the office no longer holds and wait for a wake that never
 * comes.
 */
export function waitEnded(u: Unparked): string[] {
  const until =
    'task' in u
      ? `{owner} finished or dropped "${flat(u.task)}"`
      : `${clockTime(u.at)} ${zoneName()}`;
  return [
    `This work was parked until ${until}. That wait ended as this run started, so nothing brings you back for it now. If the work still needs to wait, park it again with resume_at.`,
    ''
  ];
}

/** The owner's answers a run reads, one a line: a hub's pick-up on its thread (`answerLead`), and an `answered` run. */
const answers = (note: string | null): string[] =>
  (note ?? '').split('\n').map((line) => `- ${line}`);

/** What the staffer is told, for each kind of follow-up. */
export function followUpBrief(
  f: FollowUpRow,
  a?: AskRow,
  t?: { row: TaskRow; files: string[] },
  g?: GoalRow,
  {
    also = [],
    draftOnly = false,
    level,
    actsOnHandOffs = false
  }: {
    /** Twins answered with `a` whose work this carry-out does too (`standsFor`). */
    also?: AskRow[];
    /** This run works at Draft at most, whatever the Odd's level (`draftOnly` in staff.ts). */
    draftOnly?: boolean;
    /** The Odd's level: only at Draft is it offered a standing yes after a call. */
    level?: Level;
    /** The owner lets this Odd act on its own on work from colleagues (`staff.actsOnHandOffs`). */
    actsOnHandOffs?: boolean;
  } = {}
): string[] {
  switch (f.kind) {
    case 'resume':
      return resumeBrief(f, a, g);
    case 'first_day':
      return firstDayBrief();
    case 'goal':
      return goalBrief(f, g);
    case 'task_done':
      return taskDoneBrief(f, t);
    case 'carry_out':
      return carryOutBrief(f, a, also, draftOnly, level, actsOnHandOffs);
    case 'denied':
      return deniedBrief(f, a);
    case 'rework':
      return reworkBrief(f, a);
    case 'answered':
      return answeredBrief(f);
    // A hand-off and a hand-back reach here only with their row or thread
    // missing, and an edit never does (`editBrief` comes first in staff.ts):
    // with nothing else to go on, each reads its note as the owner's feedback.
    case 'hand_off':
    case 'handed_back':
    case 'edited':
      return feedbackBrief(f);
    default: {
      const missed: never = f.kind;
      throw new Error(`No brief for a ${String(missed)} follow-up`);
    }
  }
}

function resumeBrief(f: FollowUpRow, a?: AskRow, g?: GoalRow): string[] {
  // The owner answered a plan raised on this thread. Sending one back is a
  // `rework` instead, so only an approval or a denial reaches a resume.
  if (a?.kind === 'plan') {
    const plan = g ? `your plan for goal #${g.id}, "${g.title}"` : `"${a.title}"`;
    const hires = a.plan?.items.some((i) => i.kind === 'hire')
      ? ' Odds the plan hires are not here yet: you pick up here again as {owner} hires each one, and hand it its first piece then.'
      : '';
    if (a.status === 'approved')
      return [
        `{owner} approved ${plan}. Start the work now. You lead it, here on the goal.`,
        '',
        ...answers(f.note),
        '',
        `1. Hand each piece of the work to the colleague who should do it, with hand_off, on the goal.${hires}`,
        '2. Each time a piece comes back, check it and hand on the next, until the goal is met or the next step waits on a time.',
        '3. To check a piece of work, prefer a colleague who did not do it.',
        '4. Tell {owner} only what needs them, with raise_ask or give_owner_a_task, and when something is ready to try, with poke_owner. Never ask them to pass work to an Odd: that is yours to do.'
      ];
    if (a.status === 'denied')
      return [
        `{owner} said no to ${plan}. Do not start any of it.`,
        '',
        ...answers(f.note),
        '',
        '1. If their answer says what they want instead, do that. A new plan goes through propose_goal_plan.',
        '2. Otherwise say so, and stop.'
      ];
  }
  // {owner} hired an Odd a plan of yours proposed, from its hire ask on this thread.
  if (a?.kind === 'hire' && a.status === 'approved' && g)
    return [
      `{owner} hired an Odd your plan for goal #${g.id}, "${g.title}", proposed. Carry on leading the work, here on the goal.`,
      '',
      ...answers(f.note),
      '',
      `1. Find each new Odd with list_goals: it serves goal #${g.id}, under the name {owner} hired it by.`,
      '2. It starts nothing on its own. Hand it its first piece the plan gives it now, with hand_off, on the goal.',
      "3. If its part waits on another's work, say so, and stop."
    ];
  // Each line says what it is: an answer to something raised on the thread,
  // what {owner} told a colleague about it in chat (`tellLead`), or the usage
  // window resetting on a thread it held (`wakeThread`).
  return f.note
    ? [
        'Word came for work you lead, and no run of yours has seen it yet. Pick it back up now.',
        '',
        ...answers(f.note)
      ]
    : ['The time you set to pick your work back up has come. Pick it up now.'];
}

function firstDayBrief(): string[] {
  return [
    'You joined the office today, and you just said hello to {owner} in chat. Get started now, so they never have to ask.',
    '',
    '1. Read your job description, notes/intake.md if you have one, my_goals and my_jobs.',
    '2. Check what the office already knows about your job: search relevant Ledger entries when you have access, and read relevant work already shared with you. For anything still missing, check the colleagues listed in your prompt. If one can help and you can hand off, give them the work and finish this run. Their answer brings you back.',
    '3. Give {owner} a task only for what still needs them after that check. A decision or preference only {owner} can make goes to {owner}, never to a colleague. Ask only the questions your intake and the office could not answer. Say why no colleague can do it, then stop.',
    `4. If a tool you need is not in my_access, ask for it with ask_for_access. For ${SWITCH_NAMES.commands} or ${SWITCH_NAMES.web}, ask with ask_for_switch when my_access says {owner} can switch it on.`,
    '5. Otherwise do the first piece of real work your job calls for, now: the first run of your job, or the first thing your job description says to do, so {owner} sees it today. Work for a goal you serve is not yours to start: the Odd who leads it hands you each piece.',
    '6. Your reply goes on their desk. Write it to {owner}: what you did, and what comes next.'
  ];
}

function goalBrief(f: FollowUpRow, g?: GoalRow): string[] {
  if (!g) return feedbackBrief(f);
  return [
    `{owner} set a new goal. Plan how the office meets it, and bring them the plan.`,
    '',
    `- Goal #${g.id}: ${g.title}`,
    `- When: ${goalWhen(g)}. Area: ${g.area}.`,
    ...(g.why ? [`- Why it matters: ${g.why}`] : []),
    ...(g.doneWhen ? [`- Done when: ${g.doneWhen}`] : []),
    '',
    '1. Read the office: office_report for each Odd, what it does, its level and the tools it holds or is waiting on, and list_goals for the goals they already serve.',
    `2. Work out who does what, how often, and with which tools (find_connectors). Give the work to Odds already here when one fits, with a new job or a change to one. Give a part to an Odd whose level and tools cover it. Never put a level raise or an office tool in owner_steps: the Odd asks for it itself with ask_for_level or ask_for_office_tool when its part needs it. For an outside tool an Odd lacks, have the Odd ask for it itself with ask_for_access when its officeTools include it, or put connecting it in owner_steps when they do not. For ${SWITCH_NAMES.commands} or ${SWITCH_NAMES.web}, never put switching it on in owner_steps: the Odd asks for it itself with ask_for_switch when its part needs it, and office_report says whether {owner} can switch it on for that Odd. Keep every other step only {owner} can do in owner_steps too. Hire only for work nobody here fits.`,
    '3. Read the brief and any answers already given. If a missing answer changes the plan, put only those questions in the response of give_owner_a_task, then stop. You pick up when they finish it.',
    "4. Otherwise bring the whole plan in one ask with propose_goal_plan. Write each hire's job description to a file first, and pass any intake as its intake_file.",
    '5. Once {owner} approves the plan, you pick up here on the goal and lead the work: you hand each piece to the Odd who does it. So its owner steps hold only what truly needs {owner}, such as signing in to a tool, never passing work or a request to an Odd.',
    '6. If the office already meets this goal as it is, say so and stop.'
  ];
}

function taskDoneBrief(f: FollowUpRow, t?: { row: TaskRow; files: string[] }): string[] {
  if (!t) return feedbackBrief(f);
  const answers = ownerAnswers(t.row.steps).map(
    (a) => `- They answered "${a.step}" with: ${a.answer}`
  );
  // Their message in the chat you gave it in, which may say what to do once it ends.
  const said = t.row.ownerSaid && flat(t.row.ownerSaid);
  return [
    `{owner} finished the task you gave them: "${t.row.title}". Pick up the work that waited on it now.`,
    '',
    `- Why you gave it: ${t.row.why}`,
    ...(said ? [`- What {owner} said in chat when you gave it: "${said}"`] : []),
    ...answers,
    ...(t.row.responseVersion
      ? [
          `- Use the owner's saved response (version ${t.row.responseVersion}) in this run's message.`
        ]
      : []),
    ...(f.note ? [`- Their note: ${f.note}`] : []),
    ...(t.files.length
      ? [
          // A file from a thread's folder is named from the office's folder, so the run gets where it is.
          `- ${t.row.responseVersion ? 'Reference files' : 'Attached, with anything they filled in'}: ${t.files.map((f) => (workPath(f) ? home(f) : f)).join(', ')}. Read each one first.`
        ]
      : []),
    ...(f.pickedUp ?? []).map((title) => `- ${pickedUpLine(title)}`),
    '',
    '1. Read what they gave you: the files above, their answers and their note.',
    `2. Do ${said ? 'what they asked for in chat, or ' : ''}the next step you told them would follow, now. When it needs their yes, such as a hire, a change outside the office ${ACT_WRITE}, or a new job, raise it with the tool for it (propose_goal_plan for a goal, propose_hire, raise_ask and the rest).`,
    '3. If something you need is missing or unclear, put one short question on their desk with give_owner_a_task, then stop.',
    '4. If nothing was waiting on this task, say so and stop.'
  ];
}

/** What the ask said, for the runs that answer one. */
function askLinesOf(a?: AskRow): string[] {
  return a
    ? [
        `- Ask #${a.id}: ${a.title}`,
        `- Why: ${a.why}`,
        `- What you said would happen: ${a.ifApproved}`,
        ...carriedLinesOf(a)
      ]
    : [];
}

/**
 * What the ask carries, by its kind. A new kind fails the type check here
 * until it says what its run is shown.
 */
function carriedLinesOf(a: AskRow): string[] {
  switch (a.kind) {
    case 'reply':
      return a.reply
        ? [
            `- The reply: to ${a.reply.to.join(', ')}${a.reply.cc.length ? `, cc ${a.reply.cc.join(', ')}` : ''}${a.reply.gmailThreadId ? `, in Gmail thread ${a.reply.gmailThreadId}` : ''}${a.reply.inReplyTo ? `, answering message ${a.reply.inReplyTo}` : ''}`,
            `- Its subject: ${a.reply.subject}`,
            '- Its body:',
            '',
            a.reply.body,
            ''
          ]
        : [];
    case 'filter':
      return a.filter
        ? [`- The filter: ${filterWords(a.filter)}`, `- Its summary: ${a.filter.summary}`]
        : [];
    case 'folder':
      return a.folder
        ? [
            `- The folder you asked for: ${shownFolder(a.folder.path)} (${FOLDER_SAID[a.folder.level]})`
          ]
        : [];
    case 'switch':
      return a.switches?.length ? [`- What you asked to turn on: ${switchesSaid(a.switches)}`] : [];
    case 'level':
      return a.level ? [`- The level you asked for: ${LEVEL_NAME[a.level]}`] : [];
    case 'office_tool':
      return a.officeTools?.length
        ? [`- What you asked to turn on: ${officeToolsSaid(a.officeTools)}`]
        : [];
    case 'call':
      return a.call
        ? [
            `- The call: ${a.call.tool} on ${a.call.connector}, with ${JSON.stringify(a.call.arguments)}`,
            ...(a.call.result ? [`- What it returned: ${callResultText(a.call.result)}`] : [])
          ]
        : [];
    case 'approval':
    case 'access':
    case 'hire':
    case 'goal':
    case 'plan':
    case 'hand_offs':
    case 'window':
    case 'remove':
    case 'bring_back':
    case 'catch_up':
    case 'standing':
      return [];
  }
}

/**
 * The carry-out run's brief, by the kind of ask approved. A new kind fails
 * the type check here until it says which brief its yes gets.
 */
function carryOutBrief(
  f: FollowUpRow,
  a: AskRow | undefined,
  also: AskRow[],
  draftOnly: boolean,
  level?: Level,
  actsOnHandOffs = false
): string[] {
  // A connect task's end starts this run and wakes the work parked on that task at once.
  const askLines = [...askLinesOf(a), ...(f.pickedUp ?? []).map((t) => `- ${pickedUpLine(t)}`)];
  const alsoAnswers = (what: string) =>
    also.length
      ? [
          `This also answers your ${also.length > 1 ? 'asks' : 'ask'} ${also.map((x) => `#${x.id}`).join(', ')}, which another of your runs raised for the same ${what}: do that work once, here.`
        ]
      : [];
  const approved = () => [
    `{owner} approved your ask #${a?.id}. Carry it out now.`,
    '',
    ...askLines,
    `- Their reason: ${f.note ?? 'none given'}`,
    '',
    '1. Do what they approved, and nothing beyond it.',
    '2. If you cannot finish without something from {owner}, put it on their desk with raise_ask or give_owner_a_task, with everything needed to finish, then stop.'
  ];
  switch (a?.kind) {
    case 'folder': {
      // What the owner gave for a folder ask, which may be narrower than it asked.
      const given = a.folder?.given;
      if (!given) return approved();
      return [
        `{owner} approved your ask #${a.id} and gave you ${shownFolder(given.path)} (${FOLDER_SAID[given.level]}). This run reaches it.`,
        ...alsoAnswers('folder'),
        '',
        ...askLines,
        `- Their reason: ${a.reason ?? 'none given'}`,
        '',
        '1. Check you can reach it: list the folder.',
        '2. If work was waiting on it, do it now, within what they gave you. If they gave less than you asked and the work needs more, say so in your reply.',
        '3. If nothing was waiting, stop there.'
      ];
    }
    case 'switch':
      return [
        `{owner} approved your ask #${a.id} and turned on ${switchesSaid(a.switches ?? [])} for you. This run has it.`,
        ...(also.length
          ? [
              `This also answers your ${also.length > 1 ? 'asks' : 'ask'} ${also.map((x) => `#${x.id}`).join(', ')}, which another of your runs raised for the same: do that work once, here.`
            ]
          : []),
        '',
        ...askLines,
        `- Their reason: ${a.reason ?? 'none given'}`,
        '',
        '1. If work was waiting on it, do it now.',
        '2. If nothing was waiting, stop there.'
      ];
    case 'level': {
      if (!a.level) return approved();
      const said = `{owner} approved your ask #${a.id} for the ${LEVEL_NAME[a.level]} level`;
      return [
        // A yes to Draft reaches a run held to Draft anyway, so only a yes to Act
        // carried out in one says the run does not have it. A level carry-out is
        // held to Draft only when it serves a colleague's hand-off and the owner
        // chose to be asked first on such work (staff.ts), as the line says.
        ...(a.level !== 'act'
          ? [`${said}, and this run has it.`]
          : draftOnly
            ? [
                `${said}. Your own work runs at ${LEVEL_NAME[a.level]} from now on; this run serves a colleague's hand-off, so it works at Draft at most.`
              ]
            : [
                `${said}, and this run has it.`,
                actsOnHandOffs
                  ? '{owner} lets you act on your own on work a colleague hands you, so it runs at Act too. A thread you pick back up still runs at Draft at most.'
                  : 'Work a colleague hands you, and a thread you pick back up, still runs at Draft at most.'
              ]),
        ...alsoAnswers('level'),
        '',
        ...askLines,
        `- Their reason: ${a.reason ?? 'none given'}`,
        '',
        '1. If work was waiting on it, do it now.',
        '2. If nothing was waiting, stop there.'
      ];
    }
    case 'office_tool':
      if (!a.officeTools?.length) return approved();
      return [
        `{owner} approved your ask #${a.id} and turned on ${officeToolsSaid(a.officeTools)} for you. This run has ${a.officeTools.length > 1 ? 'them' : 'it'}.`,
        ...alsoAnswers('office tools'),
        '',
        ...askLines,
        `- Their reason: ${a.reason ?? 'none given'}`,
        '',
        '1. If work was waiting on it, do it now.',
        '2. If nothing was waiting, stop there.'
      ];
    case 'access':
      if (!a.access) return approved();
      return [
        `{owner} approved your ask #${a.id}, and the access is ready now.`,
        ...alsoAnswers('tool'),
        '',
        ...askLines,
        '',
        '1. Check the tool answers: one small read.',
        '2. If work was waiting on this access, do it now.',
        '3. If nothing was waiting, stop there.'
      ];
    case 'call':
      if (!a.call) return approved();
      return [
        `{owner} said yes to your call #${a.id}, and the office made it for you. Do not make it again.`,
        '',
        ...askLines,
        '',
        '1. Carry on with the work that waited on it, using what it returned.',
        '2. If it failed, say so plainly and what you would try instead. Do not call it again without a reason {owner} would want.',
        '3. If nothing more waited on it, stop there.',
        // Where a Draft Odd notices a stage-then-commit service, and offers to stop
        // asking for the stage. At Act a standing yes changes nothing, and a call
        // that failed made nothing to apply.
        ...(level === 'draft' && a.call.result?.ok
          ? [
              `4. If this call only prepared a change (a preview, a staged edit, a draft) and another call makes it real, make that call now: it waits for {owner}'s yes as this one did. Then offer ask_for_standing_yes once for ${a.call.tool}, so {owner} approves only the call that makes a change real.`
            ]
          : [])
      ];
    case undefined:
    case 'approval':
    case 'hire':
    case 'goal':
    case 'plan':
    case 'hand_offs':
    case 'window':
    case 'reply':
    case 'filter':
    case 'remove':
    case 'bring_back':
    case 'catch_up':
    case 'standing':
      return approved();
  }
}

function deniedBrief(f: FollowUpRow, a?: AskRow): string[] {
  const askLines = askLinesOf(a);
  return [
    `{owner} turned down your ask #${a?.id}, and said why.`,
    '',
    ...askLines,
    `- Their reason: ${f.note}`,
    '',
    '1. If the reason tells you how they want things done from now on, keep_lesson with their words.',
    '2. Do not carry out the ask, and do not raise it again.',
    '3. If the reason asks for something else instead, raise that as a new ask.'
  ];
}

function reworkBrief(f: FollowUpRow, a?: AskRow): string[] {
  const askLines = askLinesOf(a);
  return [
    `{owner} sent your ask #${a?.id} back. Rework it the way they say, then bring it back.`,
    '',
    ...askLines,
    `- What they want changed: ${f.note}`,
    '',
    '1. Do any work the new version needs first, such as rewriting a file in your folder.',
    `2. Raise the new version with the same tool as before (raise_ask, propose_reply, propose_filter, propose_hire, ask_for_access, ask_for_folder, ask_for_switch, ask_for_level, ask_for_office_tool, propose_goal or propose_goal_plan), or the one their note calls for, passing revises: ${a?.id}.`,
    '3. Do not carry out the ask itself. They decide the new version.'
  ];
}

/**
 * The owner answered something the Odd raised on no thread and no hand-off:
 * nothing else carries the answer back, so this run hears it.
 */
function answeredBrief(f: FollowUpRow): string[] {
  return [
    '{owner} answered something you raised:',
    '',
    ...answers(f.note),
    '',
    '1. If it changes what you should do, do it now.',
    '2. Otherwise say so, and stop.'
  ];
}

function feedbackBrief(f: FollowUpRow): string[] {
  return [
    '{owner} gave feedback. Work out what it means, then act on it.',
    '',
    `- Their feedback: ${f.note}`,
    '',
    '1. Work inside the office that they asked for, such as notes or a file in your folder, do now.',
    `2. Anything that changes one of your jobs, or something outside the office ${ACT_WRITE}: raise_ask first, one exact action per ask.`,
    '3. Anything only they can do goes on their desk with give_owner_a_task.',
    '4. If the feedback needs nothing done, say so.'
  ];
}
