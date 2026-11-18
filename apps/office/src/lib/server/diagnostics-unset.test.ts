// A build with no address for reports: the SDK never starts, the page never
// asks the owner, and the relay drops what the page sends. The office's own
// database runs in a temp folder, since the page's `load`
// queries it. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PAGE, recorder, sender, tempOffice, type Route } from './diagnostics-harness.ts';

const door = await recorder();
const { folder } = tempOffice('diagnostics-unset');
const port = await new Promise<number>((done) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => done(p));
  });
});
Object.assign(process.env, {
  // A settings file that does not exist, so no address comes from there.
  ODDBORO_ENV: join(folder, 'none.env'),
  ODDBORO_DB_PORT: String(port),
  // Even a yes sends nothing when there is nowhere to send it.
  OFFICE_DIAGNOSTICS: 'yes'
});
delete process.env.OFFICE_ADDRESS;

await import('../../instrumentation.server.ts');
const { startLocalDatabase } = await import('@oddboro/ledger/local-db');
const stopDatabase = await startLocalDatabase();
const { bringUpToDate } = await import('@oddboro/ledger/upgrade');
await bringUpToDate();
const { pg } = await import('@oddboro/ledger');
const hooks = await import('../../hooks.server.ts');
const page = await import('../../routes/+page.server.ts');
const relayRoute = await import('../../routes/api/diagnostics/envelope/+server.ts');

after(async () => {
  door.close();
  await pg.end();
  await stopDatabase();
  rmSync(folder, { recursive: true, force: true });
});

test('a build with no address sends nothing and never asks the owner', async () => {
  // `load` ignores its event; the cast stands in for the one Kit would build.
  const data = (await page.load({} as never)) as { diagnostics?: { possible: boolean } };
  assert.equal(data.diagnostics?.possible, false);

  const header = JSON.stringify({ dsn: `http://page@127.0.0.1:${door.port}/oddboro/0` });
  const event = JSON.stringify({ message: 'T9 page report', platform: 'javascript' });
  const relayed = await sender(hooks.handle)({
    route: '/api/diagnostics/envelope',
    method: 'POST',
    headers: { ...PAGE, 'content-type': 'application/x-sentry-envelope' },
    body: `${header}\n${JSON.stringify({ type: 'event' })}\n${event}\n`,
    // Typed for its own route's event, which is the one the harness builds.
    resolve: relayRoute.POST as Route
  });
  assert.equal(relayed.status, 200);
  assert.equal(door.got.length, 0);
});
