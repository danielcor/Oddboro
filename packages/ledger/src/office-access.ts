// Connectors and grants: giving, changing and taking back access to a tool.
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from './db.ts';
import { deleteSecret, getSecret } from './secrets.ts';
import { fixedError } from './errors.ts';
import { type Tx } from './threads.ts';
import {
  connectors,
  grants,
  staff,
  tasks,
  type AccessRequest,
  type GoogleProduct,
  type Step
} from './schema.ts';
import { grantWorks, POSTAL_ID, POSTAL_NAME, type Level } from './access-words.ts';
import type { AskRow, TaskRow, GrantRow, ConnectorRow } from './office.ts';
import { staffer } from './office-staff.ts';
import { record } from './office-ledger.ts';
import { task } from './office-tasks.ts';
import { ownerName } from './office-usage.ts';
import { transitionWork } from './work/apply.ts';
import type { EventOf, NewTask } from './work/events.ts';
import { LEFT_RAISES_NOTHING } from './work/threads.ts';

// Access

/**
 * Grant access, then give the owner whatever steps connecting it still needs.
 * Says whether that put a task on the desk (a tool already connected needs
 * none), and which connector it granted: with `another`, a new one for one
 * more Google account, made once the grant can go.
 */
export async function grantAccess(
  staffId: string,
  req: AccessRequest,
  askId?: number
): Promise<{ task: boolean; connector: string }> {
  const who = await staffer(staffId);
  const named = await connector(req.connector);
  if (!who || !named) throw fixedError('No such Odd or connector');
  if (named.id === POSTAL_ID && req.level !== 'read')
    throw new Error('Physical mail only allows Read only access.');
  if (req.level === 'draft')
    throw new Error(`${named.name} connects to read, or to read and write`);
  if (!grantWorks(req.level, who.permission))
    throw new Error(`${who.name} holds ${who.permission}, so it cannot be given ${req.level}`);
  if (req.another && named.config.google !== req.another)
    throw new Error(`Only Gmail and Google Drive take another account`);
  const conn = req.another ? await addGoogleAccount(req.another) : named;
  const saveGrant = (store: Tx | typeof db) =>
    store
      .insert(grants)
      .values({ staffId, connectorId: conn.id, level: req.level, askId })
      .onConflictDoUpdate({
        target: [grants.staffId, grants.connectorId],
        set: { level: req.level, askId, grantedAt: new Date() }
      });
  if (conn.id === POSTAL_ID) {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ ready: connectors.readyAt })
        .from(connectors)
        .where(eq(connectors.id, conn.id))
        .for('update');
      if (!current?.ready) {
        const pending = await tx
          .select({ id: grants.staffId })
          .from(grants)
          .where(eq(grants.connectorId, conn.id));
        if (pending.some((g) => g.id !== staffId))
          throw new Error('Choose the office mailbox before granting another Odd access.');
      }
      await saveGrant(tx);
    });
  } else await saveGrant(db);
  const steps = connectSteps(conn);
  if (steps.length) {
    // A further Google account not signed in yet reads as one, beside the one already there.
    const g = conn.config.google;
    const called =
      g && conn.id !== GOOGLE[g].id && !conn.config.account
        ? `another ${conn.name} account`
        : conn.name;
    // Through the work core: an Odd that left since the check above gets no
    // task, and the task waits on any other change to this tool's connect tasks.
    const went = await transitionWork({
      kind: 'taskGiven',
      task: {
        staffId,
        askId,
        title: `Connect ${called} for ${who.name}`,
        why: `${who.name} needs ${conn.name} at ${req.level} level.`,
        steps
      }
    });
    if ('refused' in went)
      throw new Error(
        went.refused === LEFT_RAISES_NOTHING
          ? `${who.name} left the office, so there is nothing to connect.`
          : went.refused
      );
    return { task: true, connector: conn.id };
  }
  // Already connected: the staffer can use it now, and nothing waits on the owner.
  await record({
    kind: 'access',
    actor: 'owner',
    title: `Gave ${who.name} ${conn.name} (${req.level})`,
    body: `${conn.name} was already connected, so there were no steps for ${await ownerName()}.`,
    askId
  });
  // An ask's carry-out is its caller's to start (`decide`), since one answer may settle twins.
  return { task: false, connector: conn.id };
}

