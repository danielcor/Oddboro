// One entry for each run, from waiting for a slot through process exit.
// The clock still owns which jobs are due. This registry owns live execution.
import { randomUUID } from 'node:crypto';
import type { UsageKind } from './schema.ts';

export type WorkAbout = {
  key: string;
  kind: 'job' | 'goal';
  id: number;
  title: string;
  leadId: string;
  lead: string;
};

export type Work = {
  /** Unique while the office runs. A follow-up yet to start is its row's id, below zero. */
  id: number;
  kind: 'job' | 'follow-up' | 'draft';
  /** The job's name or the ask's title. */
  label: string;
  /** What kind of work it is, in a few words: "Carrying out ask #20". */
  detail: string;
  /** When it started, or joined the line for a slot. */
  since: string;
  /** True while it waits for a free slot, or to start. */
  queued: boolean;
  /**
   * A follow-up the office has yet to start: it waits for the Odd's run on
   * the same work to end (`followUpsToStart` in the ledger).
   */
  toStart?: true;
  askId?: number;
  /**
   * The hand-off this run serves (`servesHandOff`): its own row's id, or the
   * one whose ask or task the owner answered. Whoever handed the work over
   * reads the colleague as on it while such a run goes, a carry-out included.
   */
  handOffId?: number;
  about?: WorkAbout;
  /** The tool the staffer is using now, as Claude Code names it. */
  doing?: string;
  /** Tool calls so far. */
  steps: number;
};

export type LiveRun = {
  key: string;
  staffId: string;
  kind: UsageKind | 'hello';
  stop: AbortController;
  end: { promise: Promise<void>; resolve: () => void };
  turnId?: string;
  work?: Work;
  /** A queued background run is released by the preceding run or by Stop. */
  enter?: () => void;
  /**
   * Adds the owner's words to the run while it goes, in the same turn. Only a
   * Claude Code chat has it. False once the run can take no more.
   */
  add?: (text: string) => boolean;
};

export const runsGoing = new Map<string, LiveRun>();

export function reserveRun(
  input: Pick<LiveRun, 'staffId' | 'kind' | 'turnId' | 'work'> & { key?: string }
): LiveRun {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  const run: LiveRun = {
    ...input,
    key: input.key ?? randomUUID(),
    stop: new AbortController(),
    // Promise calls its executor before the constructor returns.
    end: { promise, resolve: resolve! }
  };
  if (runsGoing.has(run.key)) throw new Error('That run is already registered.');
  runsGoing.set(run.key, run);
  return run;
}

export function releaseRun(run: LiveRun): void {
  if (runsGoing.get(run.key) !== run) return;
  runsGoing.delete(run.key);
  run.end.resolve();
}
