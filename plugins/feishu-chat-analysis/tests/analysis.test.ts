import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { FeishuChatMessage, ProcessorInput } from '@opencontext/contracts';
import {
  analyzeFeishuChat,
  feishuChatAnalysisDefinition,
} from '../src/index.ts';

const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
type Source = ProcessorInput['files'][number];
function source(
  text: string,
  patch: Partial<FeishuChatMessage> = {},
  fileId = 'message-file',
): Source {
  const message: FeishuChatMessage = {
    schema: 'opencontext.feishu-chat-message/v1',
    realm: 'feishu',
    evidence: 'simulated',
    chatId: 'synthetic-chat',
    messageId: 'synthetic-message',
    createTime: '1700000000000',
    updateTime: '1700000000001',
    messageType: 'text',
    text,
    raw: {},
    ...patch,
  };
  message.raw = patch.raw ?? {
    message_id: message.messageId,
    chat_id: message.chatId,
    msg_type: message.messageType,
    create_time: message.createTime,
    update_time: message.updateTime,
    deleted: false,
    body: { content: JSON.stringify({ text: message.text }) },
  };
  const serialized = `${JSON.stringify(message)}\n`;
  return {
    text: serialized,
    file: {
      fileId,
      revisionId: `revision-${fileId}`,
      contentHash: hash(serialized),
      bytes: Buffer.byteLength(serialized),
      projectId: 'project-1',
      bindingId: 'binding-1',
      slotKey: fileId,
      logicalPath: `sources/binding-1/chats/${hash(message.chatId)}/messages/${hash(message.messageId)}.json`,
      collection: 'sources',
      ownership: 'source_managed',
      freshness: 'fresh',
      tombstone: false,
      sourceVersion: 'source-version',
      createdAt: '2026-09-30T00:00:00Z',
      derivedFrom: [],
    },
  };
}
function rewrite(
  entry: Source,
  mutate: (message: FeishuChatMessage) => void,
): Source {
  const message: FeishuChatMessage = JSON.parse(entry.text);
  mutate(message);
  const text = `${JSON.stringify(message)}\n`;
  return {
    text,
    file: {
      ...entry.file,
      contentHash: hash(text),
      bytes: Buffer.byteLength(text),
    },
  };
}
function input(
  files: Source[],
): ProcessorInput & { config: Record<string, unknown> } {
  return {
    projectId: 'project-1',
    bindingId: 'binding-1',
    inputCommitId: 'commit-1',
    files,
    config: {},
  };
}
const context = () => ({
  signal: new AbortController().signal,
  workDir: '/unused-synthetic-chat-analysis',
});

