// Explicit protocol only: no login or model turn; all data and authorization are temporary.
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { assertProbeRequest } from './policy.ts';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApplication } from '../../apps/server/src/app.ts';
const root = mkdtempSync(join(tmpdir(), 'oc-agent-protocol-'));
const home = join(root, 'agent');
mkdirSync(home);
const owner = 'synthetic-agent-protocol-loopback-owner';
const headers = { authorization: 'Bearer ' + owner };
const a = createApplication({
  dataRoot: join(root, 'data'),
  ownerToken: owner,
  autoStart: false,
});
let child;
const pending = new Map();
let next = 1;
let failure;
const terminate = () => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
};
const deadline = setTimeout(terminate, 90000);
const interrupted = () => terminate();
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
try {
  const api = async (method, url, payload) => {
    const r = await a.app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    assert.ok(r.statusCode < 300, r.body);
    return r.json();
  };
  const p = await api('POST', '/api/projects', {
    name: 'Synthetic agent protocol',
  });
  const base = '/api/projects/' + p.id;
  const b = await api('POST', base + '/bindings', {
    name: 'Synthetic session',
    connector: {
      packageRef: 'org.opencontext.codex-sessions@0.1.0',
      config: { projectScope: 'synthetic-project' },
    },
    processor: {
      packageRef: 'org.opencontext.session-candidates@0.1.0',
      config: {},
    },
  });
  await api('POST', base + '/bindings/' + b.id + '/imports', {
    filename: 'synthetic.json',
    content: readFileSync(
      new URL(
        '../../plugins/session-connector/fixtures/codex-session.json',
        import.meta.url,
      ),
      'utf8',
    ),
  });
  await api('POST', base + '/bindings/' + b.id + '/sync', {});
  await a.coordinator.drain();
  const reader = a.catalog.createReaderToken(p.id);
  const origin = await a.app.listen({ host: '127.0.0.1', port: 0 });
  child = spawn(
    process.env.CODEX_BINARY ?? 'codex',
    [
      'app-server',
      '--stdio',
      '-c',
      `mcp_servers.opencontext.url="${origin}/mcp"`,
      '-c',
      'mcp_servers.opencontext.bearer_token_env_var="SYNTHETIC_QUERY_TOKEN"',
    ],
    {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: home,
        TMPDIR: home,
        SYNTHETIC_QUERY_TOKEN: reader.token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  );
  const fail = () => {
    failure = new Error('PROBE_PROCESS_FAILED');
    for (const f of pending.values()) f.reject(failure);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  let buffer = '';
  let received = 0;
  child.stdout.on('data', (c) => {
    received += c.length;
    if (received > 4194304) {
      fail();
      terminate();
      return;
    }
    buffer += c;
    for (;;) {
      const i = buffer.indexOf('\n');
      if (i < 0) break;
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) {
          const f = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) f.reject(new Error('PROBE_RPC_REJECTED'));
          else f.resolve(m.result);
        }
      } catch {
        /* Ignore non-protocol log lines; deadlines still apply. */
      }
    }
  });
  child.stderr.resume();
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      assertProbeRequest(method, params);
      if (failure) {
        reject(failure);
        return;
      }
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('RPC_TIMEOUT ' + method));
      }, 20000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  const init = await rpc('initialize', {
    clientInfo: { name: 'opencontext_synthetic_acceptance', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const thread = await rpc('thread/start', {
    cwd: home,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  const id = thread.thread.id;
  const result = await rpc('mcpServer/tool/call', {
    threadId: id,
    server: 'opencontext',
    tool: 'context_search',
    arguments: { projectId: p.id, query: 'bounded backoff', mode: 'grep' },
  });
  const parsed =
    result.structuredContent ??
    JSON.parse(result.content.find((x) => x.type === 'text').text);
  assert.ok(parsed.hits.length > 0);
  const file = parsed.hits[0].file;
  const read = await rpc('mcpServer/tool/call', {
    threadId: id,
    server: 'opencontext',
    tool: 'context_read',
    arguments: {
      projectId: p.id,
      fileId: file.fileId,
      revisionId: file.revisionId,
      maxBytes: 256,
    },
  });
  const content =
    read.structuredContent ??
    JSON.parse(read.content.find((x) => x.type === 'text').text);
  assert.equal(content.citation.revisionId, file.revisionId);
  assert.ok(Buffer.byteLength(content.text) <= 256);
  assert.equal(existsSync(join(home, 'auth.json')), false);
  console.log(
    JSON.stringify({
      result: 'passed',
      client: init.userAgent ?? 'installed Codex (version unavailable)',
      initialize: true,
      ephemeralThread: true,
      explicitMcpSearch: true,
      fixedRevisionBoundedRead: true,
      modelTurns: 0,
      authFile: false,
      scope:
        'Direct protocol commands, not model-selected tool use or pinned 0.161.0 worker validation',
    }),
  );
} finally {
  clearTimeout(deadline);
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    const timer = setTimeout(terminate, 3000);
    await exited;
    clearTimeout(timer);
  }
  terminate();
  await a.app.close();
  rmSync(root, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
}
