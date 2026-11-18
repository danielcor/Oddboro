// Tools for an Odd's access: what it holds, finding tools, and asking for more.
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  asksFor,
  catalog,
  checkFolder,
  folderAskRefused,
  FOLDER_REFUSED,
  shownFolder,
  switchAskRefused,
  switchesOff,
  GOOGLE,
  googleConnectors,
  grantsFor,
  reconnectTask,
  raiseAsk,
  staffer
} from './office.ts';
import { accessInRun, askAboveLevel, capabilities, handOffsLine } from './capabilities.ts';
import { standingAsked, standingSaid, standingTitle } from './standing.ts';
import { commandsOnline } from './agents.ts';
import { currentPlatform } from './platform.ts';
import {
  AT_LEVEL,
  FOLDER_SAID,
  POSTAL_ID,
  grantWorks,
  LEVEL_NAME,
  levelAtMost,
  LEVELS,
  NOT_OWN_TOOLS,
  OWN_SWITCHES,
  SETTINGS_TAB,
  SWITCH_NAMES,
  switchesSaid
} from './access-words.ts';
import {
  BUILT_IN,
  ensureConnector,
  GITHUB_ADDRESS,
  GITHUB_ID,
  searchRegistry
} from './registry.ts';
import type { OwnSwitch as OwnSwitchName } from './access-words.ts';
import {
  GRANTABLE_TOOLS,
  isGrantable,
  OFFICE_TOOLS,
  officeToolsSaid,
  type OfficeToolId
} from './tools.ts';
import {
  CEILING,
  HAND_OFF_ID,
  ME,
  me,
  OWNER,
  has,
  offered,
  VIA,
  revisesArg,
  tool,
  text,
  json,
  line,
  refused
} from './mcp-run.ts';
import { raisedNote, placed } from './mcp-desk.ts';
import './mcp-mail.ts';

tool(
  'my_access',
  {
    description: `Your level, the tool your runs go through and what its own tools reach, the folders ${OWNER} gave you, and each outside tool ${OWNER} gave you: what it reaches, or why a run leaves it out for now.`,
    inputSchema: {}
  },
  async () => text(accessInRun(await capabilities(me), OWNER, process.env))
);

if (has('find_connectors'))
  tool(
    'find_connectors',
    {
      description: `Find MCP servers that would give you a tool you need: the office's own catalog first, then the public MCP Registry. Then call ask_for_access with the id or registry name. ${NOT_OWN_TOOLS}`,
      inputSchema: {
        need: z.string().describe('The service or job, e.g. "Trello cards" or "Notion pages".')
      }
    },
    async ({ need }) => {
      const words = need.toLowerCase().split(/\W+/).filter(Boolean);
      const added = await catalog();
      // The tools the office connects itself count as its own before anyone asks for one.
      const own = [
        ...added,
        ...BUILT_IN.filter((b) => !added.some((c) => c.id === b.id)).map((b) => ({
          ...b,
          readyAt: null
        }))
      ].filter((c) => words.some((w) => `${c.name} ${c.description}`.toLowerCase().includes(w)));
      let found: Awaited<ReturnType<typeof searchRegistry>> = [];
      let note = '';
      try {
        found = (await searchRegistry(need)).filter(
          (s) => !own.some((c) => c.registry === s.registry || c.id === s.registry)
        );
      } catch (e) {
        note = `\nThe MCP Registry did not answer: ${e instanceof Error ? e.message : e}`;
      }
      return json({
        catalog: own.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          ready: !!c.readyAt
        })),
        registry: found.map((c) => ({
          registry: c.registry,
          description: c.description,
          repository: c.repository,
          runsAs: c.kind ?? null,
          needs: [...(c.config?.secrets ?? []), ...(c.config?.headers ?? [])],
          unsupported: c.unsupported
        })),
        note: note || undefined
      });
    }
  );