describe('explicit Feishu chat candidate analysis', () => {
  test('produces all four English and Chinese candidate kinds with exact revision evidence', async () => {
    const entry = source(
      'Topic: Release scope\nConclusion: ship the smaller slice\nTodo: verify recovery\nRequirement: retain citations\n主题：版本计划\n结论：保留历史\n待办：检查权限\n需求：离线恢复',
    );
    const result = await feishuChatAnalysisDefinition.invoke(
      input([entry]),
      context(),
    );
    expect(result).toMatchObject({ mode: 'full', complete: true });
    expect(result.outputs).toHaveLength(8);
    for (const kind of ['topic', 'conclusion', 'todo', 'requirement'])
      expect(
        result.outputs.filter((output) =>
          output.content.startsWith(`# ${kind} candidate`),
        ),
      ).toHaveLength(2);
    for (const output of result.outputs) {
      expect(output.content).toContain('status: candidate');
      expect(output.content).toContain('method: deterministic');
      expect(output.content).toContain(
        'No LLM semantic analysis was performed',
      );
      expect(output.content).toContain(
        'oc://space/project-1/file/message-file@revision-message-file',
      );
      expect(output.content).toContain(`SHA-256: ${entry.file.contentHash}`);
      expect(output.content).toContain('Chat ID: synthetic-chat');
      expect(output.content).toContain('Message ID: synthetic-message');
      expect(output.derivedFrom).toEqual([
        { fileId: entry.file.fileId, revisionId: entry.file.revisionId },
      ]);
      expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(16384);
      expect(output.relativePath).toMatch(
        /^chat-candidates\/[a-f0-9]{64}\.md$/,
      );
    }
  });

  test('returns a complete empty set for unmarked text, nontext and unrelated sources', async () => {
    const unmarked = source(
      'A discussion with no explicit conclusion.\n> Topic: quoted nested marker\nWe say Todo: inside a sentence\nRequirement:   ',
    );
    const nontext = source(
      'Todo: should not parse image payload',
      { messageId: 'image', messageType: 'image' },
      'image-file',
    );
    const ignored = rewrite(nontext, (message) => {
      message.raw['body'] = { content: 'unsupported-image-body' };
    });
    const unrelatedText = 'Topic: not a normalized chat message';
    const unrelated = {
      text: unrelatedText,
      file: {
        ...source('').file,
        fileId: 'unrelated',
        logicalPath: 'sources/binding-1/notes.txt',
        contentHash: hash(unrelatedText),
        bytes: Buffer.byteLength(unrelatedText),
      },
    };
    expect(
      await analyzeFeishuChat(input([unmarked, ignored, unrelated]), context()),
    ).toEqual({ mode: 'full', complete: true, outputs: [] });
    expect(await analyzeFeishuChat(input([]), context())).toEqual({
      mode: 'full',
      complete: true,
      outputs: [],
    });
  });

  test('rejects forged raw identity, timestamps, text, deleted messages and normalized paths', async () => {
    const entry = source('Conclusion: retain fixed references');
    const mutations: ((message: FeishuChatMessage) => void)[] = [
      (m) => {
        m.raw['message_id'] = 'other';
      },
      (m) => {
        m.raw['chat_id'] = 'other';
      },
      (m) => {
        m.raw['msg_type'] = 'image';
      },
      (m) => {
        m.raw['create_time'] = '0';
      },
      (m) => {
        m.raw['update_time'] = '0';
      },
      (m) => {
        m.raw['deleted'] = true;
      },
      (m) => {
        m.raw['body'] = { content: 'not-json' };
      },
      (m) => {
        m.raw['body'] = { content: JSON.stringify({ text: 'different' }) };
      },
      (m) => {
        m.raw['body'] = { content: JSON.stringify({ text: 7 }) };
      },
      (m) => {
        m.messageId = 'wrong-normalized-id';
      },
    ];
    for (const mutate of mutations)
      await expect(
        analyzeFeishuChat(input([rewrite(entry, mutate)]), context()),
      ).rejects.toThrow('INVALID_MESSAGE');
    const optionalChat = rewrite(entry, (m) => {
      delete m.raw['chat_id'];
    });
    expect(
      (await analyzeFeishuChat(input([optionalChat]), context())).outputs,
    ).toHaveLength(1);
    const numericTimes = rewrite(entry, (m) => {
      m.raw['create_time'] = Number(m.createTime);
      m.raw['update_time'] = Number(m.updateTime);
    });
    expect(
      (await analyzeFeishuChat(input([numericTimes]), context())).outputs,
    ).toHaveLength(1);
    const missingUpdate = rewrite(entry, (m) => {
      delete m.raw['update_time'];
      m.updateTime = m.createTime;
    });
    expect(
      (await analyzeFeishuChat(input([missingUpdate]), context())).outputs,
    ).toHaveLength(1);
    const wrongPath = {
      ...entry,
      file: {
        ...entry.file,
        logicalPath: entry.file.logicalPath.replace(
          hash('synthetic-message'),
          'a'.repeat(64),
        ),
      },
    };
    await expect(
      analyzeFeishuChat(input([wrongPath]), context()),
    ).rejects.toThrow('INVALID_MESSAGE');
  });

  test('labels simulated and live evidence without upgrading either to verified semantics', async () => {
    for (const evidence of ['simulated', 'live'] as const) {
      const result = await analyzeFeishuChat(
        input([source('Todo: review evidence', { evidence })]),
        context(),
      );
      expect(result.outputs[0]?.content).toContain(`evidence: ${evidence}`);
      expect(result.outputs[0]?.content).toContain(
        'semantic correctness is unverified',
      );
      expect(result.outputs[0]?.content).toContain(
        evidence === 'simulated'
          ? 'does not verify access to a real group'
          : 'not independently fact-checked',
      );
    }
  });

  test('rejects cross-project, cross-binding, modified bytes and non-source ownership', async () => {
    const entry = source('Requirement: isolation');
    const changes: Partial<Source['file']>[] = [
      { projectId: 'another-project' },
      { bindingId: 'another-binding' },
      { ownership: 'human_owned' },
      { collection: 'derived' },
      { freshness: 'stale' },
      { freshness: 'invalid' },
      { tombstone: true },
      { bytes: 1 },
      { contentHash: 'a'.repeat(64) },
    ];
    for (const change of changes)
      await expect(
        analyzeFeishuChat(
          input([{ ...entry, file: { ...entry.file, ...change } }]),
          context(),
        ),
      ).rejects.toThrow('INVALID_INPUT');
    await expect(
      analyzeFeishuChat(input([entry, entry]), context()),
    ).rejects.toThrow('INVALID_INPUT');
    await expect(
      analyzeFeishuChat(
        input([
          entry,
          { ...entry, file: { ...entry.file, fileId: 'duplicate-path' } },
        ]),
        context(),
      ),
    ).rejects.toThrow('INVALID_INPUT');
  });

  test('enforces file, aggregate bytes, candidate count and complete rendered-file limits', async () => {
    const entry = source('Topic: small');
    await expect(
      analyzeFeishuChat(input(Array<Source>(10001).fill(entry)), context()),
    ).rejects.toThrow('FILE_LIMIT');
    const large = 'x'.repeat(1048576);
    const largeHash = hash(large);
    const oversized = Array.from({ length: 101 }, (_, index) => ({
      text: large,
      file: {
        ...entry.file,
        fileId: `large-${index}`,
        logicalPath: `sources/binding-1/large-${index}.txt`,
        contentHash: largeHash,
        bytes: large.length,
      },
    }));
    await expect(
      analyzeFeishuChat(input(oversized), context()),
    ).rejects.toThrow('BYTE_LIMIT');
    await expect(
      analyzeFeishuChat(
        input([
          source(
            Array.from(
              { length: 201 },
              (_, i) => `Todo: synthetic task ${i}`,
            ).join('\n'),
          ),
        ]),
        context(),
      ),
    ).rejects.toThrow('CANDIDATE_LIMIT');
    expect(
      (
        await analyzeFeishuChat(
          input([
            source(
              Array.from(
                { length: 200 },
                (_, i) => `Todo: synthetic task ${i}`,
              ).join('\n'),
            ),
          ]),
          context(),
        )
      ).outputs,
    ).toHaveLength(200);
    for (const bytes of [16000, 16385])
      await expect(
        analyzeFeishuChat(
          input([source(`Topic: ${'x'.repeat(bytes)}`)]),
          context(),
        ),
      ).rejects.toThrow('CANDIDATE_LIMIT');
  });

  test('yields and honours cancellation without returning partial candidates', async () => {
    const controller = new AbortController();
    const ctx = { ...context(), signal: controller.signal };
    const pending = analyzeFeishuChat(
      input([source('Topic: first\nTodo: second')]),
      ctx,
    );
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow('CANCELLED');
    await expect(
      analyzeFeishuChat(input([]), {
        ...context(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('CANCELLED');
  });

  test('keeps conflicting messages separate and is idempotent across commit IDs and input order', async () => {
    const first = source(
      'Conclusion: release now',
      { messageId: 'one' },
      'one',
    );
    const second = source(
      'Conclusion: postpone release',
      { messageId: 'two' },
      'two',
    );
    const original = input([first, second]);
    const result = await analyzeFeishuChat(original, context());
    expect(result.outputs).toHaveLength(2);
    expect(new Set(result.outputs.map((output) => output.slotKey)).size).toBe(
      2,
    );
    expect(
      await analyzeFeishuChat(
        {
          ...original,
          inputCommitId: 'unrelated-new-commit',
          files: [second, first],
        },
        context(),
      ),
    ).toEqual(result);
    expect(
      result.outputs.every(
        (output) => !output.content.includes(original.inputCommitId),
      ),
    ).toBe(true);
    const inserted = source(
      'Unmarked explanation\nConclusion: release now',
      { messageId: 'one' },
      'one',
    );
    expect(
      (await analyzeFeishuChat(input([inserted]), context())).outputs[0]
        ?.slotKey,
    ).toBe(result.outputs[0]?.slotKey);
  });

  test('escapes metadata and quotes markup and long fence runs as data', async () => {
    const entry = source(
      'Topic: ~~~~~ [open](javascript:ignored) <script>synthetic</script>',
      {
        chatId: 'chat\n# forged heading [link](https://example.invalid)',
        messageId: 'msg`[*]',
      },
      'file[1]',
    );
    const result = await analyzeFeishuChat(input([entry]), context());
    const text = result.outputs[0]!.content;
    expect(text).toContain('Chat ID: chat \\# forged heading \\[link\\]');
    expect(text).not.toContain('\n# forged heading');
    expect(text).toContain(
      '~~~~~~text\n~~~~~ [open](javascript:ignored) <script>synthetic</script>\n~~~~~~',
    );
    expect(text).toContain('file/file%5B1%5D@revision-file%5B1%5D');
    expect(text).toContain(
      'not an approved decision, executable rule or external task',
    );
  });

  test('rejects unknown configuration and exports the real static processor contract', async () => {
    await expect(
      analyzeFeishuChat(
        { ...input([]), config: { provider: 'paid-service' } },
        context(),
      ),
    ).rejects.toThrow('INVALID_CONFIG');
    expect(feishuChatAnalysisDefinition.manifest).toMatchObject({
      id: 'org.opencontext.feishu-chat-analysis',
      version: '0.1.0',
      capabilities: ['processor'],
      trust: 'official-trusted-native',
    });
    expect(feishuChatAnalysisDefinition.probe()).toMatchObject({
      available: true,
      capabilities: ['processor'],
    });
    expect(feishuChatAnalysisDefinition.acceptsImports).toBe(false);
  });
});
