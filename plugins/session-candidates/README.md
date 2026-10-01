# Session candidates

`sessionCandidatesDefinition` implements `org.opencontext.session-candidates@0.1.0`, a trusted processor with empty config `{}`. It consumes source files emitted by the [session connector](../session-connector/README.md), not arbitrary conversation directories.

The shipped extractor is deterministic. A line beginning with `Memory:`, `Rule:`, `Experience:`, `记忆：`, `规则：` or `经验：` becomes one candidate. It does not infer unstated memories, summarize ordinary prose, resolve contradictions or establish factual truth. No matches produces a successful empty full set; there is no hidden LLM fallback.

Candidates live under `candidates/<hash>.md` inside the binding's derived namespace. Each contains:

- `status: candidate`, `method: deterministic` and a confidence statement explicitly limited to marker matching.
- Provider/session/message ID, optional turn ID and evidence line.
- Fixed revision citations and SHA-256 for both the normalized message and exact raw session export, plus input commit.
- Fenced source data and `derivedFrom` dependencies on both files.

Different messages keep different slots even if they contradict one another. Updating a message at a stable file ID updates its candidate slot (kind and marker line also participate); removed messages/markers disappear from the next successful full set. Host CAS, current ACL, freshness and output ownership gates remain authoritative. Partial failure or cancellation publishes nothing. A future manual promotion must preserve those host gates; this plugin never writes `AGENTS.md`, `CLAUDE.md`, hooks, skills or execution policy.

Input hashes, sizes, project/binding, source collection, current freshness, non-tombstone state and duplicate file IDs are verified. Normalized message schema and hashed path identity must match. Before extraction, the cited raw envelope must match schema, completeness, provider, project scope and session ID; its native turn/message ID, role and projected text must exactly match the normalized message. Merely placing an unrelated hash-valid file at `raw.json` is rejected. This verifies correspondence, not vendor authenticity. Raw JSON is not extracted as a second candidate stream, so markers embedded in tool payloads or raw metadata do not generate extra candidates. Maximum 200 candidates per run and 16 KiB per candidate; oversized work fails explicitly rather than publishing a truncated set.

`CandidateExtractor` is an asynchronous injectable development interface. Tests inject a **synthetic** adapter and validate its output and cancellation. `method` can identify deterministic/local-agent/provider, but the registry currently selects only the built-in deterministic extractor. No real Codex/Claude processor or provider call, model installation, login, cost tracking or native process sandbox is implemented by this package. Nondefault outputs remain bounded cited candidate data; unreviewed adapter proposals are never promoted to approved truth or instructions.

From repository root:

```sh
pnpm exec vitest run plugins/session-candidates/tests/candidates.test.ts
```

These are plugin contract tests. Parent server integration tests separately verify upload → task → commit → recall; neither proves a real model used the candidates.
