import { it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { StaticRegistry } from '../src/index.ts';
import type {
  ConnectorDefinition,
  ProcessorDefinition,
  ExecutionContext,
} from '@opencontext/plugin-sdk';
const base: ConnectorDefinition = {
  manifest: {
    id: 'fixture.lifecycle',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['connector'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  capability: 'connector',
  artifactPaths: [import.meta.url],
  title: 'Lifecycle',
  description: 'Offline controlled fixture',
  configSchema: Type.Object({}, { additionalProperties: false }),
  fields: [],
  acceptsImports: true,
  probe: () => ({
    available: true,
    capabilities: ['connector'],
    limitations: [],
  }),
  invoke: async () => ({
    sourceVersion: 'v1',
    complete: true,
    files: [],
    renames: [],
    skipped: [],
  }),
};
const context = () => ({
  signal: new AbortController().signal,
  workDir: '/synthetic-fixture',
});
const input = {
  config: {},
  previousVersion: null,
  imports: [],
  maxFiles: 10,
  maxBytes: 1000,
};
for (const hook of ['config', 'import', 'connector', 'processor'] as const)
  it(`${hook} noncooperative work times out, retains quota until settlement and receives aborted signal`, async () => {
    let release: () => void = () => {},
      seen: AbortSignal | undefined;
    const block = (signal?: AbortSignal) => {
      seen = signal;
      return new Promise<void>((r) => (release = r));
    };
    let connector = { ...base };
    const processor: ProcessorDefinition = {
      ...base,
      capability: 'processor',
      probe: () => ({
        available: true,
        capabilities: ['processor'],
        limitations: [],
      }),
      acceptsImports: false,
      manifest: {
        ...base.manifest,
        id: 'fixture.processor',
        capabilities: ['processor'],
      },
      invoke: async (_i, c) => {
        await block(c.signal);
        return { mode: 'full', complete: true, outputs: [] };
      },
    };
    if (hook === 'config')
      connector = { ...base, validateConfig: (_config, c) => block(c.signal) };
    if (hook === 'import')
      connector = {
        ...base,
        validateImport: (_text, _config, c) => block(c?.signal),
      };
    if (hook === 'connector')
      connector = {
        ...base,
        invoke: async (_i, c) => {
          await block(c.signal);
          return {
            sourceVersion: 'v1',
            complete: true as const,
            files: [],
            renames: [],
            skipped: [],
          };
        },
      };
    const registry = new StaticRegistry([connector, processor], {
      timeoutMs: 30,
      maxConcurrent: 1,
    });
    const lock = registry.prepareSync(
      {
        packageRef:
          hook === 'processor'
            ? 'fixture.processor@0.1.0'
            : 'fixture.lifecycle@0.1.0',
        config: {},
      },
      hook === 'processor' ? 'processor' : 'connector',
    );
    const invoke = () =>
      hook === 'config'
        ? registry.prepare(
            { packageRef: lock.packageRef, config: {} },
            'connector',
          )
        : hook === 'import'
          ? registry.validateImport(lock, '{}')
          : hook === 'connector'
            ? registry.invokeConnector(lock, input, context())
            : registry.invokeProcessor(
                lock,
                {
                  projectId: 'p1',
                  bindingId: 'b1',
                  inputCommitId: 'c1',
                  files: [],
                  config: {},
                },
                context(),
              );
    await expect(invoke()).rejects.toThrow('PLUGIN_TIMEOUT');
    expect(seen?.aborted).toBe(true);
    expect(registry.operationCounts().active).toBe(1);
    await expect(invoke()).rejects.toThrow('RESOURCE_BUSY');
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.operationCounts().active).toBe(0);
  });
it('caller cancellation does not expose its reason or permit a late import port read', async () => {
  let saved: ExecutionContext | undefined,
    release: () => void = () => {};
  const registry = new StaticRegistry(
    [
      {
        ...base,
        invoke: async (
          _i: Parameters<ConnectorDefinition['invoke']>[0],
          c: ExecutionContext,
        ) => {
          saved = c;
          await new Promise<void>((r) => (release = r));
          return {
            sourceVersion: 'v1',
            complete: true as const,
            files: [],
            renames: [],
            skipped: [],
          };
        },
      },
    ],
    { timeoutMs: 1000 },
  );
  const lock = registry.prepareSync(
      { packageRef: 'fixture.lifecycle@0.1.0', config: {} },
      'connector',
    ),
    controller = new AbortController();
  const pending = registry.invokeConnector(lock, input, {
    signal: controller.signal,
    workDir: '/synthetic',
    readImport: async () => {
      throw new Error('SHOULD_NOT_RUN');
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  controller.abort('PRIVATE_ABORT_SECRET');
  await expect(pending).rejects.toThrow('CANCELLED');
  expect(saved?.signal.aborted).toBe(true);
  await expect(
    saved!.readImport!({
      id: 'outside',
      filename: 'outside.json',
      bytes: 1,
      contentHash: 'f'.repeat(64),
    }),
  ).rejects.toThrow('CANCELLED');
  release();
});
it('unknown native errors are sanitized and explicit policy codes remain intact', async () => {
  const registry = new StaticRegistry([
    {
      ...base,
      validateConfig: () => {
        throw new Error('PRIVATE_CREDENTIAL_SECRET');
      },
    },
  ]);
  await expect(
    registry.prepare(
      { packageRef: 'fixture.lifecycle@0.1.0', config: {} },
      'connector',
    ),
  ).rejects.toThrow('PROCESSING_FAILED');
  const policy = new StaticRegistry([
    {
      ...base,
      validateConfig: () => {
        throw new Error('POLICY_DENIED: PRIVATE_REASON');
      },
    },
  ]);
  await expect(
    policy.prepare(
      { packageRef: 'fixture.lifecycle@0.1.0', config: {} },
      'connector',
    ),
  ).rejects.toThrow(/^POLICY_DENIED$/);
});
for (const manifest of [
  { ...base.manifest, protocolVersion: '2' },
  { ...base.manifest, version: 'latest' },
  { ...base.manifest, id: '../unsafe' },
  { ...base.manifest, capabilities: ['connector', 'connector'] },
  { ...base.manifest, secret: 'unrecognized' },
])
  it('rejects incompatible manifest shape before plugin code is invoked', () => {
    expect(
      () =>
        new StaticRegistry([
          { ...base, manifest: manifest as typeof base.manifest },
        ]),
    ).toThrow('INCOMPATIBLE_PLUGIN');
  });
it('rejects invalid top-level config schema and host limits at registration', () => {
  expect(
    () => new StaticRegistry([{ ...base, configSchema: Type.String() }]),
  ).toThrow('INCOMPATIBLE_PLUGIN');
  for (const timeoutMs of [0, 30001, NaN])
    expect(() => new StaticRegistry([base], { timeoutMs })).toThrow(
      'INVALID_PLUGIN_LIMIT',
    );
});
