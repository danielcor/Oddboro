// The office's own address: https://local.oddboro.com, so nobody has to
// remember a port. That name reaches this Mac through a public DNS record
// pointing it at 127.0.0.1; where a network's DNS drops such answers, the
// office uses http://oddboro.localhost, which always reaches this Mac.
//
// Caddy answers on ports 80 and 443 and hands everything to the office on
// 127.0.0.1 at its own port (`OFFICE_PORT`: 4500, or `ODDBORO_PORT`). Three
// cases, by what this Mac already has:
//
// - Nothing on port 80: the office runs its own Caddy as a login service
//   (com.oddboro.caddy), downloading Caddy first if this Mac has none.
// - A Caddy of the owner's on port 80: the office adds its site to it through
//   Caddy's admin API on this Mac, and touches none of the owner's files. That
//   Caddy forgets the site when it reloads its own config, so the office adds
//   it again when it starts and when a page loads.
// - Something else on port 80, a Caddy with its admin API off, or no way to
//   look at port 80: the office stays at oddboro.localhost on its own port,
//   which needs nothing.
//
// HTTPS: a browser lets only a secure page show notifications, so the office
// serves local.oddboro.com over HTTPS with a certificate from Caddy's own
// authority. No public authority can vouch for a name that points at
// 127.0.0.1. This Mac trusts that authority once, with the owner's password in
// the macOS dialog. Until then the plain http:// address works.
//
// Linux works the same way, with three differences: the office's own Caddy
// runs as a systemd user unit, the owner's password comes through pkexec's
// dialog, and binding ports 80 and 443 needs a kernel that lets ordinary users
// do it (net.ipv4.ip_unprivileged_port_start at 80 or lower).
//
// So does Windows: the office's own Caddy runs as a Task Scheduler task, and
// the firewall has nothing to ask about, since there it listens on 127.0.0.1
// and [::1] only (`ownCaddyfile`); trust
// goes in the owner's own list of authorities, which Windows confirms in its
// own dialog with no admin. Windows' own web server (http.sys, behind IIS and
// some other services) often holds port 80, and then the office stays at its port.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  IN_APP,
  LINUX,
  LOGS,
  MAC,
  OFFICE_PORT,
  SYSTEM,
  WINDOWS,
  currentSystem,
  home,
  installService,
  powershell,
  probe,
  type Probe,
  type System
} from '@oddboro/ledger';
import { writeEnv } from '@oddboro/ledger/env';
import { fixedError } from '@oddboro/ledger/errors';
import { systemWords } from '@oddboro/ledger/system-words';
import type { Address } from '#lib/address.ts';
import { HOSTS } from './hosts.ts';

const SECURE = HOSTS[0];
const UPSTREAM = `127.0.0.1:${OFFICE_PORT}`;
// Caddy's admin API listens on 127.0.0.1 by default; Node would try IPv6's ::1 first for localhost.
const ADMIN = 'http://127.0.0.1:2019';
const HTTP_ROUTE = 'oddboro';
const HTTPS_ROUTE = 'oddboro-https';
const TLS_POLICY = 'oddboro-tls';
const LABEL = 'com.oddboro.caddy';
const HOME = home();
const OWN_CADDY = join(HOME, 'bin', WINDOWS ? 'caddy.exe' : 'caddy');
const CADDYFILE = join(HOME, 'caddy', 'Caddyfile');
/** Where a Caddy run by this user keeps its own authority's root certificate. */
const OWN_ROOT = join(
  MAC
    ? join(homedir(), 'Library', 'Application Support', 'Caddy')
    : WINDOWS
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Caddy')
      : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'caddy'),
  'pki',
  'authorities',
  'local',
  'root.crt'
);
/** A copy of the root certificate, taken from Caddy's admin API when its own file is out of reach. */
const COPIED_ROOT = join(HOME, 'caddy', 'root.crt');
/** The system's list of trusted authorities on Linux: Debian and Arch, then Fedora. */
const LINUX_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];

