import type {
  PluginDescriptor,
  CreatePluginBindingInput,
} from '@opencontext/contracts';

export function pluginDefaults(plugin: PluginDescriptor | undefined) {
  return Object.fromEntries(
    (plugin?.fields ?? []).map((field) => [field.key, field.default ?? '']),
  );
}

export function defaultProcessor(
  plugins: PluginDescriptor[],
  connector?: PluginDescriptor,
) {
  return (
    plugins.find(
      (plugin) =>
        plugin.available &&
        plugin.capability === 'processor' &&
        plugin.packageRef === connector?.recommendedProcessorRef,
    ) ??
    plugins.find(
      (plugin) => plugin.available && plugin.capability === 'processor',
    )
  );
}

export function bindingDefaults(
  plugins: PluginDescriptor[],
): CreatePluginBindingInput {
  const connector = plugins.find(
    (plugin) => plugin.available && plugin.capability === 'connector',
  );
  const processor = defaultProcessor(plugins, connector);
  return {
    name: '',
    connector: {
      packageRef: connector?.packageRef ?? '',
      config: pluginDefaults(connector),
    },
    processor: {
      packageRef: processor?.packageRef ?? '',
      config: pluginDefaults(processor),
    },
  };
}
