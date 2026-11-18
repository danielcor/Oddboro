// A Codex Odd's run as the office starts it, in an office under test
// (office-under-test.ts) with a stand-in `codex` first on PATH: its exact
// arguments, the permission profile the kernel holds it to on a chat, a
// thread run, a lead's chat and a run reading the owner's edit, its
// environment and temp folder, the office's Codex home and sign-in, what it is
// told about its own tools, how its stream (a recorded live turn too) reaches
// the floor and the usage records, and that what its shell left running in the
// run's process tree stops with it. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  L,
  OFFICE_PROCESS_GIT,
  assertKeychainUntouched,
  bin,
  chat,
  chatOf,
  codexLaunches,
  filesOf,
  folder,
  gave,
  goal,
  odd,
  onPlatform,
  ownerData,
  ownerHome,
  plain,
  runOf,
  withEnv
} from './office-under-test.ts';

const { mcpServers, GATEWAY_TOKEN } = await import('./codex.ts');
const { stopGroups } = await import('./launch.ts');
const { processGone } = await import('./drive.ts');
const { deniedEdits } = await import('./files.ts');

await L.pg`insert into staff ${L.pg([
  { ...odd('cody', 'Cody'), agent: 'codex' },
  { ...odd('cass', 'Cass'), agent: 'codex' },
  { ...odd('cole', 'Cole'), agent: 'codex' },
  { ...odd('cora', 'Cora'), agent: 'codex' }
])}`;

const CODEX_HOME = join(folder, 'accounts', 'codex', 'office');
/** The names no run may write in a folder it writes, as files.ts has them. */
const INSTRUCTIONS = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude',
  '.grok',
  'AGENTS.md',
  '.mcp.json',
  'AGENTS.override.md',
  '.codex',
  '.agents',
  'GEMINI.md',
  '.gemini'
];
/**
 * Each instruction file in `w` shut, at the top and below, the path and
 * everything under it. On Linux Codex mounts the exact `.codex` and `.agents`
 * itself, so the office leaves those two paths to it (`SELF_SHUT` in codex.ts).
 */
const shut = (w: string, platform: NodeJS.Platform = 'darwin') =>
  Object.fromEntries(
    INSTRUCTIONS.flatMap((n) =>
      [`${w}/${n}`, `${w}/${n}/**`, `${w}/**/${n}`, `${w}/**/${n}/**`]
        .filter((p) => !(platform === 'linux' && (p === `${w}/.codex` || p === `${w}/.agents`)))
        .map((p) => [p, 'deny'])
    )
  );
/** A profile's paths with this machine's folder and each run's id as stand-ins. */
const plainPaths = (fs: Record<string, string>) =>
  Object.fromEntries(Object.entries(fs).map(([p, v]) => [plain([p])[0], v]));
/** The `-c` values too long to compare whole, as stand-ins. */
const hideSets = (args: string[]) =>
  args.map((a, i) =>
    args[i - 1] === '-c' &&
    /^(developer_instructions|permissions|mcp_servers|shell_environment_policy\.set)=/.test(a)
      ? `${a.slice(0, a.indexOf('='))}=<…>`
      : a
  );
/** One chat message's error, for a run that never replies. */
async function chatError(id: string, message = 'Hello.'): Promise<string> {
  let error = '';
  await chat(id, message, (e) => {
    if (e.type === 'error') error = e.message;
  });
  return error;
}
/** A new chat session for `id`, as if it never chatted: no session, and no chat for a replay to carry a stand-in's words into. */
const forget = (id: string) => {
  rmSync(L.chatSession(id), { force: true });
  rmSync(L.home('staff', id, 'chat.jsonl'), { force: true });
};

