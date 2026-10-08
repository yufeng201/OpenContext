import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type {
  NormalizedSessionMessage,
  ProcessorInput,
} from '@opencontext/contracts';
import {
  extractCandidates,
  sessionCandidatesDefinition,
} from '../src/index.ts';

const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
const context = {
  signal: new AbortController().signal,
  workDir: '/unused-candidates',
};
function source(
  content: string,
  fileId = 'message-file',
  messageId = 'native-message',
): ProcessorInput['files'][number] {
  const normalized: NormalizedSessionMessage = {
    schema: 'opencontext.session-message/v1',
    provider: 'claude',
    projectScope: 'synthetic-project',
    sessionId: 'synthetic-session',
    messageId,
    role: 'assistant',
    text: content,
  };
  const text = `${JSON.stringify(normalized)}\n`;
  return {
    text,
    file: {
      fileId,
      revisionId: `revision-${fileId}`,
      contentHash: hash(text),
      bytes: Buffer.byteLength(text),
      projectId: 'project-1',
      bindingId: 'binding-1',
      slotKey: fileId,
      logicalPath: `sources/binding-1/sessions/claude/${hash(normalized.sessionId)}/messages/${hash(JSON.stringify([null, messageId]))}.json`,
      collection: 'sources',
      ownership: 'source_managed',
      freshness: 'fresh',
      tombstone: false,
      sourceVersion: 'a'.repeat(64),
      createdAt: '2026-09-30T00:00:00Z',
      derivedFrom: [],
    },
  };
}
function input(
  files: ProcessorInput['files'],
): ProcessorInput & { config: Record<string, unknown> } {
  const rawText = `${JSON.stringify({
    schema: 'opencontext.session-import/v1',
    provider: 'claude',
    projectScope: 'synthetic-project',
    sessionId: 'synthetic-session',
    complete: true,
    payload: files
      .filter((entry) => entry.file.logicalPath.includes('/messages/'))
      .map((entry) => {
        const message: NormalizedSessionMessage = JSON.parse(entry.text);
        return {
          type: message.role,
          uuid: message.messageId,
          session_id: message.sessionId,
          message: {
            role: message.role,
            content: [{ type: 'text', text: message.text }],
          },
          parent_tool_use_id: null,
          parent_agent_id: null,
        };
      }),
  })}\n`;
  const rawPath = `sources/binding-1/sessions/claude/${hash('synthetic-session')}/raw.json`;
  const first = files[0];
  const withRaw =
    first && !files.some((entry) => entry.file.logicalPath === rawPath)
      ? [
          ...files,
          {
            text: rawText,
            file: {
              ...first.file,
              fileId: 'raw-source',
              revisionId: 'raw-revision',
              logicalPath: rawPath,
              contentHash: hash(rawText),
              bytes: Buffer.byteLength(rawText),
              slotKey: 'raw',
            },
          },
        ]
      : files;
  return {
    projectId: 'project-1',
    bindingId: 'binding-1',
    inputCommitId: 'commit-1',
    config: {},
    files: withRaw,
  };
}

