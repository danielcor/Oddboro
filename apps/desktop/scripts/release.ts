// Builds a release of Oddboro for the machine it runs on, into
// apps/desktop/release/, or the folder `--out` names.
//
// On a Mac: signed with New Altitude's Developer ID, notarized by Apple, with
// the ticket stapled, in a .dmg that is signed, notarized and stapled too,
// plus the updater's archive, its signature and the latest.json the app
// checks.
//
// On Linux (x86_64 or arm64): an AppImage, which is also the updater's
// payload, its signature, a copy under the name the site links to
// (Oddboro-x86_64.AppImage or Oddboro-aarch64.AppImage), and a latest.json
// for this one machine.
//
// On Windows (x64 or arm64): the installer, which is also the updater's
// payload, its signature, a copy under the name the site links to
// (Oddboro-x64-setup.exe or Oddboro-arm64-setup.exe), and a latest.json for
// this one machine. GitHub merges every machine's latest.json into one.
//
// Signing uses APPLE_SIGNING_IDENTITY, else the Developer ID in this Mac's
// keychain. Notarizing uses an App Store Connect API key when
// APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER are set (GitHub),
// else the notarytool profile ODDBORO_NOTARY_PROFILE, else "oddboro"
// (xcrun notarytool store-credentials oddboro ...). The updater archive is
// signed with TAURI_SIGNING_PRIVATE_KEY (the key or its path) and
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD. latest.json points at
// ODDBORO_RELEASE_URL (the release's download folder) and carries
// ODDBORO_RELEASE_NOTES. Signing and notarizing are Mac only: the Windows
// installer is not code-signed yet, so Windows warns before it runs.
//
// With SENTRY_AUTH_TOKEN set (and SENTRY_ORG and SENTRY_PROJECT), the shell
// keeps its line tables and they go to Sentry, as the office's page source
// maps do from its build. Without it the shell's release profile is as it
// was, and nothing goes to Sentry.
//
//   node apps/desktop/scripts/release.ts [--version 0.0.2] [--out <dir>] [--test]
//
// `--version` sets the version in tauri.conf.json and Cargo.toml for this
// build only, and puts the files back after. `--test` is for trying updates
// on this machine: no notarizing, and the app accepts an http latest.json
// from ODDBORO_UPDATE_URL, and nothing goes to Sentry. Never ship a --test
// build.
import { preparePty } from '../../../scripts/prepare-pty.mjs';
import { searchRuntimeFiles } from './search-runtime.ts';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASES = 'https://github.com/New-Altitude/Oddboro/releases';
const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const TAURI = join(DESKTOP, 'src-tauri');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const TEST = args.includes('--test');
const OUT = resolve(flag('--out') ?? join(DESKTOP, 'release'));
// Rust writes source paths into the binary for its panic messages, and those
// paths name the builder's home folder. Map them to neutral ones, so a release
// never carries whose Mac built it. With debug files built, the C code's paths
// take the same map, through CFLAGS. rustc, and gcc and clang for debug info,
// apply the last map that matches, so the list runs from the most general
// folder to the most specific: the checkout and Cargo's folder usually sit
// inside the home folder.
const CARGO_HOME = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
const PATH_MAPS = [
  [homedir(), '/home'],
  [CARGO_HOME, '/cargo'],
  // The shell's reports cut its own frames to this (`ROOT` in src-tauri/src/diagnostics.rs).
  [resolve(DESKTOP, '..', '..'), '/oddboro']
];
const RUSTFLAGS = [
  process.env.RUSTFLAGS ?? '',
  ...PATH_MAPS.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
]
  .join(' ')
  .trim();
// The C code the shell links (ring) names its paths too once it keeps line
// tables. clang and gcc take these flags; MSVC builds it on Windows, where
// checkNoHome still catches a path left in. gcc 11 (Ubuntu 22.04) hands the
// assembler only -fdebug-prefix-map, so ring's .S files need it too.
const CFLAGS = [
  process.env.CFLAGS ?? '',
  ...PATH_MAPS.flatMap(([from, to]) => [
    `-ffile-prefix-map=${from}=${to}`,
    `-fdebug-prefix-map=${from}=${to}`
  ])
]
  .join(' ')
  .trim();
