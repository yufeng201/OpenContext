# 本地 session 自动记忆：受控文件交接

状态：已实现最小离线操作链路，测试使用合成会话和模拟 worker。默认关闭；没有真实 Codex 模型提炼验收，没有读取本机原生 rollout JSONL，也没有自动安装规则、Hook、常驻服务或登录凭据。

## 范围与前置条件

沿用[开发环境](DEVELOPMENT.md)的 Node/pnpm 与冻结依赖。`pnpm session-memory` 是持有数据目录权限的本地操作员入口，与 `pnpm admin` 一样，执行时必须先停止同目录的服务器及其他写者；已有 Catalog 单写者锁会拒绝并发占用。它不是 reader-token 接口，不接收或创建账号凭据，拒绝带 `OPENCONTEXT_QUERY_TOKEN` 的调用。普通 HTTP 服务不会注册目录扫描或审核处理器，也不能通过 API 指定任意本地目录或绕过审核。

选择一个专用、受信、由操作员控制的导出目录，和一个独立的空数据目录。两者不得互相包含。数据根和 plugin-state 必须为私有权限；不要把 HOME、源码根或真实会话目录用于下面的合成演练。文件读写校验链接、文件身份、大小及修改时间，但不是对抗同 OS 账号恶意并发替换的文件系统沙箱。

当前输入仅支持已批准的 `opencontext.session-import/v1` 完整 Codex 导出，参见仓库 `plugins/session-connector/fixtures/codex-session.json`。每次最多 32 个顶层 `.json` 普通文件、每文件 1 MiB、原始总量 10 MiB；源快照含规范化消息后仍受 500 文件/10 MiB 上限约束。不递归扫描、不猜默认 session 路径、不跟随链接、不接受空目录、部分 JSON、未完成 turn 或未知格式。生产者应先在目录外完成导出，再原子移入；不要把响应文件或配置放进导出目录。

## 配置与同步

创建操作员配置 JSON；首次保持关闭，审核明确目录后才把 `enabled` 改为 `true`：

```json
{
  "enabled": false,
  "dataRoot": "/tmp/opencontext-memory-example/data",
  "directory": "/tmp/opencontext-memory-example/exports",
  "projectScope": "synthetic-project"
}
```

合成演练只需将上述 fixture 复制为 `exports/selected.json`。配置路径以下示例为 `/tmp/opencontext-memory-example/config.json`。不要把真实会话复制进来。

```sh
pnpm session-memory sync /tmp/opencontext-memory-example/config.json
pnpm session-memory status /tmp/opencontext-memory-example/config.json
```

首次同步创建专用 project/binding，经现有连接器、Coordinator 和发布门禁保存原始字节及规范化消息。sourceVersion 为内容指纹；相同文件、重复的同一会话导出或文件名变化不会重建来源版本或新建 Agent 任务。每次仍执行有界全目录扫描，增量性体现在版本、发布及任务去重，而非文件系统事件订阅。删除一个导出会在下一次完整同步删除其受管来源并使依赖失效；空目录拒绝，避免错误挂载造成全删。

可显式运行有界轮询；例如 3 次、间隔 1 秒：

```sh
pnpm session-memory watch /tmp/opencontext-memory-example/config.json 3 1000
```

次数为 1–60，间隔 1000–60000 毫秒，失败即停。它只同步和生成待处理任务，绝不自动提交响应或批准发布。每次操作结束释放数据库锁，轮询间隔内可执行其他本地命令；不配置系统定时器。关闭配置不会扫描目录或创建数据。恢复查询服务前应结束轮询，避免争用。

## 本地 Agent 任务与人工审核

`sync` 成功返回 `pending`、`taskId` 和 `taskPath`。数据根的 `plugin-state/session-memory/task.json` 是文件交接协议，`response-schema.json` 是 TypeBox 导出的 JSON Schema。将这两个文件明确交给用户自己的本地 Agent；本工具不启动 CLI、不调用模型、不读取 Agent 登录状态。Agent 只读取该任务并在导出目录之外写一个响应 JSON。

