// The section of the system prompt every run gets. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_GRANTS } from '@oddboro/ledger/grantable';
import { house, managerWork, stillOnDeskSection, whoIsHereSection } from './house.ts';

const section = house({ has: () => false, now: '9:00', zone: 'London time' });

test('every run is told that only its reply and its tool calls reach the owner', () => {
  assert.match(
    section,
    /- What reaches \{owner\} is only your reply, and what a tool call put on their desk or in their chat\./
  );
});

test("every run is told that the owner reads every reply, so work goes by its title, a file by its name in code, and a colleague's, an unclear or a given folder's file by its full path from ~", () => {
  assert.match(
    section,
    /- \{owner\} reads every reply you write, in any run, even one that goes back to a colleague\./
  );
  assert.match(
    section,
    /never by a number, and a file by its name alone, in code \(`plan\.md`\); when that name could mean more than one file, or the file is a colleague's or in a folder \{owner\} gave you, give its full path from ~ with forward slashes, in code, which the page turns into a link by a short name\. Ids and any other path are for tool calls\./
  );
  assert.doesNotMatch(section, /never by its folder or path/);
});

test('every run is told to ask which one when a name could be an Odd or someone outside, or there is more than one way, and to offer choices as lines the page turns into buttons', () => {
  assert.match(
    section,
    /- When \{owner\} names someone who could be an Odd here or someone outside the office, such as an email contact, .* ask them which in one short question before you act, naming each choice and where it sends what\. When their words settle it \("email Nate", "hand it to Nate"\), just do it\./
  );
  assert.match(
    section,
    /end your reply with each choice on a line of its own, as `\[choice\] ` then the answer in their words .* at most five, with nothing after them\./
  );
});

test("the office's Odds are listed by name, id and role, a persona's with where its words go, and what this Odd can do about them", () => {
  const odds = [
    {
      id: 'marshall',
      name: 'Marshall',
      role: 'Office Manager',
      remit: 'Keeps the editorial plan.',
      persona: false
    },
    {
      id: 'nate',
      name: 'Nate',
      role: 'Advisor from New Altitude',
      remit: 'Reviews strategy.',
      persona: true
    }
  ];
  const can = whoIsHereSection(odds, true);
  assert.match(can, /^\n## Who's in the office\n/);
  assert.match(can, /- Marshall \(marshall\): Office Manager\. Keeps the editorial plan\.\n/);
  assert.match(
    can,
    /- Nate \(nate\): Advisor from New Altitude\. Reviews strategy\. A persona: Nate's replies come from New Altitude, so what you give Nate leaves this computer\./
  );
  assert.match(can, /To give one of them work, call hand_off\./);
  const cannot = whoIsHereSection(odds, false);
  assert.match(
    cannot,
    /You cannot hand them work\. If you need a colleague, name them and say that you lack hand-off access/
  );
  assert.doesNotMatch(cannot, /call hand_off/);
  assert.equal(whoIsHereSection([], true), '', 'alone in the office, nothing');
});

test('every run is told never to claim it sent, gave, brought or handed something no tool call did', () => {
  assert.match(
    section,
    /- Never say you sent, gave, brought or handed something unless a tool call in this run did it and succeeded\./
  );
});

test('every run is told never to promise the owner a later step that no tool call in it set up', () => {
  assert.match(
    section,
    /- Never promise \{owner\} a later step, such as "I'll send you" or "when it's ready", unless a tool call in this run set up what brings you back to do it, such as a hand_off, or an ask or task on their desk\./
  );
});

test('every run speaks of the owner by name or as "they" unless the owner said otherwise', () => {
  assert.match(
    section,
    /- Speak of \{owner\} by name or as "they", unless they have told you otherwise\./
  );
});

test('every run is told Run commands and Browse the web are its own tools, which my_access says how to get, never outside tools to find', () => {
  assert.ok(
    section.includes(
      '- my_access lists your outside tools and your own. Run commands and Browse the web are your own tools, not outside tools: my_access says whether you have each, and if not, whether you can ask for it. When a job needs one you can ask for, call ask_for_switch. When an outside tool stops working'
    ),
    section
  );
});

test('a run that can ask for access is told where more outside tools come from', () => {
  const at = (held: string[]) =>
    house({ has: (t) => held.includes(t), now: '9:00', zone: 'London time' });
  assert.match(
    at(['ask_for_access', 'find_connectors']),
    /ask_for_switch\. For more outside tools, call find_connectors, then ask_for_access\. When an outside tool/
  );
  assert.match(
    at(['ask_for_access']),
    /ask_for_switch\. For more outside tools, call ask_for_access\. When an outside tool/
  );
  assert.doesNotMatch(section, /For more outside tools/);
});

test("a run is told where more outside tools come from in the words of the outside-tools grant's line", () => {
  for (const held of [['ask_for_access', 'find_connectors'], ['ask_for_access'], []]) {
    const has = (t: string) => held.includes(t);
    const more = OWNER_GRANTS.outside_tools.missing({ has });
    assert.ok(
      house({ has, now: '9:00', zone: 'London time' }).includes(
        `call ask_for_switch.${more} When an outside tool`
      ),
      held.join(', ')
    );
  }
});

test("every run is told to read what it has on the owner's desk before raising anything, and to revise rather than raise again", () => {
  assert.ok(
    section.includes(
      `- Before you put anything on {owner}'s desk, read "Still on {owner}'s desk from you" above, when it is there. To change an item on it, raise it again with revises set to its id. Never put the same thing on their desk twice.`
    ),
    section
  );
});

test('the desk section lists each open item with its id, says how many more, and is absent when the Odd has none', () => {
  assert.equal(stillOnDeskSection({ items: [], more: 0 }), '');
  assert.equal(
    stillOnDeskSection({
      items: [
        { kind: 'task', id: 9, title: 'Sign the form' },
        { kind: 'ask', id: 4, title: 'Reply to Re: Lunch' }
      ],
      more: 3
    }),
    "\n## Still on {owner}'s desk from you\n\n- Task #9: Sign the form\n- Ask #4: Reply to Re: Lunch\n- And 3 more.\n"
  );
});

for (const hasTools of [false, true]) {
  test(`a run with office tools ${hasTools ? 'on' : 'off'} keeps its house rules`, (t) => {
    t.assert.snapshot(house({ has: () => hasTools, now: '9:00', zone: 'London time' }));
  });
}

for (const pending of [false, true]) {
  test(`a manager ${pending ? 'with' : 'without'} a pending judgment keeps its current brief`, (t) => {
    t.assert.snapshot(managerWork(pending));
  });
}