test("a Codex Odd's first chat starts codex exec with every switch the office sets, its message on stdin, and the office's file tools in place of a shell", async () => {
  // The Mac's switches; Linux adds one (`project_doc_max_bytes`, tested below).
  const run = await onPlatform('darwin', () => chatOf('cody'));
  assert.deepEqual(plain(hideSets(run.args)), [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--strict-config',
    '--ignore-rules',
    ...[
      'approval_policy="never"',
      'agents.enabled=false',
      'allow_login_shell=false',
      'shell_environment_policy.inherit="core"',
      'history.persistence="none"',
      'analytics.enabled=false',
      'check_for_update_on_startup=false',
      'cli_auth_credentials_store="file"',
      'project_root_markers=[]',
      'skills.bundled.enabled=false',
      'skills.include_instructions=false',
      ...[
        'view_image',
        'multi_agent',
        'hooks',
        'memories',
        'apps',
        'remote_plugin',
        'goals',
        'shell_snapshot',
        'plugins',
        'browser_use',
        'computer_use',
        'image_generation',
        'in_app_browser',
        'skill_mcp_dependency_install',
        'workspace_dependencies',
        'tool_suggest',
        'sleep_tool'
      ].map((f) => `features.${f}=false`),
      'shell_environment_policy.set=<…>',
      // Browse the web is off for a new Odd.
      'web_search="disabled"',
      'developer_instructions=<…>',
      // Run commands is off for a new Odd: no shell, so files go through the office's file tools.
      'features.shell_tool=false',
      'features.unified_exec=false',
      'permissions=<…>',
      'default_permissions="odd"',
      'mcp_servers=<…>',
      // No level picked: Medium (`effortFor`).
      'model_reasoning_effort="medium"'
    ].flatMap((c) => ['-c', c]),
    '-'
  ]);
  assert.match(run.system, /You are Cody\./);
  assert.ok(run.message.endsWith('Hello.'), run.message);
  // The office's file server, under this Node, holds the folders its profile holds, with every tool allowed.
  const dir = join(folder, 'staff', 'cody');
  assert.deepEqual(filesOf(run), {
    command: process.execPath,
    args: [L.FILES_SERVER],
    walls: {
      cwd: dir,
      reads: [ownerData],
      writes: [dir],
      noWrite: deniedEdits({ dir, writes: [dir], granted: [] })
    }
  });
  assert.equal(run.servers?.files.enabled_tools, undefined);
});

// One test per system, faked, so a Mac proves both: only Linux reads Codex's
// own install (`codexInstall`) and leaves two exact paths to Codex (`selfShut`), the folder of the codex first on PATH, which
// here is the stand-in's bin folder.
for (const platform of ['darwin', 'linux'] as const)
  test(`on ${platform}, a Codex Odd's chat is held by the kernel to its own folder and its own temp folder, reads the owner's data folder it is told of, the developer folder xcode-select picks and node's OpenSSL config, and never reaches an instruction file, /tmp or the network`, () =>
    // An empty home, so this Mac's own developer tool folders are not read.
    ownerHome(() =>
      onPlatform(platform, async () => {
        const run = await chatOf('cody');
        assert.ok(run.system.includes(`data folder: ${ownerData}`), run.system);
        assert.deepEqual(run.permissions?.network, { enabled: false });
        assert.deepEqual(plainPaths(run.permissions?.filesystem ?? {}), {
          ':root': 'deny',
          ':minimal': 'read',
          ':slash_tmp': 'deny',
          '/Library/Developer/CommandLineTools': 'read',
          '/private/var/db/xcode_select_link': 'read',
          '<home>/Applications/Xcode.app/Contents/Developer': 'read',
          '/System/Library/OpenSSL/openssl.cnf': 'read',
          ...(platform === 'linux' ? { '<home>/bin': 'read' } : {}),
          '<home>/data': 'read',
          '<home>/staff/cody': 'write',
          '<home>/codex-tmp/<id>': 'write',
          ...shut('<home>/staff/cody', platform)
        });
      })
    ));

test("with Run commands on, Codex's commands stay off the internet, Browse the web or not", async () => {
  const owner = await L.ownerName();
  const offline = `a shell confined to your folders and ${owner}'s developer tools (read only), with no network`;
  await L.pg`update staff set commands = true, web = true where id = 'cole'`;
  try {
    const on = await chatOf('cole');
    assert.ok(on.args.includes('features.shell_tool=true'), on.args.join(' '));
    assert.deepEqual(on.permissions?.network, { enabled: false });
    assert.ok(on.system.includes(offline), on.system);
    await L.pg`update staff set web = false where id = 'cole'`;
    assert.deepEqual((await chatOf('cole')).permissions?.network, { enabled: false });
  } finally {
    await L.pg`update staff set commands = false, web = false where id = 'cole'`;
  }
});

