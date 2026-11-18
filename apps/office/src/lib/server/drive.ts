// The one loop an AI run goes through, whatever its tool: it starts the tool,
// writes its input, reads its stream through the launch's reader, stops it and
// what it started, and ends the run once, on the tool's result, its exit, the
// deadline or the run's stop signal. It decides no reply and no words: each
// caller makes those from the `RunEnd`. Server only.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename } from 'node:path';
import { currentPlatform } from '@oddboro/ledger';
import { waitsToBeReaped } from '@oddboro/ledger/platform';
import type { LiveRun } from '@oddboro/ledger/run-registry';
import type { Launch } from './cli.ts';
import { stopGroups, type ResultFacts, type RunEvent } from './launch.ts';

/** How a run ended, as facts. */
export type RunEnd =
  /** `text`: the result's text, as the tool sent it. `spoken`: the streamed text joined as it came, else the last whole message. */
  | { outcome: 'done'; text?: string; spoken: string; session?: string }
  /** Every end but `done` carries the tool's stderr, which a caller reads for the network refusal. */
  | {
      outcome: 'failed';
      why: { tool: string } | { exit: number | null } | { start: string } | { result: ResultFacts };
      stderr: string;
      session?: string;
    }
  | { outcome: 'timeout'; stderr: string; session?: string }
  | { outcome: 'stopped'; stderr: string; session?: string }
  /** The Odd left the office (`stopRuns` aborts with 'left'). */
  | { outcome: 'left'; stderr: string; session?: string };

/** What the caller hears as the run goes, in order. The end comes as `RunEnd`, and `error` events go to its stderr. */
export type Sink = {
  event: (
    e: Extract<RunEvent, { type: 'session' | 'tool' | 'message' | 'delta' | 'usage' | 'plan' }>
  ) => void;
};

/**
 * Whether a run gets a process group of its own: always where the system has
 * groups, and on Windows only a tool with a shell (`ownGroup`). A caller's
 * `start` passes it as `detached`, and the driver stops that group again when
 * the tool exits, so commands it left running stop with it.
 */
export const ownsGroup = (launch: Pick<Launch, 'ownGroup'>): boolean =>
  !!launch.ownGroup || currentPlatform() !== 'win32';

/**
 * Whether `pid` is gone: no such process, or one that exited and waits for
 * its parent to reap it, which `process.kill(pid, 0)` still finds. Not gone
 * when ps fails, or on Windows, which has no ps and no such wait: the kill's
 * answer stands, and a caller polls again.
 */
export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM: it is there, under another user.
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
  return waitsToBeReaped(pid);
}

/** A stop's signals land after it returns, so a pid gets this long to go before it counts as left behind. */
const GONE_WITHIN_MS = 1000;

/** Log each pid a stop found that is still there once the run's tool has exited. */
async function reportLeftBehind(pids: number[], tool: string): Promise<void> {
  const start = Date.now();
  let left = pids.filter((p) => !processGone(p));
  while (left.length && Date.now() - start < GONE_WITHIN_MS) {
    await new Promise((r) => setTimeout(r, 20));
    left = left.filter((p) => !processGone(p));
  }
  if (left.length)
    console.error(
      `${tool} was stopped, but processes it started are still running: ${left.join(', ')}`
    );
}

const stoppedBy = (signal: AbortSignal, stderr: string): RunEnd =>
  signal.reason === 'left' ? { outcome: 'left', stderr } : { outcome: 'stopped', stderr };

/**
 * Run one launch to its end. `start` spawns the tool, with `detached` from
 * `ownsGroup`; it is never called when the signal already aborted or the
 * deadline already passed. `deadline` is the time the run must end by, in ms
 * since the epoch. `live`, for a launch that takes words while it replies
 * (`turn`), is the run's registry entry, whose `add` the driver sets while
 * the run can take them. The driver calls `launch.done()` once, however the
 * run ends; a caller never calls it again.
 */
