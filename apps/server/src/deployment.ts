import {
  constants,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  existsSync,
  statfsSync,
} from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { getHeapStatistics } from 'node:v8';
export function parsePublicOrigin(value: string): URL {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('INVALID_PUBLIC_ORIGIN');
    return origin;
  } catch {
    throw new Error('INVALID_PUBLIC_ORIGIN');
  }
}
export function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535)
    throw new Error('INVALID_PORT');
  return Number(value);
}

/** Only a named owner secret is read; no credential discovery or generation. */
export function ownerToken(env: NodeJS.ProcessEnv): string {
  const file = env['OPENCONTEXT_OWNER_TOKEN_FILE'];
  if (file && env['OPENCONTEXT_OWNER_TOKEN'] !== undefined)
    throw new Error('OWNER_TOKEN_CONFIGURATION_CONFLICT');
  let token = env['OPENCONTEXT_OWNER_TOKEN'] ?? '';
  if (file) {
    if (!isAbsolute(file)) throw new Error('INVALID_SECRET_FILE');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 257)
        throw new Error('INVALID_SECRET_FILE');
      const bytes = Buffer.alloc(258);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count > 257) throw new Error('INVALID_SECRET_FILE');
      token = bytes.subarray(0, count).toString('utf8').replace(/\n$/, '');
    } finally {
      closeSync(fd);
    }
  }
  if (token.length < 32) throw new Error('OWNER_TOKEN_TOO_SHORT');
  if (token.length > 256) throw new Error('OWNER_TOKEN_TOO_LONG');
  if (!/^[!-~]+$/.test(token)) throw new Error('INVALID_OWNER_TOKEN');
  return token;
}
export function runtimeConfig(env: NodeJS.ProcessEnv) {
  if (
    env['NODE_ENV'] === 'production' &&
    !/^v24\.(?:19|[2-9][0-9])\./.test(process.version)
  )
    throw new Error('RUNTIME_UNSUPPORTED');
  const host = env['OPENCONTEXT_BIND_HOST'] ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0')
    throw new Error('INVALID_BIND_HOST');
  const origin = env['OPENCONTEXT_PUBLIC_ORIGIN'];
  if (origin) parsePublicOrigin(origin);
  if (host !== '127.0.0.1' && !origin)
    throw new Error('PUBLIC_ORIGIN_REQUIRED');
  const raw = env['OPENCONTEXT_SHUTDOWN_TIMEOUT_MS'] ?? '15000';
  if (!/^\d{3,5}$/.test(raw) || Number(raw) < 100 || Number(raw) > 60000)
    throw new Error('INVALID_SHUTDOWN_TIMEOUT');
  return {
    host,
    port: parsePort(env['PORT'] ?? '4310'),
    shutdownTimeoutMs: Number(raw),
  };
}
/** Admission checks, not an OS memory/disk quota or ongoing monitor. */
export function resourceAdmission(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): void {
  if (getHeapStatistics().heap_size_limit < 256 * 1024 * 1024)
    throw new Error('RESOURCE_BUDGET_TOO_LOW');
  const raw = env['OPENCONTEXT_MIN_FREE_BYTES'] ?? '67108864';
  if (
    !/^\d{1,15}$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < 67108864
  )
    throw new Error('INVALID_RESOURCE_BUDGET');
  let existing = dataRoot;
  while (!existsSync(existing)) existing = dirname(existing);
  const stat = statfsSync(existing, { bigint: true });
  if (stat.bavail * stat.bsize < BigInt(raw))
    throw new Error('DISK_BUDGET_TOO_LOW');
}