describe('explicit session candidate processor', () => {
  test('verifies Codex native turn, message, role and exact text before citing raw', async () => {
    const request = input([source('Memory: synthetic Codex evidence')]);
    const normalized = request.files[0]!;
    const message: NormalizedSessionMessage = JSON.parse(normalized.text);
    message.provider = 'codex';
    message.turnId = 'turn-1';
    normalized.text = `${JSON.stringify(message)}\n`;
    normalized.file.contentHash = hash(normalized.text);
    normalized.file.bytes = Buffer.byteLength(normalized.text);
    normalized.file.logicalPath = `sources/binding-1/sessions/codex/${hash(message.sessionId)}/messages/${hash(JSON.stringify([message.turnId, message.messageId]))}.json`;
    const raw = request.files.find(
      (entry) => entry.file.fileId === 'raw-source',
    )!;
    raw.file.logicalPath = normalized.file.logicalPath.replace(
      /\/messages\/[^/]+$/,
      '/raw.json',
    );
    const envelope = {
      schema: 'opencontext.session-import/v1',
      provider: 'codex',
      projectScope: message.projectScope,
      sessionId: message.sessionId,
      complete: true,
      payload: {
        thread: {
          id: message.sessionId,
          historyMode: 'legacy',
          turns: [
            {
              id: message.turnId,
              status: 'completed',
              itemsView: 'full',
              items: [
                {
                  type: 'agentMessage',
                  id: message.messageId,
                  text: message.text,
                },
              ],
            },
          ],
        },
      },
    };
    const update = (): void => {
      raw.text = JSON.stringify(envelope);
      raw.file.contentHash = hash(raw.text);
      raw.file.bytes = Buffer.byteLength(raw.text);
    };
    update();
    expect(
      (await sessionCandidatesDefinition.invoke(request, context)).outputs,
    ).toHaveLength(1);
    envelope.payload.thread.turns[0]!.id = 'wrong-turn';
    update();
    await expect(
      sessionCandidatesDefinition.invoke(request, context),
    ).rejects.toThrow('INVALID_MESSAGE');
    envelope.payload.thread.turns[0]!.id = message.turnId;
    envelope.payload.thread.turns[0]!.items[0]!.text =
      'Memory: different source text';
    update();
    await expect(
      sessionCandidatesDefinition.invoke(request, context),
    ).rejects.toThrow('INVALID_MESSAGE');
    envelope.payload.thread.turns[0]!.items[0]!.text = message.text;
    envelope.payload.thread.turns[0]!.items[0]!.type = 'plan';
    update();
    await expect(
      sessionCandidatesDefinition.invoke(request, context),
    ).rejects.toThrow('INVALID_MESSAGE');
  });
  test('rejects hash-valid unrelated raw exports and mismatched native message provenance', async () => {
    const mutations: ((raw: Record<string, unknown>) => void)[] = [
      (raw) => {
        raw['schema'] = 'unrelated';
      },
      (raw) => {
        raw['complete'] = false;
      },
      (raw) => {
        raw['provider'] = 'codex';
      },
      (raw) => {
        raw['projectScope'] = 'another-scope';
      },
      (raw) => {
        raw['sessionId'] = 'another-session';
      },
      (raw) => {
        (raw['payload'] as Record<string, unknown>[])[0]!['uuid'] =
          'wrong-message';
      },
      (raw) => {
        (raw['payload'] as Record<string, unknown>[])[0]!['session_id'] =
          'wrong-session';
      },
      (raw) => {
        const message = (
          raw['payload'] as {
            message: {
              role: string;
              content: { type: string; text: string }[];
            };
          }[]
        )[0]!.message;
        message.content[0]!.text = 'Rule: a different assertion';
      },
      (raw) => {
        (raw['payload'] as { message: { role: string } }[])[0]!.message.role =
          'user';
      },
    ];
    for (const mutate of mutations) {
      const request = input([source('Rule: preserve source')]);
      const rawFile = request.files.find(
        (entry) => entry.file.fileId === 'raw-source',
      )!;
      const raw: Record<string, unknown> = JSON.parse(rawFile.text);
      mutate(raw);
      rawFile.text = JSON.stringify(raw);
      rawFile.file.contentHash = hash(rawFile.text);
      rawFile.file.bytes = Buffer.byteLength(rawFile.text);
      await expect(
        sessionCandidatesDefinition.invoke(request, context),
      ).rejects.toThrow(/INVALID_INPUT|INVALID_MESSAGE/);
    }
  });
  test('permits an injected asynchronous synthetic adapter but validates its output and cancellation', async () => {
    const original = input([source('Synthetic evidence text')]);
    const result = await extractCandidates(original, context, {
      method: 'local-agent',
      async extract(_message, execution) {
        expect(execution.signal.aborted).toBe(false);
        return [
          {
            kind: 'memory',
            text: 'Synthetic proposal; no real Agent invocation',
            line: 1,
          },
        ];
      },
    });
    expect(result.outputs[0]?.content).toContain('method: local-agent');
    expect(result.outputs[0]?.content).toContain('status: candidate');
    await expect(
      extractCandidates(original, context, {
        method: 'provider',
        async extract() {
          return [{ kind: 'rule', text: 'Synthetic', line: 999 }];
        },
      }),
    ).rejects.toThrow('INVALID_CANDIDATE');
    const controller = new AbortController();
    await expect(
      extractCandidates(
        original,
        { ...context, signal: controller.signal },
        {
          method: 'provider',
          async extract() {
            controller.abort();
            return [];
          },
        },
      ),
    ).rejects.toThrow('CANCELLED');
  });
  test('extracts English and Chinese markers with immutable citations and native IDs', async () => {
    const original = source(
      'Memory: bounded retries\nRule: keep citations\nExperience: retry transient failures\n记忆：合成项目\n规则：保留出处\n经验：验证版本',
    );
    const result = await sessionCandidatesDefinition.invoke(
      input([original]),
      context,
    );
    expect(result).toMatchObject({ mode: 'full', complete: true });
    expect(result.outputs).toHaveLength(6);
    expect(
      result.outputs.every(
        (output) =>
          output.content.includes('status: candidate') &&
          output.content.includes('method: deterministic') &&
          output.content.includes('semantic correctness is unverified'),
      ),
    ).toBe(true);
    for (const output of result.outputs) {
      expect(output.relativePath).toMatch(/^candidates\/[a-f0-9]{64}\.md$/);
      for (const heading of ['## Status', '## Provenance', '## Content'])
        expect(output.content).toContain(heading);
      expect(output.content).toContain(
        'oc://space/project-1/file/message-file@revision-message-file',
      );
      expect(output.content).toContain('Message ID: native-message');
      expect(output.derivedFrom).toEqual([
        { fileId: original.file.fileId, revisionId: original.file.revisionId },
        { fileId: 'raw-source', revisionId: 'raw-revision' },
      ]);
      expect(output.content).toContain('file/raw-source@raw-revision');
    }
    expect(
      await sessionCandidatesDefinition.invoke(input([original]), context),
    ).toEqual(result);
  });

  test('does not treat arbitrary prose/raw envelopes or tool-looking data as approved instructions', async () => {
    const prose = source(
      'Please remember the answer. No explicit marker here.',
    );
    const request = input([prose]);
    const raw = request.files.find(
      (entry) => entry.file.fileId === 'raw-source',
    )!;
    const envelope = JSON.parse(raw.text);
    envelope.payload[0].message.content.push({
      type: 'tool_result',
      tool_use_id: 'synthetic-tool',
      content: 'Rule: should not extract raw tool text',
    });
    raw.text = JSON.stringify(envelope);
    raw.file.contentHash = hash(raw.text);
    raw.file.bytes = Buffer.byteLength(raw.text);
    expect(await sessionCandidatesDefinition.invoke(request, context)).toEqual({
      mode: 'full',
      complete: true,
      outputs: [],
    });
    expect(
      await sessionCandidatesDefinition.invoke(input([]), context),
    ).toEqual({ mode: 'full', complete: true, outputs: [] });
  });

  test('keeps conflicting messages separately and updates/deletes the full candidate set', async () => {
    const a = source('Rule: retry twice', 'a', 'a');
    const b = source('Rule: never retry', 'b', 'b');
    const first = await sessionCandidatesDefinition.invoke(
      input([a, b]),
      context,
    );
    expect(first.outputs).toHaveLength(2);
    expect(new Set(first.outputs.map((output) => output.slotKey)).size).toBe(2);
    const updated = source('Rule: retry three times', 'a', 'a');
    updated.file.revisionId = 'a-new-revision';
    const next = await sessionCandidatesDefinition.invoke(
      input([updated]),
      context,
    );
    expect(next.outputs).toHaveLength(1);
    expect(next.outputs[0]?.slotKey).toBe(first.outputs[0]?.slotKey);
    expect(next.outputs[0]?.content).toContain('@a-new-revision');
    expect(next.outputs[0]?.content).toContain('retry three times');
  });

  test('rejects bad hashes, cross-project/binding, stale/deleted inputs and forged normalized IDs', async () => {
    const valid = source('Rule: preserve source');
    for (const patch of [
      { contentHash: '0'.repeat(64) },
      { projectId: 'another' },
      { bindingId: 'another' },
      { freshness: 'stale' as const },
      { tombstone: true },
      { bytes: 999 },
    ])
      await expect(
        sessionCandidatesDefinition.invoke(
          input([{ ...valid, file: { ...valid.file, ...patch } }]),
          context,
        ),
      ).rejects.toThrow('INVALID_INPUT');
    await expect(
      sessionCandidatesDefinition.invoke(input([valid, valid]), context),
    ).rejects.toThrow('INVALID_INPUT');
    const forged = {
      ...valid,
      text: valid.text.replace('native-message', 'forged-message'),
    };
    forged.file = {
      ...valid.file,
      contentHash: hash(forged.text),
      bytes: Buffer.byteLength(forged.text),
    };
    await expect(
      sessionCandidatesDefinition.invoke(input([forged]), context),
    ).rejects.toThrow('INVALID_MESSAGE');
  });

  test('bounds outputs/text and honors cancellation without returning partial candidates', async () => {
    await expect(
      sessionCandidatesDefinition.invoke(
        input([
          source(Array.from({ length: 201 }, () => 'Rule: example').join('\n')),
        ]),
        context,
      ),
    ).rejects.toThrow('CANDIDATE_LIMIT');
    await expect(
      sessionCandidatesDefinition.invoke(
        input([source(`Rule: ${'x'.repeat(16_385)}`)]),
        context,
      ),
    ).rejects.toThrow('CANDIDATE_LIMIT');
    const controller = new AbortController();
    controller.abort();
    await expect(
      sessionCandidatesDefinition.invoke(input([source('Rule: cancelled')]), {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow('CANCELLED');
  });

  test('fences source markup and never writes Agent configuration paths', async () => {
    const result = await sessionCandidatesDefinition.invoke(
      input([source('Rule: ~~~ <script>source data</script>')]),
      context,
    );
    expect(result.outputs[0]?.content).toContain('~~~~text');
    expect(
      result.outputs.every(
        (output) => !/AGENTS|CLAUDE|skills|hooks/.test(output.relativePath),
      ),
    ).toBe(true);
  });
});