/**
 * The root certificate of the Caddy serving the office. A Caddy run by this
 * user keeps it in its own folder. A Caddy run as a system service (as Linux
 * packages run it) keeps it where this user cannot read, so the office asks
 * that Caddy's admin API for it and keeps a copy.
 */
async function rootCert(): Promise<string | undefined> {
  if (existsSync(OWN_ROOT)) return OWN_ROOT;
  const r = await admin('/pki/ca/local');
  const pem = r?.ok
    ? ((await r.json().catch(() => ({}))) as { root_certificate?: string }).root_certificate
    : undefined;
  if (pem) {
    mkdirSync(join(HOME, 'caddy'), { recursive: true });
    writeFileSync(COPIED_ROOT, pem);
    return COPIED_ROOT;
  }
  return existsSync(COPIED_ROOT) ? COPIED_ROOT : undefined;
}

/** No command here should take two minutes; one that hangs is stopped there. */
const WAIT = { timeout: 120_000 };

/** Whether a command ran and succeeded. Failing, missing and running out of time all mean no. */
function succeeded(r: Probe): boolean {
  switch (r.status) {
    case 'ok':
      return true;
    case 'failed':
    case 'missing':
    case 'timeout':
      return false;
    default: {
      const missed: never = r;
      throw new Error(`A command came back as ${JSON.stringify(missed)}`);
    }
  }
}

const get = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(3000) }).catch(() => undefined);

/**
 * A request to Caddy's admin API. Caddy refuses one that carries a browser's
 * fetch headers and no origin, as Node's `fetch` does, so it names its own.
 */
