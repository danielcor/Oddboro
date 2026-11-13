// The office's own address: https://local.oddboro.com, so nobody has to
// remember a port. That name reaches this Mac through a public DNS record
// pointing it at 127.0.0.1; where a network's DNS drops such answers, the
// office uses http://oddboro.localhost, which always reaches this Mac.
//
// Caddy answers on ports 80 and 443 and hands everything to the office on
// 127.0.0.1:4500. Three cases, by what this Mac already has:
//
// - Nothing on port 80: the office runs its own Caddy as a login service
//   (com.oddboro.caddy), downloading Caddy first if this Mac has none.
// - A Caddy of the owner's on port 80: the office adds its site to it through
//   Caddy's admin API on this Mac, and touches none of the owner's files. That
//   Caddy forgets the site when it reloads its own config, so the office adds
//   it again when it starts and when a page loads.
// - Something else on port 80, or a Caddy with its admin API off: the office
//   stays at oddboro.localhost:4500, which needs nothing.
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
import { execFile } from 'node:child_process';
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
  home,
  hostEnv,
  installService,
  powershell,
  type System
} from '@oddboro/ledger';
import { writeEnv } from '@oddboro/ledger/env';
import { fixedError } from '@oddboro/ledger/errors';
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

/** How the address stands, with the name it uses. */
export type Address = { host: string } & (
  | {
      state: 'ready';
      url: string;
      /** Served over HTTPS with a certificate this Mac trusts. */
      secure: boolean;
      /** Served over HTTPS, waiting only for this Mac to trust Caddy's authority. */
      canSecure: boolean;
    }
  | { state: 'own'; installed: boolean }
  | { state: 'shared' }
  | { state: 'blocked'; holder: string }
);

const run = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((done) =>
    execFile(cmd, args, { env: hostEnv(), timeout: 120_000 }, (e, out) =>
      done({ ok: !e, out: String(out ?? '') })
    )
  );

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
  if (MAC) return (await run('security', ['verify-cert', '-c', root])).ok;
  // Trusted when the owner's or the computer's list of authorities holds it.
  if (WINDOWS)
    return (
      await powershell(
        '$t = (New-Object Security.Cryptography.X509Certificates.X509Certificate2($env:ODDBORO_ROOT)).Thumbprint; if (-not (Get-ChildItem Cert:\\CurrentUser\\Root, Cert:\\LocalMachine\\Root | Where-Object Thumbprint -eq $t)) { exit 1 }',
        { ODDBORO_ROOT: root }
      )
    ).ok;
  const bundle = LINUX_BUNDLES.find((b) => existsSync(b));
  return !!bundle && (await run('openssl', ['verify', '-CAfile', bundle, root])).ok;
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

/** What holds port 80, by program name, if anything. */
async function port80(): Promise<string | undefined> {
  if (WINDOWS) {
    const r = await powershell(
      'Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName }'
    );
    // Process 4, "System", is http.sys, Windows' own web server.
    return r.out === 'System' ? "Windows' own web server (http.sys)" : r.out || undefined;
  }
  const r = await run('lsof', ['-nP', '-iTCP:80', '-sTCP:LISTEN', '-Fc']);
  return r.out
    .split('\n')
    .find((l) => l.startsWith('c'))
    ?.slice(1);
}

/** A Caddy already on this Mac: Homebrew's or anyone's on the PATH, else the office's own. */
async function caddyBinary(): Promise<string | undefined> {
  const found = (await run(WINDOWS ? 'where.exe' : 'which', ['caddy'])).out.split(/\r?\n/)[0];
  if (found?.trim()) return found.trim();
  return existsSync(OWN_CADDY) ? OWN_CADDY : undefined;
}

export async function address(): Promise<Address> {
  const name = await host();
  // Caddy, its login service and certificate trust are written for a Mac,
  // Linux and Windows; elsewhere the office stays at its port, which needs nothing.
  if (!MAC && !LINUX && !WINDOWS)
    return { host: name, state: 'blocked', holder: 'this system for now' };
  if (await answers(`http://${name}`)) {
    const https = name === SECURE && (await answersSecurely(name));
    const secure = https && (await trusted());
    return {
      host: name,
      state: 'ready',
      url: `${secure ? 'https' : 'http'}://${name}`,
      secure,
      canSecure: https && !secure && !!(await rootCert())
    };
  }
  const holder = await port80();
  if (!holder && !lowPortsAllowed())
    return { host: name, state: 'blocked', holder: 'Linux (ports 80 and 443 need root)' };
  if (!holder) return { host: name, state: 'own', installed: !!(await caddyBinary()) };
  if (holder === 'caddy' && (await admin('/config/'))?.ok) return { host: name, state: 'shared' };
  return { host: name, state: 'blocked', holder };
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
  if (!(await run('tar', unpack)).ok) throw fixedError('The Caddy download would not unpack.');
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

/**
 * Trust Caddy's authority on this Mac, so browsers accept the office's
 * certificate. macOS asks for the owner's password in its own dialog.
 */
export async function secureAddress(): Promise<Address> {
  const root = await rootCert();
  if (!root) throw fixedError('Caddy has not made its certificate yet. Try again in a moment.');
  const q = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
  // Windows adds it to the owner's own list after its own dialog asks them, with no admin.
  const r = WINDOWS
    ? await run('certutil.exe', ['-user', '-addstore', 'Root', root])
    : MAC
      ? await run('osascript', [
          '-e',
          'on run argv',
          '-e',
          'do shell script (item 1 of argv) with prompt "Oddboro wants to trust its own certificate, so your browser opens the office securely." with administrator privileges',
          '-e',
          'end run',
          `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${q(root)}`
        ])
      : // pkexec shows the desktop's own password dialog. p11-kit's trust (Arch,
        // Fedora) adds it to the system list; Debian and Ubuntu use update-ca-certificates.
        await run('pkexec', [
          'sh',
          '-c',
          `if command -v trust >/dev/null; then trust anchor --store ${q(root)}; else cp ${q(root)} /usr/local/share/ca-certificates/oddboro-caddy.crt && update-ca-certificates; fi`
        ]);
  if (!r.ok)
    throw fixedError('The certificate was not trusted. Try again, and enter your password.');
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
