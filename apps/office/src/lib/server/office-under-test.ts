// An office under test, for the tests of a run as the office starts it
// (`followThrough`, `chat`): the office's own database (local-db.ts) in a
// throwaway folder (on Windows, on a free port), stand-ins for `claude`, `grok`, `codex`, `gemini`,
// `xcode-select`, `security` and the installers `npm` and `bash` first on PATH, a stand-in secret store, a few
// Odds, and the helpers that start a run and read back what its stand-in was given. Each stand-in sends back what the run gave it,
// its arguments, the tool server's environment and the run's instructions,
// and ends done. A test file imports this before anything of the office's, so
// the office reads this folder as it loads.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { after, mock } from 'node:test';
import { onPath } from './on-path.ts';

export const folder = mkdtempSync(join(tmpdir(), 'oddboro-staff-run-'));
/** The owner's data folder in the office's home, which every Odd reads. */
export const ownerData = join(folder, 'data');
/**
 * The test database's port, which only Windows uses: on a Mac and Linux the
 * database listens on a socket in the office home (db.ts). A port the system
 * picks (listen on 0) comes from the range it also gives outgoing
 * connections, and the database listens only later: in between, another test
 * file's database or any connection could take it, and the database's listen
 * then kills this process (EADDRINUSE). So: below every system's range for
 * those (Linux 32768, the Mac and Windows 49152), by process id, which no two
 * test files running at once share, and the next one up if something already
 * listens there.
 */
async function databasePort(): Promise<number> {
  for (let port = 20_000 + (process.pid % 12_000); ; port = port >= 31_999 ? 20_000 : port + 1) {
    const free = await new Promise<boolean>((done) => {
      const s = createServer()
        .once('error', () => done(false))
        .listen(port, '127.0.0.1', () => s.close(() => done(true)));
    });
    if (free) return port;
  }
}
const port = await databasePort();
// The stand-in for Claude Code: it reads the message, then reports one tool
// call and a result that carries what the office gave the run, the variables
// Run commands sets among it, and whether the git template folder those name
// was there and empty as it ran (`done()` removes it after), and npm's
// settings. It takes the markers every stand-in takes (`SHARED`, below). A
// message whose last line says "Refuse the open
// network", in a run whose sandbox opens every host, gets the words Claude
// Code's binary refuses that with, on stderr, and exit 1, after any hold;
// "Refuse the open network and wait." says the same words, then never ends.
// Only the last line, since a later prompt can quote an earlier message.
// "Succeed with an error." ends on a success result that says is_error, and
// "Succeed with no text." on a success result with no text.
// One that says "Think aloud: <words>." on any line streams <words> as
// text first. A run with --input-format stream-json starts on its first user
// line, as Claude Code does, and keeps each user line after it, text only, in
// "added" (Send now), answering all of them in its one result. Each user line
// after that result gets a result of its own, "Then: <words>", as the office
// closes its stdin, as Claude Code answers words that came too late for its
// turn; it ends then.
// "claude auth status" says signed out at once, "claude auth logout" ends at
// once, and "claude auth login" prints its sign-in page and waits until it is
// stopped, as Setup's sign-in waits on the owner.
export const bin = join(folder, 'bin');
mkdirSync(bin);
/**
 * Node alone, for the stand-ins, never node's own bin folder: a tool the
 * owner installed with npm (a real grok or codex) lives there, and a test
 * that found it would start it for real, a sign-in page in their browser.
 */
export const nodeBin = join(folder, 'node-bin');
mkdirSync(nodeBin);
symlinkSync(process.execPath, join(nodeBin, 'node'));
/**
 * With this variable set, a stand-in exits 0 before it reads its input, as a
 * tool that fails as it starts does. A variable, not words in the message: the
 * Claude, Codex and Gemini stand-ins get the message on stdin, so they could
 * not see a marker there without reading it.
 */
