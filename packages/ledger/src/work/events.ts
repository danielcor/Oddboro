// What can happen to the office's work, as plain data. Each event is decided
// by one pure function (`DECIDERS` in decide.ts), which turns it into the
// rows to write. An entry function builds the event from what its caller
// passed and what it read outside the transaction.
//
// Pure: every import here is a type, so this file loads nothing.
import type { Level } from '../access-words.ts';
import type { oweCatchUp } from '../missed-runs.ts';
import type { bringBack, removeOdd } from '../leaving.ts';
import type { grantAccess } from '../office-access.ts';
import type { GmailFilter } from '../filter-words.ts';
import type { Carried, CarriedFile } from '../hand-offs.ts';
import type { carryOutTogether, Decision } from '../office-asks.ts';
import type { Unparked } from '../office-follow-ups.ts';
import type {
  AccessRequest,
  FileEdit,
  FolderRequest,
  GoalStatus,
  HeldCall,
  InChat,
  Outcome,
  ReplyDraft
} from '../schema.ts';
import type { TaskEnded } from '../task-parking.ts';
import type { FollowUpKind } from './kinds.ts';
import type { LiveFollowUp } from './runs.ts';
import type { Inserted, LedgerLine, PerKindInTx } from './snapshot.ts';
import type { AskBase, FollowUp, RetiredKind, TaskBase } from './state.ts';

/** A follow-up kind the office still starts. */
export type LiveKind = Exclude<FollowUpKind, RetiredKind>;

/** The run a source owes an Odd: whose it is, its kind, and what it answers or works on. */
export type OwedRun = {
  staffId: string;
  kind: LiveKind;
  note: string | null;
  askId?: number;
  taskId?: number;
  goalId?: number;
  /** The work it picks up. With none, the run works on the thread of the ask or task it answers. */
  threadId?: number;
  edit?: FileEdit;
  pickedUp?: string[];
  reportWhenDone?: boolean;
};

/**
 * How a run ended, as the run hands it over: one value, so any driver that
 * runs an Odd attaches by producing it. `joined` are the results the claim
 * picked up with this run (`Claimed.joined`): they end with it.
 */
export type RunEnded = { outcome: Outcome; result: string; joined: number[] };

/** The columns an Odd's new ask names. Every other column starts empty, as a new row's does. */
export type NewAsk = Pick<AskBase, 'staffId' | 'kind' | 'title' | 'why' | 'ifApproved'> &
  Partial<Omit<AskBase, 'id' | 'createdAt' | 'staffId' | 'kind' | 'title' | 'why' | 'ifApproved'>>;

/** The columns a new task names, its steps built by the entry. Every other column starts empty. */
export type NewTask = Pick<TaskBase, 'staffId' | 'title' | 'why' | 'steps'> &
  Partial<Pick<TaskBase, 'askId' | 'handOffId' | 'threadId' | 'via' | 'ownerSaid' | 'response'>>;

/** What the office did with an ask the owner approved by doing it, kept on the ask with the yes. */
export type AskDone = {
  reply?: ReplyDraft;
  filter?: GmailFilter;
  call?: HeldCall;
  folder?: FolderRequest;
};

