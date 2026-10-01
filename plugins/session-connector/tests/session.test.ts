import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import type {
  ConnectorInvocation,
  ImportedObjectRef,
} from '@opencontext/contracts';
import type { ExecutionContext } from '@opencontext/plugin-sdk';
import {
  codexSessionDefinition,
  claudeSessionDefinition,
} from '../src/index.ts';

const fixtures = {
  codex: await readFile(
    new URL('../fixtures/codex-session.json', import.meta.url),
    'utf8',
  ),
  claude: await readFile(
    new URL('../fixtures/claude-session.json', import.meta.url),
    'utf8',
  ),
};
function request(raws: string[]): {
  input: ConnectorInvocation;
  context: ExecutionContext;
} {
  const imports: ImportedObjectRef[] = raws.map((raw, index) => ({
    id: `import-${index}`,
    filename: `session-${index}.json`,
    contentHash: createHash('sha256').update(raw).digest('hex'),
    bytes: Buffer.byteLength(raw),
  }));
  return {
    input: {
      config: { projectScope: 'synthetic-project' },
      previousVersion: null,
      imports,
      maxFiles: 100,
      maxBytes: 8_388_608,
    },
    context: {
      signal: new AbortController().signal,
      workDir: '/unused-session-import',
      readImport: async (ref) =>
        raws[imports.findIndex((item) => item.id === ref.id)]!,
    },
  };
}
type MutableFixture = {
  projectScope: string;
  complete: boolean;
  provider: string;
  sessionId: string;
  unrecognized?: boolean;
  payload: {
    authorization?: string;
    thread: {
      historyMode: string;
      turns: {
        status: string;
        itemsView: string;
        items: {
          type: string;
          id?: string;
          text?: string;
          content: { type: string; text: string }[];
        }[];
      }[];
    };
  } & {
    authorization?: string;
    session_id: string;
    parent_agent_id?: string;
    message: { content: { type: string; text: string }[] };
  }[];
};
function mutated(
  provider: 'codex' | 'claude',
  edit: (value: MutableFixture) => void,
): string {
  const value = JSON.parse(fixtures[provider]);
  edit(value);
  return JSON.stringify(value);
}

describe.each([
  ['codex', codexSessionDefinition],
  ['claude', claudeSessionDefinition],
] as const)('%s explicit session import', (provider, definition) => {
  test('preserves approved raw bytes and emits stable native message identities', async () => {
    const { input, context } = request([fixtures[provider]]);
    const result = await definition.invoke(input, context);
    expect(result.complete).toBe(true);
    expect(result.files).toHaveLength(3);
    expect(
      result.files.find((file) => file.relativePath.endsWith('/raw.json'))
        ?.content,
    ).toBe(fixtures[provider]);
    const messages = result.files
      .filter((file) => file.relativePath.includes('/messages/'))
      .map((file) => JSON.parse(file.content));
    expect(messages).toHaveLength(2);
    expect(
      messages.every(
        (message) =>
          message.schema === 'opencontext.session-message/v1' &&
          message.provider === provider &&
          message.messageId &&
          message.sessionId,
      ),
    ).toBe(true);
    expect(
      await definition.invoke(
        { ...input, previousVersion: result.sourceVersion },
        context,
      ),
    ).toEqual(result);
    const duplicate = request([fixtures[provider], fixtures[provider]]);
    expect(await definition.invoke(duplicate.input, duplicate.context)).toEqual(
      result,
    );
  });

  test('rejects conflicting duplicate exports, cross scope, partial, wrong provider and unknown fields', async () => {
    const edits: ((value: MutableFixture) => void)[] = [
      (value) => {
        value.projectScope = 'other';
      },
      (value) => {
        value.complete = false;
      },
      (value) => {
        value.provider = 'unknown';
      },
      (value) => {
        value.unrecognized = true;
      },
      (value) => {
        value.sessionId = '';
      },
    ];
    for (const edit of edits) {
      const { input, context } = request([mutated(provider, edit)]);
      await expect(definition.invoke(input, context)).rejects.toThrow();
    }
    const conflict = request([fixtures[provider], `${fixtures[provider]} `]);
    await expect(
      definition.invoke(conflict.input, conflict.context),
    ).rejects.toThrow('DUPLICATE_SESSION_CONFLICT');
  });

  test('removes messages only with a complete replacement; explicit removal permits an empty full set', async () => {
    const initial = request([fixtures[provider]]);
    const first = await definition.invoke(initial.input, initial.context);
    const changed = request([
      mutated(provider, (value) => {
        if (provider === 'codex')
          value.payload.thread.turns[0]!.items.splice(1);
        else value.payload.splice(1);
      }),
    ]);
    const second = await definition.invoke(changed.input, changed.context);
    expect(second.files).toHaveLength(2);
    expect(second.sourceVersion).not.toEqual(first.sourceVersion);
    expect(
      second.files.find((file) => file.relativePath.includes('/messages/'))
        ?.relativePath,
    ).toBe(
      first.files.find((file) =>
        file.content.includes('How should this failure'),
      )?.relativePath,
    );
    const emptyHistory = request([
      mutated(provider, (value) => {
        if (provider === 'codex') value.payload.thread.turns = [];
        else value.payload.splice(0);
      }),
    ]);
    await expect(
      definition.invoke(emptyHistory.input, emptyHistory.context),
    ).rejects.toThrow('EMPTY_SESSION');
    const removed = request([]);
    const empty = await definition.invoke(removed.input, removed.context);
    expect(empty).toMatchObject({
      complete: true,
      files: [],
      skipped: [],
      renames: [],
    });
  });

  test('rejects secret metadata without redacting approved raw bytes or leaking content in errors', async () => {
    const rejected = request([
      mutated(provider, (value) => {
        value.payload.authorization = 'SYNTHETIC_SECRET_SENTINEL';
        if (provider === 'claude')
          value.payload[0]!.authorization = 'SYNTHETIC_SECRET_SENTINEL';
      }),
    ]);
    await expect(
      definition.invoke(rejected.input, rejected.context),
    ).rejects.toThrow('SECRET_DETECTED');
    await expect(
      definition.invoke(rejected.input, rejected.context),
    ).rejects.not.toThrow('SYNTHETIC_SECRET_SENTINEL');
  });

  test('rejects bad hashes, byte/file limits and cancellation without a partial return', async () => {
    const { input, context } = request([fixtures[provider]]);
    await expect(
      definition.invoke(
        {
          ...input,
          imports: [{ ...input.imports[0]!, contentHash: '0'.repeat(64) }],
        },
        context,
      ),
    ).rejects.toThrow('IMPORT_HASH_MISMATCH');
    await expect(
      definition.invoke({ ...input, maxFiles: 1 }, context),
    ).rejects.toThrow('FILE_LIMIT');
    await expect(
      definition.invoke({ ...input, maxBytes: 1 }, context),
    ).rejects.toThrow('BYTE_LIMIT');
    const controller = new AbortController();
    controller.abort();
    await expect(
      definition.invoke(input, { ...context, signal: controller.signal }),
    ).rejects.toThrow('CANCELLED');
  });
});

