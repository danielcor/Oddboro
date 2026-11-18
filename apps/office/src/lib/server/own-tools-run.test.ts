// What the owner's Run commands, Browse the web and the folders they give an
// Odd reach in a run as the office starts it, on each tool, in an office under
// test (office-under-test.ts), and the staff route that sets them: the
// arguments and environment each tool gets, Claude Code's sandbox for
// commands, and what the Odd is told. Run with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import {
  L,
  OFFICE_PROCESS_GIT,
  awayFromHome,
  chatOf,
  filesOf,
  folder,
  gave,
  odd,
  onPlatform,
  ownerData,
  ownerHome,
  patch,
  recorded,
  refusal,
  request,
  runOf,
  secrets,
  setOwn,
  withEnv,
  writeRule,
  type Gave
} from './office-under-test.ts';

// After the office under test set its home, as the office's own imports are.
const { deniedEdits } = await import('./files.ts');
const { gitEnv } = await import('./launch.ts');

await L.pg`insert into staff ${L.pg([
  odd('otto', 'Otto'),
  odd('wes', 'Wes'),
  odd('fern', 'Fern'),
  odd('cal', 'Cal'),
  { ...odd('gwen', 'Gwen'), agent: 'grok' },
  { ...odd('cato', 'Cato'), agent: 'codex' },
  { ...odd('gem', 'Gem'), agent: 'gemini' }
])}`;

/** Run commands is on only on a Mac (`commandsHow`), where Claude Code's sandbox was measured. */
const onMac = { skip: process.platform !== 'darwin' && 'Run commands runs on a Mac only' };
const staffDir = (id: string) => join(folder, 'staff', id);

/** A folder outside the office made now, by its real path, as `checkFolder` stores one. */
function made(...parts: string[]): string {
  const p = join(folder, 'given', ...parts);
  mkdirSync(p, { recursive: true });
  return realpathSync(p);
}
/** The value after `flag`. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
/** Every value given with `flag`, which may come more than once. */
const each = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);
type Sandbox = {
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    denyWrite: string[];
  };
  credentials: { envVars: { name: string; mode: string }[] };
  [k: string]: unknown;
};
const settingsOf = (run: Gave) =>
  run.claudeSettings as { sandbox?: Sandbox; enabledPlugins: unknown };

// In an empty home, so no developer tool folder of this Mac's joins the sandbox's reads.
test(
  "a Claude run with Run commands gets Bash in its sandbox, beside the office's file tools",
  onMac,
  () =>
    ownerHome(async () => {
      assert.ok(
        !existsSync(ownerData),
        'this office has a data folder, which the sandbox would read'
      );
      await setOwn('otto', { commands: true });
      const run = await chatOf('otto');
      // The office carries its files, so Bash is its one tool of its own.
      assert.equal(after(run.args, '--tools'), 'Bash');
      assert.ok(run.claudeSettings!.permissions.allow.includes('Bash'));
      assert.ok(run.claudeSettings!.permissions.allow.includes('mcp__files'));
      assert.equal(filesOf(run)?.walls.cwd, staffDir('otto'));
      const tmp = `/private/tmp/ob-${run.env.RUN_KEY.slice(0, 8)}`;
      assert.match(run.tmpdir ?? '', /^\/private\/tmp\/ob-[0-9a-f]{8}$/);
      assert.equal(run.tmpdir, tmp);
      assert.equal(run.nodeOptions, null, "the office's node options reached the run");
      assert.ok(!existsSync(tmp), "the commands' temp folder outlived the run");
      const dir = staffDir('otto');
      const sandbox = settingsOf(run).sandbox;
      // Claude Code names the sessions folder after the Odd's folder, which differs from Mac to Mac.
      const sessions = sandbox?.filesystem.allowRead.find((p) => p.includes('/.claude/projects/'));
      assert.equal(dirname(sessions ?? ''), join(homedir(), '.claude', 'projects'));
      const node = dirname(dirname(process.execPath));
      // The secrets commands never see depend on the test's own environment: the next test holds them.
      const { credentials, ...rest } = sandbox ?? ({} as Sandbox);
      assert.ok(credentials.envVars.length > 0);
      assert.deepEqual(rest, {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          denyRead: ['~/', '/Users', '/Volumes', '/private/tmp', '/tmp', '/private/var/folders'],
          // No data folder: there is none to read.
          allowRead: [dir, sessions, tmp, ...(node.startsWith(homedir() + sep) ? [node] : [])],
          denyWrite: deniedEdits({ dir, writes: [dir], granted: [] })
        },
        network: { allowedDomains: [] }
      });
    })
);

