// The dev server answers only this computer, and launches no editor for any
// page: Vite's own dev server with the office's plugin, in a throwaway folder,
// and the loopback plugin's hook on a stand-in server. Run with
// `npm test -w @oddboro/office`.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { after, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import config, {
  buildOptions,
  mapSource,
  noEditorLaunch,
  onlyThisComputer,
  siteUrl
} from '../vite.config.ts';
import { REQUEST_TARGETS } from './lib/server/request-targets.ts';
import { NOT_THIS_COMPUTER } from './lib/server/this-computer.ts';

const folder = mkdtempSync(join(tmpdir(), 'oddboro-vite-'));
const launched = join(folder, 'launched.log');
// Should the refusal ever break, Vite launches this stub, which only logs, and
// never an editor of the owner's (Vite takes LAUNCH_EDITOR before guessing one).
const editor = join(folder, 'editor.sh');
writeFileSync(editor, `#!/bin/sh\necho "$@" >> '${launched}'\n`);
chmodSync(editor, 0o755);
process.env.LAUNCH_EDITOR = editor;
const target = join(folder, 'secret.txt');
writeFileSync(target, 'secret');

const vite = await createServer({
  configFile: false,
  root: folder,
  logLevel: 'silent',
  appType: 'custom',
  server: { middlewareMode: true, ws: false, watch: null },
  plugins: [noEditorLaunch()]
});
const http = createHttpServer(vite.middlewares);
const port = await new Promise<number>((done) =>
  http.listen(0, '127.0.0.1', () => done((http.address() as { port: number }).port))
);

after(async () => {
  await new Promise((done) => http.close(done));
  await vite.close();
  rmSync(folder, { recursive: true, force: true });
});

test("the office's dev config asks where a request came from first, then refuses the editor route", () => {
  const { plugins } = config({ command: 'serve', mode: 'development' });
  assert.equal((plugins?.[0] as { name?: string }).name, onlyThisComputer().name);
  assert.equal(onlyThisComputer().enforce, 'pre');
  assert.equal((plugins?.[1] as { name?: string }).name, noEditorLaunch().name);
});

test('the dev server refuses every request and websocket that is not from this computer', () => {
  type Middleware = (req: unknown, res: unknown, next: () => void) => void;
  type Upgrade = (req: unknown, socket: unknown) => void;
  let middleware: Middleware | undefined;
  let upgrade: Upgrade | undefined;
  // Only the two members the hook uses; the file's real Vite runs in
  // middleware mode, where `httpServer` is null.
  const server = {
    middlewares: { use: (fn: Middleware) => (middleware = fn) },
    httpServer: {
      prependListener: (event: string, fn: Upgrade) => {
        assert.equal(event, 'upgrade');
        upgrade = fn;
      }
    }
  } as unknown as ViteDevServer;
  const hook = onlyThisComputer().configureServer;
  assert.equal(typeof hook, 'function');
  (hook as (server: ViteDevServer) => void)(server);
  assert.ok(middleware && upgrade);

  const rows: { what: string; peer?: string; header?: string | string[]; ok: boolean }[] = [
    { what: 'a LAN device straight to the port', peer: '192.168.1.103', ok: false },
    { what: 'a LAN device through Caddy', peer: '127.0.0.1', header: '192.168.1.103', ok: false },
    {
      what: 'a forged loopback in front of a LAN address',
      peer: '127.0.0.1',
      header: '127.0.0.1, 192.168.1.103',
      ok: false
    },
    {
      what: 'the header given twice, one from the LAN',
      peer: '127.0.0.1',
      header: ['127.0.0.1', '192.168.1.103'],
      ok: false
    },
    { what: 'a LAN IPv6 device', peer: 'fe80::1', ok: false },
    { what: 'a connection with no address', ok: false },
    { what: 'this computer through Caddy', peer: '127.0.0.1', header: '127.0.0.1', ok: true },
    { what: 'this computer with no header', peer: '127.0.0.1', ok: true },
    { what: 'this computer over IPv6', peer: '::1', header: '::1', ok: true },
    { what: 'this computer as a mapped address', peer: '::ffff:127.0.0.1', ok: true }
  ];
  for (const { what, peer, header, ok } of rows) {
    const req = {
      headers: header === undefined ? {} : { 'x-forwarded-for': header },
      socket: { remoteAddress: peer }
    };
    const res = {
      statusCode: 200,
      body: undefined as string | undefined,
      end: (b: string) => (res.body = b)
    };
    let passed = false;
    middleware(req, res, () => (passed = true));
    assert.equal(passed, ok, `${what}: next()`);
    assert.equal(res.statusCode, ok ? 200 : 403, `${what}: status`);
    assert.equal(res.body, ok ? undefined : NOT_THIS_COMPUTER, `${what}: body`);

    const socket = { destroyed: false, destroy: () => (socket.destroyed = true) };
    upgrade(req, socket);
    assert.equal(socket.destroyed, !ok, `${what}: websocket closed`);
  }
});

