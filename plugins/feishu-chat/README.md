# Feishu / Lark selected-group archive

`createFeishuChatDefinition(options)` provides the trusted connector `org.opencontext.feishu-chat@0.1.0`. The application statically registers it and supplies private state and credential ports. It recommends the separate `org.opencontext.feishu-chat-analysis@0.1.0` processor; the connector does not analyze messages or call a model.

This is a bounded, read-only group archive for the current single-owner product. No events, bot installation, OAuth flow, credential creation, attachment downloads, group posting or external task creation are performed. API scopes and membership/resource access must already permit the selected chat. A configured plugin is available even without credentials; connection testing then reports `blocked / SECRET_NOT_CONFIGURED`.

## Configuration and trusted host ports

All binding fields are strings:

```json
{
  "realm": "feishu",
  "chatId": "oc_synthetic",
  "secretRef": "secret:feishu/synthetic",
  "startTime": "2026-09-30T00:00:00Z",
  "endTime": "now",
  "overlapSeconds": "300"
}
```

`realm` is `feishu` or `lark`. Times are UTC ISO timestamps; only `endTime` also accepts `now`. Start must precede end and end cannot be in the future. Overlap is 0–3600 seconds. `secretRef` must match `secret:feishu/<lowercase-name>`; it is not a bearer token. The six fields above are the complete configuration; no arbitrary endpoint is accepted.

Host options are `stateRoot`, `resolveCredential(ref, { realm, chatId })`, and optional `fetch`, `evidence`, `now`, `sleep`. The host must resolve only credentials explicitly authorized for that realm/chat. `ExecutionContext.instanceRef` comes from the locked instance, not user configuration. Tests inject fetch/credential functions; injected fetch defaults to `simulated`, real built-in fetch to `live`. Evidence is written into every normalized source file and is not a user-configurable field.

Requests use only `https://open.feishu.cn/open-apis/im/v1/messages` or `https://open.larksuite.com/open-apis/im/v1/messages`, with `Authorization: Bearer …`, `redirect: error`, timeout and response-size bounds. 429/5xx reads retry at most three attempts with bounded delay. HTTP 401/403 have stable authentication/permission errors; other vendor error codes are reported as `FEISHU_API_ERROR`, without guessing undocumented meanings or logging response messages.

Connection testing checks one selected-chat page and validates any returned `chat_id`. It does not modify checkpoints, prove complete history access, test every thread or grant permissions. An empty readable page can be a valid successful diagnostic. Simulated success never claims live API verification.

## Pagination, messages and files

Chat listing uses `container_id_type=chat`, `page_size=50`, `sort_type=ByCreateTimeAsc`, and second-based start/end parameters. The end is frozen for the whole run. Empty `items` with `has_more=true` continues; missing/repeated tokens fail. Discovered `thread_id` values are queued with `container_id_type=thread`; those calls omit time parameters, then filter message `create_time` in milliseconds against the fixed window. Returned chat IDs, when present, must match the configured group. Duplicate roots from thread listings deduplicate by message ID/version.

`message_id`, `create_time` and message type are required for live records. Timestamps accept digit strings or safe nonnegative integers, normalize to strings and leave raw fields unchanged. Missing `update_time` falls back to `create_time`; null/invalid values fail. Newer versions win; older arrivals do not overwrite them; same-version different content fails conservatively instead of choosing arrival order.

Each current message becomes one source JSON file at:

```text
chats/<sha256(chatId)>/messages/<sha256(messageId)>.json
```

It follows shared `FeishuChatMessageSchema`: provider region, live/simulated evidence, chat/message IDs, creation/update times, type, text and original parsed `raw` object. Text messages decode `body.content` JSON's `text` field. Non-text messages retain raw metadata with empty normalized text and `unsupported_message_type_raw_only` diagnostics. Image/file keys are not downloaded. The parsed raw object is preserved, not the byte spelling of the HTTP envelope.

Known credentials are screened before persistence in wire bytes, parsed strings and nested JSON such as `body.content`; Unicode escape spelling cannot bypass this check. Known secret-bearing metadata keys are rejected. This does not guarantee discovery of arbitrary unrelated secrets in chat prose. Errors exclude credentials, response text and private message bodies.

## Durable synchronization and deletion