test(
  "a Claude run with Run commands gets the office's git settings from gitEnv, and an empty git template in its temp folder",
  onMac,
  async () => {
    await setOwn('otto', { commands: true });
    const run = await chatOf('otto');
    const tmp = `/private/tmp/ob-${run.env.RUN_KEY.slice(0, 8)}`;
    const expected = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TEMPLATE_DIR: join(tmp, 'git-template'),
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.attributesFile',
      GIT_CONFIG_VALUE_1: '/dev/null'
    };
    assert.deepEqual(gitEnv(tmp), expected);
    assert.deepEqual(run.git, gitEnv(tmp));
    assert.equal(
      run.gitTemplate,
      true,
      'the git template was missing or not empty as the run went'
    );
    // Claude Code reads its own config from XDG_CONFIG_HOME.
    assert.ok(!('XDG_CONFIG_HOME' in gitEnv(tmp)));
  }
);

test(
  "no git variable of the office's own reaches a run: Claude's launch env holds only gitEnv's, and Grok's and Gemini's none",
  onMac,
  () =>
    withEnv(OFFICE_PROCESS_GIT, async () => {
      await setOwn('otto', { commands: true });
      const run = await chatOf('otto');
      assert.deepEqual(run.git, gitEnv(`/private/tmp/ob-${run.env.RUN_KEY.slice(0, 8)}`));
      const git = (env: Record<string, string> = {}) =>
        Object.keys(env).filter((k) => k.startsWith('GIT_'));
      assert.deepEqual(git((await chatOf('gwen')).grokEnv), []);
      assert.deepEqual(git((await chatOf('gem')).geminiEnv), []);
    })
);

test(
  "with Run commands, Bash keeps every git setting gitEnv gives it, by name, while an owner's token stays hidden and an owner's GIT_..._TOKEN never reaches the run",
  onMac,
  () =>
    // An owner's Anthropic token reaches Claude Code (`RUN_ENV_ALLOW`), so its commands must not see it.
    withEnv({ ANTHROPIC_AUTH_TOKEN: 'planted', GIT_ASKPASS_TOKEN: 'planted' }, async () => {
      await setOwn('otto', { commands: true });
      const run = await chatOf('otto');
      const denied = (settingsOf(run).sandbox?.credentials.envVars ?? []).map((v) => v.name);
      const git = Object.keys(gitEnv('/t'));
      assert.ok(
        git.every((n) => run.git?.[n]),
        'a git setting did not reach the run'
      );
      assert.deepEqual(
        git.filter((n) => denied.includes(n)),
        []
      );
      assert.ok(denied.includes('ANTHROPIC_AUTH_TOKEN'), JSON.stringify(denied));
      assert.ok(!('GIT_ASKPASS_TOKEN' in (run.git ?? {})), 'the token reached the run');
    })
);

test(
  "with Run commands, Bash sees none of the run's secrets, and Claude Code and the office's tool server keep theirs",
  onMac,
  async () => {
    const names = ['OFFICE_AUTH', 'FAKE_TOKEN'] as const;
    const before = names.map((n) => process.env[n]);
    Object.assign(process.env, { OFFICE_AUTH: 'key', FAKE_TOKEN: 'planted' });
    secrets.set('anthropic:API_KEY', 'the-office-anthropic-key-for-tests');
    try {
      await setOwn('otto', { commands: true });
      const run = await chatOf('otto');
      const denied = settingsOf(run).sandbox?.credentials.envVars ?? [];
      // Claude Code sets CLAUDE_CODE_MESSAGING_TOKEN itself, so it is in no environment the office passes.
      for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_MESSAGING_TOKEN'])
        assert.ok(
          denied.some((v) => v.name === name && v.mode === 'deny'),
          `${name} reaches Bash: ${JSON.stringify(denied)}`
        );
      // The office's own secrets never reach the run at all (`runEnv`).
      for (const name of ['FAKE_TOKEN', 'DATABASE_URL', 'XAI_API_KEY'])
        assert.ok(!run.envNames.includes(name), `${name} reached the run`);
      assert.ok(denied.every((v) => v.mode === 'deny'));
      assert.ok(
        !denied.some((v) => v.name === 'PATH' || v.name === 'HOME'),
        JSON.stringify(denied)
      );
      assert.equal(run.apiKey, 'the-office-anthropic-key-for-tests', 'a key sign-in lost its key');
      assert.ok(run.env.DATABASE_URL, "the office's tool server lost its database");
    } finally {
      names.forEach((n, i) => {
        if (before[i] === undefined) delete process.env[n];
        else process.env[n] = before[i];
      });
      secrets.delete('anthropic:API_KEY');
    }
  }
);

