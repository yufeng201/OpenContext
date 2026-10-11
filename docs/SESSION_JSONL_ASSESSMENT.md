# Codex 原生 JSONL 有限适配

日期：2026-10-11。已实现 `codex-rollout/0.159.2-legacy-text-v1` 和 `codex-rollout/0.161.0-archive-v2` 插件解析及在线单写者链路。兼容性依据是公开固定 tag 和合成 fixture；没有读取真实会话、运行真实 Codex 或调用模型，不能称为真实 Codex 导出验收。

## 固定格式依据

公开源码固定为 `openai/codex` 的 `rust-v0.159.2`：

- [history 记录定义](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/history/src/lib.rs)：RolloutLine 的 timestamp、可选 ordinal 与展开 item。
- [rollout wire 定义](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/history/src/rollout_payload.rs)：type/payload，以及 response_item 的可选 metadata。
- [协议定义](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/protocol/src/protocol.rs)：SessionMeta、legacy/paginated、history_base、task_started/task_complete 及别名。
- [消息定义](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/protocol/src/models.rs)：message、role、文本 content 及可选 ID。

这是受限读取 profile，不是完整 Rust schema 兼容实现。TypeBox 定义和运行时语义检查在 session-connector 内；不把 main 当稳定承诺。后续 parser 行为改变必须更改解析器身份、审查支持范围并迁移锁定实例，不能静默替换既有锁。当前安装已有执行锁可能因源码 digest 改变而拒绝，不能自动改写旧锁来通过。

## 0.161.0 固定源码比较与支持矩阵

已取公开固定 `rust-v0.161.0` 与 `rust-v0.159.2` 对应四文件并比较字节：rollout_payload.rs 和 protocol.rs 完全相同；models.rs 的差异是工具 helper 导出及 InputText 的 Debug 格式，不改变文本 JSON wire；history/lib.rs 新增 `guardian_review_ids`、`guardian_retained_omissions`，并新增 serde(skip) 的内存 history_revision。这些新增 Guardian 语义不在读取范围内，非空 harness metadata 仍整轮拒绝。没有通过忽略新字段扩大兼容性。

对应固定源：[0.161 rollout wire](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/history/src/rollout_payload.rs)、[0.161 协议](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/protocol/src/protocol.rs)、[0.161 消息](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/protocol/src/models.rs)、[0.161 history](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/history/src/lib.rs)。两版本共同 wire 文件 SHA256 为 `ac6c17fda98ecc6377132ac9a34fb4771e902632b943decc94261961891a3598`，共同 protocol 文件为 `d3d3d384da91b2824c10091de4331a2bc26ec5474887ed0aef1e3f3c4ae110f4`。

| 文件版本           | 显式 format         | 支持范围                                      | 不支持                                                       |
| ------------------ | ------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| 0.159.2            | codex-jsonl-0.159.2 | legacy 顶层完成文本 turn；目录或显式上传      | paginated、fork/subagent、工具、compaction、harness metadata |
| 0.161.0            | codex-jsonl-0.161.0 | 完成文本 turn、成对文本工具及有限压缩档案证据 | 分页/继承、媒体/加密工具、复杂压缩状态、Guardian             |
| 其他或混合版本集合 | 无                  | 整轮拒绝                                      | 不按“更高版本兼容”猜测                                       |

0.161 合成 fixture 位于 `plugins/session-connector/fixtures/codex-0.161.0-synthetic.jsonl`；测试比较两版本的规范化文本，确认错误 profile 和新增 Guardian metadata 拒绝。用户安装了 0.161.0 不代表所有实际 session 均受支持；必须满足表中历史/事件限制，目前没有读取真实用户文件确认。

## 支持与拒绝

必须先有 session_meta，cli_version 必须精确匹配所选 0.159.2 或 0.161.0 profile；只支持 legacy、顶层单文件历史。history_base、fork、parent/subagent、非空 harness metadata 和未知记录拒绝；0.161.0 的有限工具/压缩范围见下文。metadata 中 cwd 是数据，永不跟随。支持 task_started/task_complete（及 turn 别名）边界和 response_item/message 的 input_text/output_text。user/assistant 进入规范化消息；system/developer、turn_context 和已知 user_message/agent_message/token_count/agent_reasoning 事件仅留原文，不二次抽取镜像或把系统指令变成用户经验。0.159.2 的工具及非文本 response_item 继续拒绝；失败或中止 turn 不发布。