test("a Codex run reads the developer tool folders that exist and never their credential files, nor a link's folder, nor its file in a secret store or with a glob character in its path", () =>
  ownerHome(async (home) => {
    const h = realpathSync(home);
    /** A link in ~/.local/bin named `name`, to a file of that name in `folder`. */
    const link = (name: string, folder: string) => {
      mkdirSync(join(h, folder), { recursive: true });
      writeFileSync(join(h, folder, name), '');
      symlinkSync(join(h, folder, name), join(h, '.local/bin', name));
    };
    for (const d of ['.npm', '.cargo', '.local/bin']) mkdirSync(join(h, d), { recursive: true });
    link('x', '.local/share/x/bin');
    link('y', '.config/y');
    link('z', '.local/share/z[1]/bin');
    // A credential file in each folder whose entries Codex has listed one by one, and a file beside it.
    const controls = [
      '.volta/tools/image/node/v1.0.0/bin/node',
      '.gradle/wrapper/gradle-wrapper.properties',
      'go/pkg/mod/cache/vcs/0a1b/HEAD',
      '.cargo/git/db/dep-0a1b/HEAD'
    ];
    for (const f of [
      '.volta/tools/image/node/v1.0.0/etc/npmrc',
      '.gradle/init.d/proxy.gradle',
      'go/pkg/mod/cache/vcs/0a1b/config',
      '.cargo/git/db/dep-0a1b/config',
      ...controls
    ]) {
      mkdirSync(dirname(join(h, f)), { recursive: true });
      writeFileSync(join(h, f), '');
    }
    const profile = (await chatOf('cora')).permissions?.filesystem ?? {};
    const mine = Object.entries(profile).filter(([p]) => p.startsWith(h + '/'));
    assert.deepEqual(mine, [
      [join(h, '.npm'), 'read'],
      [join(h, '.volta'), 'read'],
      [join(h, '.cargo'), 'read'],
      [join(h, 'go'), 'read'],
      [join(h, '.gradle'), 'read'],
      [join(h, '.local/bin'), 'read'],
      [join(h, '.local/share/x/bin/x'), 'read'],
      [join(h, '.cargo/credentials'), 'deny'],
      [join(h, '.cargo/credentials.toml'), 'deny'],
      [join(h, '.cargo/config'), 'deny'],
      [join(h, '.cargo/config.toml'), 'deny'],
      [join(h, '.gradle/gradle.properties'), 'deny'],
      [join(h, '.gradle/init.gradle'), 'deny'],
      [join(h, '.gradle/init.gradle.kts'), 'deny'],
      [join(h, '.gradle/init.d'), 'deny'],
      [join(h, '.volta/tools/image/node/v1.0.0/etc/npmrc'), 'deny'],
      [join(h, '.gradle/init.d/proxy.gradle'), 'deny'],
      [join(h, 'go/pkg/mod/cache/vcs/0a1b/config'), 'deny'],
      [join(h, '.cargo/git/db/dep-0a1b/config'), 'deny']
    ]);
    for (const f of controls)
      assert.ok(
        !mine.some(([p, how]) => how === 'deny' && L.within(join(h, f), p)),
        `${f} is shut`
      );
  }));

test("every glob in a Codex run's profile is a deny, and it names no repository, since Codex refuses to start on a glob it reads or writes and keeps each write folder's own .git read only itself", async () => {
  const w = join(realpathSync(folder), 'given', 'cora-repo');
  const r = join(realpathSync(folder), 'given', 'cora-read');
  for (const f of [w, r]) mkdirSync(join(f, '.git'), { recursive: true });
  await L.pg`update staff set folders = ${JSON.stringify([
    { path: w, write: true },
    { path: r, write: false }
  ])}::jsonb where id = 'cora'`;
  const fs = (await chatOf('cora')).permissions?.filesystem ?? {};
  assert.equal(fs[w], 'write', 'the granted folder did not reach the run');
  // Codex takes `<p>/**` as the subtree of an exact path; any other `*` is a glob.
  const globs = Object.keys(fs).filter((p) => p.replace(/\/\*\*$/, '').includes('*'));
  assert.ok(globs.length > 0, 'no glob to check');
  for (const p of globs) assert.equal(fs[p], 'deny', `${p} is a glob Codex refuses as ${fs[p]}`);
  const repo = Object.keys(fs).filter((p) => p.includes('/.git/') || p.endsWith('/.git'));
  assert.deepEqual(repo, []);
});

test("on Linux a Codex run leaves the exact .codex and .agents paths to Codex's own read-only mount, shuts what is under them, and reads no AGENTS.md", async () => {
  const w = join(folder, 'staff', 'cody');
  const linux = await onPlatform('linux', () => chatOf('cody'));
  const fs = linux.permissions?.filesystem ?? {};
  for (const n of ['.codex', '.agents']) {
    assert.equal(fs[`${w}/${n}`], undefined, `${n} is denied as an exact path`);
    for (const p of [`${w}/${n}/**`, `${w}/**/${n}`, `${w}/**/${n}/**`])
      assert.equal(fs[p], 'deny', p);
  }
  assert.equal(fs[`${w}/AGENTS.md`], 'deny');
  assert.ok(linux.args.includes('project_doc_max_bytes=0'), linux.args.join(' '));
  // On a Mac nothing clashes, so both stay and AGENTS.md is left to the deny.
  const mac = await onPlatform('darwin', () => chatOf('cody'));
  for (const n of ['.codex', '.agents'])
    assert.equal(mac.permissions?.filesystem?.[`${w}/${n}`], 'deny');
  assert.ok(!mac.args.includes('project_doc_max_bytes=0'), mac.args.join(' '));
});

