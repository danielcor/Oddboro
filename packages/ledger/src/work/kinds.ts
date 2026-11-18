// The kinds of follow-up an Odd owes, and the rules each kind carries: whether
// its run serves a thread, and how far its run may act. Pure, so a decider can
// read it without the database.
import { levelAtMost, type Level } from '../access-words.ts';

/**
 * Work a staffer owes after the owner answers it: carry out an approved ask, rework
 * one the owner sent back, take in the reason for a no, pick up the work
 * that waited on a task the staffer gave them, or plan a goal the owner set. A
 * new hire with a job gets started without being asked by its `first_day`. A `hand_off` is
 * work a colleague handed it, and `handed_back` brings the result home. A
 * `resume` picks a thread back up for its hub: at the time the hub set, or with
 * the owner's answer when no other run follows it. An `answered` run hears the
 * owner's answer to something the staffer raised on no thread and no hand-off,
 * when no other run carries it. An `edited` run reads the owner's edit to one
 * of the staffer's files, for a lesson.
 */
export const FOLLOW_UP_KINDS = [
  'carry_out',
  'rework',
  'denied',
  'task_done',
  'goal',
  'first_day',
  'hand_off',
  'handed_back',
  'resume',
  'answered',
  'edited'
] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

/**
 * A `denied` run only reads the owner's reason for a lesson. The denial itself
 * already went back to the hand-off or thread the ask came from when the owner
 * answered, so the run serves neither: it joins no thread and hands
 * nothing back. An `edited` run only reads the owner's edit to a file, for a
 * lesson, and answers nothing raised anywhere. Neither run hands work on: the
 * office tells its tool server so (`LESSON_RUN`), which then offers no
 * `hand_off`.
 */
export const SERVES_NO_THREAD: Record<FollowUpKind, boolean> = {
  carry_out: false,
  rework: false,
  denied: true,
  task_done: false,
  goal: false,
  first_day: false,
  hand_off: false,
  handed_back: false,
  resume: false,
  answered: false,
  edited: true
};

/**
 * Whether a follow-up's run works at Draft at most by its kind alone: the
 * giver's pick-up of a hand-off's result, the hub picking its thread back up,
 * a run reading the owner's answer to something raised on no work, and a run
 * that only reads the owner's reason or edit for a lesson (every kind
 * `SERVES_NO_THREAD` marks). The owner's choice never lifts these. A
 * hand-off's own run, and a run of any other kind that serves one, works at
 * Draft at most too (`runsAtDraft`), but an approval ask's carry-out, unless
 * the owner lets the Odd act on its own on work from colleagues
 * (`staff.actsOnHandOffs`).
 */
export const AT_DRAFT: Record<FollowUpKind, boolean> = {
  carry_out: false,
  rework: false,
  denied: true,
  task_done: false,
  goal: false,
  first_day: false,
  hand_off: false,
  handed_back: true,
  resume: true,
  answered: true,
  edited: true
};
export const atDraft = (kind: FollowUpKind): boolean => AT_DRAFT[kind];

/**
 * Whether a follow-up's run works at Draft at most: a kind `AT_DRAFT` names,
 * or a run that serves a colleague's hand-off, so a colleague's words never
 * stand in for the owner's yes, even after a yes that raised this Odd's own
 * level or tools. The carry-out of an approval ask is the owner's yes to that
 * exact action, so it keeps the Odd's level and one yes stays one yes. The
 * owner can let an Odd act on its own on work from colleagues
 * (`actsOnHandOffs`): then every run that serves a hand-off keeps its level.
 * It never lifts a kind `AT_DRAFT` names.
 */
export const runsAtDraft = (run: {
  kind: FollowUpKind;
  serves: boolean;
  carriesApproval: boolean;
  actsOnHandOffs: boolean;
}): boolean => AT_DRAFT[run.kind] || (run.serves && !run.carriesApproval && !run.actsOnHandOffs);

/**
 * The level a run may act at: the Odd's own, or Draft when the run is held to
 * Draft and the Odd's level reaches it. An Odd at Read stays at Read.
 */
export const runCeiling = (level: Level, draftOnly: boolean | undefined): Level =>
  draftOnly && levelAtMost('draft', level) ? 'draft' : level;
