// What a run's office tool server (mcp.ts in the ledger) is told about the run,
// through its environment. The tool server trusts only these, never a tool
// argument, so each one here is a rule the run is held to.
import type { ChatUpdateStatus } from '@oddboro/ledger';

/** What `officeEnv` needs to know about one run. */
export type RunFacts = {
  /** The run's key, which every run gets: a thread it hands off on keeps it while it goes (`runsGoing`). */
  key: string;
  /** The owner's own message, when this is a chat. */
  ownerSaid?: string;
  /** The updater's status when this owner chat starts. No app key or release notes. */
  update?: ChatUpdateStatus;
  /** In a chat, the last exchange before the owner's message, which `tell_lead` passes on. */
  chatExchange?: string;
  /**
   * In a chat, every file the owner attached to their message: its tag there,
   * its path in the Odd's folder, and the name it lands under in the work.
   * `tell_lead` copies each into the work.
   */
  ownerFiles?: { tag: string; path: string; name: string }[];
  /** The ask the owner approved that this run carries out. */
  approvedAsk?: number;
  /** The tools whose sign-ins ran out, which only this run knows. */
  signedOut: string[];
  /** The owner's note a follow-up carries out, which a lesson may quote. */
  ownerNote?: string;
  /** The owner's version of a file they edited, which a lesson read from it quotes. */
  ownerEdit?: string;
  /** The level the run works at, when it is below the Odd's own. */
  ceiling?: string;
  /** The hand-off a colleague's run serves. */
  handOffId?: number;
  /** The thread the run works on, either side. */
  threadId?: number;
  /** On a lead's pick-up of a colleague's result, that colleague: what the run puts on the desk names them. */
  via?: string;
  /** A colleague's words reach the run: it serves a hand-off, or picks up a result. */
  fromColleague?: boolean;
  /** A run that only reads the owner's reason or edit for a lesson: it hands nothing on. */
  lessonRun: boolean;
  /** The office holds the network, after a Claude Code refused the open one (`networkHeld`), whatever this run's own tool or switches. */
  networkHeld: boolean;
};

/** The most of the owner's words a run's environment carries, in UTF-16 units. */
const WORDS_MAX = 4000;

/**
 * Text cut to `max` UTF-16 units, never between the two halves of a character
 * outside the BMP (an emoji): a half alone is no character, and Codex's `-c`,
 * which carries a run's environment, refuses the TOML.
 */
export function cut(s: string, max: number): string {
  const kept = s.slice(0, max);
  return s.length > max && /[\ud800-\udbff]$/.test(kept) ? kept.slice(0, -1) : kept;
}

const words = (s: string): string => cut(s, WORDS_MAX);

/** The environment the run's office tool server starts with, beyond what every run shares. */
export function officeEnv(r: RunFacts): Record<string, string> {
  return {
    RUN_KEY: r.key,
    ...(r.ownerSaid ? { OWNER_SAID: words(r.ownerSaid) } : {}),
    ...(r.ownerSaid && r.update ? { ODDBORO_UPDATE_STATUS: JSON.stringify(r.update) } : {}),
    ...(r.chatExchange ? { CHAT_EXCHANGE: words(r.chatExchange) } : {}),
    // Whole, never cut: a list cut short would read as none.
    ...(r.ownerFiles?.length ? { OWNER_FILES: JSON.stringify(r.ownerFiles) } : {}),
    ...(r.approvedAsk ? { APPROVED_ASK: String(r.approvedAsk) } : {}),
    ...(r.signedOut.length ? { SIGNED_OUT: r.signedOut.join(',') } : {}),
    ...(r.ownerNote ? { OWNER_NOTE: words(r.ownerNote) } : {}),
    ...(r.ownerEdit ? { OWNER_EDIT: r.ownerEdit } : {}),
    // Below the Odd's own level, my_access answers for this run, as its prompt does.
    ...(r.ceiling ? { CEILING: r.ceiling } : {}),
    ...(r.handOffId ? { HAND_OFF_ID: String(r.handOffId) } : {}),
    ...(r.threadId ? { THREAD_ID: String(r.threadId) } : {}),
    ...(r.via ? { VIA: r.via } : {}),
    // my_access then leaves out the standing yeses the run does not have (`handedOver`).
    ...(r.fromColleague ? { FROM_COLLEAGUE: '1' } : {}),
    ...(r.lessonRun ? { LESSON_RUN: '1' } : {}),
    // On every run while held, so my_access and office_report apply the hold
    // to each Odd they speak of, as the office's own readers do (`heldReach`).
    ...(r.networkHeld ? { OFFICE_NETWORK_HELD: '1' } : {})
  };
}