export const EXIT_BEFORE_READING = 'ODDBORO_STAND_IN_EXIT_BEFORE_READING';
// What every stand-in does the same way, after its version and sign-in
// commands. A message whose last line says "Hold until <file> exists." keeps
// the run going until it does. Then "Fail now." says
// "The stand-in failed as told." on stderr, sends the tool's own failed result
// and exits 1, and "Start a command and wait." starts a node process in a
// group of its own, writes its pid to command.pid in the run's folder, and
// never ends. The command needs its own group: in the tool's, the stop on the
// run's end would reach it through that group alone, so a test of the stop
// that walks the tree would pass with no walk.
const SHARED = `if (process.env[${JSON.stringify(EXIT_BEFORE_READING)}]) process.exit(0);
const lastOf = (text) => text.trimEnd().split('\\n').at(-1);
function holdThen(last, go) {
  const hold = /Hold until (\\/[^\\s"\\\\]+) exists/.exec(last)?.[1];
  if (!hold) return go();
  const wait = setInterval(() => fs.existsSync(hold) && (clearInterval(wait), go()), 20);
}
function failNow(result) {
  process.stderr.write('The stand-in failed as told.\\n', () =>
    process.stdout.write(JSON.stringify(result) + '\\n', () => process.exit(1))
  );
}
function startCommand() {
  const command = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync('command.pid', String(command.pid));
  setInterval(() => {}, 60_000);
}`;
writeFileSync(
  join(bin, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
// "--version" prints versions/claude in the test office, else the oldest the office runs.
if (process.argv[2] === '--version') {
  const v = ${JSON.stringify(join(folder, 'versions', 'claude'))};
  process.stdout.write('' + (fs.existsSync(v) ? fs.readFileSync(v, 'utf8').trim() : '2.1.318') + '\\n');
  process.exit(0);
}
const [verb, sub] = process.argv.slice(2);
if (verb === 'auth' && sub === 'status') {
  // Signed in only in an account's folder holding a "signed-in" file, which names the email.
  const mark = (process.env.CLAUDE_CONFIG_DIR ?? '/nowhere') + '/signed-in';
  process.stdout.write(
    fs.existsSync(mark)
      ? JSON.stringify({ loggedIn: true, email: fs.readFileSync(mark, 'utf8').trim() }) + '\\n'
      : '{"loggedIn":false}\\n'
  );
  process.exit(0);
}
if (verb === 'auth' && sub === 'logout') process.exit(0);
if (verb === 'auth' && sub === 'login') {
  process.stdout.write('Opening https://claude.ai/oauth/authorize?test\\n');
  setInterval(() => {}, 60_000);
  return;
}
${SHARED}
let message = '';
/** What each stream-json user line after the first said, before the result. */
const added = [];
/** What each user line after the result said. */
const late = [];
let answered = false;
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
/** The owner's words in a chat, or a job's instructions, which come last. */
const lastLine = () => message.trimEnd().split('\\n').at(-1);
const streamed = process.argv.includes('--input-format');
let lines = '';
let started = false;
const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
process.stdin.on('data', (d) => {
  if (!streamed) return void (message += d);
  lines += d;
  let nl;
  while ((nl = lines.indexOf('\\n')) >= 0) {
    const line = lines.slice(0, nl);
    lines = lines.slice(nl + 1);
    if (!line.trim()) continue;
    const content = JSON.parse(line).message.content;
    if (started) {
      (answered ? late : added).push(textOf(content));
      continue;
    }
    // A turn with a picture comes back whole, for a test to read its blocks.
    message = content.some((b) => b.type !== 'text') ? line : textOf(content);
    started = true;
    start();
  }
});
process.stdin.on('end', () => {
  if (!streamed) return start();
  // Late words that say "Fail now." get a failed result; any others get a reply of their own.
  for (const words of late)
    line(
      words === 'Fail now.'
        ? { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Failed late.'] }
        : { type: 'result', subtype: 'success', result: 'Then: ' + words }
    );
});
function start() {
  holdThen(lastLine(), answer);
}
/** After any hold, so two runs can be refused at once. */
function answer() {
  if (lastLine().includes('Fail now.'))
    return failNow({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Failed as told.'] });
  if (lastLine().includes('Start a command and wait.')) return startCommand();
  // Ends with an error and no result, as a tool that crashed does.
  if (lastLine().includes('Exit with an error.'))
    return process.stderr.write('The stand-in exited as told.\\n', () => process.exit(3));
  // Only a staff run carries --settings, so it is read only for the trigger.
  if (
    lastLine().includes('Refuse the open network') &&
    settings().sandbox?.network?.allowedDomains?.includes('*')
  ) {
    process.stderr.write('Overly broad patterns like "*" are not allowed\\n');
    if (lastLine().includes('and wait.')) return void setInterval(() => {}, 60_000);
    process.exit(1);
  }
  reply();
}
/** A staff run's settings, from the file --settings names; the office's own runs pass them inline. */
function settings() {
  const v = process.argv[process.argv.indexOf('--settings') + 1];
  return JSON.parse(v.startsWith('{') ? v : fs.readFileSync(v, 'utf8'));
}
function emptyFolder(p) {
  try {
    return fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}
function reply() {
  answered = true;
  const args = process.argv.slice(2);
  const after = (flag) => args[args.indexOf(flag) + 1];
  // A staff run passes the servers as a file, read here while the run goes; the office's own runs pass them inline.
  const config = after('--mcp-config');
  const mcp = JSON.parse(config.startsWith('{') ? config : fs.readFileSync(config, 'utf8'));
  const gave = {
    args,
    envNames: Object.keys(process.env).sort(),
    mcp,
    env: mcp.mcpServers.office?.env,
    // A staff run's settings and system prompt come in files, read here while the run goes; the office's own runs pass both inline.
    claudeSettings: settings(),
    system: args.includes('--append-system-prompt-file')
      ? fs.readFileSync(after('--append-system-prompt-file'), 'utf8')
      : after('--append-system-prompt'),
    message,
    added,
    claudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
    autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
    tmpdir: process.env.CLAUDE_CODE_TMPDIR ?? null,
    git: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GIT_'))),
    gitTemplate: emptyFolder(process.env.GIT_TEMPLATE_DIR),
    npm: {
      npm_config_cache: process.env.npm_config_cache ?? null,
      npm_config_userconfig: process.env.npm_config_userconfig ?? null
    },
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null
  };
  line({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'look' } } });
  const aloud = /Think aloud: ([^.]+)\./.exec(message)?.[1];
  if (aloud) line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: aloud } } });
  // Claude Code sends each text block whole as well, after its streamed pieces.
  if (aloud && lastLine().includes('Send it whole too.'))
    line({ type: 'assistant', message: { content: [{ type: 'text', text: aloud }] } });
  // "Plan used: 0.25" reports that share of the five-hour window, as Claude Code's rate_limit_event does.
  const used = /Plan used: (0\\.\\d+)/.exec(lastLine())?.[1];
  if (used) line({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: Number(used) } } } });
  // A failed result that keeps the run going, so words added after it get their own results.
  if (lastLine().includes('Fail and go on.'))
    return line({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Failed first.'] });
  if (lastLine().includes('Succeed with an error.'))
    return line({ type: 'result', subtype: 'success', is_error: true, result: 'It went wrong.' });
  if (lastLine().includes('Succeed with no text.')) return line({ type: 'result', subtype: 'success' });
  line({ type: 'result', subtype: 'success', result: JSON.stringify(gave) + '\\nOutcome: done' });
}
`
);
chmodSync(join(bin, 'claude'), 0o755);
// The stand-in for Grok, which reads no input: it sends back its arguments, the
// Grok, git and key variables it got, its agent file's MCP servers and the tool
// server's environment from them, and its sandbox profile when it has one (none
// on Windows). Then one MCP call the way Grok streams it
// (through use_tool), and a result. A message that ends "Replay <file>"
// gets that recorded stream instead (only at the end, since a later prompt
// can quote an earlier message that failed), and its arguments go in replay-args.json.
// "grok models", which renews the sign-in, adds a dot to models.log in the
// Grok home, and puts renewed.json there as the sign-in when there is one.
// With hang.pid in the Grok home, it writes its pid there and never ends,
// whatever SIGTERM says. Its arguments go in models-args.json.
// "grok login" logs its arguments and home in logins.jsonl and its pid in
// login.pid, prints its sign-in page, and waits for login.go in its home:
// then it keeps a sign-in for owner@example.com and ends. "grok logout"
// adds a dot to logouts.log. Its message, from a plain-text prompt file
// (`--prompt-file`), takes the markers every stand-in takes (`SHARED`), with
// Claude Code's failed result.
writeFileSync(
  join(bin, 'grok'),
  `#!/usr/bin/env node
const fs = require('node:fs');
// "--version" prints versions/grok in the test office, else the oldest the office runs.
if (process.argv[2] === '--version') {
  const v = ${JSON.stringify(join(folder, 'versions', 'grok'))};
  process.stdout.write('grok ' + (fs.existsSync(v) ? fs.readFileSync(v, 'utf8').trim() : '1.0.77') + '\\n');
  process.exit(0);
}
const args = process.argv.slice(2);
const home = process.env.GROK_HOME;
if (args[0] === 'login') {
  fs.appendFileSync(home + '/logins.jsonl', JSON.stringify({ args, home }) + '\\n');
  fs.writeFileSync(home + '/login.pid', String(process.pid));
  process.stdout.write('Open this URL to sign in: https://auth.x.ai/oauth2/authorize?client_id=test&redirect_uri=http://127.0.0.1:5000/callback\\n');
  setInterval(() => {
    if (!fs.existsSync(home + '/login.go')) return;
    fs.rmSync(home + '/login.go');
    const expires_at = new Date(Date.now() + 86_400_000).toISOString();
    fs.writeFileSync(home + '/auth.json', JSON.stringify({ 'https://auth.x.ai::test': { email: 'owner@example.com', expires_at } }));
    process.stdout.write('Signed in as owner@example.com\\n');
    process.exit(0);
  }, 20);
  return;
}
if (args[0] === 'logout') {
  fs.appendFileSync(home + '/logouts.log', '.');
  process.exit(0);
}
if (args[0] === 'models') {
  fs.writeFileSync(home + '/models-args.json', JSON.stringify(args));
  fs.appendFileSync(process.env.GROK_HOME + '/models.log', '.');
  const hang = process.env.GROK_HOME + '/hang.pid';
  if (fs.existsSync(hang)) {
    fs.writeFileSync(hang, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 60_000);
    return;
  }
  const renewed = process.env.GROK_HOME + '/renewed.json';
  if (fs.existsSync(renewed)) fs.copyFileSync(renewed, process.env.GROK_HOME + '/auth.json');
  process.exit(0);
}
// As grok 1.0.46 refuses a value that starts with "- " after its flag (measured).
if (args.some((a) => a.startsWith('- '))) {
  process.stderr.write("error: unexpected argument '- ' found");
  process.exit(2);
}
${SHARED}
const after = (flag) => args[args.indexOf(flag) + 1];
// The message comes in the file --prompt-file names: plain text, or content blocks in a .json file.
const promptPath = after('--prompt-file');
const promptText = fs.readFileSync(promptPath, 'utf8');
const blocks = promptPath.endsWith('.json') ? JSON.parse(promptText) : undefined;
// A message with pictures carries no marker.
const text = blocks ? '' : promptText;
const replay = /Replay (\\/[^\\r\\n]+\\.jsonl)\\s*$/.exec(text)?.[1];
if (replay) {
  fs.writeFileSync(process.env.GROK_HOME + '/replay-args.json', JSON.stringify(args));
  process.stdout.write(fs.readFileSync(replay, 'utf8'));
  process.exit(0);
}
holdThen(lastOf(text), answer);
function answer() {
  const last = lastOf(text);
  if (last.includes('Fail now.'))
    return failNow({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Failed as told.'] });
  if (last.includes('Start a command and wait.')) return startCommand();
  const agent = fs.readFileSync(after('--agent'), 'utf8');
  const profile = args.includes('--sandbox')
    ? fs
        .readFileSync(process.env.GROK_HOME + '/sandbox.toml', 'utf8')
        .split(/^(?=\\[profiles\\.)/m)
        .find((b) => b.startsWith('[profiles.' + after('--sandbox') + ']'))
    : undefined;
  const servers = Object.assign({}, ...JSON.parse(/^mcpServers: (.*)$/m.exec(agent)[1]));
  const gave = {
    args,
    envNames: Object.keys(process.env).sort(),
    grokEnv: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => /^(GROK_|XAI_|ANTHROPIC_API_KEY|TMPDIR|NODE_OPTIONS|GIT_)/.test(k))
    ),
    env: servers.office?.env,
    servers,
    home: process.env.HOME,
    agentMode: fs.statSync(after('--agent')).mode & 0o777,
    profile,
    // The system prompt is the agent file's body, after its frontmatter.
    system: agent.replace(/^---\\n[\\s\\S]*?\\n---\\n/, '').replace(/\\n$/, ''),
    promptMode: /^prompt_mode: (.*)$/m.exec(agent)?.[1],
    promptFileMode: fs.statSync(promptPath).mode & 0o777,
    message: blocks ? undefined : promptText,
    prompt: blocks
  };
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  line({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'use_tool' } } });
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'use_tool', input: { tool_name: 'office__raise_ask', tool_input: {} } }] } });
  line({ type: 'result', subtype: 'success', result: JSON.stringify(gave) + '\\nOutcome: done' });
}
`
);
chmodSync(join(bin, 'grok'), 0o755);
// The stand-in for Codex, which reads the message on stdin: it sends back its
// arguments, the Codex, git and key variables it got, what its `-c` values set
// (the MCP servers, the permission profile, the instructions, its shell's git
// environment), and whether the git template folder that names was there and
// empty as it ran (`done()` removes it after), in the item
// shapes `codex exec --json` prints (exec_events.rs): a shell command, an MCP
// call, a file change, two messages and the turn's tokens. A message that
// ends "Replay <file>" gets that recorded stream instead, and one that says
// "Leave a sleeper at <file>" first starts a `sleep` that outlives it, in its
// process group, and writes its pid there. Every launch's arguments go in
// launches.jsonl, a line each. "codex login" is no launch: it logs its
// arguments, home and whether config.toml was there in logins.jsonl and its
// pid in login.pid, prints its callback server and then its sign-in page, and
// waits for login.go in its home: then it keeps a sign-in whose ID token
// names owner@example.com and ends. "codex logout" adds a dot to logouts.log.
// A launch takes the markers every stand-in takes (`SHARED`), failing with
// turn.failed.
writeFileSync(
  join(bin, 'codex'),
  `#!/usr/bin/env node
