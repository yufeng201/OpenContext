import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

/** Bounded local operator input, never a URL or an implicit home-directory scan. */
export function readLocalText(path: string, maximum: number): string {
  if (realpathSync(path) !== resolve(path)) throw new Error('UNSAFE_SYMLINK');
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    const checkPath = () => {
      if (realpathSync(path) !== resolve(path))
        throw new Error('UNSAFE_SYMLINK');
      const current = statSync(path);
      if (current.dev !== before.dev || current.ino !== before.ino)
        throw new Error('INPUT_CHANGED');
    };
    checkPath();
    if (!before.isFile() || before.nlink !== 1) throw new Error('INVALID_PATH');
    if (before.size > maximum) throw new Error('BYTE_LIMIT');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    const after = fstatSync(fd);
    checkPath();
    if (
      count !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('INPUT_CHANGED');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, count),
    );
  } finally {
    closeSync(fd);
  }
}
