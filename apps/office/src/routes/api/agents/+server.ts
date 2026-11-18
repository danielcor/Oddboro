// The coding tools this system offers an Odd (`AGENT_PLATFORMS`), whether
// each is installed, and each one's Office account sign-in (`signInState`,
// Claude Code's `claudeSignInState`), with the accounts the owner added and
// theirs (`accounts`): what the "Runs on" picker (`RunsOn.svelte`) on the
// Settings tab and in the hire drawer, setup's Your AI card and the Setup
// window show. Installed means `agentCommand` finds the tool's command, the
// one a run starts. `office` is the tool the office runs on, and `later` the
// tools this system does not offer yet, which setup shows greyed out with
// why. `drawsLooks` says whether the office's tool, on its model, draws an
// Odd's look; when it does not, the hire offers building one from parts. Each installed tool says its version, a newer one when its maker has
// one out, and the oldest the office runs when it is older (versions.ts).
// Each tool says how it takes Run commands on this system (`commandsHow`), so
// the hire drawer names that switch only where the owner can move it, and the
// model an Odd with none of its own runs on it (`shownOfficeModel`).
// PUT picks the office's tool. Installs and sign-ins themselves go to
// /api/agents/[tool].
import { error, json } from '@sveltejs/kit';
import {
  currentPlatform,
  currentSystem,
  AGENT_NAMES,
  AGENTS,
  agentsOn,
  commandsHow,
  type CommandsHow,
  listAccounts,
  notOfferedWhy,
  officeAgent,
  offeredAgent,
  type Agent
} from '@oddboro/ledger';
import { writeEnv } from '@oddboro/ledger/env';
import { computerWord } from '@oddboro/ledger/system-words';
import {
  claudeSignInState,
  signInState,
  agentCommand,
  type SignInState
} from '#lib/server/agent-sign-in.ts';
import { claudeAccount, claudeSettings } from '#lib/server/claude.ts';
import { officeDrawsLooks, shownOfficeModel } from '#lib/server/claude.ts';
import { versionState, type VersionState } from '#lib/server/versions.ts';
import type { RequestHandler } from './$types';

/** One tool as the page gets it. */
export type AgentTool = {
  id: Agent;
  name: string;
  installed: boolean;
  signIn?: SignInState;
  commandsHow: CommandsHow;
  /** The model an Odd with none of its own runs on this tool, for the Office default card. */
  officeModel?: string;
} & VersionState;
/** A tool this system does not offer yet, with why, for setup's greyed row. */
export type LaterTool = { id: Agent; name: string; why: string };
/** An account the owner added, with its sign-in, for the Model tab's cards. */
export type AccountState = { id: string; agent: Agent; label: string; signIn: SignInState };

/** One account's sign-in: Claude Code's read with its own folder, the rest from their files. */
const stateOf = (tool: Agent, account?: string): Promise<SignInState> | SignInState =>
  tool === 'claude'
    ? claudeSignInState(
        account,
        // Only the Office account on the Claude plan falls back to the owner's own login.
        !account && claudeSettings().auth === 'plan' ? () => claudeAccount() : undefined
      )
    : signInState(tool, account);

export const GET: RequestHandler = async () => {
  const platform = currentPlatform();
  return json({
    // The picker's word for this computer.
    computer: computerWord(currentSystem()),
    office: officeAgent(),
    drawsLooks: officeDrawsLooks(),
    tools: await Promise.all(
      agentsOn(platform).map(async (id): Promise<AgentTool> => {
        const installed = !!agentCommand(id);
        return {
          id,
          name: AGENT_NAMES[id],
          installed,
          signIn: await stateOf(id),
          commandsHow: commandsHow(id, platform),
          officeModel: shownOfficeModel(id),
          ...(installed ? await versionState(id) : {})
        };
      })
    ),
    accounts: await Promise.all(
      (await listAccounts())
        .filter((a) => agentsOn(platform).includes(a.agent))
        .map(async (a): Promise<AccountState> => ({
          id: a.id,
          agent: a.agent,
          label: a.label,
          signIn: await stateOf(a.agent, a.id)
        }))
    ),
    later: AGENTS.flatMap((id): LaterTool[] => {
      const why = notOfferedWhy(id, platform);
      return why ? [{ id, name: AGENT_NAMES[id], why }] : [];
    })
  });
};

/** Pick the tool the office runs on. It applies to the next office run and the next hire. */
export const PUT: RequestHandler = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { office?: unknown };
  const agent = offeredAgent(b.office, currentPlatform());
  if (!agent) error(400, `Pick ${agentsOn(currentPlatform()).join(' or ')}`);
  writeEnv({ OFFICE_AGENT: agent });
  process.env.OFFICE_AGENT = agent;
  return json({ office: agent });
};
