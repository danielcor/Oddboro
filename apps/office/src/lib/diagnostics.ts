// What an error or trace report may carry, and when a trace is taken. The
// office server, the relay that passes the page's reports on, and the page
// all use this one file. The page loads it too, so it imports nothing under
// /server/: callers pass the office's own names in as `officeHosts`, and the
// relay the host and port the page reached it on.
//
// The rule is an allow list. A text field leaves only in a shape known to
// come from code; anything else leaves as `[withheld]`, or not at all.
import type {
  DataCollection,
  Envelope,
  ErrorEvent,
  Event,
  Exception,
  StackFrame,
  StreamedSpanJSON
} from '@sentry/core';
import type { BrowserOptions } from '@sentry/sveltekit';
import type { RouteId } from '$app/types';
import { isFixedError } from '@oddboro/ledger/errors';

/** The owner's answer about reports. No answer, or any other value, is `unasked`. */
export type Answer = 'yes' | 'no' | 'unasked';

export const answerFrom = (value: unknown): Answer =>
  value === 'yes' || value === 'no' ? value : 'unasked';

const parsed = (text: string | undefined): URL | undefined => {
  try {
    return text ? new URL(text) : undefined;
  } catch {
    // Not an address: nothing to match.
    return undefined;
  }
};

/**
 * Whether reports sent to this address need a New Altitude sign-in: New
 * Altitude's own address over https, or the account site itself when one is
 * set (a stand-in in development and tests, whose port may differ). Any other
 * address, such as a source build's own Sentry, needs none and never gets the
 * token. `address` is a DSN or the envelope URL made from one: both have its
 * scheme and host. The two are named, not in order, because swapped they still
 * type-check and turn the sign-in off for New Altitude's own address. The
 * shell's `needs_sign_in` is the same rule, and both are tested against
 * `needs-sign-in.cases.json`.
 */
export function needsSignIn({
  address,
  accountSite
}: {
  address: string | undefined;
  accountSite: string | undefined;
}): boolean {
  const to = parsed(address);
  if (!to) return false;
  const own = to.hostname === 'newaltitude.ai' || to.hostname.endsWith('.newaltitude.ai');
  return (to.protocol === 'https:' && own) || parsed(accountSite)?.hostname === to.hostname;
}

/**
 * What the page is told about reports: whether they can go at all, whether
 * they need a New Altitude sign-in, and the owner's answer.
 */
export type ReportsState = { possible: boolean; account: boolean; answer: Answer };

/** Whether the office offers reports: they can go, and need no sign-in or have one. */
export const reportsOffered = (
  state: Pick<ReportsState, 'possible' | 'account'>,
  signedIn: boolean
): boolean => state.possible && (!state.account || signedIn);

/** About one trace in ten, as the privacy policy says. */
export const TRACE_SAMPLE_RATE = 0.1;

/** Every category the SDK could collect, off. */
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false
} satisfies DataCollection;

/**
 * Never traced. The event streams stay open with the page or terminal, and
 * the terminal posts each input to its command route. The
 * shell asks for updates every 30 seconds, so a trace there would send
 * reports while the owner is away, and asks for the key's proof every half
 * second while Node starts. The relay would trace itself in a loop.
 */
export const QUIET_ROUTES: ReadonlySet<string> = new Set<RouteId>([
  '/api/events',
  '/api/project-sessions',
  '/api/project-sessions/[id]/events',
  '/api/proof',
  '/api/update',
  '/api/diagnostics/envelope'
]);

/**
 * Every route the office has. A transaction or span keeps its name only when
 * it is one of these, so a raw path (`/api/staff/ada-quill`) never leaves.
 * `satisfies` fails the type check when a route is added or renamed without
 * its key here.
 */