test('a Codex run reads the developer folder xcode-select names by its real path, never the link it named', async () => {
  const fs = (await chatOf('cody')).permissions?.filesystem ?? {};
  // The test's own folder may sit behind a link too (/var is one on a Mac).
  const apps = join(realpathSync(folder), 'Applications');
  assert.equal(fs[join(apps, 'Xcode.app', 'Contents', 'Developer')], 'read');
  assert.equal(fs[join(apps, 'Linked.app', 'Contents', 'Developer')], undefined);
});

test("a Codex run asks xcode-select with PATH alone, so DEVELOPER_DIR in the office's environment names no folder it reads", async () => {
  const fs = (await chatOf('cody')).permissions?.filesystem ?? {};
  assert.ok(process.env.DEVELOPER_DIR, 'the office under test sets DEVELOPER_DIR');
  assert.equal(fs[realpathSync(process.env.DEVELOPER_DIR)], undefined);
});

test("a Codex colleague's run on a thread reads the thread's folder and the owner's data folder, and writes only its own part of the thread", async () => {
  const h = await gave('cody', 'cass', { title: 'Codex thread' });
  // The Mac's walls; Linux leaves two exact paths to Codex (tested above).
  const run = await onPlatform('darwin', () => runOf(h.id));
  const thread = L.threadFolder(h.thread);
  const fs = run.permissions?.filesystem ?? {};
  assert.equal(fs[thread], 'read');
  assert.equal(fs[ownerData], 'read');
  assert.equal(fs[join(thread, 'cass')], 'write');
  assert.equal(fs[join(folder, 'staff', 'cass')], 'write');
  for (const w of [join(folder, 'staff', 'cass'), join(thread, 'cass')])
    for (const [p, v] of Object.entries(shut(w))) assert.equal(fs[p], v, p);
});

test("a Codex lead's chat reads the folder of the goal it leads, and writes nothing there", async () => {
  const h = await gave('cody', 'cass', { title: 'Codex goal', goalId: await goal('Codex goal') });
  const thread = L.threadFolder(h.thread);
  mkdirSync(thread, { recursive: true });
  const fs = (await chatOf('cody')).permissions?.filesystem ?? {};
  assert.equal(fs[thread], 'read');
  assert.ok(
    !Object.entries(fs).some(([p, v]) => p.startsWith(thread) && v === 'write'),
    'the chat writes in the goal folder'
  );
});

test("a Codex colleague's chat reads the folder of work it is on, and writes nothing there", async () => {
  const h = await gave('cody', 'cass', { title: 'Codex work' });
  const thread = L.threadFolder(h.thread);
  mkdirSync(thread, { recursive: true });
  const fs = (await chatOf('cass')).permissions?.filesystem ?? {};
  assert.equal(fs[thread], 'read');
  assert.ok(
    !Object.entries(fs).some(([p, v]) => p.startsWith(thread) && v === 'write'),
    'the chat writes in the folder'
  );
});

test("a Codex run reading the owner's edit may read that file and never write it", async () => {
  const dir = join(folder, 'staff', 'cass', 'notes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.md'), 'The owner wrote this.');
  assert.ok(
    await L.learnFromEdit('cass', { path: 'notes/plan.md', before: 'Cass wrote this.' }, 'x')
  );
  const [f] = await L.pg<{ id: number }[]>`
    select id from follow_ups where staff_id = 'cass' and kind = 'edited' and outcome is null`;
  const fs = (await runOf(f.id)).permissions?.filesystem ?? {};
  assert.equal(fs[join(dir, 'plan.md')], 'read');
  assert.equal(fs[join(dir, 'plan.md', '**')], 'read');
});

test("a Codex run's environment has the office's Codex home and the run's own temp folder, and no key, Codex setting, git variable or node options from the office's own", () =>
  withEnv(OFFICE_PROCESS_GIT, async () => {
    const run = await chatOf('cody');
    assert.deepEqual(run.codexEnv, {
      CODEX_HOME,
      TMPDIR: join(folder, 'codex-tmp', run.env.RUN_KEY)
    });
    assert.equal(run.temp, true, 'the temp folder was not there while the run went');
  }));

test("a Codex run's shell gets the office's git settings and npm's cache in its temp folder through one shell_environment_policy.set, never on codex's own environment, with an empty git template in its temp folder", async () => {
  const run = await chatOf('cody');
  const temp = join(folder, 'codex-tmp', run.env.RUN_KEY);
  assert.deepEqual(run.git, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TEMPLATE_DIR: join(temp, 'git-template'),
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.attributesFile',
    GIT_CONFIG_VALUE_1: '/dev/null',
    npm_config_cache: join(temp, 'npm'),
    npm_config_userconfig: join(temp, 'npmrc'),
    npm_config_globalconfig: join(temp, 'npmrc-global')
  });
  // A second set would replace the first.
  assert.equal(run.args.filter((a) => a.startsWith('shell_environment_policy.set=')).length, 1);
  assert.equal(run.gitTemplate, true, 'the git template was missing or not empty as the run went');
  // The shell inherits only the core variables, so one set on codex itself never reaches it.
  assert.deepEqual(
    Object.keys(run.codexEnv ?? {}).filter((k) => k.startsWith('GIT_')),
    []
  );
});

