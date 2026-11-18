// What the owner tells a colleague in chat about a thread reaches the
// thread's lead: the colleague's chat lists the threads it works on and does
// not lead, and tell_lead passes the owner's own words to the lead. The
// office's own code on every migration, in an in-memory PGlite that stands in
// for db.ts (pglite.ts). Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { connectors, followUps, goals, grants, staff, staffGoals, threads } from '../src/schema.ts';
import { db } from './pglite.ts';

// Loaded once db.ts is this database, so every query they make lands here.
const { handOff } = await import('../src/hand-offs.ts');
const { raiseAsk } = await import('../src/office.ts');
const { exchangeForLead, notLed, tellLead, threadFolder, threadPart, threadsOn, threadsOnBrief } =
  await import('../src/threads.ts');
const { setOwnerName } = await import('../src/office-usage.ts');
// The lead's note names the owner as the office does, by the name they gave.
await setOwnerName('Sam');

const odd = (id: string, name: string) => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft' as const,
  desk: `You are ${name}.`
});
await db.insert(staff).values([odd('cole', 'Cole'), odd('bram', 'Bram'), odd('rex', 'Rex')]);

/** `hub` hands `to` a piece of work on a new thread. Returns the thread. */
async function onThread(hub: string, to: string, title: string): Promise<number> {
  const r = await handOff({
    from: hub,
    to,
    work: { title: 'Draw the presets', brief: 'Draw two presets.' },
    thread: { title }
  });
  assert.ok('id' in r, JSON.stringify(r));
  return r.thread;
}
const presets = await onThread('cole', 'bram', 'Presets for the sim');
const ownThread = await onThread('bram', 'rex', 'Bram leads this one');

const said = 'Thanks Bram. On the presets: make the colours warmer.\nAlso, lunch at one?';
const reading = 'Sam wants the presets in warmer colours.';
const tell = (staffId: string, threadId: number, words = 'make the colours warmer.') =>
  tellLead({ staffId, threadId, said, words, reading });
const resumes = (id: number) =>
  db
    .select()
    .from(followUps)
    .where(and(eq(followUps.threadId, id), eq(followUps.kind, 'resume')));

// Gil holds Gmail. Lena leads work Gil is on and lacks it; Mae leads other
// work Gil is on and holds it too. Every office has Gmail (0009_google): mark
// it connected, so Mae's grant is in force. Set up here, above the first test:
// under --test-force-exit the runner drops every test registered after a
// top-level await.
await db.insert(staff).values([odd('gil', 'Gil'), odd('lena', 'Lena'), odd('mae', 'Mae')]);
await db.update(connectors).set({ readyAt: new Date() }).where(eq(connectors.id, 'gmail'));
await db.insert(grants).values([
  { staffId: 'gil', connectorId: 'gmail', level: 'read' },
  { staffId: 'mae', connectorId: 'gmail', level: 'read' }
]);

