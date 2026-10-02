import { it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { StaticRegistry, PluginHostError } from '../src/index.ts';
import type { ConnectorDefinition } from '@opencontext/plugin-sdk';
const secret = 'SYNTHETIC_PRIVATE_NATIVE_DIAGNOSTIC';
const healthy = () => ({
  available: true,
  capabilities: ['connector' as const],
  limitations: ['No real source.'],
});
const base: ConnectorDefinition = {
  manifest: {
    id: 'fixture.projection',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['connector'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  capability: 'connector',
  artifactPaths: [import.meta.url],
  title: 'Projection',
  description: 'Offline controlled boundary fixture',
  configSchema: Type.Object({}, { additionalProperties: false }),
  fields: [],
  acceptsImports: true,
  probe: healthy,
  invoke: async () => ({
    sourceVersion: 'v1',
    complete: true,
    files: [],
    renames: [],
    skipped: [],
  }),
};
for (const field of [
  'available',
  'capabilities',
  'limitations',
  'array-access',
  'proxy',
] as const)
  for (const stage of ['list', 'prepareSync', 'prepare', 'resolve'] as const)
    it(`${stage} encloses ${field} probe access failure`, async () => {
      let broken = false;
      const boom = () => {
        throw new Error(secret);
      };
      const registry = new StaticRegistry([
        {
          ...base,
          probe: () => {
            if (!broken) return healthy();
            if (field === 'proxy') return new Proxy(healthy(), { get: boom });
            if (field === 'array-access')
              return {
                ...healthy(),
                capabilities: new Proxy(['connector' as const], { get: boom }),
              };
            return Object.defineProperty(healthy(), field, { get: boom });
          },
        },
      ]);
      const selection = { packageRef: 'fixture.projection@0.1.0', config: {} };
      const lock = registry.prepareSync(selection, 'connector');
      broken = true;
      let error: unknown;
      try {
        if (stage === 'list') registry.list();
        else if (stage === 'prepareSync')
          registry.prepareSync(selection, 'connector');
        else if (stage === 'prepare')
          await registry.prepare(selection, 'connector');
        else registry.resolve(lock, 'connector');
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({
        name: 'PluginHostError',
        code: 'PROCESSING_FAILED',
        message: 'PROCESSING_FAILED',
      });
      expect(
        String(error) + JSON.stringify(error) + (error as Error).stack,
      ).not.toContain(secret);
    });
it('probe projection serializes only bounded plain data and ignores unrelated native getters', () => {
  let read = 0;
  const status = {
    ...healthy(),
    get toJSON() {
      read++;
      throw new Error(secret);
    },
    get details() {
      read++;
      throw new Error(secret);
    },
  };
  const registry = new StaticRegistry([{ ...base, probe: () => status }]);
  expect(registry.list()[0]).toMatchObject({
    available: true,
    limitations: ['No real source.'],
  });
  expect(read).toBe(0);
});
it('invalid and oversized probe fields return stable contract failure', () => {
  for (const value of [
    { ...healthy(), available: 'yes' },
    { ...healthy(), capabilities: ['unknown'] },
    { ...healthy(), limitations: Array(21).fill('x') },
    { ...healthy(), limitations: ['x'.repeat(1001)] },
  ]) {
    const registry = new StaticRegistry([
      {
        ...base,
        probe: () => value as ReturnType<ConnectorDefinition['probe']>,
      },
    ]);
    expect(() => registry.list()).toThrow('INVALID_PLUGIN_OUTPUT');
  }
});
it('host construction, descriptor serialization and post-config access preserve stable native boundary', async () => {
  const poisoned = new Proxy(base, {
    get(target, key, receiver) {
      if (key === 'manifest') throw new Error(secret);
      return Reflect.get(target, key, receiver);
    },
  });
  expect(() => new StaticRegistry([poisoned])).toThrow(/^PROCESSING_FAILED$/);
  const definition = {
    ...base,
    configSchema: Type.Object({}, { additionalProperties: false }),
  };
  const registry = new StaticRegistry([definition]);
  Object.defineProperty(definition.configSchema, 'toJSON', {
    get() {
      throw new Error(secret);
    },
  });
  expect(() => registry.list()).toThrow(/^PROCESSING_FAILED$/);
});
it('probe exception proxy cannot make error classification itself throw', () => {
  const registry = new StaticRegistry([
    {
      ...base,
      probe: () => {
        throw new Proxy(new Error(secret), {
          getPrototypeOf() {
            throw new Error(secret);
          },
          getOwnPropertyDescriptor() {
            throw new Error(secret);
          },
        });
      },
    },
  ]);
  expect(() => registry.list()).toThrow(/^PROCESSING_FAILED$/);
});
it('getters that return valid data are read inside boundary and projected safely', () => {
  const registry = new StaticRegistry([
    {
      ...base,
      probe: () => ({
        get available() {
          return true;
        },
        get capabilities() {
          return ['connector' as const];
        },
        get limitations() {
          return ['No real source.'];
        },
      }),
    },
  ]);
  expect(registry.list()[0]?.available).toBe(true);
});

it('host error construction rejects unknown/coercing native values without original diagnostics', () => {
  const hostile = {
    toString() {
      throw new Error(secret);
    },
  };
  const result = new PluginHostError(hostile as unknown as string);
  expect(result).toMatchObject({
    name: 'PluginHostError',
    code: 'PROCESSING_FAILED',
    message: 'PROCESSING_FAILED',
  });
  expect(new PluginHostError('POLICY_DENIED')).toMatchObject({
    code: 'POLICY_DENIED',
  });
});
it('bounded probe copy ignores an unrelated hostile array iterator', () => {
  let reads = 0;
  const capabilities: ['connector'] = ['connector'];
  Object.defineProperty(capabilities, Symbol.iterator, {
    get() {
      reads++;
      throw new Error(secret);
    },
  });
  const registry = new StaticRegistry([
    { ...base, probe: () => ({ ...healthy(), capabilities }) },
  ]);
  expect(registry.list()[0]?.available).toBe(true);
  expect(reads).toBe(0);
});