// release.yml passes "" when the secret is missing, so empty means unset.
const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN || '';
/**
 * With a Sentry token, line tables for the shell, so a crash names its line:
 * inside the binary on Linux, beside it as a .dSYM or .pdb on the Mac and
 * Windows. The env overrides Cargo.toml's release profile for this build
 * only; without a token it is empty and the profile is as it was. The Mac
 * keeps the profile's strip: rustc writes the .dSYM first, then strips the
 * binary of the linker's map of object files, whose paths name the home
 * folder. On Linux the line tables live in the binary, and on Windows a
 * strip means no .pdb, so there nothing is stripped.
 */
const SYMBOLS: Record<string, string> = SENTRY_TOKEN
  ? {
      CARGO_PROFILE_RELEASE_DEBUG: 'line-tables-only',
      ...(process.platform === 'darwin' ? {} : { CARGO_PROFILE_RELEASE_STRIP: 'none' }),
      ...(process.platform === 'linux' ? {} : { CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: 'packed' }),
      ...(process.platform === 'win32' ? {} : { CFLAGS })
    }
  : {};
/** This machine: Rust's target, and the name its files and latest.json use. */
const MACHINES: Record<string, { target: string; arch: string; platform: string }> = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', arch: 'aarch64', platform: 'darwin-aarch64' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', arch: 'x86_64', platform: 'linux-x86_64' },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-gnu',
    arch: 'aarch64',
    platform: 'linux-aarch64'
  },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', arch: 'x64', platform: 'windows-x86_64' },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc', arch: 'arm64', platform: 'windows-aarch64' }
};
const MACHINE = MACHINES[`${process.platform}-${process.arch}`];
if (!MACHINE) throw new Error(`Oddboro does not build on ${process.platform}-${process.arch}`);
const TARGET = MACHINE.target;
const RELEASE = join(DESKTOP, 'src-tauri', 'target', TARGET, 'release');
const IDENTITY =
  process.env.APPLE_SIGNING_IDENTITY ?? 'Developer ID Application: New Altitude, Inc. (982T92H38A)';
const PROFILE = process.env.ODDBORO_NOTARY_PROFILE ?? 'oddboro';
const API_KEY = [
  process.env.APPLE_API_KEY_PATH,
  process.env.APPLE_API_KEY_ID,
  process.env.APPLE_API_ISSUER
];
const CONF = join(TAURI, 'tauri.conf.json');
const CARGO = join(TAURI, 'Cargo.toml');
const LOCK = join(TAURI, 'Cargo.lock');
const BUNDLE = join(RELEASE, 'bundle', 'macos');
const APP = join(BUNDLE, 'Oddboro.app');
// The .dmg's window: its picture and Finder's layout (scripts/installer.ts).
const INSTALLER = join(DESKTOP, 'installer');

/** Run a command. An env value of undefined takes that variable out. */
const run = (cmd: string, argv: string[], env: Record<string, string | undefined> = {}) => {
  const all = { ...process.env, ...env };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  execFileSync(cmd, argv, { cwd: DESKTOP, stdio: 'inherit', env: all });
};
const read = (cmd: string, argv: string[]) =>
  execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** The Tauri CLI, run by this Node: `npx` is a batch file on Windows, which only a shell runs. */
const CLI = join(
  dirname(createRequire(import.meta.url).resolve('@tauri-apps/cli/package.json')),
  'tauri.js'
);
const tauri = (argv: string[], env: Record<string, string | undefined> = {}) =>
  run(process.execPath, [CLI, ...argv], env);
// A test build hands the office's build no token, so its source maps never go
// to Sentry.
const stage = () => {
  run(
    process.execPath,
    [join(DESKTOP, 'scripts', 'stage.ts')],
    TEST ? { SENTRY_AUTH_TOKEN: undefined } : {}
  );
  run(process.execPath, [join(DESKTOP, 'scripts', 'smoke.ts'), '--stage']);
};

/**
 * Sends the shell's debug files to Sentry, when there is a token; a test build
 * only scans them. The CLI is found here, not at the top, so a build without
 * a token never needs it.
 */
