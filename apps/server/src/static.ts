import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
} from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
import { noLinks } from '@opencontext/state-sqlite/maintenance';
/** Public build files only. A filesystem error never turns into a file disclosure. */
export function readStaticAsset(root: string, path: string): Buffer {
  try {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      throw new Error('NOT_FOUND');
    noLinks(root);
    noLinks(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8_388_608)
        throw new Error('NOT_FOUND');
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error('NOT_FOUND');
  }
}
