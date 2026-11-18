// A persona Odd's chat, job or follow-up: its own coding tool does the work
// first, as its hands, then the persona answers through its door on New
// Altitude, in its own voice. The door takes no tools, so what the hands found
// reaches it as words. Every word the office sends the door is in this file.
import { ownerName, setQuiet, type StaffRow } from '@oddboro/ledger';
import { QUIET_LINE } from '#lib/persona.ts';
import { askPersona } from './persona.ts';
import { PERSONA_MESSAGE_MAX, type DoorAnswer } from './persona-door.ts';
import type { Run, RunOpts } from './staff.ts';

/** How a follow-up's work ended, the last line of its reply (`followThrough`). */
export const OUTCOME_LINE = /[*_\s]*Outcome:[*_\s]*(done|failed|waiting)\W*$/i;

/** The most of the door's message what was asked may take; the hands' report gets the rest. */
const ASKED_MAX = 1_500;
const REPORT_HEAD = 'What your hands in the office found and did:';
const CUT = ' [cut]';

/** `s`, at most `max` characters, marked where it was cut. */
const cut = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, max - CUT.length).trimEnd() + CUT;

/** The run kinds the persona answers; drafts, looks and the office's own runs stay with the hands. */
type Voiced = 'chat' | 'job' | 'follow-up';

/** What the persona is told it was asked, by the kind of run. */
const INTRO: Record<Voiced, (owner: string) => string> = {
  chat: (owner) => `${owner} wrote to you in Oddboro, where you work as an Odd in their office:`,
  job: (owner) => `Your job in ${owner}'s Oddboro office just ran. Its instructions:`,
  'follow-up': (owner) => `Work in ${owner}'s Oddboro office:`
};

/** Whether a persona Odd's run of this kind goes on to its persona. */
export const voiced = (kind: RunOpts['kind']): kind is Voiced => Object.hasOwn(INTRO, kind);

/** The door's message: what was asked, then the hands' report, within the door's limit. */
function voiceMessage(p: { kind: Voiced; owner: string; asked: string; report: string }): string {
  const head = `${INTRO[p.kind](p.owner)}\n\n${cut(p.asked, ASKED_MAX)}\n\n${REPORT_HEAD}\n\n`;
  return (head + cut(p.report, PERSONA_MESSAGE_MAX - head.length)).replaceAll('{owner}', p.owner);
}

type Unanswered = Exclude<DoorAnswer, { outcome: 'answered' }>;

/** A wait the door gave in seconds, as the owner reads it: whole minutes or hours, rounded up. */
function waitWords(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const [n, unit] = minutes < 60 ? [minutes, 'minute'] : [Math.ceil(minutes / 60), 'hour'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** The office's line before the hands' report, when the persona did not answer. */
function note(name: string, a: Unanswered): string {
  const found = `Here is what ${name}'s hands found.`;
  switch (a.outcome) {
    case 'refused_content':
      return `${a.decline ?? `${name} would not take this up.`} ${found}`;
    case 'refused_budget':
      return `${name} has reached New Altitude's limit for now.${a.retryAfterSeconds === undefined ? '' : ` Try again in ${waitWords(a.retryAfterSeconds)}.`} ${found}`;
    case 'failed':
    case 'abandoned':
      return `${name} could not answer just now. ${found}`;
    case 'interrupted':
      return [`${name} could not finish this answer.`, a.partialReply, found]
        .filter(Boolean)
        .join('\n\n');
    case 'refused_access':
      return `${QUIET_LINE.access(name)} ${found}`;
    case 'grant':
      return `${QUIET_LINE.grant(name)} ${found}`;
    default: {
      const missed: never = a;
      return missed;
    }
  }
}

/**
 * Run a persona Odd: a quiet one answers its quiet line and runs nothing.
 * Otherwise the hands run (`runTool`, passed in so this module needs nothing
 * of staff.ts's at load), and only their tool steps reach `onEvent`; then the
 * door answers. A follow-up keeps the hands' Outcome line, after the voice. A
 * door that does not answer fails the run, with the hands' report under a
 * note: the work waited on the persona's judgment, so a follow-up's Outcome
 * line goes and a task it carries out stays open. Stop ends the wait at once.
 */
export async function personaRun(
  who: StaffRow,
  message: string,
  opts: RunOpts & { kind: Voiced },
  runTool: (who: StaffRow, message: string, opts: RunOpts) => Promise<Run>
): Promise<Run> {
  const quiet = who.package?.quiet;
  if (quiet) {
    const line = QUIET_LINE[quiet](who.name);
    opts.onEvent?.({ type: 'error', message: line });
    return { ok: false, text: line };
  }
  const hands = await runTool(who, message, {
    ...opts,
    onEvent: (e) => void (e.type === 'tool' && opts.onEvent?.(e))
  });
  if (!hands.ok) {
    opts.onEvent?.({ type: 'error', message: hands.text });
    return hands;
  }
  const outcome = opts.kind === 'follow-up' ? OUTCOME_LINE.exec(hands.text) : null;
  const report = outcome ? hands.text.slice(0, outcome.index).trim() : hands.text;
  const asked =
    opts.kind === 'chat'
      ? (opts.ownerSaid ?? message)
      : opts.kind === 'job'
        ? message
        : (opts.asked ?? message);
  const answer = await askPersona(
    who,
    voiceMessage({ kind: opts.kind, owner: await ownerName(), asked, report }),
    { ...(opts.kind === 'chat' ? { chat: { ownerSaid: asked } } : {}), signal: opts.signal }
  );
  if (answer.outcome !== 'answered') {
    if (answer.outcome === 'refused_access') await setQuiet(who.id, 'access');
    if (answer.outcome === 'grant') await setQuiet(who.id, 'grant');
    const text = `${note(who.name, answer)}\n\n${report}`;
    opts.onEvent?.({ type: 'error', message: text });
    return { ok: false, text };
  }
  const reply = [answer.frame, answer.reply, answer.caveat].filter(Boolean).join('\n\n');
  const text = outcome ? `${reply}\n\n${outcome[0].trim()}` : reply;
  opts.onEvent?.({ type: 'delta', text: reply });
  opts.onEvent?.({ type: 'done', text });
  return { ok: true, text };
}