test("a Claude run with Browse the web gets WebSearch and WebFetch, beside the office's file tools", async () => {
  await setOwn('wes', { web: true });
  const run = await chatOf('wes');
  assert.equal(after(run.args, '--tools'), 'WebSearch,WebFetch');
  assert.equal(filesOf(run)?.walls.cwd, staffDir('wes'));
  const allowed = run.claudeSettings!.permissions.allow;
  assert.ok(allowed.includes('WebSearch') && allowed.includes('WebFetch'), allowed.join(' '));
  assert.ok(!allowed.includes('Bash'));
  assert.equal(settingsOf(run).sandbox, undefined);
  assert.equal(run.tmpdir, null);
});

test('Grok gets the web but never a shell', async () => {
  // A stored yes, as one moved from Claude Code would keep it.
  await setOwn('gwen', { commands: true });
  const off = await chatOf('gwen');
  assert.equal(after(off.args, '--tools'), 'todo_write');
  // Off in every grok the office starts (`grokEnv`).
  assert.equal(off.grokEnv?.GROK_WEB_FETCH, '0');
  // Grok never runs commands, so it is never offered the Run commands switch, whatever is stored.
  assert.ok(
    off.system.includes(
      `Your own tools work on files only. No shell: Grok can't run commands here. No web: ask ${await L.ownerName()} to turn on Browse the web with ask_for_switch.`
    ),
    off.system
  );
  await setOwn('gwen', { commands: true, web: true });
  const on = await chatOf('gwen');
  assert.equal(after(on.args, '--tools'), 'todo_write,web_search,web_fetch');
  assert.equal(on.grokEnv?.GROK_WEB_FETCH, '1');
  // Grok's sandbox asks before a fetch, and a headless run cannot answer.
  assert.ok(on.args.join(' ').includes('--allow web_fetch'), on.args.join(' '));
  assert.ok(!off.args.includes('web_fetch'), off.args.join(' '));
});

test('the system prompt says what the Odd reaches', async () => {
  const owner = await L.ownerName();
  const w = made('reach');
  await setOwn('fern', { web: true, folders: [{ path: w, write: true }] });
  const { system } = await chatOf('fern');
  assert.ok(
    system.includes(
      `You write files only in your folder, on work you share with colleagues in your part of its folder, and in the folders ${owner} gave you to change.`
    ),
    system
  );
  // Claude Code follows the Run commands switch on a Mac only, so only there is Fern told the owner can switch it on.
  const noShell =
    process.platform === 'darwin'
      ? `No shell: ask ${owner} to turn on Run commands with ask_for_switch.`
      : "No shell: Claude Code can't run commands here.";
  assert.ok(
    system.includes(`Your own tools work on files, plus web search and fetch. ${noShell}`),
    system
  );
  assert.ok(
    system.includes(
      `Beyond the office, you reach only the outside tools below, the web and the folders ${owner} gave you.`
    ),
    system
  );
});

