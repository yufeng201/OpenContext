# Codex 原生 JSONL 适配评估

日期：2026-10-09。结论：可在 session 插件中继续实现，但本轮优先完成在线唯一写入者及审核发布，**没有交付原生 JSONL 解析器**。只构造了明确标为 synthetic 的拒绝用例，没有访问真实 `~/.codex/sessions`、调用 Codex 或安装 Hook。不能写成“原生格式解析通过”，更不能写成“真实 Codex 导出验收通过”。

## 已核实的接缝

现有 `session-connector` 仅处理完整 `opencontext.session-import/v1` envelope；来源路径依赖 session/turn/message 的稳定身份。`session-candidates` 会用固定 raw.json 验证归一化消息，再生成双 revision 引用。因此只把 JSONL 拼成一个 envelope，会把新造 JSON 错当原始文件，不能沿用“原文精确保留”的证明。

公开的 [Codex 协议源码](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) 中，SessionMeta 包含 `cli_version`、`history_mode` 和可选 `history_base`；HistoryPosition 指向另一 rollout 的前缀并包含字节偏移。源码也区分 legacy/paginated 历史。该链接为可变 main，核查日期如上，不能当成锁定版本的兼容性承诺。这些字段说明“读完单个 JSONL 文件”不总等于完整对话；适配前必须固定支持的格式/客户端版本及历史范围。

## 下一增量必须一起实现的内容

1. 格式解释放 session 插件，以固定版本的公开结构和合成 fixture 为依据；不扫描默认目录。原始 JSONL 保留原字节，规范化消息和 Markdown 仍通过共享文件/任务门禁。
2. 用文件身份、前缀 hash、完整记录边界和 turn 终态管理断点。尾部半行不得推进断点；文件截断/替换必须重新核对。现有连接器返回 full 快照，不能简单跳过半写文件并把缺失来源当删除；需要保留已确认的旧快照或整轮拒绝。
3. 完全相同事件只去重一次，有稳定身份却内容冲突时拒绝；不能把所有相同文本都当重复事件。未知版本、未知必需事件、子 Agent、缺失历史前缀等必须拒绝，不能默默得到“完整”历史。
4. 原始 JSONL→归一化消息→候选引用必须可验证且固定版本，不能通过候选插件直接导入另一个场景插件来绕过边界。需要显式设计共享来源证明端口或统一 session 插件职责后再接入发布。

## 当前真实验证

在线测试向专门创建的合成导出目录放入 rollout-shaped JSONL，分别包括完整行、重复行及截断尾行；三者均因格式未支持而整轮拒绝，来源 sourceVersion 和 taskId 不推进。未知 v999 导出 envelope 同样拒绝。这只证明失败关闭，**不是 JSONL 去重、增量解析或真实兼容性测试**。正常 v1 导出仍可通过在线同步、模拟 worker、人工审核和召回闭环。
