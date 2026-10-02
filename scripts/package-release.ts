/** Explicit allowlist: no runtime data, environment files, credentials or Git metadata. */
import {
  readdirSync,
  lstatSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { safeErrorCode } from '../packages/contracts/src/errors.ts';
export function packageRelease(source: string, target: string): object {
  source = resolve(source);
  target = resolve(target);
  if (
    target === source ||
    target.startsWith(source + '/') ||
    existsSync(target)
  )
    throw new Error('INVALID_RELEASE_TARGET');
  if (lstatSync(source).isSymbolicLink())
    throw new Error('RELEASE_SYMLINK_DENIED');
  const selected: string[] = [];
  function tree(path: string): void {
    let cursor = source;
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error('RELEASE_SYMLINK_DENIED');
    }
    const stat = lstatSync(join(source, path));
    if (
      path
        .split('/')
        .some(
          (part) =>
            part.startsWith('.') ||
            /^(runtime|data|secrets|credentials|node_modules|plugin-state)$/.test(
              part,
            ),
        ) &&
      path !== '.node-version'
    )
      throw new Error('RELEASE_FILE_DENIED');
    if (stat.isSymbolicLink()) throw new Error('RELEASE_SYMLINK_DENIED');
    if (stat.isDirectory()) {
      for (const item of readdirSync(join(source, path)).sort())
        tree(join(path, item));
    } else if (stat.isFile()) selected.push(path);
    else throw new Error('RELEASE_FILE_DENIED');
  }
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.node-version',
  ])
    tree(file);
  tree('apps/server/src');
  tree('apps/web/dist');
  tree('apps/server/package.json');
  tree('apps/web/package.json');
  for (const parent of ['packages', 'plugins']) {
    for (const name of readdirSync(join(source, parent)).sort()) {
      const base = join(parent, name);
      if (existsSync(join(source, base, 'package.json'))) {
        tree(join(base, 'package.json'));
        tree(join(base, 'src'));
      }
    }
  }
  for (const script of ['admin.ts', 'preflight.ts', 'opencontext.ts'])
    tree(join('scripts', script));
  for (const file of ['Dockerfile', 'compose.yaml', 'opencontext.service'])
    tree(join('deploy', file));
  for (const doc of [
    'PRODUCTION_RUNBOOK.md',
    'DEPLOYMENT_SECURITY.md',
    'BACKUP_RECOVERY.md',
  ])
    tree(join('docs', doc));
  const files: Record<string, string> = {};
  mkdirSync(target, { mode: 0o700 });
  for (const file of selected.sort()) {
    const bytes = readFileSync(join(source, file));
    files[file] = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(source, file), join(target, file));
  }
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
  }).trim();
  const sourceDirty =
    execFileSync('git', ['status', '--porcelain'], {
      cwd: source,
      encoding: 'utf8',
    }).trim() !== '';
  const directories = new Set<string>();
  for (const file of selected) {
    let parent = dirname(file);
    while (parent !== '.') {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  const dockerIgnore =
    '*\n' +
    [...directories]
      .sort()
      .map((path) => '!' + path + '/')
      .join('\n') +
    '\n' +
    selected.map((path) => '!' + path).join('\n') +
    '\n!release-manifest.json\n!.dockerignore\n';
  writeFileSync(join(target, '.dockerignore'), dockerIgnore);
  files['.dockerignore'] = createHash('sha256')
    .update(dockerIgnore)
    .digest('hex');
  const treeHash = createHash('sha256')
    .update(JSON.stringify(files))
    .digest('hex');
  const manifest = {
    format: 'opencontext-release/v1',
    sourceCommit,
    sourceDirty,
    node: '24.19.0',
    pnpm: '11.19.0',
    files,
    treeHash,
  };
  writeFileSync(
    join(target, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return {
    sourceCommit,
    sourceDirty,
    treeHash,
    fileCount: Object.keys(files).length,
    target: relative(process.cwd(), target),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 3) throw new Error('RELEASE_TARGET_REQUIRED');
    console.log(
      JSON.stringify(packageRelease(process.cwd(), process.argv[2]!), null, 2),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ error: safeErrorCode(error, 'RELEASE_BUILD_FAILED') }),
    );
    process.exitCode = 1;
  }
}
