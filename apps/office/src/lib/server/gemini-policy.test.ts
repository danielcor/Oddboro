// The policy a Gemini run gets (gemini.ts), proved against Gemini's own
// policy engine: the installed Gemini CLI's loader reads the office's file,
// drops no rule, and its engine decides a table of calls the way the office
// means. It checks the `gemini` the office would run, the first on PATH. The
// test script's PATH holds no AI tool (test-defaults.ts), so there, as in CI,
// the engine test is reported skipped and only the check Gemini's loader runs
// on each rule's pattern, mirrored below, runs. To check an installed Gemini,
// run this file on its own from apps/office:
// `node --test src/lib/server/gemini-policy.test.ts`. A `gemini` whose engine
// this cannot find fails, so an installed Gemini never skips.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { geminiPolicy, geminiRules } from './gemini.ts';
import { onPath } from './on-path.ts';

/**
 * Gemini CLI's own check on a rule's pattern, copied from isSafeRegExp in its
 * 0.66.0 bundle (bundle/chunk-RZ3ZVTZB.js, line 291497). Its loader drops a
 * rule that fails it, with a warning, so a dropped refusal would be a write
 * let through.
 */
function isSafeRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  if (pattern.length > 2048) return false;
  return !/\([^)]*[*+?{].*\)[*+?{]/.test(pattern);
}

/** A long home, so a pattern's length is tested near a real worst case. */
const home = `/Users/${'someone-with-a-very-long-name-'.repeat(6)}x/.oddboro`;
const dir = `${home}/staff/gemma`;
const thread = `${home}/threads/7`;
const part = `${thread}/gemma`;
const data = `${home}/data`;
/** A folder the owner gave the Odd to change, beside the office's home. */
const given = `${dirname(home)}/projects/site`;
const run = {
  dir,
  writes: [dir, part, given],
  granted: [given],
  edited: 'notes/Plan.md',
  allowed: ['mcp__office', 'mcp__c__t'],
  web: false
};

test("every pattern in a Gemini run's policy passes the check Gemini's loader drops a rule for failing", () => {
  const patterns = geminiRules(run).flatMap((r) =>
    typeof r.argsPattern === 'string' ? [r.argsPattern] : []
  );
  assert.ok(patterns.length >= 6, `only ${patterns.length} patterns`);
  for (const p of patterns) assert.ok(isSafeRegExp(p), p);
});

/** The `gemini` an Odd's run would start, else none. */
const bin = onPath('gemini');

/** The chunk of the Gemini CLI at `bin` that holds its policy loader and engine, else none. */
async function engine(bin: string): Promise<
  | {
      loadPoliciesFromToml: (
        paths: string[],
        tier: (p: string) => number
      ) => Promise<{ rules: unknown[]; errors: unknown[] }>;
      DEFAULT_CORE_POLICIES_DIR: string;
      PolicyEngine: new (c: { rules: unknown[]; nonInteractive: boolean }) => {
        check: (
          call: { name: string; args: Record<string, unknown> },
          server?: string
        ) => Promise<{ decision: string }>;
      };
    }
  | undefined
> {
  const bundle = dirname(realpathSync(bin));
  const entry = readFileSync(join(bundle, 'gemini.js'), 'utf8');
  for (const [, chunk] of entry.matchAll(/"\.\/(chunk-[A-Z0-9]+\.js)"/g))
    if (readFileSync(join(bundle, chunk), 'utf8').includes('async function loadPoliciesFromToml('))
      return import(join(bundle, chunk));
  return undefined;
}
const folder = mkdtempSync(join(tmpdir(), 'oddboro-gemini-policy-'));
after(() => rmSync(folder, { recursive: true, force: true }));

