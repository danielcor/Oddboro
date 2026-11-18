// A persona Odd's runs in an office under test (office-under-test.ts): its
// coding tool's stand-in works as its hands, then a fake New Altitude
// (`fake-new-altitude.ts`) answers at the persona's door with whatever a test
// sets. The made-up persona `pat` is installed before the tests start, with
// the account and pat's own sign-in already made. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import {
  L,
  bus,
  chat,
  followThrough,
  history,
  runOf,
  secrets,
  startedBy
} from './office-under-test.ts';
import { DOOR_SESSION, fakeNewAltitude, MEMBER, PAT } from './fake-new-altitude.ts';

const fake = await fakeNewAltitude();
process.env.ODDBORO_ACCOUNT_SITE = fake.origin;
/** A sign-in kept as the callback keeps it, with both tokens live at the fake. */
function signedIn(id: string, scope: string, token: string, extra: object = {}) {
  fake.issueGrant(`access-${token}`, `refresh-${token}`, scope);
  secrets.set(
    `${id}:oauth`,
    JSON.stringify({
      tokens: {
        access_token: `access-${token}`,
        refresh_token: `refresh-${token}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope
      },
      savedAt: Date.now(),
      ...extra
    })
  );
}
signedIn('new-altitude-account', 'profile personas', 'seed', {
  profile: { id: MEMBER.id, name: MEMBER.name, email: MEMBER.email },
  discovery: { authorizationServerUrl: fake.origin }
});
signedIn('new-altitude-persona-pat', 'stream', 'door');
// After the office under test is set up, as its own imports are.
const { installPersona, startPersonaGrant } = await import('./persona.ts');
const { draft, RUN_ENDED, runJob, stopReply } = await import('./staff.ts');
const { QUIET_LINE } = await import('#lib/persona.ts');
await L.setOwnerName('Ada');
await installPersona('pat');
const pat = (await L.personaOdd('pat'))!;
assert.ok(pat, 'pat was not installed');

after(() => fake.close());

/** Chat attempts and runs that ended: each frees its place in the run registry. */
let runsEnded = 0;
bus.on(RUN_ENDED, () => runsEnded++);

/** What the office sent pat's door, each turn in order. */
const doorTurns = () =>
  fake.seen
    .filter((s) => s.method === 'POST' && s.path === '/pat/stream')
    .map(
      (s) =>
        JSON.parse(s.body) as {
          message: string;
          sessionId: string;
          turnIndex: number;
          priorTurns?: Record<string, string>[];
        }
    );
const lastTurn = () => doorTurns().at(-1)!;

/** The door's answered body, as the fake sends it by default. */
const ANSWERED = { ...fake.door };
const SAID = 'From what my hands found:\n\nShip it on Friday.\n\nThis is my view, not advice.';
/** A settled body for one of the door's other outcomes, as New Altitude shapes them. */
const body = (outcome: string, more: object = {}) => ({
  outcome,
  speakable: false,
  sentences: [],
  answer: { sessionId: DOOR_SESSION, turnIndex: 0 },
  ...more
});

/** One chat message to pat: every event it sent the page, and the reply the chat kept. */
async function talk(message: string) {
  const events: { type: string; text?: string; message?: string }[] = [];
  const kept = history(pat.id).length;
  // The reply's run id, which the page gets first for Stop, is left out.
  await chat(pat.id, message, (e) => {
    if (e.type !== 'reply') events.push(e);
  });
  const added = history(pat.id).slice(kept);
  const staff = added.find((m) => m.from === 'staff');
  return { events, reply: staff?.text, failed: staff?.failed };
}
const REPORT_HEAD = 'What your hands in the office found and did:';
/** The stand-in's report is the JSON of what its run was given. */
const REPORT_START = '{"args":["-p"';

test("a chat with a persona Odd runs its hands, then sends the owner's words and the report to the door, and the reply is the persona's", async () => {
  // The hello pat said at install is a line the office wrote, which the hands' run is told first.
  assert.ok(history(pat.id).some((m) => m.told));
  const runs = runsEnded;
  const turns = doorTurns().length;
  const { events, reply } = await talk(
    'Should we ship the fair poster on Friday? Think aloud: the hands are reading the notes.'
  );
  assert.equal(runsEnded - runs, 1);
  assert.equal(doorTurns().length - turns, 1);
  const { message } = lastTurn();
  assert.ok(message.length <= 4000, `${message.length} characters`);
  const [owner, report] = message.split(REPORT_HEAD);
  assert.ok(owner.startsWith('Ada wrote to you in Oddboro'), owner);
  assert.ok(owner.includes('Should we ship the fair poster on Friday?'));
  assert.ok(!owner.includes('Before this'), owner);
  assert.ok(!owner.includes("I'm Pat"), owner);
  assert.ok(report.trim().startsWith(REPORT_START), report.slice(0, 80));
  assert.ok(report.endsWith('[cut]'));
  assert.equal(reply, SAID);
  assert.ok(!reply.includes('Outcome:'));
  // The page heard the hands' tool steps, then the persona's reply once, and none of the hands' text.
  const own = events.findIndex((e) => e.type === 'delta' && e.text === SAID);
  assert.ok(own > 0, JSON.stringify(events));
  assert.deepEqual(
    events.slice(0, own).map((e) => e.type),
    Array(own).fill('tool')
  );
  assert.deepEqual(
    events.filter((e) => e.type === 'delta').map((e) => e.text),
    [SAID]
  );
  assert.deepEqual(events.at(-1), { type: 'done', text: SAID });

  // The hands' system prompt is cut from the door's message with the rest of
  // their report, and kept nowhere. A draft, which only the hands run, shows it whole.
  const drafted = await draft(pat.id, 'Draft a note.');
  assert.equal(doorTurns().length - turns, 1);
  const { system } = JSON.parse(drafted.text.slice(0, drafted.text.lastIndexOf('\nOutcome:'))) as {
    system: string;
  };
  assert.ok(system.startsWith(L.personaDesk('Pat', 'Pat Example', 'Ada')), system.slice(0, 300));
  const odd = PAT.odd as Record<string, string>;
  for (const words of [odd.remit, odd.hello, odd.hello.replace('{owner}', 'Ada'), odd.portraitPx])
    assert.ok(!system.includes(words), `the hands were told: ${words.slice(0, 60)}`);
});

test('a chat sends earlier answered exchanges and keeps the session the door returns', async () => {
  rmSync(L.home('staff', pat.id, 'persona-session.json'), { force: true });
  await talk('First question.');
  const first = lastTurn();
  assert.deepEqual(first.priorTurns, []);
  assert.notEqual(first.sessionId, DOOR_SESSION);
  await talk('Second question.');
  const second = lastTurn();
  assert.deepEqual(second.priorTurns, [
    {
      message: 'First question.',
      answer: 'From what my hands found: Ship it on Friday. This is my view, not advice.'
    }
  ]);
  assert.equal(second.sessionId, DOOR_SESSION);
  assert.equal(second.turnIndex, 1);
  // A turn the door did not answer is never sent back as the persona's words.
  fake.door = body('failed');
  await talk('Third question.');
  fake.door = { ...ANSWERED };
  await talk('Fourth question.');
  assert.deepEqual(
    lastTurn().priorTurns?.map((t) => t.message),
    ['First question.', 'Second question.']
  );

  // Only the newest 50 exchanges go to the door, and only they are kept.
  const file = L.home('staff', pat.id, 'persona-session.json');
  const many = Array.from({ length: 60 }, (_, i) => ({ message: `Q${i}`, answer: `A${i}` }));
  writeFileSync(file, JSON.stringify({ sessionId: DOOR_SESSION, turnIndex: 60, priorTurns: many }));
  await talk('Fifth question.');
  const sent = lastTurn().priorTurns!;
  assert.equal(sent.length, 50);
  assert.equal(sent[0].message, 'Q10');
  const kept = (JSON.parse(readFileSync(file, 'utf8')) as { priorTurns: { message: string }[] })
    .priorTurns;
  assert.equal(kept.length, 50);
  assert.equal(kept[0].message, 'Q11');
  assert.equal(kept.at(-1)?.message, 'Fifth question.');
});

test("a hand-off to a persona Odd gives the persona the colleague's brief and returns its reply with the hands' outcome", async () => {
  const h = await L.handOff({
    from: 'lead',
    to: pat.id,
    work: { title: 'Price the fair tickets', brief: "Find last year's ticket price in the notes." },
    thread: { title: 'The fair tickets' }
  });
  assert.ok('id' in h, JSON.stringify(h));
  const f = await L.startFollowUp(h.id);
  assert.ok(f);
  const r = await followThrough(f);
  assert.equal(r.outcome, 'done', r.text);
  assert.equal(r.text, SAID);
  const { message } = lastTurn();
  assert.ok(
    message.includes(
      "Lena asked you: Price the fair tickets\n\nFind last year's ticket price in the notes."
    ),
    message.slice(0, 300)
  );
  assert.equal(lastTurn().priorTurns, undefined);
});

test('a follow-up whose persona does not answer fails, so the work it carries out stays open', async () => {
  const h = await L.handOff({
    from: 'lead',
    to: pat.id,
    work: { title: 'Price the fair stalls', brief: "Find last year's stall price in the notes." },
    thread: { title: 'The fair stalls' }
  });
  assert.ok('id' in h, JSON.stringify(h));
  const f = await L.startFollowUp(h.id);
  assert.ok(f);
  fake.door = body('refused_budget');
  const r = await followThrough(f);
  fake.door = { ...ANSWERED };
  assert.equal(r.outcome, 'failed', r.text);
  assert.ok(r.text.startsWith("Pat has reached New Altitude's limit for now."), r.text);
  assert.ok(r.text.includes(REPORT_START), r.text.slice(0, 200));
  // The hands' "Outcome: done" does not survive a persona that did not judge the work.
  assert.ok(!/Outcome:/.test(r.text.slice(-40)), r.text.slice(-40));
});

test("Stop during the persona's turn cancels the call to its door", async () => {
  const signals: AbortSignal[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input).endsWith('/pat/stream') && init?.signal) signals.push(init.signal);
    return real(input, init);
  };
  try {
    const held = fake.hold('/pat/stream');
    let runId = '';
    const events: { type: string; text?: string }[] = [];
    const chatting = chat(pat.id, 'Is the stall price right?', (e) => {
      if (e.type === 'reply') runId = e.runId;
      else events.push(e);
    });
    const release = await held;
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);
    assert.ok(await stopReply(pat.id, runId));
    await chatting;
    assert.equal(signals[0].aborted, true);
    assert.deepEqual(events.at(-1), {
      type: 'done',
      text: 'You stopped this reply. Completed work and saved files remain.'
    });
    release();
  } finally {
    globalThis.fetch = real;
  }
});

test("a run that reads the owner's no or edit for a lesson stays with its hands and never reaches New Altitude", async () => {
  const turns = doorTurns().length;
  const no = await L.raiseAsk(pat.id, { title: 'Post the fair poster', why: 'w', ifApproved: 'i' });
  await L.decideAsk(no.ask.id, 'deny', 'Never post on a Sunday.');
  const denied = await runOf(await startedBy(no.ask.id, 'denied'), no.ask.id);
  assert.equal(denied.env.LESSON_RUN, '1');

  writeFileSync(L.home('staff', pat.id, 'notes.md'), 'The owner wrote this.');
  assert.ok(await L.learnFromEdit(pat.id, { path: 'notes.md', before: 'Pat wrote this.' }, 'x'));
  const [f] = await L.pg<{ id: number }[]>`
    select id from follow_ups where staff_id = ${pat.id} and kind = 'edited' and outcome is null`;
  const edited = await runOf(f.id);
  assert.equal(edited.env.LESSON_RUN, '1');
  assert.equal(doorTurns().length, turns);
});

test('an over-long report is cut so the message stays within 4,000 characters', async () => {
  // The stand-in's report echoes the job's instructions, so it runs past 10,000 characters.
  const job = await L.addJob({
    staffId: pat.id,
    name: 'Long read',
    instructions: 'Read every note. '.repeat(600),
    schedule: { every: 'day', at: '09:00' }
  });
  const r = await runJob(job, 'manual');
  assert.ok(r.ok, r.text);
  const { message } = lastTurn();
  assert.ok(message.length <= 4000, `${message.length} characters`);
  assert.ok(message.startsWith("Your job in Ada's Oddboro office just ran."), message.slice(0, 80));
  assert.ok(message.endsWith('[cut]'), message.slice(-80));
  assert.equal(r.text, SAID);
});

test('every other door answer fails the chat with the report under a note and no sign-in card, and a budget wait reads in whole minutes or hours, rounded up', async () => {
  const budget = (seconds: number, line: string): [string, () => void, string] => [
    `refused_budget after ${seconds} seconds`,
    () =>
      void (fake.door = body('refused_budget', {
        refusal: { retryAfterSeconds: seconds }
      })),
    line
  ];
  const cases: [string, () => void, string][] = [
    [
      'refused_content',
      () =>
        void (fake.door = body('refused_content', {
          presentation: { text: 'I only talk about pricing.' }
        })),
      'I only talk about pricing.'
    ],
    budget(30, 'Try again in 1 minute.'),
    budget(70, 'Try again in 2 minutes.'),
    budget(3_600, 'Try again in 1 hour.'),
    budget(73_000, 'Try again in 21 hours.'),
    ['failed', () => void (fake.door = body('failed')), 'Pat could not answer just now.'],
    ['abandoned', () => void (fake.door = body('abandoned')), 'Pat could not answer just now.'],
    [
      'interrupted',
      () => void (fake.door = body('interrupted', { partialReply: 'Ship' })),
      'Pat could not finish this answer.'
    ],
    ['503', () => void fake.refused.set('/pat/stream', 503), 'Pat could not answer just now.'],
    [
      'an unreachable refresh',
      () => {
        const blob = JSON.parse(secrets.get('new-altitude-persona-pat:oauth')!);
        secrets.set(
          'new-altitude-persona-pat:oauth',
          JSON.stringify({ ...blob, savedAt: Date.now() - 3_600_000 })
        );
        fake.down.add('/token');
      },
      'Pat could not answer just now.'
    ]
  ];
  for (const [name, set, line] of cases) {
    set();
    const { events, reply, failed } = await talk(`About ${name}?`);
    fake.door = { ...ANSWERED };
    fake.refused.clear();
    fake.down.clear();
    assert.ok(reply, `${name}: the chat kept no reply`);
    assert.equal(failed, true, name);
    // The persona's door failed, not the hands' sign-in, so the page shows no sign-in card.
    assert.deepEqual(events.at(-1), { type: 'error', message: reply }, name);
    assert.ok(reply.split('\n')[0].includes(line), `${name}: ${reply.slice(0, 120)}`);
    if (name === 'interrupted') {
      assert.ok(reply.includes("\n\nShip\n\nHere is what Pat's hands found."), reply);
    }
    assert.ok(reply.includes("Here is what Pat's hands found.\n\n" + REPORT_START), name);
    assert.equal((await L.personaOdd('pat'))?.package?.quiet, undefined, name);
  }
  // The refresh that could not reach New Altitude kept pat's sign-in.
  assert.ok(JSON.parse(secrets.get('new-altitude-persona-pat:oauth')!).tokens);
});

test('when the door refuses access the owner still gets the report, the Odd goes quiet and runs nothing next time, and Reconnect signs in afresh', async () => {
  fake.refused.set('/pat/stream', 401);
  const turned = await talk('Are you there?');
  fake.refused.clear();
  assert.ok(turned.reply?.startsWith(QUIET_LINE.grant('Pat')), turned.reply);
  assert.ok(turned.reply?.includes(REPORT_START));
  assert.equal((await L.personaOdd('pat'))?.package?.quiet, 'grant');
  // The refused sign-in is dropped, so Reconnect opens New Altitude's page instead of refreshing it.
  assert.equal(JSON.parse(secrets.get('new-altitude-persona-pat:oauth')!).tokens, undefined);
  assert.ok((await startPersonaGrant('pat')).url);
  signedIn('new-altitude-persona-pat', 'stream', 'door2');
  await L.setQuiet(pat.id, undefined);

  // Tokens a refresh kept while the door turned an older one down stay.
  const KEY = 'new-altitude-persona-pat:oauth';
  const stale = { access_token: 'access-stale', token_type: 'Bearer', expires_in: 3600 };
  secrets.set(KEY, JSON.stringify({ tokens: stale, savedAt: Date.now() }));
  const held = fake.hold('/pat/stream');
  const turning = talk('Anyone there?');
  const release = await held;
  signedIn('new-altitude-persona-pat', 'stream', 'door3');
  release();
  await turning;
  assert.equal(JSON.parse(secrets.get(KEY)!).tokens.access_token, 'access-door3');
  await L.setQuiet(pat.id, undefined);

  fake.door = body('refused_access');
  const { reply } = await talk('Still with us?');
  fake.door = { ...ANSWERED };
  assert.ok(reply?.startsWith(QUIET_LINE.access('Pat')), reply);
  assert.ok(reply?.includes(REPORT_START));
  assert.equal((await L.personaOdd('pat'))?.package?.quiet, 'access');

  const runs = runsEnded;
  const turns = doorTurns().length;
  const kept = history(pat.id).length;
  const quiet = await talk('Hello?');
  // Only the chat's attempt ended: its hands never ran, so no tool step below.
  assert.equal(runsEnded - runs, 1);
  assert.equal(doorTurns().length, turns);
  // A quiet Odd's chat ends as any failed chat does: the owner's line and the
  // quiet line stay, marked failed, so a reload shows both (NEW-1658).
  assert.deepEqual(
    history(pat.id)
      .slice(kept)
      .map(({ from, text, failed }) => ({ from, text, failed })),
    [
      { from: 'owner', text: 'Hello?', failed: undefined },
      { from: 'staff', text: QUIET_LINE.access('Pat'), failed: true }
    ]
  );
  assert.deepEqual(quiet.events, [{ type: 'error', message: QUIET_LINE.access('Pat') }]);
});