export const ROUTE_IDS = {
  '/': true,
  '/account/callback': true,
  '/api/account': true,
  '/api/accounts': true,
  '/api/act-check': true,
  '/api/agents': true,
  '/api/agents/[tool]': true,
  '/api/asks/[id]': true,
  '/api/asks/[id]/attachments/[n]': true,
  '/api/asks/[id]/call': true,
  '/api/asks/[id]/filter': true,
  '/api/asks/[id]/filter-preview': true,
  '/api/asks/[id]/folder': true,
  '/api/asks/[id]/original': true,
  '/api/asks/[id]/reply': true,
  '/api/backup': true,
  '/api/backup/restore': true,
  '/api/browser-link': true,
  '/api/client-log': true,
  '/api/connectors': true,
  '/api/diagnostics': true,
  '/api/diagnostics/envelope': true,
  '/api/events': true,
  '/api/files': true,
  '/api/files/open': true,
  '/api/files/resolve': true,
  '/api/folders/pick': true,
  '/api/gateway/[connector]': true,
  '/api/goals': true,
  '/api/goals/[id]': true,
  '/api/goals/[id]/staff': true,
  '/api/health': true,
  '/api/jobs/[id]': true,
  '/api/jobs/away': true,
  '/api/ledger': true,
  '/api/lessons': true,
  '/api/lessons/[id]': true,
  '/api/looks': true,
  '/api/looks/parts': true,
  '/api/me/parts': true,
  '/api/office': true,
  '/api/office/design': true,
  '/api/office/layouts': true,
  '/api/office/layouts/[id]': true,
  '/api/office/move-in': true,
  '/api/onboarding': true,
  '/api/personas': true,
  '/api/personas/[slug]': true,
  '/api/pokes/[id]': true,
  '/api/project-sessions': true,
  '/api/project-sessions/[id]/events': true,
  '/api/proof': true,
  '/api/reports/[id]': true,
  '/api/rooms': true,
  '/api/services': true,
  '/api/services/[id]': true,
  '/api/services/[id]/tools': true,
  '/api/setup': true,
  '/api/setup/address': true,
  '/api/setup/advanced': true,
  '/api/setup/claude': true,
  '/api/setup/notify': true,
  '/api/setup/search': true,
  '/api/staff': true,
  '/api/staff/[id]': true,
  '/api/staff/[id]/access': true,
  '/api/staff/[id]/chat': true,
  '/api/staff/[id]/chat/[turnId]/[index]': true,
  '/api/staff/[id]/description': true,
  '/api/staff/[id]/attachments': true,
  '/api/staff/[id]/attachments/[name]': true,
  '/api/staff/[id]/bug-reports': true,
  '/api/staff/[id]/jobs': true,
  '/api/staff/[id]/lessons': true,
  '/api/staff/[id]/look': true,
  '/api/staff/[id]/pokes': true,
  '/api/staff/[id]/portrait': true,
  '/api/staff/[id]/skills': true,
  '/api/staff/[id]/storage': true,
  '/api/staff/[id]/usage': true,
  '/api/staff/draft': true,
  '/api/switches': true,
  '/api/tasks/[id]': true,
  '/api/update': true,
  '/api/weather': true,
  '/atlas/[file]': true,
  '/connect/callback': true
} as const satisfies Record<RouteId, true>;

/** The only span attributes that leave. */
const KEPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.route',
  'http.request.method',
  'http.response.status_code',
  'sentry.op',
  'sentry.origin',
  'sentry.segment.name.source',
  'db.system'
]);

/** The only event tags that leave. The office sets none. */
const KEPT_TAGS: ReadonlySet<string> = new Set();

const METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS'
]);

const WITHHELD = '[withheld]';

const ENGINE_TYPES: ReadonlySet<string> = new Set([
  'TypeError',
  'ReferenceError',
  'RangeError',
  'SyntaxError'
]);

