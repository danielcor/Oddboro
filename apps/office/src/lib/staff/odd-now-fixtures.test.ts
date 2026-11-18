// One fixture per state an Odd can show renders every screen that reads an
// Odd's state (svelte-load.ts compiles them) and checks the words each shows
// against the fixture's own. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import type { AskRow, HandOffLine } from '@oddboro/ledger';
import { untilStable } from '#lib/server/google/http.ts';
import {
  CARRY_OUT_LABEL,
  CATCH_UP,
  deskOf,
  GONE,
  HAND_OFF_LABEL,
  handOff,
  HELLO,
  IDS,
  JOBS,
  NAMES,
  nameOf,
  work
} from '#lib/staff/odd-now-cases.ts';
import {
  handOffProgress,
  jobRunning,
  oddNow,
  readerProps,
  tagWords,
  type Show,
  type Snapshot
} from '#lib/staff/odd-now.ts';
import type { Activity, StaffProfile } from '#lib/staff/roster.ts';
import type { Work } from '#lib/staff/work.ts';

/** An Odd's profile, with only the fields its screens read. Every Odd here is a Writer. */
const profileOf = (id: string) =>
  ({
    id,
    name: NAMES[id],
    role: 'Writer',
    agent: 'claude',
    permission: 'read',
    hired: '2026-11-01',
    remit: 'Writes the briefs.',
    portrait: id,
    sprite: id,
    variant: 'a',
    guesses: 0,
    tools: []
    // The rest of a profile is the server's, and no screen here reads it.
  }) as unknown as StaffProfile;

/** Where the floor put each Odd: Ada at `activity`, the rest at work. */
const adaAt = (activity: Activity): Record<string, Activity> => ({
  ada: activity,
  bo: 'work',
  cy: 'work'
});

/** The office as the page holds it: Ada, Bo and Cy at work with nothing going, then `more`. */
const office = (more: Partial<Snapshot> = {}): Snapshot => ({
  ids: IDS,
  inProgress: {},
  toStart: {},
  chatting: [],
  desk: deskOf([], []),
  staff: IDS.map(profileOf),
  messages: {},
  threads: [],
  activity: Object.fromEntries(IDS.map((id) => [id, 'work' as Activity])),
  nameOf,
  ...more
});

const goingRun = (id: number, label: string, more: Partial<Work> = {}) =>
  work(id, label, { queued: false, ...more });
/** Bo's thread, which Ada holds for it. */
const BOS_THREAD = { title: HAND_OFF_LABEL, hubId: 'bo', holderId: 'ada' };
/** The hand-off Bo gave Ada, as Bo's chat lists it. */
const toAda = handOff({ from: 'Bo', to: 'Ada', fromId: 'bo', toId: 'ada' });
/** A step that came back waiting on the owner, who has since answered. */
const answeredBack = {
  at: new Date('2026-11-12T10:00:00.000Z'),
  outcome: 'waiting' as const,
  text: 'Asked the owner',
  answered: true,
  pickUp: { status: 'done' as const }
};

/** A piece of work in the list, by its label, and how it stands. */
type Item = [label: string, stands: 'going' | 'slot' | 'start'];
/** What the info page and the chat's foot say of a piece of work, past its label. */
const ITEM_WORDS = {
  going: { info: 'Thinking · 0 steps', chat: 'Thinking' },
  slot: {
    info: 'Waiting for a free slot: Ada runs up to three things at once.',
    chat: 'waiting for a free slot'
  },
  start: { info: "Starts once Ada's current run on this work ends.", chat: 'waiting to start' }
};

/** What Ada's screens show. */
type Expected = {
  /** The floor tag, the card line and the rail's title. */
  words: string;
  /** The info page's line. */
  info: string;
  work: Item[];
  /** The rail's count and the card's in-progress count. */
  count: number;
  /** Whether the rail rings Ada. */
  ring: boolean;
  /** The Jobs tab's line while a run goes. */
  jobsLine?: string;
  /** The jobs the Jobs tab shows Running. */
  running: string[];
  /** Whether Run now is locked. */
  locked: boolean;
};

/** A hand-off line in the lead's chat, read in `office` (the fixture's own by default). */
type HandOffCheck = {
  lead: string;
  line: HandOffLine;
  office?: Snapshot;
  text: string;
};

type Fixture = { name: string; snap: Snapshot; expect: Expected; handOffs?: HandOffCheck[] };

/** Ada with nothing going and nothing queued. */
const idle = { work: [], count: 0, ring: false, running: [], locked: false };
/** Ada with the Morning brief going, whatever she shows. */
const briefGoing: Pick<Expected, 'work' | 'count' | 'jobsLine' | 'running' | 'locked'> = {
  work: [['Morning brief', 'going']],
  count: 1,
  jobsLine: 'Running Morning brief now.',
  running: ['Morning brief'],
  locked: true
};
const brief = { ada: [goingRun(1, 'Morning brief')] };

