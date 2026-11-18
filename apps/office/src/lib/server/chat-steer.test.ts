// The same requests as two office windows, with real staff runs in a throwaway office.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { L, bus, chat, folder, history, followThrough, type Gave } from './office-under-test.ts';

const { GET, POST, PATCH, DELETE } = await import('../../routes/api/staff/[id]/chat/+server.ts');
const { runJob, inProgress } = await import('./staff.ts');
const { addToReply, aboutBrief } = await import('./chat-run.ts');

function request(id: string, body: object, method = 'POST') {
  return {
    params: { id },
    request: new Request('http://office/chat', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  } as Parameters<typeof POST>[0];
}
const state = async (id: string) =>
  (await GET({ params: { id } } as Parameters<typeof GET>[0])).json();
const stop = async (id: string, runId: string) =>
  (await DELETE(request(id, { runId }, 'DELETE'))).json();
const add = async (id: string, runId: string, message: string) =>
  (await PATCH(request(id, { runId, message }, 'PATCH'))).json();
const send = (id: string, body: object) => POST(request(id, body));
const last = async (r: Response) =>
  JSON.parse((await r.text()).trim().split('\n\n').at(-1)!.slice(6));
const gaveOf = (text: string): Gave => JSON.parse(text.split('\nOutcome:')[0]);

test(
  'Send now adds words to the running Claude Code reply in the same turn, and the run ends after its result',
  { timeout: 60_000 },
  async (t) => {
    const id = 'cleo';
    const turnId = randomUUID();
    const ready = join(folder, 'add-ready');
    const jobReady = join(folder, 'job-ready');
    const job = await L.addJob({
      staffId: id,
      name: 'Count the seats',
      instructions: `Hold until ${jobReady} exists.`,
      schedule: { every: 'day', at: '09:00' }
    });
    const running = runJob(job, 'manual');
    try {
      const stream = await send(id, { turnId, message: `Hold until ${ready} exists.` });
      await t.waitFor(() => assert.equal(L.runsGoing.size, 2), { timeout: 20_000 });
      const { reply } = await state(id);
      assert.equal(reply.turnId, turnId);
      // Its tool is running, with stdin open, once the run can take words.
      await t.waitFor(() => assert.ok(L.runsGoing.get(reply.runId)?.add), { timeout: 20_000 });
      let ends = 0;
      const count = () => ends++;
      bus.on('run-ended', count);
      t.after(() => {
        bus.off('run-ended', count);
      });
      // An old window naming another run adds nothing.
      assert.deepEqual(await add(id, randomUUID(), 'Not this.'), { added: false });
      assert.deepEqual(await add(id, reply.runId, 'Count the blue seats too.'), { added: true });
      const kept = history(id).filter((e) => e.turnId === turnId && e.from === 'owner');
      assert.deepEqual(
        kept.map((e) => [e.text, e.source?.kind]),
        [
          [`Hold until ${ready} exists.`, 'chat'],
          ['Count the blue seats too.', 'added']
        ]
      );
      writeFileSync(ready, '');
      const answer = await last(stream);
      assert.equal(answer.type, 'done', answer.message);
      const gave = gaveOf(answer.text);
      // A Claude Code chat reads stream-json, even with no picture, and got both in its one turn.
      assert.equal(gave.args[gave.args.indexOf('--input-format') + 1], 'stream-json');
      assert.equal(gave.message.trimEnd().split('\n').at(-1), `Hold until ${ready} exists.`);
      assert.deepEqual(gave.added, ['Count the blue seats too.']);
      assert.equal(history(id).filter((e) => e.turnId === turnId && e.from === 'staff').length, 1);
      // Too late: the reply ended, so the page sends the words as the next message.
      assert.deepEqual(await add(id, reply.runId, 'And the red ones.'), { added: false });
      assert.equal(history(id).filter((e) => e.turnId === turnId).length, 3);
      // The background job runs on, untouched.
      assert.equal(inProgress()[id]?.[0].about?.id, job.id);
      assert.equal(L.runsGoing.size, 1);
      assert.equal(ends, 1);
    } finally {
      writeFileSync(ready, '');
      writeFileSync(jobReady, '');
      assert.equal((await running).ok, true);
    }
  }
);

test('words added after the result of a Claude Code chat still end with Claude Code, and other tools never take them', async () => {
  /** A chat on `id` that tries to add words as its tool reports its first step, just before its result. */
  async function addAtStep(id: string) {
    let runId = '';
    let added: boolean | undefined;
    let text = '';
    await chat(id, 'Hello.', (e) => {
      if (e.type === 'reply') runId = e.runId;
      if (e.type === 'tool' && added === undefined) added = addToReply(id, runId, 'Also this.');
      if (e.type === 'done') text = e.text;
      if (e.type === 'error') text = e.message;
    });
    return { added, text };
  }
  // The stand-in had answered before the words came; the run still ends once it does.
  const claude = await addAtStep('sam');
  assert.equal(claude.added, true);
  assert.equal(gaveOf(claude.text).message.trimEnd().split('\n').at(-1), 'Hello.');
  // Grok reads its message once, from its prompt file, so its chat takes nothing more.
  const grok = await addAtStep('gus');
  assert.equal(grok.added, false, grok.text);
  assert.equal(
    history('gus').some((e) => e.text === 'Also this.'),
    false
  );
  assert.equal(L.runsGoing.size, 0);
});

test(
  'disconnect leaves a reply running, and Stop stands alone and says so plainly',
  { timeout: 60_000 },
  async (t) => {
    const id = 'paige';
    const first = randomUUID();
    const ready = join(folder, 'window-closed');
    const res = await send(id, { turnId: first, message: `Hold until ${ready} exists.` });
    const before = (await state(id)).reply;
    await res.body!.cancel();
    assert.equal((await state(id)).reply.runId, before.runId);
    writeFileSync(ready, '');
    await t.waitFor(
      () => assert.ok(history(id).some((e) => e.turnId === first && e.from === 'staff')),
      { timeout: 20_000 }
    );
    assert.equal(
      history(id).some((e) => e.interrupted),
      false
    );
    rmSync(ready);
    t.after(() => writeFileSync(ready, ''));
    const third = await send(id, { message: `Hold until ${ready} exists.` });
    const active = (await state(id)).reply;
    assert.deepEqual(await stop(id, before.runId), { stopped: false });
    assert.deepEqual(await stop(id, active.runId), { stopped: true });
    const stopped = (await last(third)).text;
    assert.equal(stopped, 'You stopped this reply. Completed work and saved files remain.');
    // The owner's message ended with a period; the line never doubles one.
    assert.doesNotMatch(stopped, /[.!?…]["”’']?[.!?]/);
  }
);

test(
  'a message about a colleague’s goal goes to its lead and never stops the other work',
  { timeout: 60_000 },
  async (t) => {
    const [goal] = await L.pg<
      { id: number }[]
    >`insert into goals (title) values ('Plan the fair') returning id`;
    const ready = join(folder, 'hand-off-ready');
    const h = await L.handOff({
      from: 'lead',
      to: 'paige',
      work: { title: `Hold until ${ready} exists.`, brief: 'Count the seats.' },
      thread: { title: 'Fair seating', goalId: goal.id }
    });
    assert.ok('id' in h);
    const f = await L.startFollowUp(h.id);
    assert.ok(f);
    const run = followThrough(f);
    try {
      await t.waitFor(() => assert.ok(inProgress().paige?.[0].about), { timeout: 20_000 });
      const about = inProgress().paige[0].about!;
      assert.equal(about.leadId, 'lead');
      assert.equal(about.title, 'Plan the fair');
      const message = {
        turnId: randomUUID(),
        about: about.key,
        message: 'Leave room for the band.'
      };
      await assert.rejects(async () => send('paige', message), { status: 400 });
      const answer = await send('lead', message);
      const result = await last(answer);
      assert.equal(result.type, 'done', result.message);
      assert.ok(gaveOf(result.text).message.includes(`goal #${goal.id}, "Plan the fair"`));
      assert.deepEqual(history('lead').find((e) => e.turnId === message.turnId)?.about, about);
      assert.equal(inProgress().paige[0].about?.key, about.key);
    } finally {
      writeFileSync(ready, '');
      await run;
    }
  }
);

test('a message about work tells the lead which work it changes, and nothing else', (t) => {
  const line = {
    from: 'owner' as const,
    at: '2026-01-01T00:00:00.000Z',
    text: 'Leave room for the band.',
    turnId: 'earlier'
  };
  t.assert.snapshot(
    aboutBrief({
      ...line,
      about: {
        key: 'goal-work',
        kind: 'goal',
        id: 7,
        title: 'Plan the fair',
        leadId: 'lead',
        lead: 'Lena'
      }
    })
  );
  assert.deepEqual(aboutBrief(line), []);
});

test('a chat reply tells every page who is replying as it starts, and again as it ends', async (t) => {
  const id = 'cleo';
  const ready = join(folder, 'reply-ready');
  const told: string[][] = [];
  const hear = (e: { type: string; chatting?: string[] }) => {
    if (e.type === 'working') told.push(e.chatting ?? []);
  };
  bus.on('event', hear);
  t.after(() => {
    bus.off('event', hear);
    rmSync(ready, { force: true });
  });
  const stream = await send(id, { turnId: randomUUID(), message: `Hold until ${ready} exists.` });
  await t.waitFor(() => assert.ok(told.some((c) => c.includes(id))), { timeout: 20_000 });
  writeFileSync(ready, '');
  assert.equal((await last(stream)).type, 'done');
  assert.deepEqual(told.at(-1), []);
});
