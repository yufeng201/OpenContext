import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  verifyEvidence,
  importEvidence,
  importServerAudit,
  readEvidenceFile,
  type Evidence,
  type Request,
} from '../../scripts/live-gate.ts';
function fixture() {
  const text = 'Synthetic harbour retention is 7 days.';
  const citation = {
    uri: 'opencontext://synthetic-file@synthetic-revision',
    projectId: 'synthetic-project',
    fileId: 'synthetic-file',
    revisionId: 'synthetic-revision',
    commitId: 'synthetic-commit',
    path: 'sources/synthetic.md',
    sourceVersion: 'v1',
    contentHash: createHash('sha256').update(text).digest('hex'),
  };
  const request: Request = {
    scenario: 'recall',
    expected: { citation, fact: '7 days' },
    priorSessionIds: ['seed'],
  };
  const evidence: Evidence = {
    format: 'opencontext-sanitized-live-evidence/v1',
    client: 'codex',
    clientVersion: '0.151.0',
    provenance: 'synthetic',
    seedSessionId: 'seed',
    sessionId: 'recall',
    sessionStart: { sessionId: 'recall', resumed: false, priorMessages: 0 },
    prompt: 'Retrieve harbour retention via MCP and cite the fixed revision.',
    answer: text + ' ' + citation.uri,
    elapsedMs: 10,
    modelCalls: 1,
    events: [
      {
        callId: 'search',
        requestId: 'request-search',
        tool: 'context_search',
        projectId: citation.projectId,
        code: 'OK',
        hits: [{ fileId: citation.fileId, revisionId: citation.revisionId }],
      },
      {
        callId: 'read',
        requestId: 'request-read',
        tool: 'context_read',
        projectId: citation.projectId,
        code: 'OK',
        fileId: citation.fileId,
        revisionId: citation.revisionId,
        text,
        citation,
      },
    ],
    audits: [],
    claims: [{ callId: 'read', citation, quote: text }],
  };
  evidence.audits = evidence.events.map(
    ({ requestId, tool, projectId, code, fileId, revisionId }) => ({
      requestId,
      tool,
      projectId,
      code,
      ...(fileId ? { fileId } : {}),
      ...(revisionId ? { revisionId } : {}),
    }),
  );
  return { request, evidence };
}
test('offline recall joins pinned search/read, audit and answer; missing authorization stays dry-run', () => {
  for (const client of ['codex', 'claude'] as const) {
    const { request, evidence } = fixture();
    evidence.client = client;
    evidence.clientVersion = client === 'codex' ? '0.151.0' : '2.1.280';
    const result = verifyEvidence(request, evidence);
    assert.equal(result.status, 'DRY_RUN_CONSISTENT');
    assert.equal(result.liveProof, false);
    request.authorization = {
      approvalId: 'synthetic-approval',
      paidEgressApproved: true,
      maxCalls: 1,
      maxInputBytes: 262144,
      maxToolBytes: 32768,
      maxElapsedMs: 100,
      maxUsd: 1,
      externalCostEnforcement: true,
    };
    assert.equal(
      verifyEvidence(request, evidence).status,
      'OFFLINE_CONSISTENT',
    );
  }
});
test('reject unsafe evidence without loosening pinned reference or freshness predicates', () => {
  const cases: Array<(r: Request, e: Evidence) => void> = [
    (_r, e) => {
      e.sessionId = e.seedSessionId;
    },
    (_r, e) => {
      e.sessionStart.resumed = true;
    },
    (_r, e) => {
      e.sessionStart.priorMessages = 1;
    },
    (r, e) => {
      r.priorSessionIds.push(e.sessionId);
    },
    (_r, e) => {
      e.prompt += ' 7 days';
    },
    (_r, e) => {
      e.events = [];
      e.audits = [];
    },
    (_r, e) => {
      e.events.reverse();
    },
    (_r, e) => {
      e.events[1]!.revisionId = 'head';
      e.audits[1]!.revisionId = 'head';
    },
    (_r, e) => {
      e.events[1]!.text += ' changed';
    },
    (_r, e) => {
      e.claims[0]!.citation = { ...e.claims[0]!.citation, commitId: 'wrong' };
    },
    (_r, e) => {
      e.claims[0]!.callId = 'self-claimed';
    },
    (_r, e) => {
      e.answer = '7 days unsupported';
    },
    (_r, e) => {
      e.events[0]!.projectId = 'other';
    },
    (_r, e) => {
      e.audits = [];
    },
    (_r, e) => {
      e.audits[1]!.requestId = e.audits[0]!.requestId;
    },
    (_r, e) => {
      e.events[1]!.callId = e.events[0]!.callId;
    },
    (_r, e) => {
      e.clientVersion = 'unknown';
    },
    (_r, e) => {
      Object.assign(e, { token: 'synthetic-never-print' });
    },
    (_r, e) => {
      e.elapsedMs = 120001;
    },
    (_r, e) => {
      e.modelCalls = 7;
    },
    (r, e) => {
      r.authorization = {
        approvalId: 'synthetic',
        paidEgressApproved: true,
        maxCalls: 1,
        maxInputBytes: 1,
        maxToolBytes: 1,
        maxElapsedMs: 1,
        maxUsd: 1,
        externalCostEnforcement: true,
      };
      e.modelCalls = 2;
    },
  ];
  for (const mutate of cases) {
    const { request, evidence } = fixture();
    mutate(request, evidence);
    assert.throws(() => verifyEvidence(request, evidence));
  }
  assert.throws(() => importEvidence([{ type: 'raw-cli-stream' }]));
});
test('denied and failed fresh sessions require actual matching errors and no answer or plaintext', () => {
  for (const code of [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'TIMEOUT',
    'INTERNAL_ERROR',
  ] as const) {
    const { request, evidence } = fixture();
    request.scenario =
      code === 'TIMEOUT' || code === 'INTERNAL_ERROR' ? 'failure' : 'revoked';
    if (request.scenario === 'failure') request.failureCode = code as 'TIMEOUT';
    else request.deniedCode = code as 'UNAUTHORIZED';
    evidence.events = [
      {
        callId: 'denied',
        requestId: 'denied-request',
        tool: 'context_read',
        projectId: request.expected.citation.projectId,
        code,
      },
    ];
    evidence.audits = [
      {
        requestId: 'denied-request',
        tool: 'context_read',
        projectId: request.expected.citation.projectId,
        code,
      },
    ];
    evidence.answer = '';
    evidence.claims = [];
    assert.equal(verifyEvidence(request, evidence).liveProof, false);
    evidence.answer = 'possibly 7 days';
    assert.throws(() => verifyEvidence(request, evidence));
    evidence.answer = '';
    evidence.events[0]!.text = 'cached secret';
    assert.throws(() => verifyEvidence(request, evidence));
  }
});
test('server audit projection only accepts reader evidence and strips unrelated metadata', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const raw = {
    id,
    time: '2026-10-02T00:00:00.000Z',
    actor: { id, role: 'reader' },
    action: 'file.search',
    target: {
      projectId: id,
      bindingId: null,
      fileId: null,
      revisionId: null,
      objectId: null,
      tokenId: null,
    },
    result: 'success',
    code: 'OK',
    requestId: id,
    jobId: null,
  };
  assert.deepEqual(importServerAudit(raw), {
    requestId: id,
    tool: 'context_search',
    projectId: id,
    code: 'OK',
  });
  assert.throws(() =>
    importServerAudit({ ...raw, actor: { id: 'owner', role: 'owner' } }),
  );
  assert.throws(() => importServerAudit({ ...raw, requestId: null }));
});
test('explicit file import rejects oversize and symlinks; CLI errors redact raw content', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-live-gate-'));
  try {
    const file = join(root, 'evidence.json');
    writeFileSync(file, JSON.stringify({ synthetic: true }));
    assert.deepEqual(readEvidenceFile(file), { synthetic: true });
    symlinkSync(file, join(root, 'link'));
    assert.throws(() => readEvidenceFile(join(root, 'link')));
    writeFileSync(file, 'x'.repeat(262145));
    assert.throws(() => readEvidenceFile(file));
    writeFileSync(file, 'private-synthetic-canary');
    const run = spawnSync(
      process.execPath,
      ['scripts/live-gate.ts', 'verify', file, file],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert(!run.stderr.includes('private-synthetic-canary'));
    assert.equal(JSON.parse(run.stderr).liveProof, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no-writer FIFO, device, directory and regular-to-FIFO replacement reject within a hard child deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-live-special-'));
  try {
    const regular = join(root, 'regular.json');
    const fifo = join(root, 'synthetic-private-fifo');
    writeFileSync(regular, '{"synthetic":true}');
    assert.deepEqual(readEvidenceFile(regular), { synthetic: true });
    const made = spawnSync('mkfifo', [fifo], {
      encoding: 'utf8',
      timeout: 2000,
    });
    assert.equal(made.error, undefined);
    assert.equal(made.status, 0);
    const rejectWithinDeadline = (path: string, first: boolean) => {
      const started = performance.now();
      const run = spawnSync(
        process.execPath,
        [
          'scripts/live-gate.ts',
          'verify',
          ...(first ? [path, regular] : [regular, path]),
        ],
        {
          encoding: 'utf8',
          timeout: 2000,
          killSignal: 'SIGKILL',
        },
      );
      assert.equal(
        run.error,
        undefined,
        'special input must reject, not require timeout termination',
      );
      assert.equal(run.signal, null);
      assert.equal(run.status, 1);
      assert(performance.now() - started < 2000);
      assert.equal(run.stdout, '');
      assert.deepEqual(JSON.parse(run.stderr), {
        status: 'REJECTED',
        code: 'INVALID_OR_UNSUPPORTED_OFFLINE_EVIDENCE',
        liveProof: false,
      });
      assert(!run.stderr.includes(path));
    };
    for (const path of [fifo, root, '/dev/null']) {
      rejectWithinDeadline(path, true);
      // A valid request schema is not required: both files are read before validation.
      rejectWithinDeadline(path, false);
    }
    // Replace a previously accepted regular pathname. The open fd, rather than a
    // stale pre-open pathname stat, must determine whether the input is regular.
    renameSync(fifo, regular);
    rejectWithinDeadline(regular, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