if (has('ask_for_access'))
  tool(
    'ask_for_access',
    {
      description: `Ask ${OWNER} to connect a tool for you. Pass a catalog id or registry name from find_connectors, or the https address of a hosted MCP server. Ask for the lowest level that does the job: read to look, write to change things in the tool (needs Draft or Act; at Draft each change waits for ${OWNER}'s yes). For a second Google account of Gmail or Google Drive, pass that connector with another_account. If they approve, they get numbered steps to connect it, and it shows up in my_access when done. ${NOT_OWN_TOOLS}${raisedNote}`,
      inputSchema: {
        connector: z.string(),
        level: z
          .enum(['read', 'write'])
          .describe('read to look, write to change things in the tool.'),
        why: z.string().describe('What job this access is for, in one or two sentences.'),
        connect_only: z
          .boolean()
          .optional()
          .describe(
            'Set true when a separate proposal or job will do the work. This request only connects the tool. By default the Odd picks up its waiting work as soon as access is ready.'
          ),
        key_header: z
          .string()
          .max(64)
          .optional()
          .describe(
            `Only for an https address that takes a key instead of a sign-in: the name of the header the key goes in, as the server's docs or ${OWNER} give it, e.g. x-api-key or Authorization. ${OWNER} pastes the key on their desk. Never ask for the key itself. Never for GitHub, which signs in (catalog id ${GITHUB_ID}).`
          ),
        another_account: z
          .boolean()
          .optional()
          .describe(
            `Only for Gmail or Google Drive, for each Google account beyond the first. When ${OWNER} uses more than one, ask for all of them in one run: the first without another_account, then one ask with it for each further account. ${OWNER} signs in to each as a tool of its own.`
          ),
        revises: revisesArg
      }
    },
    async ({
      connector: wanted,
      level: asked,
      why,
      key_header,
      another_account,
      connect_only,
      revises
    }) => {
      const on = await placed({});
      if ('problem' in on) return refused(on.problem);
      const level = asked === 'write' ? 'act' : 'read';
      if (!grantWorks(level, me.permission))
        return text(askAboveLevel(me.permission, asked, OWNER));
      // Any address on GitHub's server is the catalog's GitHub, which signs in:
      // an Odd's key header there would have the owner make a token.
      const github = GITHUB_ADDRESS.test(wanted.trim());
      const found = await ensureConnector(
        github ? GITHUB_ID : wanted,
        key_header && !github ? { keyHeader: key_header.trim() } : undefined
      );
      if (!found.connector) return text(`${found.problem} Use find_connectors.`);
      const conn = found.connector;
      if (conn.id === POSTAL_ID && level !== 'read')
        return refused('Physical mail only allows Read only access.');
      const product = conn.config.google;
      if (another_account && !product)
        return refused(`another_account is only for Gmail and Google Drive.`);
      // Another account only beside a first one: connected, or on its way (this
      // Odd's open ask for it, or a grant still being connected). So an Odd that
      // needs two mailboxes can ask for both at once, on its first day.
      const firstOnItsWay = async (p: NonNullable<typeof product>) => {
        const ids = new Set((await googleConnectors(p)).map((c) => c.id));
        const asking = (await asksFor(ME)).some(
          (a) =>
            a.kind === 'access' &&
            a.status === 'open' &&
            !!a.access &&
            ids.has(a.access.connector) &&
            !a.access.another
        );
        return asking || (await grantsFor(ME)).some((g) => ids.has(g.connectorId));
      };
      const another =
        another_account &&
        product &&
        ((await googleConnectors(product)).some((c) => c.readyAt) || (await firstOnItsWay(product)))
          ? product
          : undefined;
      if (another_account && !another)
        return refused(
          `Ask for ${GOOGLE[product!].id} without another_account first. Then ask again with another_account for each further account, in the same run if you need them all.`
        );
      const plain = another ? GOOGLE[another].name : conn.name;
      const title = another
        ? `Connect another ${plain} account (${asked})`
        : `Connect ${conn.name} (${asked})`;
      const connection = another
        ? `You get numbered steps to sign in to another Google account for ${plain}, for ${me.name}.`
        : conn.readyAt
          ? `${me.name} can use ${conn.name} at once: you connected it already, so there are no steps.`
          : `You get numbered steps to connect ${conn.name} for ${me.name}.`;
      const { ask, precedent } = await raiseAsk(ME, {
        ...on,
        title,
        why,
        ifApproved: connect_only
          ? `${connection} This request only connects the tool. The work starts separately.`
          : connection,
        revises,
        access: {
          connector: conn.id,
          level,
          ...(another ? { another } : {}),
          ...(connect_only && { connectOnly: true })
        }
      });
      return text(
        `Ask ${ask.id} is on ${OWNER}'s desk.` +
          (precedent.length
            ? `\n${OWNER}'s closest past decisions:\n${precedent.map(line).join('\n')}`
            : '')
      );
    }
  );

