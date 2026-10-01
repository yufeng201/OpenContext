# Explicit session imports

The two trusted connector definitions share this package:

- `codexSessionDefinition`: `org.opencontext.codex-sessions@0.1.0`.
- `claudeSessionDefinition`: `org.opencontext.claude-sessions@0.1.0`.
- Both recommend `org.opencontext.session-candidates@0.1.0` and use config `{ "projectScope": "synthetic-project" }`.

This is a user-selected import path. It does not discover local files, run a coding CLI, log in, request a model, or transfer Agent credentials. `projectScope` is an exact export/config consistency label; host project authorization is the real access boundary. Untrusted repository metadata cannot grant scope.

## Importable fixtures and envelope

Use [Codex fixture](fixtures/codex-session.json) or [Claude fixture](fixtures/claude-session.json). Both contain synthetic conversations only, with explicit candidate markers. Create a matching binding, upload the JSON, then synchronize and process. The parent application owns upload, task, commit and retrieval APIs.

```json
{
  "schema": "opencontext.session-import/v1",
  "provider": "codex",
  "projectScope": "synthetic-project",
  "sessionId": "stable-native-session-id",
  "complete": true,
  "payload": {
    "thread": {
      "id": "stable-native-session-id",
      "historyMode": "legacy",
      "turns": [
        {
          "id": "turn-1",
          "status": "completed",
          "itemsView": "full",
          "items": [
            { "type": "agentMessage", "id": "message-1", "text": "Memory: A synthetic example." }
          ]
        }
      ]
    }
  }
}
```

The envelope is **OpenContext's exchange format**, not a vendor-native export command. Top-level fields are strict. `payload` wraps a Codex `thread/read` response or a Claude SDK `SessionMessage[]`. The short example shows the fields consumed by this adapter; the downloadable Codex fixture includes a fuller synthetic native response. `complete:true` is the user's/exporter's completeness confirmation, not proof that pages were not omitted. Import a stable, fully captured conversation; the server cannot independently interrogate its origin.

## Supported native subset

Codex uses stable `thread.id`, `turn.id`, `item.id`. The thread ID must equal `sessionId`. Completed/interrupted/failed turns are accepted; in-progress turns are rejected. `historyMode` must be `legacy` or omitted; `itemsView` must be `full` or omitted for compatible legacy responses. Paginated history must be captured by a future explicit adapter; summary views are not complete exports.

- `userMessage` text blocks and `agentMessage.text` become normalized message files.
- Known Codex 0.159.2 items remain in exact raw only: `hookPrompt`, `functionCallOutput`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`, `webSearch`, `imageView`, `sleep`, `imageGeneration`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`. Required item fields must be present; this is not a complete reimplementation of every vendor schema.
- Known non-text user inputs `image`, `localImage`, `audio`, `localAudio`, `skill`, `mention` also remain raw. Paths and URLs are never opened. Raw-only types are reported in `skipped`; no tool output is interpreted as a user rule.

Claude uses SDK message `uuid` plus `session_id`; each message must match the envelope session. Only top-level user/assistant messages are supported. `message.role` must match `type`; `message.content` may be a string or text blocks. `tool_use`, `tool_result` and `thinking` blocks remain exact raw with diagnostics. Unknown block types and subagent histories reject the batch. A pure tool-result message produces an empty normalized text, never a rule extracted from the tool JSON.

Unknown variants, absent IDs, unsupported history, malformed messages and conflicting duplicate message IDs reject the entire sync. Empty Claude or Codex history is rejected: missing/compacted/unreadable history is not deletion evidence. The native APIs may expose compaction summaries rather than original verbatim text; this adapter cannot recover unavailable history.

## Files, update and deletion

Paths are relative to the binding's source root:

```text
sessions/<provider>/<sha256(sessionId)>/raw.json
sessions/<provider>/<sha256(sessionId)>/messages/<sha256([turnId-or-null,messageId])>.json
```

`raw.json` is the exact approved UTF-8 envelope, including whitespace and final newline. Normalized messages use the shared `SessionMessageSchema` in contracts. They contain provider, project scope, session/message IDs, optional turn ID, role and extracted text. Hashing IDs makes paths stable without accepting provider-controlled path traversal.

Each successful sync is a complete set across the binding's **currently selected imported objects**. Exact same-session bytes deduplicate; different exports of the same session in one selected set are rejected. Replace the existing upload when updating a session. A complete replacement may remove missing messages. Explicitly DELETE an imported object, then sync, to remove that session. An empty selected set yields a complete empty source set. This is deliberate removal, not an inference from an empty SDK response. Host ownership gates determine tombstones and downstream freshness; the connector never writes the database.

Source version hashes sorted paths and exact content hashes. Repeated identical input is deterministic; changed raw formatting intentionally changes raw revision. Limits are 32 imports, 1 MiB per import, 2,000 normalized messages per session and the host's complete-set file/byte budgets. A limit failure returns no partial set or cursor update. The import reader is a host port restricted to the run's locked objects; filenames never become filesystem read requests.

## Secrets and trust

Upload preflight and run execution both validate the payload. Known credential metadata keys (`authorization`, `api_key`, access/refresh tokens, password/client secret) and private-key markers reject the whole input before upload persistence through the supported application route. They are not silently redacted while claiming exact raw preservation. Arbitrary secrets embedded in prose cannot be reliably detected: review/exclude sensitive material before approving an export. Import objects and content history have host retention rules; deleting a current source is not secure erasure of all revisions/backups.

This is trusted native plugin code, not a process sandbox. It receives no general database, filesystem-import or credential port. No live Feishu connector is included; a future group-message importer must separately define message IDs, replies, completeness, deletes and authorization. A synthetic Feishu fixture contract is not evidence of API access.

## Verification and references

From repository root:

```sh
pnpm exec vitest run plugins/session-connector/tests/session.test.ts
```

Tests use synthetic bytes only. They cover raw preservation, stable IDs, duplicate/conflicting exports, scope, completeness, deletion, limits, cancellation, hash mismatch, secret preflight and known raw-only tools.

Official format evidence: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude session browser](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser), [Claude SDK session reader](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py), [Claude SDK content types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py). Codex native shape was checked against local 0.159.2 generated schema; Claude evidence is official source, not a locally installed SDK test. Claude `/export` is plain text and is not this JSON format.
