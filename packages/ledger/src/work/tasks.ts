// A task on the owner's desk from given to ended: an Odd or the office gives
// it, and the owner finishes or drops it, or it is taken off the desk. Each
// decider mirrors the database code it replaces, named on each, and takes
// every fact from the loaded rows.
//
// Pure: every import that reaches the database is a type.
import { ownerAnswers, pickedUpLine } from '../desk-answers.ts';
import type { InChat } from '../schema.ts';
import { stepsToGo } from '../tools.ts';
import type { After, Decided } from '../transition.ts';
import {
  ANSWERED_ALREADY,
  answerBack,
  offWorkAnswer,
  answeredWith,
  ownRunOf,
  startCarryOuts,
  taskAnswer,
  taskEffects,
  wakeParked
} from './answers.ts';
import type { EventOf } from './events.ts';
import {
  changeOf,
  draft,
  filled,
  putAll,
  type Change,
  type LedgerLine,
  type WorkRows
} from './snapshot.ts';
import { type Task, type Thread } from './state.ts';
import { hasLeft, LEFT_RAISES_NOTHING, oweRun, raisedOn } from './threads.ts';

/** Whether a step of the task connects this tool; with `aws`, only an AWS step counts. */
export const connects = (t: Pick<Task, 'steps'>, connector: string, aws = false): boolean =>
  t.steps.some(
    (s) =>
      !!s.action &&
      'connector' in s.action &&
      s.action.connector === connector &&
      (!aws || s.action.kind === 'aws')
  );

/** The open tasks, by id. */
const openTasks = (rows: WorkRows): Task[] =>
  [...rows.tasks.values()].filter((t) => t.status === 'open').sort((a, b) => a.id - b.id);

/**
 * A task goes on the owner's desk, as `giveTask` in office-tasks.ts does. A
 * connect task the office gives (`oneOpen`, as `reconnectTask` and
 * `changeAwsTask` in office-access.ts give them) is not given twice: an open
 * one with a step for that tool answers it, the Odd's own when it has an Odd.
 * Given on a thread, it keeps the thread open until the owner answers
 * (`raisedOn`). The repeat refusal stays in the entry, under its desk lock.
 */
export function taskGiven(
  rows: WorkRows,
  e: EventOf<'taskGiven'>,
  now: Date
): Decided<Change<{ already: number } | null>> {
  const { task: k, oneOpen } = e;
  if (k.staffId && hasLeft(rows, k.staffId)) return { refused: LEFT_RAISES_NOTHING };
  const there = oneOpen
    ? openTasks(rows).find(
        (t) =>
          (k.staffId === null || t.staffId === k.staffId) &&
          connects(t, oneOpen.connector, oneOpen.aws)
      )
    : undefined;
  if (there) return { change: changeOf(draft(rows), { already: there.id }), after: [] };

  // A task the office gives itself has no Odd, so no files of one.
  const d = draft(
    rows,
    k.staffId && e.attach?.length
      ? [{ kind: 'attachments', staffId: k.staffId, paths: e.attach, to: { task: 'task' } }]
      : []
  );
  const empty = {
    askId: null,
    handOffId: null,
    threadId: null,
    via: null,
    ownerSaid: null,
    response: null
  };
  putAll(d, [
    {
      table: 'tasks',
      ref: 'task',
      insert: {
        ...filled(empty, k),
        responseVersion: 0,
        note: null,
        createdAt: now,
        status: 'open'
      }
    }
  ]);
  if (k.threadId) raisedOn(d, k.threadId, { run: e.run, by: k.staffId, plan: false }, now);
  return { change: changeOf(d, null), after: [] };
}

/** The open threads parked on a task, by id: the work its end wakes. */
const parkedOn = (rows: WorkRows, taskId: number): Thread[] =>
  [...rows.threads.values()]
    .filter((t) => t.status === 'open' && t.park.on === 'task' && t.park.task === taskId)
    .sort((a, b) => a.id - b.id);

/**
 * The owner finished or dropped a task, or the office or its Odd took it off
 * the desk (`withdrawn`), as `finishTask` in office-tasks.ts and
 * `withdrawTask` in office-decide.ts end it. What its end starts follows its
 * row in `OWNER_ANSWERS` (`taskEffects`). Work parked on it wakes, and each
 * run that picks up is told of the other, so neither does the other's part.
 */