// A folder on this computer, outside the office: only the owner gives one,
// from this ask's card or the Settings tab. Checked here with the Settings
// tab's rules, so a folder they could not give never reaches the desk.
tool(
  'ask_for_folder',
  {
    description: `Ask ${OWNER} for a folder on this computer, outside the office, to read or to read and change. Ask with this instead of giving ${OWNER} steps for your ${SETTINGS_TAB} tab: they give it with one click, or a narrower one. Ask for the narrowest folder and the lowest level the work needs: read to look, write only to change files there. You reach it from your next run, which starts when they give it. my_access lists the folders you have.${raisedNote}`,
    inputSchema: {
      path: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe(
          'The folder\'s full path, starting with /, ~ or a drive letter, e.g. "~/Documents/Taxes".'
        ),
      level: z.enum(['read', 'write']).describe('read to look, write to change files there.'),
      why: z.string().max(1000).describe('What work needs it, in one or two plain sentences.'),
      revises: revisesArg
    }
  },
  async ({ path, level, why, revises }) => {
    const on = await placed({});
    if ('problem' in on) return refused(on.problem);
    if (!isAbsolute(path) && !/^~(?=$|[\\/])/.test(path))
      return refused("Give the folder's full path, starting with /, ~ or a drive letter.");
    const checked = checkFolder(path);
    if ('refused' in checked) return refused(checked.refused);
    if ('warning' in checked) return refused(FOLDER_REFUSED.broad);
    const held = folderAskRefused((await staffer(ME)) ?? me, checked.real, level);
    if (held) return refused(held);
    const shown = shownFolder(checked.real);
    const { ask } = await raiseAsk(ME, {
      ...on,
      kind: 'folder',
      title: `${level === 'write' ? 'Read and change' : 'Read'} ${shown}`,
      why,
      ifApproved: `The office gives ${me.name} ${shown} (${FOLDER_SAID[level]}), or the folder and level you pick, and ${me.name} picks up the work with it.`,
      folder: { path: checked.real, level },
      revises,
      via: VIA
    });
    return text(
      `Ask ${ask.id} is on ${OWNER}'s desk. When they give the folder, a new run of yours picks up the work with it. Check my_asks later for their decision.`
    );
  }
);

