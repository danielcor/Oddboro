// A one-off run as the office itself, not as any staffer: no MCP, no job
// description, on the tool the office runs on (`officeAgent`, picked at
// setup). Drafting a job description, drawing a look and designing an office
// run this way, so a new office with nobody on staff can still hire its first
// staffer. Usage is recorded with no staffer.
//
// Every tool's run goes through the same launch an Odd's run does
// (`LAUNCHES` in cli.ts). On Claude Code the run has no tools, its pictures
// go in the message itself, from memory, and Claude Code keeps no
// transcript, so a headshot never lands on disk. On Grok or Codex it runs
// with that tool's sandbox, in a folder of its own that reads nothing else,
// writes only itself, has no MCP, no web and no network, and is removed when
// the run ends, pictures and all. Neither has a shell or a tool that reads
// files: the pictures go in with the message.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_NAMES,
  home,
  OFFICE_ACCOUNT,
  officeAgent,
  ownerName,
  recordUsage,
  reserveRun,
  releaseRun,
  type Agent,
  type UsageKind
} from '@oddboro/ledger';
import { notePlan } from './staff.ts';
import { claudeRunHome, type ClaudeRun } from './claude.ts';
import { endedEarly, LAUNCHES, stoppedWhy } from './cli.ts';
import { drive, ownsGroup, type RunEnd, type Sink } from './drive.ts';
import { SIGN_IN_WHERE, type RunImage } from './launch.ts';
import { agentCommand } from './agent-sign-in.ts';
import { tooOldLine } from './versions.ts';

const HOME = home('office');
/** Each Grok or Codex office run's own folder, removed when it ends. */
const RUNS = join(HOME, 'runs');

export type OfficeRun = { ok: boolean; text: string };

type OfficeRunOpts = {
  runId?: string;
  system: string;
  kind: UsageKind;
  timeoutMs: number;
  /** Lower effort answers sooner; the default is the tool's own. */
  effort?: 'low' | 'medium' | 'high';
  /** Pictures sent ahead of the message, as base64. */
  images?: { mediaType: string; data: string }[];
  /** A Claude model other than the owner's pick. Claude Code only. */
  model?: string;
  /** Stops the run, such as when the owner leaves a drawing for parts. */
  signal?: AbortSignal;
};

/** What an office run says when its signal stopped it. */
const STOPPED = 'Stopped.';

/** One office run. Prompts name the owner as {owner}, filled in with this install's name. */
export async function runAsOffice(message: string, opts: OfficeRunOpts): Promise<OfficeRun> {
  const owner = await ownerName();
  const say = (s: string) => s.replaceAll('{owner}', owner);
  const agent = officeAgent();
  // Without this, a tool that is not installed reads as not signed in.
  if (agent !== 'claude' && !agentCommand(agent))
    return {
      ok: false,
      text: `${AGENT_NAMES[agent]} is not installed. Install it ${SIGN_IN_HERE}.`
    };
  const tooOld = await tooOldLine(agent, SIGN_IN_HERE);
  if (tooOld) return { ok: false, text: tooOld };
  const live = reserveRun({ staffId: 'office', kind: opts.kind });
  const cancel = () => live.stop.abort();
  if (opts.signal?.aborted) cancel();
  else opts.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const said = { ...opts, system: say(opts.system), signal: live.stop.signal, runId: live.key };
    if (said.signal.aborted) return { ok: false, text: STOPPED };
    return await runOn(agent, say(message), said);
  } finally {
    opts.signal?.removeEventListener('abort', cancel);
    releaseRun(live);
  }
}

/**
 * Said to an office run on Grok or Codex after its own instructions. Claude
 * Code's office run has no tools at all; Grok's has one harmless one, and
 * either tool went looking for files or ran a script before it answered when
 * it could, so the answer comes in this one reply instead.
 */
const ONE_REPLY =
  'You have no tools you need here and no files to read: everything is in this message. Answer in this one reply, in the shape it asks for.';

/** Where an office run's refusal sends the owner to sign its tool in: setup, not an Odd's Settings tab. */
const SIGN_IN_HERE = 'in Setup, under Your AI';

/**
 * Where an office run works, and how its pictures reach its tool. Claude Code
 * takes them in its message, from memory, so a headshot never lands on disk,
 * and works in the office's folder. Grok and Codex open them as files, in a
 * folder of the run's own, removed when the run ends (`clear`).
 */
