# Codex 原生 JSONL 有限适配

日期：2026-10-09。已实现 `codex-rollout/0.159.2-legacy-text-v1` 插件解析及在线单写者链路。兼容性依据是公开固定 tag 和合成 fixture；没有读取真实会话、运行真实 Codex 或调用模型，不能称为真实 Codex 导出验收。

## 固定格式依据

公开源码固定为 `openai/codex` 的 `rust-v0.159.2`：

- [history 记录定义](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/history/src/lib.rs)：RolloutLine 的 timestamp、可选 ordinal 与展开 item。
- [rollout wire 定义](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/history/src/rollout_payload.rs)：type/payload，以及 response_item 的可选 metadata。
- [协议定义](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/protocol/src/protocol.rs)：SessionMeta、legacy/paginated、history_base、task_started/task_complete 及别名。
- [消息定义](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/protocol/src/models.rs)：message、role、文本 content 及可选 ID。

这是受限读取 profile，不是完整 Rust schema 兼容实现。TypeBox 定义和运行时语义检查在 session-connector 内；不把 main 当稳定承诺。后续 parser 行为改变必须更改解析器身份、审查支持范围并迁移锁定实例，不能静默替换既有锁。当前安装已有执行锁可能因源码 digest 改变而拒绝，不能自动改写旧锁来通过。

## 支持与拒绝

必须先有 session_meta，cli_version 必须为 0.159.2；只支持 legacy、顶层单文件历史。history_base、fork、parent/subagent、非空 harness metadata、压缩和未知记录拒绝。metadata 中 cwd 是数据，永不跟随。支持 task_started/task_complete（及 turn 别名）边界和 response_item/message 的 input_text/output_text。user/assistant 进入规范化消息；system/developer、turn_context 和已知 user_message/agent_message/token_count/agent_reasoning 事件仅留原文，不二次抽取镜像或把系统指令变成用户经验。工具及非文本 response_item 拒绝；失败 turn 不发布。

配置默认关闭，必须显式选择服务器专用目录及 `format: codex-jsonl-0.159.2`，不扫描 ~/.codex，不递归，不读真实账号。最多 32 个顶层 JSONL 普通文件，每个 1 MiB、输入共 10 MiB；每文件最多 10000 完整记录、2000 规范化消息；最终来源快照还受 500 文件/10 MiB 约束。链接/硬链接/非普通文件、空目录和读期间替换都拒绝。

## 完整记录、追加和重启

每次有界全量重放，不持有隐含内存 offset。只提交最后一个完成 turn 的原字节前缀；无换行的末尾记录即使是合法 JSON 也等待，不完整 UTF-8 尾字节亦等待。已换行的坏 JSON/无效 UTF-8、未知或冲突记录整轮拒绝，不能跳过坏行。没有任何完成 turn 时拒绝而非发出空 full 快照。活动 turn 和半行不推进已发布前缀。原始 hash 指**消费的精确前缀**，不冒充尚未消费尾部的全文件 hash。

持久断点由已发布的来源快照、原始前缀字节数/hash、解析器身份和 binding sourceVersion 表示；进程重启从头核验。相同快照不会生成新 revision/task。ordinal 相同且记录不同拒绝；相同 ordinal 的同记录去重。message ID 在 turn 内相同且内容不同拒绝，同内容只归一化一次。无 ID/ordinal 的 response_item 按记录位置作为独立 occurrence，不能仅凭相同文本判断重复；同一文件重放不会重复发布。

截断或原子替换按新的完整快照全量校验。若还有合法完成 turn，可以发布缩短/替换后的快照，移除消息产生 tombstone，旧固定 revision 留存，依赖输出按现有规则变 stale；若只剩 metadata/半行/损坏则整轮失败，旧来源不删除。目录中任一文件失败也整轮失败。文件 inode/mtime 不作为续传信任依据。异版本替换拒绝，配置改变拒绝旧 checkpoint。该策略是显式全快照重置，不是 append-only 日志保证。

## 原文、转换与可信边界

插件生成四类来源：精确 raw.jsonl 前缀、转换后的 raw.json v1 envelope、规范化 messages、transform.json。凭据记录 schema、parser、原始 hash/bytes 和 canonical hash；候选 Markdown 明确标记 canonical 与 native 原文，绑定规范化、canonical、原始前缀和转换凭据的固定 revisions。

candidate 插件校验 v1→message 语义及转换凭据两端 hash；原生解析的语义由锁定的 official-trusted-native connector 负责，不是假称另一插件独立重解析，也不是密码学签名。没有跨插件 import 或第二个数据库写者。worker 无法提供或改写这些 source 文件；它只返回候选，再走既有审核 hash、CAS 和内部发布门禁。受信原生插件不是 OS 沙箱。

## 已执行与未覆盖

`tests/integration/session-jsonl.test.ts` 包含末尾等待、坏行/版本/历史拒绝、重复冲突、边界预算、追加重启、截断替换和在线文件交接演示。`pnpm demo:session-jsonl` 单独运行演示：服务保持运行，初次及追加同步，模拟 worker 文件返回 Markdown，测试操作员显式批准，再经实际 CLI 和 MCP 固定版本召回。操作拓扑见[session memory](SESSION_MEMORY.md)。

没有真实 Codex/模型验证、Mac 自动采集/上传、Hook、跨文件历史、任意版本兼容或工业级可靠性结论。此前只拒绝 JSONL 的旧测试仍验证默认 v1 模式不会误吞原生文件。