// Run commands or Browse the web: only the owner turns one on, from this ask's
// card or the Settings tab. Checked here as the Settings tab checks it, so a
// switch they could not turn on never reaches the desk.
tool(
  'ask_for_switch',
  {
    description: `Ask ${OWNER} to turn on ${SWITCH_NAMES.commands} (a shell, to run commands like git, npm or a script) or ${SWITCH_NAMES.web} (search and read web pages) for you, or both. Ask with this instead of giving ${OWNER} steps for your ${SETTINGS_TAB} tab: they turn it on with one click. Ask only for what the work needs; work that downloads, such as git clone or npm install, needs both. You have it from your next run, which starts when they say yes. my_access says which you have.${raisedNote}`,
    inputSchema: {
      switches: z
        // OWN_SWITCHES is a literal list of two, so it is never empty.
        .array(z.enum(OWN_SWITCHES as [OwnSwitchName, ...OwnSwitchName[]]))
        .min(1)
        .max(2)
        .describe(`commands for ${SWITCH_NAMES.commands}, web for ${SWITCH_NAMES.web}.`),
      why: z.string().max(1000).describe('What work needs it, in one or two plain sentences.'),
      revises: revisesArg
    }
  },
  async ({ switches, why, revises }) => {
    const on = await placed({});
    if ('problem' in on) return refused(on.problem);
    const now = (await staffer(ME)) ?? me;
    const held = switchAskRefused(now, switches);
    if (held) return refused(held);
    const off = switchesOff(now, switches);
    const online = commandsOnline(now.agent, currentPlatform(), {
      commands: now.commands || off.includes('commands'),
      web: now.web || off.includes('web')
    });
    const { ask } = await raiseAsk(ME, {
      ...on,
      kind: 'switch',
      title: `Turn on ${switchesSaid(off)}`,
      why,
      ifApproved: `The office turns on ${switchesSaid(off)} for ${me.name}, as the ${SETTINGS_TAB} tab does, and ${me.name} picks up the work with it.${online ? ` With both on, ${me.name}'s commands can reach the internet.` : ''}`,
      switches: off,
      revises,
      via: VIA
    });
    return text(
      `Ask ${ask.id} is on ${OWNER}'s desk. When they turn it on, a new run of yours picks up the work with it. Check my_asks later for their decision.`
    );
  }
);

// A level: only the owner raises it, from this ask's card or the Settings
// tab. A level the Odd holds already never reaches the desk. What it says of
// work another Odd hands this Odd follows the owner's choice for it
// (`actsOnHandOffs`), which they make each time they put it at Act.
const handOffsAtAct =
  me.permission === 'act'
    ? handOffsLine(me.actsOnHandOffs, OWNER)
    : `When ${OWNER} puts you at Act, they also choose whether work another Odd hands you runs at Act or at Draft at most.`;
tool(
  'ask_for_level',
  {
    description: `Ask ${OWNER} to raise your level when your work keeps needing more than it lets you do. Draft: you prepare changes outside the office, and each waits for their yes. Act: you use a tool they connected for you at read and write without asking each time, from their yes until they lower it. For a single change, do not ask for Act: at Draft, prepare it so it waits for their yes, or ask for that one action with raise_ask. Ask for Act only for changes that repeat, where a yes for each would be a chore. Ask with this instead of giving ${OWNER} steps for your ${SETTINGS_TAB} tab: they raise it with one click. Ask for the lowest level the work needs. ${handOffsAtAct} my_access says your level.${raisedNote}`,
    inputSchema: {
      level: z.enum(LEVELS).describe('The level the work needs.'),
      why: z.string().max(1000).describe('What work needs it, in one or two plain sentences.'),
      revises: revisesArg
    }
  },
  async ({ level, why, revises }) => {
    const on = await placed({});
    if ('problem' in on) return refused(on.problem);
    const now = (await staffer(ME)) ?? me;
    // A run held below its level only by serving a colleague's hand-off is
    // told why, since it was told a lower level than this refusal names: the
    // owner chose to be asked first on such work. Handed-back and resume runs
    // are capped too, for other reasons.
    if (levelAtMost(level, now.permission))
      return refused(
        `Your level is ${LEVEL_NAME[now.permission]} already.${
          HAND_OFF_ID !== undefined && CEILING
            ? ` Work another Odd hands you runs at ${LEVEL_NAME[CEILING]} whatever your level, since ${OWNER} chose to be asked first there, so raising it does not change this run.`
            : ''
        }`
      );
    const { ask } = await raiseAsk(ME, {
      ...on,
      kind: 'level',
      title: `Raise ${now.name} from ${LEVEL_NAME[now.permission]} to ${LEVEL_NAME[level]}`,
      why,
      ifApproved: `The office raises ${now.name} from ${LEVEL_NAME[now.permission]} to ${LEVEL_NAME[level]}, as the ${SETTINGS_TAB} tab does, and ${now.name} picks up the work with it. ${AT_LEVEL[level](now.name)} ${now.name} stays at ${LEVEL_NAME[level]} until you lower it in the ${SETTINGS_TAB} tab.`,
      level,
      revises,
      via: VIA
    });
    // The run that carries out a yes raised in a colleague's hand-off serves
    // that hand-off, so it stays at Draft whatever level the yes gives, unless
    // the owner lets this Odd act on its own on such work, which a yes to Act
    // asks them right after.
    return text(
      HAND_OFF_ID !== undefined
        ? `Ask ${ask.id} is on ${OWNER}'s desk. When they say yes, your level is ${LEVEL_NAME[level]}, and a new run of yours picks up the work; it serves a colleague's hand-off, so it works at Draft at most${level === 'act' ? `, unless ${OWNER} lets you act on your own on work from colleagues when they say yes` : ''}. Check my_asks later for their decision.`
        : `Ask ${ask.id} is on ${OWNER}'s desk. When they say yes, a new run of yours picks up the work at ${LEVEL_NAME[level]}. Check my_asks later for their decision.`
    );
  }
);

