// The loop every AI run goes through (drive.ts), in an office under test
// (office-under-test.ts) with its stand-in tools: how each tool's run ends,
// one row per way a run goes, and how a run and what it started stop. Run
// with `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Agent } from '@oddboro/ledger';
import type { LiveRun } from '@oddboro/ledger/run-registry';
import {
  EXIT_BEFORE_READING,
  L,
  bin,
  chat,
  folder,
  odd,
  onWindows,
  setOwn,
  withEnv,
  type Gave
} from './office-under-test.ts';

// After the office under test set its home, so each launch reads it.
const { drive, ownsGroup, processGone } = await import('./drive.ts');
const { LAUNCHES } = await import('./cli.ts');
const { claudeLaunch } = await import('./claude.ts');
const { stopGroups } = await import('./launch.ts');
const { runAsOffice } = await import('./office-run.ts');
const { run: runOdd } = await import('./staff.ts');
const { NETWORK_REFUSED_LINE } = await import('./sandbox.ts');
type RunEnd = import('./drive.ts').RunEnd;
type Sink = import('./drive.ts').Sink;
type Launch = import('./cli.ts').Launch;
type CliRun = import('./cli.ts').CliRun;
type Driven = Launch & { read: NonNullable<Launch['read']> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait up to `ms` for `done`, and say whether it came. */
async function until(done: () => boolean, ms = 2000): Promise<boolean> {
  for (const start = Date.now(); !done(); await sleep(20))
    if (Date.now() - start > ms) return false;
  return true;
}
/** `child`'s end: at once when it already ended. */
const closed = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((r) => child.once('close', () => r()));
/** Kill each pid still there, for a test's `finally`. */
function killLeft(pids: (number | undefined)[]): void {
  for (const pid of pids)
    if (pid && !processGone(pid))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // It went between the check and the kill.
      }
}
/** A run that never ends by itself, and records no tool of its own. */
const holding = (): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)']);

test('processGone says a running process is not gone', async () => {
  const child = spawn('sleep', ['60']);
  try {
    assert.equal(processGone(child.pid!), false);
  } finally {
    child.kill('SIGKILL');
    await closed(child);
  }
});

test('processGone says a process that exited and was reaped is gone', async () => {
  const child = spawn('true');
  await closed(child);
  assert.equal(processGone(child.pid!), true);
});

/** `fn`, with a stand-in `ps` first on PATH that prints `stat` for any process. */
function withPsSaying<T>(stat: string, fn: () => T): Promise<T> {
  const dir = mkdtempSync(join(folder, 'ps-'));
  writeFileSync(join(dir, 'ps'), `#!/bin/sh\necho ${stat}\n`);
  chmodSync(join(dir, 'ps'), 0o755);
  return withEnv({ PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` }, fn);
}

test('processGone says a process that exited but waits to be reaped is gone, though a signal still finds it', async () => {
  const child = spawn('sleep', ['60']);
  try {
    assert.equal(await withPsSaying('Z', () => processGone(child.pid!)), true);
  } finally {
    child.kill('SIGKILL');
    await closed(child);
  }
});

test('processGone says a sleeping process that a signal finds is not gone', async () => {
  const child = spawn('sleep', ['60']);
  try {
    assert.equal(await withPsSaying('S', () => processGone(child.pid!)), false);
  } finally {
    child.kill('SIGKILL');
    await closed(child);
  }
});

test('a stop returns every pid it found under the run, the tool first, off Windows', async () => {
  const at = join(mkdtempSync(join(folder, 'tree-')), 'grandchild.pid');
  const tool = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(at)}, String(c.pid));
setInterval(() => {}, 1000);`
    ],
    { detached: true, stdio: 'ignore' }
  );
  let grandchild: number | undefined;
  try {
    assert.ok(await until(() => existsSync(at) && readFileSync(at, 'utf8') !== ''));
    grandchild = Number(readFileSync(at, 'utf8'));
    const found = stopGroups(tool.pid!);
    assert.equal(found[0], tool.pid);
    assert.ok(found.includes(grandchild), `the stop did not find ${grandchild} in ${found}`);
  } finally {
    killLeft([grandchild, tool.pid]);
  }
});

