import type { AskKind, AskRow } from '@oddboro/ledger';
import { LEVEL_NAME } from '@oddboro/ledger/access';

/** What the Desk knows as it words the button: the plan parts ticked, and a call under way. */
export type DeskNow = { picked: number; busy: boolean };

/**
 * What plain Approve reads, by the kind of ask. A reply, a filter, a folder
 * and a hire have their own buttons, and read Approve only when their part
 * is missing. A new kind fails the type check here until it says.
 */
const YES_SAID: Record<AskKind, (a: AskRow, now: DeskNow) => string> = {
  approval: () => 'Approve',
  access: (a) => (a.access ? 'Connect' : 'Approve'),
  hire: () => 'Approve',
  goal: () => 'Set the goal',
  plan: (a, { picked }) =>
    a.plan && picked < a.plan.items.length
      ? `Approve ${picked} of ${a.plan.items.length}`
      : 'Approve',
  hand_offs: () => 'Approve',
  window: () => 'Let it carry on',
  reply: () => 'Approve',
  filter: () => 'Approve',
  folder: () => 'Approve',
  switch: () => 'Turn on',
  level: (a) => (a.level ? `Raise to ${LEVEL_NAME[a.level]}` : 'Approve'),
  office_tool: () => 'Turn on',
  call: (_, { busy }) => (busy ? 'Making the call' : 'Make this call'),
  remove: () => 'Remove',
  bring_back: () => 'Bring back',
  catch_up: () => 'Approve',
  standing: () => 'Allow'
};

/** The words on an ask's yes button on the Desk. */
export const yesSaid = (a: AskRow, now: DeskNow): string => YES_SAID[a.kind](a, now);
