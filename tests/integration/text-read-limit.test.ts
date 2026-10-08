import { it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  openSync,
  ftruncateSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileStore,
  MAX_TEXT_READ_BYTES,
} from '../../packages/storage-fs/src/index.ts';
import { disclose } from '../../apps/server/src/disclosure.ts';
it('text reads accept the exact 16MiB limit and project a bounded body; oversized on-disk objects reject before decode/hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-text-budget-'));
  try {
    const store = new FileStore(root),
      text = 'x'.repeat(MAX_TEXT_READ_BYTES - 4) + '🙂',
      object = store.putText(text);
    expect(object.bytes).toBe(MAX_TEXT_READ_BYTES);
    expect(store.readText(object.contentHash)).toBe(text);
    const fragment = disclose(text, 'large.md', { maxBytes: 8192 });
    expect(Buffer.byteLength(fragment.text)).toBe(8192);
    expect(fragment.disclosure!.nextOffsetBytes).toBe(8192);
    const fd = openSync(
      join(
        store.root,
        'blobs',
        object.contentHash.slice(0, 2),
        object.contentHash,
      ),
      'r+',
    );
    ftruncateSync(fd, MAX_TEXT_READ_BYTES + 1);
    closeSync(fd);
    expect(() => store.readText(object.contentHash)).toThrow('BYTE_LIMIT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
