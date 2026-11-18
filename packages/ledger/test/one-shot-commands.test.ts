// Every one-shot command the office runs starts through `probe` in
// platform.ts, which says how it came back (ran, failed, could not start, ran
// out of time), so no caller can read "could not check" as an empty answer.
// And a command runs with no window on Windows unless it opens one the owner
// must see, at a place this file names with its reason.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { parse, sourceFiles, type Source } from './source-files.ts';

const PLATFORM = 'packages/ledger/src/platform.ts';
const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);

/**
 * The only places a command may show its window, each with its reason. A new
 * one fails until it is named here.
 */
const SHOWS_WINDOW: Record<string, string> = {
  'apps/office/src/lib/server/address.ts TRUST_ROOT.windows':
    "certutil's dialog asks the owner to trust the office's certificate, so it must show.",
  'packages/ledger/src/platform.ts openUrl':
    'A hidden opener on Windows can open the browser hidden too.'
};

/**
 * Whether a file can reach `execFile` from child_process: by name (renamed or
 * not), or through the whole module, as a namespace or a default import.
 */
function importsExecFile({ ast }: Source): boolean {
  return ast.statements.some((s) => {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) return false;
    if (!CHILD_PROCESS.has(s.moduleSpecifier.text)) return false;
    const clause = s.importClause;
    if (!clause || clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bound = clause.namedBindings;
    if (!bound) return false;
    if (ts.isNamespaceImport(bound)) return true;
    return bound.elements.some(
      (e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === 'execFile'
    );
  });
}

/** The statement at the file's top that holds this node. */
function topOf(node: ts.Node, ast: ts.SourceFile): ts.Node {
  let n = node;
  while (n.parent && n.parent !== ast) n = n.parent;
  return n;
}

/** A top-level statement's name: its function's, or its first variable's. */
function nameOf(statement: ts.Node): string {
  if (ts.isFunctionDeclaration(statement) && statement.name) return statement.name.text;
  if (ts.isVariableStatement(statement)) {
    const name = statement.declarationList.declarations[0]?.name;
    if (name && ts.isIdentifier(name)) return name.text;
  }
  return ts.SyntaxKind[statement.kind];
}

/** Each read of `execFile` in a file, by the top-level statement it sits in. */
function execFileUses({ ast }: Source): string[] {
  const places: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'execFile' && !ts.isImportSpecifier(n.parent)) {
      const top = topOf(n, ast);
      places.push(
        ts.isFunctionDeclaration(top) ? nameOf(top) : `outside a function (${nameOf(top)})`
      );
    }
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return places;
}

/**
 * Each place a `showWindow` property is written: the file, the top-level
 * statement, and the keys of any objects it sits in, such as
 * `TRUST_ROOT.windows`.
 */
function showWindowPlaces(source: Source): string[] {
  const { path, ast } = source;
  const places: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      n.name.getText(ast) === 'showWindow'
    ) {
      const keys: string[] = [];
      for (let p: ts.Node = n.parent; p.parent && p.parent !== ast; p = p.parent)
        if (ts.isPropertyAssignment(p)) keys.unshift(p.name.getText(ast));
      places.push(`${path} ${[nameOf(topOf(n, ast)), ...keys].join('.')}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return places;
}

test('an import of execFile is seen by name, renamed, or through the whole module', () => {
  const imports = (line: string) => importsExecFile(parse('example.ts', line));
  assert.equal(imports("import { execFile } from 'node:child_process';"), true);
  assert.equal(imports("import { spawn, execFile as run } from 'child_process';"), true);
  assert.equal(imports("import * as cp from 'node:child_process';"), true);
  assert.equal(imports("import cp from 'node:child_process';"), true);
  assert.equal(imports("import { execFileSync, spawn } from 'node:child_process';"), false);
  assert.equal(imports("import type { ExecFileException } from 'node:child_process';"), false);
  assert.equal(imports("import { execFile } from './elsewhere.ts';"), false);
});

test('only platform.ts imports execFile, so every one-shot command starts through probe', () => {
  const files = sourceFiles();
  assert.ok(files.length > 0, 'no source file was parsed, so nothing was checked');
  assert.deepEqual(
    files.filter(importsExecFile).map((f) => f.path),
    [PLATFORM],
    'Start a one-shot command with probe from @oddboro/ledger/platform, which says how it came back.'
  );
});

test("platform.ts uses execFile inside probe alone, so no command skips probe's result", () => {
  const platform = sourceFiles().find((f) => f.path === PLATFORM);
  assert.ok(platform, `${PLATFORM} was not found`);
  const uses = execFileUses(platform);
  assert.ok(uses.length > 0, 'platform.ts uses no execFile, so nothing was checked');
  assert.deepEqual(
    [...new Set(uses)],
    ['probe'],
    'Run the command through probe rather than execFile.'
  );
});

test('a command shows its window on Windows only where this file names it with its reason', () => {
  assert.deepEqual(
    sourceFiles().flatMap(showWindowPlaces).sort(),
    Object.keys(SHOWS_WINDOW).sort(),
    'A command that must show its window is named in SHOWS_WINDOW with its reason; any other runs hidden.'
  );
});