const fs = require('node:fs');
// "--version" prints versions/codex in the test office, else the oldest the office runs.
if (process.argv[2] === '--version') {
  const v = ${JSON.stringify(join(folder, 'versions', 'codex'))};
  process.stdout.write('codex-cli ' + (fs.existsSync(v) ? fs.readFileSync(v, 'utf8').trim() : '0.166.0') + '\\n');
  process.exit(0);
}
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
if (args[0] === 'login') {
  const configFirst = fs.existsSync(home + '/config.toml');
  fs.appendFileSync(home + '/logins.jsonl', JSON.stringify({ args, home, configFirst }) + '\\n');
  fs.writeFileSync(home + '/login.pid', String(process.pid));
  process.stdout.write('Starting local login server on http://localhost:1455.\\nIf your browser did not open, navigate to this URL to authenticate:\\n\\nhttps://auth.openai.com/oauth/authorize?client_id=test\\n');
  setInterval(() => {
    if (!fs.existsSync(home + '/login.go')) return;
    fs.rmSync(home + '/login.go');
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const id_token = part({ alg: 'none' }) + '.' + part({ email: 'owner@example.com' }) + '.sig';
    fs.writeFileSync(home + '/auth.json', JSON.stringify({ tokens: { id_token } }));
    process.exit(0);
  }, 20);
  return;
}
if (args[0] === 'logout') {
  fs.appendFileSync(home + '/logouts.log', '.');
  process.exit(0);
}
${SHARED}
fs.appendFileSync(process.env.CODEX_HOME + '/launches.jsonl', JSON.stringify(args) + '\\n');
function emptyFolder(p) {
  try {
    return fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}
let message = '';
process.stdin.on('data', (d) => (message += d));
process.stdin.on('end', () => holdThen(lastOf(message), answer));
function answer() {
  if (lastOf(message).includes('Fail now.'))
    return failNow({ type: 'turn.failed', error: { message: 'Failed as told.' } });
  if (lastOf(message).includes('Start a command and wait.')) return startCommand();
  const replay = /Replay (\\/[^\\r\\n]+\\.jsonl)\\s*$/.exec(message)?.[1];
  if (replay) return process.stdout.write(fs.readFileSync(replay, 'utf8'));
  const sleeper = /Leave a sleeper at (\\/\\S+)/.exec(message)?.[1];
  if (sleeper) {
    const s = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' });
    fs.writeFileSync(sleeper, String(s.pid));
    s.unref();
  }
  // The office writes each -c value with JSON strings, so an inline table is JSON once its " = " is ": ".
  const set = {};
  args.forEach((a, i) => {
    if (args[i - 1] !== '-c') return;
    const v = a.slice(a.indexOf('=') + 1);
    set[a.slice(0, a.indexOf('='))] = JSON.parse(v.startsWith('{') ? v.replaceAll('" = ', '": ') : v);
  });
  const gave = {
    args,
    envNames: Object.keys(process.env).sort(),
    codexEnv: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => /^(CODEX_|OPENAI_|ANTHROPIC_API_KEY|TMPDIR|NODE_OPTIONS|GIT_)/.test(k))
    ),
    git: set['shell_environment_policy.set'],
    gitTemplate: emptyFolder(set['shell_environment_policy.set']?.GIT_TEMPLATE_DIR),
    env: set.mcp_servers.office?.env,
    servers: set.mcp_servers,
    // Whether each picture was there as the run read it (an office run's).
    pictures: args.filter((a) => a.startsWith('--image=')).map((a) => fs.existsSync(a.slice(8))),
    // None on Windows, where the run has Codex's read-only mode instead.
    permissions: set.permissions?.[set.default_permissions],
    system: set.developer_instructions,
    message,
    temp: fs.existsSync(process.env.TMPDIR)
  };
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const item = (type, o) => line({ type, item: o });
  line({ type: 'thread.started', thread_id: '019a0000-0000-7000-8000-00000000c0de' });
  line({ type: 'turn.started' });
  item('item.started', { id: 'item_0', type: 'command_execution', command: 'ls', status: 'in_progress' });
  item('item.completed', { id: 'item_0', type: 'command_execution', command: 'ls', exit_code: 0, status: 'completed' });
  item('item.started', { id: 'item_1', type: 'mcp_tool_call', server: 'office', tool: 'raise_ask', status: 'in_progress' });
  item('item.completed', { id: 'item_1', type: 'mcp_tool_call', server: 'office', tool: 'raise_ask', status: 'completed' });
  item('item.completed', { id: 'item_2', type: 'file_change', changes: [{ path: 'notes.md', kind: 'add' }], status: 'completed' });
  item('item.completed', { id: 'item_3', type: 'agent_message', text: 'Looking.' });
  item('item.completed', { id: 'item_4', type: 'agent_message', text: JSON.stringify(gave) + '\\nOutcome: done' });
  line({
    type: 'turn.completed',
    usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 20 }
  });
}
`
);
chmodSync(join(bin, 'codex'), 0o755);
// The stand-in for Gemini, which reads the message on stdin: like Gemini, it
// runs a message that starts with "/" as a command of its own, and fails it.
// Else it sends back its arguments, the Gemini, git and key variables it got, its
// run folder's policy, settings and instructions, and the message, in the
// event shapes `gemini -o stream-json` prints: the session, an echo of the
// message, a reply in pieces, a file tool and an MCP call, the reply's last
// message in two pieces and the result's tokens. A message that ends "End in
// error" gets a failed result instead (only at the end, since a later prompt
// can quote an earlier message that failed). Each launch adds a dot to launches.log
// in the Gemini home. It takes the markers every stand-in takes (`SHARED`),
// failing with its error result.
writeFileSync(
  join(bin, 'gemini'),
  `#!/usr/bin/env node