test('Run commands refuses a tool that cannot hold it on this system, takes Codex on a Mac and Linux, and survives a tool switch', async () => {
  for (const [id, agent, platform] of [
    ['gwen', 'grok', 'darwin'],
    ['gwen', 'grok', 'linux'],
    ['cato', 'codex', 'win32']
  ] as const) {
    await setOwn(id, {});
    assert.deepEqual(
      await onPlatform(platform, () => refusal(patch(id, { commands: true }))),
      { status: 400, message: L.COMMANDS_WHY[agent] },
      `${agent} on ${platform}`
    );
    assert.equal((await L.staffer(id))?.commands, false);
  }
  for (const platform of ['darwin', 'linux'] as const) {
    await setOwn('cato', {});
    await onPlatform(platform, async () => {
      assert.equal((await patch('cato', { commands: true })).status, 200, platform);
    });
    assert.equal((await L.staffer('cato'))?.commands, true, platform);
  }
  await setOwn('cato', {});
  await setOwn('cal', {});
  await onPlatform('darwin', async () => {
    assert.equal((await patch('cal', { commands: true })).status, 200);
    assert.equal((await L.staffer('cal'))?.commands, true);
    assert.ok(await recorded('Let Cal run commands'));
    await patch('cal', { agent: 'codex' });
    await patch('cal', { agent: 'claude' });
  });
  const cal = await L.staffer('cal');
  assert.equal(cal?.agent, 'claude');
  assert.equal(cal?.commands, true, "a tool switch dropped the owner's Run commands");
});

