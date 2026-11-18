import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS } from './roster.ts';
import { readClaudeAgent, skippedSaid, sortServers } from './claude-agent.ts';

const agent = [
  '---',
  'name: fact-checker',
  'description: >-',
  '  Check each claim',
  '  against its source.',
  'model: sonnet',
  'tools: [Read, Grep]',
  'skills: [check-claims]',
  'permissionMode: plan',
  '---',
  'Quote the passage and flag any mismatch.',
  '---',
  'Return a list of corrections.'
].join('\n');

test('a Claude agent opens as an editable job with its other settings named', () => {
  const draft = readClaudeAgent('\uFEFF' + agent.replaceAll('\n', '\r\n'));
  assert.equal(draft.name, 'fact-checker');
  assert.equal(draft.role, 'fact checker');
  assert.equal(draft.remit, 'Check each claim against its source.');
  assert.equal(
    draft.desk,
    draft.remit + '\n\nQuote the passage and flag any mismatch.\n---\nReturn a list of corrections.'
  );
  assert.match(draft.model ?? '', /^claude-sonnet-/);
  assert.deepEqual(draft.skipped, ['tools', 'skills', 'permissionMode']);
});

test('an unsupported model is named and the job description is never silently cut', () => {
  const draft = readClaudeAgent(agent.replace('model: sonnet', 'model: unknown'));
  assert.equal(draft.model, null);
  assert.ok(draft.skipped.includes('model'));
  assert.throws(() => readClaudeAgent(agent + 'a'.repeat(LIMITS.desk)), /Shorten/);
  assert.throws(() => readClaudeAgent('ordinary Markdown'), /header/);
  assert.throws(() => readClaudeAgent('---\nname: example\n---'), /description/);
});

test('a header the parser cannot read, or one with an alias, says so in one plain sentence', () => {
  const broken = {
    message:
      "The agent file's header, between the --- lines, could not be read. Check it for a typo and try again."
  };
  assert.throws(
    () =>
      readClaudeAgent(
        '---\nname: fact-checker\ndescription: Checks.\ntools: [Read, Grep\n---\nGo.'
      ),
    broken
  );
  assert.throws(
    () => readClaudeAgent('---\nname: &who fact-checker\ndescription: *who\n---\nGo.'),
    broken
  );
});

test('the settings left in the file are named in plain words', () => {
  assert.equal(
    skippedSaid(['tools', 'permissionMode', 'skills', 'odd']),
    'its tool list, its permission mode, its skills, its odd setting'
  );
});

test('web and catalog servers become asks, and a command or unknown name is only listed', () => {
  const draft = readClaudeAgent(
    [
      '---',
      'name: researcher',
      'description: Find sources.',
      'tools: [Read]',
      'permissionMode: bypassPermissions',
      'mcpServers:',
      '  - GitHub',
      '  - slack',
      '  - notes:',
      '      type: http',
      '      url: https://mcp.example.com/mcp',
      '  - plain:',
      '      type: sse',
      '      url: http://localhost:3000/sse',
      '  - files:',
      '      command: npx',
      '      args: [-y, some-server]',
      '---',
      'Go.'
    ].join('\n')
  );
  assert.deepEqual(draft.skipped, ['tools', 'permissionMode']);
  assert.deepEqual(draft.servers, [
    { name: 'GitHub' },
    { name: 'slack' },
    { name: 'notes', url: 'https://mcp.example.com/mcp' },
    { name: 'plain', url: 'http://localhost:3000/sse' },
    { name: 'files', command: 'npx' }
  ]);
  assert.deepEqual(sortServers(draft.servers, [{ id: 'github', name: 'GitHub' }]), {
    asks: [
      { name: 'GitHub', connector: 'github', label: 'GitHub' },
      { name: 'notes', connector: 'https://mcp.example.com/mcp', label: 'mcp.example.com' }
    ],
    listed: [
      { name: 'slack', why: 'not one of the office tools' },
      { name: 'plain', why: 'not a secure web address' },
      { name: 'files', why: 'runs a command here' }
    ]
  });
  // A map of name to settings reads the same way.
  const map = readClaudeAgent(
    '---\nname: a\ndescription: b\nmcpServers:\n  notes: { url: "https://mcp.example.com/mcp" }\n---\n'
  );
  assert.deepEqual(map.servers, [{ name: 'notes', url: 'https://mcp.example.com/mcp' }]);
});
