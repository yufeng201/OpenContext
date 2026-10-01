import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { Type } from '@sinclair/typebox';
import type {
  ConnectorDefinition,
  ProcessorDefinition,
  ExecutionContext,
} from '@opencontext/plugin-sdk';
import type {
  ConnectorInvocation,
  ProcessorInput,
  ImportedObjectRef,
} from '@opencontext/contracts';
import { StaticRegistry } from '../src/index.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const sha = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
function definition(
  overrides: Partial<ConnectorDefinition> = {},
): ConnectorDefinition {
  return {
    manifest: {
      id: 'test.connector',
      version: '0.1.0',
      protocolVersion: '1',
      capabilities: ['connector'],
      location: 'server',
      trust: 'official-trusted-native',
    },
    capability: 'connector',
    artifactPaths: [import.meta.url],
    title: 'Fixture',
    description: 'Synthetic fixture',
    configSchema: Type.Object(
      { label: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    fields: [{ key: 'label', label: 'Label', kind: 'text' }],
    acceptsImports: false,
    probe: () => ({
      available: true,
      capabilities: ['connector'],
      limitations: ['Trusted native fixture.'],
    }),
    invoke: async (input) => ({
      sourceVersion: 'fixture-1',
      complete: true,
      files: [
        {
          relativePath: 'note.txt',
          content: input.config['label'] as string,
          mime: 'text/plain',
        },
      ],
      renames: [],
      skipped: [],
    }),
    ...overrides,
  };
}
function connectorInput(
  config: Record<string, unknown>,
  imports: ImportedObjectRef[] = [],
): ConnectorInvocation {
  return {
    config,
    imports,
    previousVersion: null,
    maxFiles: 100,
    maxBytes: 10000,
  };
}
function context(): ExecutionContext {
  return {
    signal: new AbortController().signal,
    workDir: '/unused-synthetic-plugin-fixture',
  };
}
describe('static trusted plugin registry', () => {
  test('injects locked instance identity and validates diagnostic evidence without publishing', async () => {
    let received: string | undefined;
    const def = definition({
      testConnection: async () => ({
        status: 'reachable',
        evidence: 'simulated',
        code: 'FIXTURE_OK',
      }),
      invoke: async (_input, ctx) => {
        received = ctx.instanceRef;
        return {
          sourceVersion: 'empty',
          complete: true,
          files: [],
          renames: [],
          skipped: [],
        };
      },
    });
    const registry = new StaticRegistry([def]);
    const lock = await registry.prepare(
      { packageRef: 'test.connector@0.1.0', config: { label: 'test' } },
      'connector',
    );
    expect(registry.list()[0]!.supportsConnectionTest).toBe(true);
    expect(await registry.testConnection(lock, context().signal)).toEqual({
      status: 'reachable',
      evidence: 'simulated',
      code: 'FIXTURE_OK',
    });
    await registry.invokeConnector(lock, connectorInput(lock.config), {
      ...context(),
      instanceRef: 'forged',
    });
    expect(received).toBe(lock.ref);
    def.testConnection = async () => ({
      status: 'reachable',
      evidence: 'simulated',
      code: 'raw response with sensitive data',
    });
    await expect(
      registry.testConnection(lock, context().signal),
    ).rejects.toThrow('INVALID_PLUGIN_OUTPUT');
    const abort = new AbortController();
    abort.abort();
    await expect(registry.testConnection(lock, abort.signal)).rejects.toThrow(
      'CONNECTION_TEST_CANCELLED',
    );
  });
  test('separates immutable instance identity from equal configuration locks and runs through the common host', async () => {
    const registry = new StaticRegistry([definition()]);
    const selection = {
      packageRef: 'test.connector@0.1.0',
      config: { label: 'NEEDLE' },
    };
    const lock = await registry.prepare(selection, 'connector');
    expect(lock.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.configHash).toMatch(/^[a-f0-9]{64}$/);
    const second = await registry.prepare(selection, 'connector');
    const migrated = registry.prepareSync(selection, 'connector');
    expect(new Set([lock.ref, second.ref, migrated.ref]).size).toBe(3);
    expect(lock.ref).toMatch(/^instance:[a-f0-9-]{36}@1$/);
    expect(second).toEqual({ ...lock, ref: second.ref });
    expect(migrated).toEqual({ ...lock, ref: migrated.ref });
    expect(registry.resolve(second, 'connector')).toBe(
      registry.resolve(lock, 'connector'),
    );
    expect(registry.list()[0]).toMatchObject({
      packageRef: selection.packageRef,
      available: true,
      capability: 'connector',
    });
    selection.config.label = 'CHANGED';
    expect(lock.config).toEqual({ label: 'NEEDLE' });
    expect(
      (
        await registry.invokeConnector(
          lock,
          connectorInput(lock.config),
          context(),
        )
      ).files[0]?.content,
    ).toBe('NEEDLE');
  });
  test('fails closed for unknown, duplicate, unavailable, incompatible or wrong-capability packages', () => {
    const def = definition();
    expect(() => new StaticRegistry([def, def])).toThrow('DUPLICATE_PLUGIN');
    const registry = new StaticRegistry([def]);
    expect(() =>
      registry.prepareSync({ packageRef: 'absent@1', config: {} }, 'connector'),
    ).toThrow('UNKNOWN_PLUGIN');
    expect(() =>
      registry.prepareSync(
        { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
        'processor',
      ),
    ).toThrow('PLUGIN_CAPABILITY_MISMATCH');
    const unavailable = new StaticRegistry([
      definition({
        probe: () => ({
          available: false,
          capabilities: ['connector'],
          limitations: [],
        }),
      }),
    ]);
    expect(unavailable.list()[0]?.available).toBe(false);
    expect(() =>
      unavailable.prepareSync(
        { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
        'connector',
      ),
    ).toThrow('PLUGIN_UNAVAILABLE');
    expect(
      () =>
        new StaticRegistry([
          definition({
            manifest: { ...def.manifest, protocolVersion: '2' as '1' },
          }),
        ]),
    ).toThrow('INCOMPATIBLE_PLUGIN');
  });
  test('rejects unsupported configuration, a changed digest, config or ref', async () => {
    const registry = new StaticRegistry([definition()]);
    const selection = {
      packageRef: 'test.connector@0.1.0',
      config: { label: 'x' },
    };
    for (const config of [
      {},
      { label: 7 },
      { label: 'x', secret: 'not-supported' },
      { label: undefined },
    ])
      expect(() =>
        registry.prepareSync({ ...selection, config }, 'connector'),
      ).toThrow('INVALID_PLUGIN_CONFIG');
    const lock = await registry.prepare(selection, 'connector');
    for (const changed of [
      { ...lock, packageDigest: '0'.repeat(64) },
      { ...lock, config: { label: 'other' } },
      { ...lock, configHash: '0'.repeat(64) },
      { ...lock, ref: 'different' },
    ])
      expect(() => registry.resolve(changed, 'connector')).toThrow(
        'PLUGIN_LOCK_MISMATCH',
      );
    await expect(
      registry.invokeConnector(
        lock,
        connectorInput({ label: 'different' }),
        context(),
      ),
    ).rejects.toThrow('PLUGIN_LOCK_MISMATCH');
  });
  test('hashes actual reviewed artifact bytes and rejects edits after registration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-plugin-registry-'));
    temporary.push(root);
    const path = join(root, 'plugin.js');
    writeFileSync(path, 'export const build = 1;\n');
    const def = definition({ artifactPaths: [pathToFileURL(path).href] });
    const registry = new StaticRegistry([def]);
    const selection = {
      packageRef: 'test.connector@0.1.0',
      config: { label: 'x' },
    };
    const lock = await registry.prepare(selection, 'connector');
    writeFileSync(path, 'export const build = 2;\n');
    expect(() => registry.resolve(lock, 'connector')).toThrow(
      'PLUGIN_ARTIFACT_CHANGED',
    );
    const next = new StaticRegistry([def]);
    expect((await next.prepare(selection, 'connector')).packageDigest).not.toBe(
      lock.packageDigest,
    );
    expect(() => next.resolve(lock, 'connector')).toThrow(
      'PLUGIN_LOCK_MISMATCH',
    );
  });
  test('only normal prepare executes asynchronous configuration policy', async () => {
    let calls = 0;
    const registry = new StaticRegistry([
      definition({
        validateConfig: async (_config, ctx) => {
          calls++;
          if (ctx.allowedLocalRepoRoot !== '/synthetic')
            throw new Error('POLICY_DENIED');
        },
      }),
    ]);
    const selection = {
      packageRef: 'test.connector@0.1.0',
      config: { label: 'x' },
    };
    registry.prepareSync(selection, 'connector');
    expect(calls).toBe(0);
    await expect(registry.prepare(selection, 'connector')).rejects.toThrow(
      'POLICY_DENIED',
    );
    await registry.prepare(selection, 'connector', {
      allowedLocalRepoRoot: '/synthetic',
    });
    expect(calls).toBe(2);
  });
  test('import preflight rejects before caller persistence and preserves stable plugin errors', async () => {
    let stored = false;
    const registry = new StaticRegistry([
      definition({
        acceptsImports: true,
        validateImport: async (content, config) => {
          expect(Object.isFrozen(config)).toBe(true);
          expect(config).toEqual({ label: 'x' });
          if (content === 'synthetic-secret-marker')
            throw new Error('SECRET_DETECTED');
        },
      }),
    ]);
    const lock = await registry.prepare(
      { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
      'connector',
    );
    const upload = async (content: string): Promise<void> => {
      await registry.validateImport(lock, content);
      stored = true;
    };
    await expect(upload('synthetic-secret-marker')).rejects.toThrow(
      'SECRET_DETECTED',
    );
    expect(stored).toBe(false);
    await upload('synthetic-safe-fixture');
    expect(stored).toBe(true);
    expect(lock.config).toEqual({ label: 'x' });
    const unsupported = new StaticRegistry([definition()]);
    const unsupportedLock = await unsupported.prepare(
      { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
      'connector',
    );
    await expect(
      unsupported.validateImport(unsupportedLock, '{}'),
    ).rejects.toThrow('PLUGIN_IMPORTS_UNSUPPORTED');
    const noHook = new StaticRegistry([definition({ acceptsImports: true })]);
    const noHookLock = await noHook.prepare(
      { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
      'connector',
    );
    await expect(
      noHook.validateImport(noHookLock, '{}'),
    ).resolves.toBeUndefined();
  });
  test('gives imports only to the locked object references and verifies bytes', async () => {
    const ref = {
      id: 'synthetic-import',
      filename: 'session.json',
      contentHash: sha('payload'),
      bytes: 7,
    };
    const run = async (readRef: ImportedObjectRef, readText = 'payload') => {
      const registry = new StaticRegistry([
        definition({
          acceptsImports: true,
          invoke: async (_input, ctx) => ({
            sourceVersion: 'one',
            complete: true,
            files: [
              {
                relativePath: 'note.txt',
                mime: 'text/plain',
                content: await ctx.readImport!(readRef),
              },
            ],
            renames: [],
            skipped: [],
          }),
        }),
      ]);
      const lock = await registry.prepare(
        { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
        'connector',
      );
      return registry.invokeConnector(
        lock,
        connectorInput(lock.config, [ref]),
        { ...context(), readImport: async () => readText },
      );
    };
    expect((await run(ref)).files[0]?.content).toBe('payload');
    await expect(run({ ...ref, id: 'other-binding' })).rejects.toThrow(
      'IMPORT_ACCESS_DENIED',
    );
    await expect(run({ ...ref, filename: 'different.json' })).rejects.toThrow(
      'IMPORT_ACCESS_DENIED',
    );
    await expect(run(ref, 'changed')).rejects.toThrow('IMPORT_HASH_MISMATCH');
  });
  test('rejects malformed, partial, duplicate-path, unsafe or over-budget connector output', async () => {
    const valid = {
      sourceVersion: '1',
      complete: true as const,
      files: [
        {
          relativePath: 'one.txt',
          content: 'payload',
          mime: 'text/plain' as const,
        },
      ],
      renames: [],
      skipped: [],
    };
    for (const output of [
      { ...valid, complete: false },
      { ...valid, files: [...valid.files, ...valid.files] },
      { ...valid, files: [{ ...valid.files[0], relativePath: '../escape' }] },
      { ...valid, files: [{ ...valid.files[0], content: 7 }] },
    ]) {
      const registry = new StaticRegistry([
        definition({ invoke: async () => output as typeof valid }),
      ]);
      const lock = await registry.prepare(
        { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
        'connector',
      );
      await expect(
        registry.invokeConnector(lock, connectorInput(lock.config), context()),
      ).rejects.toThrow('INVALID_PLUGIN_OUTPUT');
    }
    const registry = new StaticRegistry([
      definition({ invoke: async () => valid }),
    ]);
    const lock = await registry.prepare(
      { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
      'connector',
    );
    await expect(
      registry.invokeConnector(
        lock,
        { ...connectorInput(lock.config), maxBytes: 2 },
        context(),
      ),
    ).rejects.toThrow('PLUGIN_OUTPUT_LIMIT');
  });
  test('cancelled work never returns publishable output and SDK context has no DB port', async () => {
    const registry = new StaticRegistry([
      definition({
        invoke: async (_input, ctx) => {
          expect(Object.keys(ctx).sort()).toEqual([
            'instanceRef',
            'signal',
            'workDir',
          ]);
          return {
            sourceVersion: '1',
            complete: true,
            files: [],
            renames: [],
            skipped: [],
          };
        },
      }),
    ]);
    const lock = await registry.prepare(
      { packageRef: 'test.connector@0.1.0', config: { label: 'x' } },
      'connector',
    );
    await registry.invokeConnector(
      lock,
      connectorInput(lock.config),
      context(),
    );
    await expect(
      registry.invokeConnector(lock, connectorInput(lock.config), {
        ...context(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('CANCELLED');
  });
  test('processor references must belong to frozen authorized inputs; duplicate slots are rejected', async () => {
    const base = definition();
    const make = (
      derivedFrom: { fileId: string; revisionId: string }[],
      duplicate = false,
    ): ProcessorDefinition => ({
      ...base,
      manifest: {
        ...base.manifest,
        id: 'test.processor',
        capabilities: ['processor'],
      },
      capability: 'processor',
      probe: () => ({
        available: true,
        capabilities: ['processor'],
        limitations: [],
      }),
      invoke: async () => ({
        mode: 'full',
        complete: true,
        outputs: [
          {
            slotKey: 'one',
            relativePath: 'one.md',
            content: 'candidate',
            derivedFrom,
          },
          ...(duplicate
            ? [
                {
                  slotKey: 'one',
                  relativePath: 'two.md',
                  content: 'candidate',
                  derivedFrom,
                },
              ]
            : []),
        ],
      }),
    });
    const input: ProcessorInput & { config: Record<string, unknown> } = {
      projectId: 'project',
      bindingId: 'binding',
      inputCommitId: 'snapshot',
      files: [
        {
          file: {
            fileId: 'source',
            revisionId: 'rev-1',
            contentHash: sha('source text'),
            bytes: 11,
            projectId: 'project',
            bindingId: 'binding',
            slotKey: 'source',
            logicalPath: 'sources/binding/source.txt',
            collection: 'sources',
            ownership: 'source_managed',
            freshness: 'fresh',
            tombstone: false,
            sourceVersion: 'source-version',
            createdAt: '2026-09-30T00:00:00Z',
            derivedFrom: [],
          },
          text: 'source text',
        },
      ],
      config: { label: 'x' },
    };
    for (const def of [
      make([]),
      make([{ fileId: 'other-project', revisionId: 'old' }]),
      make([{ fileId: 'source', revisionId: 'rev-1' }], true),
      make([{ fileId: 'source', revisionId: 'rev-old' }]),
    ]) {
      const registry = new StaticRegistry([def]);
      const lock = await registry.prepare(
        { packageRef: 'test.processor@0.1.0', config: input.config },
        'processor',
      );
      await expect(
        registry.invokeProcessor(lock, input, context()),
      ).rejects.toThrow('INVALID_PLUGIN_OUTPUT');
    }
    const registry = new StaticRegistry([
      make([{ fileId: 'source', revisionId: 'rev-1' }]),
    ]);
    const lock = await registry.prepare(
      { packageRef: 'test.processor@0.1.0', config: input.config },
      'processor',
    );
    expect(
      (await registry.invokeProcessor(lock, input, context())).outputs,
    ).toHaveLength(1);
  });
});
