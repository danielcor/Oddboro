// Test-only: hostile and legitimate request targets, one row each, for the
// tests of the office's guard (`guardOffice` in owner-page.ts) in the app and
// from source, and of the dev server's loopback rule (vite.config.ts). No
// office module imports it. A new tricky target is a new row here, never a
// single case in one test.
//
// `app` is what `guardOffice` does in the app with a request that carries no
// key but the proof its own path asks for: the shell's header at a shell
// path, a run's token under /api/gateway/, and a GET anywhere else.
// 'passes' hands it on, 'refused' answers 403, and 'unparsed' means no
// Request can be made of it, so the server answers before `handle`. Each
// value is written out by hand, never worked out from the rule, so a broken
// rule cannot agree with itself. A caller fills in `<root>` with any folder.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type RequestTarget = {
  target: string;
  /** The page a remote function call names (`x-sveltekit-pathname`), which the caller writes. */
  kitPath?: string;
  app: 'refused' | 'passes' | 'unparsed';
  why: string;
};

export const REQUEST_TARGETS: readonly RequestTarget[] = [
  // Hostile: none of these is an exception route.
  {
    target: '//x/api/gateway/notes',
    app: 'refused',
    why: 'A URL parse keeps the doubled slash, so the path is //x/api/gateway/notes, no gateway call.'
  },
  {
    target: '//x/api/gateway/notes?raw',
    app: 'refused',
    why: 'The same doubled slash, with a query that asks the dev server for a file raw.'
  },
  {
    target: '//%5c..%5c..%5c@h/api/gateway/x',
    app: 'refused',
    why: 'Escaped backslashes that the dev server decodes into steps out of the folder.'
  },
  {
    target: '/api/gateway/%2e%2e/x',
    app: 'refused',
    why: 'An escaped .. step: a URL parse resolves it to /api/x.'
  },
  {
    target: '/api/gateway/.%2e/x',
    app: 'refused',
    why: 'Half of a .. step escaped, which a URL parse still reads as one.'
  },
  {
    target: '/api/gateway/../x',
    app: 'refused',
    why: 'A plain .. step out of the gateway route.'
  },
  {
    target: 'http://h/api/gateway/x',
    app: 'unparsed',
    why: 'The absolute form does not start with a slash, and the office cannot read it as a path.'
  },
  {
    target: '/@fs/<root>/package.json?oddboro-link=wrong',
    app: 'refused',
    why: 'A Vite route with a made-up link code. The app runs no Vite, and the code opens nothing.'
  },
  {
    target: '/@vite/client?oddboro-link=wrong',
    app: 'refused',
    why: "The dev server's own client, with a made-up link code."
  },
  {
    target: '/account/callback/x',
    app: 'refused',
    why: 'A step below a sign-in page is no sign-in page.'
  },
  {
    target: '/account/callback/',
    app: 'refused',
    why: 'A sign-in page with a trailing slash is another path.'
  },
  {
    target: '/account/callback/../x',
    app: 'refused',
    why: 'A .. step out of a sign-in page; a URL parse resolves it to /account/x.'
  },
  {
    target: '/account/callback/__data.json',
    app: 'refused',
    why: 'Kit hands `handle` this as the sign-in page, but no browser without the key asks for its data: the page makes no request of its own.'
  },
  {
    target: '/connect/callback/x',
    app: 'refused',
    why: 'A step below a sign-in page is no sign-in page.'
  },
  {
    target: '/connect/callback/',
    app: 'refused',
    why: 'A sign-in page with a trailing slash is another path.'
  },
  {
    target: '/connect/callback/../x',
    app: 'refused',
    why: 'A .. step out of a sign-in page; a URL parse resolves it to /connect/x.'
  },
  {
    target: '/api/update/',
    app: 'refused',
    why: 'The update route with a trailing slash is another path.'
  },
  {
    target: '/api/update/x',
    app: 'refused',
    why: 'A step below the update route.'
  },
  {
    target: '/api/update/__data.json',
    app: 'refused',
    why: 'Kit hands `handle` this as the update route, but the shell never sends it.'
  },
  {
    target: '/API/update',
    app: 'refused',
    why: 'Routes are matched by case, and this is not the update route.'
  },
  {
    target: '/api/browser-link/',
    app: 'refused',
    why: 'The link route with a trailing slash is another path.'
  },
  {
    target: '/api/proof/',
    app: 'refused',
    why: 'The proof with a trailing slash is another path.'
  },
  {
    target: '/api/proof/x',
    app: 'refused',
    why: 'A step below the proof.'
  },
  {
    target: '/api/proof/__data.json',
    app: 'refused',
    why: 'Kit hands `handle` this as the proof, but the shell never sends it.'
  },
  {
    target: '/_app/remote/x/y',
    kitPath: '/api/proof',
    app: 'refused',
    why: 'A remote function call that names the proof as its page. Kit gives `handle` the page it names; the office has no remote functions.'
  },
  {
    target: '/_app/remote/x/y',
    kitPath: '/account/callback',
    app: 'refused',
    why: 'A remote function call that names a sign-in page as its page.'
  },
  {
    target: '/_app/remote/x/y',
    kitPath: '/api/gateway/notes',
    app: 'refused',
    why: "A remote function call that names a gateway call as its page, with a run's token."
  },
  {
    target: '/_app/remote/x/y',
    kitPath: '/api/update',
    app: 'refused',
    why: "A remote function call that names the update route as its page, with the shell's header."
  },
  {
    target: '/_app/immutable/chunks/x.js',
    app: 'refused',
    why: 'Built files are served before the guard, from the build alone; one that reaches the guard is no exception.'
  },
  {
    target: '/_app/immutable/../../api/ledger',
    app: 'refused',
    why: 'Steps out of the built files: a URL parse resolves it to /api/ledger.'
  },

  // Under /api/gateway/ with a run's token: the guard hands these on, and Kit
  // sends each to the gateway route, which answers only a connector the run
  // holds, or to no route at all. None reaches another route.
  {
    target: '/api/gateway/..%5c..%5cpackage.json',
    app: 'passes',
    why: 'Kit decodes it to the connector `..\\..\\package.json`, which no run holds, so the gateway refuses it.'
  },
  {
    target: '/api/gateway/x/',
    app: 'passes',
    why: 'Kit redirects it to /api/gateway/x before `handle`.'
  },
  {
    target: '/api/gateway/x%00',
    app: 'passes',
    why: 'An escaped null byte in a connector id, which no run holds.'
  },
  {
    target: '/api/gateway/no\ttes',
    app: 'passes',
    why: 'A URL parse drops the tab, so it is /api/gateway/notes; Node answers 400 to a raw tab before the guard.'
  },
  {
    target: '/api/gateway/x;/',
    app: 'passes',
    why: 'Kit redirects the trailing slash before `handle`, and no run holds `x;`.'
  },
  {
    target: '/api/gateway/./notes',
    app: 'passes',
    why: 'A URL parse resolves the . step to /api/gateway/notes.'
  },
  {
    target: '/api/gateway/Notes',
    app: 'passes',
    why: 'A connector id is lowercase, so no run holds this one.'
  },
  {
    target: '/api/gateway/a/b',
    app: 'passes',
    why: 'Two steps: no route matches, so Kit answers 404.'
  },
  {
    target: '/api/gateway/',
    app: 'passes',
    why: 'No connector id: no route matches, so Kit answers 404.'
  },
  {
    target: '/api/gateway/a\\b',
    app: 'passes',
    why: 'A URL parse reads the backslash as /, so it is /api/gateway/a/b: no route matches.'
  },
  {
    target: '/api/gateway/%6eotes',
    app: 'passes',
    why: 'Kit decodes the escaped letter, so the gateway sees notes, as the run asked.'
  },
  {
    target: '/api/gateway/notes/',
    app: 'passes',
    why: 'Kit redirects it to /api/gateway/notes before `handle`.'
  },

  // Exception routes: each passes on to its own proof.
  {
    target: '/api/update',
    app: 'passes',
    why: "The shell's update route, with the shell's header."
  },
  {
    target: '/api/update#x',
    app: 'passes',
    why: 'A fragment is no part of the path; Node answers 400 to a raw one before the guard.'
  },
  {
    target: '/api/update#/../secret.txt',
    app: 'passes',
    why: 'Steps after the # are fragment, not path.'
  },
  {
    target: '/api/update?import',
    app: 'passes',
    why: 'An exception path with any query: the route answers, and asks for the shell.'
  },
  {
    target: '/api/update?raw',
    app: 'passes',
    why: 'An exception path with any query: the route answers, and asks for the shell.'
  },
  {
    target: '/api/update?url',
    app: 'passes',
    why: 'An exception path with any query: the route answers, and asks for the shell.'
  },
  {
    target: '/api/browser-link',
    app: 'passes',
    why: "The shell asking for a link for the owner's browser, with the shell's header."
  },
  {
    target: '/account/callback',
    app: 'passes',
    why: "A tool's sign-in page, proved by the sign-in's state."
  },
  {
    target: '/account/callback?code=c&state=s',
    app: 'passes',
    why: 'A sign-in coming back with its code and state.'
  },
  {
    target: '/account/callback?import&raw',
    app: 'passes',
    why: 'An exception path with any query: the page answers, and asks for its state.'
  },
  {
    target: '/connect/callback',
    app: 'passes',
    why: "A connector's sign-in page, proved by the sign-in's state."
  },
  {
    target: '/api/proof',
    app: 'passes',
    why: 'The proof that this server holds the key, by GET: it answers a nonce with a hash and holds nothing else.'
  },
  {
    target: '/api/gateway/notes',
    app: 'passes',
    why: "A run reaching one of its tools, with the run's token."
  },
  {
    target: '/api/gateway/gmail-2',
    app: 'passes',
    why: "A second Google account's connector id, with its dash and digit."
  },
  {
    target: '/api/gateway/x?import',
    app: 'passes',
    why: "An exception path with any query: the gateway answers, and asks for the run's token."
  },
  {
    target: '/api/gateway/x?/../../secret.txt',
    app: 'passes',
    why: "Steps after the ? are query, not path: the path is the gateway's."
  },
  {
    target: '/api/gateway/x?oddboro-link=wrong',
    app: 'passes',
    why: "A made-up link code changes nothing at an exception path; the run's token is what counts."
  }
];

