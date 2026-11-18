// How the owner installs the office's Grok, Codex and Gemini, signs each
// tool's accounts in (Claude Code's too), and gives Gemini its API key, from
// the office's page (routes/api/agents/[tool]), so no tool an Odd runs on
// needs Terminal. Each account is a folder of its own (accounts.ts), and a
// sign-in signs that one folder in. Claude Code's install is Setup's Claude
// card; its sign-in runs with the account's `CLAUDE_CONFIG_DIR`, so it never
// touches the owner's own login.
//
// Install runs the tool's own installer and sign-in its own sign-in command
// in the office's home for it, each streamed to the page through the runner
// Claude Code's uses (command-stream.ts), one at a time per tool. An install
// runs to its end, since one stopped halfway can leave the tool half
// installed or a shell's settings half written. Sign out removes that home's
// sign-in file and nothing else: it never runs a tool's own logout, since
// `GROK_HOME=<office> grok logout` removed the owner's own ~/.grok sign-in in
// the same second. The session at xAI or OpenAI lasts until it ends or the
// owner removes it in their account. Server only.
import { rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { OFFICE_ACCOUNT, type Agent } from '@oddboro/ledger';
import {
  claudeCommand,
  currentPlatform,
  currentSystem,
  npmCommand,
  probe
} from '@oddboro/ledger/platform';
import { computerWord } from '@oddboro/ledger/system-words';
import { claudeAccountOf, claudeHome, cleanEnv, forgetClaudeAccount } from './claude.ts';
import { codexAccount, codexHome, codexSignIn } from './codex.ts';
import { commandSlot, type Slot } from './command-stream.ts';
import { clearGeminiKey, geminiAccount, setGeminiKey } from './gemini.ts';
import { grokAccount, grokCommand, grokHome, grokSignIn } from './grok.ts';
import { vendorEnv } from './launch.ts';
import { onPath } from './on-path.ts';

/** Every tool whose install and sign-in are here: each but Claude Code, whose install is Setup's. */
export type SignInTool = Exclude<Agent, 'claude'>;

type Account = { email?: string };
/** A command and its arguments, as spawn takes them. */
type Command = readonly [string, readonly string[]];
/** A tool that signs in on its maker's page in the browser, and keeps the sign-in as a file. */
type BrowserSignIn = {
  how: 'browser';
  /** The tool's own installer, which the page's Install runs. */
  install: Command;
  /** An account's sign-in file, which Sign out removes. */
  auth: (account: string) => string;
  account: (account: string) => Account | undefined;
  command: (account: string) => { args: string[]; env: NodeJS.ProcessEnv };
};
/** A tool that signs in with an API key the owner pastes. */
type KeySignIn = {
  how: 'key';
  install: Command;
  account: () => Account | undefined;
  setKey: (key: string) => Promise<{ ok: true } | { ok: false; problem: string }>;
  clear: () => void;
};

/** How the owner signs each tool in from the page. Every tool has an entry, so a new one fails the type check until it does. */
export const SIGN_INS: Record<SignInTool, BrowserSignIn | KeySignIn> = {
  grok: {
    how: 'browser',
    // Grok installs only through xAI's own script: its usage line, run as it
    // says, and on Windows its PowerShell one, which puts grok.exe in ~/.grok/bin.
    get install(): Command {
      return currentPlatform() === 'win32'
        ? [
            'powershell',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              'irm https://x.ai/cli/install.ps1 | iex'
            ]
          ]
        : ['bash', ['-c', 'curl -fsSL https://x.ai/cli/install.sh | bash']];
    },
    auth: (a) => grokHome(a).auth,
    account: grokAccount,
    command: grokSignIn
  },
  codex: {
    how: 'browser',
    install: ['npm', ['install', '-g', '@openai/codex']],
    auth: (a) => codexHome(a).auth,
    account: codexAccount,
    command: codexSignIn
  },
  gemini: {
    how: 'key',
    install: ['npm', ['install', '-g', '@google/gemini-cli']],
    account: geminiAccount,
    setKey: setGeminiKey,
    clear: clearGeminiKey
  }
};

/** One install or sign-in at a time per tool, Claude Code's (Setup's install and every sign-in) among them. */
export const SLOTS: Record<Agent, Slot> = {
  claude: commandSlot(),
  grok: commandSlot(),
  codex: commandSlot(),
  gemini: commandSlot()
};
/** The account each tool's running sign-in signs in, so only its card says it waits. */
export const signingIn: Partial<Record<Agent, string>> = {};

/** What the page reads about one tool's sign-in (in `/api/agents`). */
export type SignInState = {
  how: 'browser' | 'key';
  /** Its install or update runs, so the page offers nothing else for it until that ends, even after a refresh. */
  installing: boolean;
  signedIn: boolean;
  /** The account's email, when the sign-in names one. */
  account?: string;
  /** A sign-in waits on its page, with that page's address once printed. */
  waiting?: { url?: string };
  /**
   * Claude Code's Office account only, before the owner signs it in: the
   * owner's own login, which its Odds keep running on until then.
   */
  ownLogin?: string;
};

/** Whether `account`'s sign-in is the one waiting on its page, and that page's address. */
function waitingFor(tool: Agent, account: string): SignInState['waiting'] {
  const running = SLOTS[tool].running;
  if (running?.action !== 'sign-in' || (signingIn[tool] ?? OFFICE_ACCOUNT) !== account)
    return undefined;
  return running.url ? { url: running.url } : {};
}