const fs = require('node:fs');
// "--version" prints versions/gemini in the test office, else the oldest the office runs.
if (process.argv[2] === '--version') {
  const v = ${JSON.stringify(join(folder, 'versions', 'gemini'))};
  process.stdout.write('' + (fs.existsSync(v) ? fs.readFileSync(v, 'utf8').trim() : '0.66.0') + '\\n');
  process.exit(0);
}
${SHARED}
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GEMINI_CLI_HOME + '/launches.log', '.');
let message = '';
process.stdin.on('data', (d) => (message += d));
process.stdin.on('end', () => holdThen(lastOf(message), answer));
function answer() {
  if (lastOf(message).includes('Fail now.'))
    return failNow({ type: 'result', status: 'error', error: { type: 'Error', message: 'Failed as told.' } });
  if (lastOf(message).includes('Start a command and wait.')) return startCommand();
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  line({ type: 'init', session_id: '0a0a0a0a-0000-4000-8000-00000000ce01', model: 'gemini-test' });
  if (message.startsWith('/'))
    return line({ type: 'result', status: 'error', error: { type: 'Error', message: 'Ran a slash command.' } });
  if (/End in error\\s*$/.test(message))
    return line({ type: 'result', status: 'error', error: { type: 'Error', message: 'Quota used up.' } });
  const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const run = path.dirname(settingsPath);
  const gave = {
    args,
    envNames: Object.keys(process.env).sort(),
    geminiEnv: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => /^(GEMINI_|GOOGLE_|ANTHROPIC_API_KEY|NODE_OPTIONS|GIT_)/.test(k))
    ),
    env: settings.mcpServers.office.env,
    settings,
    settingsMode: fs.statSync(settingsPath).mode & 0o777,
    runMode: fs.statSync(run).mode & 0o777,
    policy: fs.readFileSync(path.join(run, 'policy.toml'), 'utf8'),
    system: fs.readFileSync(process.env.GEMINI_SYSTEM_MD, 'utf8'),
    message
  };
  line({ type: 'message', role: 'user', content: message });
  line({ type: 'message', role: 'assistant', content: 'Look', delta: true });
  line({ type: 'message', role: 'assistant', content: 'ing.', delta: true });
  line({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: 'x' } });
  line({ type: 'tool_result', tool_id: 't1', status: 'success', output: '' });
  line({ type: 'tool_use', tool_name: 'mcp_office_raise_ask', tool_id: 't2', parameters: {} });
  line({ type: 'tool_result', tool_id: 't2', status: 'success', output: '' });
  const reply = JSON.stringify(gave) + '\\nOutcome: done';
  line({ type: 'message', role: 'assistant', content: reply.slice(0, 20), delta: true });
  line({ type: 'message', role: 'assistant', content: reply.slice(20), delta: true });
  line({
    type: 'result',
    status: 'success',
    stats: { models: { 'gemini-test': { total_tokens: 1050, input_tokens: 1000, output_tokens: 50, cached: 600, input: 400 } } }
  });
}
`
);
chmodSync(join(bin, 'gemini'), 0o755);
// A stand-in ripgrep, which Grok's grep runs, on PATH through a link the way
// Homebrew puts it there.
export const rgBin = join(folder, 'rg-bin');
export const rgReal = join(folder, 'rg-real');
mkdirSync(rgBin);
mkdirSync(rgReal);
writeFileSync(join(rgReal, 'rg'), '#!/bin/sh\n');
chmodSync(join(rgReal, 'rg'), 0o755);
symlinkSync(join(rgReal, 'rg'), join(rgBin, 'rg'));
// A stand-in xcode-select, which names an Xcode.app developer folder, as on a
// Mac that uses Xcode rather than the Command Line Tools alone. It names it
// through a link, and names DEVELOPER_DIR instead when that is set, as the
// real one does; the office's own environment sets it (below). So the profile
// holds Xcode.app's real folder only when the office asks with PATH alone and
// takes the real path.
const xcode = join(folder, 'Applications', 'Xcode.app', 'Contents', 'Developer');
mkdirSync(xcode, { recursive: true });
symlinkSync(join(folder, 'Applications', 'Xcode.app'), join(folder, 'Applications', 'Linked.app'));
const linked = join(folder, 'Applications', 'Linked.app', 'Contents', 'Developer');
const elsewhere = join(folder, 'Applications', 'Elsewhere.app', 'Contents', 'Developer');
mkdirSync(elsewhere, { recursive: true });
writeFileSync(join(bin, 'xcode-select'), `#!/bin/sh\necho "\${DEVELOPER_DIR:-${linked}}"\n`);
chmodSync(join(bin, 'xcode-select'), 0o755);
// A stand-in `security`, the Keychain's own command, which fails and logs
// each call in `keychainCalls`. The office's secret store is a stand-in below,
// so nothing here should ever reach it, let alone the owner's own Keychain.
export const keychainCalls = join(folder, 'security-calls.log');
writeFileSync(join(bin, 'security'), `#!/bin/sh\necho "$1" >> '${keychainCalls}'\nexit 1\n`);
chmodSync(join(bin, 'security'), 0o755);
// The stand-ins for the installers the page's Install runs, `npm` and `bash`
// (xAI's script runs through `bash -c`), in a folder of their own so a test
// can leave the tools themselves off PATH. Each logs its name and arguments,
// and the names in the environment it got, in `installs`, a line each,
// prints a line, then waits for `<name>.go` in
// the office's folder and ends done, or with `<name>.fail` there says why and
// fails. Neither installs anything. Two minutes, longer than any test may
// run, and it gives up, so a test that died before telling it never leaves
// it running.
export const installers = join(folder, 'installers');
export const installs = join(folder, 'installs.jsonl');
mkdirSync(installers);
for (const name of ['npm', 'bash']) {
  writeFileSync(
    join(installers, name),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(installs)}, JSON.stringify({ args: ['${name}', ...process.argv.slice(2)], env: Object.keys(process.env) }) + '\\n');