// Office tools: only the owner turns one on, from this ask's card or the
// Settings tab. Only the ones the Settings tab grants, and only ones the Odd
// lacks, reach the desk. Named by name in the description, since an Odd
// reads an id only for a tool it holds.
const lackedTools = OFFICE_TOOLS.filter((t) => isGrantable(t.id) && !me.tools.includes(t.id));
tool(
  'ask_for_office_tool',
  {
    description: `Ask ${OWNER} to turn on office tools you lack when a job needs them. Ask with this instead of giving ${OWNER} steps for your ${SETTINGS_TAB} tab: they turn them on with one click. Ask only for what the work needs. You have them from your next run, which starts when they say yes. The office tools you lack:${lackedTools.map((t) => `\n${t.name}: ${t.does}`).join('')}${raisedNote}`,
    inputSchema: {
      tools: z
        // GRANTABLE_TOOLS is never empty: setting-asks.test.ts pins it.
        .array(z.enum(GRANTABLE_TOOLS as [OfficeToolId, ...OfficeToolId[]]))
        .min(1)
        .max(GRANTABLE_TOOLS.length)
        .describe('The office tools the work needs, from the list above.'),
      why: z.string().max(1000).describe('What work needs them, in one or two plain sentences.'),
      revises: revisesArg
    }
  },
  async ({ tools, why, revises }) => {
    const on = await placed({});
    if ('problem' in on) return refused(on.problem);
    const now = (await staffer(ME)) ?? me;
    const lacked = tools.filter((t) => !now.tools.includes(t));
    if (!lacked.length) return refused(`You already have ${officeToolsSaid(tools)}.`);
    const said = officeToolsSaid(lacked);
    const { ask } = await raiseAsk(ME, {
      ...on,
      kind: 'office_tool',
      title: `Turn on ${said}`,
      why,
      ifApproved: `The office turns on ${said} for ${now.name}, as the ${SETTINGS_TAB} tab does, and ${now.name} picks up the work with it.${OFFICE_TOOLS.filter(
        (t) => lacked.includes(t.id)
      )
        .map((t) => `\n- ${t.name}: ${t.does}`)
        .join('')}`,
      officeTools: lacked,
      revises,
      via: VIA
    });
    return text(
      `Ask ${ask.id} is on ${OWNER}'s desk. When they turn them on, a new run of yours picks up the work with them. Check my_asks later for their decision.`
    );
  }
);