/** Every state Ada can show, each with the offices that put her there. */
const FIXTURES: Record<Show['is'], Fixture[]> = {
  message: [
    {
      name: 'a message',
      snap: office({ messages: { ada: 1 }, activity: adaAt('wait') }),
      expect: { ...idle, words: 'Has a message for you', info: 'Has a message for you', ring: true }
    },
    {
      name: 'a message while running',
      snap: office({ messages: { ada: 1 }, inProgress: brief, activity: adaAt('wait') }),
      expect: {
        ...briefGoing,
        words: 'Has a message for you',
        info: 'Has a message for you',
        ring: true
      }
    }
  ],
  waitingOnYou: [
    {
      name: 'waiting on you',
      snap: office({ desk: deskOf([{ id: 1, staffId: 'ada' }], []), activity: adaAt('wait') }),
      expect: { ...idle, words: 'Waiting on you', info: 'Waiting on you', ring: true }
    },
    {
      name: 'waiting on you while running',
      snap: office({
        desk: deskOf([{ id: 1, staffId: 'ada' }], []),
        inProgress: brief,
        activity: adaAt('wait')
      }),
      expect: { ...briefGoing, words: 'Waiting on you', info: 'Waiting on you', ring: true }
    }
  ],
  holding: [
    {
      name: 'holding a thread',
      snap: office({ threads: [BOS_THREAD] }),
      expect: { ...idle, words: 'Plan the trip · with Bo', info: 'Plan the trip · with Bo' }
    },
    {
      name: 'holding while its hand-off run goes',
      snap: office({
        threads: [BOS_THREAD],
        inProgress: {
          ada: [goingRun(1, HAND_OFF_LABEL, { kind: 'follow-up', handOffId: toAda.id })]
        }
      }),
      expect: {
        words: 'Plan the trip · with Bo',
        info: 'Plan the trip · with Bo',
        work: [['Plan the trip', 'going']],
        count: 1,
        ring: false,
        running: [],
        locked: true
      },
      handOffs: [
        { lead: 'bo', line: toAda, text: 'Ada is on it' },
        {
          lead: 'bo',
          line: toAda,
          office: office({
            threads: [BOS_THREAD],
            toStart: {
              ada: [
                work(1, HAND_OFF_LABEL, { kind: 'follow-up', toStart: true, handOffId: toAda.id })
              ]
            }
          }),
          text: 'Ada has not started yet'
        },
        {
          // Ada's step came back waiting on the owner, and she carries out their yes.
          lead: 'bo',
          line: { ...toAda, backs: [answeredBack] },
          office: office({
            threads: [BOS_THREAD],
            inProgress: {
              ada: [goingRun(2, CARRY_OUT_LABEL, { kind: 'follow-up', handOffId: toAda.id })]
            }
          }),
          text: 'Ada is back on it'
        }
      ]
    }
  ],
  leading: [
    {
      name: 'leading a thread a colleague holds',
      snap: office({ threads: [{ title: HAND_OFF_LABEL, hubId: 'ada', holderId: 'bo' }] }),
      expect: { ...idle, words: 'Waiting on Bo', info: 'Waiting on Bo' }
    },
    {
      name: 'leading a thread a colleague holds while running',
      snap: office({
        threads: [{ title: HAND_OFF_LABEL, hubId: 'ada', holderId: 'bo' }],
        inProgress: brief
      }),
      expect: {
        ...briefGoing,
        words: 'Plan the trip · with Bo',
        info: 'Plan the trip · with Bo',
        ring: false
      }
    }
  ],
  chatting: [
    {
      name: 'chatting',
      snap: office({ chatting: ['ada'] }),
      expect: { ...idle, words: 'Replying to you', info: 'Replying to you' }
    },
    {
      name: 'chatting while a run goes',
      snap: office({ chatting: ['ada'], inProgress: brief }),
      expect: { ...briefGoing, words: 'Replying to you', info: 'Replying to you', ring: false }
    }
  ],
  running: [
    {
      name: 'running two runs',
      snap: office({
        inProgress: { ada: [goingRun(1, 'Morning brief'), goingRun(2, 'Inbox sweep')] }
      }),
      expect: {
        words: 'Morning brief +1 more',
        info: 'Running Morning brief +1 more',
        work: [
          ['Morning brief', 'going'],
          ['Inbox sweep', 'going']
        ],
        count: 2,
        ring: false,
        jobsLine: 'Running Morning brief +1 more now.',
        running: ['Morning brief', 'Inbox sweep'],
        locked: true
      }
    },
    {
      name: 'saying hello',
      snap: office({ inProgress: { ada: [goingRun(1, HELLO)] } }),
      expect: {
        words: 'Saying hello',
        info: 'Running Saying hello',
        work: [['Saying hello', 'going']],
        count: 1,
        ring: false,
        jobsLine: 'Running Saying hello now.',
        running: [],
        locked: true
      }
    },
    {
      name: 'a catch-up run going',
      snap: office({ inProgress: { ada: [goingRun(1, CATCH_UP)] } }),
      expect: {
        words: 'Catching up 2 periods of Morning brief',
        info: 'Running Catching up 2 periods of Morning brief',
        work: [['Catching up 2 periods of Morning brief', 'going']],
        count: 1,
        ring: false,
        jobsLine: 'Running Catching up 2 periods of Morning brief now.',
        running: [],
        locked: true
      }
    }
  ],
  queued: [
    {
      name: 'queued only',
      snap: office({ inProgress: { ada: [work(1, 'Morning brief')] } }),
      expect: {
        ...idle,
        words: 'Working',
        info: 'Working',
        work: [['Morning brief', 'slot']],
        count: 1
      }
    },
    {
      name: 'a follow-up yet to start',
      snap: office({
        toStart: {
          ada: [work(1, HAND_OFF_LABEL, { kind: 'follow-up', toStart: true, handOffId: 7 })]
        },
        activity: adaAt('read')
      }),
      expect: {
        ...idle,
        words: 'Reading in the library',
        info: 'Reading in the library',
        work: [['Plan the trip', 'start']],
        count: 1
      }
    }
  ],
  free: [
    {
      name: 'free at work after a run ended',
      snap: office(),
      expect: { ...idle, words: 'At their desk', info: 'At their desk' }
    },
    {
      name: 'free elsewhere',
      snap: office({ activity: adaAt('play') }),
      expect: { ...idle, words: 'In the break room', info: 'In the break room' }
    },
    {
      name: "free elsewhere with an office task on the Desk, which is no Odd's",
      snap: office({
        desk: deskOf([], [{ id: 1, staffId: null }]),
        activity: adaAt('play')
      }),
      expect: { ...idle, words: 'In the break room', info: 'In the break room' }
    },
    {
      name: "a hand-off to a colleague who has left keeps today's line",
      snap: office(),
      expect: { ...idle, words: 'At their desk', info: 'At their desk' },
      handOffs: [
        {
          lead: 'ada',
          line: handOff({ toId: GONE, to: 'Dee', status: 'failed' }),
          text: 'Dee could not finish · Ada is taking it from here'
        }
      ]
    }
  ]
};

