// The address Setup's first card shows (`shownAddress`): the office's own
// port, as the server sends it, whenever the office keeps its port.
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shownAddress, type Address } from './address.ts';

// Not the default 4500, so a port written into the card would show.
const at = { host: 'local.oddboro.com', port: 4651 };

test("while the office keeps its port, the card shows the office's own port, not the default one", () => {
  const kept: Address[] = [
    { ...at, state: 'unchecked' },
    { ...at, state: 'blocked', holder: 'nginx' }
  ];
  for (const a of kept) assert.equal(shownAddress(a), 'local.oddboro.com:4651', a.state);
});

test('once Caddy answers at the address, or is about to, the card shows the bare name', () => {
  const bare: Address[] = [
    { ...at, state: 'ready', url: 'https://local.oddboro.com', secure: true, canSecure: false },
    { ...at, state: 'own', installed: false },
    { ...at, state: 'shared' }
  ];
  for (const a of bare) assert.equal(shownAddress(a), 'local.oddboro.com', a.state);
});
