import type {
  Capability,
  PluginManifest,
  PluginInstance,
  PluginField,
  ImportedObjectRef,
  ConnectorInvocation,
  ConnectorOutput,
  ProcessorInput,
  ProcessorOutput,
  ConnectionTestResult,
} from '@opencontext/contracts';
import type { TSchema } from '@sinclair/typebox';

export type ExecutionContext = {
  signal: AbortSignal;
  workDir: string;
  /** Supplied by the registry from the locked instance, never by plugin configuration. */
  instanceRef?: string;
  allowedLocalRepoRoot?: string;
  /** Only imported objects frozen into this binding's run are exposed by the host. */
  readImport?(ref: ImportedObjectRef): Promise<string>;
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

export type ConfigurationContext = {
  allowedLocalRepoRoot?: string;
  signal?: AbortSignal;
};
type DefinitionMetadata = {
  manifest: PluginManifest;
  /** Reviewed local source/build files. The registry hashes bytes, not package names. */
  artifactPaths: readonly string[];
  title: string;
  description: string;
  configSchema: TSchema;
  fields: PluginField[];
  acceptsImports: boolean;
  recommendedProcessorRef?: string;
  probe(): {
    available: boolean;
    capabilities: Capability[];
    limitations: string[];
  };
  validateConfig?(
    config: Record<string, unknown>,
    context: ConfigurationContext,
  ): void | Promise<void>;
  /** Optional import preflight before the server persists user-selected bytes. */
  validateImport?(
    content: string,
    config: Record<string, unknown>,
    context?: { signal: AbortSignal },
  ): void | Promise<void>;
};
export type ConnectorDefinition = DefinitionMetadata & {
  capability: 'connector';
  testConnection?(
    config: Record<string, unknown>,
    context: { signal: AbortSignal },
  ): Promise<ConnectionTestResult>;
  invoke(
    input: ConnectorInvocation,
    context: ExecutionContext,
  ): Promise<ConnectorOutput>;
};
export type ProcessorDefinition = DefinitionMetadata & {
  capability: 'processor';
  invoke(
    input: ProcessorInput & { config: Record<string, unknown> },
    context: ExecutionContext,
  ): Promise<ProcessorOutput>;
};
/** Statically registered trusted code; this interface is not an OS sandbox. */
export type PluginDefinition = ConnectorDefinition | ProcessorDefinition;
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