async function workspace(
  agent: Agent,
  key: string,
  opts: OfficeRunOpts
): Promise<{
  dir: string;
  clear: () => void;
  run: Pick<ClaudeRun, 'system' | 'images' | 'pictures' | 'model' | 'toolDir'>;
}> {
  if (agent === 'claude') {
    mkdirSync(HOME, { recursive: true });
    return {
      dir: HOME,
      clear: () => {},
      run: {
        system: opts.system,
        pictures: opts.images,
        ...(opts.model ? { model: opts.model } : {}),
        // The office's own Claude Code folder, or the owner's login before it is signed in.
        toolDir: await claudeRunHome(OFFICE_ACCOUNT)
      }
    };
  }
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });
  const dir = join(RUNS, key);
  mkdirSync(dir, { mode: 0o700 });
  const images = (opts.images ?? []).map((img, i): RunImage => {
    const path = join(dir, `picture-${i + 1}.${img.mediaType.split('/')[1] || 'png'}`);
    writeFileSync(path, Buffer.from(img.data, 'base64'), { mode: 0o600 });
    return { path, mediaType: img.mediaType };
  });
  return {
    dir,
    clear: () => rmSync(dir, { recursive: true, force: true }),
    run: { system: `${opts.system}\n\n${ONE_REPLY}`, images }
  };
}

/** One office run, on the tool the office runs on. */
async function runOn(
  agent: Agent,
  message: string,
  opts: OfficeRunOpts & { runId: string; signal: AbortSignal }
): Promise<OfficeRun> {
  const place = await workspace(agent, opts.runId, opts);
  try {
    const launch = await LAUNCHES[agent]({
      key: opts.runId,
      // The office's own runs sign in with each tool's Office account.
      account: OFFICE_ACCOUNT,
      staffId: 'office',
      dir: place.dir,
      reads: [],
      // `part` gives Grok a sandbox profile for this run alone.
      part: place.dir,
      writes: [place.dir],
      granted: [],
      web: false,
      commands: false,
      network: false,
      input: message,
      servers: {},
      allowed: [],
      timeoutMs: opts.timeoutMs,
      bare: true,
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...place.run
    });
    if ('refused' in launch)
      return { ok: false, text: launch.refused.replace(SIGN_IN_WHERE, SIGN_IN_HERE) };
    const [cmd, before] = agentCommand(agent) ?? [agent, []];
    const sink: Sink = {
      event: (e) => {
        switch (e.type) {
          case 'usage':
            void recordUsage(null, opts.kind, e.usage).catch(() => {});
            break;
          case 'plan':
            void notePlan(e.info);
            break;
          // An office run shows nothing as it goes.
          case 'session':
          case 'tool':
          case 'message':
          case 'delta':
            break;
          default: {
            // The type check fails here until a new kind of event has its case.
            const unheard: never = e;
            console.error(`An office run has no case for ${JSON.stringify(unheard)}`);
          }
        }
      }
    };
    const end = await drive(
      () =>
        spawn(cmd, [...before, ...launch.args], {
          cwd: place.dir,
          env: launch.env,
          detached: ownsGroup(launch),
          windowsHide: true
        }),
      launch,
      sink,
      { deadline: Date.now() + opts.timeoutMs, signal: opts.signal }
    );
    return officeEnded(agent, end, opts.timeoutMs);
  } finally {
    place.clear();
  }
}

/**
 * What an office run says when its tool's run ends (`drive`). Claude Code's
 * and Grok's runs read Claude Code's stream: a result that says it succeeded
 * is the reply, even one that also says it erred, and with no result text the
 * reply is empty, though Grok streams its text. Codex's and Gemini's reply is
 * their last whole message.
 */
function officeEnded(agent: Agent, end: RunEnd, timeoutMs: number): OfficeRun {
  switch (end.outcome) {
    case 'done':
      return {
        ok: true,
        text: (agent === 'claude' || agent === 'grok' ? (end.text ?? '') : end.spoken).trim()
      };
    case 'failed': {
      const { why } = end;
      if ('result' in why) {
        if (why.result.subtype === 'success')
          return { ok: true, text: (why.result.text ?? '').trim() };
        return {
          ok: false,
          text:
            agent === 'claude'
              ? `The run ended early (${why.result.subtype}).`
              : endedEarly(agent, why.result)
        };
      }
      if ('tool' in why) return { ok: false, text: why.tool };
      if ('exit' in why) return { ok: false, text: stoppedWhy(agent, why.exit, end.stderr, true) };
      return { ok: false, text: `Could not start ${AGENT_NAMES[agent]}: ${why.start}` };
    }
    case 'timeout':
      return { ok: false, text: `No reply after ${timeoutMs / 60_000} minutes.` };
    case 'stopped':
    case 'left':
      return { ok: false, text: STOPPED };
    default: {
      // The type check fails here until a new way to end has its words.
      const unworded: never = end;
      return unworded;
    }
  }
}
