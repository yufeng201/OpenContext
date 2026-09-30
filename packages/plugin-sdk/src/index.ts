import type {
  Capability,
  PluginManifest,
  PluginInstance,
} from '@opencontext/contracts';

export type ExecutionContext = {
  signal: AbortSignal;
  workDir: string;
  allowedLocalRepoRoot?: string;
};
export interface OfficialPlugin<I, O> {
  manifest: PluginManifest;
  probe(): {
    available: boolean;
    capabilities: Capability[];
    limitations: string[];
  };
  invoke(input: I, context: ExecutionContext): Promise<O>;
}
export function resolveInstance(
  instances: PluginInstance[],
  ref: string,
  capability: Capability,
): PluginInstance {
  const instance = instances.find((item) => item.ref === ref);
  if (!instance || !instance.capabilities.includes(capability))
    throw new Error('CAPABILITY_OR_INSTANCE_MISMATCH');
  return instance;
}
