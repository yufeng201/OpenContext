import type { FileEntry, Collection } from '@opencontext/contracts';

export function safeRelativePath(value: string): string {
  if (
    !value ||
    value.length > 1000 ||
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    /^[a-z]:/i.test(value)
  ) {
    throw new Error('INVALID_PATH');
  }
  return value;
}

// Pure publish policy: the host supplies identities/hashes; the catalog still
// rechecks the head and lease inside the actual transaction.
export function mergeOwnedSnapshot(
  current: FileEntry[],
  desired: FileEntry[],
  bindingId: string,
  collection: Collection,
): FileEntry[] {
  const keys = new Set<string>(),
    paths = new Set<string>();
  for (const next of desired) {
    safeRelativePath(next.logicalPath);
    if (
      next.bindingId !== bindingId ||
      next.collection !== collection ||
      keys.has(next.slotKey) ||
      paths.has(next.logicalPath) ||
      next.tombstone
    )
      throw new Error('INVALID_OUTPUT_SET');
    if (
      current.some(
        (old) =>
          old.bindingId === bindingId &&
          old.slotKey === next.slotKey &&
          old.ownership === 'human_owned' &&
          (old.collection !== collection ||
            old.revisionId !== next.revisionId ||
            old.logicalPath !== next.logicalPath),
      )
    )
      throw new Error('OUTPUT_CONFLICT');
    keys.add(next.slotKey);
    paths.add(next.logicalPath);
  }
  const replacements = new Map(desired.map((file) => [file.fileId, file]));
  const result = current.map((old) => {
    if (old.bindingId !== bindingId || old.collection !== collection)
      return { ...old };
    const next = replacements.get(old.fileId);
    if (old.ownership === 'human_owned') {
      if (
        next &&
        (next.revisionId !== old.revisionId ||
          next.logicalPath !== old.logicalPath)
      )
        throw new Error('OUTPUT_CONFLICT');
      replacements.delete(old.fileId);
      return { ...old };
    }
    if (next) {
      replacements.delete(old.fileId);
      return next;
    }
    return old.tombstone
      ? { ...old }
      : { ...old, tombstone: true, freshness: 'invalid' as const };
  });
  result.push(...[...replacements.values()].map((file) => ({ ...file })));
  // Promotion can move a slot to authored. It must not create another generated
  // file with the same binding/slot, even if a directory selector changed.
  for (const file of desired) {
    if (
      current.some(
        (old) =>
          old.bindingId === bindingId &&
          old.slotKey === file.slotKey &&
          old.ownership === 'human_owned' &&
          old.fileId !== file.fileId,
      )
    )
      throw new Error('OUTPUT_CONFLICT');
  }
  const activePaths = new Set<string>();
  for (const file of result)
    if (!file.tombstone) {
      if (activePaths.has(file.logicalPath)) throw new Error('OUTPUT_CONFLICT');
      activePaths.add(file.logicalPath);
    }
  // The bundled processor consumes the entire binding source selection, including
  // membership and paths. Byte-identical renames/additions also invalidate its
  // old navigation. A no-op sync must leave generated freshness unchanged.
  const sourceSelection = (files: FileEntry[]) =>
    JSON.stringify(
      files
        .filter(
          (file) =>
            file.bindingId === bindingId &&
            file.collection === 'sources' &&
            !file.tombstone,
        )
        .map((file) => [file.fileId, file.revisionId, file.logicalPath])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
  if (
    collection === 'sources' &&
    sourceSelection(current) !== sourceSelection(result)
  ) {
    for (const file of result) {
      if (
        file.bindingId === bindingId &&
        file.collection === 'derived' &&
        file.ownership === 'generated' &&
        !file.tombstone &&
        file.freshness === 'fresh'
      ) {
        file.freshness = 'stale';
      }
    }
  }
  const byId = new Map(result.map((file) => [file.fileId, file]));
  // Monotone freshness propagation; bounded by file count, no recursive cycles.
  for (let pass = 0; pass < result.length; pass++) {
    let changed = false;
    for (const file of result) {
      if (!file.derivedFrom.length || file.tombstone) continue;
      let freshness = file.freshness;
      for (const dep of file.derivedFrom) {
        const source = byId.get(dep.fileId);
        if (!source || source.tombstone || source.freshness === 'invalid') {
          freshness = 'invalid';
          break;
        }
        if (
          freshness !== 'invalid' &&
          (source.revisionId !== dep.revisionId || source.freshness === 'stale')
        )
          freshness = 'stale';
      }
      if (freshness !== file.freshness) {
        file.freshness = freshness;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result.sort((a, b) => a.fileId.localeCompare(b.fileId));
}
export function equalSnapshot(a: FileEntry[], b: FileEntry[]): boolean {
  return (
    JSON.stringify([...a].sort((x, y) => x.fileId.localeCompare(y.fileId))) ===
    JSON.stringify([...b].sort((x, y) => x.fileId.localeCompare(y.fileId)))
  );
}