test("a Codex run's temp folder goes when it ends, and one a run that died with the office left goes at the next run", async () => {
  await chatOf('cody');
  assert.deepEqual(readdirSync(join(folder, 'codex-tmp')), []);
  mkdirSync(join(folder, 'codex-tmp', 'died-with-the-office'));
  await chatOf('cody');
  assert.deepEqual(readdirSync(join(folder, 'codex-tmp')), []);
});

test('a message that starts with a dash reaches codex whole on stdin, never as a flag', async () => {
  forget('cody');
  const said = '- buy milk\n- call the vet';
  const run = await chatOf('cody', said);
  assert.ok(run.message.endsWith(said), run.message);
  assert.equal(run.args.at(-1), '-');
  // The owner's words also reach the office's tool server, inside `-c mcp_servers`; never as an argument of their own.
  assert.ok(!run.args.some((a) => a.startsWith('- buy milk')), 'the message went on argv');
});

test("Codex's shell commands, MCP calls and file changes reach the floor once each by Claude Code's names, and the reply is the last message", async () => {
  const run = await chatOf('cole');
  assert.deepEqual(run.tools, ['Bash', 'mcp__office__raise_ask', 'Edit']);
  assert.ok(!run.message.includes('Looking.'));
});

test("a Codex run's tokens are recorded with cached and cache-written tokens apart from the rest of its input", async () => {
  await chatOf('cole');
  let rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 100 && !rows.length; i++) {
    rows = await L.pg`
      select model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
      from usage where staff_id = 'cole'`;
    if (!rows.length) await new Promise((r) => setTimeout(r, 20));
  }
  // The stand-in's turn: 1000 in, 600 of them cached and 100 cache-written; 50 out, 20 of them reasoning.
  assert.deepEqual(rows[0], {
    model: 'codex',
    input_tokens: 300,
    output_tokens: 50,
    cache_read_tokens: 600,
    cache_write_tokens: 100
  });
});

test("a Codex Odd's next chat resumes the session its last one started", async () => {
  forget('cole');
  const first = await chatOf('cole');
  assert.ok(!first.args.includes('resume'), 'a first chat resumed a session');
  const next = await chatOf('cole');
  assert.deepEqual(next.args.slice(-3), ['resume', '019a0000-0000-7000-8000-00000000c0de', '-']);
});

test("a Codex Odd's chat gets the owner's pictures as --image, after resume on a resumed session, and is told where every attached file is", async () => {
  forget('cole');
  await chatOf('cole');
  const { attachedFiles, keepAttachment } = await import('./chat-files.ts');
  const shot = keepAttachment('cole', 'image.png', 'image/png', new Uint8Array([1, 2, 3]));
  const pdf = keepAttachment('cole', 'lease.pdf', 'application/pdf', new Uint8Array([4]));
  const files = attachedFiles('cole', [
    { tag: 'Image #1', name: shot.name },
    { tag: 'lease.pdf', name: pdf.name }
  ]);
  let text = '';
  await chat(
    'cole',
    'What is [Image #1] and [lease.pdf]?',
    (e) => {
      if (e.type === 'done') text = e.text;
      if (e.type === 'error') text = e.message;
    },
    undefined,
    files
  );
  const next = JSON.parse(text.slice(0, text.lastIndexOf('\nOutcome:'))) as {
    args: string[];
    message: string;
  };
  assert.deepEqual(next.args.slice(-4), [
    'resume',
    '019a0000-0000-7000-8000-00000000c0de',
    `--image=${files[0].path}`,
    '-'
  ]);
  // The PDF is not a picture: Codex reads it with its shell, told where it is.
  // Its name is in the tool server's settings, for tell_lead, but never on an --image.
  assert.ok(
    !next.args.some((a) => a.startsWith('--image') && a.includes(pdf.name)),
    'the PDF went as a picture'
  );
  assert.ok(next.message.includes(`- [Image #1]: ${files[0].path} (image/png)`), next.message);
  assert.ok(
    next.message.includes(`- [lease.pdf]: ${files[1].path} (application/pdf)`),
    next.message
  );
  // The owner's line in the chat keeps each file, without its path.
  const { history } = await import('./staff.ts');
  const line = history('cole').findLast((e) => e.from === 'owner');
  assert.deepEqual(
    line?.files?.map((f) => f.tag),
    ['Image #1', 'lease.pdf']
  );
  assert.ok(!JSON.stringify(line).includes('/attachments/'), 'the path went in the chat log');
});

