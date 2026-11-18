// A Svelte component compiled for the server, so a test renders it as the
// page would show it, with `render` from svelte/server. Tests only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';

/**
 * The component in the .svelte file at `source`, compiled. `C` is the type of
 * that file's own import (`typeof NotifyHelp`).
 */
export async function compiledForServer<C>(source: string): Promise<C> {
  const out = mkdtempSync(join(tmpdir(), 'oddboro-component-'));
  after(() => rmSync(out, { recursive: true, force: true }));
  // The compiled module lands outside the app, so each import it makes is
  // pointed at the file it means: a relative one beside the component, a
  // package one as this module resolves it.
  const { js } = compile(readFileSync(source, 'utf8'), { generate: 'server', filename: source });
  const code = js.code.replace(/from '([^']+)'/g, (_, spec: string) => {
    const url = spec.startsWith('.')
      ? pathToFileURL(resolve(dirname(source), spec)).href
      : import.meta.resolve(spec);
    return `from '${url}'`;
  });
  const file = join(out, `${basename(source, '.svelte')}.js`);
  writeFileSync(file, code);
  // The module is that very file, compiled, so it has the component's own type.
  return ((await import(pathToFileURL(file).href)) as { default: C }).default;
}