test('Codex rejects incomplete turn views, unsupported items, and conflicting native IDs', async () => {
  const edits: ((value: MutableFixture) => void)[] = [
    (value) => {
      value.payload.thread.turns[0]!.status = 'inProgress';
    },
    (value) => {
      value.payload.thread.turns[0]!.itemsView = 'summary';
    },
    (value) => {
      value.payload.thread.historyMode = 'paginated';
    },
    (value) => {
      value.payload.thread.turns[0]!.items[0]!.type = 'commandExecution';
    },
    (value) => {
      value.payload.thread.turns[0]!.items[0]!.content[0]!.type =
        'futureUnknownBlock';
    },
    (value) => {
      value.payload.thread.turns[0]!.items.push({
        ...value.payload.thread.turns[0]!.items[1]!,
        text: 'Conflicting text',
      });
    },
    (value) => {
      delete value.payload.thread.turns[0]!.items[1]!.id;
    },
  ];
  for (const edit of edits) {
    const { input, context } = request([mutated('codex', edit)]);
    await expect(
      codexSessionDefinition.invoke(input, context),
    ).rejects.toThrow();
  }
});

test('Claude rejects tool content, mismatched session IDs and subagent history', async () => {
  for (const edit of [
    (value: MutableFixture) => {
      value.payload[0]!.message.content[0]!.type = 'tool_result';
    },
    (value: MutableFixture) => {
      value.payload[0]!.session_id = 'another-session';
    },
    (value: MutableFixture) => {
      value.payload[0]!.parent_agent_id = 'subagent';
    },
  ]) {
    const { input, context } = request([mutated('claude', edit)]);
    await expect(
      claudeSessionDefinition.invoke(input, context),
    ).rejects.toThrow();
  }
});

test('known native tools are retained byte-for-byte with diagnostics, never normalized as rules', async () => {
  const codex = JSON.parse(fixtures.codex);
  codex.payload.thread.turns[0].items.push({
    type: 'commandExecution',
    id: 'command-1',
    command: 'echo synthetic',
    commandActions: [],
    cwd: '/synthetic/project',
    status: 'completed',
    aggregatedOutput: 'Rule: never extract this tool output',
  });
  codex.payload.thread.turns[0].items.push({
    type: 'mcpToolCall',
    id: 'mcp-1',
    arguments: {},
    server: 'synthetic',
    tool: 'read',
    status: 'completed',
  });
  const claude = JSON.parse(fixtures.claude);
  claude.payload[1].message.content.push({
    type: 'tool_use',
    id: 'tool-1',
    name: 'Read',
    input: { file_path: '/synthetic/example' },
  });
  claude.payload[0].message.content.push({
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'Rule: do not extract tool results',
  });
  for (const [value, definition] of [
    [codex, codexSessionDefinition],
    [claude, claudeSessionDefinition],
  ] as const) {
    const raw = JSON.stringify(value);
    const { input, context } = request([raw]);
    const result = await definition.invoke(input, context);
    expect(
      result.files.find((file) => file.relativePath.endsWith('/raw.json'))
        ?.content,
    ).toBe(raw);
    expect(result.skipped).toHaveLength(2);
    expect(
      result.skipped.every((skip) => skip.reason.endsWith('_raw_only')),
    ).toBe(true);
    expect(
      result.files
        .filter((file) => file.relativePath.includes('/messages/'))
        .every(
          (file) =>
            !file.content.includes('tool output') &&
            !file.content.includes('tool results'),
        ),
    ).toBe(true);
  }
});

test('preflight rejects secrets and partial history before host persistence', async () => {
  expect(() =>
    codexSessionDefinition.validateImport?.(
      mutated('codex', (value) => {
        value.payload.authorization = 'SYNTHETIC_REJECTED_VALUE';
      }),
      { projectScope: 'synthetic-project' },
    ),
  ).toThrow('SECRET_DETECTED');
  expect(() =>
    claudeSessionDefinition.validateImport?.(
      mutated('claude', (value) => {
        value.complete = false;
      }),
      { projectScope: 'synthetic-project' },
    ),
  ).toThrow('PARTIAL_SESSION');
  expect(() =>
    codexSessionDefinition.validateImport?.(fixtures.codex, {
      projectScope: 'synthetic-project',
    }),
  ).not.toThrow();
});
