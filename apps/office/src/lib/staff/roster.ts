// The shape of a staffer on the floor, and the words for what each one is
// doing. The staff themselves live in Postgres; hiring adds a row there.
// The page loads this file for ACTIVITY_LABEL, so it takes only types from
// the ledger; the server builds the profile (`toProfile` in `lib/server/profile.ts`).
import type { OwnTools, PersonaLink } from '@oddboro/ledger';
import type { Level } from '@oddboro/ledger/access';
import type { Agent, Effort, GrantedFolder } from '@oddboro/ledger/agents';
import type { LookSpec } from '@oddboro/sprites/look';

export type Activity =
  'work' | 'intake' | 'read' | 'wait' | 'play' | 'rest' | 'eat' | 'exercise' | 'talk' | 'home';

/** Character limits for an Odd's profile and job description. */
export const LIMITS = { name: 40, role: 60, remit: 200, desk: 20_000 } as const;
export type StaffProfile = {
  id: string;
  name: string;
  role: string;
  office: string;
  sprite: string;
  variant: string;
  portrait: string;
  hired: string;
  permission: Level;
  /** At Act, whether work another Odd hands it runs at Act (true) or at Draft at most. Kept below Act. */
  actsOnHandOffs: boolean;
  /** The coding tool its runs go through. */
  agent: Agent;
  /** The account it signs in with on that tool (accounts.ts), or nothing for the Office account. */
  account?: string;
  /** Its own model on that tool, or nothing for the office's. */
  model?: string;
  /** The office's model on that tool, which it runs without one of its own. */
  officeModel?: string;
  /** How hard its runs think on that tool (`effortFor`), or nothing on a tool with no levels. */
  effort?: Effort;
  /** The office tools the owner granted, beyond the ones every staffer has. */
  tools: string[];
  /** The Office Manager, whom the office always keeps: its card offers no Remove. */
  manager?: true;
  /** The owner's Run commands switch, as stored; `reach.commandsHow` says whether its tool follows it. */
  commands: boolean;
  /** The owner's Browse the web switch, as stored. */
  web: boolean;
  /** The line under Browse the web: what its commands do with it on this tool. */
  webLine: string;
  /**
   * Folders outside the office the owner gave it, as stored, so one gone from
   * the disk can still be taken back, each with its home folder written `~`.
   */
  /** `touchesStore`: in or holding a secret store, so no run gets it (`touchesSecretStore`). */
  folders: (GrantedFolder & { shown: string; touchesStore: boolean })[];
  /**
   * What its runs get now. The stored switches and folders above are the
   * owner's choice; this is what its tool makes of them, less folders gone
   * from the disk or touching a secret store, and a network this office holds back.
   */
  reach: OwnTools & { held: boolean };
  /** One sentence on what this staffer is for, shown on the card. */
  remit: string;
  /** The room template this staffer works in when it has a choice. */
  room: string;
  /** Guesses waiting for the owner's Keep on its Lessons tab. */
  guesses: number;
  /** A generated look: where its frames and portrait load from. Absent for hand-drawn art. */
  look?: { spec: LookSpec; sheet: string; portrait: string; version: string };
  /** Set for an Odd added from a New Altitude persona's package. */
  persona?: PersonaLink;
};

/** A short stamp that changes whenever the look or portrait does. */
export function lookVersion(look: LookSpec, portraitPx: string): string {
  let h = 5381;
  for (const ch of JSON.stringify(look) + portraitPx) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** What a person reads on the floor for each activity. */
export const ACTIVITY_LABEL: Record<Activity, string> = {
  work: 'Working',
  intake: 'Sorting the mail',
  read: 'Reading in the library',
  wait: 'Waiting on you',
  play: 'In the break room',
  rest: 'Taking a break',
  eat: 'At lunch',
  exercise: 'In the gym',
  talk: 'Talking with you',
  home: 'Gone home'
};