// V8 writes an identifier here from the source text, so it is code. A
// property key is the value the code read with `obj[name]`, so it can be data:
// it never leaves (`[key]`).
const ID = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
const ENGINE_TEMPLATES: readonly RegExp[] = [
  new RegExp(`^${ID} is not defined$`),
  new RegExp(`^${ID} is not a function$`),
  new RegExp(`^${ID} is not iterable$`),
  new RegExp(`^${ID} is not a constructor$`),
  new RegExp(`^Cannot access '${ID}' before initialization$`),
  /^Cannot read properties of (?:undefined|null) \(reading '.*'\)$/s,
  /^Cannot set properties of (?:undefined|null) \(setting '.*'\)$/s,
  /^Assignment to constant variable\.$/,
  /^Maximum call stack size exceeded$/,
  /^Invalid array length$/
];

/** An engine error's message when it matches a template, its property key replaced. */
function engineMessage(type: unknown, message: unknown): string | undefined {
  if (typeof type !== 'string' || !ENGINE_TYPES.has(type) || typeof message !== 'string') return;
  if (!ENGINE_TEMPLATES.some((t) => t.test(message))) return;
  return message.replace(/\((reading|setting) '.*'\)$/s, "($1 '[key]')");
}

/** A Node system error as its code and call (`ENOENT open`), never its path. */
function systemMessage(e: NodeJS.ErrnoException): string | undefined {
  if (typeof e.code !== 'string' || !/^E[A-Z0-9]+$/.test(e.code)) return;
  if (typeof e.syscall !== 'string') return;
  // A spawn names the program it ran (`spawn /path/to/caddy`): only the first word leaves.
  const call = /^[a-z0-9_]+/.exec(e.syscall)?.[0];
  return call ? `${e.code} ${call}` : e.code;
}

const PG_NAME = /^[a-z_][a-z0-9_]*$/;
const PG_FIELDS = [
  ['table_name', 'table'],
  ['column_name', 'column'],
  ['constraint_name', 'constraint']
] as const;

/** A Postgres error as its SQLSTATE and the names of what it touched, never its detail or query. */
function postgresMessage(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return;
  const pg = e as Record<string, unknown>;
  if (pg.name !== 'PostgresError' || typeof pg.code !== 'string') return;
  if (!/^[0-9A-Z]{5}$/.test(pg.code)) return;
  const names = PG_FIELDS.flatMap(([field, label]) => {
    const v = pg[field];
    return typeof v === 'string' && PG_NAME.test(v) ? [`${label} ${v}`] : [];
  });
  return [`SQLSTATE ${pg.code}`, ...names].join(', ');
}

/**
 * The message an error report may keep: an engine template, a Node system
 * error's code, a message the code wrote (`fixedError`), or a Postgres
 * error's code (Drizzle puts it in `cause`). Anything else is `[withheld]`.
 */
export function keptMessage(error: unknown): string {
  if (!(error instanceof Error)) return WITHHELD;
  return (
    engineMessage(error.name, error.message) ??
    systemMessage(error) ??
    (isFixedError(error) ? error.message : undefined) ??
    postgresMessage(error) ??
    postgresMessage(error.cause) ??
    WITHHELD
  );
}

/** `name` when it is a route id, alone or after a method; else `[withheld]`. */
export function keptTransaction(name: unknown): string {
  if (typeof name !== 'string') return WITHHELD;
  const m = /^(?:([A-Z]+) )?(\S+)$/.exec(name);
  if (!m || (m[1] !== undefined && !METHODS.has(m[1]))) return WITHHELD;
  return Object.hasOwn(ROUTE_IDS, m[2]) ? name : WITHHELD;
}

/**
 * Whether a URL is the office's own: one of `officeHosts` on its default
 * port, where Caddy serves the office, or exactly the `host` (name and
 * port) the page reached the office on. Any other URL can be a tool the owner
 * connects or a computer of theirs, a loopback one too, since a loopback port
 * names the tool behind it (`127.0.0.1:11434`).
 */
function isOffice(u: URL, { officeHosts, host }: Scrub): boolean {
  // Not the scheme: the built office names its own URL https (adapter-node
  // reads no ORIGIN), while the desktop window loads it over http. Only the
  // office listens on its host and port. A `blob:` URL's host is empty, and
  // the server's own reports set no host, so neither matches.
  return (u.port === '' && officeHosts.includes(u.hostname)) || u.host === host;
}