test("a colleague's chat lists the threads it works on and does not lead, with each lead and where it stands", async () => {
  const rows = await threadsOn('bram');
  assert.deepEqual(rows, [
    { id: presets, title: 'Presets for the sim', stage: 'under_way', lead: 'Cole', goalId: null }
  ]);
  const brief = threadsOnBrief(rows);
  assert.match(brief, /^## Work you are on$/m);
  assert.ok(brief.includes(`- Work ${presets}: Presets for the sim, led by Cole (under way).`));
  assert.match(brief, /pass their words to its lead with tell_lead/);
  assert.equal(threadsOnBrief(await threadsOn('cole')), '');
});

test("tell_lead writes one resume for the lead, with the owner's words, the colleague's reading labelled as not theirs, and the last exchange, on one line", async () => {
  const r = await tellLead({
    staffId: 'bram',
    threadId: presets,
    said,
    words: 'make the colours warmer.',
    reading: 'Sam wants the presets\nin warmer colours.',
    exchange: 'Just before, Sam said: "Done yet?".\nBram replied: "Nearly.".'
  });
  assert.deepEqual(r, { lead: 'Cole' });
  const [wake, ...more] = await resumes(presets);
  assert.equal(more.length, 0);
  assert.equal(wake.staffId, 'cole');
  assert.equal(
    wake.note,
    'Bram passed you what Sam told them in chat about this work. You decide what comes of it and hand on any work it needs; Bram does nothing more with it. Sam\'s words: make the colours warmer. Bram\'s own reading, which is not Sam\'s words: Sam wants the presets in warmer colours. Just before, Sam said: "Done yet?". Bram replied: "Nearly.".'
  );
});

test('a tell_lead with no reading is refused', async () => {
  const quiet = await onThread('cole', 'bram', 'Presets with no reading');
  const r = await tellLead({
    staffId: 'bram',
    threadId: quiet,
    said,
    words: 'make the colours warmer.',
    reading: ' \n '
  });
  assert.ok('problem' in r && r.problem.includes('in reading'), JSON.stringify(r));
  assert.equal((await resumes(quiet)).length, 0);
});

test("a colleague's chat is told to work out a clarification in chat and pass nothing on", async () => {
  const rows = await threadsOn('bram');
  assert.match(threadsOnBrief(rows), /work it out in chat and pass nothing on/);
});

test("words that are not the owner's are refused, so nothing else reaches the lead as theirs", async () => {
  const before = (await resumes(presets)).length;
  const r = await tell('bram', presets, 'make the colours colder.');
  assert.ok('problem' in r && r.problem.includes('copied exactly'), JSON.stringify(r));
  assert.equal((await resumes(presets)).length, before);
});

test('tell_lead on a thread the Odd leads is refused', async () => {
  const r = await tell('bram', ownThread);
  assert.ok('problem' in r && r.problem.includes('You lead work'), JSON.stringify(r));
  assert.equal((await resumes(ownThread)).length, 0);
});

test('tell_lead on a thread the Odd is not on is refused', async () => {
  const r = await tell('rex', presets);
  assert.ok('problem' in r && r.problem.includes('is not work you are on'), JSON.stringify(r));
});

test('tell_lead on a thread the owner stopped is refused, and copies no file the owner attached', async () => {
  const stopped = await onThread('cole', 'bram', 'Stopped work');
  await db
    .update(threads)
    .set({ status: 'stopped', endedAt: new Date() })
    .where(eq(threads.id, stopped));
  const r = await tellLead({
    staffId: 'bram',
    threadId: stopped,
    said,
    words: 'make the colours warmer.',
    reading,
    files: { carry: [attached('swatch.png', 'png')], unfit: [] }
  });
  assert.ok('problem' in r && r.problem.includes('stopped'), JSON.stringify(r));
  assert.equal((await resumes(stopped)).length, 0);
  assert.equal(existsSync(threadPart(stopped, 'bram')), false, 'a file was copied');
});

test("a goal's Odd never handed a piece of its work tells the lead by its own name", async () => {
  await db.insert(staff).values(odd('zed', 'Zed'));
  const [goal] = await db.insert(goals).values({ title: 'A warmer sim' }).returning();
  // Zed serves the goal and is handed nothing, so only its serving puts it on the work.
  await db.insert(staffGoals).values({ staffId: 'zed', goalId: goal.id, part: 'The colours' });
  const r = await handOff({
    from: 'cole',
    to: 'bram',
    work: { title: 'Draw the presets', brief: 'Draw two presets.' },
    thread: { title: 'A warmer sim', goalId: goal.id }
  });
  assert.ok('id' in r, JSON.stringify(r));
  assert.deepEqual(await tell('zed', r.thread), { lead: 'Cole' });
  const [wake] = await resumes(r.thread);
  assert.ok(wake.note?.startsWith('Zed passed you what Sam told them'), wake.note ?? '');
});

test("a colleague's chat says the work waits on the owner while an ask raised on it is open", async () => {
  const raised = await onThread('cole', 'bram', 'Presets to buy');
  await raiseAsk('cole', {
    title: 'Buy a preset pack',
    why: 'It saves a day.',
    ifApproved: 'I buy it.',
    threadId: raised
  });
  const row = (await threadsOn('bram')).find((t) => t.id === raised);
  assert.ok(row, 'Bram is not on the work');
  assert.equal(row.stage, 'waiting_on_you');
  assert.ok(threadsOnBrief([row]).includes('led by Cole (waiting on {owner})'));
});

const exchange = 'Just before, Sam said: "Any news?".\nGil replied: "The bank wrote back.".';
const fromGil = async (lead: string, title: string, exchange?: string) => {
  const id = await onThread(lead, 'gil', title);
  const r = await tellLead({
    staffId: 'gil',
    threadId: id,
    said,
    words: 'make the colours warmer.',
    reading,
    exchange
  });
  assert.ok('lead' in r, JSON.stringify(r));
  const [wake] = await resumes(id);
  return wake.note ?? '';
};
const gilsReading = `Gil's own reading, which is not Sam's words: ${reading}`;

test('a lead holding every tool the colleague holds reads the last exchange in full', async () => {
  assert.ok(
    (await fromGil('mae', 'Mae holds Gmail', exchange)).endsWith(
      `${gilsReading} Just before, Sam said: "Any news?". Gil replied: "The bank wrote back.".`
    )
  );
});

test("a lead lacking a tool the colleague holds reads the owner's line and not the colleague's, and is told one line was left out", async () => {
  const note = await fromGil('lena', 'Lena lacks Gmail', exchange);
  assert.ok(
    note.endsWith(
      `${gilsReading} Just before, Sam said: "Any news?". One line Gil said in that chat is left out, since Gil has Gmail and you do not.`
    ),
    note
  );
  assert.ok(!note.includes('bank'), note);
});

test("a colleague's line alone is left out for a lead lacking its tools", async () => {
  const note = await fromGil(
    'lena',
    'Lena lacks Gmail, Gil spoke first',
    'Just before, Gil said: "The bank wrote back.".'
  );
  assert.ok(
    note.endsWith(
      `${gilsReading} One line Gil said in that chat is left out, since Gil has Gmail and you do not.`
    ),
    note
  );
});

test("with no exchange, a lead lacking the colleague's tools reads the note as it was", async () => {
  assert.ok((await fromGil('lena', 'Lena lacks Gmail, no exchange')).endsWith(gilsReading));
});

test("with the colleague's line set to be quoted, a lead lacking its tools reads the exchange in full", () => {
  assert.equal(
    exchangeForLead(exchange, 'Gil', [{ id: 'gmail', name: 'Gmail' }], 'quoted'),
    'Just before, Sam said: "Any news?". Gil replied: "The bank wrote back.".'
  );
});

/** A file the owner attached, kept outside every work: what `tellLead` copies in. */
function attached(name: string, text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oddboro-attached-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, name);
  writeFileSync(real, text);
  return { real, name, named: name };
}
// A junction on Windows, which needs no admin.
const linkFolder = (to: string, at: string) =>
  symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir');