/**
 * A tool the owner already gave a staffer stopped working: its connect steps go
 * on the desk again, after the staffer's own steps for getting a new key. There
 * is no ask, since the owner said yes once. A tool has one open reconnect at a time.
 * Only a tool that takes a key has a box for one, so the staffer's key steps
 * go only on its task. For a tool that signs in, or needs nothing, they would
 * send the owner looking for a box that is not there (`keptOut` says so).
 */
export async function reconnectTask(
  staffId: string,
  connectorId: string,
  problem: string,
  getKey: string[]
): Promise<{ task: TaskRow; already: boolean; keptOut: boolean } | { problem: string }> {
  const who = await staffer(staffId);
  const conn = await connector(connectorId);
  if (!who || !conn) return { problem: `No connector named ${connectorId}.` };
  const [grant] = await db
    .select()
    .from(grants)
    .where(and(eq(grants.staffId, staffId), eq(grants.connectorId, conn.id)));
  if (!grant) return { problem: `You were never given ${conn.name}. Use ask_for_access.` };
  const takesKey = secretNames(conn).some((n) => n !== 'oauth');
  const { row, already } = await giveConnectTask(
    {
      staffId,
      title: `Reconnect ${conn.name} for ${who.name}`,
      why: problem,
      steps: [
        ...(takesKey ? getKey : []).map((text) => ({ text, done: false })),
        ...connectSteps(conn, true)
      ]
    },
    { connector: conn.id }
  );
  return { task: row, already, keptOut: !already && !takesKey && getKey.length > 0 };
}

/**
 * The owner wants an AWS tool on another role or Region: its one desk step
 * goes on the desk again, from the office, starting on what it uses now.
 * Picking connects it again. A tool has one open at a time.
 */
export async function changeAwsTask(connectorId: string): Promise<TaskRow> {
  const conn = await connector(connectorId);
  if (!conn || !isAws(conn.id)) throw new Error('Only an AWS tool has a role and Region to change');
  const { row } = await giveConnectTask(
    {
      staffId: null,
      title: `Change the role or Region for ${conn.name}`,
      why: `You asked to change the AWS role or Region ${conn.name} uses.`,
      steps: connectSteps(conn, true)
    },
    { connector: conn.id, aws: true }
  );
  return row;
}

/**
 * Give a connect task in the office's name, unless an open one with a step
 * for the tool answers it (`oneOpen`): the check and the insert are one
 * transition, so two at once give one task.
 */
async function giveConnectTask(
  t: NewTask,
  oneOpen: NonNullable<EventOf<'taskGiven'>['oneOpen']>
): Promise<{ row: TaskRow; already: boolean }> {
  const went = await transitionWork({ kind: 'taskGiven', task: t, oneOpen });
  if ('refused' in went) throw new Error(went.refused);
  const already = went.change.result?.already;
  const row = await task(already ?? went.real({ ref: 'task' }));
  if (!row) throw fixedError('A task was given that is not there.');
  return { row, already: already !== undefined };
}

/** The longest name the owner can give a service. */
export const SERVICE_NAME_MAX = 60;

/**
 * The owner names a service, such as Open Brain for a server they added by
 * its address. Odds read the new name too, since every run reads the row.
 */
export async function renameConnector(id: string, name: string): Promise<void> {
  const c = await connector(id);
  if (!c) throw new Error('No such service');
  const named = name.trim().replace(/\s+/g, ' ');
  if (!named || named.length > SERVICE_NAME_MAX)
    throw new Error(`Give it a name of 1 to ${SERVICE_NAME_MAX} characters.`);
  if (named === c.name) return;
  await db.update(connectors).set({ name: named }).where(eq(connectors.id, id));
  await record({ kind: 'access', actor: 'owner', title: `Renamed ${c.name} to ${named}` });
}

