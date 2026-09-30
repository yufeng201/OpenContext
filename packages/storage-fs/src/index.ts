import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import type { FileEntry } from '@opencontext/contracts';

export function hash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export class FileStore {
  readonly root: string;
  constructor(dataRoot: string) {
    this.root = resolve(dataRoot, 'content');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    syncDirectory(dirname(this.root));
  }
  private path(...parts: string[]): string {
    const path = resolve(this.root, ...parts);
    if (relative(this.root, path).startsWith('..' + sep))
      throw new Error('INVALID_PATH');
    return path;
  }
  private ensureDirectory(path: string): void {
    if (existsSync(path)) return;
    this.ensureDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
    syncDirectory(dirname(path));
  }
  private immutable(path: string, bytes: Buffer): void {
    this.ensureDirectory(dirname(path));
    if (existsSync(path)) {
      if (!readFileSync(path).equals(bytes))
        throw new Error('IMMUTABLE_OBJECT_MISMATCH');
      return;
    }
    const temp = path + '.tmp-' + randomUUID();
    let fd: number | null = null;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, path);
      syncDirectory(dirname(path));
    } finally {
      if (fd !== null) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  putText(text: string): { contentHash: string; bytes: number } {
    const bytes = Buffer.from(text, 'utf8'),
      contentHash = hash(bytes);
    this.immutable(
      this.path('blobs', contentHash.slice(0, 2), contentHash),
      bytes,
    );
    return { contentHash, bytes: bytes.length };
  }
  readText(contentHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('INVALID_HASH');
    const bytes = readFileSync(
      this.path('blobs', contentHash.slice(0, 2), contentHash),
    );
    if (hash(bytes) !== contentHash) throw new Error('CORRUPT_OBJECT');
    return bytes.toString('utf8');
  }
  revision(file: FileEntry): void {
    const {
      fileId,
      revisionId,
      contentHash,
      bytes,
      projectId,
      bindingId,
      createdAt,
      derivedFrom,
      sourceVersion,
    } = file;
    if (!/^[a-zA-Z0-9-]+$/.test(fileId) || !/^[a-zA-Z0-9-]+$/.test(revisionId))
      throw new Error('INVALID_ID');
    this.immutable(
      this.path('revisions', fileId, revisionId + '.json'),
      Buffer.from(
        JSON.stringify({
          fileId,
          revisionId,
          contentHash,
          bytes,
          projectId,
          bindingId,
          createdAt,
          derivedFrom,
          sourceVersion,
        }) + '\n',
      ),
    );
  }
  manifest(
    projectId: string,
    commitId: string,
    parent: string | null,
    files: FileEntry[],
  ): string {
    if (![projectId, commitId].every((id) => /^[a-zA-Z0-9-]+$/.test(id)))
      throw new Error('INVALID_ID');
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: '1',
        projectId,
        commitId,
        parent,
        files,
      }) + '\n',
    );
    this.immutable(this.path('commits', projectId, commitId + '.json'), bytes);
    return hash(bytes);
  }
  readManifest(
    projectId: string,
    commitId: string,
    expectedHash: string,
  ): { files: FileEntry[] } {
    if (![projectId, commitId].every((id) => /^[a-zA-Z0-9-]+$/.test(id)))
      throw new Error('INVALID_ID');
    const bytes = readFileSync(
      this.path('commits', projectId, commitId + '.json'),
    );
    if (hash(bytes) !== expectedHash) throw new Error('CORRUPT_MANIFEST');
    const object = JSON.parse(bytes.toString('utf8')) as {
      schemaVersion: string;
      projectId: string;
      commitId: string;
      files: FileEntry[];
    };
    if (
      object.schemaVersion !== '1' ||
      object.projectId !== projectId ||
      object.commitId !== commitId ||
      !Array.isArray(object.files)
    )
      throw new Error('CORRUPT_MANIFEST');
    return object;
  }
}
