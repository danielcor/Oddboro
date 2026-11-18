// What the page gets of an Odd (`toProfile`), in an office under test
// (office-under-test.ts), whose ledger takes the line a held network records.
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StaffRow } from '@oddboro/ledger';
import { setZone } from '@oddboro/ledger/time';
import { onThisDisk, STORE_STATES } from '../../../../../packages/ledger/test/store-states.ts';
import { folder, onPlatform, ownerHome } from './office-under-test.ts';

// After the office under test set its home, as the office's own imports are.
const { toProfile } = await import('./profile.ts');
const { holdNetwork, resetHeldNetwork } = await import('@oddboro/ledger');

/** A staff row as the ledger returns it; anything not named is off or empty. */
const row = (o: Partial<StaffRow> = {}): StaffRow => ({
  id: 'penny',
  name: 'Penny',
  role: 'Writer',
  office: 'Main Street',
  sprite: 'staff',
  variant: 'a',
  portrait: 'a',
  room: 'workspace',
  permission: 'draft',
  actsOnHandOffs: false,
  agent: 'claude',
  account: null,
  model: null,
  effort: null,
  tools: [],
  commands: false,
  web: false,
  folders: [],
  remit: 'Writes the newsletter.',
  desk: 'You are Penny.',
  look: null,
  portraitPx: null,
  package: null,
  hiredAt: new Date('2026-11-04T01:30:00Z'),
  leftAt: null,
  jobsOff: null,
  ...o
});

test("an Odd hired on an evening in New York shows that day as its hire date, not tomorrow's UTC date", () => {
  setZone('America/New_York');
  // 8:30 PM in New York on Nov 3 is 01:30 UTC on Nov 4.
  assert.equal(toProfile(row()).hired, '2026-11-03');
});

test("the page's profile carries what runs reach, each folder's ~ form, the offer and the web line", async () => {
  await onPlatform('darwin', async () => {
    const grok = toProfile(row({ agent: 'grok', commands: true, web: true }));
    assert.equal(grok.commands, true, 'the stored switch stays as the owner set it');
    assert.equal(grok.reach.commands, false);
    const how = grok.reach.commandsHow;
    assert.equal(how.state === 'never' && how.offer, 'claude');
    assert.equal(grok.webLine, 'Search and read web pages.');

    const both = row({ commands: true, web: true });
    const claude = toProfile(both);
    assert.deepEqual(
      { commands: claude.reach.commands, network: claude.reach.network, held: claude.reach.held },
      { commands: true, network: true, held: false }
    );
    assert.equal(
      claude.webLine,
      'Search and read web pages. With Run commands on, its commands can reach the internet too.'
    );
    const codex = row({ agent: 'codex', web: true });
    assert.equal(
      toProfile(codex).webLine,
      "Search the web. Codex's commands stay off the internet."
    );

    await ownerHome(async (home) => {
      const garden = join(home, 'garden');
      mkdirSync(garden);
      const gone = join(home, 'gone');
      const p = toProfile(
        row({
          folders: [
            { path: garden, write: true },
            { path: gone, write: false }
          ]
        })
      );
      // As stored, so the owner can still take back the one gone from the disk.
      assert.deepEqual(p.folders, [
        { path: garden, write: true, shown: '~/garden', touchesStore: false },
        { path: gone, write: false, shown: '~/gone', touchesStore: false }
      ]);
      assert.deepEqual(p.reach.granted, [{ path: garden, write: true }]);
    });

    // Held: this office met a Claude Code that refused the open network.
    await holdNetwork();
    try {
      const held = toProfile(both);
      assert.deepEqual(
        { network: held.reach.network, held: held.reach.held },
        { network: false, held: true }
      );
      assert.equal(
        held.webLine,
        'Search and read web pages. This version of Claude Code keeps its commands off the internet.'
      );
      // The refusal is Claude Code's, so a Codex Odd is not held, and keeps its own line.
      const codexHeld = toProfile(codex);
      assert.deepEqual(
        { network: codexHeld.reach.network, held: codexHeld.reach.held },
        { network: false, held: false }
      );
      assert.equal(codexHeld.webLine, "Search the web. Codex's commands stay off the internet.");
    } finally {
      resetHeldNetwork();
    }
  });
});