/** Each service's name by its id, for the lines that say what an Odd is doing. */
export async function serviceNames(): Promise<Record<string, string>> {
  const rows = await db.select({ id: connectors.id, name: connectors.name }).from(connectors);
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/** A service in the office and every Odd that holds it, for the owner's Services window. */
export type OfficeService = {
  id: string;
  name: string;
  description: string;
  ready: boolean;
  aws: boolean;
  odds: { id: string; name: string; level: Level }[];
};

/** Every service an Odd holds or that is connected, by name, with who holds it. */
export async function services(): Promise<OfficeService[]> {
  const held = await db
    .select({
      connectorId: grants.connectorId,
      level: grants.level,
      id: staff.id,
      name: staff.name
    })
    .from(grants)
    .innerJoin(staff, eq(grants.staffId, staff.id))
    .orderBy(asc(staff.name));
  return (await catalog())
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      ready: !!c.readyAt,
      aws: isAws(c.id),
      odds: held
        .filter((h) => h.connectorId === c.id)
        .map((h) => ({ id: h.id, name: h.name, level: h.level }))
    }))
    .filter((s) => s.ready || s.odds.length);
}

/**
 * The AWS tools, by what the owner wants: their secrets' names (and the
 * office's keys), reading their account, or building in it. The office signs
 * in to AWS itself, once for all three (the office's `aws.ts`).
 */
export const AWS_SECRETS_ID = 'aws-secrets';
export const AWS_READ_ID = 'aws-read';
export const AWS_BUILD_ID = 'aws-build';
export const AWS_IDS: readonly string[] = [AWS_SECRETS_ID, AWS_READ_ID, AWS_BUILD_ID];
export const isAws = (id: string): boolean => AWS_IDS.includes(id);
/** Where the one AWS sign-in sits in the secret store. */
export const AWS_SIGN_IN = { id: 'aws', name: 'sso' } as const;

const AWS_STEP: Record<string, string> = {
  [AWS_SECRETS_ID]:
    'Sign in to AWS, then pick the role the office reads your secrets with. Your Odds see secret names only, never their values.',
  [AWS_READ_ID]:
    'Sign in to AWS, then pick the role your Odds read AWS with. The office checks that it cannot read a secret value.',
  [AWS_BUILD_ID]:
    'Sign in to AWS, then pick the role your Odds build in AWS with. The office checks that it cannot read a secret value.'
};

/** The steps that connect a tool. `again` gives them even when it looks connected. */
function connectSteps(conn: ConnectorRow, again = false): Step[] {
  if (conn.readyAt && !again) return [];
  const key = `oauth:${conn.id}`;
  // One step: picking the role connects the tool too.
  if (isAws(conn.id))
    return [{ text: AWS_STEP[conn.id], done: false, action: { kind: 'aws', connector: conn.id } }];
  return [
    ...(conn.config.oauth
      ? [
          {
            text: `Click Sign in. ${conn.config.oauth === 'google' ? 'Google' : conn.name}'s sign-in page opens in a new tab.`,
            done: false,
            key,
            action: {
              kind: 'oauth' as const,
              connector: conn.id,
              ...(conn.config.oauth === 'google' ? { google: true } : {})
            }
          },
          {
            text: 'Approve access on that page. This step ticks itself when it lands.',
            done: false,
            key
          }
        ]
      : []),
    ...[...(conn.config.secrets ?? []), ...(conn.config.headers ?? [])].map((name) => ({
      // A server named by its address has one header, and it holds the key.
      text: `Paste ${name === 'Authorization' || (conn.kind === 'http' && !conn.registry) ? `your ${conn.name} key` : `the ${name} value for ${conn.name}`} below. It goes in this computer's password store, never the database.`,
      done: false,
      action: { kind: 'secret' as const, connector: conn.id, name }
    })),
    ...(conn.id === POSTAL_ID
      ? [
          {
            text: 'Choose the LegalZoom mailbox this Odd can read. Access includes every recipient in that mailbox.',
            done: false,
            action: { kind: 'postal' as const, connector: conn.id }
          }
        ]
      : [
          {
            text: `Click Connect. The office starts ${conn.name} and lists its tools, marking the ones that only read.`,
            done: false,
            action: { kind: 'tools' as const, connector: conn.id }
          }
        ])
  ];
}

