// The three AWS tools: each connects in one desk step, and a tool no Odd
// holds any longer drops its role, while the one sign-in stays until no AWS
// tool has a role. Secrets Manager keeps its role while another tool's key
// comes from AWS. The office's own code on every migration, in an in-memory
// PGlite that stands in for db.ts (pglite.ts), with the system's secret store
// stood in for too. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { connectors, staff, tasks } from '../src/schema.ts';
import { db } from './pglite.ts';

const deleted: string[] = [];
mock.module(new URL('../src/secrets.ts', import.meta.url).href, {
  exports: {
    setSecret: () => {},
    getSecret: () => undefined,
    deleteSecret: (id: string, name: string) => {
      deleted.push(`${id}/${name}`);
      return true;
    },
    secretStore: () => ({ ok: true })
  }
});

const {
  AWS_BUILD_ID,
  AWS_READ_ID,
  AWS_SECRETS_ID,
  changeAwsTask,
  grantAccess,
  renameConnector,
  revoke,
  serviceNames,
  services
} = await import('../src/office.ts');
const { BUILT_IN } = await import('../src/registry.ts');

await db.insert(staff).values({
  id: 'cole',
  name: 'Cole',
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  permission: 'act',
  desk: 'You are Cole.'
});
await db
  .insert(connectors)
  .values([
    ...BUILT_IN,
    { id: 'stripe', name: 'Stripe', description: 'Payments.', kind: 'stdio', config: {} }
  ]);

const role = (id: string) => ({
  accountId: '123456789012',
  role: `Oddboro-${id}`,
  region: 'us-east-2'
});
const setAws = (id: string) =>
  db
    .update(connectors)
    .set({ config: { ...BUILT_IN.find((b) => b.id === id)!.config, aws: role(id) } })
    .where(eq(connectors.id, id));
const configOf = async (id: string) =>
  (await db.select().from(connectors).where(eq(connectors.id, id)))[0].config;

test('each AWS tool connects in one step, which names what its role is for', async () => {
  for (const [id, level] of [
    [AWS_SECRETS_ID, 'read'],
    [AWS_READ_ID, 'read'],
    [AWS_BUILD_ID, 'act']
  ] as const)
    await grantAccess('cole', { connector: id, level });
  const open = await db.select().from(tasks).where(eq(tasks.staffId, 'cole'));
  const steps = Object.fromEntries(open.map((t) => [t.title, t.steps]));
  assert.equal(steps['Connect AWS Secrets Manager for Cole'].length, 1);
  assert.match(steps['Connect AWS Secrets Manager for Cole'][0].text, /never their values/);
  assert.match(steps['Connect AWS, read only for Cole'][0].text, /cannot read a secret value/);
  assert.deepEqual(steps['Connect AWS, builder for Cole'][0].action, {
    kind: 'aws',
    connector: AWS_BUILD_ID
  });
});

test('a revoked AWS tool drops its role, and the sign-in goes with the last one', async () => {
  await setAws(AWS_READ_ID);
  await setAws(AWS_BUILD_ID);
  await revoke('cole', AWS_READ_ID);
  assert.equal((await configOf(AWS_READ_ID)).aws, undefined);
  assert.deepEqual(deleted, [], 'builder still has a role, so the sign-in stays');
  await revoke('cole', AWS_BUILD_ID);
  assert.equal((await configOf(AWS_BUILD_ID)).aws, undefined);
  assert.deepEqual(deleted, ['aws/sso']);
});

test("Secrets Manager keeps its role while another tool's key comes from AWS", async () => {
  deleted.length = 0;
  await setAws(AWS_SECRETS_ID);
  await db
    .update(connectors)
    .set({ config: { fromAws: { STRIPE_KEY: { secret: 'prod/stripe' } } } })
    .where(eq(connectors.id, 'stripe'));
  await revoke('cole', AWS_SECRETS_ID);
  assert.deepEqual((await configOf(AWS_SECRETS_ID)).aws, role(AWS_SECRETS_ID));
  assert.deepEqual(deleted, []);

  const [cole] = await db.select().from(staff).where(eq(staff.id, 'cole'));
  await db.insert(staff).values({ ...cole, id: 'river', name: 'River' });
  await grantAccess('cole', { connector: 'stripe', level: 'read' });
  await grantAccess('river', { connector: 'stripe', level: 'read' });
  await revoke('cole', 'stripe');
  assert.ok((await configOf('stripe')).fromAws?.STRIPE_KEY, 'River still uses the tool');
  await revoke('river', 'stripe');
  assert.equal((await configOf('stripe')).fromAws, undefined);
  assert.equal((await configOf(AWS_SECRETS_ID)).aws, undefined);
  assert.deepEqual(deleted, ['aws/sso']);
});

test("Change puts an AWS tool's one step on the desk again, once", async () => {
  await db.update(tasks).set({ status: 'done' });
  const first = await changeAwsTask(AWS_BUILD_ID);
  assert.equal(first.staffId, null, 'the office asks, not an Odd');
  assert.deepEqual(first.steps[0].action, { kind: 'aws', connector: AWS_BUILD_ID });
  assert.equal((await changeAwsTask(AWS_BUILD_ID)).id, first.id, 'one open at a time');
  await assert.rejects(changeAwsTask('stripe'), /Only an AWS tool/);
});

test('the owner renames a service, and the Services list shows who holds it', async () => {
  await grantAccess('cole', { connector: 'stripe', level: 'read' });
  await renameConnector('stripe', '  Stripe   payments ');
  assert.equal((await serviceNames()).stripe, 'Stripe payments');
  await assert.rejects(renameConnector('stripe', '   '), /1 to 60/);
  const stripe = (await services()).find((s) => s.id === 'stripe');
  assert.deepEqual(stripe?.odds, [{ id: 'cole', name: 'Cole', level: 'read' }]);
  assert.equal(stripe?.aws, false);
});

test('two role or Region changes at once give one open task', async () => {
  const awsSteps = async () =>
    (await db.select().from(tasks).where(eq(tasks.status, 'open'))).filter((t) =>
      t.steps.some((s) => s.action?.kind === 'aws' && s.action.connector === AWS_READ_ID)
    );
  assert.deepEqual(await awsSteps(), [], 'no change is on the desk yet');
  const both = await Promise.all([changeAwsTask(AWS_READ_ID), changeAwsTask(AWS_READ_ID)]);
  const open = await awsSteps();
  assert.equal(open.length, 1);
  assert.deepEqual(
    both.map((t) => t.id),
    [open[0].id, open[0].id]
  );
});
