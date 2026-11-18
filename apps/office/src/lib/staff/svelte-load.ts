// Lets `node --test` render Svelte components with `render` from
// `svelte/server`. The app's own compile is vite's, and `node --test` runs no
// vite, so this hook compiles each `.svelte` file for the server and each
// `.svelte.ts` module as Node loads it. Test code only: a test registers it
// with `module.register` before it imports a component.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes, type LoadHook } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compile, compileModule } from 'svelte/compiler';

export const load: LoadHook = async (url, context, nextLoad) => {
  const svelte = url.endsWith('.svelte');
  if (!svelte && !url.endsWith('.svelte.ts')) return nextLoad(url, context);
  const filename = fileURLToPath(url);
  const source = await readFile(filename, 'utf8');
  const { js } = svelte
    ? compile(source, { filename, generate: 'server' })
    : // compileModule reads JavaScript, so a `.svelte.ts` module loses its types first.
      compileModule(stripTypeScriptTypes(source), { filename, generate: 'server' });
  return { format: 'module', source: js.code, shortCircuit: true };
};