function uploadDebugFiles(files: string[]): void {
  if (!SENTRY_TOKEN) return;
  const cli = join(dirname(createRequire(import.meta.url).resolve('sentry')), 'bin.cjs');
  run(
    process.execPath,
    [cli, 'debug-files', 'upload', ...(TEST ? ['--no-upload'] : []), ...files],
    { SENTRY_CLI_NO_TELEMETRY: '1' }
  );
}

const KEY = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!KEY) throw new Error('Set TAURI_SIGNING_PRIVATE_KEY to sign the updater archive');
// `tauri build` takes the key or its path, `tauri signer sign` only the key.
if (existsSync(KEY)) process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(KEY, 'utf8').trim();
const wanted = flag('--version');
if (wanted !== undefined && !/^\d+\.\d+\.\d+$/.test(wanted))
  throw new Error(`--version wants x.y.z, not ${wanted}`);

/** Send a file to Apple and wait for its verdict, then staple the ticket to what was sent. */
function notarize(file: string, staple: string): void {
  const [key, keyId, issuer] = API_KEY;
  const auth =
    key && keyId && issuer
      ? ['--key', key, '--key-id', keyId, '--issuer', issuer]
      : ['--keychain-profile', PROFILE];
  run('xcrun', ['notarytool', 'submit', file, ...auth, '--wait']);
  run('xcrun', ['stapler', 'staple', staple]);
}

/**
 * The one file in `folder` that `tauri build` made for `version`, ending in
 * `ending`. Anything but exactly one stops the release. GitHub's cache keeps
 * target/ from earlier builds, and 0.0.6 for Windows once shipped the 0.0.5
 * installer left there, which sorted first.
 */
function builtFile(folder: string, version: string, ending: string): string {
  const found = readdirSync(folder).filter((f) => f.includes(`_${version}_`) && f.endsWith(ending));
  if (found.length !== 1)
    throw new Error(`Want one ${version} ${ending} in ${folder}, found ${found.length}`);
  return found[0];
}

/** Set this build's version in tauri.conf.json and Cargo.toml. Returns what puts them back. */
function setVersion(version: string): () => void {
  const saved = [CONF, CARGO, LOCK].map((f) => [f, readFileSync(f, 'utf8')] as const);
  const conf = JSON.parse(saved[0][1]) as { version: string };
  conf.version = version;
  writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n');
  writeFileSync(CARGO, saved[1][1].replace(/^version = ".*"$/m, `version = "${version}"`));
  return () => saved.forEach(([f, text]) => writeFileSync(f, text));
}

