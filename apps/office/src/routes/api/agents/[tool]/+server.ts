// One tool's install and sign-in in the office, from the page
// (agent-sign-in.ts). Only a tool this system offers. Claude Code's install
// is Setup's; its accounts sign in here like every tool's.
//
// POST `install` runs the tool's own installer, `update` its update
// (`updateCommand` in versions.ts), and `sign-in` a browser tool's sign-in
// to one account (`account`, the Office account without one), each
// streaming its output a line of JSON at a time, the sign-in with its page's
// address once it prints one. A second sign-in starts over. POST `sign-out`
// stops a sign-in still waiting, then signs that account out
// (`signOut`: never Grok's or Codex's own logout). PUT `{ key }` tries a key
// tool's key once, then keeps it. DELETE stops a sign-in that is waiting.
// Each but the streams answers with the account's state. An install runs to
// its end, and so does an update: while one runs, every other request about
// that tool gets 409.
import { error, json } from '@sveltejs/kit';
import {
  currentPlatform,
  currentSystem,
  account as accountRow,
  AGENT_NAMES,
  OFFICE_ACCOUNT,
  offeredAgent,
  type Agent
} from '@oddboro/ledger';
import { computerWord } from '@oddboro/ledger/system-words';
import {
  claudeSignIn,
  claudeSignInState,
  installEnv,
  npmMissing,
  SIGN_INS,
  signingIn,
  signInState,
  signOut,
  SLOTS,
  agentCommand
} from '#lib/server/agent-sign-in.ts';
import { updateCommand } from '#lib/server/versions.ts';
import type { RequestHandler } from './$types';

/**
 * The tool the address names, when this system offers it and it signs in
 * here, and nothing is installing it.
 */
function toolOf(name: string): Agent {
  const tool = offeredAgent(name, currentPlatform());
  if (!tool) error(404, 'No such tool to sign in to here.');
  const running = SLOTS[tool].running?.action;
  if (running === 'install' || running === 'update')
    error(
      409,
      `${AGENT_NAMES[tool]} is still ${running === 'install' ? 'installing' : 'updating'}.`
    );
  return tool;
}

/** The account a request names: the Office account, or one the owner added for this tool. */
async function accountFor(tool: Agent, named: unknown): Promise<string> {
  if (named === undefined || named === OFFICE_ACCOUNT) return OFFICE_ACCOUNT;
  const row = typeof named === 'string' ? await accountRow(named) : undefined;
  if (row?.agent !== tool) error(404, `No such ${AGENT_NAMES[tool]} account.`);
  return row.id;
}

/** One account's sign-in, as the page reads it. */
const state = async (tool: Agent, account: string) =>
  tool === 'claude' ? claudeSignInState(account) : signInState(tool, account);

export const POST: RequestHandler = async ({ params, request }) => {
  const tool = toolOf(params.tool);
  const b = (await request.json().catch(() => ({}))) as { action?: unknown; account?: unknown };
  const name = AGENT_NAMES[tool];
  const account = await accountFor(tool, b.account);
  if (b.action === 'sign-in') {
    const command = agentCommand(tool);
    if (!command)
      error(400, `${name} is not on this ${computerWord(currentSystem())}. Install it first.`);
    const s = tool === 'claude' ? undefined : SIGN_INS[tool];
    if (s?.how === 'key') error(400, `${name} takes an API key.`);
    const [cmd, before] = command;
    const { args, env } = s?.how === 'browser' ? s.command(account) : claudeSignIn(account);
    signingIn[tool] = account;
    return SLOTS[tool].start('sign-in', cmd, [...before, ...args], env);
  }
  if (b.action === 'sign-out') {
    SLOTS[tool].stop('Signed out.');
    await signOut(tool, account);
    return json(await state(tool, account));
  }
  // Claude Code installs and updates from Setup.
  if (tool === 'claude') error(400, 'Say sign-in or sign-out.');
  const s = SIGN_INS[tool];
  if (b.action === 'install') {
    const [cmd, args] = s.install;
    const missing = cmd === 'npm' ? npmMissing(name) : undefined;
    if (missing) error(400, missing);
    return SLOTS[tool].start('install', cmd, args, installEnv());
  }
  if (b.action === 'update') {
    if (!agentCommand(tool))
      error(400, `${name} is not on this ${computerWord(currentSystem())}. Install it first.`);
    const u = updateCommand(tool);
    return SLOTS[tool].start('update', u.cmd, u.args, u.env ?? installEnv());
  }
  error(400, 'Say install, update, sign-in or sign-out.');
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const tool = toolOf(params.tool);
  if (tool === 'claude') error(400, 'Claude Code takes its key in Setup.');
  const s = SIGN_INS[tool];
  if (s.how !== 'key') error(400, `${AGENT_NAMES[tool]} signs in on its own page, not with a key.`);
  const b = (await request.json().catch(() => ({}))) as { key?: unknown };
  const r = await s.setKey(typeof b.key === 'string' ? b.key : '');
  if (!r.ok) error(400, r.problem);
  return json(signInState(tool));
};

export const DELETE: RequestHandler = async ({ params }) => {
  const tool = toolOf(params.tool);
  return json({ stopped: SLOTS[tool].stop('Cancelled.') });
};