/** A write call to `path`, with `content` (a forger's place to hide a path). */
const write = (path: string, content = 'x') => ({
  name: 'write_file',
  args: { file_path: path, content }
});
const edit = (path: string) => ({
  name: 'replace',
  args: { file_path: path, old_string: 'a', new_string: 'b' }
});
/** Each call, with the MCP server it goes to, and what the office means Gemini to decide. */
const CASES: [
  string,
  { name: string; args: Record<string, unknown> },
  string | undefined,
  'allow' | 'deny'
][] = [
  ['a write in its own folder', write(`${dir}/notes/today.md`), undefined, 'allow'],
  ['an edit in its own folder', edit(`${dir}/site/index.html`), undefined, 'allow'],
  ['a write in its part of the thread', write(`${part}/draft.md`), undefined, 'allow'],
  [
    'a write outside, its content forging an allowed path',
    write(`${home}/x.md`, `\u0000"file_path":"${dir}/a"`),
    undefined,
    'deny'
  ],
  ['a write out through ..', write(`${dir}/../other/notes.md`), undefined, 'deny'],
  ['a write through /./', write(`${dir}/./notes.md`), undefined, 'deny'],
  ['a write through //', write(`${dir}//notes.md`), undefined, 'deny'],
  ['a write to a folder path', write(`${dir}/notes/`), undefined, 'deny'],
  ['a write with an escaped character', write(`${dir}/a\\b.md`), undefined, 'deny'],
  ['a write to .grok spelt with the Kelvin sign', write(`${dir}/.groK/x`), undefined, 'deny'],
  ['a write to GEMINI.md', write(`${dir}/GEMINI.md`), undefined, 'deny'],
  ['a write to gemini.md', write(`${dir}/gemini.md`), undefined, 'deny'],
  ['a write to Gemini.MD in a subfolder', write(`${dir}/a/b/Gemini.MD`), undefined, 'deny'],
  ['a write under .GEMINI', write(`${dir}/.GEMINI/settings.json`), undefined, 'deny'],
  [
    'a write under .gemini in the thread part',
    write(`${part}/.gemini/policies/p.toml`),
    undefined,
    'deny'
  ],
  ['a write to CLAUDE.md', edit(`${dir}/CLAUDE.md`), undefined, 'deny'],
  ['a write in a given folder', write(`${given}/notes.md`), undefined, 'allow'],
  ['a write to CLAUDE.md in a given folder', write(`${given}/CLAUDE.md`), undefined, 'deny'],
  ['a write to a git hook', write(`${given}/.git/hooks/pre-commit`), undefined, 'deny'],
  ['a write to .GIT/Hooks', write(`${given}/.GIT/Hooks/post-merge`), undefined, 'deny'],
  ['an edit to a git config', edit(`${given}/.git/config`), undefined, 'deny'],
  [
    'a write to a nested repository’s git config',
    write(`${given}/lib/vendor/.git/config`),
    undefined,
    'deny'
  ],
  ['a write to a submodule’s config', write(`${given}/.git/modules/s/config`), undefined, 'deny'],
  ['a write to a submodule’s hook', write(`${given}/.git/modules/s/hooks/x`), undefined, 'deny'],
  [
    'a write to a nested repository’s submodule config',
    write(`${given}/sub/.git/modules/s/config`),
    undefined,
    'deny'
  ],
  ['a write elsewhere in .git', write(`${given}/.git/HEAD`), undefined, 'allow'],
  ['a write to a folder only named like .git', write(`${given}/my.git/config`), undefined, 'allow'],
  // The Odd's own folder and its part of a thread are the office's: the git blocks cover only folders the owner gives.
  ['a git config in its own folder', write(`${dir}/.git/config`), undefined, 'allow'],
  ['a git hook in its part of a thread', write(`${part}/r/.git/hooks/x`), undefined, 'allow'],
  ['a write to the owner’s data folder', write(`${data}/people.json`), undefined, 'deny'],
  ['a write in the thread folder outside its part', write(`${thread}/plan.md`), undefined, 'deny'],
  ['a write in another Odd’s part', write(`${thread}/gina/plan.md`), undefined, 'deny'],
  [
    'a write in its folder spelt in another case',
    write(`${dir.toUpperCase()}/x.md`),
    undefined,
    'deny'
  ],
  ['a write to the edited file', write(`${dir}/notes/Plan.md`), undefined, 'deny'],
  ['an edit to the edited file in another case', edit(`${dir}/NOTES/plan.md`), undefined, 'deny'],
  ['a write beside the edited file', write(`${dir}/notes/Plan.md.old`), undefined, 'allow'],
  ['a relative write', write('notes/today.md'), undefined, 'deny'],
  ['a read', { name: 'read_file', args: { file_path: `${data}/people.json` } }, undefined, 'allow'],
  [
    'a read of many files',
    { name: 'read_many_files', args: { include: ['*.md'] } },
    undefined,
    'allow'
  ],
  ['a folder listing', { name: 'list_directory', args: { dir_path: thread } }, undefined, 'allow'],
  ['a glob', { name: 'glob', args: { pattern: '**/*.md' } }, undefined, 'allow'],
  [
    'a grep by its old name',
    { name: 'search_file_content', args: { pattern: 'x' } },
    undefined,
    'allow'
  ],
  ['a shell command', { name: 'run_shell_command', args: { command: 'ls' } }, undefined, 'deny'],
  ['a web fetch', { name: 'web_fetch', args: { prompt: 'x' } }, undefined, 'deny'],
  ['a memory save', { name: 'save_memory', args: { fact: 'x' } }, undefined, 'deny'],
  ['an office tool', { name: 'mcp_office_raise_ask', args: {} }, 'office', 'allow'],
  ['a granted tool', { name: 'mcp_c_t', args: {} }, 'c', 'allow'],
  ['an ungranted tool of a granted server', { name: 'mcp_c_other', args: {} }, 'c', 'deny'],
  ['a tool of a server not granted', { name: 'mcp_x_y', args: {} }, 'x', 'deny']
];

