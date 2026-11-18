import { sentrySvelteKit } from '@sentry/sveltekit/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { fromThisComputer, NOT_THIS_COMPUTER } from './src/lib/server/this-computer.ts';

/** The repository's root folder, where every uploaded map's sources start. */
const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * One source of a map as Sentry gets it: relative to the repository, with
 * forward slashes, such as `apps/office/src/routes/+page.svelte`. Every
 * release job builds the same code, so the same file gets the same debug id
 * on every system, and whichever job's upload Sentry keeps must name its
 * sources the same way. Sentry's own default resolves each source against
 * the build's working folder, not the map's, and keeps the system's
 * separator, so a Windows job uploaded `..\..\src\...`. `paths` is
 * `node:path`, or `path.win32` in a test.
 */
export function mapSource(source: string, mapDir: string, root = REPO, paths = path): string {
  return paths.relative(root, paths.resolve(mapDir, source)).split(paths.sep).join('/');
}

/**
 * Sentry's build plugin. It uploads the office's source maps only when the
 * release build holds SENTRY_AUTH_TOKEN (SENTRY_ORG and SENTRY_PROJECT come
 * from the environment too); without one it makes no request at all. It never
 * reports the build itself, and wraps nothing at build time: the office sets
 * Sentry up by hand (src/instrumentation.server.ts, src/hooks.*.ts).
 */
export function buildOptions(env: NodeJS.ProcessEnv) {
  return {
    autoInstrument: false,
    buildTimeInstrumentation: false,
    telemetry: false,
    autoUploadSourceMaps: !!env.SENTRY_AUTH_TOKEN,
    // Maps match by debug id. Injecting a release would stamp the page with
    // the git hash, which matches no server release (oddboro@<version>). With
    // no release made, nothing may finalize it or set its commits either:
    // each would ask Sentry for a release that is not there (404).
    release: { create: false, finalize: false, setCommits: false as const, inject: false },
    sourcemaps: {
      rewriteSources: (source: string, _map: unknown, context?: { mapDir: string }) =>
        context ? mapSource(source, context.mapDir) : source
    }
  };
}

/** True when a request to Vite's server, or its websocket, comes from this computer. */
function nodeFromThisComputer(req: IncomingMessage): boolean {
  const header = req.headers['x-forwarded-for'];
  return fromThisComputer({
    forwardedFor: Array.isArray(header) ? header.join(',') : header,
    peer: req.socket.remoteAddress ?? ''
  });
}

/**
 * Under `vite dev`, which setup and the login service run, Vite serves its
 * own routes (the source files, `/@vite/client`) and its live-reload
 * websocket before the office's own check (`guardOffice`) sees a request.
 * So the check's first rule runs here as well, at that earlier door: anything
 * not from this computer gets 403, and its websocket is closed before Vite's
 * handler sees it.
 */
export function onlyThisComputer(): Plugin {
  return {
    name: 'oddboro:only-this-computer',
    apply: 'serve',
    enforce: 'pre',
    // Three of Vite's middlewares run before this one: reject-invalid, CORS and host check.
    // None serves content, and CORS hands a preflight on because SvelteKit sets `preflightContinue`.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (nodeFromThisComputer(req)) return next();
        res.statusCode = 403;
        res.end(NOT_THIS_COMPUTER);
      });
      // Prepended, so it runs before Vite's own websocket handler.
      server.httpServer?.prependListener('upgrade', (req, socket) => {
        if (!nodeFromThisComputer(req)) socket.destroy();
      });
    }
  };
}

/**
 * Vite's dev server has a route, `/__open-in-editor`, that opens a file in an
 * editor, and it runs before the office's own check (`guardOffice`). Nothing
 * in the office uses it; only Vite's error overlay links there. So it is
 * refused outright, for this computer too. This config imports only the
 * office's loopback rule (this-computer.ts, which uses only `node:net`),
 * never the server's other modules.
 */
export function noEditorLaunch(): Plugin {
  return {
    name: 'oddboro:no-editor-launch',
    apply: 'serve',
    // Middleware added here runs before Vite's own, its editor route included.
    configureServer(server) {
      server.middlewares.use('/__open-in-editor', (_req, res) => {
        res.statusCode = 403;
        res.end('The office opens no editor');
      });
    }
  };
}

/**
 * Where the office links to the public site's guides (`lib/site.ts`). A
 * developer's `npm run dev` starts the site beside the office, so it links to
 * the site's dev server on 4501. Everything else links to oddboro.com: a
 * build, and the office `npm run setup` keeps running from source, which
 * starts Vite itself rather than through npm. ODDBORO_SITE_URL overrides both.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.ODDBORO_SITE_URL) return env.ODDBORO_SITE_URL.replace(/\/+$/, '');
  return env.npm_lifecycle_event === 'dev' ? 'http://localhost:4501' : 'https://oddboro.com';
}

// Port 4500 unless ODDBORO_PORT says otherwise, to run a second office beside
// the owner's. A build leaves the workspace packages out: they find their own
// files (migrations, sprites, rooms) beside their code, so a release ships them
// whole (apps/desktop/scripts/stage.ts). In dev Vite keeps loading them, so
// they reload on save.
const port = Number(process.env.ODDBORO_PORT) || 4500;
export default defineConfig(({ command }) => ({
  // The loopback rule first, the earliest door. Sentry's plugin goes before
  // SvelteKit's, as Sentry's setup asks.
  plugins: [
    onlyThisComputer(),
    noEditorLaunch(),
    tailwindcss(),
    sentrySvelteKit(buildOptions(process.env)),
    sveltekit({ adapter: adapter() })
  ],
  define: { __SITE_URL__: JSON.stringify(siteUrl()) },
  // The first file picked in Hire must not reload the page while Vite prepares its parser.
  optimizeDeps: { include: ['yaml'] },
  // The office's addresses through Caddy (lib/server/address.ts).
  server: {
    port,
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: ['local.oddboro.com', 'oddboro.localhost']
  },
  // Rolldown, not ssr.external: this keeps a workspace package and its subpaths
  // out of the server build. The adapter also leaves out whatever package.json
  // lists under dependencies, so the office lists only the workspace packages
  // there, and every third-party package under devDependencies, which bundles
  // it: the app then ships none of them (issue #13). Sentry is the exception:
  // it stays under dependencies, since its tracing hooks modules as they load.
  environments:
    command === 'build'
      ? { ssr: { build: { rolldownOptions: { external: [/^@oddboro\//] } } } }
      : undefined,
  preview: { port, strictPort: true }
}));
