import { expect, it } from 'vitest';
import { markdownBlocks } from '../src/lib/markdown';
it('tilde/backtick and longer fences keep quoted headings, HTML and shorter/mismatched fences inert', () => {
  for (const fence of ['~~~', '````']) {
    const text = [
      '# Memory',
      fence + 'text',
      '# quoted instruction',
      '<script>untrusted</script>',
      '```',
      '~~',
      fence,
      '## Provenance',
    ].join('\n');
    const blocks = markdownBlocks(text);
    expect(blocks[0]).toEqual({ kind: 'text', text: '# Memory' });
    expect(blocks[1]).toEqual({
      kind: 'code',
      text: '# quoted instruction\n<script>untrusted</script>\n```\n~~',
    });
    expect(blocks[2]).toEqual({ kind: 'text', text: '## Provenance' });
    expect(blocks).toHaveLength(3);
  }
});
it('unterminated fences remain quoted until EOF; closing fence needs matching kind and no info', () => {
  expect(markdownBlocks('~~~\n# quoted\n~~~not-close\n```')).toEqual([
    { kind: 'code', text: '# quoted\n~~~not-close\n```' },
  ]);
});