export async function connector(id: string): Promise<ConnectorRow | undefined> {
  const [row] = await db.select().from(connectors).where(eq(connectors.id, id));
  return row;
}

export async function catalog(): Promise<ConnectorRow[]> {
  return db.select().from(connectors).orderBy(asc(connectors.name));
}

export async function addConnector(c: typeof connectors.$inferInsert): Promise<ConnectorRow> {
  const [row] = await db.insert(connectors).values(c).onConflictDoNothing().returning();
  return row ?? (await connector(c.id))!;
}

/**
 * The Google products the office serves itself: the connector each starts
 * with (migration 0009_google), and its plain name before a sign-in names
 * the account. A further account of one is a connector of its own
 * (`addGoogleAccount`). Code looks a Google connector up by
 * `config.google`, never by its id.
 */
export const GOOGLE: Record<GoogleProduct, { id: string; name: string; description: string }> = {
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    description: "Search, read, label, draft and send mail in the owner's Gmail."
  },
  drive: {
    id: 'google-drive',
    name: 'Google Drive',
    description: "Find and read files in the owner's Google Drive, and write Docs and Sheets."
  }
};

/** Whether two Google addresses are one account: Google ignores case. */
const sameAccount = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Every connector of one Google product, or of both, oldest first. */
export async function googleConnectors(product?: GoogleProduct): Promise<ConnectorRow[]> {
  const rows = await db
    .select()
    .from(connectors)
    .orderBy(asc(connectors.createdAt), asc(connectors.id));
  return rows.filter((c) => (product ? c.config.google === product : !!c.config.google));
}

/**
 * One more Google account of a product: a new connector, `gmail-2`,
 * `gmail-3` and so on, named plainly until its sign-in names the account.
 */
export async function addGoogleAccount(product: GoogleProduct): Promise<ConnectorRow> {
  const g = GOOGLE[product];
  for (;;) {
    const taken = (await googleConnectors(product)).map((c) => c.id);
    let n = 2;
    while (taken.includes(`${g.id}-${n}`)) n++;
    const [row] = await db
      .insert(connectors)
      .values({
        id: `${g.id}-${n}`,
        name: g.name,
        description: g.description,
        kind: 'builtin',
        config: { oauth: 'google', google: product }
      })
      .onConflictDoNothing()
      .returning();
    // Two at once can pick the same number: the second tries the next.
    if (row) return row;
  }
}

/**
 * The Gmail account a reply or filter goes through: the connector it names,
 * or, with none named, the first Gmail account its Odd holds.
 */
export async function mailboxOf(a: AskRow): Promise<ConnectorRow | undefined> {
  const named = a.reply?.connector ?? a.filter?.connector;
  if (named) return connector(named);
  const held = (await grantsFor(a.staffId)).find((g) => g.connector.config.google === 'gmail');
  return held?.connector ?? (await googleConnectors('gmail'))[0];
}

/** Give a connector the name the owner sees. */
export async function nameConnector(id: string, name: string): Promise<void> {
  await db.update(connectors).set({ name }).where(eq(connectors.id, id));
}

/**
 * Another connector of the same Google product already signed in to this
 * address, if one is: one account is one connector.
 */
export async function googleAccountHeld(
  id: string,
  address: string
): Promise<ConnectorRow | undefined> {
  const c = await connector(id);
  if (!c?.config.google) return undefined;
  return (await googleConnectors(c.config.google)).find(
    (o) => o.id !== id && sameAccount(o.config.account, address)
  );
}

/**
 * A Google sign-in landed: the connector keeps the address and is named after
 * it ("Gmail (ada@example.com)"), so the owner and its Odds know whose mail
 * or files it reaches. Its sign-in step reads as it always does again.
 */
export async function signedInAs(id: string, address: string): Promise<void> {
  const c = await connector(id);
  if (!c?.config.google) return;
  await db
    .update(connectors)
    .set({
      name: `${GOOGLE[c.config.google].name} (${address})`,
      config: { ...c.config, account: address }
    })
    .where(eq(connectors.id, id));
  await sayOnSignIn(id);
}

