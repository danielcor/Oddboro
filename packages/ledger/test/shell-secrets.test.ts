// The app's Keychain through its shell: the office loads every secret once,
// answers from memory, sends each change over the pipe, and moves the items
// an older version kept through `security` across, once, with no prompt.
// A fake shell answers on a pair of streams and `security` is stubbed, so no
// test touches a real Keychain. Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';

/** The old items `security` keeps, under the service "oddboro". */
const legacy = new Map<string, string>();
/** Old items whose delete fails, as a locked keychain's would. */
const stuck = new Set<string>();
/** Every argument list `security` was started with, to check no value is on one. */
const commandLines: string[][] = [];

/** How `security -i` splits a line into words, as measured on macOS 26. */
function words(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ') {
      i++;
      continue;
    }
    let word = '';
    if (line[i] === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++)
        word += line[i] === '\\' ? line[++i] : line[i];
      i++;
    } else for (; i < line.length && line[i] !== ' '; i++) word += line[i];
    out.push(word);
  }
  return out;
}
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

function security(args: string[], input?: string): { status: number; stderr: string } {
  commandLines.push(args);
  const [command] = args;
  if (command === '-i') {
    for (const line of (input ?? '').split('\n').filter(Boolean)) {
      assert.ok(Buffer.byteLength(line) <= 3900, 'a line security -i would cut');
      const w = words(line);
      assert.equal(w[0], 'add-generic-password');
      assert.equal(flag(w, '-s'), 'oddboro');
      legacy.set(flag(w, '-a'), flag(w, '-w'));
    }
    return { status: 0, stderr: '' };
  }
  const account = flag(args, '-a');
  if (command === 'find-generic-password') {
    const value = legacy.get(account);
    return value === undefined
      ? { status: 44, stderr: 'The specified item could not be found in the keychain.\n' }
      : { status: 0, stderr: `password: "${value}"\n` };
  }
  if (command === 'delete-generic-password') {
    if (stuck.has(account) || !legacy.delete(account)) return { status: 44, stderr: '' };
    return { status: 0, stderr: '' };
  }
  return { status: 0, stderr: '' };
}

mock.module('node:child_process', {
  namedExports: {
    execFile: () => assert.fail('no secret store starts a program in the background'),
    spawn: () => assert.fail('no secret store spawns'),
    execFileSync: (cmd: string, args: string[], options: { input?: string }) => {
      assert.equal(cmd, 'security');
      const { status } = security(args, options?.input);
      if (status) throw Object.assign(new Error(`Command failed: security ${args[0]}`), { status });
      return '';
    },
    spawnSync: (cmd: string, args: string[]) => {
      assert.equal(cmd, 'security');
      return { ...security(args), stdout: '' };
    }
  }
});
// Under test the store refuses until a test stands one in. This file tests
// the Keychain store itself, with `security` stubbed above, so it asks for
// this system's store before secrets.ts picks one as it loads.
process.env.ODDBORO_SECRETS = 'system';
const {
  getSecret,
  setSecret,
  deleteSecret,
  secretStore,
  useShellSecrets,
  saveLines,
  securityWord
} = await import('../src/secrets.ts');

const errors: string[] = [];
const logs: string[] = [];
mock.method(console, 'error', (line: string) => void errors.push(line));
mock.method(console, 'log', (line: string) => void logs.push(line));

/** The shell's own Keychain under "com.oddboro.office", and the accounts it refuses to save. */
const shellKeychain = new Map<string, string>();
const refused = new Set<string>();
/** Every line the office wrote to the shell. */
const sent: string[] = [];

/** A fake shell on a pair of pipes: Node's stdout in, Node's stdin out. */
function fakeShell() {
  const fromNode = new PassThrough();
  const toNode = new PassThrough();
  createInterface({ input: fromNode }).on('line', (line) => {
    sent.push(line);
    const ask = JSON.parse(line.replace(/^oddboro:secret /, '')) as {
      id: number;
      op: string;
      account: string;
      value: string;
    };
    const reply = (more: object) => toNode.write(`${JSON.stringify({ id: ask.id, ...more })}\n`);
    if (ask.op === 'list') reply({ ok: true, secrets: Object.fromEntries(shellKeychain) });
    else if (ask.op === 'legacy') reply({ ok: true, accounts: [...legacy.keys()] });
    else if (refused.has(ask.account))
      reply({ ok: false, error: 'User interaction is not allowed.' });
    else if (ask.op === 'set') {
      shellKeychain.set(ask.account, ask.value);
      reply({ ok: true });
    } else if (ask.op === 'remove') {
      shellKeychain.delete(ask.account);
      reply({ ok: true });
    } else reply({ ok: false, error: 'unknown op' });
  });
  return { fromNode, toNode };
}
const settle = () => new Promise((done) => setTimeout(done, 20));

test('without ODDBORO_SECRETS the office keeps using security and writes nothing to the shell', async () => {
  delete process.env.ODDBORO_SECRETS;
  const { fromNode, toNode } = fakeShell();
  await useShellSecrets(toNode, fromNode);
  await settle();
  assert.deepEqual(sent, []);
});

test(
  'the store kept is the stubbed security, not the one that refuses under test',
  // Elsewhere this system's store is secret-tool or the Credential Manager, which nothing here stubs.
  { skip: process.platform !== 'darwin' && 'security is the store on a Mac only' },
  () => {
    assert.deepEqual(secretStore(), { ok: true });
    assert.deepEqual(commandLines.at(-1), ['default-keychain']);
  }
);