test("a file the owner attached lands in the colleague's part once, and told again it is left as it is and listed again", async () => {
  const work = await onThread('cole', 'rex', 'Presets with a sketch');
  const sketch = attached('sketch.png', 'png');
  const at = join(threadPart(work, 'rex'), 'sketch.png');
  for (const time of ['first', 'again']) {
    const r = await tellLead({
      staffId: 'rex',
      threadId: work,
      said,
      words: 'make the colours warmer.',
      reading,
      files: { carry: [sketch], unfit: [] }
    });
    assert.deepEqual(r, { lead: 'Cole', files: [{ named: 'sketch.png', at }] }, time);
  }
  assert.equal(readFileSync(at, 'utf8'), 'png');
  const [wake] = await resumes(work);
  const lines = (wake.note ?? '').split('\n');
  assert.equal(lines.length, 2, 'the second joins the pick-up still to start');
  for (const line of lines)
    assert.ok(
      line.endsWith(
        `Rex's own reading, which is not Sam's words: ${reading} Sam attached a file to that message, now in this work: sketch.png at ${at}.`
      ),
      line
    );
});

test("a file that cannot land never holds back the owner's words: the lead is told which did not come and why", async () => {
  const work = await onThread('cole', 'rex', 'Presets with a linked part');
  const elsewhere = mkdtempSync(join(tmpdir(), 'oddboro-elsewhere-'));
  after(() => rmSync(elsewhere, { recursive: true, force: true }));
  mkdirSync(threadFolder(work), { recursive: true });
  linkFolder(elsewhere, threadPart(work, 'rex'));
  const r = await tellLead({
    staffId: 'rex',
    threadId: work,
    said,
    words: 'make the colours warmer.',
    reading,
    files: {
      carry: [attached('swatch.png', 'png')],
      unfit: [{ named: 'Image #2', why: 'it is reached through a link' }]
    }
  });
  assert.ok('lead' in r, JSON.stringify(r));
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing landed through the link');
  const [wake] = await resumes(work);
  assert.ok(
    wake.note?.endsWith(
      `Rex's own reading, which is not Sam's words: ${reading} 2 files Sam attached did not come: swatch.png, since the part of the work it would land in is a link; Image #2, since it is reached through a link.`
    ),
    wake.note ?? ''
  );
});