/**
 * An office URL as its scheme and host. Under `/_app/` it keeps its path
 * too: those are the page's built code files, named in its stack frames.
 * Any other URL gives undefined, since its address never leaves.
 */
function officeUrl(u: URL, scrub: Scrub): string | undefined {
  if (!isOffice(u, scrub)) return;
  return u.pathname.startsWith('/_app/') ? `${u.origin}${u.pathname}` : u.origin;
}

/** Where Oddboro's own code and the owner's home folder are, for `reportPath`. */
export type Folders = {
  /** Oddboro's own code: the repo in development, the app's staged office in a release. */
  root?: string;
  /** The owner's home folder. */
  home?: string;
};

// Forward slashes and no drive letter: the SvelteKit SDK drops a Windows
// frame's drive (`C:\\Users\\ada` becomes `/Users/ada`) before this sees it.
const comparable = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '');

/** `path` relative to `folder` when it lies inside it, else undefined. */
function inside(path: string, folder: string | undefined): string | undefined {
  // `/` or an empty home is no folder to hide.
  if (!folder || folder.length < 2) return;
  const prefix = `${comparable(folder).replace(/\/+$/, '')}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/**
 * A file path as a report may carry it. Under Oddboro's own code it becomes
 * relative to it; inside a package, it keeps the part from `node_modules/`
 * on; anywhere else under the home folder it becomes its file name alone,
 * since the folders there can name the owner's work. A path outside the
 * home folder (a system library, the installed app) stays as it is, and so
 * does anything that is not a file path (`node:fs`, `<anonymous>`). The
 * shell applies the same rule (`report_path` in
 * `apps/desktop/src-tauri/src/diagnostics.rs`).
 */
export function reportPath(path: string, { root, home }: Folders): string {
  if (!/^(?:[/\\]|[A-Za-z]:[/\\])/.test(path)) return path;
  const p = comparable(path);
  const own = inside(p, root);
  if (own !== undefined) return own;
  const at = p.indexOf('/node_modules/');
  if (at !== -1) return p.slice(at + 1);
  if (inside(p, home) !== undefined) return p.slice(p.lastIndexOf('/') + 1);
  return path;
}

/**
 * The SvelteKit SDK writes a server frame's file as this and then the path:
 * relative to the office's build, or the whole path when it lies outside it.
 */
const APP = 'app:///';

/**
 * A URL's scheme. Two letters at least, since `C:` is a Windows drive. A
 * browser extension's id (`chrome-extension://`, `moz-extension://`) names the
 * owner's browser, and a `file://` or `blob:` URL can name their folders or
 * another host.
 */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/**
 * A frame's file: an office URL by `officeUrl`, any other URL as its file
 * name alone, the same as a file in the home folder, and a path, `node:` or
 * anything else by `reportPath`.
 */
function framePath(path: string | undefined, scrub: Scrub): string | undefined {
  if (path === undefined) return;
  if (path.startsWith(APP)) return APP + reportPath(path.slice(APP.length), scrub);
  if (!SCHEME.test(path) || path.startsWith('node:')) return reportPath(path, scrub);
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    // Not a URL after all: nothing of it can be kept.
    return;
  }
  return officeUrl(url, scrub) ?? url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
}

function scrubFrame(f: StackFrame, scrub: Scrub): StackFrame {
  return {
    function: f.function,
    module: f.module,
    lineno: f.lineno,
    colno: f.colno,
    in_app: f.in_app,
    context_line: f.context_line,
    pre_context: f.pre_context,
    post_context: f.post_context,
    filename: framePath(f.filename, scrub),
    abs_path: framePath(f.abs_path, scrub)
  };
}

function pick<T extends object>(from: T | undefined, keys: readonly (keyof T)[]): Partial<T> {
  if (!from) return {};
  // fromEntries forgets the key type; every key here is one of `keys`.
  return Object.fromEntries(
    keys.filter((k) => from[k] !== undefined).map((k) => [k, from[k]])
  ) as Partial<T>;
}