export function drive(
  start: () => ChildProcessWithoutNullStreams,
  launch: Launch,
  sink: Sink,
  o: { deadline: number; signal: AbortSignal; live?: LiveRun }
): Promise<RunEnd> {
  const tidy = () => {
    try {
      launch.done();
    } catch (e) {
      console.error('A run ended, but tidying up after it failed:', e);
    }
  };
  // staff.ts's order: a stop the owner asked for wins over a deadline that also passed.
  const over: RunEnd | undefined = o.signal.aborted
    ? stoppedBy(o.signal, '')
    : o.deadline <= Date.now()
      ? { outcome: 'timeout', stderr: '' }
      : undefined;
  if (over) {
    tidy();
    return Promise.resolve(over);
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = start();
  } catch (e) {
    tidy();
    const why = { start: e instanceof Error ? e.message : String(e) };
    return Promise.resolve({ outcome: 'failed', why, stderr: '' });
  }
  const owns = ownsGroup(launch);
  const tool = basename(child.spawnfile);

  return new Promise((resolve) => {
    let buffer = '';
    let stderr = '';
    /** The streamed text, joined as it came. */
    let deltas = '';
    /** The last whole message, the reply of a tool that streams none. */
    let message = '';
    let session: string | undefined;
    let finished = false;
    let added = 0;
    // What waits for the tool's exit: its first failure, which ends the run
    // only once all of its stderr is in, and each success after added words.
    let failure: { tool: string } | { result: ResultFacts } | undefined;
    const replies: { text?: string; spoken: string }[] = [];
    /** What a stop on the deadline or the signal found under the run, checked once the tool exits. */
    let stopped: number[] | undefined;
    const spoken = () => deltas || message;
    const heard = (): RunEnd | undefined => {
      if (failure) return { outcome: 'failed', why: failure, stderr };
      if (replies.length < 2) return replies[0] && { outcome: 'done', ...replies[0] };
      // Words added too late got a turn of their own: each reply as staff.ts made it, joined.
      const text = replies.map((r) => (r.text ?? r.spoken).trim()).join('\n\n');
      return { outcome: 'done', text, spoken: spoken() };
    };
    const endInput = () => {
      if (!child.stdin.writableEnded) child.stdin.end();
    };
    const finish = (end: RunEnd) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      o.signal.removeEventListener('abort', interrupted);
      if (o.live) o.live.add = undefined;
      endInput();
      tidy();
      resolve(session === undefined ? end : { ...end, session });
    };
    const stop = () => (child.pid ? stopGroups(child.pid) : (child.kill(), []));
    const timer = setTimeout(
      () => {
        stopped = stop();
        finish(heard() ?? { outcome: 'timeout', stderr });
      },
      Math.max(0, o.deadline - Date.now())
    );
    const interrupted = () => {
      stopped = stop();
      finish(stoppedBy(o.signal, stderr));
    };
    o.signal.addEventListener('abort', interrupted, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let e: unknown;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof e !== 'object' || e === null || Array.isArray(e)) continue;
        // Passed on after the end too: a reader can send usage on the line that ends the run.
        for (const ev of launch.read(e as Record<string, unknown>))
          switch (ev.type) {
            case 'session':
              session = ev.id;
              sink.event(ev);
              break;
            case 'delta':
              deltas += ev.text;
              sink.event(ev);
              break;
            case 'message':
              message = ev.text;
              sink.event(ev);
              break;
            case 'tool':
            case 'usage':
            case 'plan':
              sink.event(ev);
              break;
            case 'error':
              // Said again with the failure, if the run fails.
              stderr += `${ev.message}\n`;
              break;
            // A result ends the tool's input. Without added words a success
            // ends the run now; anything else waits for the tool's exit.
            case 'done': {
              endInput();
              const reply = { text: ev.text, spoken: spoken() };
              if (added) replies.push(reply);
              else finish({ outcome: 'done', ...reply });
              break;
            }
            case 'failed':
              endInput();
              failure ??= ev.result ? { result: ev.result } : { tool: ev.message };
              break;
            default: {
              // The type check fails here until a new kind of event has its case.
              const unread: never = ev;
              console.error(`${tool}'s run has no case for ${JSON.stringify(unread)}`);
            }
          }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (err) => finish({ outcome: 'failed', why: { start: err.message }, stderr }));
    child.on('close', (code) => {
      if (owns && child.pid) stopGroups(child.pid);
      finish(heard() ?? { outcome: 'failed', why: { exit: code }, stderr });
      if (stopped) void reportLeftBehind(stopped, tool);
    });
    // A tool that exits before it reads its input breaks the pipe; the run
    // ends through 'close' all the same.
    child.stdin.on('error', () => {});
    const { turn } = launch;
    if (!turn || !o.live) return void child.stdin.end(launch.stdin);
    child.stdin.write(launch.stdin);
    o.live.add = (text) => {
      if (finished || child.stdin.writableEnded) return false;
      child.stdin.write(turn(text));
      added++;
      return true;
    };
  });
}