/**
 * Each state's stored folder, and whether the card's line shows on it. The
 * line goes with `ownTools` dropping a folder for touching a secret store, so
 * a folder that shows it never reaches a run, and one without it reaches every
 * run while it is still on the disk.
 */
function assertLineFollowsWhatRunsGet(states: [string, string, boolean][]): void {
  const p = toProfile(row({ folders: states.map(([, path]) => ({ path, write: false })) }));
  assert.equal(p.folders.length, states.length);
  states.forEach(([state, path, line], i) => {
    assert.equal(p.folders[i].touchesStore, line, `${state}: the line`);
    assert.equal(
      p.reach.granted.some((f) => f.path === path),
      !line && existsSync(path),
      `${state}: what runs get`
    );
  });
}

test("the card's line on a folder shows exactly when runs lose it to a secret store, in the home", async () => {
  await ownerHome(async (madeHome) => {
    // By real path, as a folder is stored: one gone from the disk has no link left to follow.
    const home = realpathSync(madeHome);
    mkdirSync(join(home, '.ssh', 'keys'), { recursive: true });
    mkdirSync(join(home, 'garden'));
    assertLineFollowsWhatRunsGet([
      ['a real store', join(home, '.ssh'), true],
      ['in a store', join(home, '.ssh', 'keys'), true],
      ['holding a store', home, true],
      ['an ordinary folder', join(home, 'garden'), false],
      ['gone from the disk, which reaches no run for another reason', join(home, 'gone'), false],
      ['gone from the disk, its stored path still in a store', join(home, '.ssh', 'old'), true]
    ]);
  });
});

test(
  "the card's line on a folder outside the home goes by what the store holds, so a project's .docker gets none",
  { skip: process.platform === 'win32' && "Windows' temp folder sits in the home's AppData" },
  async () => {
    await ownerHome(async () => {
      const outside = realpathSync(folder);
      const project = join(outside, 'a-project');
      mkdirSync(join(project, '.docker'), { recursive: true });
      writeFileSync(join(project, '.docker', 'Dockerfile'), '');
      const holder = join(outside, 'holds-sign-ins');
      mkdirSync(join(holder, '.docker'), { recursive: true });
      writeFileSync(join(holder, '.docker', 'config.json'), '{}');
      assertLineFollowsWhatRunsGet([
        ['a project with a .docker and no mark', project, false],
        ['its .docker', join(project, '.docker'), false],
        ['a folder holding a marked .docker', holder, true],
        ['that marked .docker', join(holder, '.docker'), true]
      ]);
    });
  }
);

const STATES = STORE_STATES.filter(onThisDisk);

test("runs get exactly the stored folders no store state refuses, and the card's line marks the rest, in the home", async () => {
  // The rows by name get a home of their own: the link rows put a key in the
  // home's .ssh, and those rows are about a store with no mark in it.
  for (const rows of [STATES.filter((s) => !s.homeOnly), STATES.filter((s) => s.homeOnly)])
    await ownerHome(async (madeHome) => {
      const home = realpathSync(madeHome);
      assertLineFollowsWhatRunsGet(rows.map((s) => [s.state, s.make(home, home), s.refused]));
    });
});

test(
  "runs get exactly the stored folders no store state refuses, and the card's line marks the rest, outside the home",
  { skip: process.platform === 'win32' && "Windows' temp folder sits in the home's AppData" },
  async () => {
    await ownerHome(async (madeHome) => {
      const home = realpathSync(madeHome);
      const outside = mkdtempSync(join(realpathSync(folder), 'store-states-'));
      assertLineFollowsWhatRunsGet(
        STATES.filter((s) => !s.homeOnly).map((s) => [s.state, s.make(outside, home), s.refused])
      );
    });
  }
);

test("a Gemini Odd's profile carries the office's Gemini model variable, never Grok's", async () => {
  const { withEnv } = await import('./office-under-test.ts');
  const { OFFICE_MODEL_VAR } = await import('@oddboro/ledger');
  const model = await withEnv(
    { [OFFICE_MODEL_VAR.gemini]: 'gemini-made-up', [OFFICE_MODEL_VAR.grok]: 'grok-made-up' },
    async () => (await toProfile(row({ agent: 'gemini' }))).officeModel
  );
  assert.equal(model, 'gemini-made-up');
});