export type Scrub = Folders & {
  /** The office's own names through Caddy (`HOSTS`), for `isOffice`. */
  officeHosts: readonly string[];
  /**
   * The host and port the page reached the relay on, for `isOffice`. Only the
   * page's reports have frames from a URL, so the server's own leave it out.
   */
  host?: string;
  /** The thrown error, when the caller has it. Without it only engine templates keep a message. */
  error?: unknown;
};

/** A new event built from an allow list. Everything not listed is dropped. */
export function scrubEvent(event: Event, scrub: Scrub): ErrorEvent {
  const { error } = scrub;
  // Linked causes come first, so the thrown error is the last value.
  const thrown: Exception | undefined = event.exception?.values?.at(-1);
  const exception = thrown && {
    values: [
      {
        type: thrown.type,
        value:
          error === undefined
            ? (engineMessage(thrown.type, thrown.value) ?? WITHHELD)
            : keptMessage(error),
        mechanism: thrown.mechanism && {
          type: thrown.mechanism.type,
          handled: thrown.mechanism.handled
        },
        stacktrace: thrown.stacktrace?.frames && {
          frames: thrown.stacktrace.frames.map((f) => scrubFrame(f, scrub))
        }
      }
    ]
  };
  const c = event.contexts;
  const tags = Object.fromEntries(
    Object.entries(event.tags ?? {}).filter(([k]) => KEPT_TAGS.has(k))
  );
  const images = event.debug_meta?.images;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    sdk: event.sdk,
    fingerprint: event.fingerprint,
    // A code file's path can hold the home folder, like a frame's.
    debug_meta: images && {
      images: images.map((i) => ({
        ...pick(i, ['type', 'debug_id'] as const),
        code_file: framePath('code_file' in i ? i.code_file : undefined, scrub)
      }))
    },
    exception,
    transaction: event.transaction === undefined ? undefined : keptTransaction(event.transaction),
    request: event.request?.method ? { method: event.request.method } : undefined,
    tags,
    contexts: c && {
      os: pick(c.os, ['name', 'version']),
      runtime: pick(c.runtime, ['name', 'version']),
      device: pick(c.device, ['arch', 'cpu_description']),
      trace: pick(c.trace, ['trace_id', 'span_id', 'parent_span_id'])
    }
    // `pick` keeps a subset of fields the SDK itself set, so a field the
    // types mark required is missing only where the SDK left it out too.
  } as ErrorEvent;
}

/** An attribute's value, whether it came raw (server) or as `{ type, value }` (a span item). */
const plain = (v: unknown): unknown =>
  v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : v;

type AnySpan = Pick<
  StreamedSpanJSON,
  'trace_id' | 'span_id' | 'parent_span_id' | 'start_timestamp' | 'status' | 'is_segment' | 'name'
> & { end_timestamp?: number; attributes?: Record<string, unknown> };

function bare<S extends AnySpan>(span: S): S {
  return {
    trace_id: span.trace_id,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id,
    start_timestamp: span.start_timestamp,
    end_timestamp: span.end_timestamp,
    status: span.status,
    is_segment: span.is_segment,
    name: 'span',
    attributes: {}
    // The same span with fewer fields: each one the SDK's span type requires is copied.
  } as S;
}

/**
 * A new span from an allow list. The server's `beforeSendSpan` and the relay
 * both call it; each kept attribute goes back in the form it came in. It never
 * returns nothing: the SDK sends the original span when this throws or does.
 * No address leaves: an outgoing request is named by its method alone, the
 * office's own included, since a loopback port names the tool behind it
 * (`127.0.0.1:11434`) and the route already says where in the office.
 */
