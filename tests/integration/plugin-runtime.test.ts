import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from '@sinclair/typebox';
import type {
  ConnectorDefinition,
  ProcessorDefinition,
} from '../../packages/plugin-sdk/src/index.ts';
import type {
  Binding,
  ImportedObjectRef,
  Project,
  Run,
  SearchResult,
} from '../../packages/contracts/src/index.ts';
import { StaticRegistry } from '../../packages/plugin-host/src/index.ts';
import { createApplication } from '../../apps/server/src/app.ts';

const token = 'synthetic-plugin-runtime-owner-000000000000';
const headers = { authorization: 'Bearer ' + token };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

// This approved fixture is registered only at the composition boundary. No
// connector-specific HTTP route, catalog branch or worker case is needed.
function definitions(artifact: string) {
  const connector: ConnectorDefinition = {
    capability: 'connector',
    manifest: {
      id: 'fixture.note',
      version: '1.0.0',
      protocolVersion: '1',
      capabilities: ['connector'],
      location: 'server',
      trust: 'official-trusted-native',
    },
    artifactPaths: [import.meta.url, pathToFileURL(artifact).href],
    title: 'Synthetic notes',
    description: 'Local contract fixture; no network or model.',
    configSchema: Type.Object(
      { text: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    fields: [{ key: 'text', label: 'Text', kind: 'text' }],
    acceptsImports: true,
    recommendedProcessorRef: 'fixture.note-summary@1.0.0',
    probe: () => ({
      available: true,
      capabilities: ['connector'],
      limitations: ['Trusted test fixture.'],
    }),
    async invoke(input, context) {
      const texts = [input.config['text'] as string];
      for (const object of input.imports)
        texts.push(await context.readImport!(object));
      return {
        sourceVersion: 'fixture-v1',
        complete: true,
        files: [
          {
            relativePath: 'note.md',
            content: texts.join('\n'),
            mime: 'text/markdown',
          },
        ],
        renames: [],
        skipped: [],
      };
    },
  };
  const processor: ProcessorDefinition = {
    capability: 'processor',
    manifest: {
      id: 'fixture.note-summary',
      version: '1.0.0',
      protocolVersion: '1',
      capabilities: ['processor'],
      location: 'server',
      trust: 'official-trusted-native',
    },
    artifactPaths: [import.meta.url],
    title: 'Synthetic summary',
    description: 'Deterministic evidence copy.',
    configSchema: Type.Object({}, { additionalProperties: false }),
    fields: [],
    acceptsImports: false,
    probe: () => ({
      available: true,
      capabilities: ['processor'],
      limitations: ['No semantic model extraction.'],
    }),
    async invoke(input) {
      return {
        mode: 'full',
        complete: true,
        outputs: input.files.map(({ file, text }) => ({
          slotKey: file.fileId,
          relativePath: 'candidate/' + file.fileId + '.md',
          content:
            '# Candidate\n' +
            text +
            '\nSource: oc://space/' +
            input.projectId +
            '/file/' +
            file.fileId +
            '@' +
            file.revisionId +
            '\n',
          derivedFrom: [{ fileId: file.fileId, revisionId: file.revisionId }],
        })),
      };
    },
  };
  return { connector, processor };
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-plugin-runtime-'));
  const artifact = resolve(root, 'approved-artifact.txt');
  writeFileSync(artifact, 'fixture artifact version one');
  const plugins = definitions(artifact);
  let registry = new StaticRegistry([plugins.connector, plugins.processor]);
  let app = createApplication({
    dataRoot: resolve(root, 'data'),
    ownerToken: token,
    registry,
    autoStart: false,
  });
  cleanup.push(async () => {
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    artifact,
    plugins,
    get app() {
      return app;
    },
    async restart() {
      await app.app.close();
      registry = new StaticRegistry([plugins.connector, plugins.processor]);
      app = createApplication({
        dataRoot: resolve(root, 'data'),
        ownerToken: token,
        registry,
        autoStart: false,
      });
    },
    async setup() {
      const project = (
        await app.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers,
          payload: { name: 'Fixture plugin project' },
        })
      ).json<Project>();
      const response = await app.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/bindings`,
        headers,
        payload: {
          name: 'Second real scenario',
          connector: {
            packageRef: 'fixture.note@1.0.0',
            config: { text: 'plugin-amber-note' },
          },
          processor: { packageRef: 'fixture.note-summary@1.0.0', config: {} },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      return { project, binding: response.json<Binding>() };
    },
    async run(project: Project, binding: Binding, action: 'sync' | 'process') {
      const response = await app.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/bindings/${binding.id}/${action}`,
        headers,
      });
      expect(response.statusCode, response.body).toBe(202);
      const id = response.json<Run>().id;
      await app.coordinator.drain();
      return app.catalog.getRun(id)!;
    },
  };
}

