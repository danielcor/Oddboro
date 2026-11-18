// The work modules that decide what changes are pure: they never load db.ts,
// directly or through anything they import. A test that drives them alone
// would not fail if one did, since db.ts connects only on its first query, so
// this test loads each and checks the pool db.ts makes as it loads is not
// there. It imports nothing else from src, and node --test runs each test
// file in a process of its own, so nothing here loads db.ts first.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const SRC = new URL('../src/', import.meta.url);
const WORK = new URL('work/', SRC);
/** The work modules that read and write the database: every other one in work/ is pure. */
const NOT_PURE = ['load.ts', 'apply.ts'];
/** Pure modules outside work/, checked once they exist. */
const PURE_ELSEWHERE = ['sequences.ts', 'lesson-rules.ts'];

function pureModules(): URL[] {
  const inWork = existsSync(WORK)
    ? readdirSync(WORK)
        .filter((f) => f.endsWith('.ts') && !NOT_PURE.includes(f))
        .map((f) => new URL(f, WORK))
    : [];
  const elsewhere = PURE_ELSEWHERE.map((f) => new URL(f, SRC)).filter((u) => existsSync(u));
  return [...inWork, ...elsewhere];
}

test('no pure module loads db.ts', async () => {
  const modules = pureModules();
  assert.ok(modules.length > 0, 'found no pure module to check');
  for (const m of modules) {
    await import(m.href);
    // db.ts keeps its one pool on globalThis as it loads, and nothing else sets it.
    assert.equal(
      Reflect.get(globalThis, 'oddboroSql'),
      undefined,
      `${m.pathname.slice(SRC.pathname.length)} loads db.ts`
    );
  }
});
