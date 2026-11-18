// A first day gets the office's current jobs and the same tool limits as
// other runs. The provider stand-in returns the prompt it actually received.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { L, runOf, chatOf } from './office-under-test.ts';

test('a new hire sees what its colleague covers and checks existing work before asking the owner', async () => {
  const remit = 'Keeps the confirmed newsletter calendar and visual guidelines.';
  await L.pg`update staff set role = ${L.MANAGER_ROLE}, remit = ${remit} where id = 'paige'`;
  await L.pg`update staff set tools = ${L.STARTER_TOOLS} where id = 'sam'`;
  await L.addReport('paige', 'Newsletter plan', 'The next issue brief is ready.');
  await L.startFirstDay('sam');
  const [row] = await L.pg<
    { id: number }[]
  >`select id from follow_ups where staff_id = 'sam' and kind = 'first_day'`;
  const run = await runOf(row.id);
  assert.ok(run.system.includes(`Paige (paige): ${L.MANAGER_ROLE}. ${remit}`));
  assert.match(run.system, /Use search_ledger for relevant decisions and work/);
  assert.match(run.system, /If a colleague can do it and you can hand off, call hand_off/);
  assert.match(run.system, /does not let you read a colleague's private files/);
  const check = run.system.indexOf('2. Check what the office already knows');
  const ask = run.system.indexOf('3. Give');
  assert.ok(check >= 0 && ask > check);
  assert.match(run.system, /Say why no colleague can do it/);
});

test('removing office visibility hides colleague jobs, and removing hand-offs explains the limit', async () => {
  await L.pg`update staff set tools = ${['see_office', 'give_owner_a_task']} where id = 'sam'`;
  const cannot = await chatOf('sam');
  assert.match(cannot.system, /You cannot hand them work/);
  assert.match(cannot.system, /Do not describe their work as something only .* can do/);
  await L.pg`update staff set tools = ${['give_owner_a_task']} where id = 'sam'`;
  const hidden = await chatOf('sam');
  assert.doesNotMatch(hidden.system, /## Who's in the office/);
  assert.doesNotMatch(hidden.system, /Keeps the confirmed newsletter calendar/);
});
