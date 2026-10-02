/** Portable, metadata-free canonical USTAR+gzip; no host tar or xattr APIs. */
import { createHash } from 'node:crypto';
import { gzipSync, inflateRawSync, crc32 } from 'node:zlib';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeErrorCode } from '../packages/contracts/src/errors.ts';
const MAX_BYTES = 64 * 1024 * 1024,
  MAX_MEMBERS = 2048;
const hash = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest('hex');
function fail(): never {
  throw new Error('INVALID_RELEASE_ARCHIVE');
}
function safePath(path: string): void {
  if (
    !/^[A-Za-z0-9._/-]{1,255}$/.test(path) ||
    path.startsWith('/') ||
    path.endsWith('/')
  )
    fail();
  if (
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /^(runtime|data|secrets|credentials|node_modules|plugin-state)$/.test(
            part,
          ) ||
          (part.startsWith('.') &&
            path !== '.node-version' &&
            path !== '.dockerignore'),
      )
  )
    fail();
}
type Manifest = {
  format: string;
  sourceCommit: string;
  sourceDirty: boolean;
  node: string;
  pnpm: string;
  treeHash: string;
  files: Record<string, string>;
};
function manifest(data: Buffer): Manifest {
  if (data.length > 1_048_576) fail();
  const m = JSON.parse(data.toString('utf8')) as Manifest;
  if (
    !m ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    Object.keys(m).sort().join(',') !==
      'files,format,node,pnpm,sourceCommit,sourceDirty,treeHash' ||
    m.format !== 'opencontext-release/v1' ||
    typeof m.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(m.sourceCommit) ||
    typeof m.sourceDirty !== 'boolean' ||
    m.node !== '24.19.0' ||
    m.pnpm !== '11.19.0' ||
    !m.files ||
    typeof m.files !== 'object' ||
    Array.isArray(m.files)
  )
    fail();
  const files = Object.entries(m.files);
  if (!files.length || files.length > 1024) fail();
  for (const [path, digest] of files) {
    safePath(path);
    if (
      path === 'release-manifest.json' ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      fail();
  }
  if (m.treeHash !== hash(JSON.stringify(m.files)))
    throw new Error('RELEASE_HASH_MISMATCH');
  return m;
}
function directories(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    let path = dirname(file);
    while (path !== '.') {
      dirs.add(path);
      path = dirname(path);
    }
  }
  return dirs;
}
function octal(value: number, width: number): string {
  const digits = value.toString(8);
  if (digits.length >= width) fail();
  return digits.padStart(width - 1, '0') + '\0';
}
/** A closed subset of POSIX USTAR. All timestamps/ids/names are constant. */
function header(path: string, directory: boolean, size: number): Buffer {
  safePath(path);
  const name = path + (directory ? '/' : '');
  let suffix = name,
    prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const splits = [...name.matchAll(/\//g)]
      .map((match) => match.index!)
      .reverse();
    const split = splits.find(
      (index) =>
        Buffer.byteLength(name.slice(0, index)) <= 155 &&
        Buffer.byteLength(name.slice(index + 1)) <= 100 &&
        name.slice(index + 1).length > 0,
    );
    if (split === undefined) fail();
    prefix = name.slice(0, split);
    suffix = name.slice(split + 1);
  }
  const b = Buffer.alloc(512);
  b.write(suffix, 0, 100, 'ascii');
  b.write(octal(directory ? 0o755 : 0o644, 8), 100);
  b.write(octal(0, 8), 108);
  b.write(octal(0, 8), 116);
  b.write(octal(size, 12), 124);
  b.write(octal(0, 12), 136);
  b.fill(32, 148, 156);
  b[156] = directory ? 53 : 48;
  b.write('ustar\0', 257);
  b.write('00', 263);
  b.write(prefix, 345, 155, 'ascii');
  const sum = b.reduce((total, byte) => total + byte, 0);
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
function field(b: Buffer, start: number, end: number): string {
  const bytes = b.subarray(start, end);
  return bytes
    .subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0))
    .toString('ascii');
}
function equalSets(actual: Set<string>, expected: Set<string>): void {
  if (
    actual.size !== expected.size ||
    [...actual].some((path) => !expected.has(path))
  )
    throw new Error('RELEASE_FILE_SET_MISMATCH');
}
export function verifyReleaseArchive(bytes: Buffer) {
  if (bytes.length > MAX_BYTES) throw new Error('RELEASE_ARCHIVE_LIMIT');
  if (
    !bytes
      .subarray(0, 10)
      .equals(Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 2, 255]))
  )
    fail();
  // Node24's synchronous info API reports the first raw stream's consumed
  // input, not the bytes supplied after it. gunzip would silently merge members.
  // @types/node lacks the documented info-return overload, hence this local cast.
  const inflated = inflateRawSync(bytes.subarray(10), {
    info: true,
    maxOutputLength: MAX_BYTES,
  }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const consumed = inflated.engine.bytesWritten;
  const trailer = 10 + consumed;
  if (
    !Number.isSafeInteger(consumed) ||
    consumed < 2 ||
    trailer + 8 !== bytes.length
  )
    fail();
  const tar = inflated.buffer;
  // CRC32 is Node's native implementation; no bespoke checksum/DEFLATE parser.
  if (
    bytes.readUInt32LE(trailer) !== crc32(tar) ||
    bytes.readUInt32LE(trailer + 4) !== tar.length
  )
    fail();
  const files = new Map<string, Buffer>(),
    dirs = new Set<string>();
  let offset = 0,
    count = 0;
  while (
    offset + 512 <= tar.length &&
    !tar.subarray(offset, offset + 512).equals(Buffer.alloc(512))
  ) {
    if (++count > MAX_MEMBERS) throw new Error('RELEASE_ARCHIVE_LIMIT');
    const b = tar.subarray(offset, offset + 512),
      name = field(b, 0, 100),
      prefix = field(b, 345, 500),
      raw = (prefix ? prefix + '/' : '') + name;
    const directory = b[156] === 53;
    if (b[156] !== 48 && !directory) fail();
    const path = directory ? raw.slice(0, -1) : raw;
    if (directory && !raw.endsWith('/')) fail();
    safePath(path);
    const sizeText = field(b, 124, 136);
    if (!/^[0-7]{11}$/.test(sizeText)) fail();
    const size = parseInt(sizeText, 8);
    if (
      !Number.isSafeInteger(size) ||
      size > MAX_BYTES ||
      (directory && size !== 0) ||
      !b.equals(header(path, directory, size))
    )
      fail();
    if (files.has(path) || dirs.has(path)) fail();
    offset += 512;
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tar.length) fail();
    const data = tar.subarray(offset, offset + size);
    if (tar.subarray(offset + size, offset + padded).some((byte) => byte !== 0))
      fail();
    if (directory) dirs.add(path);
    else files.set(path, data);
    offset += padded;
  }
  if (
    offset + 1024 !== tar.length ||
    tar.subarray(offset).some((byte) => byte !== 0)
  )
    fail();
  const data = files.get('release-manifest.json');
  if (!data) fail();
  const m = manifest(data);
  const expected = new Set([...Object.keys(m.files), 'release-manifest.json']);
  equalSets(new Set(files.keys()), expected);
  equalSets(dirs, directories([...expected]));
  for (const [path, digest] of Object.entries(m.files))
    if (hash(files.get(path)!) !== digest)
      throw new Error('RELEASE_HASH_MISMATCH');
  return {
    format: m.format,
    sourceCommit: m.sourceCommit,
    sourceDirty: m.sourceDirty,
    treeHash: m.treeHash,
    fileCount: files.size,
    directoryCount: dirs.size,
    memberCount: count,
    sha256: hash(bytes),
  };
}
function readRegular(root: string, path: string): Buffer {
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) fail();
  }
  const fd = openSync(
    join(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) fail();
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function createReleaseArchive(root: string): Buffer {
  root = resolve(root);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())
    fail();
  const data = readRegular(root, 'release-manifest.json'),
    m = manifest(data),
    expected = new Set([...Object.keys(m.files), 'release-manifest.json']),
    expectedDirs = directories([...expected]),
    actualFiles = new Set<string>(),
    actualDirs = new Set<string>();
  function walk(path: string): void {
    for (const name of readdirSync(join(root, path))) {
      const relative = path ? path + '/' + name : name;
      safePath(relative);
      const stat = lstatSync(join(root, relative));
      if (actualFiles.size + actualDirs.size >= MAX_MEMBERS)
        throw new Error('RELEASE_ARCHIVE_LIMIT');
      if (stat.isDirectory()) {
        actualDirs.add(relative);
        walk(relative);
      } else if (stat.isFile() && stat.nlink === 1) {
        actualFiles.add(relative);
      } else fail();
    }
  }
  walk('');
  equalSets(actualFiles, expected);
  equalSets(actualDirs, expectedDirs);
  const blocks: Buffer[] = [];
  let total = 1024;
  for (const path of [...expected, ...expectedDirs].sort()) {
    const directory = expectedDirs.has(path),
      bytes = directory ? Buffer.alloc(0) : readRegular(root, path);
    const padded = Math.ceil(bytes.length / 512) * 512;
    total += 512 + padded;
    if (total > MAX_BYTES) throw new Error('RELEASE_ARCHIVE_LIMIT');
    blocks.push(
      header(path, directory, bytes.length),
      bytes,
      Buffer.alloc(padded - bytes.length),
    );
  }
  blocks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
  // zlib's OS byte differs on Darwin/Linux; neutralize it. No header CRC is set.
  archive[9] = 255;
  verifyReleaseArchive(archive);
  return archive;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [command, input, target] = process.argv.slice(2);
    if (command === 'build' && input && target && process.argv.length === 5) {
      const bytes = createReleaseArchive(input);
      writeFileSync(resolve(target), bytes, { flag: 'wx', mode: 0o600 });
      console.log(
        JSON.stringify(
          verifyReleaseArchive(readFileSync(resolve(target))),
          null,
          2,
        ),
      );
    } else if (command === 'verify' && input && process.argv.length === 4)
      console.log(
        JSON.stringify(
          verifyReleaseArchive(readFileSync(resolve(input))),
          null,
          2,
        ),
      );
    else fail();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: safeErrorCode(error, 'INVALID_RELEASE_ARCHIVE'),
      }),
    );
    process.exitCode = 1;
  }
}