// Kit's own helpers for the suffixes its router takes off a data or route
// request before `handle` runs. The file imports nothing, and Kit ships no
// types for it, so the functions used are typed here.
const kit = (await import(
  pathToFileURL(
    join(
      dirname(createRequire(import.meta.url).resolve('@sveltejs/kit/package.json')),
      'src/pathname.js'
    )
  ).href
)) as {
  has_data_suffix: (path: string) => boolean;
  strip_data_suffix: (path: string) => string;
  has_resolution_suffix: (path: string) => boolean;
  strip_resolution_suffix: (path: string) => string;
};

/**
 * `event.url` as Kit's `respond` gives it to `handle`: the request's own
 * address with Kit's data or route suffix taken off, or, on a remote function
 * call, the path and query the caller names in its own headers.
 */
export function kitUrl(request: Request): URL {
  const url = new URL(request.url);
  if (kit.has_resolution_suffix(url.pathname))
    url.pathname = kit.strip_resolution_suffix(url.pathname);
  else if (kit.has_data_suffix(url.pathname))
    url.pathname = kit.strip_data_suffix(url.pathname) || '/';
  else if (url.pathname.startsWith('/_app/remote/')) {
    const pathname = request.headers.get('x-sveltekit-pathname');
    if (pathname !== null) {
      url.pathname = pathname;
      url.search = request.headers.get('x-sveltekit-search') ?? '';
    }
  }
  return url;
}

/** The proof a row's own path asks for, by the path it was sent to. */
export function ownProof(path: string): 'shell' | 'run' | 'get' {
  const at = new URL(path, 'http://office').pathname;
  if (at === '/api/update' || at === '/api/browser-link') return 'shell';
  return at.startsWith('/api/gateway/') ? 'run' : 'get';
}
