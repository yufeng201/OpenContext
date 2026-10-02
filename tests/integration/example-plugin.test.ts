import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  notesConnector,
  notesProcessor,
} from '../../plugins/example-notes/src/index.ts';
import { StaticRegistry } from '../../packages/plugin-host/src/index.ts';
import { createApplication } from '../../apps/server/src/app.ts';
import { OpenContextClient } from '../../packages/http-client/src/index.ts';
it('documented standalone example registers, configures, imports, publishes, recalls and reads fixed source/derived revisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-example-plugin-')),
    owner = 'synthetic-example-owner-0000000000000';
  const registry = new StaticRegistry([notesConnector, notesProcessor]);
  const app = createApplication({
    dataRoot: join(root, 'data'),
    ownerToken: owner,
    registry,
    autoStart: false,
  });
  try {
    const origin = await app.app.listen({ host: '127.0.0.1', port: 0 }),
      headers = { authorization: 'Bearer ' + owner };
    const p = (
      await app.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: 'Developer example' },
      })
    ).json();
    const definition = {
      name: 'Notes',
      connector: {
        packageRef: 'example.notes@0.1.0',
        config: { prefix: 'Example' },
      },
      processor: {
        packageRef: 'example.notes-summary@0.1.0',
        config: { heading: 'Candidate' },
      },
    };
    const invalid = await app.app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/bindings`,
      headers,
      payload: {
        ...definition,
        connector: { ...definition.connector, config: { prefix: 1 } },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(app.catalog.listBindings(p.id)).toHaveLength(0);
    const b = (
      await app.app.inject({
        method: 'POST',
        url: `/api/projects/${p.id}/bindings`,
        headers,
        payload: definition,
      })
    ).json();
    const url = `/api/projects/${p.id}/bindings/${b.id}/imports`;
    const bad = await app.app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        filename: 'bad.json',
        content: '{"text":"safe","secret":"PRIVATE_EXAMPLE"}',
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('PRIVATE_EXAMPLE');
    expect(app.catalog.listImports(b.id)).toHaveLength(0);
    await app.app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        filename: 'note.json',
        content: JSON.stringify({ text: 'developer_unique_context 中文' }),
      },
    });
    for (const kind of ['sync', 'process']) {
      const queued = await app.app.inject({
        method: 'POST',
        url: `/api/projects/${p.id}/bindings/${b.id}/${kind}`,
        headers,
      });
      expect(queued.statusCode).toBe(202);
      await app.coordinator.drain();
      expect(app.catalog.listRuns(p.id)[0]?.state).toBe('published');
    }
    const reader = app.catalog.createReaderToken(p.id),
      sdk = new OpenContextClient({ baseUrl: origin, token: reader.token });
    const hits = (
      await sdk.search(p.id, {
        query: 'developer_unique_context',
        mode: 'grep',
      })
    ).hits;
    expect(new Set(hits.map((h) => h.file.collection))).toEqual(
      new Set(['sources', 'derived']),
    );
    for (const hit of hits) {
      expect(
        (await sdk.read(p.id, hit.file.fileId, hit.file.revisionId)).citation,
      ).toEqual(hit.citation);
      if (hit.file.collection === 'derived')
        expect(hit.file.derivedFrom).toHaveLength(1);
    }
    expect((await sdk.filesPage(p.id, { limit: 1 })).nextCursor).not.toBeNull();
    app.catalog.revokeBinding(b.id);
    expect((await sdk.tree(p.id)).length).toBe(0);
    await expect(
      sdk.read(p.id, hits[0]!.file.fileId, hits[0]!.file.revisionId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('a timed-out worker cannot publish its late native output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-example-late-'));
  let release: (() => void) | undefined;
  const registry = new StaticRegistry(
    [
      {
        ...notesConnector,
        invoke: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            sourceVersion: 'late',
            complete: true as const,
            files: [
              {
                relativePath: 'late.md',
                content: 'late unpublished content',
                mime: 'text/markdown' as const,
              },
            ],
            renames: [],
            skipped: [],
          };
        },
      },
      notesProcessor,
    ],
    { timeoutMs: 30 },
  );
  const app = createApplication({
    dataRoot: join(root, 'data'),
    ownerToken: 'synthetic-example-owner-0000000000000',
    registry,
    autoStart: false,
  });
  const headers = {
    authorization: 'Bearer synthetic-example-owner-0000000000000',
  };
  try {
    const p = (
      await app.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: 'Late worker' },
      })
    ).json();
    const b = (
      await app.app.inject({
        method: 'POST',
        url: `/api/projects/${p.id}/bindings`,
        headers,
        payload: {
          name: 'Late',
          connector: {
            packageRef: 'example.notes@0.1.0',
            config: { prefix: 'Example' },
          },
          processor: {
            packageRef: 'example.notes-summary@0.1.0',
            config: { heading: 'Candidate' },
          },
        },
      })
    ).json();
    const queued = await app.app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/bindings/${b.id}/sync`,
      headers,
    });
    expect(queued.statusCode).toBe(202);
    await app.coordinator.drain();
    expect(app.catalog.listRuns(p.id)[0]).toMatchObject({
      state: 'failed',
      error: 'PLUGIN_TIMEOUT',
    });
    expect(
      (
        await app.app.inject({
          method: 'GET',
          url: `/api/projects/${p.id}/tree`,
          headers,
        })
      ).json(),
    ).toEqual([]);
    expect(registry.operationCounts().active).toBe(1);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.operationCounts().active).toBe(0);
    expect(
      (
        await app.app.inject({
          method: 'GET',
          url: `/api/projects/${p.id}/tree`,
          headers,
        })
      ).json(),
    ).toEqual([]);
    expect(app.catalog.listRuns(p.id)[0]?.state).toBe('failed');
  } finally {
    release?.();
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const hook of ['config', 'import'] as const)
  it(`real HTTP disconnect during ${hook} validation cancels the host and persists no binding/import`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-example-disconnect-'));
    let release: (() => void) | undefined, signal: AbortSignal | undefined;
    let started: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const block = async (bound?: AbortSignal) => {
      signal = bound;
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const connector = {
      ...notesConnector,
      ...(hook === 'config'
        ? {
            validateConfig: (_: unknown, context: { signal?: AbortSignal }) =>
              block(context.signal),
          }
        : {
            validateImport: (
              _: string,
              _config: unknown,
              context?: { signal: AbortSignal },
            ) => block(context?.signal),
          }),
    };
    const registry = new StaticRegistry([connector, notesProcessor], {
      timeoutMs: 1000,
    });
    const token = 'synthetic-example-owner-0000000000000',
      headers = {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      };
    const app = createApplication({
      dataRoot: join(root, 'data'),
      ownerToken: token,
      registry,
      autoStart: false,
    });
    try {
      const origin = await app.app.listen({ host: '127.0.0.1', port: 0 });
      const p = (
        await app.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers,
          payload: { name: 'Disconnected client' },
        })
      ).json();
      const definition = {
        name: 'Disconnect',
        connector: {
          packageRef: 'example.notes@0.1.0',
          config: { prefix: 'Example' },
        },
        processor: {
          packageRef: 'example.notes-summary@0.1.0',
          config: { heading: 'Candidate' },
        },
      };
      let url = `/api/projects/${p.id}/bindings`,
        payload: unknown = definition,
        bindingId: string | undefined;
      if (hook === 'import') {
        bindingId = (
          await app.app.inject({
            method: 'POST',
            url,
            headers,
            payload: definition,
          })
        ).json().id;
        url += `/${bindingId}/imports`;
        payload = {
          filename: 'note.json',
          content: JSON.stringify({ text: 'must not persist' }),
        };
      }
      const controller = new AbortController();
      const pending = fetch(origin + url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: 'AbortError',
      });
      await entered;
      controller.abort();
      await rejected;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(signal?.aborted).toBe(true);
      release!();
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (hook === 'config') expect(app.catalog.listBindings(p.id)).toEqual([]);
      else expect(app.catalog.listImports(bindingId!)).toEqual([]);
      expect(registry.operationCounts().active).toBe(0);
    } finally {
      release?.();
      await app.app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
