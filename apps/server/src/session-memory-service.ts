import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  readLocalText,
  type PluginDefinition,
  type ConnectorDefinition,
} from '@opencontext/plugin-sdk';
import {
  createReviewedAgentDefinition,
  AgentResponseSchema,
  agentHash,
} from '../../../plugins/session-candidates/src/local-agent.ts';
import {
  sessionMemory,
  memoryConnector,
  SessionMemoryConfigSchema,
  MemoryStateSchema,
  type SessionMemoryConfig,
  type MemoryHost,
  type MemoryApproval,
  type MemoryArgument,
  type MemoryCommand,
} from './session-memory-workflow.ts';

/** One server-owned selected source. No request may change directories or create a writer. */
export class SessionMemoryService {
  readonly config: SessionMemoryConfig;
  readonly definitions: PluginDefinition[];
  private approval: MemoryApproval | undefined;
  private active: Promise<unknown> | undefined;
  private activeKey: string | undefined;
  constructor(config: unknown, dataRoot: string, privateMode: boolean) {
    if (
      !Value.Check(SessionMemoryConfigSchema, config) ||
      resolve(config.dataRoot) !== resolve(dataRoot)
    )
      throw new Error('INVALID_CONFIG');
    if (config.enabled && !privateMode) throw new Error('POLICY_DENIED');
    this.config = structuredClone(config);
    const gate = (input: Record<string, unknown>) => {
      if (
        !this.config.enabled ||
        input['enabled'] !== true ||
        input['directory'] !== this.config.directory ||
        input['projectScope'] !== this.config.projectScope
      )
        throw new Error('POLICY_DENIED');
    };
    this.definitions = !config.enabled
      ? []
      : [
          {
            ...memoryConnector(config),
            validateConfig: gate,
            invoke: (input, context) => {
              gate(input.config);
              return memoryConnector(config).invoke(input, context);
            },
          } satisfies ConnectorDefinition,
          createReviewedAgentDefinition(() => this.approval),
        ];
  }
  private state() {
    const path = resolve(
      this.config.dataRoot,
      'plugin-state/session-memory/state.json',
    );
    if (!existsSync(path)) return undefined;
    const value: unknown = JSON.parse(readLocalText(path, 16_777_216));
    if (!Value.Check(MemoryStateSchema, value))
      throw new Error('CHECKPOINT_CORRUPT');
    if (value.configHash !== agentHash(this.config))
      throw new Error('INVALID_CONFIG');
    return value;
  }
  inspect(catalog?: MemoryHost['catalog']) {
    const state = this.config.enabled ? this.state() : undefined;
    return {
      enabled: this.config.enabled,
      format: this.config.format ?? 'v1',
      directory: this.config.directory,
      projectScope: this.config.projectScope,
      active: this.active !== undefined,
      status: !this.config.enabled ? 'disabled' : (state?.status ?? 'idle'),
      projectId: state?.projectId ?? null,
      bindingId: state?.bindingId ?? null,
      taskId: state?.task?.taskId ?? null,
      sourceVersion:
        (state && catalog?.getBinding(state.bindingId)?.sourceVersion) ??
        state?.taskVersion ??
        null,
      processedVersion: state?.processedVersion ?? null,
      reviewHash: state?.reviewHash ?? null,
      error: state?.error ?? null,
    };
  }
  handoff() {
    if (!this.config.enabled) throw new Error('NOT_FOUND');
    const state = this.state();
    if (
      !this.config.enabled ||
      !state?.task ||
      !['pending', 'review'].includes(state.status)
    )
      throw new Error('NOT_FOUND');
    return { task: state.task, responseSchema: AgentResponseSchema };
  }
  review() {
    if (!this.config.enabled) throw new Error('NOT_FOUND');
    const state = this.state();
    if (!this.config.enabled || state?.status !== 'review' || !state.reviewHash)
      throw new Error('NOT_FOUND');
    return {
      taskId: state.task!.taskId,
      reviewHash: state.reviewHash,
      markdown: readLocalText(
        resolve(this.config.dataRoot, 'plugin-state/session-memory/review.md'),
        8_388_608,
      ),
    };
  }
  async execute(
    command: MemoryCommand,
    argument: MemoryArgument | undefined,
    host: Omit<MemoryHost, 'setApproval'>,
  ) {
    if (!this.config.enabled) throw new Error('POLICY_DENIED');
    const key = JSON.stringify([command, argument]);
    if (this.active) {
      if (key !== this.activeKey) throw new Error('RESOURCE_BUSY');
      await this.active;
      return this.inspect(host.catalog);
    }
    const state = this.state();
    if (!state && command !== 'sync') throw new Error('NOT_FOUND');
    if (state) {
      const binding = host.catalog.getBinding(state.bindingId);
      if (!binding?.active || binding.projectId !== state.projectId)
        throw new Error('BINDING_REVOKED');
    }
    if (
      command === 'approve' &&
      typeof argument === 'object' &&
      state?.status === 'published' &&
      state.task?.taskId === argument.taskId &&
      state.reviewHash === argument.reviewHash
    ) {
      if (
        host.catalog.getBinding(state.bindingId)!.sourceVersion !==
        state.taskVersion
      )
        throw new Error('INPUT_CHANGED');
      return this.inspect(host.catalog);
    }
    this.activeKey = key;
    this.active = sessionMemory(
      this.config,
      command,
      argument,
      new AbortController().signal,
      {
        ...host,
        setApproval: (value) => {
          this.approval = value;
        },
      },
    );
    try {
      await this.active;
    } finally {
      this.active = undefined;
      this.activeKey = undefined;
      this.approval = undefined;
    }
    return this.inspect(host.catalog);
  }
  async settled(): Promise<void> {
    await this.active?.catch(() => undefined);
  }
}
