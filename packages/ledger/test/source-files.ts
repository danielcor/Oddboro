// Every TypeScript file the office ships, parsed, for tests that hold a rule by
// the code's structure rather than by matching its words, and the office's
// Svelte files as text. The office's own code and each package's, never a test.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** One parsed file, by its path from the repo's root, with forward slashes. */
export type Source = { path: string; ast: ts.SourceFile };

/** Parse one file's text as TypeScript. */
export function parse(path: string, text: string): Source {
  return { path, ast: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) };
}

/** Every path under `root`, from the repo's root, with forward slashes. */
const pathsUnder = (root: string): string[] =>
  readdirSync(join(REPO, root), { recursive: true, encoding: 'utf8' }).map(
    (file) => `${root}/${file.replaceAll('\\', '/')}`
  );

const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

/** Every non-test `.ts` file under `apps/office/src` and each `packages/<name>/src`. */
export function sourceFiles(): Source[] {
  const packages = readdirSync(join(REPO, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `packages/${d.name}/src`);
  return ['apps/office/src', ...packages].flatMap((root) =>
    pathsUnder(root)
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .map((path) => parse(path, read(path)))
  );
}

/** Every `.svelte` file under `apps/office/src`, with its text. */
export function svelteFiles(): { path: string; text: string }[] {
  return pathsUnder('apps/office/src')
    .filter((path) => path.endsWith('.svelte'))
    .map((path) => ({ path, text: read(path) }));
}
