import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  createReleaseArchive,
  verifyReleaseArchive,
} from '../../scripts/release-archive.ts';
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oc-archive-harness-'));
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, '.node-version'), '24.19.0\n');
  writeFileSync(join(root, 'pkg/index.ts'), 'synthetic source');
  const files = {
    '.node-version': hash('24.19.0\n'),
    'pkg/index.ts': hash('synthetic source'),
  };
  writeFileSync(
    join(root, 'release-manifest.json'),
    JSON.stringify({
      format: 'opencontext-release/v1',
      sourceCommit: 'a'.repeat(40),
      sourceDirty: false,
      node: '24.19.0',
      pnpm: '11.19.0',
      files,
      treeHash: hash(JSON.stringify(files)),
    }),
  );
  return root;
}
test('portable archive preserves only declared files and exact ancestors; byte output repeats without filesystem metadata', () => {
  const root = fixture();
  try {
    const first = createReleaseArchive(root),
      second = createReleaseArchive(root);
    assert.deepEqual(first, second);
    const result = verifyReleaseArchive(first);
    assert.equal(result.fileCount, 3);
    assert.equal(result.directoryCount, 1);
    assert.equal(result.memberCount, 4);
    assert.equal(result.sourceCommit, 'a'.repeat(40));
    assert.equal(
      result.sha256,
      createHash('sha256').update(first).digest('hex'),
    );
    writeFileSync(join(root, 'foreign.txt'), 'synthetic-private-marker');
    assert.throws(
      () => createReleaseArchive(root),
      /RELEASE_FILE_SET_MISMATCH/,
    );
    rmSync(join(root, 'foreign.txt'));
    writeFileSync(join(root, '._manifest'), 'synthetic-metadata');
    assert.throws(() => createReleaseArchive(root), /INVALID_RELEASE_ARCHIVE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('complete archive checking rejects AppleDouble, foreign/duplicate entries, links, unsafe paths, directories, hash and header metadata', () => {
  const root = fixture();
  try {
    const compressed = createReleaseArchive(root),
      tar = gunzipSync(compressed),
      chunks: Buffer[] = [];
    let position = 0;
    while (tar[position] !== 0) {
      const size = parseInt(
          tar.subarray(position + 124, position + 136).toString('ascii'),
          8,
        ),
        end = position + 512 + Math.ceil(size / 512) * 512;
      chunks.push(tar.subarray(position, end));
      position = end;
    }
    const first = chunks[0]!;
    function checksum(header: Buffer) {
      header.fill(32, 148, 156);
      const sum = header.reduce((total, byte) => total + byte, 0);
      header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    }
    function extra(name: string, type = '0') {
      const b = Buffer.from(first.subarray(0, 512));
      b.fill(0, 0, 100);
      b.write(name, 0, 'ascii');
      b[156] = type.charCodeAt(0);
      b.write('00000000000\0', 124);
      if (type === '5') b.write('0000755\0', 100);
      checksum(b);
      return b;
    }
    function compress(data: Buffer) {
      const archive = gzipSync(data, { level: 9 });
      archive[9] = 255;
      return archive;
    }
    function invalid(parts: Buffer[], code: RegExp) {
      const data = compress(Buffer.concat([...parts, Buffer.alloc(1024)]));
      assert.throws(() => verifyReleaseArchive(data), code);
    }
    for (const name of [
      '._manifest',
      'pkg/._index.ts',
      '../outside',
      '/outside',
      './alias',
      'pkg//alias',
      'C:\\outside',
    ])
      invalid([...chunks, extra(name)], /INVALID_RELEASE_ARCHIVE/);
    invalid([...chunks, extra('foreign.txt')], /RELEASE_FILE_SET_MISMATCH/);
    invalid([...chunks, extra('foreign/', '5')], /RELEASE_FILE_SET_MISMATCH/);
    invalid([...chunks, first], /INVALID_RELEASE_ARCHIVE/);
    invalid([...chunks, extra('link', '2')], /INVALID_RELEASE_ARCHIVE/);
    invalid([...chunks, extra('hardlink', '1')], /INVALID_RELEASE_ARCHIVE/);
    invalid(
      chunks.filter((chunk) => chunk[156] !== 53),
      /RELEASE_FILE_SET_MISMATCH/,
    );
    const changed = Buffer.from(first);
    changed[512] = 120;
    invalid([changed, ...chunks.slice(1)], /RELEASE_HASH_MISMATCH/);
    const metadata = Buffer.from(first);
    metadata.write('synthetic-private-uname', 265);
    checksum(metadata.subarray(0, 512));
    invalid([metadata, ...chunks.slice(1)], /INVALID_RELEASE_ARCHIVE/);
    const padding = Buffer.from(first);
    padding[padding.length - 1] = 1;
    invalid([padding, ...chunks.slice(1)], /INVALID_RELEASE_ARCHIVE/);
    const gzipMetadata = Buffer.from(compressed);
    gzipMetadata[4] = 1;
    assert.throws(
      () => verifyReleaseArchive(gzipMetadata),
      /INVALID_RELEASE_ARCHIVE/,
    );
    const trailing = compress(Buffer.concat([tar, Buffer.alloc(512)]));
    assert.throws(
      () => verifyReleaseArchive(trailing),
      /INVALID_RELEASE_ARCHIVE/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