/**
 * Put words before the sign-in step of a connector's open connect tasks, such
 * as why the last sign-in was not kept. None puts the step back as it was.
 */
export async function sayOnSignIn(id: string, words?: string): Promise<void> {
  const c = await connector(id);
  if (!c) return;
  const [plain] = connectSteps(c, true);
  if (!plain) return;
  const open = await db.select().from(tasks).where(eq(tasks.status, 'open'));
  for (const t of open) {
    const steps = t.steps.map((s) =>
      s.action?.kind === 'oauth' && s.action.connector === id
        ? { ...s, text: words ? `${words} ${plain.text}` : plain.text }
        : s
    );
    if (JSON.stringify(steps) !== JSON.stringify(t.steps))
      await db.update(tasks).set({ steps }).where(eq(tasks.id, t.id));
  }
}

/** Whether a connector holds a sign-in in the secret store. */
function signedIn(id: string): boolean {
  try {
    const saved = JSON.parse(getSecret(id, 'oauth') ?? '{}') as { tokens?: unknown };
    return !!saved.tokens;
  } catch {
    return false;
  }
}

/**
 * The other Google connectors that share this one's grant at Google. Google
 * ties a sign-in to the account and the office's client, not to the product,
 * so cancelling Gmail's would end the same account's Drive too. One whose
 * account is not known counts as shared, to be safe.
 */
async function sharesGrant(c: ConnectorRow): Promise<ConnectorRow[]> {
  return (await googleConnectors()).filter(
    (o) =>
      o.id !== c.id &&
      signedIn(o.id) &&
      (!c.config.account || !o.config.account || sameAccount(o.config.account, c.config.account))
  );
}

/**
 * Tell Google to cancel a sign-in before the office forgets it, so the
 * permission is gone from the owner's Google account too, not just from this
 * computer. Best effort: false when Google could not be told.
 */
async function revokeAtGoogle(id: string): Promise<boolean> {
  let token: string | undefined;
  try {
    const saved = JSON.parse(getSecret(id, 'oauth') ?? '{}') as {
      tokens?: { refresh_token?: string; access_token?: string };
    };
    token = saved.tokens?.refresh_token ?? saved.tokens?.access_token;
  } catch {
    return false;
  }
  if (!token) return true;
  try {
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000)
    });
    // 400 means Google no longer knows the token: already cancelled.
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

/** Change how the office starts a connector, e.g. when a server turns out to need no sign-in. */
export async function setConnectorConfig(
  id: string,
  config: ConnectorRow['config']
): Promise<void> {
  await db.update(connectors).set({ config }).where(eq(connectors.id, id));
}

/**
 * The names a tool's secrets go by in the system's secret store: its keys,
 * and a hosted server's sign-in. `all` adds the sign-in of any hosted server,
 * since one can leave tokens behind even after it turned out to need none.
 */
function secretNames(c: Pick<ConnectorRow, 'kind' | 'config'>, all = false): string[] {
  return [
    ...(c.config.secrets ?? []),
    ...(c.config.headers ?? []),
    ...(c.config.oauth || (all && c.kind === 'http') ? ['oauth'] : [])
  ];
}

/**
 * Drop the open tasks whose steps connect a tool, for one staffer or for all
 * of them, and wake the work parked on each, in one transaction.
 */
async function dropConnectTasks(id: string, staffId?: string): Promise<void> {
  const went = await transitionWork({ kind: 'connectTasksDropped', connector: id, staffId });
  // The decider drops what is open and never refuses.
  if ('refused' in went) throw fixedError('Dropping connect tasks was refused.');
}

/**
 * A tool not connected yet changes how it lets the office in, like a key in a
 * header instead of a sign-in. Its open connect tasks name the old way, so
 * they drop, and the next grant puts the new steps on the desk. Keys and
 * sign-ins the new way does not use come out of the secret store.
 */