/** latest.json for this machine's build of `version`, its file at `file` in OUT. */
function writeLatest(version: string, file: string): void {
  const base = process.env.ODDBORO_RELEASE_URL ?? `${RELEASES}/download/v${version}`;
  const latest = {
    version,
    notes: process.env.ODDBORO_RELEASE_NOTES ?? '',
    pub_date: new Date().toISOString(),
    platforms: {
      [MACHINE.platform]: {
        signature: readFileSync(join(OUT, `${file}.sig`), 'utf8').trim(),
        url: `${base.replace(/\/$/, '')}/${file}`
      }
    }
  };
  writeFileSync(join(OUT, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
}

/** The name can say one version and the file hold another: 0.0.6's installer was 0.0.5's (#40). */
function checkFileVersion(file: string, version: string): void {
  const got = read('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.ProductVersion`
  ]).trim();
  if (got !== version && got !== `${version}.0`)
    throw new Error(`${file} is version ${got || 'unknown'}, not ${version}`);
}

function checkBundleVersion(app: string, version: string): void {
  const plist = join(app, 'Contents', 'Info.plist');
  const got = read('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  if (got.trim() !== version) throw new Error(`${app} is version ${got.trim()}, not ${version}`);
}

/** Fails when the shell's binary still names the home folder of whoever built it. */
function checkNoHome(binary: string): void {
  if (readFileSync(binary).includes(homedir()))
    throw new Error("The app binary still names this machine's home folder");
}

/**
 * The AppImage bundles GStreamer, so the office's music plays
 * (tauri.linux.conf.json). Its bundler looks in Debian's folders, which
 * Ubuntu has; Fedora keeps them in lib64 and libexec.
 */
function gstreamerDirs(): Record<string, string> {
  if (process.env.GSTREAMER_PLUGINS_DIR || !existsSync('/usr/lib64/gstreamer-1.0')) return {};
  return {
    GSTREAMER_PLUGINS_DIR: '/usr/lib64/gstreamer-1.0',
    GSTREAMER_HELPERS_DIR: '/usr/libexec/gstreamer-1.0'
  };
}

/** The AppImage: built, checked, signed for the updater, and named for the site. */
function buildLinux(version: string): void {
  stage();
  const configs = ['src-tauri/tauri.bundle.conf.json'];
  if (TEST) configs.push('{"plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}');
  tauri(
    [
      'build',
      '--target',
      TARGET,
      '--bundles',
      'appimage',
      ...configs.flatMap((c) => ['--config', c])
    ],
    { RUSTFLAGS, ...SYMBOLS, ...gstreamerDirs() }
  );
  checkNoHome(join(RELEASE, 'oddboro'));
  uploadDebugFiles([join(RELEASE, 'oddboro')]);
  const built = join(RELEASE, 'bundle', 'appimage');
  const appimage = builtFile(built, version, '.AppImage');

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // The AppImage is the updater's payload as it is, so one file serves both.
  const file = `Oddboro_${version}_${MACHINE.arch}.AppImage`;
  copyFileSync(join(built, appimage), join(OUT, file));
  chmodSync(join(OUT, file), 0o755);
  // The signature names the version, and the app refuses one that names another.
  tauri(['signer', 'sign', '--app-version', version, join(OUT, file)]);
  writeLatest(version, file);
  // The site's Download button links to releases/latest/download/ under this name.
  copyFileSync(join(OUT, file), join(OUT, `Oddboro-${MACHINE.arch}.AppImage`));
  console.log(
    `Released ${version} for ${MACHINE.platform}${TEST ? ' (test build)' : ''} in ${OUT}`
  );
}

/**
 * The installer: built, checked, signed for the updater, and named for the
 * site. Tauri's updater runs the installer itself, so one file serves both.
 */
function buildWindows(version: string): void {
  stage();
  const configs = ['src-tauri/tauri.bundle.conf.json'];
  if (TEST) configs.push('{"plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}');
  tauri(
    ['build', '--target', TARGET, '--bundles', 'nsis', ...configs.flatMap((c) => ['--config', c])],
    { RUSTFLAGS, ...SYMBOLS }
  );
  checkNoHome(join(RELEASE, 'oddboro.exe'));
  checkFileVersion(join(RELEASE, 'oddboro.exe'), version);
  uploadDebugFiles([join(RELEASE, 'oddboro.exe'), join(RELEASE, 'oddboro.pdb')]);
  const built = join(RELEASE, 'bundle', 'nsis');
  const setup = builtFile(built, version, '-setup.exe');
  checkFileVersion(join(built, setup), version);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const file = `Oddboro_${version}_${MACHINE.arch}-setup.exe`;
  copyFileSync(join(built, setup), join(OUT, file));
  // The signature names the version, and the app refuses one that names another.
  tauri(['signer', 'sign', '--app-version', version, join(OUT, file)]);
  writeLatest(version, file);
  // The site's Download button links to releases/latest/download/ under this name.
  copyFileSync(join(OUT, file), join(OUT, `Oddboro-${MACHINE.arch}-setup.exe`));
  console.log(
    `Released ${version} for ${MACHINE.platform}${TEST ? ' (test build)' : ''} in ${OUT}`
  );
}

function buildMac(version: string): void {
  // 1. The server, staged and smoke-tested.
  stage();

  // The hardened Node sidecar loads only libraries carrying the app's team ID.
  const stage = join(DESKTOP, 'stage');
  for (const file of [...preparePty(stage), ...searchRuntimeFiles(stage)]) {
    run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', IDENTITY, file]);
    run('codesign', ['--verify', '--strict', file]);
  }
  // 2. The app, signed by Tauri: the app, its Node sidecar, the hardened
  //    runtime and Entitlements.plist on both, and the updater archive.
  const configs = ['src-tauri/tauri.bundle.conf.json', 'src-tauri/tauri.release.conf.json'];
  if (TEST) configs.push('{"plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}');
  tauri(
    ['build', '--target', TARGET, '--bundles', 'app', ...configs.flatMap((c) => ['--config', c])],
    // Tauri would notarize by itself with these. release.ts does it after the checks.
    {
      APPLE_SIGNING_IDENTITY: IDENTITY,
      RUSTFLAGS,
      ...SYMBOLS,
      APPLE_API_KEY: undefined,
      APPLE_ID: undefined
    }
  );
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP]);
  checkNoHome(join(APP, 'Contents/MacOS/oddboro'));
  checkBundleVersion(APP, version);
  uploadDebugFiles([join(APP, 'Contents/MacOS/oddboro'), join(RELEASE, 'oddboro.dSYM')]);
  const node = read('codesign', [
    '-d',
    '--entitlements',
    '-',
    '--xml',
    join(APP, 'Contents/MacOS/node')
  ]);
  if (!node.includes('com.apple.security.cs.allow-jit'))
    throw new Error('The Node sidecar is signed without allow-jit, so V8 would not start');

  // 3. The app notarized and stapled, so it opens offline on first launch.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  if (!TEST) {
    const zip = join(OUT, 'Oddboro.zip');
    run('ditto', ['-c', '-k', '--keepParent', APP, zip]);
    notarize(zip, APP);
    rmSync(zip);
  }

  // 4. The updater archive, packed again from the stapled app and signed
  //    with the updater key, which the app checks before it installs.
  const archive = `Oddboro_${version}_aarch64.app.tar.gz`;
  run('tar', ['-czf', join(OUT, archive), '-C', BUNDLE, 'Oddboro.app'], { COPYFILE_DISABLE: '1' });
  // The signature names the version, and the app refuses one that names another.
  tauri(['signer', 'sign', '--app-version', version, join(OUT, archive)]);
  writeLatest(version, archive);

  // 5. The .dmg: the stapled app beside a link to Applications, on the grass
  //    lot with an arrow between them (scripts/installer.ts draws it), signed,
  //    notarized and stapled. The site's Download button links to
  //    Oddboro.dmg, so each release carries that name too.
  const dmg = join(OUT, `Oddboro_${version}_aarch64.dmg`);
  const volume = join(OUT, 'dmg');
  mkdirSync(join(volume, '.background'), { recursive: true });
  // ditto keeps the signature and the stapled ticket intact.
  run('ditto', [APP, join(volume, 'Oddboro.app')]);
  symlinkSync('/Applications', join(volume, 'Applications'));
  copyFileSync(join(INSTALLER, 'background.tiff'), join(volume, '.background', 'background.tiff'));
  copyFileSync(join(INSTALLER, 'DS_Store'), join(volume, '.DS_Store'));
  run('hdiutil', [
    'create',
    '-volname',
    'Oddboro',
    '-srcfolder',
    volume,
    '-fs',
    'APFS',
    '-format',
    'UDZO',
    '-ov',
    dmg
  ]);
  rmSync(volume, { recursive: true, force: true });
  run('codesign', ['--sign', IDENTITY, '--timestamp', dmg]);
  if (!TEST) notarize(dmg, dmg);
  copyFileSync(dmg, join(OUT, 'Oddboro.dmg'));

  // 6. What Gatekeeper says. A test build is not notarized, so it would refuse.
  if (!TEST) {
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', APP]);
    run('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=2',
      dmg
    ]);
  }
  console.log(`Released ${version}${TEST ? ' (test build)' : ''} in ${OUT}`);
}

const restore = wanted ? setVersion(wanted) : () => {};
try {
  const version = wanted ?? (JSON.parse(readFileSync(CONF, 'utf8')) as { version: string }).version;
  // Every release starts with no bundles, so only this build's files are there to pick.
  rmSync(join(RELEASE, 'bundle'), { recursive: true, force: true });
  if (process.platform === 'darwin') buildMac(version);
  else if (process.platform === 'win32') buildWindows(version);
  else buildLinux(version);
} finally {
  restore();
}