/**
 * `fn`, as on Windows, with SystemRoot at a folder whose System32\taskkill.exe
 * is a stand-in that logs its arguments, a line each, and stops nothing. The
 * office's tests do not run on Windows, so this checks the command a stop
 * chooses there, through the real `execFileSync`, not a real kill.
 */
async function withTaskkill<T>(fn: (log: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(folder, 'windows-'));
  const log = join(root, 'taskkill.log');
  mkdirSync(join(root, 'System32'));
  writeFileSync(
    join(root, 'System32', 'taskkill.exe'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`
  );
  chmodSync(join(root, 'System32', 'taskkill.exe'), 0o755);
  return onWindows(() => withEnv({ SystemRoot: root }, () => fn(log)));
}

test('a stop on Windows returns only the run, since taskkill walks the tree itself', async () => {
  const child = holding();
  try {
    assert.deepEqual(await withTaskkill(async () => stopGroups(child.pid!)), [child.pid]);
  } finally {
    child.kill('SIGKILL');
    await closed(child);
  }
});

test("a run stopped on Windows stops its tool's whole tree with taskkill", async () => {
  const launch: Driven = { args: [], env: {}, stdin: '', done: () => {}, read: () => [] };
  const stop = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const { end, log } = await withTaskkill(async (log) => {
      const going = drive(
        () => (child = holding()),
        launch,
        { event: () => {} },
        { deadline: Date.now() + 60_000, signal: stop.signal }
      );
      stop.abort();
      return { end: await going, log };
    });
    assert.deepEqual(end, { outcome: 'stopped', stderr: '' });
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      '/PID',
      String(child!.pid),
      '/T',
      '/F'
    ]);
  } finally {
    if (child) {
      child.kill('SIGKILL');
      await closed(child);
    }
  }
});

test('a process that outlives a stop is logged, by its pid', async (t) => {
  const at = join(mkdtempSync(join(folder, 'outlives-')), 'grandchild.pid');
  // The grandchild stays in the tool's group and shrugs off the stop's SIGTERM.
  const grandchild = `process.on('SIGTERM', () => {});
require('node:fs').writeFileSync(${JSON.stringify(at)}, String(process.pid));
setInterval(() => {}, 60000);`;
  const tool = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
setInterval(() => {}, 60000);`;
  const logged = t.mock.method(console, 'error', () => {});
  const launch: Driven = { args: [], env: {}, stdin: '', done: () => {}, read: () => [] };
  const stop = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined;
  let left: number | undefined;
  try {
    const going = drive(
      () => (child = spawn(process.execPath, ['-e', tool], { detached: true })),
      launch,
      { event: () => {} },
      { deadline: Date.now() + 60_000, signal: stop.signal }
    );
    assert.ok(await until(() => existsSync(at) && readFileSync(at, 'utf8') !== ''));
    left = Number(readFileSync(at, 'utf8'));
    stop.abort();
    assert.deepEqual(await going, { outcome: 'stopped', stderr: '' });
    assert.ok(await until(() => logged.mock.callCount() > 0, 3000), 'the driver logged nothing');
    const line = String(logged.mock.calls[0]?.arguments[0]);
    assert.match(line, new RegExp(`still running: (.*, )?${left}(,|$)`), line);
  } finally {
    killLeft([left, child?.pid]);
    if (child) await closed(child);
  }
});

// The table: each way a run goes, for each tool, through `drive` with the
// tool's own launch (`LAUNCHES`) and stand-in.
const TOOLS = L.AGENTS;

type Heard = Parameters<Sink['event']>[0];

/** What a row's run gave its check. */
type Ran = {
  tool: Agent;
  /** The run's folder, where the stand-in runs. */
  dir: string;
  /** The run's registry entry, whose `add` the driver sets while the run takes added words. */
  live: LiveRun;
  /** The deadline `drive` was given. */
  deadline: number;
  /** Whether `drive` called `start`. */
  started: boolean;
  child?: ChildProcessWithoutNullStreams;
  /** Every event the sink got, in order. */
  events: Heard[];
  /** How many events the sink had got when the run ended. */
  heardByEnd: number;
  /** When the run ended, in ms since the epoch. */
  endedAt: number;
  /** Whether `live.add` was set, right after `drive` was called or at any event. */
  tookWords: boolean;
  /** What `live.add` answered for words added once the reply began. */
  tookLate?: boolean;
  /** The command the stand-in started ("Start a command and wait."). */
  command?: number;
  /** Every exception nothing caught while the run went. */
  uncaught: unknown[];
};

type Row = {
  /** What the run does, as a sentence for the test's name. */
  does: string;
  tools: readonly Agent[];
  /** The message, whose last line carries the stand-in's marker, if any. `dir` is the run's folder. */
  message: string | ((dir: string) => string);
  /** Claude Code's chat launch, which keeps its input open for added words (`turn`). */
  streamed?: true;
  /** Variables the stand-in starts with besides the launch's. */
  env?: Record<string, string>;
  /** Written to the tool after the launch's own input. */
  more?: string;
  /** The deadline, in ms from when `drive` is called: a minute unless the row says. */
  deadlineIn?: number;
  /** Done to the run's registry entry before `drive` is called. */
  before?: (live: LiveRun) => void;
  /** Done while the run goes; the end is awaited after it. */
  during?: (ran: Ran) => Promise<void>;
  /** Done with each event as the sink gets it. */
  hear?: (e: Heard, ran: Ran) => void;
  check: (end: RunEnd, ran: Ran) => void | Promise<void>;
};

/** The reason each tool's stand-in gives for "Fail now.", as its reader reads it. */
const CLAUDE_FAILED_AS_TOLD: Extract<RunEnd, { outcome: 'failed' }>['why'] = {
  result: {
    subtype: 'error_during_execution',
    isError: true,
    text: undefined,
    errors: ['Failed as told.']
  }
};
const FAILED_AS_TOLD: Record<Agent, Extract<RunEnd, { outcome: 'failed' }>['why']> = {
  claude: CLAUDE_FAILED_AS_TOLD,
  // Grok streams in Claude Code's shape.
  grok: CLAUDE_FAILED_AS_TOLD,
  codex: { tool: 'Failed as told.' },
  gemini: { tool: 'Failed as told.' }
};

/** What the stand-in gave, from a reply that ends on its outcome line. */
function gaveOf(reply: string): Gave {
  const at = reply.indexOf('\nOutcome:');
  assert.ok(at > 0, reply);
  return JSON.parse(reply.slice(0, at)) as Gave;
}

/** Wait for the stand-in's command, check it runs, then stop the run with `reason`. */
const stopMidCommand = (reason?: 'left') => async (ran: Ran) => {
  const at = join(ran.dir, 'command.pid');
  assert.ok(
    await until(() => existsSync(at) && readFileSync(at, 'utf8') !== ''),
    'the stand-in started no command'
  );
  ran.command = Number(readFileSync(at, 'utf8'));
  assert.equal(processGone(ran.command), false, 'the command is not running before the stop');
  ran.live.stop.abort(reason);
};

/** The command the stand-in started is gone after the stop. */
async function commandGone(ran: Ran): Promise<void> {
  const { command } = ran;
  assert.ok(command, 'the stand-in started no command');
  assert.ok(await until(() => processGone(command)), `command ${command} outlived the stop`);
}

/** A live Grok chat's stream, which the Grok stand-in replays ("Replay <file>"). */
const GROK_CHAT = fileURLToPath(new URL('./fixtures/grok-chat-1.jsonl', import.meta.url));
/** What that stream sent: each `text_delta`'s text, in order, and its result's text. */
const RECORDED = (() => {
  const lines = readFileSync(GROK_CHAT, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map(
      (l) =>
        JSON.parse(l) as {
          type: string;
          result?: string;
          event?: { delta?: { type: string; text: string } };
        }
    );
  return {
    deltas: lines.flatMap((l) =>
      l.event?.delta?.type === 'text_delta' ? [l.event.delta.text] : []
    ),
    result: lines.find((l) => l.type === 'result')?.result
  };
})();

const ROWS: Row[] = [
  {
    does: "a run whose tool succeeds ends done with the tool's reply, and takes no added words",
    tools: TOOLS,
    message: 'Hello from the driver.',
    check: (end, ran) => {
      assert.equal(end.outcome, 'done', JSON.stringify(end));
      assert.ok(end.outcome === 'done');
      const gave = gaveOf((end.text ?? end.spoken).trim());
      assert.ok(gave.message.includes('Hello from the driver.'), gave.message);
      assert.equal(ran.tookWords, false);
      assert.equal(ran.live.add, undefined);
    }
  },
  {
    does: "a run whose tool fails ends failed with the tool's reason and its stderr",
    tools: TOOLS,
    message: 'Fail now.',
    check: (end, ran) => {
      assert.equal(end.outcome, 'failed', JSON.stringify(end));
      assert.ok(end.outcome === 'failed');
      assert.deepEqual(end.why, FAILED_AS_TOLD[ran.tool]);
      assert.ok(end.stderr.includes('The stand-in failed as told.'), end.stderr);
    }
  },
  {
    does: 'a run whose tool exits before reading its input ends failed with the exit, and throws nothing',
    tools: TOOLS,
    message: 'Hello.',
    env: { [EXIT_BEFORE_READING]: '1' },
    // More than a pipe holds, so the write meets the closed pipe.
    more: 'x'.repeat(1_000_000),
    check: (end) => {
      assert.equal(end.outcome, 'failed', JSON.stringify(end));
      assert.ok(end.outcome === 'failed');
      assert.deepEqual(end.why, { exit: 0 });
      // This stand-in says nothing on stderr, and the end carries exactly that.
      assert.equal(end.stderr, '');
    }
  },
  {
    does: 'a run still going at its deadline ends timeout at the deadline it was given',
    tools: TOOLS,
    message: (dir) => `Hold until ${join(dir, 'never')} exists.`,
    deadlineIn: 1000,
    check: (end, ran) => {
      assert.deepEqual(end, { outcome: 'timeout', stderr: '' });
      const late = ran.endedAt - ran.deadline;
      assert.ok(Math.abs(late) < 1000, `the run ended ${late} ms after its deadline`);
    }
  },
  {
    does: 'a run whose deadline already passed ends timeout without starting its tool',
    tools: TOOLS,
    message: 'Hello.',
    deadlineIn: -1,
    check: (end, ran) => {
      assert.deepEqual(end, { outcome: 'timeout', stderr: '' });
      assert.equal(ran.started, false);
    }
  },
  {
    does: 'a run stopped while its command runs ends stopped, and the command stops too',
    tools: TOOLS,
    message: 'Start a command and wait.',
    during: stopMidCommand(),
    check: async (end, ran) => {
      assert.equal(end.outcome, 'stopped', JSON.stringify(end));
      await commandGone(ran);
    }
  },
  {
    does: 'a run whose Odd leaves while its command runs ends left, and the command stops too',
    tools: TOOLS,
    message: 'Start a command and wait.',
    during: stopMidCommand('left'),
    check: async (end, ran) => {
      assert.equal(end.outcome, 'left', JSON.stringify(end));
      await commandGone(ran);
    }
  },
  {
    does: 'a run whose signal was already aborted ends stopped without starting its tool',
    tools: TOOLS,
    message: 'Hello.',
    before: (live) => live.stop.abort(),
    check: (end, ran) => {
      assert.deepEqual(end, { outcome: 'stopped', stderr: '' });
      assert.equal(ran.started, false);
    }
  },
  {
    does: "a run that streams text passes each piece on before the end, which keeps the result's text and the streamed words apart",
    tools: ['claude'],
    message: 'Think aloud: Some words.',
    check: (end, ran) => {
      assert.equal(end.outcome, 'done', JSON.stringify(end));
      assert.ok(end.outcome === 'done');
      const before = ran.events.slice(0, ran.heardByEnd).filter((e) => e.type === 'delta');
      assert.deepEqual(before, [{ type: 'delta', text: 'Some words' }]);
      assert.equal(end.spoken, 'Some words');
      assert.equal(gaveOf(end.text ?? '').message, 'Think aloud: Some words.');
    }
  },
  {
    does: "a run that streams its recorded text passes each piece on before the end, which keeps the result's text and the streamed words apart",
    tools: ['grok'],
    message: `Replay ${GROK_CHAT}`,
    check: (end, ran) => {
      assert.equal(end.outcome, 'done', JSON.stringify(end));
      assert.ok(end.outcome === 'done');
      const deltas = ran.events.flatMap((e) => (e.type === 'delta' ? [e.text] : []));
      const before = ran.events.slice(0, ran.heardByEnd).filter((e) => e.type === 'delta');
      assert.equal(before.length, deltas.length, 'a piece came after the end');
      // The reader adds a blank line where a new message starts.
      assert.deepEqual(
        deltas.filter((t) => t !== '\n\n'),
        RECORDED.deltas
      );
      assert.equal(end.spoken, deltas.join(''));
      assert.equal(end.spoken.length, 114);
      assert.equal(end.text, RECORDED.result);
      assert.equal(end.text?.length, 26);
    }
  },
  {
    does: 'words added while a chat replies reach that reply, and words added after it get a reply of their own',
    tools: ['claude'],
    streamed: true,
    message: (dir) => `Hold until ${join(dir, 'go')} exists.`,
    // The tool call comes once the reply began, so these words are too late for it.
    hear: (e, ran) => {
      if (e.type === 'tool') ran.tookLate = ran.live.add?.('late');
    },
    during: async (ran) => {
      assert.equal(ran.live.add?.('more'), true);
      writeFileSync(join(ran.dir, 'go'), '');
    },
    check: (end, ran) => {
      assert.equal(end.outcome, 'done', JSON.stringify(end));
      assert.ok(end.outcome === 'done');
      const text = end.text ?? '';
      assert.deepEqual(gaveOf(text).added, ['more']);
      assert.equal(ran.tookLate, true);
      assert.ok(text.endsWith('\n\nThen: late'), text.slice(-100));
      assert.equal(ran.live.add, undefined);
    }
  },
  {
    does: "after added words, the first failure is the run's end",
    tools: ['claude'],
    streamed: true,
    message: 'Fail and go on.',
    // Added once the reply began: the stand-in fails the first and answers the second.
    hear: (e, ran) => {
      if (e.type !== 'tool') return;
      ran.live.add?.('Fail now.');
      ran.tookLate = ran.live.add?.('late');
    },
    check: (end, ran) => {
      assert.equal(ran.tookLate, true);
      assert.equal(end.outcome, 'failed', JSON.stringify(end));
      assert.ok(end.outcome === 'failed');
      assert.deepEqual(end.why, {
        result: {
          subtype: 'error_during_execution',
          isError: true,
          text: undefined,
          errors: ['Failed first.']
        }
      });
    }
  },
  {
    does: 'a success result that says is_error ends failed with the result as Claude Code sent it',
    tools: ['claude'],
    message: 'Succeed with an error.',
    check: (end) => {
      assert.equal(end.outcome, 'failed', JSON.stringify(end));
      assert.ok(end.outcome === 'failed');
      assert.deepEqual(end.why, {
        result: { subtype: 'success', isError: true, text: 'It went wrong.', errors: [] }
      });
      // This stand-in says nothing on stderr, and the end carries exactly that.
      assert.equal(end.stderr, '');
    }
  },
  {
    does: 'a success result with no text ends done with no text and the streamed words',
    tools: ['claude'],
    message: 'Think aloud: Joined words.\nSucceed with no text.',
    check: (end) => {
      assert.equal(end.outcome, 'done', JSON.stringify(end));
      assert.ok(end.outcome === 'done');
      assert.equal(end.text, undefined);
      assert.equal(end.spoken, 'Joined words');
    }
  }
];

/** Start `tool`'s launch for the row's message through `drive`, then hand the end to the row's check. */
async function driveRow(tool: Agent, row: Row): Promise<void> {
  const dir = mkdtempSync(join(folder, 'drive-'));
  const run: CliRun = {
    key: randomUUID(),
    staffId: 'drive',
    dir,
    reads: [],
    writes: [dir],
    granted: [],
    web: false,
    commands: false,
    network: false,
    system: 'You are a stand-in.',
    input: typeof row.message === 'string' ? row.message : row.message(dir),
    // The stand-ins read the office's own server from what the launch wrote.
    servers: { office: { type: 'stdio', command: 'node', args: [], env: {} } },
    allowed: [],
    timeoutMs: 600_000,
    account: L.OFFICE_ACCOUNT
  };
  const launch = row.streamed
    ? claudeLaunch({ ...run, streamed: true })
    : await LAUNCHES[tool](run);
  assert.ok('args' in launch, JSON.stringify(launch));
  const { read } = launch;
  assert.ok(read, `${tool}'s launch has no reader`);
  const live = L.reserveRun({ staffId: 'drive', kind: 'chat' });
  row.before?.(live);
  const ran: Ran = {
    tool,
    dir,
    live,
    deadline: Date.now() + (row.deadlineIn ?? 60_000),
    started: false,
    events: [],
    heardByEnd: 0,
    endedAt: 0,
    tookWords: false,
    uncaught: []
  };
  const uncaught = (e: unknown) => ran.uncaught.push(e);
  process.on('uncaughtException', uncaught);
  try {
    const going = drive(
      () => {
        ran.started = true;
        ran.child = spawn(join(bin, tool), launch.args, {
          cwd: dir,
          env: { ...launch.env, ...row.env },
          detached: ownsGroup(launch),
          windowsHide: true
        });
        return ran.child;
      },
      { ...launch, read, stdin: launch.stdin + (row.more ?? '') },
      {
        event: (e) => {
          ran.tookWords ||= live.add !== undefined;
          ran.events.push(e);
          row.hear?.(e, ran);
        }
      },
      { deadline: ran.deadline, signal: live.stop.signal, live }
    ).then((end) => {
      ran.endedAt = Date.now();
      ran.heardByEnd = ran.events.length;
      return end;
    });
    ran.tookWords ||= live.add !== undefined;
    await row.during?.(ran);
    const end = await going;
    assert.deepEqual(ran.uncaught, []);
    await row.check(end, ran);
  } finally {
    process.off('uncaughtException', uncaught);
    L.releaseRun(live);
    killLeft([ran.command]);
    if (ran.child) {
      killLeft([ran.child.pid]);
      await closed(ran.child);
    }
  }
}

for (const row of ROWS)
  for (const tool of row.tools)
    test(`${row.does}, on ${L.AGENT_NAMES[tool]}`, () => driveRow(tool, row));

// How each caller words a run's end (`toolEnded` in staff.ts, `officeEnded` in
// office-run.ts), through the stand-ins.

/** The end of one chat message to Odd `id`: its reply, or its error. */
async function chatEnd(id: string, message: string): Promise<{ done?: string; error?: string }> {
  const end: { done?: string; error?: string } = {};
  await chat(id, message, (e) => {
    if (e.type === 'done') end.done = e.text;
    if (e.type === 'error') end.error = e.message;
  });
  return end;
}

/** One office run on Claude Code. */
const officeRun = (
  message: string,
  o: { system?: string; images?: { mediaType: string; data: string }[] } = {}
) =>
  withEnv({ OFFICE_AGENT: 'claude' }, () =>
    runAsOffice(message, {
      system: o.system ?? 'You answer.',
      kind: 'look',
      timeoutMs: 60_000,
      images: o.images
    })
  );

test("an office run whose Claude Code result says is_error replies with the result's text", async () => {
  assert.deepEqual(await officeRun('Succeed with an error.'), { ok: true, text: 'It went wrong.' });
});

test("an Odd's chat run whose Claude Code result says is_error ends on the result's text as an error", async () => {
  assert.deepEqual(await chatEnd('sam', 'Succeed with an error.'), { error: 'It went wrong.' });
});

test("an Odd's chat run whose result has no text replies with its streamed words, as today", async () => {
  assert.deepEqual(await chatEnd('cleo', 'Think aloud: Joined words.\nSucceed with no text.'), {
    done: 'Joined words'
  });
});

test('an office run whose result has no text replies with nothing, as today', async () => {
  assert.deepEqual(await officeRun('Think aloud: Joined words.\nSucceed with no text.'), {
    ok: true,
    text: ''
  });
});

await L.pg`insert into staff ${L.pg([odd('tess', 'Tess')])}`;

test("an Odd's Claude chat shows its streamed reply once", async () => {
  const shown: string[] = [];
  await chat('tess', 'Think aloud: Some words.\nSend it whole too.', (e) => {
    if (e.type === 'delta') shown.push(e.text);
  });
  assert.equal(shown.join(''), 'Some words');
});

/** The five-hour share the office's plan record holds, once it is `share` or after two seconds. */
async function planReaches(share: number): Promise<number | undefined> {
  for (const start = Date.now(); Date.now() - start < 2000; await sleep(20))
    if ((await L.plan())?.fiveHour === share) break;
  return (await L.plan())?.fiveHour;
}

test("a Claude Code run's plan limit reaches the office's plan record", async () => {
  // Low shares, which hold back no hand-off in the tests after this one.
  assert.equal((await chatEnd('sam', 'Plan used: 0.11')).error, undefined);
  assert.equal(await planReaches(0.11), 0.11);
  assert.equal((await officeRun('Plan used: 0.12')).ok, true);
  assert.equal(await planReaches(0.12), 0.12);
});

test('an office run whose tool exits with an error says so with its exit code and stderr, as today', async () => {
  assert.deepEqual(await officeRun('Exit with an error.'), {
    ok: false,
    text: 'Claude Code stopped (exit 3). The stand-in exited as told.'
  });
});

test('an office run on Claude with a picture writes nothing to disk, and its tool gets the picture', async () => {
  const picture = { mediaType: 'image/png', data: Buffer.from('a picture').toString('base64') };
  const runs = join(folder, 'office', 'runs');
  const go = join(folder, `picture-go-${randomUUID()}`);
  // On the stand-in's command line, so the test can tell once it runs.
  const mark = randomUUID();
  const going = officeRun(`Look.\nHold until ${go} exists.`, {
    system: `You look, as run ${mark}.`,
    images: [picture]
  });
  try {
    const running = () => {
      try {
        execFileSync('pgrep', ['-f', mark]);
        return true;
      } catch {
        return false;
      }
    };
    // The run's workspace is ready before its tool starts.
    assert.ok(await until(running, 10_000), 'the stand-in never started');
    assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], []);
  } finally {
    writeFileSync(go, '');
  }
  const r = await going;
  assert.equal(r.ok, true, r.text);
  // A turn with a picture comes back whole from the stand-in.
  const turn = JSON.parse(gaveOf(r.text).message) as { message: { content: unknown[] } };
  assert.deepEqual(turn.message.content[0], {
    type: 'image',
    source: { type: 'base64', media_type: picture.mediaType, data: picture.data }
  });
  assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], []);
});

