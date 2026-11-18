// Whether the owner passed the Act check, and the check while it is open. Each
// owner action that puts an Odd at Act goes through `withActCheck`: the
// Settings tab's level, a level ask's Raise to Act, and a hire at Act. The page
// loads `passed` (`actChecked`), so the check shows before the raise; a
// refusal from the office (409, `ACT_CHECK_NEEDED`) shows it too, in case the
// page was out of date. The office checks the answers and keeps the pass.
// Right after the check, or at once when it was passed before, the owner
// chooses what happens when another Odd hands that Odd work
// (`HandOffChoice.svelte`), every time, and the raise carries the choice.
import { ACT_CHECK_NEEDED } from '@oddboro/ledger/act-check';

/** `choosing`: the name of the Odd whose choice is open. */
export const actCheck = $state<{ passed: boolean; asking: boolean; choosing?: string }>({
  passed: false,
  asking: false
});

let settle: ((passed: boolean) => void) | undefined;
let chosen: ((acts: boolean | undefined) => void) | undefined;

/** Open the check, or go straight on when it was passed. True once passed, false on Cancel. */
function checkFirst(): Promise<boolean> {
  if (actCheck.passed) return Promise.resolve(true);
  settle?.(false);
  actCheck.asking = true;
  return new Promise((resolve) => (settle = resolve));
}

/** The check closed: passed, or cancelled with nothing changed. */
export function actCheckClosed(passed: boolean): void {
  if (passed) actCheck.passed = true;
  actCheck.asking = false;
  settle?.(passed);
  settle = undefined;
}

/** Open the choice for `name`. True lets it act on its own, false asks first, undefined on Cancel. */
function chooseFor(name: string): Promise<boolean | undefined> {
  chosen?.(undefined);
  actCheck.choosing = name;
  return new Promise((resolve) => (chosen = resolve));
}

/** The choice closed: what the owner picked, or undefined on Cancel. */
export function handOffChoiceClosed(acts: boolean | undefined): void {
  actCheck.choosing = undefined;
  chosen?.(acts);
  chosen = undefined;
}

/**
 * Put the Odd `name` at Act with `raise`, after the check when it was never
 * passed, and after the owner's choice for work another Odd hands it, which
 * `raise` sends. Cancel at either leaves everything as it was and returns
 * undefined.
 */
export async function withActCheck<T>(
  name: string,
  raise: (actsOnHandOffs: boolean) => Promise<T>
): Promise<T | undefined> {
  if (!(await checkFirst())) return;
  const acts = await chooseFor(name);
  if (acts === undefined) return;
  try {
    return await raise(acts);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ACT_CHECK_NEEDED) throw e;
    actCheck.passed = false;
    if (!(await checkFirst())) return;
    return raise(acts);
  }
}