test('the Sentry build plugin never reports the build and uploads only with a token', () => {
  const without = buildOptions({});
  const withToken = buildOptions({ SENTRY_AUTH_TOKEN: 'x' });
  for (const options of [without, withToken]) {
    assert.equal(options.telemetry, false);
    assert.equal(options.release.inject, false);
    // No release is made, so nothing touches one.
    assert.equal(options.release.create, false);
    assert.equal(options.release.finalize, false);
    assert.equal(options.release.setCommits, false);
  }
  assert.equal(without.autoUploadSourceMaps, false);
  assert.equal(withToken.autoUploadSourceMaps, true);
});

test('every release job names a source map entry the same way', () => {
  // The pokes endpoint's map, as each job's build writes it. A Windows map can
  // hold either separator; a Mac or Linux map, only `/`.
  const up = '../../../../../../../';
  const endpoint = 'build/server/entries/endpoints/api/pokes/_id_';
  const jobs = [
    { root: '/Users/runner/work/Oddboro/Oddboro', source: up, paths: path.posix },
    { root: '/home/runner/work/Oddboro/Oddboro', source: up, paths: path.posix },
    { root: 'D:\\a\\Oddboro\\Oddboro', source: up, paths: path.win32 },
    { root: 'D:\\a\\Oddboro\\Oddboro', source: up.replaceAll('/', '\\'), paths: path.win32 }
  ];
  for (const { root, source, paths } of jobs) {
    const mapDir = paths.join(root, 'apps/office', endpoint);
    const file =
      source + ['src', 'routes', 'api', 'pokes', '[id]', '+server.ts'].join(source.at(-1));
    assert.equal(
      mapSource(file, mapDir, root, paths),
      'apps/office/src/routes/api/pokes/[id]/+server.ts'
    );
  }
  // What the release build passes: the map's own folder, from this repository.
  const { rewriteSources } = buildOptions({}).sourcemaps;
  const chunks = join(import.meta.dirname, '../build/server/chunks');
  assert.equal(
    rewriteSources(
      '../../../../../node_modules/@sveltejs/kit/src/index.js',
      {},
      { mapDir: chunks }
    ),
    'node_modules/@sveltejs/kit/src/index.js'
  );
  assert.equal(
    rewriteSources('../../../src/hooks.server.ts', {}, { mapDir: chunks }),
    'apps/office/src/hooks.server.ts'
  );
});

test("the office links to the site's dev server only under a developer's npm run dev", () => {
  assert.equal(siteUrl({ npm_lifecycle_event: 'dev' }), 'http://localhost:4501');
  // A build, and the office npm run setup keeps running, which starts Vite itself.
  assert.equal(siteUrl({ npm_lifecycle_event: 'build' }), 'https://oddboro.com');
  assert.equal(siteUrl({}), 'https://oddboro.com');
  assert.equal(
    siteUrl({ npm_lifecycle_event: 'dev', ODDBORO_SITE_URL: 'http://localhost:4521/' }),
    'http://localhost:4521'
  );
});

test('a page asking the dev server to open a file in an editor is refused, and no editor starts', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/__open-in-editor?file=${target}`, {
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(res.status, 403);
  assert.equal(await res.text(), 'The office opens no editor');
  assert.equal(existsSync(launched), false);
});

test('the dev server judges every request target by where it comes from alone', () => {
  type Middleware = (req: unknown, res: unknown, next: () => void) => void;
  let middleware: Middleware | undefined;
  const server = {
    middlewares: { use: (fn: Middleware) => (middleware = fn) },
    httpServer: { prependListener: () => {} }
  } as unknown as ViteDevServer;
  (onlyThisComputer().configureServer as (server: ViteDevServer) => void)(server);
  assert.ok(middleware);
  // From source no request carries a key, so the office's guard (`guardOffice`)
  // judges the path after this. Here only the address counts, whatever the target.
  for (const { target } of REQUEST_TARGETS) {
    const url = target.replace('<root>', folder);
    for (const [peer, header, ok] of [
      ['192.168.1.20', undefined, false],
      ['127.0.0.1', '192.168.1.20', false],
      ['127.0.0.1', undefined, true],
      ['::1', '::1', true]
    ] as const) {
      const req = {
        url,
        headers: header === undefined ? {} : { 'x-forwarded-for': header },
        socket: { remoteAddress: peer }
      };
      const res = { statusCode: 200, end: () => {} };
      let passed = false;
      middleware(req, res, () => (passed = true));
      assert.deepEqual([target, peer, passed, res.statusCode], [target, peer, ok, ok ? 200 : 403]);
    }
  }
});