test("a Codex Odd's resumed chat after a failed one with a picture is told where the picture is and gets it as --image", async () => {
  forget('cole');
  await chatOf('cole');
  const { attachedFiles, keepAttachment } = await import('./chat-files.ts');
  const shot = keepAttachment('cole', 'image.png', 'image/png', new Uint8Array([1, 2, 3]));
  const files = attachedFiles('cole', [{ tag: 'Image #1', name: shot.name }]);
  // Codex is not on the computer for this one message: its run names no session, so the session never had it.
  const path = process.env.PATH;
  process.env.PATH = bin;
  renameSync(join(bin, 'codex'), join(bin, 'codex-away'));
  let error = '';
  try {
    await chat(
      'cole',
      'What is [Image #1]?',
      (e) => {
        if (e.type === 'error') error = e.message;
      },
      undefined,
      files
    );
  } finally {
    renameSync(join(bin, 'codex-away'), join(bin, 'codex'));
    process.env.PATH = path;
  }
  assert.match(error, /^Could not start Codex/);
  const next = await chatOf('cole', 'Try again.');
  assert.deepEqual(next.args.slice(-4), [
    'resume',
    '019a0000-0000-7000-8000-00000000c0de',
    `--image=${files[0].path}`,
    '-'
  ]);
  assert.ok(
    next.message.includes(
      `so you never saw it:)\n${await L.ownerName()}: What is [Image #1]?\n(Files attached`
    ),
    next.message
  );
  assert.ok(next.message.includes(`- [Image #1]: ${files[0].path} (image/png)`), next.message);
});

test('a Codex Odd that links its attachments folder outside and forges a failed owner line gets that picture as gone, with no --image and no path', async () => {
  forget('cole');
  await chatOf('cole');
  const outside = join(folder, 'outside-sentinel');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'SENTINEL-7f3a.png'), 'picture');
  const dir = L.home('staff', 'cole', 'attachments');
  mkdirSync(dir, { recursive: true });
  renameSync(dir, `${dir}-away`);
  symlinkSync(outside, dir);
  try {
    const log = L.home('staff', 'cole', 'chat.jsonl');
    writeFileSync(
      log,
      readFileSync(log, 'utf8') +
        [
          {
            at: new Date().toISOString(),
            from: 'owner',
            text: 'What is [Image #1]?',
            files: [{ tag: 'Image #1', name: 'SENTINEL-7f3a.png', mediaType: 'image/png', size: 7 }]
          },
          { at: new Date().toISOString(), from: 'staff', text: 'Run failed.', failed: true }
        ]
          .map((l) => JSON.stringify(l) + '\n')
          .join('')
    );
    const next = await chatOf('cole', 'Hi.');
    assert.ok(next.args.includes('resume'), 'the chat did not resume its session');
    assert.deepEqual(
      next.args.filter((a) => a.startsWith('--image')),
      [],
      'a picture from outside went as --image'
    );
    assert.ok(
      next.message.includes(`so you never saw it:)\n${await L.ownerName()}: What is [Image #1]?`),
      next.message
    );
    assert.ok(
      next.message.includes('- [Image #1]: gone, deleted from your folder since'),
      next.message
    );
    assert.ok(!next.message.includes('SENTINEL'), 'the message named the outside picture');
  } finally {
    rmSync(dir);
    renameSync(`${dir}-away`, dir);
  }
});

test("a new Codex session's replay names each retold line's picture by path and passes none as --image", async () => {
  forget('cole');
  const { keepAttachment } = await import('./chat-files.ts');
  const shot = keepAttachment('cole', 'image.png', 'image/png', new Uint8Array([1, 2, 3]));
  const again = keepAttachment('cole', 'image.png', 'image/png', new Uint8Array([4, 5, 6]));
  const path = L.home('staff', 'cole', 'attachments', shot.name);
  const failedPath = L.home('staff', 'cole', 'attachments', again.name);
  // Plain lines, so no stand-in acts on words in them. The second owner line's
  // run failed, and the replay holds it, so the session is not missing it.
  writeFileSync(
    L.home('staff', 'cole', 'chat.jsonl'),
    [
      {
        at: '2026-11-06T09:00:00.000Z',
        from: 'owner',
        text: 'What is [Image #1]?',
        files: [{ tag: 'Image #1', ...shot }]
      },
      { at: '2026-11-06T09:01:00.000Z', from: 'staff', text: 'A chair.' },
      {
        at: '2026-11-06T09:02:00.000Z',
        from: 'owner',
        text: 'And [Image #2]?',
        files: [{ tag: 'Image #2', ...again }]
      },
      { at: '2026-11-06T09:03:00.000Z', from: 'staff', text: 'Run failed.', failed: true }
    ]
      .map((l) => JSON.stringify(l) + '\n')
      .join('')
  );
  const next = await chatOf('cole', 'And the colour?');
  assert.ok(!next.args.includes('resume'), 'a new session resumed one');
  assert.deepEqual(
    next.args.filter((a) => a.startsWith('--image')),
    [],
    'a replayed picture went as --image'
  );
  assert.ok(next.message.includes(`- [Image #1]: ${path} (image/png)`), next.message);
  assert.ok(next.message.includes(`- [Image #2]: ${failedPath} (image/png)`), next.message);
});

