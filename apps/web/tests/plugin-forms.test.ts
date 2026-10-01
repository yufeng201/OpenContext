import { expect, it, vi } from 'vitest';
import type { PluginDescriptor } from '@opencontext/contracts';
import { bindingDefaults, defaultProcessor } from '../src/lib/plugin-forms';
import { validateForm } from '../src/api/forms';

const descriptor = (
  packageRef: string,
  capability: PluginDescriptor['capability'],
  extra: Partial<PluginDescriptor> = {},
): PluginDescriptor => ({
  packageRef,
  capability,
  packageDigest: 'fixture-digest',
  title: 'Fixture',
  description: '',
  configSchema: { type: 'object', properties: {}, additionalProperties: false },
  fields: [],
  acceptsImports: false,
  available: true,
  limitations: [],
  ...extra,
});

it('uses registry order, descriptor defaults and recommended processor without package-name coupling', () => {
  const ignored = descriptor('test.disabled@1', 'connector', {
    available: false,
  });
  const source = descriptor('test.third-party-source@7', 'connector', {
    fields: [
      {
        key: 'projectScope',
        label: '项目范围',
        kind: 'text',
        default: 'scope-from-server',
      },
    ],
    recommendedProcessorRef: 'test.review@3',
  });
  const defaultOutput = descriptor('test.first-output@2', 'processor');
  const recommended = descriptor('test.review@3', 'processor', {
    fields: [
      {
        key: 'mode',
        label: '模式',
        kind: 'select',
        options: [{ value: 'strict', label: '严格' }],
        default: 'strict',
      },
    ],
  });
  const plugins = [ignored, source, defaultOutput, recommended];
  expect(bindingDefaults(plugins)).toEqual({
    name: '',
    connector: {
      packageRef: source.packageRef,
      config: { projectScope: 'scope-from-server' },
    },
    processor: {
      packageRef: recommended.packageRef,
      config: { mode: 'strict' },
    },
  });
  expect(
    defaultProcessor(
      [source, defaultOutput, { ...recommended, available: false }],
      source,
    )?.packageRef,
  ).toBe(defaultOutput.packageRef);
});

it('validates a descriptor config with its JSON Schema instead of a duplicated UI schema', async () => {
  const schema = {
    type: 'object',
    properties: { projectScope: { type: 'string', minLength: 3 } },
    required: ['projectScope'],
    additionalProperties: false,
  };
  const setError = vi.fn();
  expect(await validateForm(schema, { projectScope: 'ab' }, setError)).toBe(
    false,
  );
  expect(setError).toHaveBeenCalledWith(
    'projectScope',
    expect.objectContaining({ type: 'schema' }),
  );
  expect(
    await validateForm(schema, { projectScope: 'approved-project' }, vi.fn()),
  ).toBe(true);
});
