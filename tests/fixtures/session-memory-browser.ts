/** Disposable loopback fixture. Synthetic inputs and a fake executable only. */
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApplication } from '../../apps/server/src/app.ts';
import { prepareSessionUpload } from '../../plugins/session-connector/src/jsonl-upload.ts';
import { prepareWorker, runWorker } from '../../scripts/local-agent-worker.ts';
const mode = process.argv[2] ?? 'upload';
if (!['upload', 'directory', 'disabled'].includes(mode))
  throw new Error('INVALID_CONFIG');
const root = mkdtempSync(resolve(tmpdir(), 'oc-memory-browser-'));
const dataRoot = resolve(root, 'data');
const directory = resolve(root, 'selected');
mkdirSync(directory);
const raw = readFileSync(
  new URL(
    '../../plugins/session-connector/fixtures/codex-0.161.0-complex-synthetic.jsonl',
    import.meta.url,
  ),
  'utf8',
);
const selected = resolve(directory, 'synthetic.jsonl');
writeFileSync(selected, mode === 'directory' ? '{broken}\n' : raw);
const owner = 'synthetic-memory-browser-owner-loopback-only';
const application = createApplication({
  dataRoot,
  ownerToken: owner,
  sessionMemory: {
    enabled: mode !== 'disabled',
    inputMode: mode === 'directory' ? 'directory' : 'upload',
    format: 'codex-jsonl-0.161.0',
    ...(mode === 'directory' ? { directory } : {}),
    projectScope: 'synthetic-browser-memory',
    dataRoot,
  },
  autoStart: true,
});
const headers = { authorization: `Bearer ${owner}` };
let response: unknown = null;
let projectId: string | null = null;
let job: string | undefined;
if (mode === 'upload') {
  const uploaded = await application.app.inject({
    method: 'POST',
    url: '/api/session-memory/upload',
    headers,
    payload: {
      expectedUploadId: null,
      expectedUploadHash: null,
      upload: prepareSessionUpload(
        [Buffer.from(raw)],
        'synthetic-browser-memory',
        '0.161.0',
      ),
    },
  });
  if (uploaded.statusCode !== 200) throw new Error(uploaded.body);
  projectId = uploaded.json().projectId;
  const task = (
    await application.app.inject({
      method: 'GET',
      url: '/api/session-memory/task',
      headers,
    })
  ).json().task;
  const taskPath = resolve(root, 'task.json');
  writeFileSync(taskPath, JSON.stringify(task));
  job = prepareWorker(taskPath).job;
  const fake = resolve(root, 'fake.mjs');
  writeFileSync(
    fake,
    `import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);if(args[0]==='--version'){console.log('codex-cli 0.161.0');process.exit(0)}
let text='';for await(const chunk of process.stdin)text+=chunk;const task=JSON.parse(text.split('Evidence JSON follows:\\n')[1]);const source=task.messages.find(m=>m.message.evidence?.kind==='tool_result');
writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({schema:'opencontext.local-agent-response/v1',taskId:task.taskId,inputHash:task.inputHash,candidates:[{fileId:source.fileId,revisionId:source.revisionId,kind:'memory',line:1,markdown:'# 合成记忆候选\\n\\n请人工核验 cedar-browser-needle 的工具证据。\\n\\n<script>window.syntheticInjected=true</script>'}]}));`,
  );
  response = (
    await runWorker(
      job,
      { execute: true },
      { file: process.execPath, prefix: [fake] },
    )
  ).response;
}
const origin = await application.app.listen({ host: '127.0.0.1', port: 0 });
console.log(
  JSON.stringify({ origin, owner, root, selected, raw, response, projectId }),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void application.app.close().finally(() => {
      if (job) rmSync(job, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
  });