test('a granted folder reaches every tool at its level', async () => {
  const r = made('level', 'read');
  const w = made('level', 'write');
  const folders = [
    { path: r, write: false },
    { path: w, write: true }
  ];
  for (const id of ['fern', 'gwen', 'cato', 'gem']) await setOwn(id, { folders });

  const claude = await chatOf('fern');
  const allowed = claude.claudeSettings!.permissions.allow;
  const denied = claude.claudeSettings!.permissions.deny;
  const rule = (tool: string, p: string) => `${tool}(${L.rulePath(p)})`;
  assert.ok(allowed.includes(rule('Read', `${r}/**`)) && allowed.includes(rule('Read', `${w}/**`)));
  assert.ok(allowed.includes(rule('Edit', `${w}/**`)));
  assert.ok(!allowed.includes(rule('Edit', `${r}/**`)), 'a read-only folder is writable');
  assert.ok(denied.includes(rule('Edit', `${w}/CLAUDE.md`)));
  assert.ok(!denied.some((d) => d.includes(r)), 'a read-only folder is denied a read');
  const dirs = each(claude.args, '--add-dir');
  assert.ok(dirs.includes(r) && dirs.includes(w), dirs.join(' '));

  const codex = (await chatOf('cato')).permissions?.filesystem ?? {};
  assert.equal(codex[r], 'read');
  assert.equal(codex[w], 'write');

  const grok = await chatOf('gwen');
  // The office's file tools hold Grok to the levels; no tool of Grok's own may edit.
  const walls = filesOf(grok)?.walls;
  assert.ok(walls?.reads.includes(r) && walls.writes.includes(w), JSON.stringify(walls));
  assert.ok(!walls?.writes.includes(r), 'a read-only folder is writable');
  assert.ok(!each(grok.args, '--allow').some((a) => /^(Edit|Write)\(/.test(a)));
  const line = (key: string) =>
    JSON.parse(
      (grok.profile ?? '')
        .split('\n')
        .find((l) => l.startsWith(`${key} = `))
        ?.slice(key.length + 3) ?? '[]'
    ) as string[];
  assert.ok(line('read_only').includes(r) && line('read_only').includes(w), grok.profile);
  assert.ok(line('read_write').includes(w) && !line('read_write').includes(r), grok.profile);

  const gemini = await chatOf('gem');
  const included = each(gemini.args, '--include-directories');
  assert.ok(included.includes(r) && included.includes(w), included.join(' '));
  const policy = gemini.policy ?? '';
  assert.ok(writeRule(policy, 'allow', join(w, 'notes.md')));
  assert.ok(!writeRule(policy, 'allow', join(r, 'notes.md')), 'a read-only folder is writable');
  assert.ok(writeRule(policy, 'deny', join(w, 'GEMINI.md')));
});

test('the Odd is told the folders it was given', async () => {
  const owner = await L.ownerName();
  const r = made('told', 'read');
  const w = made('told', 'write');
  await setOwn('fern', {
    folders: [
      { path: r, write: false },
      { path: w, write: true }
    ]
  });
  const { system } = await chatOf('fern');
  assert.ok(
    system.includes(
      `- Folders ${owner} gave you:\n  - ${r} (read only)\n  - ${w} (read and change)\n`
    ),
    system
  );
});

test('a folder that was deleted can still be removed, and reaches no run', async () => {
  const gone = made('gone');
  await setOwn('fern', { folders: [{ path: gone, write: true }] });
  rmSync(gone, { recursive: true });
  const run = await chatOf('fern');
  assert.ok(!each(run.args, '--add-dir').includes(gone), 'a deleted folder was added');
  assert.ok(
    ![...run.args, JSON.stringify(run.claudeSettings)].some((a) => a.includes(gone)),
    'a deleted folder reached the run'
  );
  assert.ok(!run.system.includes(gone), 'the Odd was told of a deleted folder');
  assert.equal((await patch('fern', { folder: gone, access: null })).status, 200);
  assert.deepEqual((await L.staffer('fern'))?.folders, []);
  assert.ok(await recorded(`Took ${L.shownFolder(gone)} from Fern`));
});

test('the folder route says each refusal and records each change', async () => {
  await setOwn('wes', {});
  await awayFromHome(async (home) => {
    mkdirSync(join(home, '.ssh'));
    assert.deepEqual(await refusal(patch('wes', { folder: '~/.ssh', access: 'read' })), {
      status: 400,
      message: L.FOLDER_REFUSED.secrets
    });
    assert.deepEqual(await refusal(patch('wes', { folder: '~/nowhere', access: 'read' })), {
      status: 400,
      message: L.FOLDER_REFUSED.missing
    });
    assert.deepEqual(await refusal(patch('wes', { folder: '~', access: 'write' })), {
      status: 400,
      message: L.FOLDER_REFUSED.home
    });
    assert.deepEqual(await refusal(patch('wes', { folder: '~', access: 'all' })), {
      status: 400,
      message: 'Pick read or write'
    });
    assert.deepEqual((await L.staffer('wes'))?.folders, []);
    assert.equal((await patch('wes', { web: true })).status, 200);
    assert.equal((await L.staffer('wes'))?.web, true);
    assert.ok(await recorded('Let Wes browse the web'));
  });
});

test(
  "a folder of system files is only a warning, and given nothing, until the owner's Accept sends accept",
  { skip: process.platform === 'win32' && "Windows' temp folder sits in the home's AppData" },
  async () => {
    await setOwn('wes', {});
    await ownerHome(async () => {
      // In the system's temp folder and outside this home, so it counts as system files.
      const broad = realpathSync(mkdtempSync(join(tmpdir(), 'oddboro-broad-')));
      try {
        const change = { folder: broad, access: 'read' };
        for (const asked of [change, { ...change, accept: false }]) {
          const said = await patch('wes', asked);
          assert.equal(said.status, 200);
          assert.deepEqual(await said.json(), { warning: L.FOLDER_WARNING });
          assert.deepEqual((await L.staffer('wes'))?.folders, []);
        }
        const accepted = await patch('wes', { ...change, accept: true });
        assert.deepEqual(await accepted.json(), { ok: true });
        assert.deepEqual((await L.staffer('wes'))?.folders, [{ path: broad, write: false }]);
      } finally {
        rmSync(broad, { recursive: true, force: true });
      }
    });
  }
);

test(
  "on a folder ask, a folder of system files is only a warning, and given nothing, until the owner's Accept sends accept",
  { skip: process.platform === 'win32' && "Windows' temp folder sits in the home's AppData" },
  async () => {
    await setOwn('wes', {});
    await ownerHome(async () => {
      // In the system's temp folder and outside this home, so it counts as system files.
      const broad = realpathSync(mkdtempSync(join(tmpdir(), 'oddboro-broad-')));
      try {
        const { ask } = await L.raiseAsk('wes', {
          title: 'Asked',
          why: 'w',
          ifApproved: 'i',
          kind: 'folder',
          folder: { path: broad, level: 'read' }
        });
        const give = (body: unknown) =>
          request('/api/asks/[id]/folder', 'POST', { params: { id: String(ask.id) }, body });
        const status = async () =>
          (await L.pg<{ status: string }[]>`select status from asks where id = ${ask.id}`)[0]
            .status;
        const change = { path: broad, level: 'read' };
        // Only `true` is an Accept: the route must not take any other value for one.
        for (const asked of [change, { ...change, accept: false }, { ...change, accept: 'yes' }]) {
          const said = await give(asked);
          assert.equal(said.status, 200);
          assert.deepEqual(await said.json(), { warning: L.FOLDER_WARNING });
          assert.deepEqual((await L.staffer('wes'))?.folders, []);
          assert.equal(await status(), 'open');
        }
        const accepted = await give({ ...change, accept: true });
        assert.deepEqual(await accepted.json(), {
          ok: true,
          given: { path: broad, level: 'read' }
        });
        assert.deepEqual((await L.staffer('wes'))?.folders, [{ path: broad, write: false }]);
        assert.equal(await status(), 'approved');
      } finally {
        rmSync(broad, { recursive: true, force: true });
      }
    });
  }
);

test("with Run commands, Bash can write only the run's write folders", onMac, async () => {
  const madeData = !existsSync(ownerData);
  mkdirSync(ownerData, { recursive: true });
  try {
    const p = made('bash', 'p');
    const sub = made('bash', 'p', 'sub');
    await setOwn('otto', {
      commands: true,
      folders: [
        { path: p, write: false },
        { path: sub, write: true }
      ]
    });
    const dir = staffDir('otto');

    const h = await gave('lead', 'otto', { title: 'Sort the shelf' });
    const onThread = await runOf(h.id);
    const thread = L.threadFolder(h.thread);
    const part = join(thread, 'otto');
    // The run's temp folder last, where npm keeps its cache.
    assert.deepEqual(each(onThread.args, '--add-dir'), [ownerData, part, sub, onThread.tmpdir]);
    const denyWrite = settingsOf(onThread).sandbox?.filesystem.denyWrite ?? [];
    assert.deepEqual(denyWrite, [
      ownerData,
      ...deniedEdits({ dir, writes: [dir, part, sub], granted: [sub] })
    ]);
    for (const open of [thread, p, '/private/tmp'])
      assert.ok(!denyWrite.includes(open), `${open} is denied a write, which beats every allow`);

    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'plan.md'), 'The owner wrote this.');
    assert.ok(
      await L.learnFromEdit('otto', { path: 'notes/plan.md', before: 'Otto wrote this.' }, 'x')
    );
    const [f] = await L.pg<{ id: number }[]>`
      select id from follow_ups where staff_id = 'otto' and kind = 'edited' and outcome is null`;
    const edited = await runOf(f.id);
    assert.ok(
      settingsOf(edited).sandbox?.filesystem.denyWrite.includes(join(dir, 'notes', 'plan.md')),
      'the edited file is writable by Bash'
    );
  } finally {
    if (madeData) rmSync(ownerData, { recursive: true, force: true });
  }
});