/** A render's markup without Svelte's hydration markers, which split what the owner reads. */
const markup = (rendered: { body: string }) => untilStable(rendered.body, /<!--.*?-->/gs, '');
/** The text of `html` as the owner reads it: tags dropped, entities decoded, spaces collapsed. */
const plain = (html: string) =>
  untilStable(html, /<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
/** Each match of `re` in `html`, its groups as plain text. */
const each = (html: string, re: RegExp) =>
  [...html.matchAll(re)].map((m) => m.slice(1).map((g) => (g === undefined ? g : plain(g))));
/** The first group of the first match, as plain text; undefined with no match. */
const first = (html: string, re: RegExp) => {
  const group = re.exec(html)?.[1];
  return group === undefined ? group : plain(group);
};

/** The screens that read an Odd's state, compiled by svelte-load.ts, loaded once. */
let screens: ReturnType<typeof loadScreens> | undefined;
async function loadScreens() {
  // Static imports are hoisted, so the hook is in place only if the components load after it.
  register('./svelte-load.ts', import.meta.url);
  return {
    render: (await import('svelte/server')).render,
    StaffCard: (await import('#lib/ui/StaffCard.svelte')).default,
    OddInfo: (await import('#lib/ui/OddInfo.svelte')).default,
    OddsRail: (await import('#lib/ui/OddsRail.svelte')).default
  };
}

test("every reader of an Odd's status shows the same state for the same fixture", async (t) => {
  const { render, StaffCard, OddInfo, OddsRail } = await (screens ??= loadScreens());
  const onplan = (_hires: AskRow[]) => {};
  const none = () => {};

  for (const [is, fixtures] of Object.entries(FIXTURES)) {
    for (const f of fixtures) {
      await t.test(f.name, () => {
        const props = readerProps(f.snap, oddNow(f.snap), 'ada', onplan);
        const profile = f.snap.staff[0];
        const activity = f.snap.activity.ada;
        const card = markup(
          render(StaffCard, {
            props: {
              ...props,
              profile,
              activity,
              version: 0,
              onitem: none,
              places: [],
              manual: false,
              sentTo: undefined,
              held: {},
              onsend: none,
              onschedule: none,
              onchatstart: none,
              onchatend: none,
              oncollapse: none,
              onclose: none
            }
          })
        );
        const info = markup(
          render(OddInfo, {
            props: { profile, activity, version: 0, now: props.now, focus: 0, onsend: none }
          })
        );
        const rail = markup(
          render(OddsRail, {
            props: {
              staff: f.snap.staff,
              nowOf: props.nowOf,
              headings: Object.fromEntries(IDS.map((id) => [id, undefined])),
              onselect: none,
              onchat: none
            }
          })
        );
        // Ada's place on the rail, as markup: its title, its ring and its count.
        const onRail = /<li><button[^>]*aria-label="Ada, Writer"(.*?)<\/li>/s.exec(rail)?.[1] ?? '';
        const shown = {
          tag: tagWords(props.now),
          rail: {
            words: first(onRail, /title="Ada, Writer: ([^"]*)"/),
            count: Number(first(onRail, /aria-hidden="true">(\d+)<\/span>/) ?? 0),
            ring: onRail.includes('ring-2 ring-ember')
          },
          card: {
            words: first(card, /Writer · ([^<]*)<\/span>/),
            count: Number(first(card, /aria-label="(\d+) in progress"/) ?? 0)
          },
          info: {
            words: first(info, /<span class="truncate">([^<]*)<\/span>/),
            work: each(
              info,
              /<section class="rounded-xl bg-raise p-3[^"]*" aria-label="[^"]*">.*?<h3[^>]*>(.*?)<\/h3>\s*<p[^>]*>(.*?)<\/p>/gs
            )
          },
          chat: each(
            card,
            /title="Open In progress">([^<]*)<\/button> <span[^>]*>· ([^<]*)<\/span>(?: <span class="min-w-0 truncate[^"]*">· ([^<]*)<\/span>)?/g
          ).map(([label, stands, doing]) => [label, doing ?? stands]),
          jobs: {
            line: first(info, /(Running [^<]* now\.)/),
            // The Jobs tab lists its jobs once it has fetched them, which a server
            // render never does, so its badge and lock are read as it reads them.
            running: JOBS.filter((job) => jobRunning(props.now, job)),
            locked: props.now.runs.length > 0
          }
        };
        const e = f.expect;
        assert.deepEqual(shown, {
          tag: e.words,
          rail: { words: e.words, count: e.count, ring: e.ring },
          card: { words: e.words, count: e.count },
          info: {
            words: e.info,
            work: e.work.map(([label, stands]) => [label, ITEM_WORDS[stands].info])
          },
          chat: e.work.map(([label, stands]) => [label, ITEM_WORDS[stands].chat]),
          jobs: { line: e.jobsLine, running: e.running, locked: e.locked }
        });
        for (const h of f.handOffs ?? []) {
          const snap = h.office ?? f.snap;
          const { nowOf } = readerProps(snap, oddNow(snap), h.lead, onplan);
          assert.equal(handOffProgress(h.line, nowOf).text, h.text);
        }
        assert.equal(props.now.show.is, is);
      });
    }
  }
});