export async function reconfigureConnector(
  id: string,
  config: ConnectorRow['config']
): Promise<void> {
  const before = await connector(id);
  await db.update(connectors).set({ config }).where(eq(connectors.id, id));
  await dropConnectTasks(id);
  if (!before) return;
  const keep = secretNames({ kind: before.kind, config });
  for (const name of secretNames(before, true)) if (!keep.includes(name)) deleteSecret(id, name);
}

/**
 * What happened at Google when the office forgot a Google connector: told
 * (true), could not be told (false), or left alone, since another connector
 * still uses the same Google account (`kept`, those connectors' names).
 */
type GoogleTold = boolean | { kept: string[] };

/**
 * No Odd holds a tool any more: its keys and sign-ins come out of the secret
 * store, so none sit there unused, and it needs connecting again before the
 * next grant uses it. True when there was something to remove. A further
 * Google account (`gmail-2`) leaves the catalog too, since the owner adds
 * another whenever they want one.
 */
async function forgetConnector(id: string): Promise<{ forgot: boolean; googleTold?: GoogleTold }> {
  const c = await connector(id);
  if (!c) return { forgot: false };
  if (isAws(id)) return { forgot: await forgetAws(c) };
  const product = c.config.google;
  let googleTold: GoogleTold | undefined;
  if (c.config.oauth === 'google' && signedIn(id)) {
    const shared = await sharesGrant(c);
    googleTold = shared.length ? { kept: shared.map((o) => o.name) } : await revokeAtGoogle(id);
  }
  const removed = secretNames(c, true).filter((name) => deleteSecret(id, name));
  const hadVaultKeys = Object.keys(c.config.fromAws ?? {}).length > 0;
  if (product && id !== GOOGLE[product].id) {
    await db.delete(connectors).where(eq(connectors.id, id));
  } else if (removed.length || hadVaultKeys || id === POSTAL_ID) {
    const config = { ...c.config };
    delete config.account;
    delete config.pmb;
    delete config.fromAws;
    await db
      .update(connectors)
      .set({
        readyAt: null,
        config,
        ...(product
          ? { name: GOOGLE[product].name }
          : id === POSTAL_ID
            ? { name: POSTAL_NAME, tools: [], readTools: [] }
            : {})
      })
      .where(eq(connectors.id, id));
  }
  if (hadVaultKeys) {
    // The last dependent tool can outlive the last direct Secrets Manager grant.
    const vault = await connector(AWS_SECRETS_ID);
    if (vault && !(await hasGrants(vault.id))) await forgetAws(vault);
  }
  return { forgot: removed.length > 0 || hadVaultKeys, googleTold };
}

/**
 * An AWS tool no Odd holds drops its role. Secrets Manager keeps its role
 * while another tool's key comes from AWS, since the office reads those keys
 * with it. The one sign-in goes once no AWS tool has a role.
 */
async function forgetAws(c: ConnectorRow): Promise<boolean> {
  const all = await db.select().from(connectors);
  const keysFromAws = all.some((k) => Object.keys(k.config.fromAws ?? {}).length);
  if (!c.config.aws || (c.id === AWS_SECRETS_ID && keysFromAws)) return false;
  await db
    .update(connectors)
    .set({ config: { ...c.config, aws: undefined }, readyAt: null })
    .where(eq(connectors.id, c.id));
  if (!all.some((k) => k.id !== c.id && isAws(k.id) && k.config.aws))
    deleteSecret(AWS_SIGN_IN.id, AWS_SIGN_IN.name);
  return true;
}

/** Save the mailbox and its read tools together, only for a current owner's setup task.
 * Two setup cards cannot change an already connected mailbox under another Odd. */
