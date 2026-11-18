// The same tool descriptions and queries a new hire uses before giving the
// owner a task, with keyword search while the embedding service is offline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db, toolServer } from './tool-server.ts';

const { staff } = await import('../src/schema.ts');
const { STARTER_TOOLS } = await import('../src/tools.ts');
const { record } = await import('../src/office.ts');
await db.insert(staff).values({
  id: 'iris',
  name: 'Iris',
  role: 'Visual Designer',
  remit: 'Makes the newsletter graphics.',
  variant: 'a',
  portrait: 'a',
  desk: 'You are Iris.',
  tools: STARTER_TOOLS
});

test('a search with no matches tells the hire how to find existing answers, and an owner task asks why no colleague can do it', async () => {
  await record({
    kind: 'decision',
    actor: 'owner',
    title: 'Newsletter visual guidelines',
    body: 'Use a 1600 by 900 image with a cream background.'
  });
  const client = await toolServer('iris', { RUN_KEY: 'first-day' });
  const tools = (await client.listTools()).tools;
  const search = tools.find((tool) => tool.name === 'search_ledger');
  assert.match(search?.description ?? '', /No matches does not mean the office has no record/);
  assert.match(search?.description ?? '', /fewer words, or an empty query/);
  const text = async (query: string) => {
    const result = await client.callTool({ name: 'search_ledger', arguments: { query } });
    return JSON.stringify(result.content);
  };
  assert.match(await text('newsletter confirmed issue theme pixel size colour'), /Nothing found/);
  assert.match(await text('newsletter'), /1600 by 900/);
  assert.match(await text(''), /1600 by 900/);
  const task = tools.find((tool) => tool.name === 'give_owner_a_task');
  assert.match(JSON.stringify(task?.inputSchema.properties?.why), /colleague you considered/);
  const result = await client.callTool({
    name: 'give_owner_a_task',
    arguments: {
      title: 'Choose your preferred cover direction',
      why: 'The designer can prepare both options, but only you can choose your personal preference.',
      choices: ['Shopfront', 'Checklist']
    }
  });
  assert.notEqual(result.isError, true);
});

test("a colleague's run on a hand-off, which cannot hand on, is never told a task's work goes through hand_off", async () => {
  const client = await toolServer('iris', { RUN_KEY: 'hand-off', HAND_OFF_ID: '1' });
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some((tool) => tool.name === 'hand_off'));
  const why = JSON.stringify(
    tools.find((tool) => tool.name === 'give_owner_a_task')?.inputSchema.properties?.why
  );
  assert.doesNotMatch(why, /hand_off/);
  assert.match(why, /explain the access limit/);
});
