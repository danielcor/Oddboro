// Stages the office server for the app: apps/desktop/stage/ becomes the app's
// Resources/server folder. Node runs it from there with no TypeScript, no Vite
// and no workspace links, so the layout is plain:
//
//   stage/apps/office/build/        the office, from vite build
//   stage/node_modules/             what the workspace packages load, at the versions installed here
//   stage/node_modules/@oddboro/*   ledger, sprites and world, as JavaScript, with their files
//
// Packages' test folders and every source map stay out, and no path may run
// long enough to stop the Windows installer's builder (see LONGEST).
//
// It also fetches the Node binary the app carries, checked against nodejs.org's
// published sums. `node apps/desktop/scripts/smoke.ts --stage` then checks the
// stage as the app would run it.
import { stagePty } from '../../../scripts/prepare-pty.mjs';
import { stageSearchRuntime } from './search-runtime.ts';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DESKTOP = join(ROOT, 'apps', 'desktop');
const STAGE = join(DESKTOP, 'stage');
/** This machine as Rust names it (the sidecar's suffix) and as nodejs.org does. */
const MACHINES: Record<string, { triple: string; dist: string }> = {
  'darwin-arm64': { triple: 'aarch64-apple-darwin', dist: 'darwin-arm64' },
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', dist: 'linux-x64' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', dist: 'linux-arm64' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', dist: 'win-x64' },
  'win32-arm64': { triple: 'aarch64-pc-windows-msvc', dist: 'win-arm64' }
};
const MACHINE = MACHINES[`${process.platform}-${process.arch}`];
if (!MACHINE) throw new Error(`Oddboro does not build on ${process.platform}-${process.arch}`);
const WINDOWS = process.platform === 'win32';
const NODE_BIN = join(
  DESKTOP,
  'src-tauri',
  'binaries',
  `node-${MACHINE.triple}${WINDOWS ? '.exe' : ''}`
);
const PACKAGES = ['ledger', 'sprites', 'world'];
/**
 * What a package does not need at runtime. Its own CLAUDE.md and the
 * ledger's FILES.md, a list of its files for people working on it, stay
 * behind; every other document in it ships, since the office reads the
 * sprites' FORMAT.md and ART.md when it draws.
 */
const LEAVE_OUT = new Set([
  'CLAUDE.md',
  'FILES.md',
  'node_modules',
  'out',
  'scripts',
  'test',
  'tsconfig.json',
  'drizzle.config.ts'
]);

const run = (cmd: string, args: string[], cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
/**
 * npm. On Windows it is a batch file, which only a shell can run, so it goes
 * as one command line; its arguments here are plain words.
 */
const npm = (args: string[], cwd = ROOT) =>
  WINDOWS
    ? execSync(['npm', ...args].join(' '), { cwd, stdio: 'inherit' })
    : execFileSync('npm', args, { cwd, stdio: 'inherit' });
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

function build(): void {
  npm(['run', 'sprites']);
  npm(['run', 'build', '-w', '@oddboro/office']);
}

/**
 * The office's third-party dependencies its build leaves out, so the stage
 * carries them: Sentry's tracing hooks modules as they load. Any other
 * package listed there would ship twice, bundled and in node_modules (#13).
 */
const UNBUNDLED = ['@sentry/core', '@sentry/sveltekit'];

function checkOfficeDependencies(): void {
  const listed = Object.keys(
    readJson(join(ROOT, 'apps', 'office', 'package.json')).dependencies ?? {}
  ).filter((name) => !name.startsWith('@oddboro/') && !UNBUNDLED.includes(name));
  if (listed.length)
    throw new Error(
      `apps/office lists ${listed.join(', ')} under dependencies. The office's build ` +
        'bundles what it runs, so move them to devDependencies.'
    );
}

/**
 * Every third-party runtime dependency, pinned to the version installed here.
 * Optional ones count too: the ledger's terminal library, node-pty, is
 * optional so `npm install` works where it cannot build, but the app needs it.
 */
function dependencies(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of ['apps/office', ...PACKAGES.map((p) => `packages/${p}`)]) {
    const pkg = readJson(join(ROOT, dir, 'package.json'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (name.startsWith('@oddboro/')) continue;
      const local = join(ROOT, dir, 'node_modules', name, 'package.json');
      const version = readJson(
        existsSync(local) ? local : join(ROOT, 'node_modules', name, 'package.json')
      ).version;
      if (out[name] && out[name] !== version)
        throw new Error(`Conflicting runtime versions of ${name}`);
      out[name] = version;
    }
  }
  return out;
}

/** A .ts file as plain JavaScript, with its relative imports pointing at .js. */
function compile(file: string): void {
  const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }).replace(
    /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g,
    '$1$2.js$3'
  );
  writeFileSync(file.replace(/\.ts$/, '.js'), js);
  rmSync(file);
}