test('a folder given by ~ or through a link is stored by its real path and recorded as the owner reads it', async () => {
  await setOwn('wes', {});
  await ownerHome(async (home) => {
    mkdirSync(join(home, 'garden'));
    symlinkSync(join(home, 'garden'), join(home, 'shortcut'));
    const real = realpathSync(join(home, 'garden'));
    assert.equal((await patch('wes', { folder: '~/garden', access: 'read' })).status, 200);
    assert.deepEqual((await L.staffer('wes'))?.folders, [{ path: real, write: false }]);
    assert.ok(await recorded('Let Wes read ~/garden'));
    assert.equal((await patch('wes', { folder: '~/shortcut', access: 'write' })).status, 200);
    assert.deepEqual((await L.staffer('wes'))?.folders, [{ path: real, write: true }]);
    assert.ok(await recorded('Let Wes read and change ~/garden'));
  });
});

test('a folder to read inside one to change is refused either way round; a level change and a removal are not', async () => {
  await setOwn('wes', {});
  await ownerHome(async (home) => {
    for (const p of ['shed/tools', 'barn/loft']) mkdirSync(join(home, p), { recursive: true });
    const real = (p: string) => realpathSync(join(home, p));
    const refused = { status: 400, message: L.FOLDER_REFUSED.readInsideChange };
    assert.equal((await patch('wes', { folder: '~/shed', access: 'write' })).status, 200);
    assert.deepEqual(
      await refusal(patch('wes', { folder: '~/shed/tools', access: 'read' })),
      refused
    );
    assert.equal((await patch('wes', { folder: '~/barn/loft', access: 'read' })).status, 200);
    assert.deepEqual(await refusal(patch('wes', { folder: '~/barn', access: 'write' })), refused);
    // The same folder at another level replaces it.
    assert.equal((await patch('wes', { folder: '~/shed', access: 'read' })).status, 200);
    assert.deepEqual((await L.staffer('wes'))?.folders, [
      { path: real('barn/loft'), write: false },
      { path: real('shed'), write: false }
    ]);
    // Folders that nest from before are each still taken back.
    await setOwn('wes', {
      folders: [
        { path: real('shed'), write: true },
        { path: real('shed/tools'), write: false }
      ]
    });
    assert.equal((await patch('wes', { folder: real('shed/tools'), access: null })).status, 200);
    assert.deepEqual((await L.staffer('wes'))?.folders, [{ path: real('shed'), write: true }]);
  });
});

