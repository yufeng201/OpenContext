import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipped = new Set([
  '.git',
  'node_modules',
  '.cache',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
]);
export function files(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name) || entry.isSymbolicLink()) return [];
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
export function read(path: string): string {
  return readFileSync(path, 'utf8');
}
export function local(path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}
export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function regular(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
export function main(url: string): boolean {
  return process.argv[1] === fileURLToPath(url);
}