const admin = (path: string, init: RequestInit = {}) =>
  get(`${ADMIN}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
      origin: ADMIN
    }
  });
const put = (path: string, body: unknown) =>
  admin(path, { method: 'PUT', body: JSON.stringify(body) });

/** The best name that reaches this Mac from here. */
async function host(): Promise<string> {
  const r = await lookup(SECURE).catch(() => undefined);
  return r?.address === '127.0.0.1' ? SECURE : HOSTS[1];
}

/** Whether the address answers, and with this office rather than something else. */
async function answers(url: string): Promise<boolean> {
  const r = await get(`${url}/api/setup/address?probe=1`);
  if (!r?.ok) return false;
  return ((await r.json().catch(() => ({}))) as { office?: boolean }).office === true;
}

/**
 * Whether the office answers over HTTPS. Node keeps its own list of trusted
 * authorities, not the Mac's, so this checks who answers, not the certificate;
 * `trusted` checks that.
 */
function answersSecurely(name: string): Promise<boolean> {
  return new Promise((done) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: 443,
        servername: name,
        path: '/api/setup/address?probe=1',
        headers: { host: name },
        rejectUnauthorized: false,
        timeout: 3000
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            done(res.statusCode === 200 && JSON.parse(body).office === true);
          } catch {
            done(false);
          }
        });
      }
    );
    req.on('error', () => done(false));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

/** Whether this computer trusts Caddy's authority, so browsers accept its certificates. */
async function trusted(): Promise<boolean> {
  const root = await rootCert();
  if (!root) return false;
  if (MAC) return succeeded(await probe('security', ['verify-cert', '-c', root], WAIT));
  // Trusted when the owner's or the computer's list of authorities holds it.
  if (WINDOWS)
    return succeeded(
      await powershell(
        '$t = (New-Object Security.Cryptography.X509Certificates.X509Certificate2($env:ODDBORO_ROOT)).Thumbprint; if (-not (Get-ChildItem Cert:\\CurrentUser\\Root, Cert:\\LocalMachine\\Root | Where-Object Thumbprint -eq $t)) { exit 1 }',
        { ODDBORO_ROOT: root }
      )
    );
  const bundle = LINUX_BUNDLES.find((b) => existsSync(b));
  return !!bundle && succeeded(await probe('openssl', ['verify', '-CAfile', bundle, root], WAIT));
}

/** Linux lets ordinary users bind ports below this one; Caddy needs 80 and 443. */
function lowPortsAllowed(): boolean {
  if (!LINUX) return true;
  try {
    return Number(readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8')) <= 80;
  } catch {
    return false;
  }
}

/** What holds port 80: nothing, a program by name, or the office could not look. */
export type Port80 = { status: 'free' } | { status: 'held'; by: string } | { status: 'unchecked' };

const FREE: Port80 = { status: 'free' };
const UNCHECKED: Port80 = { status: 'unchecked' };
/** The holder's name when the check sees a listener but not whose it is. */
const ANOTHER = 'another program';

/**
 * Each system's look at port 80. A check that cannot run, or that fails, says
 * so: reading it as free would offer a Caddy that then cannot start.
 */
const PORT_80: Record<System, () => Promise<Port80>> = {
  // ss lists every listener, whoever runs it; lsof run without root misses
  // other users' programs. Without root ss names only this user's programs.
  // It goes by name: distributions keep it in /usr/bin, /usr/sbin or /sbin,
  // so no one path is safe.
  linux: async () => {
    const r = await probe('ss', ['-Hltnp', 'sport = :80'], WAIT);
    switch (r.status) {
      case 'ok': {
        const line = r.out.split('\n').find((l) => l.trim());
        if (!line) return FREE;
        return { status: 'held', by: /users:\(\("([^"]+)"/.exec(line)?.[1] ?? ANOTHER };
      }
      case 'failed':
      case 'missing':
      case 'timeout':
        return UNCHECKED;
      default: {
        const missed: never = r;
        throw new Error(`ss came back as ${JSON.stringify(missed)}`);
      }
    }
  },
  // macOS ships lsof only in /usr/sbin. By name it would run whichever lsof
  // comes first on the PATH, which need not answer as Apple's does.
  mac: async () => {
    const r = await probe('/usr/sbin/lsof', ['-nP', '-iTCP:80', '-sTCP:LISTEN', '-Fc'], WAIT);
    switch (r.status) {
      case 'ok':
        return {
          status: 'held',
          by:
            r.out
              .split('\n')
              .find((l) => l.startsWith('c'))
              ?.slice(1) || ANOTHER
        };
      // lsof exits 1 with nothing printed when nothing listens.
      case 'failed':
        return r.code === 1 && !r.out.trim() ? FREE : UNCHECKED;
      case 'missing':
      case 'timeout':
        return UNCHECKED;
      default: {
        const missed: never = r;
        throw new Error(`lsof came back as ${JSON.stringify(missed)}`);
      }
    }
  },
  windows: async () => {
    const r = await powershell(
      'Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName }'
    );
    switch (r.status) {
      case 'ok': {
        const name = r.out.trim();
        if (!name) return FREE;
        // Process 4, "System", is http.sys, Windows' own web server.
        return {
          status: 'held',
          by: name === 'System' ? "Windows' own web server (http.sys)" : name
        };
      }
      case 'failed':
      case 'missing':
      case 'timeout':
        return UNCHECKED;
      default: {
        const missed: never = r;
        throw new Error(`PowerShell came back as ${JSON.stringify(missed)}`);
      }
    }
  }
};

/** What holds port 80 on this system. A system the office does not know is not checked. */
export function port80(): Promise<Port80> {
  const system = currentSystem();
  return system ? PORT_80[system]() : Promise.resolve(UNCHECKED);
}

/** A Caddy already on this Mac: Homebrew's or anyone's on the PATH, else the office's own. */
async function caddyBinary(): Promise<string | undefined> {
  const r = await probe(WINDOWS ? 'where.exe' : 'which', ['caddy'], WAIT);
  switch (r.status) {
    case 'ok': {
      const found = r.out.split(/\r?\n/)[0]?.trim();
      if (found) return found;
      break;
    }
    // Not found, or no way to look: the office's own, if it has one.
    case 'failed':
    case 'missing':
    case 'timeout':
      break;
    default: {
      const missed: never = r;
      throw new Error(`The look for Caddy came back as ${JSON.stringify(missed)}`);
    }
  }
  return existsSync(OWN_CADDY) ? OWN_CADDY : undefined;
}

export async function address(): Promise<Address> {
  const name = await host();
  // Every state carries the port: the page shows it when the office keeps it,
  // and it moves with ODDBORO_PORT.
  const at = { host: name, port: OFFICE_PORT };
  // Caddy, its login service and certificate trust are written for a Mac,
  // Linux and Windows; elsewhere the office stays at its port, which needs nothing.
  if (!MAC && !LINUX && !WINDOWS) return { ...at, state: 'blocked', holder: 'this system for now' };
  if (await answers(`http://${name}`)) {
    const https = name === SECURE && (await answersSecurely(name));
    const secure = https && (await trusted());
    return {
      ...at,
      state: 'ready',
      url: `${secure ? 'https' : 'http'}://${name}`,
      secure,
      canSecure: https && !secure && !!(await rootCert())
    };
  }
  const port = await port80();
  switch (port.status) {
    case 'unchecked':
      return { ...at, state: 'unchecked' };
    case 'free':
      if (!lowPortsAllowed())
        return { ...at, state: 'blocked', holder: 'Linux (ports 80 and 443 need root)' };
      return { ...at, state: 'own', installed: !!(await caddyBinary()) };
    case 'held':
      if (port.by === 'caddy' && (await admin('/config/'))?.ok) return { ...at, state: 'shared' };
      return { ...at, state: 'blocked', holder: port.by };
    default: {
      const missed: never = port;
      throw new Error(`Port 80 came back as ${JSON.stringify(missed)}`);
    }
  }
}