test("a file the owner attached lands under the next free name when a different file holds its own, the lead's note names it there, and told again it is left as it is", async () => {
  const work = await onThread('cole', 'rex', 'Presets with notes');
  const part = threadPart(work, 'rex');
  mkdirSync(part, { recursive: true });
  writeFileSync(join(part, 'notes.md'), "Rex's own notes");
  const notes = attached('notes.md', 'the owner notes');
  // A second file of the same name, from another message, which the chat tags apart.
  const more = { ...attached('notes.md', 'more notes'), named: 'notes (2).md' };
  const tell = (carry: (typeof notes)[]) =>
    tellLead({
      staffId: 'rex',
      threadId: work,
      said,
      words: 'make the colours warmer.',
      reading,
      files: { carry, unfit: [] }
    });
  const second = join(part, 'notes-2.md');
  const third = join(part, 'notes-3.md');
  assert.deepEqual(await tell([notes, more]), {
    lead: 'Cole',
    files: [
      { named: 'notes.md', at: second },
      { named: 'notes (2).md', at: third }
    ]
  });
  assert.deepEqual(await tell([notes]), {
    lead: 'Cole',
    files: [{ named: 'notes.md', at: second }]
  });
  assert.deepEqual(readdirSync(part).sort(), ['notes-2.md', 'notes-3.md', 'notes.md']);
  assert.equal(readFileSync(join(part, 'notes.md'), 'utf8'), "Rex's own notes");
  assert.equal(readFileSync(second, 'utf8'), 'the owner notes');
  assert.equal(readFileSync(third, 'utf8'), 'more notes');
  const [wake] = await resumes(work);
  assert.ok(
    wake.note
      ?.split('\n')[0]
      .endsWith(
        `Sam attached 2 files to that message, now in this work: notes.md at ${second}; notes (2).md at ${third}.`
      ),
    wake.note ?? ''
  );
});

test("a file the office could not copy is named in the lead's note as not come, and the words still go", async () => {
  const work = await onThread('cole', 'rex', 'Presets on a full disk');
  // A file where the work's folder goes, so the copy fails on the disk itself.
  mkdirSync(join(threadFolder(work), '..'), { recursive: true });
  writeFileSync(threadFolder(work), 'not a folder');
  after(() => rmSync(threadFolder(work), { force: true }));
  const r = await tellLead({
    staffId: 'rex',
    threadId: work,
    said,
    words: 'make the colours warmer.',
    reading,
    files: { carry: [attached('swatch.png', 'png')], unfit: [] }
  });
  assert.deepEqual(r, {
    lead: 'Cole',
    files: [{ named: 'swatch.png', why: 'the office could not copy it' }]
  });
  const [wake] = await resumes(work);
  assert.ok(
    wake.note?.endsWith(
      `One file Sam attached did not come: swatch.png, since the office could not copy it.`
    ),
    wake.note ?? ''
  );
});

