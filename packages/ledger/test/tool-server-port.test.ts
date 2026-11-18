// The test database's port (tool-server.ts, NEW-1907): with something already
// listening where this process would put its database, the helper picks the
// next free port, below the systems' ranges for outgoing connections, and the
// database answers. Only Windows puts the database on that port; on a Mac and
// Linux it listens on a socket, so there this checks the port picked. Run
// with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';

const taken = 20_000 + (process.pid % 12_000);
const holder = createServer();
await new Promise<void>((done) => holder.listen(taken, '127.0.0.1', done));
const { sql } = await import('./tool-server.ts');
holder.close();

test('a test database whose port is taken starts on the next free one', async () => {
  const port = Number(process.env.ODDBORO_DB_PORT);
  assert.notEqual(port, taken);
  assert.ok(port >= 20_000 && port < 32_000, `port ${port}`);
  assert.equal((await sql`select 1 as one`)[0].one, 1);
});
