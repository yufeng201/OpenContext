import { isErrorCode, safeErrorCode } from '@opencontext/contracts/errors';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Type, TypeGuard } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  ConnectionTestResultSchema,
  PluginManifestSchema,
  type ConnectionTestResult,
} from '@opencontext/contracts';
import type {
  ConnectorInvocation,
  ConnectorOutput,
  ExecutableCapability,
  ImportedObjectRef,
  PluginDescriptor,
  PluginInstanceLock,
  ProcessorInput,
  ProcessorOutput,
} from '@opencontext/contracts';
import type {
  ConfigurationContext,
  ConnectorDefinition,
  ExecutionContext,
  PluginDefinition,
  ProcessorDefinition,
} from '@opencontext/plugin-sdk';

export class PluginHostError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'PluginHostError';
    this.code = code;
  }
}
function fail(code: string): never {
  throw new PluginHostError(code);
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return fail('INVALID_PLUGIN_CONFIG');
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function freezeConfiguration(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const copy = structuredClone(config);
  function freeze(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(copy);
  return copy;
}
function configHash(config: Record<string, unknown>): string {
  try {
    const serialized = canonical(config);
    if (Buffer.byteLength(serialized) > 65_536) fail('INVALID_PLUGIN_CONFIG');
    return hash(serialized);
  } catch {
    return fail('INVALID_PLUGIN_CONFIG');
  }
}
function digest(definition: PluginDefinition): string {
  const digest = createHash('sha256');
  digest.update(
    canonical({
      manifest: definition.manifest,
      configSchema: definition.configSchema,
    }),
  );
  if (!definition.artifactPaths.length) fail('PLUGIN_ARTIFACT_UNREADABLE');
  for (const [index, path] of definition.artifactPaths.entries()) {
    try {
      const url = new URL(path);
      if (url.protocol !== 'file:') fail('PLUGIN_ARTIFACT_UNREADABLE');
      const bytes = readFileSync(url);
      digest.update(`\n${index}:${bytes.length}:`);
      digest.update(bytes);
    } catch {
      fail('PLUGIN_ARTIFACT_UNREADABLE');
    }
  }
  return digest.digest('hex');
}
// Identity is distinct from the package/config content hash. Equal configurations
// in different bindings/projects must never collapse into a shared instance.
// This syntax check is not authorization; the server owns binding/project gates.
const INSTANCE_REF =
  /^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@1$/;
const sourceFile = Type.Object(
  {
    relativePath: Type.String({ minLength: 1 }),
    content: Type.String(),
    mime: Type.Union([
      Type.Literal('text/plain'),
      Type.Literal('text/markdown'),
    ]),
  },
  { additionalProperties: false },
);
const reference = Type.Object(
  {
    fileId: Type.String({ minLength: 1 }),
    revisionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const connectorOutput = Type.Object(
  {
    sourceVersion: Type.String({ minLength: 1, maxLength: 1000 }),
    complete: Type.Literal(true),
    files: Type.Array(sourceFile, { maxItems: 10000 }),
    renames: Type.Array(
      Type.Object(
        {
          from: Type.String({ minLength: 1 }),
          to: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10000 },
    ),
    skipped: Type.Array(
      Type.Object(
        { path: Type.String(), reason: Type.String() },
        { additionalProperties: false },
      ),
      { maxItems: 10000 },
    ),
  },
  { additionalProperties: false },
);
const processorOutput = Type.Object(
  {
    mode: Type.Literal('full'),
    complete: Type.Literal(true),
    outputs: Type.Array(
      Type.Object(
        {
          slotKey: Type.String({ minLength: 1 }),
          relativePath: Type.String({ minLength: 1 }),
          content: Type.String(),
          derivedFrom: Type.Array(reference, { maxItems: 10000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10001 },
    ),
  },
  { additionalProperties: false },
);
function assertNotCancelled(context: ExecutionContext): void {
  if (context.signal.aborted) fail('CANCELLED');
}
function safePath(path: string): boolean {
  return (
    path.length <= 1000 &&
    path === path.normalize('NFC') &&
    !path.includes('\\') &&
    ![...path].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function checkFiles(
  files: { relativePath: string; content: string }[],
  maxFiles: number,
  maxBytes: number,
): void {
  if (files.length > maxFiles) fail('PLUGIN_OUTPUT_LIMIT');
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (!safePath(file.relativePath) || paths.has(file.relativePath))
      fail('INVALID_PLUGIN_OUTPUT');
    paths.add(file.relativePath);
    bytes += Buffer.byteLength(file.content);
    if (bytes > maxBytes) fail('PLUGIN_OUTPUT_LIMIT');
  }
}

/** Explicitly reviewed static code only. No dynamic import, DB port, secret resolver or sandbox claim. */
export class StaticRegistry {
  private readonly entries = new Map<
    string,
    { definition: PluginDefinition; digest: string }
  >();
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private active = 0;
  constructor(
    definitions: readonly PluginDefinition[],
    options: { timeoutMs?: number; maxConcurrent?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 10 ||
      this.timeoutMs > 30000 ||
      !Number.isInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 16
    )
      fail('INVALID_PLUGIN_LIMIT');
    for (const definition of definitions) {
      const { manifest } = definition;
      if (
        !Value.Check(PluginManifestSchema, manifest) ||
        !TypeGuard.IsSchema(definition.configSchema) ||
        definition.configSchema.type !== 'object' ||
        manifest.protocolVersion !== '1' ||
        manifest.location !== 'server' ||
        manifest.trust !== 'official-trusted-native' ||
        !manifest.capabilities.includes(definition.capability) ||
        !['connector', 'processor'].includes(definition.capability)
      )
        fail('INCOMPATIBLE_PLUGIN');
      const packageRef = `${manifest.id}@${manifest.version}`;
      if (this.entries.has(packageRef)) fail('DUPLICATE_PLUGIN');
      this.entries.set(packageRef, { definition, digest: digest(definition) });
    }
  }
  list(): PluginDescriptor[] {
    return [...this.entries.entries()].map(([packageRef, entry]) => {
      const { definition } = entry;
      const status = this.probe(definition);
      return {
        packageRef,
        packageDigest: entry.digest,
        capability: definition.capability,
        title: definition.title,
        description: definition.description,
        configSchema: JSON.parse(
          JSON.stringify(definition.configSchema),
        ) as Record<string, unknown>,
        fields: structuredClone(definition.fields),
        acceptsImports: definition.acceptsImports,
        available:
          status.available &&
          status.capabilities.includes(definition.capability) &&
          digest(definition) === entry.digest,
        limitations: [...status.limitations],
        ...(definition.capability === 'connector' && definition.testConnection
          ? { supportsConnectionTest: true }
          : {}),
        ...(definition.recommendedProcessorRef
          ? { recommendedProcessorRef: definition.recommendedProcessorRef }
          : {}),
      };
    });
  }
  /** Startup migration of existing trusted local bindings only; new APIs must await prepare. */
  prepareSync(
    selection: { packageRef: string; config: Record<string, unknown> },
    capability: ExecutableCapability,
  ): PluginInstanceLock {
    const entry = this.entry(selection.packageRef, capability);
    const configurationHash = this.validate(entry.definition, selection.config);
    return {
      ref: `instance:${randomUUID()}@1`,
      packageRef: selection.packageRef,
      packageDigest: entry.digest,
      configHash: configurationHash,
      capability,
      config: structuredClone(selection.config),
    };
  }
  async prepare(
    selection: { packageRef: string; config: Record<string, unknown> },
    capability: ExecutableCapability,
    context: ConfigurationContext = {},
  ): Promise<PluginInstanceLock> {
    const lock = this.prepareSync(selection, capability);
    if (context.signal?.aborted) fail('CANCELLED');
    const definition = this.resolve(lock, capability);
    if (definition.validateConfig)
      await this.withDeadline(
        (signal) =>
          Promise.resolve(
            definition.validateConfig!(lock.config, { ...context, signal }),
          ),
        context.signal,
      );
    // Recheck after asynchronous validation; no mutations may drift the prepared lock.
    this.resolve(lock, capability);
    return lock;
  }
  async validateImport(
    lock: PluginInstanceLock,
    content: string,
    context: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const definition = this.resolve(lock, 'connector');
    if (!definition.acceptsImports) fail('PLUGIN_IMPORTS_UNSUPPORTED');
    const frozenConfig = freezeConfiguration(lock.config);
    // Plugin errors stay intact (e.g. SECRET_DETECTED). The caller must not persist
    // the bytes until this preflight succeeds; absent hooks are not secret scans.
    if (context.signal?.aborted) fail('CANCELLED');
    if (definition.validateImport)
      await this.withDeadline(
        (signal) =>
          Promise.resolve(
            definition.validateImport!(content, frozenConfig, { signal }),
          ),
        context.signal,
      );
    this.resolve(lock, 'connector');
  }
  async testConnection(
    lock: PluginInstanceLock,
    signal: AbortSignal,
  ): Promise<ConnectionTestResult> {
    if (signal.aborted) fail('CONNECTION_TEST_CANCELLED');
    const definition = this.resolve(lock, 'connector');
    if (!definition.testConnection) fail('CONNECTION_TEST_UNSUPPORTED');
    let result: unknown;
    try {
      result = await this.withDeadline(
        (bound) =>
          definition.testConnection!(freezeConfiguration(lock.config), {
            signal: bound,
          }),
        signal,
      );
    } catch (error) {
      const code = safeErrorCode(error);
      if (code === 'CANCELLED') fail('CONNECTION_TEST_CANCELLED');
      if (code === 'PLUGIN_TIMEOUT') fail('CONNECTION_TEST_TIMEOUT');
      throw error;
    }
    if (signal.aborted) fail('CONNECTION_TEST_CANCELLED');
    this.resolve(lock, 'connector');
    if (
      !Value.Check(ConnectionTestResultSchema, result) ||
      !isErrorCode(result.code)
    )
      fail('INVALID_PLUGIN_OUTPUT');
    return result;
  }
  resolve(
    lock: PluginInstanceLock,
    capability: 'connector',
  ): ConnectorDefinition;
  resolve(
    lock: PluginInstanceLock,
    capability: 'processor',
  ): ProcessorDefinition;
  resolve(
    lock: PluginInstanceLock,
    capability: ExecutableCapability,
  ): PluginDefinition;
  resolve(
    lock: PluginInstanceLock,
    capability: ExecutableCapability,
  ): PluginDefinition {
    const entry = this.entry(lock.packageRef, capability);
    const configurationHash = this.validate(entry.definition, lock.config);
    if (
      lock.capability !== capability ||
      lock.packageDigest !== entry.digest ||
      lock.configHash !== configurationHash ||
      !INSTANCE_REF.test(lock.ref)
    )
      fail('PLUGIN_LOCK_MISMATCH');
    return entry.definition;
  }
  async invokeConnector(
    lock: PluginInstanceLock,
    input: ConnectorInvocation,
    context: ExecutionContext,
  ): Promise<ConnectorOutput> {
    const definition = this.resolve(lock, 'connector');
    if (configHash(input.config) !== lock.configHash)
      fail('PLUGIN_LOCK_MISMATCH');
    if (
      !Number.isSafeInteger(input.maxFiles) ||
      input.maxFiles < 1 ||
      input.maxFiles > 10000 ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > 104857600
    )
      fail('INVALID_PLUGIN_INPUT');
    if (input.imports.length && !definition.acceptsImports)
      fail('PLUGIN_IMPORTS_UNSUPPORTED');
    const refs = new Map(input.imports.map((ref) => [ref.id, ref]));
    if (refs.size !== input.imports.length) fail('INVALID_PLUGIN_INPUT');
    const output: unknown = await this.withDeadline((signal) => {
      const guardedContext: ExecutionContext = {
        ...context,
        instanceRef: lock.ref,
        signal,
      };
      if (context.readImport)
        guardedContext.readImport = async (ref: ImportedObjectRef) => {
          assertNotCancelled(guardedContext);
          const locked = refs.get(ref.id);
          if (!locked || canonical(locked) !== canonical(ref))
            fail('IMPORT_ACCESS_DENIED');
          const text = await context.readImport!(structuredClone(locked));
          assertNotCancelled(guardedContext);
          if (
            Buffer.byteLength(text) !== locked.bytes ||
            hash(text) !== locked.contentHash
          )
            fail('IMPORT_HASH_MISMATCH');
          return text;
        };
      assertNotCancelled(guardedContext);
      return definition.invoke(
        structuredClone({ ...input, config: lock.config }),
        guardedContext,
      );
    }, context.signal);
    assertNotCancelled(context);
    if (!Value.Check(connectorOutput, output)) fail('INVALID_PLUGIN_OUTPUT');
    checkFiles(output.files, input.maxFiles, input.maxBytes);
    if (
      output.renames.some(
        (rename) => !safePath(rename.from) || !safePath(rename.to),
      )
    )
      fail('INVALID_PLUGIN_OUTPUT');
    return output;
  }
  async invokeProcessor(
    lock: PluginInstanceLock,
    input: ProcessorInput & { config: Record<string, unknown> },
    context: ExecutionContext,
  ): Promise<ProcessorOutput> {
    const definition = this.resolve(lock, 'processor');
    if (configHash(input.config) !== lock.configHash)
      fail('PLUGIN_LOCK_MISMATCH');
    const references = new Set(
      input.files.map(({ file }) => `${file.fileId}\n${file.revisionId}`),
    );
    assertNotCancelled(context);
    const output: unknown = await this.withDeadline(
      (signal) =>
        definition.invoke(structuredClone({ ...input, config: lock.config }), {
          ...context,
          signal,
          instanceRef: lock.ref,
        }),
      context.signal,
    );
    assertNotCancelled(context);
    if (!Value.Check(processorOutput, output)) fail('INVALID_PLUGIN_OUTPUT');
    checkFiles(output.outputs, 10001, 104857600);
    const slots = new Set<string>();
    for (const file of output.outputs) {
      if (
        slots.has(file.slotKey) ||
        !file.derivedFrom.length ||
        file.derivedFrom.some(
          (ref) => !references.has(`${ref.fileId}\n${ref.revisionId}`),
        )
      )
        fail('INVALID_PLUGIN_OUTPUT');
      slots.add(file.slotKey);
    }
    return output;
  }
  operationCounts() {
    return { active: this.active, maxConcurrent: this.maxConcurrent };
  }
  /** Deadline bounds waiting; continuing trusted-native work retains its quota. */
  private async withDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    external?: AbortSignal,
  ): Promise<T> {
    if (external?.aborted) fail('CANCELLED');
    if (this.active >= this.maxConcurrent) fail('RESOURCE_BUSY');
    const controller = new AbortController(),
      forward = () => controller.abort('CANCELLED');
    external?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(
      () => controller.abort('PLUGIN_TIMEOUT'),
      this.timeoutMs,
    );
    this.active++;
    const running = Promise.resolve().then(() => {
      if (controller.signal.aborted) fail('CANCELLED');
      return operation(controller.signal);
    });
    void running.then(
      () => this.active--,
      () => this.active--,
    );
    let stop: () => void = () => {};
    try {
      return await new Promise<T>((resolve, reject) => {
        stop = () =>
          reject(new PluginHostError(String(controller.signal.reason)));
        controller.signal.addEventListener('abort', stop, { once: true });
        running.then(resolve, (error) =>
          reject(
            new PluginHostError(safeErrorCode(error, 'PROCESSING_FAILED')),
          ),
        );
      });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', forward);
      controller.signal.removeEventListener('abort', stop);
    }
  }
  private probe(definition: PluginDefinition) {
    try {
      return definition.probe();
    } catch (error) {
      throw new PluginHostError(safeErrorCode(error, 'PROCESSING_FAILED'));
    }
  }
  private entry(
    packageRef: string,
    capability: ExecutableCapability,
  ): { definition: PluginDefinition; digest: string } {
    const entry = this.entries.get(packageRef);
    if (!entry) return fail('UNKNOWN_PLUGIN');
    if (entry.definition.capability !== capability)
      fail('PLUGIN_CAPABILITY_MISMATCH');
    if (digest(entry.definition) !== entry.digest)
      fail('PLUGIN_ARTIFACT_CHANGED');
    const status = this.probe(entry.definition);
    if (!status.available || !status.capabilities.includes(capability))
      fail('PLUGIN_UNAVAILABLE');
    return entry;
  }
  private validate(
    definition: PluginDefinition,
    config: Record<string, unknown>,
  ): string {
    const configurationHash = configHash(config);
    try {
      if (!Value.Check(definition.configSchema, config))
        fail('INVALID_PLUGIN_CONFIG');
    } catch {
      fail('INVALID_PLUGIN_CONFIG');
    }
    return configurationHash;
  }
}
