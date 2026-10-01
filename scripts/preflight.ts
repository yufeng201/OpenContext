/** Stopped-instance compatibility check. No migrations or control-db writes. */
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  accessSync,
  constants,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  assertCompleteRoot,
  acquireStoppedLock,
  inspectStorage,
  noLinks,
} from '../packages/state-sqlite/src/maintenance.ts';
import { safeErrorCode } from '../packages/contracts/src/errors.ts';
import { parsePublicOrigin, parsePort } from '../apps/server/src/deployment.ts';
import { readStaticAsset } from '../apps/server/src/static.ts';
export function preflight(env: Record<string, string | undefined>): object {
  if (!/^v24\.(?:19|[2-9][0-9])\./.test(process.version))
    throw new Error('RUNTIME_UNSUPPORTED');
  const pnpm = execFileSync('pnpm', ['--version'], {
    env: {
      PATH: env['PATH'],
      NPM_CONFIG_USERCONFIG: env['NPM_CONFIG_USERCONFIG'],
      NPM_CONFIG_GLOBALCONFIG: env['NPM_CONFIG_GLOBALCONFIG'],
    },
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  if (pnpm !== '11.19.0') throw new Error('RUNTIME_UNSUPPORTED');
  const policy = readFileSync('pnpm-workspace.yaml', 'utf8');
  if (
    !/^ignoreScripts: true$/m.test(policy) ||
    !/^engineStrict: true$/m.test(policy)
  )
    throw new Error('INSTALL_POLICY_UNSAFE');
  if (
    env['NODE_ENV'] === 'production' &&
    env['OPENCONTEXT_TEST_REPO_ROOT'] !== undefined
  )
    throw new Error('TEST_CONFIGURATION_DENIED');
  const token = env['OPENCONTEXT_OWNER_TOKEN'] ?? '';
  if (token.length < 32) throw new Error('OWNER_TOKEN_TOO_SHORT');
  if (token.length > 256) throw new Error('OWNER_TOKEN_TOO_LONG');
  if (!/^[!-~]+$/.test(token)) throw new Error('INVALID_OWNER_TOKEN');
  const dataRoot = env['OPENCONTEXT_DATA_ROOT'];
  if (!dataRoot || !isAbsolute(dataRoot)) throw new Error('INVALID_PATH');
  const port = parsePort(env['PORT'] ?? '4310');
  const publicOrigin = env['OPENCONTEXT_PUBLIC_ORIGIN'];
  if (publicOrigin) parsePublicOrigin(publicOrigin);
  const webRoot = resolve('apps/web/dist');
  readStaticAsset(webRoot, join(webRoot, 'index.html'));
  assertCompleteRoot(dataRoot);
  noLinks(dirname(dataRoot));
  if (existsSync(dataRoot)) {
    const stat = statSync(dataRoot);
    if (!stat.isDirectory()) throw new Error('INVALID_PATH');
    if ((stat.mode & 0o077) !== 0) throw new Error('ROOT_PERMISSIONS_UNSAFE');
    accessSync(dataRoot, constants.W_OK);
  } else {
    if (!statSync(dirname(dataRoot)).isDirectory())
      throw new Error('INVALID_PATH');
    accessSync(dirname(dataRoot), constants.W_OK);
  }
  const base = {
    node: process.version,
    pnpm,
    privateMode: true,
    loopbackOnly: true,
    port,
    configuredTlsOrigin: Boolean(publicOrigin),
    installationScriptsDisabled: true,
    webBuilt: true,
    singleWriterRequired: true,
  };
  if (!existsSync(join(dataRoot, 'control.sqlite'))) {
    if (existsSync(dataRoot) && readdirSync(dataRoot).length)
      throw new Error('DATA_ROOT_NOT_EMPTY');
    return { ...base, ready: true, data: 'new', migration: 'fresh' };
  }
  const lock = acquireStoppedLock(dataRoot);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(dataRoot, 'control.sqlite'), { readOnly: true });
    const inspection = inspectStorage(dataRoot, db);
    const ready = inspection.ready && inspection.mode === 'private';
    return {
      ...base,
      ready,
      data: 'existing',
      inspection,
      authorizationReviewRequired: true,
    };
  } finally {
    db?.close();
    lock.close();
  }
}
if (process.argv[1]?.endsWith('/preflight.ts')) {
  try {
    const report = preflight(process.env) as { ready: boolean };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({ error: safeErrorCode(error, 'STARTUP_FAILED') }),
    );
    process.exitCode = 1;
  }
}
