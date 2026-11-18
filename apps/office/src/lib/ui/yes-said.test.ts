// The words on an ask's yes button on the Desk, for every kind of ask.
// Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskKind, AskRow } from '@oddboro/ledger';
import { yesSaid, type DeskNow } from './yes-said.ts';

// Only the fields the words read are filled in, so each row is cast to its shape.
const idle: DeskNow = { picked: 0, busy: false };
const plan = { items: [{}, {}, {}] };
/**
 * Each kind's asks as the Desk holds them, with what the Desk knows, and the
 * words the button reads. Keyed by AskKind, so a new kind fails the type check
 * here until its words are written down.
 */
const SAID: Record<AskKind, [Partial<AskRow>, DeskNow, string][]> = {
  approval: [[{}, idle, 'Approve']],
  access: [
    [{ access: {} as AskRow['access'] }, idle, 'Connect'],
    [{}, idle, 'Approve']
  ],
  hire: [[{}, idle, 'Approve']],
  goal: [[{}, idle, 'Set the goal']],
  plan: [
    [{ plan: plan as AskRow['plan'] }, { picked: 2, busy: false }, 'Approve 2 of 3'],
    [{ plan: plan as AskRow['plan'] }, { picked: 3, busy: false }, 'Approve']
  ],
  hand_offs: [[{}, idle, 'Approve']],
  window: [[{}, idle, 'Let it carry on']],
  reply: [[{}, idle, 'Approve']],
  filter: [[{}, idle, 'Approve']],
  folder: [[{}, idle, 'Approve']],
  switch: [[{}, idle, 'Turn on']],
  // A Draft Odd raised to Act, and a Read Odd raised to Draft.
  level: [
    [{ level: 'act' }, idle, 'Raise to Act'],
    [{ level: 'draft' }, idle, 'Raise to Draft'],
    [{}, idle, 'Approve']
  ],
  office_tool: [[{ officeTools: ['office_report'] }, idle, 'Turn on']],
  call: [
    [{}, idle, 'Make this call'],
    [{}, { picked: 0, busy: true }, 'Making the call']
  ],
  remove: [[{}, idle, 'Remove']],
  bring_back: [[{}, idle, 'Bring back']],
  catch_up: [[{}, idle, 'Approve']],
  standing: [[{}, idle, 'Allow']]
};

test("an ask's yes button reads its kind's own words, for every kind of ask", () => {
  for (const [kind, rows] of Object.entries(SAID))
    for (const [row, now, said] of rows)
      assert.equal(
        yesSaid({ ...row, kind } as AskRow, now),
        said,
        `${kind} ${JSON.stringify(row)}`
      );
});