process.stdout.write('Installing.\\n');
const go = ${JSON.stringify(join(folder, `${name}.go`))};
const fail = ${JSON.stringify(join(folder, `${name}.fail`))};
setInterval(() => {
  if (fs.existsSync(fail)) {
    process.stderr.write('${name} error: could not install\\n');
    process.exit(1);
  }
  if (!fs.existsSync(go)) return;
  fs.rmSync(go);
  process.exit(0);
}, 20);
setTimeout(() => {
  process.stderr.write('${name} error: never told to end\\n');
  process.exit(1);
}, 120_000);
`
  );
  chmodSync(join(installers, name), 0o755);
}
// Set before the office's modules load: they read where everything is as they start.
Object.assign(process.env, {
  ODDBORO_HOME: folder,
  ODDBORO_DB_PORT: String(port),
  // A file that does not exist, so no .env reaches this office.
  ODDBORO_ENV: join(folder, 'none.env'),
  // No tool's maker is asked for its newest version (versions.ts).
  ODDBORO_NO_LATEST: '1',
  ODDBORO_LOCAL_DB: '1',
  // The stand-ins, node for them, and the system's own tools: never the Mac's
  // own claude, grok, codex, gemini, xcode-select or security.
  PATH: `${bin}:${rgBin}:${installers}:${nodeBin}:/usr/bin:/bin`,
  // Never handed to a Grok run.
  XAI_API_KEY: 'from-the-parent',
  ANTHROPIC_API_KEY: 'from-the-parent',
  GROK_SANDBOX: 'off',
  // Never handed to a Codex run, which gets the office's own Codex home.
  OPENAI_API_KEY: 'from-the-parent',
  CODEX_HOME: 'from-the-parent',
  // Never handed to a Gemini run, which gets the office's own key and home.
  GEMINI_API_KEY: 'from-the-parent',
  GOOGLE_API_KEY: 'from-the-parent',
  GEMINI_SYSTEM_MD: 'from-the-parent',
  // Harmless to the stand-ins, and never handed to a Grok, Codex or Gemini run either.
  NODE_OPTIONS: '--no-warnings',
  // A developer folder the office never asks xcode-select with (`developerReads`).
  DEVELOPER_DIR: elsewhere
});
delete process.env.OFFICE_AUTH;
/** The office's Gemini key under test: the shape the page takes, and nothing Google knows. */
export const OFFICE_GEMINI_KEY = 'the-office-key-for-tests-01';
/**
 * The office's secret store under test, by "<connector>:<NAME>", in place of
 * the system's own (`@oddboro/ledger/secrets`), so no test reads or writes the
 * owner's Keychain. It starts with the office's Gemini key.
 */
export const secrets = new Map([['gemini:API_KEY', OFFICE_GEMINI_KEY]]);
/** Each name the office read from the store, in order. */
export const secretReads: string[] = [];
const realSecrets = await import('@oddboro/ledger/secrets');
mock.module('@oddboro/ledger/secrets', {
  namedExports: {
    ...realSecrets,
    getSecret: (connector: string, name: string) => {
      secretReads.push(`${connector}:${name}`);
      return secrets.get(`${connector}:${name}`);
    },
    setSecret: (connector: string, name: string, value: string) =>
      void secrets.set(`${connector}:${name}`, value),
    deleteSecret: (connector: string, name: string) => secrets.delete(`${connector}:${name}`),
    // The stand-in store always answers, whatever this computer's own does.
    secretStore: () => ({ ok: true })
  }
});
// A Codex run starts only from a signed-in home; the stand-in reads nothing in it.
mkdirSync(join(folder, 'codex'));
writeFileSync(join(folder, 'codex', 'auth.json'), '{}');
// A static import beside this file loads as this file waits on its port above,
// so home.ts would read neither ODDBORO_HOME nor ODDBORO_DB_PORT, and the
// office would start in a folder other than this one.
const { DATABASE_PORT } = await import('@oddboro/ledger/home');
assert.equal(
  DATABASE_PORT,
  port,
  "This test file loaded the office's code before the harness set its port. Import the office's modules with `await import(...)` in the test file."
);
const { startLocalDatabase } = await import('@oddboro/ledger/local-db');
const stopDatabase = await startLocalDatabase();
const { bringUpToDate } = await import('@oddboro/ledger/upgrade');
await bringUpToDate();
export const L = await import('@oddboro/ledger');
export const { bus } = await import('./events.ts');
export const { chat, followThrough, history, isBusy } = await import('./staff.ts');
export const { currentOffice } = await import('./space.ts');
export const { PATCH } = await import('../../routes/api/staff/[id]/+server.ts');
/** The hire drawer's POST. */
export const hireRoute = await import('../../routes/api/staff/+server.ts');
export const agents = await import('../../routes/api/agents/+server.ts');

after(async () => {
  await L.pg.end();
  await stopDatabase();
  rmSync(folder, { recursive: true, force: true });
});

export const odd = (id: string, name: string) => ({
  id,
  name,
  role: 'Tester',
  remit: 'Tests.',
  variant: 'a',
  portrait: 'a',
  // Above Draft, so a run held to Draft shows it.
  permission: 'act',
  agent: 'claude',
  desk: `You are ${name}.`
});
await L.pg`insert into staff ${L.pg([
  odd('lead', 'Lena'),
  odd('paige', 'Paige'),
  odd('cleo', 'Cleo'),
  { ...odd('gus', 'Gus'), agent: 'grok' },
  odd('sam', 'Sam')
])}`;

/** What the stand-in says the run gave it. */
export type Gave = {
  args: string[];
  /** The names of every variable in the environment the tool was started with. */
  envNames: string[];
  /** The servers a Claude Code run got, read from the file `--mcp-config` names while the run went. */
  mcp?: unknown;
  /** A Claude Code run's settings, read from the file `--settings` names while the run went. */
  claudeSettings?: {
    permissions: { allow: string[]; deny: string[] };
    enabledPlugins: unknown;
    sandbox?: unknown;
  };
  env: Record<string, string>;
  system: string;
  message: string;
  /** What a streamed Claude Code chat was given after its first message (Send now). */
  added?: string[];
  claudeMds: string | null;
  autoMemory: string | null;
  /** The Claude Code run's CLAUDE_CODE_TMPDIR and NODE_OPTIONS, which Run commands sets. */
  tmpdir?: string | null;
  nodeOptions?: string | null;
  /** The git environment a run's shell gets: Claude Code's GIT_ variables, or Codex's `-c shell_environment_policy.set`. */
  git?: Record<string, string>;
  /** The Claude Code folder the run got (`CLAUDE_CONFIG_DIR`): its account's, or none for the owner's own login. */
  configDir?: string | null;
  /** Whether that environment's GIT_TEMPLATE_DIR was there and empty while the run went. */
  gitTemplate?: boolean;
  /** The Claude Code run's npm cache and user config, which Run commands sets (`shellEnv`). */
  npm?: { npm_config_cache: string | null; npm_config_userconfig: string | null };
  /** The Claude Code run's ANTHROPIC_API_KEY, which only a key sign-in sets. */
  apiKey?: string | null;
  grokEnv?: Record<string, string>;
  /** The Grok run's HOME: the owner's, or the run home `runHome` made. */
  home?: string;
  agentMode?: number;
  /** The Grok run's agent file's `prompt_mode`, and the mode of the file `--prompt-file` names. */
  promptMode?: string;
  promptFileMode?: number;
  /** The Grok run's message as content blocks, from a `.json` prompt file. */
  prompt?: { type: string; data?: string; mimeType?: string; text?: string }[];
  profile?: string;
  codexEnv?: Record<string, string>;
  /** The Codex run's MCP servers, as its `-c mcp_servers` said them, or the Grok run's, as its agent file names them. */
  servers?: Record<string, Record<string, unknown>>;
  /** The permission profile the Codex run used, as its `-c permissions` said it. */
  permissions?: { filesystem: Record<string, string>; network: { enabled: boolean } };
  /** Whether the Codex run's temp folder (TMPDIR) was there while it ran. */
  temp?: boolean;
  geminiEnv?: Record<string, string>;
  /** The Gemini run's system settings, policy and the modes of its settings file and run folder. */
  settings?: Record<string, Record<string, unknown>>;
  settingsMode?: number;
  runMode?: number;
  policy?: string;
};
/** The folders the office's file server holds a run to, as `ODDBORO_FILES` names them. */
export type FileWalls = { cwd: string; reads: string[]; writes: string[]; noWrite: string[] };
/**
 * The office's file server (`files`) a run was given, in any tool's shape:
 * Claude Code's `--mcp-config`, Codex's `-c mcp_servers` or Grok's agent
 * file. Its command, its arguments and the walls it holds, or nothing.
 */
export function filesOf(
  run: Gave
): { command: string; args: string[]; walls: FileWalls } | undefined {
  const servers =
    run.servers ?? (run.mcp as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
  const files = servers.files as
    { command: string; args: string[]; env: { ODDBORO_FILES: string } } | undefined;
  if (!files) return undefined;
  return {
    command: files.command,
    args: files.args,
    walls: JSON.parse(files.env.ODDBORO_FILES) as FileWalls
  };
}
/** What one follow-up's run was given, and the run keys going while it ran. */
export async function runOf(id: number, ask?: number): Promise<Gave & { going: string[] }> {
  const f = await L.startFollowUp(id);
  assert.ok(f, `follow-up ${id} could not start`);
  let going: string[] = [];
  // The stand-in's tool call comes before its result, so the run still goes.
  const seen = (e: { type: string; inProgress?: Record<string, { doing?: string }[]> }) => {
    if (e.type === 'working' && e.inProgress?.[f.staffId]?.some((w) => w.doing))
      going = [...L.runsGoing.keys()];
  };
  bus.on('event', seen);
  const r = await followThrough(f, ask ? await L.ask(ask) : undefined).finally(() =>
    bus.off('event', seen)
  );
  assert.equal(r.outcome, 'done', r.text);
  return { ...(JSON.parse(r.text) as Gave), going };
}
/** One chat message's run: what it was given, and the tools the floor was told it used. */
export async function chatOf(id: string, message = 'Hello.'): Promise<Gave & { tools: string[] }> {
  const tools: string[] = [];
  let text = '';
  await chat(id, message, (e) => {
    if (e.type === 'tool') tools.push(e.name);
    if (e.type === 'done') text = e.text;
    if (e.type === 'error') text = e.message;
  });
  assert.ok(text.startsWith('{'), `${id}'s chat gave no reply: ${text}`);
  return { ...gaveIn(text), tools };
}
/** What a run's stand-in said it was given, from the run's text, which ends with its outcome line. */
export const gaveIn = (text: string): Gave =>
  JSON.parse(text.slice(0, text.lastIndexOf('\nOutcome:'))) as Gave;
