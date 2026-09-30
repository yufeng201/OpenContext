import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { ProcessorInput, ProcessorOutput } from '@opencontext/contracts';
import type { OfficialPlugin } from '@opencontext/plugin-sdk';

function literal(value: string): string {
  return value
    .replace(/[\\`*_[\]<>#|]/g, (character) => `\\${character}`)
    .replace(/[\r\n]/g, ' ');
}

function uriPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export const markdownProcessor: OfficialPlugin<
  ProcessorInput,
  ProcessorOutput
> = {
  manifest: {
    id: 'org.opencontext.markdown',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['processor'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  probe() {
    return {
      available: true,
      capabilities: ['processor'],
      limitations: [
        'Deterministic source excerpts and navigation only; no model-generated Wiki or semantic summary.',
        'The host must validate current ACL, fixed input revisions, output ownership and complete-set publication.',
      ],
    };
  },
  async invoke(input, context) {
    if (context.signal.aborted)
      throw new Error('CANCELLED: Markdown processing cancelled');
    if (input.files.length > 10_000)
      throw new Error('FILE_LIMIT: Markdown input exceeds 10000 files');
    const files = [...input.files].sort((a, b) =>
      a.file.fileId.localeCompare(b.file.fileId, 'en'),
    );
    const ids = new Set<string>();
    let inputBytes = 0;
    for (const [index, { file, text }] of files.entries()) {
      if (index % 64 === 0) {
        await yieldToEventLoop();
        if (context.signal.aborted)
          throw new Error('CANCELLED: Markdown processing cancelled');
      }
      if (
        file.projectId !== input.projectId ||
        file.bindingId !== input.bindingId ||
        file.collection !== 'sources' ||
        file.tombstone ||
        file.freshness !== 'fresh' ||
        ids.has(file.fileId) ||
        createHash('sha256').update(text).digest('hex') !== file.contentHash ||
        Buffer.byteLength(text) !== file.bytes
      ) {
        throw new Error(
          'INVALID_INPUT: Expected unique, current, hash-verified source files for this binding',
        );
      }
      ids.add(file.fileId);
      inputBytes += Buffer.byteLength(text);
      if (inputBytes > 104_857_600)
        throw new Error('BYTE_LIMIT: Markdown input exceeds 100 MiB');
    }
    // An empty successful full set removes prior generated modules/index through
    // the host's ownership gate. A thrown/aborted run never publishes a subset.
    if (files.length === 0)
      return { mode: 'full', complete: true, outputs: [] };
    const outputs: ProcessorOutput['outputs'] = [];
    const navigation: string[] = [];
    const allSources: { fileId: string; revisionId: string }[] = [];
    for (const [index, { file, text }] of files.entries()) {
      if (index % 64 === 0) await yieldToEventLoop();
      if (context.signal.aborted)
        throw new Error('CANCELLED: Markdown processing cancelled');
      const relativePath = `files/${createHash('sha256').update(file.fileId).digest('hex')}.md`;
      const uri = `oc://space/${uriPart(input.projectId)}/file/${uriPart(file.fileId)}@${uriPart(file.revisionId)}`;
      const dependency = { fileId: file.fileId, revisionId: file.revisionId };
      allSources.push(dependency);
      let excerpt = text.slice(0, 1_600);
      const last = excerpt.charCodeAt(excerpt.length - 1);
      const next = text.charCodeAt(excerpt.length);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
        excerpt = excerpt.slice(0, -1);
      const fence = '~'.repeat(
        Math.max(
          3,
          ...(excerpt.match(/~+/g) ?? []).map((match) => match.length + 1),
        ),
      );
      outputs.push({
        slotKey: `source:${file.fileId}`,
        relativePath,
        derivedFrom: [dependency],
        content:
          `# Source: ${literal(file.logicalPath)}\n\nDeterministic excerpt; this is derived navigation, not an independent factual summary.\n\n` +
          `Source: [${literal(file.logicalPath)}](${uri})\n\n` +
          `Revision: ${literal(file.revisionId)}\n\nSHA-256: ${file.contentHash}\n\nInput commit: ${literal(input.inputCommitId)}\n\n` +
          `${fence}text\n${excerpt}\n${fence}\n${text.length > excerpt.length ? '\nExcerpt truncated; read the cited revision for the complete source.\n' : ''}`,
      });
      navigation.push(
        `- [${literal(file.logicalPath)}](${relativePath}) — [fixed source](${uri}); SHA-256 ${file.contentHash}`,
      );
    }
    outputs.push({
      slotKey: 'index',
      relativePath: 'index.md',
      derivedFrom: allSources,
      content: `# Repository source index\n\nGenerated from commit ${literal(input.inputCommitId)}. Source excerpts and this index share the host's authorization and freshness gates.\n\n${navigation.join('\n')}\n`,
    });
    return { mode: 'full', complete: true, outputs };
  },
};