export async function bindPostalMailbox(
  taskId: number,
  pmb: string,
  names: string[]
): Promise<void> {
  const [saved] = await db
    .update(connectors)
    .set({
      name: `${POSTAL_NAME} · PMB ${pmb}`,
      config: sql`jsonb_set(${connectors.config}, '{pmb}', to_jsonb(${pmb}::text))`,
      tools: names,
      readTools: names,
      readyAt: new Date()
    })
    .where(
      and(
        eq(connectors.id, POSTAL_ID),
        sql`(${connectors.config}->>'pmb' is null or ${connectors.config}->>'pmb' = ${pmb})`,
        sql`exists (select 1 from ${tasks} t join ${grants} g on g.staff_id = t.staff_id
      where t.id = ${taskId} and t.status = 'open' and g.connector_id = ${POSTAL_ID} and g.level = 'read'
      and t.steps @> ${JSON.stringify([{ action: { kind: 'postal', connector: POSTAL_ID } }])}::jsonb)`
      )
    )
    .returning({ id: connectors.id });
  if (!saved)
    throw new Error(
      'This setup is no longer open or another mailbox is connected. Revoke its grants before changing mailboxes.'
    );
}

export async function connectorReady(
  id: string,
  tools: string[],
  readTools: string[],
  toolNotes?: Record<string, string>
): Promise<void> {
  await db
    .update(connectors)
    .set({ tools, readTools, readyAt: new Date(), ...(toolNotes ? { toolNotes } : {}) })
    .where(eq(connectors.id, id));
}

export async function grantsFor(
  staffId: string
): Promise<(GrantRow & { connector: ConnectorRow })[]> {
  const rows = await db
    .select()
    .from(grants)
    .innerJoin(connectors, eq(grants.connectorId, connectors.id))
    .where(eq(grants.staffId, staffId));
  return rows.map((r) => ({ ...r.grants, connector: r.connectors }));
}

/**
 * Change a grant's level in place: Read only or Read and write. The tool stays
 * connected and signed in, with no new steps, and the change reaches the
 * Odd's next run. Write needs the Draft level or higher (`grantWorks`).
 */
export async function setGrantLevel(
  staffId: string,
  connectorId: string,
  level: 'read' | 'act'
): Promise<void> {
  const who = await staffer(staffId);
  const conn = await connector(connectorId);
  if (!who || !conn) throw new Error('No such Odd or tool');
  if (conn.id === POSTAL_ID && level !== 'read')
    throw new Error('Physical mail only allows Read only access.');
  if (!grantWorks(level, who.permission))
    throw new Error(`${who.name} holds ${who.permission}, so it cannot be given ${level}`);
  const [changed] = await db
    .update(grants)
    // Read only changes nothing: both exceptions go with write.
    .set(level === 'read' ? { level, standing: [], askFirst: [] } : { level })
    .where(
      and(
        eq(grants.staffId, staffId),
        eq(grants.connectorId, connectorId),
        sql`${grants.level} <> ${level}`
      )
    )
    .returning();
  if (!changed) return;
  await record({
    kind: 'access',
    actor: 'owner',
    title: `${who.name} now has ${conn.name} ${level === 'act' ? 'to read and write' : 'to read only'}`
  });
}

async function hasGrants(connectorId: string): Promise<boolean> {
  const [held] = await db
    .select({ id: grants.staffId })
    .from(grants)
    .where(eq(grants.connectorId, connectorId))
    .limit(1);
  return !!held;
}

export async function revoke(staffId: string, connectorId: string): Promise<void> {
  const [gone] = await db
    .delete(grants)
    .where(and(eq(grants.staffId, staffId), eq(grants.connectorId, connectorId)))
    .returning();
  if (!gone) return;
  await dropConnectTasks(connectorId, staffId);
  const held = await hasGrants(connectorId);
  const [c, who] = await Promise.all([connector(connectorId), staffer(staffId)]);
  const { forgot, googleTold } = held ? { forgot: false } : await forgetConnector(connectorId);
  await record({
    kind: 'access',
    actor: 'owner',
    title: `Revoked ${c?.name ?? connectorId} for ${who?.name ?? staffId}`,
    body: forgot
      ? `No Odd holds it now. The office removed its saved connection details.${
          googleTold === true
            ? ' Google cancelled the sign-in too.'
            : googleTold === false
              ? ' Google could not be told, so remove Oddboro at myaccount.google.com/permissions.'
              : googleTold
                ? ` Google keeps the sign-in, since ${googleTold.kept.join(' and ')} ${googleTold.kept.length === 1 ? 'uses' : 'use'} the same Google account. It came out of this computer only.`
                : ''
        }`
      : undefined
  });
}