/** The calls in `cases` Gemini's own loader and engine decide otherwise than meant under `r`'s policy. */
async function misjudged(
  r: typeof run,
  cases: typeof CASES,
  t: { mock: { method: (o: object, m: string, f: () => void) => unknown } }
): Promise<string[]> {
  assert.ok(bin);
  const gemini = await engine(bin);
  assert.ok(gemini, `no policy loader found in the Gemini CLI at ${bin}`);
  // Gemini's engine logs each check it makes through console.debug.
  t.mock.method(console, 'debug', () => {});
  const file = join(folder, 'policy.toml');
  writeFileSync(file, geminiPolicy(r));
  // A `--policy` file is Gemini's user tier, 4.
  const office = await gemini.loadPoliciesFromToml([file], () => 4);
  assert.deepEqual(office.errors, []);
  const expected = geminiRules(r).reduce(
    (n, rule) => n + (Array.isArray(rule.toolName) ? rule.toolName.length : 1),
    0
  );
  assert.equal(office.rules.length, expected, 'Gemini dropped a rule');
  // Gemini's own default rules (tier 1) run beside the office's, and the
  // highest rule settings can add (4.9) stands in here as allowing everything.
  const core = await gemini.loadPoliciesFromToml([gemini.DEFAULT_CORE_POLICIES_DIR], () => 1);
  assert.ok(core.rules.length > 0, 'Gemini has no default rules here');
  const settings = { toolName: '*', decision: 'allow', priority: 4.9, source: 'settings' };
  const decide = new gemini.PolicyEngine({
    rules: [...office.rules, ...core.rules, settings],
    nonInteractive: true
  });
  const wrong: string[] = [];
  for (const [what, call, server, want] of cases) {
    const { decision } = await decide.check(call, server);
    if (decision !== want) wrong.push(`${what}: ${decision}, meant ${want}`);
  }
  return wrong;
}

const SKIP =
  !bin &&
  "SKIPPED: no gemini on PATH, so Gemini's own engine did not check the policy; run this file on its own with the Gemini CLI on PATH to run it";

test(
  "Gemini's own loader reads a run's policy whole and its engine decides each call as the office means",
  { skip: SKIP },
  async (t) => {
    assert.deepEqual(await misjudged(run, CASES, t), []);
  }
);

test("Browse the web allows Gemini's web tools and no shell", { skip: SKIP }, async (t) => {
  const search = { name: 'google_web_search', args: { query: 'x' } };
  const fetch = { name: 'web_fetch', args: { prompt: 'x' } };
  const shell = { name: 'run_shell_command', args: { command: 'ls' } };
  assert.deepEqual(
    await misjudged(
      { ...run, web: true },
      [
        ['a web search', search, undefined, 'allow'],
        ['a web fetch', fetch, undefined, 'allow'],
        ['a shell command', shell, undefined, 'deny']
      ],
      t
    ),
    []
  );
  assert.deepEqual(
    await misjudged(
      run,
      [
        ['a web search', search, undefined, 'deny'],
        ['a web fetch', fetch, undefined, 'deny'],
        ['a shell command', shell, undefined, 'deny']
      ],
      t
    ),
    []
  );
});