export function signInState(tool: SignInTool, account: string = OFFICE_ACCOUNT): SignInState {
  const s = SIGN_INS[tool];
  const signed = s.how === 'browser' ? s.account(account) : s.account();
  const running = SLOTS[tool].running;
  const waiting = waitingFor(tool, account);
  return {
    how: s.how,
    installing: !!running && running.action !== 'sign-in',
    signedIn: !!signed,
    ...(signed?.email ? { account: signed.email } : {}),
    ...(waiting ? { waiting } : {})
  };
}

/**
 * Claude Code's sign-in in one account's folder, read fresh. The Office
 * account not signed in yet says the owner's own login, which its Odds use
 * until it is (`claudeRunHome`).
 */
export async function claudeSignInState(
  account: string = OFFICE_ACCOUNT,
  own?: () => Promise<{ email?: string } | undefined>
): Promise<SignInState> {
  const signed = await claudeAccountOf(account, true);
  const running = SLOTS.claude.running;
  const waiting = waitingFor('claude', account);
  const mine = !signed && own ? await own() : undefined;
  return {
    how: 'browser',
    installing: !!running && running.action !== 'sign-in',
    signedIn: !!signed,
    ...(signed?.email ? { account: signed.email } : {}),
    ...(waiting ? { waiting } : {}),
    ...(mine ? { ownLogin: mine.email ?? 'your own login' } : {})
  };
}

/** Claude Code's sign-in to one account's folder: `claude auth login` with that folder, never the owner's own. */
export function claudeSignIn(account: string = OFFICE_ACCOUNT): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  return {
    args: ['auth', 'login', '--claudeai'],
    env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: claudeHome(account) }
  };
}

/**
 * Sign one account out. Grok and Codex: remove its sign-in file, never the
 * tool's own logout, which reached the owner's own Grok. Gemini: its key.
 * Claude Code: its own logout, with the account's folder, which keeps that
 * folder's login apart from the owner's (on a Mac, a keychain entry named
 * after the folder).
 */
export async function signOut(tool: Agent, account: string = OFFICE_ACCOUNT): Promise<void> {
  if (tool === 'claude') {
    const command = agentCommand('claude');
    if (command) {
      const r = await probe(command[0], [...command[1], 'auth', 'logout'], {
        env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: claudeHome(account) },
        timeout: 15_000
      });
      switch (r.status) {
        case 'ok':
          break;
        // The office forgets the account either way, and the page reads the
        // sign-in again, so a logout that did not take shows as still signed in.
        case 'failed':
        case 'missing':
        case 'timeout':
          console.error(`Claude Code's sign-out of ${account} came back ${r.status}.`);
          break;
        default: {
          const missed: never = r;
          throw new Error(`Claude Code's sign-out came back as ${JSON.stringify(missed)}`);
        }
      }
    }
    forgetClaudeAccount(account);
    return;
  }
  const s = SIGN_INS[tool];
  if (s.how === 'browser') rmSync(s.auth(account), { force: true });
  else s.clear();
}

/**
 * How a tool starts: the program, then any words before the tool's own. A
 * run, a sign-in and the page's "installed" all use it. Claude Code's comes
 * from `claudeCommand`, which on Windows also finds an npm install's
 * claude.cmd and runs its script under this Node; Grok's from `grokCommand`,
 * which also looks in xAI's install folder; every other tool's from PATH.
 * Undefined when it is not installed.
 */
export function agentCommand(tool: Agent): Command | undefined {
  if (tool === 'grok') {
    const grok = grokCommand();
    return grok ? [grok, []] : undefined;
  }
  if (tool === 'claude') {
    const [cmd, before] = claudeCommand();
    // A path when Windows found it; the bare name everywhere else, which PATH finds.
    if (isAbsolute(cmd)) return [cmd, before];
  }
  // npm's Codex and Gemini on Windows are .cmd shims, which Node will not start.
  if (currentPlatform() === 'win32' && (tool === 'codex' || tool === 'gemini')) {
    const found = npmCommand(
      tool,
      tool === 'codex' ? ['@openai', 'codex'] : ['@google', 'gemini-cli']
    );
    if (found) return found;
  }
  const found = onPath(tool);
  return found ? [found, []] : undefined;
}

/**
 * Why an install through npm cannot start here, or undefined when it can.
 * Codex and Gemini install with npm, and so does Claude Code off Windows. The
 * app brings its own Node but not npm, so npm has to be on the PATH the
 * office started with. Without this check the page showed "spawn npm ENOENT".
 * Windows is left to the installer as before: its npm is a .cmd shim, which
 * `onPath` does not look for.
 */
export function npmMissing(name: string): string | undefined {
  if (currentPlatform() === 'win32' || onPath('npm')) return undefined;
  return `${name} installs with npm, which comes with Node.js, and the office cannot find npm on this ${computerWord(currentSystem())}. Install Node.js from nodejs.org, then quit and reopen Oddboro.`;
}

/**
 * The environment an installer gets: the office's, with no key of its own and
 * no Grok or xAI setting, since `GROK_BIN_DIR` would put Grok's links outside
 * the folder `grokCommand` looks in, and `GROK_DEPLOYMENT_KEY` would make
 * xAI's installer fetch the enterprise build.
 */
export const installEnv = (): NodeJS.ProcessEnv => vendorEnv(['GROK_', 'XAI_']);