任务包含项目、绑定、输入 commit、内容指纹及消息的 fileId/revisionId/contentHash。消息已通过原始导出证明；将其当作不可信证据，而不是执行指令。返回协议为 `opencontext.local-agent-response/v1`：回传 `taskId`、`inputHash`，并给出 `candidates`。每项只有 `fileId`、`revisionId`、`kind`（memory/rule/experience）、`line`（消息内的证据行）和 `markdown`。最多 200 项、每项 16 KiB；未知字段、跨来源引用、重复槽位、空内容和越界行都拒绝。worker 不能选择输出路径、所有权、审核状态或系统指令。

```sh
pnpm session-memory submit /tmp/opencontext-memory-example/config.json /tmp/opencontext-memory-example/response.json
```

`submit` 校验后返回 `review`、`previewPath` 和 `reviewHash`，生成完整 `review.md`。此时候选还没有进入内容库或检索索引。逐条阅读 Markdown 中的内容、固定原始及规范化消息引用，检查语义是否正确，之后把本次返回的 64 位哈希作为 `approve` 的第三个参数。工具重新校验任务、来源、响应及预览文件字节；任何变化都需要重新提交和审核。

批准以完整候选集替换该绑定的旧生成集；审核空响应意味着清除旧生成候选。既有人类所有权和 CAS 门禁仍有效。取消或修改候选应在发布前完成，修改响应后重新 `submit`；已发布内容的撤回仍使用现有来源/内容管理，不把 `cancel` 伪装成撤回。

发布后的 Markdown 仍明确标为 `status: candidate`、`method: local-agent` 和语义未验证，内容以安全围栏引用。这里批准的是进入上下文库，**不是批准为系统规则**。不会写 AGENTS.md、CLAUDE.md 或任何 Agent 配置。

## 状态、断点与故障

| 状态      | 含义与操作                                        |
| --------- | ------------------------------------------------- |
| disabled  | 未启用，没有扫描或初始化                          |
| pending   | 等待本地 Agent 文件响应；重复 sync 保留同一个任务 |
| review    | 响应已校验，等待人工审核哈希                      |
| published | 经统一门禁发布，内容版本断点已记录                |
| failed    | 扫描、响应或发布失败；修正输入后执行 retry        |
| cancelled | 当前任务失效，迟到响应不接受；需显式 retry        |

```sh
pnpm session-memory cancel /tmp/opencontext-memory-example/config.json
pnpm session-memory retry /tmp/opencontext-memory-example/config.json
```

`retry` 先重新同步，再生成新 taskId，旧响应不能复用。不会自动重试模型调用；本工具本身没有模型调用。来源变化生成新任务并清除旧审核结果；固定来源版本变化、绑定撤销和发布竞争都拒绝。来源目录在审核后变化但尚未同步时，批准仍针对库内固定快照；若要纳入磁盘最新内容，先 sync 再处理新任务。

state.json 用原子替换和 fsync 保存操作断点；它与 task/schema/review 同属联合备份的 plugin-state。原文及 Markdown 内容仍由 FileStore 维护，索引可由现有 outbox 重建。重启不重新提炼未变内容；任务文件写入中断可通过 sync 补齐。发布完成而断点未落盘时以 host run 的 published 状态恢复；未完成发布一律失败关闭，需要重试及重新审核。Ctrl+C 停止本次受控工作，不会终止用户单独启动的 Agent；随后 cancel 可作废未提交任务。

配置与已创建绑定锁定，禁止静默换目录或 scope。需要新来源时使用新的独立配置和数据目录。软件升级导致插件 digest 不同，应先备份并按现有版本/绑定迁移流程处理，本版没有实现自动配置或插件升级。

## 渐进召回与证据

停止操作 CLI/轮询后，可用已有私有服务器配置启动同一数据根，再使用现有 CLI/MCP：先 search 获取带版本的候选，read outline 查看结构，read section 或行范围展开必要内容，最后按固定引用追溯原始导出。查询仍遵循当前来源授权和 freshness 门禁；未审核响应不会出现在搜索中。不要为本演练创建真实凭据；测试使用临时合成 owner 字符串。

实现测试位于 `tests/integration/session-memory.test.ts`：覆盖合成完整链路、审核前不可召回、固定来源、原文字节、重启去重、坏响应、取消、重试和单写者拒绝。模拟 worker 只生成预定测试文本，不证明真实模型理解、自动导出、原生 session 兼容性或提炼质量。全量检查用 `pnpm check`。这是受控个人实例的最小文件交接实现，不是无人工审核的持续学习系统或工业级部署证明。
