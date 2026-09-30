import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { FileEntry, ProcessorInput } from '@opencontext/contracts';
import { markdownProcessor } from '../src/index.ts';

const context = {
  signal: new AbortController().signal,
  workDir: '/unused-no-files-written',
};
function source(
  id: string,
  text: string,
  name = `${id}.md`,
): ProcessorInput['files'][number] {
  const file: FileEntry = {
    fileId: id,
    revisionId: `revision-${id}`,
    contentHash: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    projectId: 'project-1',
    bindingId: 'binding-1',
    slotKey: name,
    logicalPath: `sources/binding-1/${name}`,
    collection: 'sources',
    ownership: 'source_managed',
    freshness: 'fresh',
    tombstone: false,
    sourceVersion: 'a'.repeat(40),
    createdAt: '2026-09-30T00:00:00Z',
    derivedFrom: [],
  };
  return { file, text };
}
function input(files: ProcessorInput['files']): ProcessorInput {
  return {
    projectId: 'project-1',
    bindingId: 'binding-1',
    inputCommitId: 'commit-1',
    files,
  };
}

describe('official deterministic Markdown processor', () => {
  test('does not split a Unicode surrogate pair at the excerpt boundary', async () => {
    const text = 'EMOJIQUERY ' + '😀'.repeat(800);
    const result = await markdownProcessor.invoke(
      input([source('unicode', text)]),
      context,
    );
    const output = result.outputs[0]!.content;
    expect(Buffer.from(output).toString('utf8')).toBe(output);
    expect(Buffer.from(output).toString('utf8')).not.toContain('�');
    expect(output).toContain('Excerpt truncated');
  });
  test('returns a deterministic full set with fixed revision/hash/source citations', async () => {
    const files = [source('b', 'Second source'), source('a', 'First source')];
    const result = await markdownProcessor.invoke(input(files), context);
    expect(result.mode).toBe('full');
    expect(result.complete).toBe(true);
    expect(result.outputs.map((output) => output.slotKey)).toEqual([
      'source:a',
      'source:b',
      'index',
    ]);
    expect(result.outputs[0]?.content).toContain(
      'oc://space/project-1/file/a@revision-a',
    );
    expect(result.outputs[0]?.content).toContain(files[1]?.file.contentHash);
    expect(result.outputs[0]?.derivedFrom).toEqual([
      { fileId: 'a', revisionId: 'revision-a' },
    ]);
    expect(
      await markdownProcessor.invoke(input([...files].reverse()), context),
    ).toEqual(result);
  });

  test('keeps module slots across source rename; deleted sources disappear from the successful full set', async () => {
    const a = source('a', 'A source');
    const b = source('b', 'B source');
    const first = await markdownProcessor.invoke(input([a, b]), context);
    const second = await markdownProcessor.invoke(
      input([
        {
          ...a,
          file: { ...a.file, logicalPath: 'sources/binding-1/renamed.md' },
        },
      ]),
      context,
    );
    expect(second.outputs.map((output) => output.slotKey)).toEqual([
      'source:a',
      'index',
    ]);
    expect(second.outputs[0]?.relativePath).toEqual(
      first.outputs[0]?.relativePath,
    );
    expect(second.outputs[0]?.content).toContain('renamed.md');
    expect(await markdownProcessor.invoke(input([]), context)).toEqual({
      mode: 'full',
      complete: true,
      outputs: [],
    });
  });

  test('treats source text as a fenced excerpt and records truncation', async () => {
    const result = await markdownProcessor.invoke(
      input([
        source(
          'a',
          `~~~\n<script>malicious source instructions</script>\n${'x'.repeat(2000)}`,
          '[name](bad).md',
        ),
      ]),
      context,
    );
    expect(result.outputs[0]?.content).toContain('~~~~text\n~~~');
    expect(result.outputs[0]?.content).toContain('Excerpt truncated');
    expect(result.outputs[0]?.content).toContain('\\[name\\](bad).md');
    expect(result.outputs[0]?.content).not.toContain('x'.repeat(2000));
  });

  test('rejects unverified, cross-binding, deleted, stale and duplicate inputs instead of partial output', async () => {
    const valid = source('a', 'Synthetic source');
    for (const file of [
      { ...valid.file, contentHash: '0'.repeat(64) },
      { ...valid.file, bindingId: 'another' },
      { ...valid.file, projectId: 'another' },
      { ...valid.file, tombstone: true },
      { ...valid.file, freshness: 'stale' as const },
      { ...valid.file, collection: 'derived' as const },
    ]) {
      await expect(
        markdownProcessor.invoke(input([{ ...valid, file }]), context),
      ).rejects.toThrow('INVALID_INPUT');
    }
    await expect(
      markdownProcessor.invoke(input([valid, valid]), context),
    ).rejects.toThrow('INVALID_INPUT');
  });

  test('honors cancellation without publishing output', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      markdownProcessor.invoke(input([source('a', 'Source')]), {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow('CANCELLED');
  });

  test('encodes URI delimiter characters and rejects input length mismatch', async () => {
    const unusual = source('a)(b', 'Source');
    const output = await markdownProcessor.invoke(input([unusual]), context);
    expect(output.outputs[0]?.content).toContain(
      'file/a%29%28b@revision-a%29%28b',
    );
    await expect(
      markdownProcessor.invoke(
        input([{ ...unusual, file: { ...unusual.file, bytes: 999 } }]),
        context,
      ),
    ).rejects.toThrow('INVALID_INPUT');
  });
});
