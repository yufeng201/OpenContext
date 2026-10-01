# Feishu chat analysis processor

`org.opencontext.feishu-chat-analysis@0.1.0` is an implemented trusted static processor with an empty configuration object. It makes no model calls, network requests, file-system reads, group posts or external tasks. It consumes the host's fixed, authorized source snapshot, not a chat API token.

Only normalized `opencontext.feishu-chat-message/v1` files at `sources/<binding>/chats/<sha256(chatId)>/messages/<sha256(messageId)>.json` are analyzed. The processor verifies source ownership, current freshness, project/binding, hash/size, unique identity and path. For text messages it checks raw message identity, timestamps and decoded `body.content.text` against the normalized fields. Deleted messages are rejected. Other source files are ignored; non-text message bodies are not parsed as text.

Lines beginning with `Topic:`, `Conclusion:`, `Todo:`, `Requirement:` or `主题：`, `结论：`, `待办：`, `需求：` produce separate candidate Markdown files. Candidate slots use stable source file identity, candidate kind and same-kind ordinal. Unmarked line insertion does not replace the slot; inserted or removed same-kind markers can change subsequent ordinals. The host's output ownership/CAS gate protects human-owned files in either case. Different messages are never merged, so conflicting conclusions remain visible as separate proposals.

Each candidate includes `status: candidate`, `method: deterministic`, `evidence: simulated|live`, an explicit non-LLM limitation, group/message identity, source hash and a fixed revision citation. Simulation does not count as a real group test. Source markup is quoted data, not an execution instruction or an approved task. A run permits at most 200 candidates, each complete rendered file at most 16 KiB; exceeding a limit or cancellation fails the run without publishing a partial output set.

Success returns a complete `full` output set. No matching markers produces an empty full set, so the host removes only this binding's previously owned generated candidates through the existing publication gate. Input commit IDs are not embedded in output bytes, avoiding changed output from unrelated commits. This is explicit-marker extraction, not semantic conversation summarization.

From the repository root, after the locked workspace install:

```sh
pnpm exec vitest run plugins/feishu-chat-analysis/tests/analysis.test.ts
```

The tests use synthetic messages only. They do not prove real Feishu/Lark access, permission revocation or model-generated analysis; connector and server integration tests cover their respective boundaries.