test('on the Settings tab a folder to change goes inside one to read in either order, each added at read first', async () => {
  await setOwn('wes', {});
  await ownerHome(async (home) => {
    for (const p of ['shed/tools', 'barn/loft']) mkdirSync(join(home, p), { recursive: true });
    const real = (p: string) => realpathSync(join(home, p));
    const refused = { status: 400, message: L.FOLDER_REFUSED.readInsideChange };
    // Outer first: the tab adds the inner one at read, then it is switched to write.
    assert.equal((await patch('wes', { folder: '~/shed', access: 'read' })).status, 200);
    assert.equal((await patch('wes', { folder: '~/shed/tools', access: 'read' })).status, 200);
    assert.equal((await patch('wes', { folder: '~/shed/tools', access: 'write' })).status, 200);
    // Inner first.
    assert.equal((await patch('wes', { folder: '~/barn/loft', access: 'read' })).status, 200);
    assert.equal((await patch('wes', { folder: '~/barn/loft', access: 'write' })).status, 200);
    assert.equal((await patch('wes', { folder: '~/barn', access: 'read' })).status, 200);
    assert.deepEqual((await L.staffer('wes'))?.folders, [
      { path: real('shed'), write: false },
      { path: real('shed/tools'), write: true },
      { path: real('barn/loft'), write: true },
      { path: real('barn'), write: false }
    ]);
    assert.ok(await recorded('Let Wes read and change ~/shed/tools'));
    // Switching the inner one back to read inside an outer one to change is refused.
    assert.equal((await patch('wes', { folder: '~/shed', access: 'write' })).status, 200);
    assert.deepEqual(
      await refusal(patch('wes', { folder: '~/shed/tools', access: 'read' })),
      refused
    );
    assert.equal((await L.staffer('wes'))?.folders.length, 4);
  });
});

test(
  'on a Mac, a folder stored in another case is the same folder',
  { skip: process.platform !== 'darwin' && "only a Mac's disk ignores case" },
  async () => {
    await ownerHome(async (home) => {
      mkdirSync(join(home, 'Orchard'));
      const real = realpathSync(join(home, 'Orchard'));
      // As a path typed in another case was stored before the real path was the disk's own.
      await setOwn('wes', { folders: [{ path: join(dirname(real), 'orchard'), write: false }] });
      assert.equal((await patch('wes', { folder: '~/Orchard', access: 'write' })).status, 200);
      assert.deepEqual((await L.staffer('wes'))?.folders, [{ path: real, write: true }]);
    });
  }
);

/** A repository's hooks, config and submodules in `w`, at the top and in any repository further in (`REPO_RUNS`). */
const repoRuns = (w: string) =>
  ['.git/hooks', '.git/config', '.git/modules'].flatMap((p) => [`${w}/${p}`, `${w}/**/${p}`]);
/** What each tool but Codex is denied a write to, of `paths`, in one chat of each Odd. */
async function deniedWrites(
  paths: string[]
): Promise<Record<'claude' | 'grok' | 'gemini', string[]>> {
  const claude = (await chatOf('fern')).claudeSettings!.permissions.deny;
  const grok = each((await chatOf('gwen')).args, '--deny');
  const policy = (await chatOf('gem')).policy ?? '';
  return {
    claude: paths.filter((p) =>
      [p, `${p}/**`].every((q) => claude.includes(`Edit(${L.rulePath(q)})`))
    ),
    grok: paths.filter((p) =>
      [p, `${p}/**`].every((q) => ['Edit', 'Write'].every((t) => grok.includes(`${t}(${q})`)))
    ),
    // Gemini's write policy matches a file's path, so a file in each place stands for the place.
    gemini: paths.filter((p) => writeRule(policy, 'deny', p.replace('/**/', '/sub/') + '/x'))
  };
}