/** `fn`, run as if the office ran on `platform`. */
export async function onPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => T | Promise<T>
): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await fn();
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
}
/**
 * The stand-in Grok and Codex by the names a Windows office starts, grok.exe
 * and codex.exe (`agentCommand`), in a folder of their own.
 */
const windowsTools = join(folder, 'windows-tools');
mkdirSync(windowsTools);
for (const tool of ['grok', 'codex'])
  symlinkSync(join(bin, tool), join(windowsTools, `${tool}.exe`));
/**
 * `fn`, run as if the office ran on Windows, with the stand-in Grok and Codex
 * first on PATH as grok.exe and codex.exe. Without them a Windows run finds
 * neither by name, and the run would start whatever grok or codex this Mac has.
 */
export async function onWindows<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ PATH: `${windowsTools}${delimiter}${process.env.PATH ?? ''}` }, () =>
    onPlatform('win32', fn)
  );
}
/** `fn`, run with `vars` set in the office's own environment, which is then put back. */
export async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => T | Promise<T>
): Promise<T> {
  const real = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(real))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}
/** `fn`, run with HOME at `home`, which is then put back. */
const withHome = <T>(home: string, fn: (home: string) => T | Promise<T>): Promise<T> =>
  withEnv({ HOME: home }, () => fn(home));
