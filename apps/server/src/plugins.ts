// Static composition root: adding an approved package changes this list, not
// HTTP routes, SQL persistence, or the task coordinator.
import { StaticRegistry } from '@opencontext/plugin-host';
import { repoDefinition } from '@opencontext/repo-connector';
import { markdownDefinition } from '@opencontext/markdown-processor';
import {
  codexSessionDefinition,
  claudeSessionDefinition,
} from '@opencontext/session-connector';
import { sessionCandidatesDefinition } from '@opencontext/session-candidates';
import {
  createFeishuChatDefinition,
  type FeishuChatOptions,
} from '@opencontext/feishu-chat';
import { feishuChatAnalysisDefinition } from '@opencontext/feishu-chat-analysis';
import { resolve } from 'node:path';
import type {
  Binding,
  CreateBindingInput,
  CreatePluginBindingInput,
  PreparedBinding,
} from '@opencontext/contracts';

export function createDefaultRegistry(
  dataRoot: string,
  feishu?: Omit<FeishuChatOptions, 'stateRoot'>,
): StaticRegistry {
  return new StaticRegistry([
    repoDefinition,
    markdownDefinition,
    codexSessionDefinition,
    claudeSessionDefinition,
    sessionCandidatesDefinition,
    createFeishuChatDefinition({
      stateRoot: resolve(dataRoot, 'plugin-state', 'feishu-chat'),
      resolveCredential: async () => undefined,
      ...feishu,
    }),
    feishuChatAnalysisDefinition,
  ]);
}

export function bindingSelection(
  input: CreateBindingInput | CreatePluginBindingInput,
): CreatePluginBindingInput {
  if ('connector' in input) return input;
  // Compatibility adapter for the original public Git-only API.
  return {
    name: input.name,
    connector: {
      packageRef: 'org.opencontext.repo@0.1.0',
      config: { repoUrl: input.repoUrl, branch: input.branch ?? 'main' },
    },
    processor: { packageRef: 'org.opencontext.markdown@0.1.0', config: {} },
  };
}

export function prepareLegacyBinding(
  registry: StaticRegistry,
  binding: Binding,
): PreparedBinding {
  return {
    name: binding.name,
    connector: registry.prepareSync(
      { packageRef: binding.packageRef, config: binding.config },
      'connector',
    ),
    processor: registry.prepareSync(
      { packageRef: 'org.opencontext.markdown@0.1.0', config: {} },
      'processor',
    ),
  };
}
