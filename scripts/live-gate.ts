/** Offline evidence gate. No provider execution, configuration discovery or network. */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CitationSchema } from '../packages/contracts/src/index.ts';
import { parseAuditEvent } from '../packages/contracts/src/audit.ts';
import { isErrorCode } from '../packages/contracts/src/errors.ts';

const str = Type.String({ minLength: 1, maxLength: 2048 });
const integer = (max: number) => Type.Integer({ minimum: 1, maximum: max });
const obj = <T extends Parameters<typeof Type.Object>[0]>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const reference = obj({ fileId: str, revisionId: str });
const event = obj({
  callId: str,
  requestId: str,
  tool: Type.Union([
    Type.Literal('context_search'),
    Type.Literal('context_read'),
  ]),
  projectId: str,
  code: str,
  fileId: Type.Optional(str),
  revisionId: Type.Optional(str),
  hits: Type.Optional(Type.Array(reference, { maxItems: 50 })),
  text: Type.Optional(Type.String({ maxLength: 8192 })),
  citation: Type.Optional(CitationSchema),
});
const audit = obj({
  requestId: str,
  tool: str,
  projectId: str,
  code: str,
  fileId: Type.Optional(str),
  revisionId: Type.Optional(str),
});
export const EvidenceSchema = obj({
  format: Type.Literal('opencontext-sanitized-live-evidence/v1'),
  client: Type.Union([Type.Literal('codex'), Type.Literal('claude')]),
  clientVersion: str,
  provenance: Type.Union([
    Type.Literal('synthetic'),
    Type.Literal('submitted'),
  ]),
  seedSessionId: str,
  sessionId: str,
  sessionStart: obj({
    sessionId: str,
    resumed: Type.Boolean(),
    priorMessages: Type.Integer({ minimum: 0 }),
  }),
  prompt: Type.String({ maxLength: 32768 }),
  answer: Type.String({ maxLength: 32768 }),
  elapsedMs: Type.Integer({ minimum: 0, maximum: 120000 }),
  modelCalls: integer(6),
  events: Type.Array(event, { maxItems: 8 }),
  audits: Type.Array(audit, { maxItems: 8 }),
  claims: Type.Array(
    obj({ callId: str, citation: CitationSchema, quote: str }),
    { maxItems: 8 },
  ),
});
export type Evidence = Static<typeof EvidenceSchema>;
export const RequestSchema = obj({
  scenario: Type.Union([
    Type.Literal('recall'),
    Type.Literal('revoked'),
    Type.Literal('failure'),
  ]),
  expected: obj({ citation: CitationSchema, fact: str }),
  priorSessionIds: Type.Array(str, { minItems: 1, maxItems: 32 }),
  deniedCode: Type.Optional(
    Type.Union([
      Type.Literal('UNAUTHORIZED'),
      Type.Literal('FORBIDDEN'),
      Type.Literal('NOT_FOUND'),
    ]),
  ),
  failureCode: Type.Optional(
    Type.Union([Type.Literal('TIMEOUT'), Type.Literal('INTERNAL_ERROR')]),
  ),
  authorization: Type.Optional(
    obj({
      approvalId: str,
      paidEgressApproved: Type.Literal(true),
      maxCalls: integer(6),
      maxInputBytes: integer(262144),
      maxToolBytes: integer(32768),
      maxElapsedMs: integer(120000),
      maxUsd: Type.Number({ exclusiveMinimum: 0, maximum: 100 }),
      externalCostEnforcement: Type.Literal(true),
    }),
  ),
});
export type Request = Static<typeof RequestSchema>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function valid<T>(
  schema: Parameters<typeof Value.Check>[0],
  value: unknown,
): asserts value is T {
  requireCondition(Value.Check(schema, value), 'INVALID_SCHEMA');
}

/** Project an explicitly supplied server audit, discarding actor/time and unrelated fields. */
export function importServerAudit(value: unknown): Static<typeof audit> {
  const a = parseAuditEvent(value);
  const tool = (
    { 'file.search': 'context_search', 'file.read': 'context_read' } as Record<
      string,
      string
    >
  )[a.action];
  requireCondition(
    tool && a.requestId && a.target.projectId && a.actor.role === 'reader',
    'UNSUPPORTED_AUDIT',
  );
  requireCondition(
    (a.code === 'OK' && a.result === 'success') ||
      (a.code !== 'OK' && a.result !== 'success'),
    'UNSUPPORTED_AUDIT',
  );
  return {
    requestId: a.requestId,
    tool,
    projectId: a.target.projectId,
    code: a.code,
    ...(a.target.fileId ? { fileId: a.target.fileId } : {}),
    ...(a.target.revisionId ? { revisionId: a.target.revisionId } : {}),
  };
}

/** Whitelist envelope adapter: raw CLI streams/history are deliberately unsupported. */
export function importEvidence(value: unknown): Evidence {
  valid<Evidence>(EvidenceSchema, value);
  requireCondition(
    (value.client === 'codex' && value.clientVersion === '0.151.0') ||
      (value.client === 'claude' && value.clientVersion === '2.1.280'),
    'UNSUPPORTED_CLIENT_VERSION',
  );
  return structuredClone(value);
}

