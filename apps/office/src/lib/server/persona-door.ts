// A persona's door on New Altitude, `/{slug}/stream`: the one module that
// knows its address, the scope it takes, what a turn sends and what comes
// back. A turn's answer arrives whole, once the persona has finished. A chat
// carries on one conversation there, kept in the Odd's folder; a job or a
// follow-up starts a new one each time.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { home, OFFICE_FILES } from '@oddboro/ledger';

/** A persona's door, on the account's authorization server (its issuer). */
export const doorUrl = (slug: string, issuer: string) => `${issuer}/${slug}/stream`;
/** The door takes a bearer with this scope and nothing more. */
export const PERSONA_SCOPE = 'stream';
/** The longest message the door takes; it refuses a longer one. */
export const PERSONA_MESSAGE_MAX = 4_000;
/** Long enough for the slowest turn New Altitude answers, its keep-alive and the trip. */
const DOOR_TIMEOUT_MS = 360_000;
/** The earlier exchanges the door reads, newest last. */
const PRIOR_TURNS_MAX = 50;

/** Every way a turn at the door ends, as New Altitude names them. */
const DOOR_OUTCOMES = [
  'answered',
  'refused_access',
  'refused_content',
  'refused_budget',
  'failed',
  'abandoned',
  'interrupted'
] as const;
export type DoorOutcome = (typeof DOOR_OUTCOMES)[number];

/**
 * How a turn ended, with what the office shows of it. `grant` is the office's
 * own: the persona's sign-in is gone or New Altitude turned its token down.
 */
export type DoorAnswer =
  | { outcome: 'answered'; frame?: string; reply: string; caveat?: string }
  | { outcome: 'refused_content'; decline?: string }
  | { outcome: 'refused_budget'; retryAfterSeconds?: number }
  | { outcome: 'interrupted'; partialReply?: string }
  | {
      outcome: Exclude<
        DoorOutcome,
        'answered' | 'refused_content' | 'refused_budget' | 'interrupted'
      >;
    }
  | { outcome: 'grant' };

/** One earlier exchange, in the door's own shape: it drops any other silently. */
type PriorTurn = { message: string; answer: string };
/** A chat's conversation at the door: the id and count the door gave back, and what was answered. */
type Session = { sessionId: string; turnIndex: number; priorTurns: PriorTurn[] };

/** Apart from the hands' chat session (`chatSession`): the door's is New Altitude's, not the coding tool's. */
const sessionFile = (odd: string) => home('staff', odd, OFFICE_FILES.personaSession);

function readSession(odd: string): Session {
  const file = sessionFile(odd);
  const fresh = { sessionId: randomUUID(), turnIndex: 0, priorTurns: [] };
  if (!existsSync(file)) return fresh;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Session;
  } catch {
    // Only the office writes it; a broken one starts the conversation again.
    return fresh;
  }
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Which conversation and turn the door ran a turn as: it may swap an id it does not know. */
type Ran = { sessionId?: string; turnIndex?: number };

/** The door's settled body, checked: any outcome it does not name is `failed`. */
function readAnswer(body: unknown): { answer: DoorAnswer; ran: Ran } {
  const b = (body ?? {}) as Record<string, unknown>;
  const ref = (b.answer ?? {}) as { sessionId?: unknown; turnIndex?: unknown };
  const ran = {
    ...(typeof ref.sessionId === 'string' ? { sessionId: ref.sessionId } : {}),
    ...(typeof ref.turnIndex === 'number' ? { turnIndex: ref.turnIndex } : {})
  };
  const outcome = DOOR_OUTCOMES.find((o) => o === b.outcome) ?? 'failed';
  return { answer: answerOf(outcome, b), ran };
}

function answerOf(outcome: DoorOutcome, b: Record<string, unknown>): DoorAnswer {
  switch (outcome) {
    case 'answered': {
      const reply = text(b.reply);
      // An answer with no words is no answer.
      if (!reply) return { outcome: 'failed' };
      return { outcome, frame: text(b.frame), reply, caveat: text(b.caveat) };
    }
    case 'refused_content':
      return { outcome, decline: text((b.presentation as { text?: unknown } | undefined)?.text) };
    case 'interrupted':
      return { outcome, partialReply: text(b.partialReply) };
    case 'refused_budget': {
      const after = (b.refusal as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      return { outcome, ...(typeof after === 'number' ? { retryAfterSeconds: after } : {}) };
    }
    default:
      return { outcome };
  }
}

/**
 * One turn at a persona's door. With `chat`, the turn carries on the Odd's
 * conversation: its earlier answered exchanges go with it, and an answered
 * turn joins them under the id the door gave back. A turn the door did not
 * answer adds nothing, so a note of the office's is never sent back as the
 * persona's words. `signal`, the run's Stop, ends the wait as its time limit does.
 */
export async function askDoor(turn: {
  url: string;
  token: string;
  message: string;
  chat?: { odd: string; ownerSaid: string };
  signal?: AbortSignal;
}): Promise<DoorAnswer> {
  const session = turn.chat
    ? readSession(turn.chat.odd)
    : { sessionId: randomUUID(), turnIndex: 0, priorTurns: [] };
  let res: Response;
  let body: unknown;
  try {
    // Plain fetch, never retried: a turn sent twice is two turns.
    res = await fetch(turn.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${turn.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: turn.message,
        sessionId: session.sessionId,
        turnIndex: session.turnIndex,
        ...(turn.chat ? { priorTurns: session.priorTurns.slice(-PRIOR_TURNS_MAX) } : {}),
        locale: 'en-US'
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(DOOR_TIMEOUT_MS),
        ...(turn.signal ? [turn.signal] : [])
      ])
    });
    if (res.status === 401) return { outcome: 'grant' };
    // A slow turn's answer starts with keep-alive spaces, which JSON.parse skips.
    body = res.ok ? JSON.parse(await res.text()) : undefined;
  } catch (e) {
    console.error(`[persona] the door did not answer: ${e instanceof Error ? e.message : e}`);
    return { outcome: 'failed' };
  }
  if (!res.ok) {
    console.error(`[persona] the door answered ${res.status}`);
    return { outcome: 'failed' };
  }
  const { answer, ran } = readAnswer(body);
  if (turn.chat && answer.outcome === 'answered') {
    // Single spaces, as the door joins an answer's parts when it reads them back.
    const said = [answer.frame, answer.reply, answer.caveat].filter(Boolean).join(' ');
    const next: Session = {
      sessionId: ran.sessionId ?? session.sessionId,
      turnIndex: (ran.turnIndex ?? session.turnIndex) + 1,
      priorTurns: [...session.priorTurns, { message: turn.chat.ownerSaid, answer: said }].slice(
        -PRIOR_TURNS_MAX
      )
    };
    const file = sessionFile(turn.chat.odd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next));
  }
  return answer;
}
