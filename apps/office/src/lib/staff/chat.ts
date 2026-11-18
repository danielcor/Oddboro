import type { Agent, BugDraft, Delivery } from '@oddboro/ledger';
import type { WorkAbout } from './work.ts';
// A staffer's chat, as the office saves it and the page shows it. Safe to
// import in the browser.
import type { HandOffLine, HandOffStep, LessonLine, ThreadLine } from '@oddboro/ledger';
import type { DeskItem } from '@oddboro/ledger/desk-answers';
import type { ChatFile } from '#lib/attachments.ts';
import type { ChatSource } from './chat-input.ts';

/** Something the staffer put on the owner's desk. */
export type ChatRef = { kind: DeskItem; id: number; title: string };
/**
 * A `poke` line is one the office delivered later, not a reply. A `told` line
 * is one the office said in the staffer's name that no run of its chat session
 * wrote, like a new manager's hello. An `item` line
 * is something the staffer put on the owner's desk, shown where it landed. An
 * owner's line with `re` replied about one of those. A `handOff` line is work
 * the staffer handed a colleague, or a colleague handed it. A `thread` line is
 * a thread the staffer leads, holding each hand-off it gave on it. A `lesson`
 * line is one the staffer kept, where it kept it. A `failed` line is the error a
 * chat run ended with, saved in place of its reply: the staffer never said it.
 * `inSession` on it means the run's tool named a session before it failed, so
 * that session holds the owner's line before it. A told line with `re` is the
 * reply of the run the owner's answer on that card started (`answerInChat`);
 * `runFailed` on it says that run failed. It is not `failed`, which marks the
 * owner's line before it as never answered.
 */
export type ChatEntry = {
  at: string;
  from: 'owner' | 'staff';
  text: string;
  /** One owner submission and each attempt to answer it, across reloads. */
  turnId?: string;
  runId?: string;
  interrupted?: true;
  about?: WorkAbout;
  source?: ChatSource;
  /** The input's digest makes a repeated import reuse its saved files. */
  inputHash?: string;
  poke?: true;
  told?: true;
  failed?: true;
  inSession?: true;
  runFailed?: true;
  re?: ChatRef;
  item?: Omit<Delivery, 'at' | 'decidedAt'>;
  lesson?: LessonLine;
  /** `back` is which hand-back a reply or pick-up line shows. */
  handOff?: { line: HandOffLine; step: HandOffStep; back?: number };
  thread?: { line: ThreadLine; steps: HandOffLine[] };
  /** On a reply a chat run wrote: milliseconds from the owner's message to the reply. */
  took?: number;
  /** On the owner's line: the files they attached, kept in the Odd's `attachments/`. */
  files?: ChatFile[];
  /** On a reply: the choices it ended with (`splitChoices`), which the page shows as buttons. */
  choices?: string[];
  /** On a reply: the bug report its run drafted (`draft_bug_report`), which File this opens in the report form. */
  bug?: BugDraft;
  /** Shows the existing Updates controls under this reply. It authorizes no installation. */
  updates?: true;
};
export type ChatSignIn = { agent: Agent; account: string; how: 'key' | 'browser' };

/** What a chat's reply streams to the page, one server-sent event each. */
export type ChatEvent =
  | { type: 'reply'; runId: string; turnId: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; text: string; choices?: string[]; bug?: BugDraft; updates?: true }
  | { type: 'error'; message: string; signIn?: ChatSignIn };