// A standing yes: tools of a service the Odd uses without asking. Offered only
// with a write grant (`withWrite`), where at Draft each change otherwise waits
// on the desk. The Odd offers it once, for a tool that only prepares a change
// another call then makes real; a no stands (`standingAsked`).
const writeGrants = (await grantsFor(ME)).filter((g) => g.level === 'act');
if (offered('ask_for_standing_yes'))
  tool(
    'ask_for_standing_yes',
    {
      description: `Ask ${OWNER} to let you use one or more tools of a service without asking each time. At Draft, each call that changes something waits on ${OWNER}'s desk; with this yes, calls to these tools go straight through from then on, and every other call that changes something still waits. Offer it for a tool that only prepares a change another call then makes real: a preview, a staged edit, a draft. The time to offer it is after ${OWNER} approved such a call and you saw that a second call was needed to apply it. Never ask for a tool that sends, publishes, deletes, pays or makes a change real by itself. Ask once: if ${OWNER} says no, keep asking for each call.${raisedNote}`,
      inputSchema: {
        connector: z
          .enum(writeGrants.map((g) => g.connectorId) as [string, ...string[]])
          .describe('The service, by the id my_access lists.'),
        tools: z
          .array(z.string())
          .min(1)
          .max(5)
          .describe('The tool names, exactly as the service lists them.'),
        why: z
          .string()
          .max(1000)
          .describe(
            `What these tools do and why using them without asking is safe, in one or two plain sentences ${OWNER} reads on their desk. Name the call that makes the change real, which still waits for their yes.`
          )
      }
    },
    async ({ connector: id, tools, why }) => {
      const on = await placed({});
      if ('problem' in on) return refused(on.problem);
      const asked = await standingAsked(ME, { connector: id, tools }, OWNER);
      if ('problem' in asked) return refused(asked.problem);
      const { service } = asked;
      const { ask } = await raiseAsk(ME, {
        ...on,
        kind: 'standing',
        title: standingTitle(asked.tools, service),
        why,
        ifApproved: `${me.name} uses ${standingSaid(asked.tools, service)} without asking from now on: each call to ${asked.tools.length === 1 ? 'it' : 'them'} goes straight through. Every other call that changes something in ${service} still waits for your yes. You can take it back on ${me.name}'s ${SETTINGS_TAB} tab, under Services.`,
        standing: { connector: id, tools: asked.tools },
        via: VIA
      });
      return text(
        `Ask ${ask.id} is on ${OWNER}'s desk. If they say yes, your runs use ${asked.tools.join(', ')} without asking from then on. Nothing else changes: carry on with the work as it is.`
      );
    }
  );

tool(
  'reconnect_access',
  {
    description: `A tool ${OWNER} already gave you stopped working: its tools fail to load, or it turns down its key or sign-in. This puts the office's own steps to connect it again on ${OWNER}'s desk, with a box for the new key or a Sign in button, then a Connect button, and no ask, since they said yes once. Never write those steps yourself with give_owner_a_task. Pass get_key only when the tool takes a key: how to get a new one, one action per step, naming the exact page and button.`,
    inputSchema: {
      connector: z.string().describe('The id my_access lists.'),
      problem: z
        .string()
        .max(300)
        .describe('What went wrong and since when, in one or two sentences, with the error.'),
      get_key: z
        .array(z.string().max(200))
        .max(4)
        .optional()
        .describe(
          'How to get a new key, e.g. ["Open https://console.apify.com/settings/integrations.", "Copy your Personal API token. It starts with apify_api_."]'
        )
    }
  },
  async ({ connector: id, problem, get_key = [] }) => {
    const r = await reconnectTask(ME, id, problem, get_key);
    if ('problem' in r) return text(r.problem);
    if (r.already)
      return text(
        `Task ${r.task.id} to connect it is already on ${OWNER}'s desk. Point them to it.`
      );
    return text(
      `Task ${r.task.id} is on ${OWNER}'s desk. You hear when they finish it.${r.keptOut ? ` ${id} takes no key, so your get_key steps were left out. Never tell ${OWNER} to paste a key for it.` : ''}`
    );
  }
);