function compileAll(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) compileAll(p);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) compile(p);
  }
}

function stagePackage(name: string): void {
  const from = join(ROOT, 'packages', name);
  const to = join(STAGE, 'node_modules', '@oddboro', name);
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(from.length + 1).split(sep)[0];
      return !LEAVE_OUT.has(rel);
    }
  });
  compileAll(join(to, 'src'));
  const pkg = readJson(join(from, 'package.json'));
  const exports = Object.fromEntries(
    Object.entries(pkg.exports as Record<string, string>).map(([k, v]) => [
      k,
      v.replace(/\.ts$/, '.js')
    ])
  );
  writeFileSync(
    join(to, 'package.json'),
    JSON.stringify({ name: pkg.name, type: 'module', exports }, null, 2) + '\n'
  );
}

/**
 * Sentry's build plugins, the source parser and the `sentry` CLI they bring.
 * `@sentry/sveltekit` and `@sentry/node` depend on them for `vite build`; the
 * running office never loads them. The parser is native code nobody signed,
 * which Apple's notary refuses. Vite and its native tools stay out by
 * `--omit=peer`.
 */
const BUILD_ONLY = [
  '@sentry/bundler-plugins',
  'oxc-parser',
  '@oxc-parser',
  '@oxc-project',
  'sentry'
];
/**
 * Native packages shipped under their publisher's signature. The terminal
 * and search binaries are checked separately because the app signs them at
 * release (`signedAtRelease`).
 */
const NATIVE = ['node_modules/@napi-rs/keyring-'];

/** Mach-O, ELF or Windows (MZ) code, by the file's first bytes. */
function isNative(path: string): boolean {
  const head = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  const magic = head.readUInt32BE(0);
  return (
    [0xcffaedfe, 0xcefaedfe, 0xcafebabe, 0x7f454c46].includes(magic) || magic >>> 16 === 0x4d5a
  );
}

/**
 * Reject unexpected native code. On a Mac, verify the publisher signature
 * and secure timestamp for each file the release does not sign itself.
 */
function checkNative(path: string, rel: string): void {
  // The Mac release signs precisely these terminal and search files before Tauri bundles them.
  if (signedAtRelease.has(path)) return;
  if (!NATIVE.some((p) => rel.startsWith(p)))
    throw new Error(`stage/${rel} is native code the app does not sign. Leave it out of the stage`);
  if (process.platform !== 'darwin') return;
  const sig = spawnSync('codesign', ['-dv', '--verbose=2', path], { encoding: 'utf8' }).stderr;
  if (!sig.includes('Authority=Developer ID Application') || !sig.includes('Timestamp='))
    throw new Error(`stage/${rel} has no Developer ID signature with a timestamp`);
}

/** Folders a package keeps for its own tests, which the app never loads. */
const TEST_DIRS = new Set(['__screenshots__', '__tests__']);
/**
 * The Windows installer's builder opens every file by its full path, and a
 * path stops at 260 characters there. GitHub's runner puts the stage about 60
 * characters deep, so no staged path may be longer than this.
 */
const LONGEST = 180;

/**
 * Takes out every test folder, where the longest names live (layerchart's
 * screenshots run past 200 characters), and every source map: nothing in the
 * app loads one, and the office's own would ship its source (Sentry's build
 * plugin keeps them when it has no token to upload them). Then fails on any
 * path still too long, here rather than in the installer, and on native code
 * the release cannot ship (checkNative).
 */
