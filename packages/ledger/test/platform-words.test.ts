// No tool an Odd is given calls the owner's computer a Mac unless it is one.
// The tool server runs in a process of its own (tool-server.ts), started as
// if on each system by as-platform.ts. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db, toolServer } from './tool-server.ts';

const { staff } = await import('../src/schema.ts');
const { OFFICE_TOOLS } = await import('../src/tools.ts');

// Wren holds every office tool, so every description is read.
await db.insert(staff).values({
  id: 'wren',
  name: 'Wren',
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  desk: 'You are Wren.',
  tools: OFFICE_TOOLS.map((t) => t.id)
});

// A file: URL, since `--import` in NODE_OPTIONS takes a URL or a specifier,
// and a Windows drive path is neither.
const AS_PLATFORM = new URL('./as-platform.ts', import.meta.url).href;

/** Every tool's description and each of its arguments', as the server on `platform` lists them. */
async function described(platform: 'darwin' | 'linux' | 'win32'): Promise<Map<string, string>> {
  const c = await toolServer('wren', {
    RUN_KEY: `k-${platform}`,
    NODE_OPTIONS: `--import ${AS_PLATFORM}`,
    ODDBORO_TEST_PLATFORM: platform,
    // The database this file started, at the address this process reaches it
    // by. As if on Windows, the server would look for it on a port, and here
    // it listens on a socket.
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    ODDBORO_LOCAL_DB: ''
  });
  const said = new Map<string, string>();
  for (const t of (await c.listTools()).tools) {
    said.set(t.name, t.description ?? '');
    const args = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    for (const [arg, schema] of Object.entries(args))
      said.set(`${t.name}.${arg}`, schema.description ?? '');
  }
  return said;
}

for (const platform of ['linux', 'win32'] as const)
  test(`on ${platform}, no tool or argument description calls the computer a Mac`, async () => {
    const said = await described(platform);
    assert.match(said.get('poke_owner') ?? '', /a notification on their computer\./);
    const mac = [...said].filter(([, text]) => /\bMac\b/.test(text)).map(([name]) => name);
    assert.deepEqual(mac, [], `on ${platform}`);
  });

test('on a Mac, the poke tool says the notification comes on their Mac', async () => {
  const said = await described('darwin');
  assert.match(said.get('poke_owner') ?? '', /a notification on their Mac\./);
});