it('runs a newly registered connector and processor through unchanged task, commit, index and MCP gates', async () => {
  const f = fixture();
  const { project, binding } = await f.setup();
  expect(binding.connector?.packageDigest).toMatch(/^[a-f0-9]{64}$/);
  const sync = await f.run(project, binding, 'sync');
  expect(sync.state).toBe('published');
  expect(sync.execution?.instance.ref).toBe(binding.connector!.ref);
  const generated = await f.run(project, binding, 'process');
  expect(generated.state).toBe('published');
  expect(generated.execution?.instance.ref).toBe(binding.processor!.ref);
  const head = f.app.catalog.head(project.id);
  expect((await f.run(project, binding, 'sync')).state).toBe('published');
  expect((await f.run(project, binding, 'process')).state).toBe('published');
  expect(f.app.catalog.head(project.id)).toBe(head);
  const result = (
    await f.app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/search`,
      headers,
      payload: { query: 'plugin-amber-note', mode: 'grep' },
    })
  ).json<SearchResult>();
  expect(new Set(result.hits.map((hit) => hit.file.collection))).toEqual(
    new Set(['sources', 'derived']),
  );
  const derived = result.hits.find((hit) => hit.file.collection === 'derived')!;
  await f.restart();
  const address = await f.app.app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(address + '/mcp', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'context_read',
        arguments: {
          projectId: project.id,
          fileId: derived.file.fileId,
          revisionId: derived.file.revisionId,
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('plugin-amber-note');
});

it('rejects unknown packages, wrong capabilities and config before persistence', async () => {
  const f = fixture();
  const { project } = await f.setup();
  for (const connector of [
    { packageRef: 'fixture.absent@1', config: {} },
    { packageRef: 'fixture.note-summary@1.0.0', config: {} },
    {
      packageRef: 'fixture.note@1.0.0',
      config: { text: 'x', secret: 'not-a-credential' },
    },
  ]) {
    const response = await f.app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/bindings`,
      headers,
      payload: {
        name: 'Rejected',
        connector,
        processor: { packageRef: 'fixture.note-summary@1.0.0', config: {} },
      },
    });
    expect(response.statusCode, response.body).toBe(400);
  }
  expect(f.app.catalog.listBindings(project.id)).toHaveLength(1);
});

it('creates separate configured instances for identical plugin config in two projects', async () => {
  const f = fixture();
  const first = await f.setup();
  const second = await f.setup();
  expect(first.binding.connector!.ref).not.toBe(second.binding.connector!.ref);
  expect(first.binding.connector!.configHash).toBe(
    second.binding.connector!.configHash,
  );
  expect((await f.run(first.project, first.binding, 'sync')).state).toBe(
    'published',
  );
  expect((await f.run(second.project, second.binding, 'sync')).state).toBe(
    'published',
  );
});

it('does not execute queued work with different package bytes after restart', async () => {
  const f = fixture();
  const { project, binding } = await f.setup();
  const queued = f.app.catalog.enqueue(binding.id, 'sync');
  await f.app.app.close();
  writeFileSync(f.artifact, 'changed artifact without retaining old version');
  await f.restart();
  expect(f.app.catalog.getRun(queued.id)!.execution).toEqual(queued.execution);
  await f.app.coordinator.drain();
  expect(f.app.catalog.getRun(queued.id)!.error).toBe('PLUGIN_LOCK_MISMATCH');
  expect(f.app.catalog.head(project.id)).toBeNull();
});

it('pins uploaded objects and rejects cross-binding import-port reads and reader writes', async () => {
  const f = fixture();
  const { project, binding } = await f.setup();
  const uploadUrl = `/api/projects/${project.id}/bindings/${binding.id}/imports`;
  const upload = await f.app.app.inject({
    method: 'POST',
    url: uploadUrl,
    headers,
    payload: { filename: 'fixture.json', content: '{"text":"import-amber"}' },
  });
  expect(upload.statusCode, upload.body).toBe(200);
  const object = upload.json<ImportedObjectRef>();
  const reader = f.app.catalog.createReaderToken(project.id);
  expect(
    (
      await f.app.app.inject({
        method: 'POST',
        url: uploadUrl,
        headers: { authorization: 'Bearer ' + reader.token },
        payload: { filename: 'x.json', content: '{}' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await f.run(project, binding, 'sync')).state).toBe('published');
  f.plugins.connector.invoke = async (_input, context) => {
    await context.readImport!({ ...object, id: 'another-binding-object' });
    throw new Error('UNREACHABLE');
  };
  expect((await f.run(project, binding, 'sync')).error).toBe(
    'IMPORT_ACCESS_DENIED',
  );
  expect(
    f.app.catalog.currentFiles(project.id).filter((file) => !file.tombstone),
  ).toHaveLength(1);
});