配置默认关闭，必须显式选择服务器专用目录及 `format: codex-jsonl-0.159.2`，不扫描 ~/.codex，不递归，不读真实账号。最多 32 个顶层 JSONL 普通文件，每个 1 MiB、输入共 10 MiB；每文件最多 10000 完整记录、2000 规范化消息；最终来源快照还受 500 文件/10 MiB 约束。链接/硬链接/非普通文件、空目录和读期间替换都拒绝。

## 完整记录、追加和重启

每次有界全量重放，不持有隐含内存 offset。只提交完成 turn（或其后支持的压缩检查点）的原字节前缀；无换行的末尾记录即使是合法 JSON 也等待，不完整 UTF-8 尾字节亦等待。已换行的坏 JSON/无效 UTF-8、未知或冲突记录整轮拒绝，不能跳过坏行。没有任何完成 turn 时拒绝而非发出空 full 快照。活动 turn 和半行不推进已发布前缀。目录模式原始 hash 指**消费的精确前缀**，不冒充尚未消费尾部的全文件 hash。上传模式额外区分客户端原始前缀声明与服务器可验证的文本投影 hash，见下文及操作指南。

持久断点由已发布的来源快照、原始前缀字节数/hash、解析器身份和 binding sourceVersion 表示；进程重启从头核验。相同快照不会生成新 revision/task。ordinal 相同且记录不同拒绝；相同 ordinal 的同记录去重。message ID 在 turn 内相同且内容不同拒绝，同内容只归一化一次。无 ID/ordinal 的 response_item 按记录位置作为独立 occurrence，不能仅凭相同文本判断重复；同一文件重放不会重复发布。

截断或原子替换按新的完整快照全量校验。若还有合法完成 turn，可以发布缩短/替换后的快照，移除消息产生 tombstone，旧固定 revision 留存，依赖输出按现有规则变 stale；若只剩 metadata/半行/损坏则整轮失败，旧来源不删除。目录中任一文件失败也整轮失败。文件 inode/mtime 不作为续传信任依据。异版本替换拒绝，配置改变拒绝旧 checkpoint。该策略是显式全快照重置，不是 append-only 日志保证。

## 原文、转换与可信边界

插件生成四类来源：精确 raw.jsonl 前缀、转换后的 raw.json v1 envelope、规范化 messages、transform.json。凭据记录 schema、parser、原始 hash/bytes 和 canonical hash；候选 Markdown 明确标记 canonical 与 native 原文，绑定规范化、canonical、原始前缀和转换凭据的固定 revisions。

candidate 插件校验 v1→message 语义及转换凭据两端 hash；原生解析的语义由锁定的 official-trusted-native connector 负责，不是假称另一插件独立重解析，也不是密码学签名。没有跨插件 import 或第二个数据库写者。worker 无法提供或改写这些 source 文件；它只返回候选，再走既有审核 hash、CAS 和内部发布门禁。受信原生插件不是 OS 沙箱。

## 已执行与未覆盖

`tests/integration/session-jsonl.test.ts` 包含末尾等待、坏行/版本/历史拒绝、重复冲突、边界预算、追加重启、截断替换和在线文件交接演示。`pnpm demo:session-jsonl` 单独运行演示：服务保持运行，初次及追加同步，模拟 worker 文件返回 Markdown，测试操作员显式批准，再经实际 CLI 和 MCP 固定版本召回。操作拓扑见[session memory](SESSION_MEMORY.md)。

没有真实 Codex/模型验证、Mac 自动采集、Hook、跨文件历史、任意版本兼容或工业级可靠性结论。显式客户端上传已实现，尚未进行真实 Mac↔服务器多机器验证。此前只拒绝 JSONL 的旧测试仍验证默认 v1 模式不会误吞原生文件。

上传测试 `tests/integration/session-upload.test.ts` 覆盖投影元数据移除、前缀等待、权限/预算、网络响应丢失重放、重启、CAS/ABA冲突、客户端取消和完整在线召回。上传保留四固定来源依赖，但本机原始 hash 仅为客户端声明；服务器独立校验的是收到的投影。实际命令、取消及选择替换语义见[操作指南](SESSION_MEMORY.md)。

## 0.161.0 archive-v2：工具与压缩档案