export type WorkEvent =
  | {
      kind: 'runQueued';
      run: OwedRun;
      /** The owner answered on a card in a chat: the run replies there when it is that chat's Odd's. */
      chat?: InChat;
      /**
       * Put the run only while its work is open. A project's result that
       * comes back after its work ended starts nothing, as before; every other
       * source puts its run on ended work too, so only that one sets this.
       */
      onlyWhileOpen?: true;
      /**
       * The run is a goal's planning run, on the goal's work, which opens in
       * this change under the run's Odd with this title (`addGoal`).
       */
      opens?: { title: string };
    }
  | { kind: 'runClaimed'; id: number }
  | {
      kind: 'runFinished';
      id: number;
      /** What the work was about, for the Ledger and report title: the entry reads it outside the transaction. */
      about: string;
      ended: RunEnded;
    }
  | {
      kind: 'staleRunsClosed';
      /** One run a restart cut off: each is closed on its own, so one that fails leaves the rest to close. */
      id: number;
      about: string;
    }
  | {
      kind: 'askRaised';
      ask: NewAsk;
      /** Files that go with it, inserted with the ask. */
      attach?: string[];
      /** The key of the run raising it, which the thread it is raised on keeps. */
      run?: string;
    }
  | {
      kind: 'askDecided';
      id: number;
      decision: Decision;
      reason: string | null;
      /** The owner answered on the ask's card in its Odd's chat: the run the answer starts replies there. */
      inChat: boolean;
      reportWhenDone?: boolean;
      done?: AskDone;
      /**
       * The Odd that raised it left the office, or took it off the desk: the
       * office closes it as a no, with this line as the answer that goes back.
       */
      withdrawn?: string;
      /** A yes that puts the Odd at Act: the owner's choice for work another Odd hands it. */
      actsOnHandOffs?: boolean;
      /** Writes in the same transaction that only the entry knows, such as setting a goal. */
      perKind: PerKindInTx[];
      effects: AskEffects;
    }
  | {
      kind: 'taskGiven';
      task: NewTask;
      attach?: string[];
      run?: string;
      /**
       * A connect task the office gives: an open task with a step for this
       * tool answers it instead. With `aws`, only an AWS step counts.
       */
      oneOpen?: { connector: string; aws?: true };
    }
  | {
      kind: 'taskEnded';
      id: number;
      ended: TaskEnded;
      /** The owner's note, or the office's line when the task is withdrawn. */
      note: string | null;
      /** The owner answered on the task's card in its Odd's chat. */
      inChat: boolean;
      /** The version of the saved response the owner finished with. */
      responseVersion?: number;
    }
  | {
      kind: 'connectTasksDropped';
      connector: string;
      /** Only this Odd's tasks; with none, every Odd's. */
      staffId?: string;
    }
  | { kind: 'goalStatusChanged'; goalId: number; status: GoalStatus }
  | {
      kind: 'parked';
      staffId: string;
      threadId: number;
      on: { at: Date } | { task: number };
      /** The threads the Odd works on and does not lead, as the entry read them: the goals it serves are not loaded. */
      worksOn: ReadonlySet<number>;
    }
  | { kind: 'clockWoke'; threadId: number }
  | {
      kind: 'oddRemoved';
      staffId: string;
      /** The Ledger line of the leaving, which names the Odd's role and its jobs, as the entry read them. */
      line: LedgerLine;
      /** What each run of the Odd yet to start was about, by id, read outside the transaction. */
      about: ReadonlyMap<number, string>;
      effects: LeaveEffects;
    }
  | {
      kind: 'oddBroughtBack';
      staffId: string;
      /** The Ledger line of its return, as the entry worded it. */
      line: LedgerLine;
    }
  | {
      kind: 'handedOff';
      from: string;
      to: string;
      /** `files` already names each carried file where it lands, `<from>/<name>`. */
      work: { title: string; brief: string; files?: string[] };
      /**
       * The work it goes on, or a new thread to open for it. The entry finds a
       * goal's thread, and checks that a new one's lead may lead work, since
       * both read rows the core does not load.
       */
      thread: { id: number } | { open: { title: string; hubId: string; goalId?: number } };
      /** The key of the run handing it off. */
      run?: string;
      /** Files from outside the work, copied into the sender's part of it. */
      carry: CarriedFile[];
    }
  | {
      kind: 'toldLead';
      staffId: string;
      threadId: number;
      /** The owner's whole message, and the part of it about this work. */
      said: string;
      words: string;
      reading: string;
      /** The chat's last exchange as the lead reads it, which the entry words from the tools each holds. */
      exchange: string;
      /** The threads the Odd works on and does not lead, as the entry read them: the goals it serves are not loaded. */
      worksOn: ReadonlySet<number>;
      /**
       * What became of each of the owner's attachments: where it landed, or
       * why it could not be copied. The entry copies them before deciding,
       * as `carryEach` does, so the lead's note names only what is there.
       */
      files: Carried[];
    };

export type { Inserted } from './snapshot.ts';

/**
 * Why a hand-off did not go, though the change still commits, on work that
 * may be new in it: a goal's work its lead opened and the sender does not
 * lead, or the usage window holding it until `at`. The words name the work's
 * number, so they are made once the apply knows it (`handOffProblem`).
 */
export type HandOffHeld<T = number | Inserted> =
  { notLed: T } | { window: T; share: number; at: string };

/** The event of one kind, as its decider takes it. */
export type EventOf<K extends WorkEvent['kind']> = Extract<WorkEvent, { kind: K }>;

/** A run as its claim hands it to the driver. */
export type Claimed = {
  run: LiveFollowUp;
  /** The wait the claim lifted, for the run's brief: the task's title, or the time. */
  unparked?: Unparked;
  /** The lead's other results on this work still waiting, which this one run picks up and ends with. */
  joined: FollowUp[];
  /** The level the run may act at. */
  ceiling: Level;
};

/** What each event's entry function returns from a change that went through. */
export type WorkResults = {
  runQueued: null;
  runClaimed: Claimed;
  runFinished: null;
  staleRunsClosed: null;
  /** The open ask a repeat of a held call found, or null when the new ask went in. */
  askRaised: { already: number } | null;
  askDecided: null;
  /** The open task that already answers it, or null when the new task went in. */
  taskGiven: { already: number } | null;
  taskEnded: null;
  connectTasksDropped: null;
  goalStatusChanged: null;
  parked: { at: Date } | { title: string };
  clockWoke: null;
  oddRemoved: null;
  oddBroughtBack: null;
  /** Taken, held by the owner's yes, or not gone with what it wrote kept. */
  handedOff:
    | { id: Inserted; thread: number | Inserted; left: number }
    | { asked: Inserted; thread: number | Inserted }
    | { held: HandOffHeld };
  toldLead: { lead: string; files?: Carried[] };
};

/** I/O an ask's answer does after the commit. office-decide.ts supplies it where it decides an ask. */
export type AskEffects = {
  grantAccess: typeof grantAccess;
  /** Another Google account's new connector, written onto the ask and its twins. */
  pointAsksAtConnector: (askIds: number[], access: AccessRequest) => Promise<void>;
  /** The grant's carry-out when no connect task was made. */
  carryOutTogether: typeof carryOutTogether;
  oweCatchUp: typeof oweCatchUp;
  /** Last in its row, so the answer went back first. */
  removeOdd: typeof removeOdd;
  bringBack: typeof bringBack;
};

/** I/O an Odd's leaving does after the commit. leaving.ts supplies it in `removeOdd`. */
export type LeaveEffects = {
  /** Every callback `whenOddLeaves` registered, such as the office stopping the Odd's runs. */
  stopRuns: (staffId: string) => void;
};
