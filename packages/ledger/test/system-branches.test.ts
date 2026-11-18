// A new branch on the operating system outside its one home fails here. A
// per-system choice goes in platform.ts, or in a lookup in a
// `Record<System, ...>` read through `currentSystem()`, which is not a branch.
// The existing branches move home over time, and the baseline falls with them.
// Run with `npm test -w @oddboro/ledger`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { parse, sourceFiles, type Source } from './source-files.ts';

/** The count when this test came in, measured by it. Lower it as branches move home; never raise it. */
const BASELINE = 56;

/** The one home of system branches, which the count leaves out. */
const HOME = new Set(['packages/ledger/src/platform.ts', 'packages/ledger/src/system-words.ts']);
const FLAGS = new Set(['MAC', 'LINUX', 'WINDOWS']);
const SYSTEM_NAMES = new Set(['darwin', 'win32', 'linux', 'mac', 'windows']);
const COMPARES = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken
]);

/** An import, an export or a declaration of the name itself, which reads nothing. */
function namesOnly(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    (ts.isVariableDeclaration(p) && p.name === id)
  );
}

const systemName = (n: ts.Node) =>
  (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && SYSTEM_NAMES.has(n.text);

/** The names a value that reads the system goes by, `process.platform` among them. */
const READS_SYSTEM = new Set(['system', 'platform', 'SYSTEM']);
const MEMBERSHIP = new Set(['includes', 'has']);

/** The expression under any brackets, `as`, `satisfies` or `!`, which change no value. */
function bare(n: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n)
  )
    n = n.expression;
  return n;
}

/** A literal array, or a `new Set([...])` of one, that holds a system's name. */
function systemsListed(n: ts.Expression): boolean {
  const e = bare(n);
  if (ts.isArrayLiteralExpression(e)) return e.elements.some(systemName);
  if (!ts.isNewExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'Set')
    return false;
  const [list] = e.arguments ?? [];
  return list !== undefined && systemsListed(list);
}

/** Whether an expression reads the system: it names `system`, `platform` or `SYSTEM` anywhere in it. */
function readsSystem(n: ts.Node): boolean {
  return (ts.isIdentifier(n) && READS_SYSTEM.has(n.text)) || !!ts.forEachChild(n, readsSystem);
}

/**
 * A membership test on the system: `.includes(...)` or `.has(...)` on a
 * literal list of systems, given a value that reads the system. A list of
 * check ids (`['mac', 'node'].includes(c.id)`), or a table's list asked about
 * the system (`AGENT_PLATFORMS[a].runs.includes(platform)`), is not one.
 */
const membership = (n: ts.Node) =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  MEMBERSHIP.has(n.expression.name.text) &&
  systemsListed(n.expression.expression) &&
  n.arguments.some(readsSystem);

/**
 * The line of each branch on the system in one file: each read of `MAC`,
 * `LINUX` or `WINDOWS`, each `===`, `!==` or `case` with a system's name on
 * one side, and each membership test on the system. It goes by name, so a
 * constant of another meaning named `MAC` counts too (sandbox-paths.ts's
 * table): renaming one lowers the count.
 */
function branches({ ast }: Source): number[] {
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isIdentifier(n) && FLAGS.has(n.text) && !namesOnly(n)) ||
      (ts.isBinaryExpression(n) &&
        COMPARES.has(n.operatorToken.kind) &&
        (systemName(n.left) || systemName(n.right))) ||
      (ts.isCaseClause(n) && systemName(n.expression)) ||
      membership(n)
    )
      lines.push(ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return lines;
}

test('each kind of system branch counts once, a membership test on a literal list of systems included, and an import, an export, a table lookup or a list of other things does not', () => {
  const lines = branches(
    parse(
      'example.ts',
      [
        "import { MAC, LINUX, WINDOWS, currentSystem } from './platform.ts';", // 1
        'export { MAC };', // 2
        'const PLACE: Record<string, string> = { mac: "a", linux: "b", windows: "c" };', // 3
        'const here = PLACE[currentSystem() ?? "linux"];', // 4
        'if (MAC) console.log(here);', // 5: counts
        'const tool = WINDOWS ? "where.exe" : "which";', // 6: counts
        "if (currentSystem() === 'linux') console.log(tool);", // 7: counts
        "if ('win32' !== process.platform) console.log(LINUX);", // 8: counts twice
        'switch (currentSystem()) {', // 9
        "  case 'mac':", // 10: counts
        '    break;', // 11
        '}', // 12
        "if (['mac'].includes(system ?? '')) console.log(1);", // 13: counts
        "if (new Set(['win32', 'linux']).has(process.platform)) console.log(1);", // 14: counts
        "if ((['mac', 'linux'] as const).includes(opts.system!)) console.log(1);", // 15: counts
        "if (['mac', 'node'].includes(c.id)) console.log(1);", // 16: a check id, not the system
        'if (AGENT_PLATFORMS[a].runs.includes(platform)) console.log(1);', // 17: a table's list
        "if (['node', 'npm'].includes(platform)) console.log(1);" // 18: no system listed
      ].join('\n')
    )
  );
  assert.deepEqual(lines, [5, 6, 7, 8, 8, 10, 13, 14, 15]);
});

test('no file outside platform.ts and system-words.ts adds a branch on the system', () => {
  const files = sourceFiles().filter((f) => !HOME.has(f.path));
  const counts = files
    .map((f) => ({ path: f.path, lines: branches(f) }))
    .filter((f) => f.lines.length);
  const total = counts.reduce((n, f) => n + f.lines.length, 0);
  assert.ok(files.length > 0, 'no source file was parsed, so nothing was checked');
  assert.ok(total > 0, 'no branch was counted, so the counter reads nothing');
  assert.ok(
    total <= BASELINE,
    `${total} branches on the system outside platform.ts, above the ${BASELINE} allowed. ` +
      'Put the new choice in platform.ts, or in a Record<System, ...> read through currentSystem(). ' +
      `Each file's branches:\n${counts.map((f) => `${f.path}: ${f.lines.join(', ')}`).join('\n')}`
  );
});