test("an Odd's run whose tool started, then hit its time limit, says so once, and never logs that its tool never started", async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'error', (...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  });
  const events: { type: string; message?: string }[] = [];
  try {
    const r = await runOdd(
      (await L.staffer('lead'))!,
      `Hold until ${join(folder, 'never-released')} exists.`,
      { kind: 'chat', timeoutMs: 3_000, onEvent: (e) => void events.push(e) }
    );
    assert.equal(r.ok, false);
    assert.match(r.text, /^No reply after /);
    assert.deepEqual(
      events.filter((e) => e.type === 'error'),
      [{ type: 'error', message: r.text }]
    );
    assert.deepEqual(
      logged.filter((l) => l.includes('never started')),
      []
    );
  } finally {
    log.mock.restore();
  }
});

test(
  'a timed-out Claude run whose tool said the network was refused gives the refusal line, and holds the network',
  { skip: process.platform !== 'darwin' && 'Run commands runs on a Mac only' },
  async () => {
    await setOwn('paige', { commands: true, web: true });
    const events: { type: string; message?: string }[] = [];
    try {
      const r = await runOdd((await L.staffer('paige'))!, 'Refuse the open network and wait.', {
        kind: 'chat',
        timeoutMs: 3_000,
        onEvent: (e) => void events.push(e)
      });
      const line = NETWORK_REFUSED_LINE.unsent.replaceAll('{name}', 'Paige');
      assert.equal(r.ok, false);
      assert.equal(r.text, line);
      assert.deepEqual(
        events.filter((e) => e.type === 'error'),
        [{ type: 'error', message: line }]
      );
      assert.equal(L.networkHeld(), true);
    } finally {
      L.resetHeldNetwork();
      await setOwn('paige', {});
    }
  }
);

await L.pg`insert into staff ${L.pg([{ ...odd('cody', 'Cody'), agent: 'codex' }])}`;

test("an Odd's Codex chat run replies with its last message, as today", async () => {
  const end = await chatEnd('cody', 'Hello.');
  // The stand-in says "Looking." first, then what it was given.
  assert.equal(end.error, undefined, end.error);
  assert.ok(end.done && !end.done.includes('Looking.'), end.done);
  assert.ok(gaveOf(end.done).message.includes('Hello.'));
});