/** Nonblocking open, then validate/read the same fd; no pathname stat/open race. */
export function readEvidenceFile(path: string): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    requireCondition(stat.isFile() && stat.size <= 262144, 'INPUT_LIMIT');
    const bytes = Buffer.alloc(262145);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    requireCondition(count <= 262144, 'INPUT_LIMIT');
    return JSON.parse(bytes.subarray(0, count).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

export function verifyEvidence(request: unknown, input: unknown) {
  valid<Request>(RequestSchema, request);
  const e = importEvidence(input);
  requireCondition(
    e.sessionId !== e.seedSessionId &&
      request.priorSessionIds.includes(e.seedSessionId) &&
      !request.priorSessionIds.includes(e.sessionId),
    'FRESH_SESSION_REQUIRED',
  );
  requireCondition(
    e.sessionStart.sessionId === e.sessionId &&
      !e.sessionStart.resumed &&
      e.sessionStart.priorMessages === 0,
    'FRESH_SESSION_REQUIRED',
  );
  requireCondition(!e.prompt.includes(request.expected.fact), 'FACT_IN_PROMPT');
  const bytes = Buffer.byteLength(JSON.stringify(e));
  const toolBytes = e.events.reduce(
    (n, x) => n + Buffer.byteLength(JSON.stringify(x)),
    0,
  );
  requireCondition(bytes <= 262144 && toolBytes <= 32768, 'INPUT_LIMIT');
  const auth = request.authorization;
  if (auth)
    requireCondition(
      e.modelCalls <= auth.maxCalls &&
        bytes <= auth.maxInputBytes &&
        toolBytes <= auth.maxToolBytes &&
        e.elapsedMs <= auth.maxElapsedMs,
      'BUDGET_EXCEEDED',
    );
  const calls = new Set<string>(),
    requests = new Set<string>();
  requireCondition(e.audits.length === e.events.length, 'AUDIT_JOIN_REQUIRED');
  for (const x of e.events) {
    requireCondition(
      x.code === 'OK' || isErrorCode(x.code),
      'UNSUPPORTED_ERROR_CODE',
    );
    requireCondition(
      !calls.has(x.callId) && !requests.has(x.requestId),
      'DUPLICATE_CALL',
    );
    calls.add(x.callId);
    requests.add(x.requestId);
    const matches = e.audits.filter((a) => a.requestId === x.requestId);
    requireCondition(matches.length === 1, 'AUDIT_JOIN_REQUIRED');
    const a = matches[0]!;
    requireCondition(
      a.tool === x.tool &&
        a.projectId === x.projectId &&
        a.code === x.code &&
        a.fileId === x.fileId &&
        a.revisionId === x.revisionId,
      'AUDIT_JOIN_REQUIRED',
    );
    requireCondition(
      x.projectId === request.expected.citation.projectId,
      'WRONG_SCOPE',
    );
    if (x.code !== 'OK')
      requireCondition(
        x.text === undefined &&
          x.citation === undefined &&
          x.hits === undefined,
        'FAILED_TOOL_HAS_CONTENT',
      );
  }
  if (request.scenario !== 'recall') {
    const code =
      request.scenario === 'revoked' ? request.deniedCode : request.failureCode;
    requireCondition(
      code &&
        e.events.length > 0 &&
        e.events.every((x) => x.code === code) &&
        e.answer.trim() === '' &&
        e.claims.length === 0,
      'NO_ANSWER_REQUIRED',
    );
  } else {
    const expected = request.expected.citation;
    const readIndex = e.events.findIndex(
      (x) =>
        x.tool === 'context_read' &&
        x.code === 'OK' &&
        x.fileId === expected.fileId &&
        x.revisionId === expected.revisionId,
    );
    requireCondition(readIndex > 0, 'PINNED_READ_REQUIRED');
    const read = e.events[readIndex]!;
    requireCondition(
      e.events
        .slice(0, readIndex)
        .some(
          (x) =>
            x.tool === 'context_search' &&
            x.code === 'OK' &&
            x.hits?.some(
              (h) =>
                h.fileId === read.fileId && h.revisionId === read.revisionId,
            ),
        ),
      'SEARCH_BEFORE_READ_REQUIRED',
    );
    requireCondition(
      typeof read.text === 'string' &&
        sha(read.text) === expected.contentHash &&
        read.text.includes(request.expected.fact),
      'CONTENT_HASH_MISMATCH',
    );
    const equalCitation = (a: unknown) =>
      Value.Check(CitationSchema, a) &&
      Object.entries(expected).every(
        ([k, v]) => (a as Record<string, unknown>)[k] === v,
      );
    requireCondition(
      equalCitation(read.citation) && e.claims.length > 0,
      'CITATION_MISMATCH',
    );
    for (const claim of e.claims)
      requireCondition(
        claim.callId === read.callId &&
          equalCitation(claim.citation) &&
          read.text.includes(claim.quote) &&
          e.answer.includes(claim.quote) &&
          e.answer.includes(claim.citation.uri),
        'UNSUPPORTED_CLAIM',
      );
    requireCondition(
      e.answer.includes(request.expected.fact),
      'ANSWER_UNSUPPORTED',
    );
  }
  return {
    status: auth ? 'OFFLINE_CONSISTENT' : 'DRY_RUN_CONSISTENT',
    liveProof: false,
    liveStatus: 'BLOCKED_INDEPENDENT_CAPTURE_AND_AUTHENTICITY',
    provenance: e.provenance,
    evidenceHash: sha(JSON.stringify(e)),
    modelCallsObserved: e.modelCalls,
    toolCallsObserved: e.events.length,
    inputBytes: bytes,
    toolBytes,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [command, request, evidence, ...extra] = process.argv.slice(2);
    requireCondition(
      command === 'verify' && request && evidence && extra.length === 0,
      'OFFLINE_ONLY',
    );
    console.log(
      JSON.stringify(
        verifyEvidence(readEvidenceFile(request), readEvidenceFile(evidence)),
      ),
    );
  } catch {
    // Never print arbitrary exception messages, paths, transcript contents or credentials.
    console.error(
      JSON.stringify({
        status: 'REJECTED',
        code: 'INVALID_OR_UNSUPPORTED_OFFLINE_EVIDENCE',
        liveProof: false,
      }),
    );
    process.exitCode = 1;
  }
}
