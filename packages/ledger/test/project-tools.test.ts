// Native assignments use the same run ceiling and tool declaration as the rest of the office.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db, toolServer } from './tool-server.ts';

const { staff } = await import('../src/schema.ts');
const { connectProject, shareProject, projectWork, setAdvancedMode, letSendUnasked } =
  await import('../src/project-sessions.ts');
const { setOwnerName } = await import('../src/office.ts');
await setOwnerName('Tester');
await db.insert(staff).values({
  id: 'editor',
  name: 'Editor',
  role: 'Editor',
  remit: 'Review projects.',
  variant: 'a',
  portrait: 'a',
  permission: 'act',
  desk: 'Review the project.'
});

const offers = async (client: Awaited<ReturnType<typeof toolServer>>) =>
  (await client.listTools()).tools.some((t) => t.name === 'send_project_work');

test('project tools exist only while advanced mode is on', async () => {
  const s = await connectProject('claude', randomUUID(), '/fixture/off', 'Off');
  await shareProject(s.id, 'editor');
  assert.ok(!(await offers(await toolServer('editor', {}))));
  assert.ok(!(await offers(await toolServer('editor', { CEILING: 'act' }))));
  await shareProject(s.id, null);
});

test(
  'only a shared project offers its tools, and a Draft run keeps one proposal',
  // Four tool servers, one for each run it checks: four starts in a row hit
  // the package's 15 s limit on a loaded machine, so each gets that limit.
  { timeout: 60_000 },
  async () => {
    await setAdvancedMode(true);
    const before = await toolServer('editor', {});
    assert.ok(!(await offers(before)));
    const s = await connectProject('codex', randomUUID(), '/fixture/project', 'A project');
    await shareProject(s.id, 'editor');
    const client = await toolServer('editor', { CEILING: 'draft' });
    const call = (key: string) =>
      client.callTool({
        name: 'send_project_work',
        arguments: { session: s.id, key, prompt: 'Review the draft.' }
      });
    const key = randomUUID();
    assert.ok(!(await call(key)).isError);
    assert.ok(!(await call(key)).isError);
    const work = await projectWork(s.id);
    assert.equal(work.length, 1);
    assert.equal(work[0].state, 'proposed');
    const read = await toolServer('editor', { CEILING: 'read' });
    assert.equal(
      (
        await read.callTool({
          name: 'send_project_work',
          arguments: { session: s.id, key: randomUUID(), prompt: 'Review.' }
        })
      ).isError,
      true
    );
    const lesson = await toolServer('editor', { LESSON_RUN: '1' });
    assert.ok(!(await offers(lesson)));
    await shareProject(s.id, null);
    assert.equal((await call(randomUUID())).isError, true);
    assert.equal((await projectWork(s.id)).length, 1);
  }
);

test('a run at Act waits for the owner until the session lets that Odd send without asking', async () => {
  const s = await connectProject('codex', randomUUID(), '/fixture/act', 'Act');
  await shareProject(s.id, 'editor');
  const client = await toolServer('editor', { CEILING: 'act' });
  const send = async () => {
    const r = await client.callTool({
      name: 'send_project_work',
      arguments: { session: s.id, key: randomUUID(), prompt: 'Run the tests.' }
    });
    const [part] = r.content as { text: string }[];
    return (JSON.parse(part.text) as { state: string }).state;
  };
  assert.equal(await send(), 'proposed');
  await letSendUnasked(s.id, 'editor');
  assert.equal(await send(), 'queued');
});
