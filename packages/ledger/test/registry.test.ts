import assert from 'node:assert/strict';
import { test } from 'node:test';
import './tool-server.ts';

const { addConnector } = await import('../src/office.ts');
const { connectorId, ensureConnector, searchRegistry } = await import('../src/registry.ts');

test('a saved registry connection can be chosen again while the registry is offline', async (t) => {
  const registry = 'app.linear/linear';
  const saved = await addConnector({
    id: connectorId(registry),
    registry,
    name: 'Linear',
    description: 'Issues in this workspace',
    kind: 'http',
    config: { url: 'https://mcp.linear.app/mcp', oauth: true },
    readyAt: new Date()
  });
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw Error('Registry is offline');
  });
  assert.deepEqual((await ensureConnector(registry)).connector, saved);
  assert.equal(fetch.mock.callCount(), 0);
});

test('a work request can find the service when the registry has no exact phrase match', async (t) => {
  const searches: string[] = [];
  t.mock.method(globalThis, 'fetch', async (address: string) => {
    const search = new URL(address).searchParams.get('search')!;
    searches.push(search);
    const servers = search === 'com.notion/mcp' ? [{ server: { name: search } }] : [];
    return Response.json({ servers });
  });
  assert.equal((await searchRegistry('Notion pages'))[0]?.registry, 'com.notion/mcp');
  assert.deepEqual(searches, ['Notion pages', 'com.notion/mcp']);
});