export function scrubSpan<S extends AnySpan>(span: S): S {
  try {
    const from = span.attributes ?? {};
    const attributes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(from)) {
      if (!KEPT_ATTRIBUTES.has(k)) continue;
      const value = plain(v);
      if (k === 'http.route' && !(typeof value === 'string' && Object.hasOwn(ROUTE_IDS, value)))
        continue;
      attributes[k] = v;
    }
    const op = plain(from['sentry.op']);
    let name: string;
    if (
      plain(from['sentry.segment.name.source']) === 'route' &&
      keptTransaction(span.name) !== WITHHELD
    ) {
      name = span.name;
    } else if (op === 'http.client') {
      const method = [plain(from['http.request.method']), span.name.split(' ')[0]].find(
        (m): m is string => typeof m === 'string' && METHODS.has(m)
      );
      name = method ?? op;
    } else {
      name = typeof op === 'string' ? op : 'span';
    }
    return { ...bare(span), name, attributes };
  } catch {
    // A span the rule cannot read leaves bare, never as it came.
    return bare(span);
  }
}

type EnvelopeHeader = Envelope[0];

/**
 * A new envelope header from an allow list. `dsn` never stays, and the
 * trace's key becomes the office's own (`publicKey`), so a page envelope
 * reaches the door under the office's key. The sampling context's
 * `transaction` can be anything an incoming `baggage` header said.
 */
export function scrubEnvelopeHeader(header: EnvelopeHeader, publicKey: string): EnvelopeHeader {
  const h = header as Record<string, unknown>;
  const trace = h.trace as Record<string, unknown> | undefined;
  const transaction = trace && keptTransaction(trace.transaction);
  return {
    event_id: h.event_id,
    sent_at: h.sent_at,
    sdk: h.sdk,
    trace: trace && {
      ...pick(trace, [
        'trace_id',
        'sample_rate',
        'sample_rand',
        'sampled',
        'release',
        'environment'
      ]),
      public_key: publicKey,
      ...(transaction !== WITHHELD && { transaction })
    }
    // Every field is copied from the header the SDK built, so each keeps its type.
  } as EnvelopeHeader;
}

/** Whether a trace is kept: never without the owner's yes, never on a quiet route. */
export function sampleTrace(
  ctx: { parentSampled?: boolean; attributes?: Record<string, unknown> },
  answer: Answer
): number | boolean {
  const route = ctx.attributes?.['http.route'];
  if (answer !== 'yes' || (typeof route === 'string' && QUIET_ROUTES.has(route))) return 0;
  return ctx.parentSampled ?? TRACE_SAMPLE_RATE;
}

/** A placeholder: the relay replaces the header, and nothing is ever sent to this host. */
export const PAGE_DSN = 'http://oddboro@127.0.0.1/0';

/** The page's SDK options. Its reports go only to the office's relay. */
export function pageOptions(answer: () => Answer): BrowserOptions {
  return {
    dsn: PAGE_DSN,
    tunnel: '/api/diagnostics/envelope',
    // Kit refuses a cross-origin POST with a form content type, and through
    // Caddy the page's origin is https while the office sees http.
    transportOptions: { headers: { 'Content-Type': 'application/x-sentry-envelope' } },
    // The pageload follows the server's decision first: `answer()` is still
    // `unasked` when the page starts.
    tracesSampler: (ctx) => ctx.parentSampled ?? sampleTrace(ctx, answer()),
    spotlight: false,
    traceLifecycle: 'stream',
    tracePropagationTargets: [],
    // No span per file the page fetches. They time the office's own build
    // files from this computer, and made the pageload report 191 KB, near the
    // relay's 512 KB body limit. A pattern, because `ignoreResourceSpans`
    // matches whole op names and the browser has many initiator types.
    ignoreSpans: [{ op: /^resource\./ }],
    sendClientReports: false,
    maxBreadcrumbs: 0,
    dataCollection: DATA_COLLECTION,
    integrations: (d) =>
      d.filter(
        (i) => !['BrowserSession', 'Breadcrumbs', 'Console', 'LinkedErrors'].includes(i.name)
      )
  };
}