这次扩展只启用于 0.161.0，解析器身份由 legacy-text-v1 改为 archive-v2。原有 0.159.2 范围不变；已有插件锁因源码 digest 改变应走显式升级/重新绑定流程，不能覆盖锁。普通 v1 JSON 导入不接受 OpenContext 的 archive evidence 扩展，必须由原生 JSONL 插件生成。

固定公开依据为 [ResponseItem](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/protocol/src/models.rs)、[CompactedItem wire](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/history/src/rollout_payload.rs) 和 [compaction 实现](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/compact.rs)。官方 compaction 会替换模型历史；本实现保留原始档案和检查点证据，**不重建模型当前上下文**。

- 支持 `function_call` / `custom_tool_call` 及对应 output，要求非空 call_id、同 turn 先调用后结果；并行调用可交错返回。arguments/input 保持原字符串，不执行或解释。output 只接受字符串或纯 input_text 数组，缺 ID 的函数通知、媒体/加密输出、未知字段拒绝。custom call 的 status 仅接受缺省/null/completed。
- 每条调用/结果独立规范化为 role=tool，保留 call_id、原始行号/行 SHA256 和双向配对行/hash。相同 ID 的相同内容去重，冲突拒绝。仍在活动 turn 的调用不推进前缀；完成标记处仍缺结果时整轮 PARTIAL_SESSION，既有发布不变，不猜测工具完成。
- `compacted.message` 必须是非空文本。可携带仅由文本 message 组成的 replacement_history，以及等长空对象 metadata 数组、简单 window 标识；非空 Guardian/retained/MCP/resume/token 状态和不认识的字段拒绝。空 message 的远端/不透明检查点、replacement 中工具或加密 compaction 不支持。压缩时若仍有未配对工具亦拒绝。
- 压缩文本规范化为 role=summary，标明不是用户原话或批准规则；记录检查点行/hash、其前方观察到的原始前缀行数/hash，coverage 恒为 `observed-prefix-only; exact-model-coverage-unknown`。replacement 仅保留原文，不再次提炼；turn 外的检查点用明确的 OpenContext 合成 turn ID 归档。没有声称摘要逐字覆盖全部前文或恢复丢失历史。
- 规范化 user/assistant 同样带 sourceLine/hash，任务按 session 和来源行顺序排列。任务及候选仍经现有人工审核，tool/summary 明确绕过确定性 `Rule:` 标记提取器；它们只能作为显式 Agent 的不可信证据，不能批准发布或更改 Agent 配置。

reasoning response、已知 UI 镜像/用量事件保留原文并在 transform.rawOnly 计数及 connector skipped 中报告，不作为第二条消息流。允许列表包括工具 begin/end/delta、patch、item started/completed、raw response、plan/reasoning delta 和 context_compacted；仅其镜像身份受支持，不宣称解析其中工具状态。turn_aborted、error、rollback、collab、Hook、权限审批及未知事件仍拒绝。system/developer 同样 raw-only；非空外层 harness metadata 继续拒绝。

0.161 上传使用 `archive-projection/v2`，保留工具与 compacted 的受支持结构、顺序及 ordinal，在服务器重新配对解析。替换机器 metadata/turn_context，UI 只保留类型与必要 turn 边界，推理正文/密文置空，顶层和 replacement 内 system/developer 文本均用占位替换。用户、assistant、工具参数/结果和摘要正文不会猜测脱敏，可能包含路径或敏感文本；只应上传已审核的选定文件。客户端原始前缀 hash 仍只是声明；服务器证明的是收到的投影行/hash，不伪称验证了本机原始字节。

候选生成要求 evidence 存在对应 native/receipt，核对实际原始行及配对行 SHA256、call_id、工具类型/先后关系，以及摘要的观察前缀 SHA256；普通 JSON 导入不能自填 JSONL 来源声明。候选四个固定 revision 依赖和人工 review gate 不变。预算保持每文件 1 MiB/10000 行/2000 规范化记录、上传集合 1 MiB、任务最多 500 消息，不截短工具文本以通过预算。

新增 `tests/integration/session-complex.test.ts` 使用公开结构合成 fixture，验证交错配对、重复/冲突、坏行、尾部等待、媒体/加密/高级压缩拒绝、嵌套投影、伪造证据拒绝，并实际运行 loopback 上传→重启→fake executable→审核→Markdown→CLI search/MCP outline/section及固定原文追溯，最后验证取消后的迟到响应拒绝。可运行 `pnpm demo:session-complex`。没有真实用户会话、认证、模型或全 Codex 兼容验收。