test("a Codex Odd without Run commands is told it has no shell and to ask for one with ask_for_switch; with it, a shell confined to its folders and the owner's developer tools, with no network, Browse the web or not", async () => {
  const owner = await L.ownerName();
  const shell = `a shell confined to your folders and ${owner}'s developer tools (read only)`;
  const switchOn = (name: string) => `ask ${owner} to turn on ${name} with ask_for_switch.`;
  const off = await chatOf('cody');
  assert.ok(
    off.system.includes(
      `Your own tools work on files only. No shell: ${switchOn('Run commands')} No web: ${switchOn('Browse the web')}`
    ),
    off.system
  );
  assert.doesNotMatch(off.system, /a shell confined/);
  await L.pg`update staff set commands = true where id = 'cody'`;
  try {
    const commands = await chatOf('cody');
    assert.ok(
      commands.system.includes(
        `Your own tools work on files, plus ${shell}, with no network. No web: ${switchOn('Browse the web')}`
      ),
      commands.system
    );
    assert.doesNotMatch(commands.system, /no shell|Run commands in/i);
    await L.pg`update staff set web = true where id = 'cody'`;
    const both = await chatOf('cody');
    assert.ok(
      both.system.includes(
        `Your own tools work on files, plus ${shell}, with no network, and web search.`
      ),
      both.system
    );
  } finally {
    await L.pg`update staff set commands = false, web = false where id = 'cody'`;
  }
});

test("Browse the web turns Codex's web search on", async () => {
  const search = (args: string[]) => args.find((a) => a.startsWith('web_search='));
  await L.pg`update staff set web = true where id = 'cole'`;
  try {
    assert.equal(search((await chatOf('cole')).args), 'web_search="live"');
  } finally {
    await L.pg`update staff set web = false where id = 'cole'`;
  }
  assert.equal(search((await chatOf('cole')).args), 'web_search="disabled"');
});

test('a recorded Codex turn replays as it ran: the floor sees the office call, the file change and the shell command once each, the reply is the last message, and the next chat resumes its thread', async () => {
  // A live codex-cli 0.166.0 turn on the free plan, with the owner's paths and the thread id made up.
  const fixture = fileURLToPath(new URL('./fixtures/codex-chat.jsonl', import.meta.url));
  forget('cass');
  const tools: string[] = [];
  let text = '';
  try {
    await chat('cass', `Replay ${fixture}`, (e) => {
      if (e.type === 'tool') tools.push(e.name);
      if (e.type === 'done') text = e.text;
      if (e.type === 'error') text = e.message;
    });
    assert.deepEqual(tools, ['mcp__office__my_goals', 'Edit', 'Bash']);
    assert.ok(text.startsWith('1. `my_goals` returned: `You serve no goals yet.`'), text);
    assert.ok(!text.includes('follow the sequence'), 'the first message joined the reply');
    const next = await chatOf('cass');
    assert.deepEqual(next.args.slice(-3), ['resume', '019a0000-0000-7000-8000-0000000c0de2', '-']);
  } finally {
    forget('cass');
  }
});

test('whatever a Codex run with Run commands left running stops when the run ends', async () => {
  const at = join(folder, 'sleeper.pid');
  // Only a shell leaves processes behind, so only a run with one gets a process group of its own.
  await L.pg`update staff set commands = true where id = 'cole'`;
  try {
    await chatOf('cole', `Leave a sleeper at ${at}`);
  } finally {
    await L.pg`update staff set commands = false where id = 'cole'`;
  }
  const pid = Number(readFileSync(at, 'utf8'));
  // A signal still finds a process that exited and waits to be reaped, so it asks ps too.
  const alive = () => !processGone(pid);
  try {
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(), false, 'the sleep the run started outlived it');
  } finally {
    if (alive()) process.kill(pid);
  }
});

test('stopping a run mid-command stops the command too, though Codex runs each command in a process group of its own', async () => {
  const at = join(folder, 'command.pid');
  // A stand-in for codex as a run times out: in a group of its own, with a
  // command it started in another group still running.
  const tool = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(at)}, String(c.pid));