test("a removal landing while tell_lead passes the owner's words waits for it, so 'Passed to' always means the lead's pick-up holds the words", async (t) => {
  await db.insert(staff).values([odd('ivy', 'Ivy'), odd('kit', 'Kit')]);
  const work = await onThread('ivy', 'kit', 'Work its lead leaves');
  const sharing = await import('../src/sharing.ts');
  const { removeOdd } = await import('../src/leaving.ts');
  let removal: Promise<unknown> | undefined;
  t.mock.module(new URL('../src/sharing.ts', import.meta.url).href, {
    namedExports: {
      ...sharing,
      // tell_lead reads the tools under its locks, before its checks and the note. The
      // removal starts here and gets a quarter second to land: where the
      // checks and the note are separate steps it lands in that time, and the
      // lead it removed never gets the note; here it waits for the note's
      // transaction, so the time runs out and the note goes first.
      heldTools: async (...a: Parameters<typeof sharing.heldTools>) => {
        removal = removeOdd('ivy');
        await Promise.race([removal, new Promise((done) => setTimeout(done, 250))]);
        return sharing.heldTools(...a);
      }
    }
  });
  // A copy that imports the sharing above, so its tellLead calls it.
  // The query loads a fresh copy of the module, whose type is the module's own.
  const fresh = '../src/threads.ts?removal';
  const { tellLead: telling } = (await import(fresh)) as typeof import('../src/threads.ts');
  const r = await telling({
    staffId: 'kit',
    threadId: work,
    said,
    words: 'make the colours warmer.',
    reading,
    exchange: 'Sam: make the colours warmer.\nKit: I will pass it on.'
  });
  assert.ok(removal, 'the tools were never read');
  assert.equal(await removal, undefined, 'the removal was refused');
  assert.ok('lead' in r, JSON.stringify(r));
  const notes = (await resumes(work)).filter((f) => f.staffId === 'ivy').map((f) => f.note ?? '');
  assert.ok(
    notes.some((n) => n.includes("Sam's words: make the colours warmer.")),
    `tellLead returned ${JSON.stringify(r)}, and the lead's pick-ups hold ${JSON.stringify(notes)}`
  );
});

test("tell_lead on work its lead's leaving stopped says the work stopped, never that the owner stopped it", async () => {
  await db.insert(staff).values([odd('uma', 'Uma'), odd('vic', 'Vic')]);
  const work = await onThread('uma', 'vic', 'Work whose lead leaves');
  const { removeOdd } = await import('../src/leaving.ts');
  await removeOdd('uma');
  assert.equal((await db.select().from(threads).where(eq(threads.id, work)))[0]?.status, 'stopped');
  const r = await tell('vic', work);
  assert.deepEqual(r, {
    problem: `Work ${work} has stopped, so nothing more runs on it. Tell Sam so.`
  });
  assert.doesNotMatch(r.problem, /stopped it|stopped work/);
});

test('a hub naming its own stopped work for an ask hears the work stopped, never that the owner stopped it', async () => {
  const work = await onThread('cole', 'bram', 'Stopped work a hub names');
  await db
    .update(threads)
    .set({ status: 'stopped', endedAt: new Date() })
    .where(eq(threads.id, work));
  const problem = await notLed({ hubId: 'cole', threadId: work });
  assert.equal(
    problem,
    `Work ${work} has stopped, so nothing more goes on it. Name another, or null.`
  );
  assert.doesNotMatch(problem ?? '', /stopped it|stopped work/);
});