function prune(dir: string, rel = ''): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(path).isDirectory()) {
      if (TEST_DIRS.has(name)) rmSync(path, { recursive: true, force: true });
      else prune(path, r);
    } else if (name.endsWith('.map')) rmSync(path);
    else if (r.length > LONGEST)
      throw new Error(`stage/${r} is ${r.length} characters, too long for the Windows installer`);
    else if (isNative(path)) checkNative(path, r);
  }
}

/**
 * 500 kB is Vite's own warning size. 0.0.5's first page loaded a 785 kB chunk (#13).
 * A chunk over 400 kB is a warning on the build's page, so it is seen before it fails.
 */
function checkChunks(dir: string): void {
  const over: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const s = statSync(path);
      if (s.isDirectory()) walk(path);
      else if (name.endsWith('.js') && s.size > 400 * 1024) {
        const said = `${path.slice(dir.length + 1)} is ${Math.round(s.size / 1024)} kB`;
        console.log(`::warning title=Large chunk::${said}. The stage fails over 500 kB.`);
        if (s.size > 500 * 1024) over.push(said);
      }
    }
  };
  walk(dir);
  if (over.length)
    throw new Error(
      `The page has chunks over 500 kB:\n  ${over.join('\n  ')}\n` +
        'Load what they hold with import() when it is needed.'
    );
}

function stageOffice(): void {
  const office = join(STAGE, 'apps', 'office');
  cpSync(join(ROOT, 'apps', 'office', 'build'), join(office, 'build'), { recursive: true });
  writeFileSync(
    join(office, 'package.json'),
    JSON.stringify({ name: '@oddboro/office', private: true, type: 'module' }, null, 2) + '\n'
  );
}

/** The Node the app carries: this machine's version and system, checked against its sum. */
async function fetchNode(): Promise<void> {
  const version = process.version;
  const have = existsSync(NODE_BIN)
    ? execFileSync(NODE_BIN, ['--version'], { encoding: 'utf8' }).trim()
    : '';
  if (have === version) return;
  const base = `https://nodejs.org/dist/${version}`;
  // Windows builds come as a zip, with node.exe at the top; the rest as a
  // tarball, with node in bin/.
  const folder = `node-${version}-${MACHINE.dist}`;
  const tarball = `${folder}${WINDOWS ? '.zip' : '.tar.gz'}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums
    .split('\n')
    .find((l) => l.endsWith(`  ${tarball}`))
    ?.split(' ')[0];
  if (!want) throw new Error(`No published sum for ${tarball}`);
  const body = Buffer.from(await (await fetch(`${base}/${tarball}`)).arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== want) throw new Error(`${tarball} does not match its published sum`);
  const tmp = join(tmpdir(), `oddboro-node-${version}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, tarball), body);
  // Windows's own tar reads zips. Git for Windows puts a GNU tar earlier on
  // the PATH that does not, so name the system's.
  const tar = WINDOWS
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  run(tar, ['-xf', tarball], tmp);
  mkdirSync(join(DESKTOP, 'src-tauri', 'binaries'), { recursive: true });
  cpSync(join(tmp, folder, ...(WINDOWS ? ['node.exe'] : ['bin', 'node'])), NODE_BIN);
  chmodSync(NODE_BIN, 0o755);
  rmSync(tmp, { recursive: true, force: true });
}

checkOfficeDependencies();
build();
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
writeFileSync(
  join(STAGE, 'package.json'),
  JSON.stringify(
    { name: 'oddboro-server', private: true, type: 'module', dependencies: dependencies() },
    null,
    2
  ) + '\n'
);
// --omit=peer leaves out Vite and SvelteKit, which Sentry's SvelteKit SDK
// names as peers for the build. The office bundles its own.
npm(['install', '--omit=dev', '--omit=peer', '--no-audit', '--no-fund', '--loglevel=error'], STAGE);
for (const p of [...BUILD_ONLY, '.bin/sentry'])
  rmSync(join(STAGE, 'node_modules', p), { recursive: true, force: true });
const signedAtRelease = new Set([...stagePty(STAGE), ...stageSearchRuntime(STAGE)]);
for (const p of PACKAGES) stagePackage(p);
stageOffice();
prune(STAGE);
checkChunks(join(STAGE, 'apps', 'office', 'build', 'client'));
await fetchNode();
console.log(`Staged the server in ${STAGE}.`);