test("the rail's title says where an Odd is headed, and Arriving for one the floor has not placed or the page holds no state for", async () => {
  const { render, OddsRail } = await (screens ??= loadScreens());
  const snap = office();
  const { nowOf } = readerProps(snap, oddNow(snap), 'ada', () => {});
  // Dee has left, so the page holds no state for her.
  const staff = [...snap.staff, { ...profileOf('ada'), id: GONE, name: 'Dee' }];
  const titles = (headings: Record<string, string | undefined>) => {
    const rail = markup(
      render(OddsRail, {
        props: { staff, nowOf, headings, onselect: () => {}, onchat: () => {} }
      })
    );
    return Object.fromEntries(
      ['Ada', 'Bo', 'Dee'].map((name) => [
        name,
        first(rail, new RegExp(`title="${name}, Writer: ([^"]*)"`))
      ])
    );
  };
  assert.deepEqual(titles({ ada: 'Kitchen', bo: undefined, cy: undefined, [GONE]: undefined }), {
    Ada: '→ Kitchen',
    Bo: 'At their desk',
    Dee: 'Arriving'
  });
  // The floor has not placed Ada yet.
  assert.deepEqual(titles({ bo: undefined, cy: undefined, [GONE]: undefined }), {
    Ada: 'Arriving',
    Bo: 'At their desk',
    Dee: 'Arriving'
  });
});

test('a comment that one pass of the strip would leave behind is gone from the markup', () => {
  assert.equal(markup({ body: '<!-<!---->--->' }), '');
  // One pass of the tag strip already leaves no tag here, so no input tells
  // the loop apart from it. The loop is for CodeQL's multi-character rule.
  assert.equal(plain('<scr<b>ipt>'), 'ipt>');
});
