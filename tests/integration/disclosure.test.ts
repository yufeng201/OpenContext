import { it, expect } from 'vitest';
import { disclose } from '../../apps/server/src/disclosure.ts';
import { createHash } from 'node:crypto';
const text =
  '# Synthetic\nOverview\n## Memory\n中文🙂 memory\n### Detail\nEvidence\n```md\n## Other\n```\n## Other\nOther evidence\n';
it('Markdown section selection preserves nested headings, ignores fenced headings and has a byte-bounded resumable path', () => {
  expect(disclose(text, 'memory.md', {})).toEqual({ text });
  const section = disclose(text, 'memory.md', {
    section: 'Memory',
    maxBytes: 12,
  });
  expect(section.disclosure?.mode).toBe('section');
  expect(Buffer.byteLength(section.text)).toBeLessThanOrEqual(12);
  let reconstructed = section.text,
    offset = section.disclosure!.nextOffsetBytes;
  while (offset !== null) {
    const next = disclose(text, 'memory.md', {
      section: 'Memory',
      maxBytes: 12,
      offsetBytes: offset,
    });
    expect(next.text).not.toContain('\ufffd');
    expect(next.disclosure!.textHash).toBe(
      createHash('sha256').update(next.text).digest('hex'),
    );
    reconstructed += next.text;
    offset = next.disclosure!.nextOffsetBytes;
  }
  expect(reconstructed).toBe(
    '## Memory\n中文🙂 memory\n### Detail\nEvidence\n```md\n## Other\n```',
  );
  expect(disclose(text, 'memory.md', { startLine: 4, maxLines: 1 }).text).toBe(
    '中文🙂 memory',
  );
  expect(disclose(text, 'memory.md', { maxBytes: 65536 }).text).toBe(text);
});
it('reject ambiguous/missing sections, non-Markdown section requests, mixed ranges, invalid offsets and unsafe budgets', () => {
  for (const options of [
    { section: 'Missing' },
    { section: 'Memory', startLine: 1 },
    { startLine: 1000 },
    { maxBytes: 3 },
    { maxBytes: 65537 },
    { maxLines: 201 },
    { offsetBytes: 99999 },
  ])
    expect(() => disclose(text, 'memory.md', options)).toThrow(
      'INVALID_ARGUMENTS',
    );
  expect(() => disclose(text, 'raw.json', { section: 'Memory' })).toThrow();
  expect(() =>
    disclose('## Same\na\n## Same\nb', 'memory.md', { section: 'Same' }),
  ).toThrow();
  expect(() => disclose('中文', 'memory.md', { offsetBytes: 1 })).toThrow();
});

it('bounded deterministic heading discovery paginates without returning body or fenced pseudo-headings', () => {
  const first = disclose(text, 'memory.md', { outline: true, maxBytes: 120 });
  expect(first.text).toBe('');
  expect(first.disclosure!.mode).toBe('outline');
  expect(Buffer.byteLength(JSON.stringify(first.outline))).toBeLessThanOrEqual(
    120,
  );
  expect(first.disclosure!.nextOutlineLine).not.toBeNull();
  const next = disclose(text, 'memory.md', {
    outline: true,
    startLine: first.disclosure!.nextOutlineLine!,
    maxBytes: 8192,
  });
  expect([...first.outline!, ...next.outline!].map((h) => h.title)).toEqual([
    'Synthetic',
    'Memory',
    'Detail',
    'Other',
  ]);
  expect(() => disclose(text, 'raw.json', { outline: true })).toThrow();
  expect(() =>
    disclose(text, 'memory.md', { outline: true, section: 'Memory' }),
  ).toThrow();
  expect(() =>
    disclose(text, 'memory.md', { outline: true, maxBytes: 4 }),
  ).toThrow('BYTE_LIMIT');
});