/** Download the official Caddy for this computer's system and chip, checked against its published checksum. */
async function download(): Promise<string> {
  const release = (await (
    await fetch('https://api.github.com/repos/caddyserver/caddy/releases/latest')
  ).json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  const version = release.tag_name.replace(/^v/, '');
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const archive = WINDOWS
    ? `caddy_${version}_windows_${arch}.zip`
    : `caddy_${version}_${MAC ? 'mac' : 'linux'}_${arch}.tar.gz`;
  const url = (name: string) => release.assets.find((a) => a.name === name)?.browser_download_url;
  const tarUrl = url(archive);
  const sumsUrl = url(`caddy_${version}_checksums.txt`);
  if (!tarUrl || !sumsUrl) throw new Error(`Caddy ${version} has no download for this computer.`);
  const tar = Buffer.from(await (await fetch(tarUrl)).arrayBuffer());
  const sums = await (await fetch(sumsUrl)).text();
  const want = sums
    .split('\n')
    .find((l) => l.trim().endsWith(archive))
    ?.split(/\s+/)[0];
  const got = createHash('sha512').update(tar).digest('hex');
  if (!want || want !== got) throw fixedError('The Caddy download did not match its checksum.');
  mkdirSync(join(HOME, 'bin'), { recursive: true });
  const file = join(HOME, 'bin', archive);
  writeFileSync(file, tar);
  // Windows 10 and later ship bsdtar, which reads a zip as well.
  const unpack = WINDOWS
    ? ['-xf', file, '-C', join(HOME, 'bin'), 'caddy.exe']
    : ['-xzf', file, '-C', join(HOME, 'bin'), 'caddy'];
  if (!succeeded(await probe('tar', unpack, WAIT)))
    throw fixedError('The Caddy download would not unpack.');
  if (!WINDOWS) chmodSync(OWN_CADDY, 0o755);
  return OWN_CADDY;
}

/**
 * The office's own Caddyfile on `system`. HTTPS from Caddy's own authority
 * for the real name, plain HTTP for both names so the address works before
 * this Mac trusts that authority. The owner trusts it from the card, so Caddy
 * does not ask on its own.
 *
 * Only on Windows does it listen on the loopback addresses alone, so the
 * firewall never asks the owner. On a Mac a process the owner runs can bind
 * a port under 1024 only on every address (127.0.0.1 and ::1 were refused,
 * measured), so there the office's own Caddy listens on every address, and
 * what keeps an Odd's commands off this Mac is the deny list each run gets
 * (`macAddresses` in sandbox.ts). Linux was not measured, so it gets no bind
 * either.
 */
export function ownCaddyfile(system: System | undefined): string {
  return [
    '# Written by the office: its address on this Mac.',
    '{',
    '\tadmin off',
    '\tpersist_config off',
    '\tskip_install_trust',
    ...(system === 'windows' ? ['\tdefault_bind 127.0.0.1 [::1]'] : []),
    '}',
    '',
    `${SECURE} {`,
    '\ttls internal',
    `\treverse_proxy ${UPSTREAM}`,
    '}',
    '',
    `${HOSTS.map((h) => `http://${h}`).join(', ')} {`,
    `\treverse_proxy ${UPSTREAM}`,
    '}',
    ''
  ].join('\n');
}

/** The office's own Caddy, started now and at every login. */
async function startOwn(): Promise<void> {
  const caddy = (await caddyBinary()) ?? (await download());
  mkdirSync(join(HOME, 'caddy'), { recursive: true });
  writeFileSync(CADDYFILE, ownCaddyfile(SYSTEM));
  const started = await installService({
    label: LABEL,
    args: [caddy, 'run', '--config', CADDYFILE, '--adapter', 'caddyfile'],
    log: join(LOGS, MAC ? 'oddboro-caddy.log' : 'caddy.log')
  });
  if (!started) throw fixedError('Caddy would not start as a login service.');
}

type Servers = Record<string, { listen?: string[] }>;
const proxy = [{ handler: 'reverse_proxy', upstreams: [{ dial: UPSTREAM }] }];

/** The server in the owner's Caddy listening on a port, by name. */
const onPort = (servers: Servers, port: number) =>
  Object.entries(servers).find(([, s]) =>
    (s.listen ?? []).some((l) => new RegExp(`:${port}$`).test(l))
  )?.[0];

/** Put a route first on the owner's server for a port, or on a server of the office's own. */
async function addRoute(servers: Servers, port: number, route: object, own: object) {
  const name = onPort(servers, port);
  const r = name
    ? await put(`/config/apps/http/servers/${name}/routes/0`, route)
    : await put(`/config/apps/http/servers/${port === 80 ? HTTP_ROUTE : HTTPS_ROUTE}`, own);
  if (!r?.ok) throw new Error(`Your Caddy did not take the office's site: ${await r?.text()}`);
}

/** A certificate for the real name from Caddy's own authority, first among the owner's policies. */
async function addPolicy(): Promise<void> {
  const policy = { '@id': TLS_POLICY, subjects: [SECURE], issuers: [{ module: 'internal' }] };
  const tls = (await (await admin('/config/apps/tls'))?.json().catch(() => null)) as {
    automation?: { policies?: unknown[] };
  } | null;
  const r = !tls
    ? await put('/config/apps/tls', { automation: { policies: [policy] } })
    : !tls.automation
      ? await put('/config/apps/tls/automation', { policies: [policy] })
      : !tls.automation.policies
        ? await put('/config/apps/tls/automation/policies', [policy])
        : await put('/config/apps/tls/automation/policies/0', policy);
  if (!r?.ok)
    throw new Error(`Your Caddy did not take the office's certificate: ${await r?.text()}`);
}

/** The office's site, added to the owner's own Caddy through its admin API. */
async function addShared(): Promise<void> {
  const servers = ((await (
    await admin('/config/apps/http/servers')
  )
    ?.json()
    .catch(() => undefined)) ?? {}) as Servers;
  if (!(await admin(`/id/${HTTP_ROUTE}`))?.ok)
    await addRoute(
      servers,
      80,
      { '@id': HTTP_ROUTE, match: [{ host: HOSTS }], handle: proxy, terminal: true },
      {
        listen: [':80'],
        routes: [{ '@id': HTTP_ROUTE, match: [{ host: HOSTS }], handle: proxy, terminal: true }],
        automatic_https: { disable: true }
      }
    );
  if (!(await admin(`/id/${TLS_POLICY}`))?.ok) await addPolicy();
  if (!(await admin(`/id/${HTTPS_ROUTE}`))?.ok) {
    const route = {
      '@id': HTTPS_ROUTE,
      match: [{ host: [SECURE] }],
      handle: proxy,
      terminal: true
    };
    await addRoute(servers, 443, route, { listen: [':443'], routes: [route] });
  }
}

/** Set the address up in whichever way this Mac allows, and check it answers. */
export async function setUpAddress(): Promise<Address> {
  const now = await address();
  if (now.state === 'own') {
    await startOwn();
    writeEnv({ OFFICE_ADDRESS: 'own' });
  } else if (now.state === 'shared') {
    await addShared();
    writeEnv({ OFFICE_ADDRESS: 'shared' });
    process.env.OFFICE_ADDRESS = 'shared';
  } else return now;
  const url = `http://${await host()}`;
  for (let i = 0; i < 20 && !(await answers(url)); i++)
    await new Promise((r) => setTimeout(r, 500));
  return address();
}

/** A path in single quotes, for a shell. */
const quote = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;

/**
 * Each system's way to trust the root certificate at `root`. Each asks the
 * owner in the system's own dialog, so its window must show.
 */
const TRUST_ROOT: Record<System, (root: string) => Promise<Probe>> = {
  // macOS asks for the owner's password in its own dialog.
  mac: (root) =>
    probe(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'do shell script (item 1 of argv) with prompt "Oddboro wants to trust its own certificate, so your browser opens the office securely." with administrator privileges',
        '-e',
        'end run',
        `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${quote(root)}`
      ],
      WAIT
    ),
  // pkexec shows the desktop's own password dialog. p11-kit's trust (Arch,
  // Fedora) adds it to the system list; Debian and Ubuntu use update-ca-certificates.
  linux: (root) =>
    probe(
      'pkexec',
      [
        'sh',
        '-c',
        `if command -v trust >/dev/null; then trust anchor --store ${quote(root)}; else cp ${quote(root)} /usr/local/share/ca-certificates/oddboro-caddy.crt && update-ca-certificates; fi`
      ],
      WAIT
    ),
  // Windows adds it to the owner's own list after its own dialog asks them,
  // with no admin. That dialog is certutil's window, so it is not hidden.
  windows: (root) =>
    probe('certutil.exe', ['-user', '-addstore', 'Root', root], { ...WAIT, showWindow: true })
};

/**
 * Trust Caddy's authority on this computer, so browsers accept the office's
 * certificate. The system asks the owner in its own dialog. A system the
 * office does not know has no way to, so nothing runs there.
 */
export async function secureAddress(): Promise<Address> {
  const root = await rootCert();
  if (!root) throw fixedError('Caddy has not made its certificate yet. Try again in a moment.');
  const system = currentSystem();
  if (!system || !succeeded(await TRUST_ROOT[system](root)))
    throw fixedError(systemWords(system).trustFailed);
  return address();
}

/**
 * The owner's Caddy forgets the office's site when it reloads its own config:
 * put it back. Runs when the office starts and when a page loads, and costs
 * a few requests to the admin API.
 */
export async function keepAddress(): Promise<void> {
  if (IN_APP || process.env.OFFICE_ADDRESS !== 'shared') return;
  await addShared().catch(() => {});
}