Private state is isolated under `stateRoot/sha256(instanceRef)/`. Immutable `snapshots/<digest>.json` store cumulative messages, minimal tombstones, watermark and last full-reconciliation time. `fs1:<digest>` is the connector's source version. The database-confirmed `previousVersion` is the only authority for choosing the base snapshot; there is no independently authoritative local “latest” pointer.

`pending.json` pins schema/plugin version, config hash, realm/chat, confirmed base, fixed scan window, container queue, pagination tokens, visited threads, counters and collected records. Every successful page uses write → fsync → rename → directory fsync. Failed/cancelled runs return no partial source set. A restarted factory resumes the last durable page. HTTP 400 or a vendor API error while using a page token can restart that same fixed window once; a further failure remains an error. Credentials are resolved again for each request.

A completed but unconfirmed proposal can replay its immutable result. Before replay it re-resolves the scoped credential and performs a fresh one-item chat permission probe; revoked credentials or upstream denial block first publication. An already confirmed no-change version does not freeze subsequent polling. Snapshots are hash verified; a missing confirmed snapshot raises `CHECKPOINT_MISSING` and is never replaced with an empty archive.

First synchronization reads the configured range. Later runs overlap from the confirmed watermark; at least daily they reconcile the full configured range. New replies under old roots may remain undiscovered until this full reconciliation. There is no promise of real-time or full-tenant collection.

Absence from a listing never deletes an archived message: permissions, partial scans and pagination can hide records. Explicit `deleted: true` at a newer version removes the current source file and retains only message ID/update time in the current private tombstone. Historical immutable snapshots and content revisions remain retained; this is not secure erasure. The host publishes the complete set atomically, applies tombstones, and invalidates dependent products. The plugin does not write the control database.

Limits are 100 pages per scan, 500 examined/retained records, 10 MiB scan/output and 2 MiB per HTTP response, plus host file/byte budgets. Threads count toward those limits. Exceeding a limit blocks the entire run; choose a smaller history range instead of treating a partial scan as complete.

**Backups must include this private plugin state together with database and content.** Confirmed snapshots are not disposable cache and are not garbage-collected by this plugin. Same-process factories serialize a given instance. Cross-process state-root sharing relies on the server's single Catalog lifetime lock; this package does not implement a distributed worker lock. Running independent hosts over the same state root is unsupported.

An upstream permission/token failure blocks future sync. It does not automatically remove a single owner's already imported archive or implement enterprise source-ACL propagation. Revoke the binding/project locally to immediately block local reads and derivative access. Do not describe this archive as live Feishu ACL synchronization.

## Synthetic evidence and diagnostics

[Chat page](fixtures/chat-page.json) and [thread page](fixtures/thread-page.json) use official response fields and synthetic IDs/content. They are fetch fixtures, not live credentials or upload envelopes. From repository root:

```sh
pnpm exec vitest run plugins/feishu-chat/tests/connector.test.ts
```

Tests cover pagination/thread roots, empty pages, limits, retry, checkpoint restart, confirmed cursors, same-version no-change polling, explicit deletion, conflict/late arrivals, instance isolation, scope/permission denial, cancellation, missing backups, credential replay and encoded-secret attacks. Application/UI tests separately cover registration → job → commit → retrieval. No test here accesses a real group or calls a model.

Frequent codes: `SECRET_NOT_CONFIGURED`, `AUTH_FAILED`, `PERMISSION_DENIED`, `CHAT_MISMATCH`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `FEISHU_API_ERROR`, `INVALID_RESPONSE`, `INVALID_PAGE_TOKEN`, `REPEATED_PAGE_TOKEN`, `PAGE_LIMIT`, `SCAN_LIMIT`, `SNAPSHOT_LIMIT`, `MESSAGE_VERSION_CONFLICT`, `CHECKPOINT_MISSING`, `CHECKPOINT_CORRUPT`, `CHECKPOINT_IO`, `SECRET_IN_RESPONSE`, `INSTANCE_BUSY`, `CANCELLED`. These intentionally omit upstream private error messages.

Official references: [list messages](https://open.feishu.cn/document/server-docs/im-v1/message/list), [message events](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive), [official Go SDK IM models](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/model.go). Events and attachment APIs are reference boundaries, not implemented features.