/**
 * Git variables the office's own environment may hold, from the owner's shell
 * or a git hook: each would point an Odd's git elsewhere, and none may reach a run.
 */
export const OFFICE_PROCESS_GIT = {
  GIT_DIR: '/nonexistent',
  GIT_CONFIG_PARAMETERS: "'x.y=z'",
  GIT_EDITOR: 'true'
};
/**
 * `fn`, run with HOME at an empty folder of its own, so the Mac's own
 * ~/.grok/bin, where `grokCommand` also looks, is never found. Only around a
 * test: the office reads HOME as it loads for paths it shuts.
 */
export const awayFromHome = <T>(fn: (home: string) => T | Promise<T>): Promise<T> =>
  withHome(mkdtempSync(join(folder, 'home-')), fn);
/**
 * `fn`, run with HOME at an empty folder under the system's temp folder,
 * removed after. `awayFromHome`'s sits in the office's home, where
 * `checkFolder` refuses every folder; a folder in this one can be given.
 */
export async function ownerHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'oddboro-owner-'));
  try {
    return await withHome(home, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
/** No test reached the system's secret store: `security` here is the stand-in, and nothing ran it. */
export function assertKeychainUntouched(): void {
  assert.equal(onPath('security'), join(bin, 'security'));
  assert.ok(
    !existsSync(keychainCalls),
    `security ran: ${existsSync(keychainCalls) && readFileSync(keychainCalls, 'utf8')}`
  );
}
/** The one follow-up of a kind an ask started. */
export const startedBy = async (ask: number, kind: string) => {
  const [row] = await L.pg<{ id: number }[]>`
    select id from follow_ups where ask_id = ${ask} and kind = ${kind}`;
  assert.ok(row, `ask ${ask} started no ${kind}`);
  return row.id;
};

export const code = (d: string) => resolve(L.CODE, d);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Arguments with this machine's paths and each run's ids as stand-ins, so they can be compared whole. */
export const plain = (args: string[]) =>
  args.map((a) =>
    a
      // macOS links the temp folder into /private.
      .replaceAll(realpathSync(folder), '<home>')
      .replaceAll(folder, '<home>')
      .replaceAll(dirname(process.execPath), '<node>')
      .replaceAll(resolve(L.CODE), '<code>')
      .replaceAll(homedir(), '~')
      .replace(UUID, '<id>')
  );
/** The value after `flag` as a stand-in. */
export const hide = (args: string[], ...flags: string[]) =>
  args.map((a, i) => (flags.includes(args[i - 1]) ? `<${args[i - 1].replace(/^-+/, '')}>` : a));

/**
 * Whether a rule of a Gemini run's policy with `decision` matches a write to
 * `path`, as Gemini matches it: the arguments as JSON, each pair between NULs.
 * Each value the office writes is a JSON string, one key a line.
 */
export function writeRule(policy: string, decision: 'allow' | 'deny', path: string): boolean {
  const args = `{\0"content":"x"\0,\0"file_path":${JSON.stringify(path)}\0}`;
  return policy
    .split('[[rule]]\n')
    .filter(Boolean)
    .map(
      (block) =>
        Object.fromEntries(
          block
            .trim()
            .split('\n')
            .map((l) => [l.slice(0, l.indexOf(' = ')), JSON.parse(l.slice(l.indexOf(' = ') + 3))])
        ) as Record<string, unknown>
    )
    .some(
      (r) =>
        r.decision === decision &&
        typeof r.argsPattern === 'string' &&
        new RegExp(r.argsPattern).test(args)
    );
}

/** Every Codex launch so far, as its stand-in logged its arguments. */
export const codexLaunches = (): string[][] => {
  const log = join(folder, 'codex', 'launches.jsonl');
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[])
    : [];
};
export const goal = async (title: string) =>
  (await L.pg<{ id: number }[]>`insert into goals (title) values (${title}) returning id`)[0].id;
const give = (from: string, to: string, thread: Parameters<typeof L.handOff>[0]['thread']) =>
  L.handOff({
    from,
    to,
    work: { title: `For ${to}`, brief: 'Do it.' },
    thread
  });
/** A hand-off that went with no ask. */
export async function gave(...a: Parameters<typeof give>): Promise<{ id: number; thread: number }> {
  const h = await give(...a);
  assert.ok('id' in h, JSON.stringify(h));
  return h;
}
/** An Odd's switches and folders as the owner left them; anything not named is off. */
export async function setOwn(
  id: string,
  o: { commands?: boolean; web?: boolean; folders?: { path: string; write: boolean }[] }
): Promise<void> {
  await L.pg`
    update staff set commands = ${o.commands ?? false}, web = ${o.web ?? false},
      folders = ${JSON.stringify(o.folders ?? [])}::jsonb where id = ${id}`;
}
/** What the owner's page sends one route: its params, its query and its JSON body. */
export type Call = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
};
/**
 * The owner's page calling one of the office's routes, answered by the
 * route's own handler for `method`. `route` is its id, like `/api/staff/[id]`.
 * A route that refuses throws, as SvelteKit's `error` does.
 */