test("a given write folder's git hooks, config and submodules are read and never written, on every tool", async () => {
  const w = made('repo');
  for (const id of ['fern', 'gwen', 'cato', 'gem'])
    await setOwn(id, { folders: [{ path: w, write: true }] });
  const paths = repoRuns(w);
  assert.deepEqual(await deniedWrites(paths), { claude: paths, grok: paths, gemini: paths });

  const claude = (await chatOf('fern')).claudeSettings!.permissions.deny;
  assert.ok(!claude.some((d) => d.startsWith('Read(') && d.includes('.git')), 'git cannot read');
  assert.ok(!((await chatOf('gwen')).profile ?? '').includes('.git/'), 'the kernel shuts git out');
  // Codex keeps each write folder's own .git read only itself, and refuses a glob it reads.
  const codex = (await chatOf('cato')).permissions?.filesystem ?? {};
  assert.deepEqual(
    Object.keys(codex).filter((p) => p.includes('.git')),
    []
  );
  assert.ok(writeRule((await chatOf('gem')).policy ?? '', 'allow', join(w, 'notes.md')));
});

test("only a folder the owner gave an Odd to change refuses git's hooks and config; its own folder keeps its instruction files shut", async () => {
  const dirs = { fern: staffDir('fern'), gwen: staffDir('gwen'), gem: staffDir('gem') };
  for (const id of ['fern', 'gwen', 'gem']) await setOwn(id, {});
  const none = { claude: [], grok: [], gemini: [] };
  const own = (id: keyof typeof dirs) => repoRuns(dirs[id]);
  // With no folder given, no tool refuses a repository's hooks or config anywhere.
  for (const id of ['fern', 'gwen', 'gem'] as const)
    assert.deepEqual(await deniedWrites(own(id)), none, `${id}'s own folder`);
  const policy = (await chatOf('gem')).policy ?? '';
  assert.ok(writeRule(policy, 'allow', join(dirs.gem, '.git', 'config')));
  assert.ok(!writeRule(policy, 'deny', join(dirs.gem, '.git', 'config')));

  const w = made('given-repo');
  for (const id of ['fern', 'gwen', 'gem'])
    await setOwn(id, { folders: [{ path: w, write: true }] });
  const paths = repoRuns(w);
  assert.deepEqual(await deniedWrites(paths), { claude: paths, grok: paths, gemini: paths });
  for (const id of ['fern', 'gwen', 'gem'] as const)
    assert.deepEqual(await deniedWrites(own(id)), none, `${id}'s own folder`);

  // Its tools' instruction files stay shut in its own folder, on every tool.
  const claude = (await chatOf('fern')).claudeSettings!.permissions.deny;
  assert.ok(claude.includes(`Edit(${L.rulePath(join(dirs.fern, 'CLAUDE.md'))})`));
  const grok = each((await chatOf('gwen')).args, '--deny');
  assert.ok(grok.includes(`Write(${join(dirs.gwen, '**', 'AGENTS.md')})`), grok.join(' '));
  const codex = (await chatOf('cato')).permissions?.filesystem ?? {};
  assert.equal(codex[join(staffDir('cato'), 'AGENTS.md')], 'deny');
  assert.ok(writeRule((await chatOf('gem')).policy ?? '', 'deny', join(dirs.gem, 'GEMINI.md')));
});

test(
  "with Run commands, Bash cannot write a given write folder's git hooks, config or submodules",
  onMac,
  async () => {
    const w = made('bash-repo');
    await setOwn('otto', { commands: true, folders: [{ path: w, write: true }] });
    const denyWrite = settingsOf(await chatOf('otto')).sandbox?.filesystem.denyWrite ?? [];
    for (const p of repoRuns(w)) assert.ok(denyWrite.includes(p), `Bash may write ${p}`);
    for (const p of repoRuns(staffDir('otto')))
      assert.ok(!denyWrite.includes(p), `Bash may not write its own folder's ${p}`);
  }
);
