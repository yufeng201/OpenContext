import { resolve, relative, dirname } from 'node:path';
import ts from 'typescript';
import { isBuiltin } from 'node:module';
import { root, files, local, read, main } from './lib.ts';

function group(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts.slice(0, 2).join('/');
}
export function violations(path: string, source: string): string[] {
  const errors: string[] = [];
  const from = group(path);
  const tree = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  function check(specifier: string): void {
    const target = specifier.startsWith('@opencontext/')
      ? 'packages/' + specifier.slice('@opencontext/'.length).split('/')[0]
      : specifier.startsWith('.')
        ? relative(root, resolve(root, dirname(path), specifier)).replaceAll(
            '\\',
            '/',
          )
        : specifier;
    const to = group(target);
    const internal = /^(packages|apps|plugins)\//.test(target);
    let forbidden = false;
    if (from === 'apps/web')
      forbidden =
        (isBuiltin(target) &&
          !(
            /^apps\/web\/tests\/[^/]+\.spec\.ts$/.test(path) &&
            ['node:fs', 'node:fs/promises'].includes(target)
          )) ||
        /^(better-sqlite3|fastify|@fastify\/)/.test(target) ||
        (internal && to !== from && to !== 'packages/contracts');
    if (from === 'packages/core')
      forbidden =
        isBuiltin(target) ||
        /^(better-sqlite3|fastify|@fastify\/)/.test(target) ||
        (internal && to !== from && to !== 'packages/contracts');
    if (from === 'packages/contracts')
      forbidden =
        target.startsWith('node:') ||
        (internal && to !== from) ||
        !(internal || /^(typebox|@sinclair\/typebox)(\/|$)/.test(target));
    if (path.startsWith('plugins/'))
      forbidden =
        (internal &&
          ![from, 'packages/plugin-sdk', 'packages/contracts'].includes(to)) ||
        /^(better-sqlite3|sqlite3|node:sqlite|pg)$/.test(target);
    if (target.startsWith('..')) forbidden = true;
    if (forbidden) errors.push(path + ' -> ' + specifier);
  }
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) check(arg.text);
      else if (
        from === 'apps/web' ||
        from === 'packages/core' ||
        from === 'packages/contracts' ||
        path.startsWith('plugins/')
      )
        errors.push(
          path + ': nonliteral import requires reviewed host boundary',
        );
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      check(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return errors;
}
export function checkBoundaries(): void {
  const paths = files().filter(
    (p) =>
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p) &&
      /^(apps|packages|plugins)\//.test(local(p)) &&
      !['apps/web/vite.config.ts', 'apps/web/playwright.config.ts'].includes(
        local(p),
      ),
  );
  const errors = paths.flatMap((p) => violations(local(p), read(p)));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'Boundaries: ' +
      paths.length +
      ' application modules scanned; static imports only, not application behavior. Rule fixtures run in test:harness.',
  );
}
if (main(import.meta.url)) checkBoundaries();