export async function request(route: string, method: string, call: Call = {}): Promise<Response> {
  const module = (await import(`../../routes${route}/+server.ts`)) as Record<
    string,
    ((event: unknown) => Promise<Response>) | undefined
  >;
  const handler = module[method];
  assert.ok(handler, `${route} has no ${method}`);
  let path = route;
  for (const [k, v] of Object.entries(call.params ?? {})) path = path.replace(`[${k}]`, v);
  const url = new URL(`http://office${path}`);
  url.search = new URLSearchParams(call.query ?? {}).toString();
  return handler({
    params: call.params ?? {},
    url,
    // A GET or HEAD carries no body: `Request` refuses one.
    request: new Request(url, {
      method,
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(call.body ?? {})
    }),
    getClientAddress: () => '127.0.0.1'
  });
}
/** The owner's PATCH of an Odd from its card. */
export const patch = (id: string, body: unknown) =>
  request('/api/staff/[id]', 'PATCH', { params: { id }, body });
/** What the route said when it refused a PATCH. */
export async function refusal(
  body: ReturnType<typeof patch>
): Promise<{ status: number; message: string }> {
  try {
    await body;
  } catch (e) {
    const h = e as { status: number; body: { message: string } };
    return { status: h.status, message: h.body.message };
  }
  assert.fail('the route took it');
}
/** Whether the ledger holds a line with this title. */
export const recorded = async (title: string) =>
  (await L.pg`select 1 from ledger where title = ${title}`).length === 1;