export function taskEnded(
  rows: WorkRows,
  e: EventOf<'taskEnded'>,
  now: Date
): Decided<Change<null>> {
  const t = rows.tasks.get(e.id);
  if (t?.status !== 'open') return { refused: ANSWERED_ALREADY };
  const done = e.ended === 'done';
  if (done && t.response !== null) {
    if (!t.responseVersion || e.responseVersion !== t.responseVersion)
      return { refused: 'Review and save your response before marking this task done.' };
    if (stepsToGo(t.steps))
      return { refused: 'Finish the required steps before marking this task done.' };
  }
  const { status: _, ...base } = t;
  const note = e.note || null;
  const ended: Task = done
    ? { ...base, note, status: 'done', doneAt: now }
    : { ...base, note, status: 'dropped', doneAt: now, withdrawn: e.ended === 'withdrawn' };
  const owner = rows.owner;
  const words = taskAnswer(ended);
  const byOwner = e.ended !== 'withdrawn';
  const answers = ownerAnswers(t.steps);
  const line: LedgerLine = {
    kind: 'work',
    actor: 'owner',
    title: `${done ? 'Done' : 'Dropped'} by ${owner}: ${t.title}`,
    // Answers first: search_ledger shows the first 400 characters, and a long why would cut them off.
    body: [...answers.map((a) => `${a.step} ${a.answer}`), t.why].join('\n'),
    // Their saved response and note are their answer, or a choice they tapped when they wrote neither.
    reason: words ?? (answers.map((a) => a.answer).join('\n') || null),
    taskId: t.id
  };
  // The owner's line is written with the end; a withdrawal's after it, as today.
  const d = draft(rows, byOwner ? [{ kind: 'record', line }] : []);
  putAll(d, [{ table: 'tasks', row: ended }]);
  const said = byOwner
    ? `${owner} ${done ? 'finished' : 'dropped'} "${t.title}"${words ? `: ${words}` : '.'}`
    : (note ?? '');
  const chat: InChat | undefined =
    e.inChat && t.staffId
      ? { staffId: t.staffId, card: { kind: 'task', id: t.id, title: t.title } }
      : undefined;

  const { from, effects, on, offWorkOdd } = taskEffects(rows, ended);
  // Read before the effects: waking the parked work clears what parks it.
  const parked = parkedOn(rows, t.id);
  const ownRun = parked.length ? ownRunOf(d.rows, ended) : undefined;
  const pickedUp = parked.length ? parked.map((p) => p.title) : undefined;
  for (const effect of effects) {
    switch (effect) {
      // A dropped task's answer goes back to its hand-off or thread, with no
      // chat card, as today. On no work it is the `answered` run of the Odd
      // that gave it (`offWorkAnswer`), unless taken off the desk.
      case 'answer_back': {
        const answer = [said, ...parked.map((p) => pickedUpLine(p.title))].join(' ');
        if (offWorkOdd)
          offWorkAnswer(
            d,
            { staffId: offWorkOdd, item: 'task', ids: [t.id], asked: t.id, line: answer, chat },
            now
          );
        else answerBack(d, on, { outcome: done ? 'done' : 'failed', answer }, now);
        break;
      }
      // The owner finished connecting a tool an Odd asked for: the work that
      // waited on it starts, once however many asks that one answer settled.
      case 'carry_out':
        if (t.staffId && from)
          startCarryOuts(d, [from, ...answeredWith(rows, from)], { pickedUp }, now);
        break;
      // Any other task an Odd gave them: the Odd picks up whatever waited on it.
      case 'task_done':
        if (t.staffId)
          oweRun(
            d,
            { staffId: t.staffId, kind: 'task_done', taskId: t.id, note, pickedUp },
            { chat },
            now
          );
        break;
      // Work on another thread that waited on this task, whoever gave it.
      case 'wake_parked':
        wakeParked(
          d,
          { ...ended, note: taskAnswer(ended) },
          { ended: e.ended, ...(ownRun && { ownRun }) },
          now
        );
        break;
      default:
        effect satisfies never;
    }
  }
  const after: After[] = byOwner
    ? []
    : [
        {
          record: {
            kind: 'work',
            actor: 'office',
            title: `Withdrawn: ${t.title}`,
            body: said,
            taskId: t.id
          }
        }
      ];
  return { change: changeOf(d, null), after };
}

/**
 * A tool's connect tasks go, as `dropConnectTasks` in office-access.ts drops
 * them: each open task with a step for the tool, the Odd's own when one is
 * named, ends dropped, with its time, and the work parked
 * on each wakes. It tells no one else, as today. Nothing to drop is an
 * empty change.
 */
export function connectTasksDropped(
  rows: WorkRows,
  e: EventOf<'connectTasksDropped'>,
  now: Date
): Decided<Change<null>> {
  const stale = openTasks(rows).filter(
    (t) => (e.staffId === undefined || t.staffId === e.staffId) && connects(t, e.connector)
  );
  const dropped = stale.map(({ status: _, ...base }): Task => ({
    ...base,
    status: 'dropped',
    doneAt: now,
    withdrawn: false
  }));
  const d = draft(rows);
  putAll(
    d,
    dropped.map((row) => ({ table: 'tasks', row }) as const)
  );
  for (const t of dropped) wakeParked(d, t, { ended: 'dropped' }, now);
  return { change: changeOf(d, null), after: [] };
}