setInterval(() => {}, 1000);`
    ],
    { detached: true, stdio: 'ignore' }
  );
  // What ps says of a process, for a failure's message.
  const state = (pid: number) =>
    spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  const alive = (pid: number) => !processGone(pid);
  /** Until `done`, within 10 s on a busy runner; done ends the wait at once. */
  const wait = async (done: () => boolean) => {
    const until = Date.now() + 10_000;
    while (!done() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  };
  await wait(() => existsSync(at));
  const command = Number(readFileSync(at, 'utf8'));
  try {
    assert.ok(tool.pid && alive(command), 'the stand-in did not start its command');
    stopGroups(tool.pid);
    await wait(() => !alive(command) && !alive(tool.pid!));
    assert.equal(alive(command), false, `the command outlived the run (ps: ${state(command)})`);
    assert.equal(alive(tool.pid), false, `the tool outlived the run (ps: ${state(tool.pid)})`);
  } finally {
    for (const pid of [command, tool.pid]) if (pid && alive(pid)) process.kill(pid);
  }
});

test("a Codex turn that fails ends the run with Codex's own words", async () => {
  const stream = join(folder, 'codex-failed.jsonl');
  writeFileSync(
    stream,
    [
      { type: 'thread.started', thread_id: '019a0000-0000-7000-8000-00000000fa11' },
      { type: 'turn.failed', error: { message: 'The model is busy.' } }
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n'
  );
  assert.equal(await chatError('cass', `Replay ${stream}`), 'The model is busy.');
});

test("the office keeps a config.toml it did not write, so the owner's workspace pin stays", async () => {
  const config = join(CODEX_HOME, 'config.toml');
  const pinned = 'forced_chatgpt_workspace_id = "ws-test"\n';
  writeFileSync(config, pinned);
  await chatOf('cody');
  assert.equal(readFileSync(config, 'utf8'), pinned);
});

test('a Codex run from an office Codex home nobody signed in to points to its Settings tab to sign in to that home, which keeps the sign-in as a file, and starts nothing', async () => {
  const auth = join(CODEX_HOME, 'auth.json');
  const config = join(CODEX_HOME, 'config.toml');
  const before = codexLaunches().length;
  renameSync(auth, `${auth}.away`);
  rmSync(config);
  try {
    assert.equal(
      await chatError('cody'),
      "Codex is not signed in for this office. Sign in on this Odd's Settings tab, under Model."
    );
    assert.equal(codexLaunches().length, before, 'codex started without a sign-in');
    assert.match(readFileSync(config, 'utf8'), /^cli_auth_credentials_store = "file"$/m);
  } finally {
    renameSync(`${auth}.away`, auth);
  }
});

test('a Codex Odd on a Mac without codex fails its run naming Codex, and never runs on Claude Code', async () => {
  // Only the stand-ins' folder, so the Mac's own codex, if it has one, is not found either.
  const path = process.env.PATH;
  process.env.PATH = bin;
  renameSync(join(bin, 'codex'), join(bin, 'codex-away'));
  try {
    assert.match(await chatError('cody'), /^Could not start Codex: spawn codex ENOENT/);
  } finally {
    renameSync(join(bin, 'codex-away'), join(bin, 'codex'));
    process.env.PATH = path;
  }
});

test("a Codex run's MCP servers call their tools without asking, a server granted by tool gets only those, and the office's must start", () => {
  const servers = mcpServers(
    {
      office: { type: 'stdio', command: 'node', args: ['mcp.ts'], env: { RUN_KEY: 'k' } },
      notes: { type: 'http', url: 'https://notes.example/mcp', headers: { Authorization: 'a' } }
    },
    ['mcp__office', 'mcp__notes__search', 'mcp__notes__read']
  );
  assert.deepEqual(servers, {
    office: {
      command: 'node',
      args: ['mcp.ts'],
      env: { RUN_KEY: 'k' },
      default_tools_approval_mode: 'approve',
      required: true
    },
    notes: {
      url: 'https://notes.example/mcp',
      http_headers: { Authorization: 'a' },
      default_tools_approval_mode: 'approve',
      enabled_tools: ['search', 'read']
    }
  });
});

test("a Codex run reads the gateway's token from its environment, never its command line", () => {
  const servers = mcpServers(
    {
      mail: {
        type: 'http',
        url: 'http://127.0.0.1:4500/api/gateway/gmail',
        headers: { Authorization: 'Bearer tok' }
      }
    },
    ['mcp__mail']
  );
  assert.deepEqual(servers.mail, {
    url: 'http://127.0.0.1:4500/api/gateway/gmail',
    bearer_token_env_var: GATEWAY_TOKEN,
    default_tools_approval_mode: 'approve'
  });
  assert.doesNotMatch(JSON.stringify(servers), /the-run-secret/);
});

test('no test reached the keychain', () => {
  assertKeychainUntouched();
});