test('the first start loads the shell Keychain and moves the old items across, then deletes them', async () => {
  shellKeychain.set('github:token', 'ghp_new');
  shellKeychain.set('anthropic:API_KEY', 'sk-already-moved');
  // The old item a move before could not delete: the shell's newer value stands.
  legacy.set('anthropic:API_KEY', 'sk-stale');
  legacy.set('gemini:API_KEY', 'AIza "quoted" \\ value');
  // A long value development saved in two pieces.
  legacy.set('notion:oauth', '{"tokens":"first half');
  legacy.set('notion:oauth#1', ' and the second"}');
  legacy.set('linear:token', 'lin_refused');
  refused.add('linear:token');
  legacy.set('slack:token', 'xoxb-stuck');
  stuck.add('slack:token');

  process.env.ODDBORO_SECRETS = 'shell';
  const { fromNode, toNode } = fakeShell();
  await useShellSecrets(toNode, fromNode);

  assert.deepEqual(Object.fromEntries(shellKeychain), {
    'github:token': 'ghp_new',
    'anthropic:API_KEY': 'sk-already-moved',
    'gemini:API_KEY': 'AIza "quoted" \\ value',
    'notion:oauth': '{"tokens":"first half and the second"}',
    'slack:token': 'xoxb-stuck'
  });
  assert.deepEqual(
    [...legacy.keys()].sort(),
    ['linear:token', 'slack:token'],
    'only what the shell refused or security would not delete stays, for the next start'
  );
  assert.equal(getSecret('notion', 'oauth'), '{"tokens":"first half and the second"}');
  assert.equal(getSecret('anthropic', 'API_KEY'), 'sk-already-moved');
  assert.equal(getSecret('linear', 'token'), undefined, 'a refused item is not in memory either');
  assert.deepEqual(logs, [
    "secrets: moved 3 of 5 into the app's Keychain; 2 stay for the next start"
  ]);
  for (const line of [...logs, ...errors])
    for (const value of ['sk-stale', 'AIza', 'first half', 'lin_refused', 'xoxb'])
      assert.ok(!line.includes(value), `a value reached the log: ${line}`);
});

test('the shell store answers from memory and sends each change at once', async () => {
  const before = sent.length;
  assert.equal(getSecret('github', 'token'), 'ghp_new');
  assert.equal(sent.length, before, 'a read never asks the shell');

  setSecret('figma', 'API_KEY', 'figd_1');
  assert.equal(getSecret('figma', 'API_KEY'), 'figd_1', 'memory changes before the shell answers');
  await settle();
  assert.equal(shellKeychain.get('figma:API_KEY'), 'figd_1');

  assert.equal(deleteSecret('figma', 'API_KEY'), true);
  assert.equal(getSecret('figma', 'API_KEY'), undefined);
  assert.equal(deleteSecret('figma', 'API_KEY'), false, 'none left to remove');
  await settle();
  assert.equal(shellKeychain.has('figma:API_KEY'), false);
  assert.deepEqual(secretStore(), { ok: true });

  const asked = sent.slice(before).map((l) => JSON.parse(l.replace(/^oddboro:secret /, '')));
  assert.deepEqual(
    asked.map(({ op, account, value }) => ({ op, account, value })),
    [
      { op: 'set', account: 'figma:API_KEY', value: 'figd_1' },
      { op: 'remove', account: 'figma:API_KEY', value: undefined }
    ]
  );
});

test("a change the shell refuses is logged by the secret's name, never its value", async () => {
  errors.length = 0;
  setSecret('linear', 'token', 'lin_second_try');
  await settle();
  assert.deepEqual(errors, [
    'secrets: the Keychain did not set linear:token: User interaction is not allowed.'
  ]);
});

test('no secret ever went on a command line', () => {
  for (const args of commandLines)
    for (const value of ['sk-', 'AIza', 'first half', 'lin_', 'xoxb', 'ghp_', 'figd_'])
      assert.ok(!args.join(' ').includes(value), args.join(' '));
});

test('development saves through security -i with every awkward character quoted', () => {
  for (const value of [
    'plain',
    'with "double" quotes',
    "with 'single' quotes",
    'back\\slash and \\" both',
    'trailing backslash\\',
    '  spaces  around  ',
    '$HOME `id` #hash ;semi | pipe',
    'unicode é 日本 🙂',
    JSON.stringify({ a: 'b"c', d: 'e\\f', n: 1 }),
    ''
  ]) {
    const [line, ...more] = saveLines('test:x', value);
    assert.deepEqual(more, []);
    assert.deepEqual(words(line), [
      'add-generic-password',
      '-U',
      '-s',
      'oddboro',
      '-a',
      'test:x',
      '-w',
      value
    ]);
  }
  assert.throws(() => securityWord('two\nlines'), /line break/);
});

test('a long value goes in pieces, each line short enough, and comes back whole', () => {
  const value = JSON.stringify({ discovery: '"é\\'.repeat(3000), tokens: 'x'.repeat(5000) });
  const lines = saveLines('notion:oauth', value);
  assert.ok(lines.length > 2);
  let whole = '';
  lines.forEach((line, i) => {
    assert.ok(Buffer.byteLength(line) <= 3900, `line ${i} is ${Buffer.byteLength(line)} bytes`);
    const w = words(line);
    assert.equal(flag(w, '-a'), i ? `notion:oauth#${i}` : 'notion:oauth');
    whole += flag(w, '-w');
  });
  assert.equal(whole, value);
});
