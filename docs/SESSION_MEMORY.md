# 本地 session 自动记忆：受控文件交接

状态：已实现在线控制 API/CLI 与兼容离线操作链路，测试使用合成会话和模拟 worker。默认关闭；没有真实 Codex 模型提炼验收，没有读取真实用户的原生 rollout JSONL，也没有自动安装规则、Hook、常驻采集服务或登录凭据。

## 在线操作：服务器保持运行

推荐使用 `pnpm session-memory:online`。服务器复用唯一 Catalog、FileStore、Coordinator 和发布门禁；每次控制请求不会另开数据库写者。旧 `pnpm session-memory` 是停服离线兼容入口，不能与在线服务同时写同一目录。

首次由操作员在本地准备下文的配置 JSON（默认 `enabled: false`），审核选定目录后启用。启动服务器时通过 `OPENCONTEXT_SESSION_MEMORY_CONFIG` 指向该配置文件，其 dataRoot 必须与 `OPENCONTEXT_DATA_ROOT` 相同。这是服务器本地配置，不接受 HTTP 修改路径。开启功能需私有模式；demo 拒绝启用。未提供配置时控制功能保持关闭。此增量不改变 owner 初始化：使用用户已有的私有配置，不创建或输出凭据。

在线 CLI 使用现有 `OPENCONTEXT_OWNER_TOKEN` 和 `OPENCONTEXT_URL`（默认 `http://127.0.0.1:4310`）。不读取或写入本地运行数据目录，不修改 Agent 配置；HTTP 只允许 loopback，远端必须 HTTPS，拒绝 URL 中的凭据和重定向。

```sh
pnpm session-memory:online config
pnpm session-memory:online sync
pnpm session-memory:online status
pnpm session-memory:online task
pnpm session-memory:online submit /tmp/opencontext-memory-example/response.json
pnpm session-memory:online review
```

`task` 输出 `{task, responseSchema}`，可重定向到明确选定的本地文件交给用户自己的 Agent；不是自动运行 Agent。模拟 worker/Agent 只按 task 生成 response JSON。`submit` 不发布，`review` 返回完整 Markdown 和审核哈希。阅读后执行 `approve TASK_ID REVIEW_SHA256`；取消执行 `cancel TASK_ID`，修正失败后执行 `retry TASK_ID`。TASK_ID 和哈希必须来自当前响应，旧任务不能取消或批准新任务。所有命令都放在 `pnpm session-memory:online` 后。

| 路由                                   | 方法 / 输入             | 权限与行为                            |
| -------------------------------------- | ----------------------- | ------------------------------------- |
| `/api/session-memory`                  | GET                     | owner；配置、状态、active、任务及断点 |
| `/api/session-memory/task`             | GET                     | owner；待处理任务与响应 schema        |
| `/api/session-memory/review`           | GET                     | owner；当前审核 Markdown 与哈希       |
| `/api/session-memory/sync`             | POST `{}`               | owner；选定目录同步并生成或复用任务   |
| `/api/session-memory/submit`           | POST AgentResponse      | owner；最多 4 MiB，校验候选，不发布   |
| `/api/session-memory/approve`          | POST taskId、reviewHash | owner；显式批准当前预览后发布         |
| `/api/session-memory/cancel`、`/retry` | POST taskId             | owner；作废或重新同步并建立新任务     |

匿名返回 401，reader 返回 403；既有 Host/Origin/cookie 门禁继续生效。任务和预览含会话内容，只允许 owner 访问。专用插件不能通过通用创建 binding API 选择；普通 process 没有审核授权时失败关闭。更改本地配置会拒绝旧任务访问，不会静默把旧来源套用到新目录。来源撤销后拒绝任务/审核及批准操作。

相同并发请求合并执行；不同的同时操作返回 `RESOURCE_BUSY`。已发布任务的相同批准请求幂等，但仍检查配置、来源有效性与版本。新配置在重启后生效；日常同步、提交、审核和发布均不需要停服。在线控制请求脱离客户端连接后仍可能完成：CLI 15 秒超时不撤销服务器已接受的操作，应先查询 status/active，再决定重试。active 工作期间不另起控制操作，pending/review 的取消仅作废交接任务，不终止用户另行运行的 Agent。读接口继续服务，既有队列也可能使控制请求等待。

在线合成回归见 `tests/integration/session-memory-online.test.ts`，覆盖持续运行的服务、权限拒绝、并发幂等、审核前不可召回、重启继续审核、撤销、配置变更以及真实 loopback CLI 完整操作。原生 JSONL 已有显式启用的有限适配，支持范围与拒绝边界见[适配说明](SESSION_JSONL_ASSESSMENT.md)。

## 原生 Codex JSONL：显式服务器目录

在新的专用配置中设置 `format: "codex-jsonl-0.159.2"` 或 `format: "codex-jsonl-0.161.0"`（必须匹配文件 metadata 中的版本），其余配置字段相同。目录只放明确选定的顶层 `.jsonl` 文件。默认仍关闭；省略 format 沿用 v1 `.json` 导出。配置与已有 checkpoint 不一致会拒绝，不能直接把既有 v1 binding 改成 JSONL。

`directory` 是 **OpenContext 服务器的本地绝对路径**。Mac CLI 只发送控制请求，不能让云端读取 Mac 的 `/Users/...`。目录模式只适合同机部署或操作员已把文件放到服务器的情形。异地主机可使用下一节的显式客户端上传模式，无需让服务器读取 Mac 路径；没有自动采集。不要把配置和 worker 响应放入来源目录。原生记录中的 `cwd` 只保留为数据，绝不据此打开路径。

两个 profile 分别针对公开固定版本 Codex 0.159.2/0.161.0 的 legacy 顶层文本 rollout；仅发布已完成 turn 的原始前缀，不声明整个会话已经结束。原始 JSONL 前缀、转换 v1 和转换凭据分别保存，包含 SHA256、已消费字节数和解析器身份；候选依赖这些固定 revision。未知版本/事件、paginated/fork/subagent 历史失败关闭；0.161.0 新增成对文本工具和有限压缩档案证据，准确范围见适配说明。末尾无换行的记录（含不完整 UTF-8）等待，下次同步重读；中部坏行导致整轮拒绝。完整边界、重复、截断及信任边界详见适配说明。

可直接运行有界合成演示：

```sh
pnpm demo:session-jsonl
```

演示测试会创建临时数据目录、固定的合成测试 token 和 loopback 服务，初次/追加同步后导出 task 文件，模拟 worker 返回 Markdown，再由测试操作员明确提交批准请求，验证 CLI 搜索和 MCP 固定 revision 读取，最终清理。它自动执行的是测试中的批准步骤，日常流程仍要求用户阅读 review 后手工 approve；没有启动 Codex Agent 或调用模型。

## Mac/本地 CLI 上传：一次性选择，不运行后台采集

服务器操作员使用已有私有实例的 owner 凭据，准备一个新的专用 session-memory 配置；初始关闭，审核配置后才改为 true：

```json
{
  "enabled": false,
  "inputMode": "upload",
  "format": "codex-jsonl-0.161.0",
  "dataRoot": "/tmp/opencontext-upload-example/server-data",
  "projectScope": "synthetic-upload-project"
}
```

`dataRoot` 是服务器本机路径，必须与 `OPENCONTEXT_DATA_ROOT` 相同。上传模式**不填写 directory**；不能把 Mac 路径配置到服务器。服务器通过 `OPENCONTEXT_SESSION_MEMORY_CONFIG` 加载此文件，功能只在 private 模式下可启用。省略配置或 enabled=false 时仍拒绝上传。已有目录模式 checkpoint 不能直接改成上传模式，已有执行锁也不会被自动重写；在新专用配置/数据根验证，迁移旧实例需另行受控操作。本轮不创建用户凭据或修改网络/Agent 配置。

客户端需要此版本项目及冻结依赖、Node 24.19.0/pnpm 11.19.0；使用已有 `OPENCONTEXT_URL` 和 `OPENCONTEXT_OWNER_TOKEN`。远端地址必须是既有 HTTPS 入口，HTTP 仅允许 loopback；拒绝 URL 凭据和重定向。下面 PATH 是运行 CLI 的机器本地路径（Mac 上可以是 /Users/...），只用于本地读取，不发送该路径：

```sh
pnpm session-memory:upload --file /tmp/opencontext-client-example/selected.jsonl
# 或：整个选定集合，最多八个顶层 JSONL 文件
pnpm session-memory:upload --directory /tmp/opencontext-client-example/selected
pnpm session-memory:online status
pnpm session-memory:online task > /tmp/opencontext-client-example/task.json
# 用户自己的 worker 读取 task 并写 response；这里没有自动启动 Agent
pnpm session-memory:online submit /tmp/opencontext-client-example/response.json
pnpm session-memory:online review
```

阅读预览后，使用其中的当前 TASK_ID/REVIEW_SHA256 执行 `pnpm session-memory:online approve TASK_ID REVIEW_SHA256`。在上传后修改 JSONL，再运行同一 upload 命令即可追加同步；没有 daemon、Hook、默认目录发现或定时器。`--directory` 把当前选择作为完整集合；没有选中的旧 session/消息会按已有 full 快照规则 tombstone，不能把一次 `--file` 当成追加第二个独立文件的集合合并。空集合拒绝。需要保留多份会话时，每次明确选择包含全部目标文件的目录。

客户端插件先校验完整文件，等待末尾半行。0.159.2 上传 **text-projection/v1**；0.161.0 上传 **archive-projection/v2**，新增成对工具文本与有限压缩摘要。两者都不是本机原始字节，不发文件名/cwd/环境等机器 metadata，系统/developer 文本（包括 replacement 内）置为占位；服务器校验投影必须可精确重建，不能靠附加字段夹带元数据。用户/assistant、工具参数/结果和压缩摘要正文若包含路径或秘密，不会猜测删改；操作员仍应先审核明确选中的内容。已知秘密字段检查不是完整秘密检测。

每个本地文件最多 1 MiB、集合最多 8 文件；上传 envelope 的 UTF-8 JSON 最多 1 MiB，HTTP body 最多 2,105,344 字节，服务器解析后来源仍受 500 文件/10 MiB 约束。请求只带 cliVersion、文本投影、原始消费前缀 hash/bytes 和 CAS 字段，不读取/上传本地环境变量（仅已有连接地址和 token 用于请求）。每次全量有界重放；相同前缀在追加半行或重启后保持幂等，无重复候选。截断/替换按已验证完整集合重置，坏行和未知语义在发送或写入前拒绝。

`POST /api/session-memory/upload` 是现有私有控制面下的 owner-only 路由，reader/匿名拒绝；不新增公开监听或放宽 Host/Origin/cookie 门禁。服务复用现有 Catalog、FileStore、Coordinator，整个集合以一个不可变 import 对象进行 CAS 替换，随后正常同步并创建审核任务。通用 imports POST/DELETE 不可修改这类专用 binding。`status` 返回 `uploadHash` 和 `uploadId`；二者共同约束更新，避免 A→B→A 后迟到请求覆盖新选择。已经是相同当前上传内容时只幂等同步，不复活已取消任务。

客户端固定一次读取所得的请求体及 expectedUploadHash/expectedUploadId，单请求限时 15 秒；仅网络错误/超时最多重试一次，不对 409 冲突或其他 HTTP 错误重试。冲突后先检查 status 和当前选择，再决定是否明确重新上传。SIGINT/SIGTERM 停止客户端请求及后续重试；已经被服务器接受的上传可能继续完成，不承诺网络断开能回滚导入。查询 status；`cancel TASK_ID` 作废待审核任务而保留来源，需恢复时显式 `retry TASK_ID`。从未批准的上传不会自动产生可召回 Markdown。

服务器原始来源是收到的投影，保存其精确 hash；转换凭据另保留客户端原始消费前缀 hash/bytes，并在候选中明确标为**未经服务器验证的客户端声明**。服务器没有收到已省略的原始元数据，因此不能独立证明该原始 hash，也不把投影冒充原文件。所有候选依赖固定的消息、投影、canonical 和转换凭据 revisions，仍需审核哈希与发布门禁。

```sh
pnpm demo:session-upload
```

这个有界演示使用同一 Linux 云端上的两个临时隔离目录模拟 client/server，使用实际 loopback HTTP、上传 CLI、模拟文件 worker、测试操作员批准及 CLI/MCP 固定版本召回，并清理本轮临时资源。不是 Mac↔云端多机器实测，不调用真实 Codex/模型。

## 范围与前置条件

以下为兼容离线入口，沿用[开发环境](DEVELOPMENT.md)的 Node/pnpm 与冻结依赖。`pnpm session-memory` 是持有数据目录权限的本地操作员入口，与 `pnpm admin` 一样，执行时必须先停止同目录的服务器及其他写者；已有 Catalog 单写者锁会拒绝并发占用。它不是 reader-token 接口，不接收或创建账号凭据，拒绝带 `OPENCONTEXT_QUERY_TOKEN` 的调用。在线使用上文新 CLI，不应为每次同步重启服务器。

选择一个专用、受信、由操作员控制的导出目录，和一个独立的空数据目录。两者不得互相包含。数据根和 plugin-state 必须为私有权限；不要把 HOME、源码根或真实会话目录用于下面的合成演练。文件读写校验链接、文件身份、大小及修改时间，但不是对抗同 OS 账号恶意并发替换的文件系统沙箱。

默认 `format` 为 `v1`，支持已批准的 `opencontext.session-import/v1` 完整 Codex 导出，参见仓库 `plugins/session-connector/fixtures/codex-session.json`。每次最多 32 个顶层 `.json` 普通文件、每文件 1 MiB、原始总量 10 MiB；源快照含规范化消息后仍受 500 文件/10 MiB 上限约束。不递归扫描、不猜默认 session 路径、不跟随链接、不接受空目录、部分 JSON、未完成 turn 或未知格式。生产者应先在目录外完成导出，再原子移入；不要把响应文件或配置放进导出目录。

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

`sync` 成功返回 `pending`、`taskId` 和 `taskPath`。数据根的 `plugin-state/session-memory/task.json` 是文件交接协议，`response-schema.json` 是 TypeBox 导出的 JSON Schema。将这两个文件明确交给用户自己的本地 Agent；原有 sync/submit 命令不启动 CLI、不调用模型、不读取 Agent 登录状态；新增显式 worker 适配器见下文。Agent 只读取该任务并在导出目录之外写一个响应 JSON。

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

`retry` 先重新同步，再生成新 taskId，旧响应不能复用。不会自动重试模型调用；原有同步命令本身没有模型调用。来源变化生成新任务并清除旧审核结果；固定来源版本变化、绑定撤销和发布竞争都拒绝。来源目录在审核后变化但尚未同步时，批准仍针对库内固定快照；若要纳入磁盘最新内容，先 sync 再处理新任务。

state.json 用原子替换和 fsync 保存操作断点；它与 task/schema/review 同属联合备份的 plugin-state。原文及 Markdown 内容仍由 FileStore 维护，索引可由现有 outbox 重建。重启不重新提炼未变内容；任务文件写入中断可通过 sync 补齐。发布完成而断点未落盘时以 host run 的 published 状态恢复；未完成发布一律失败关闭，需要重试及重新审核。Ctrl+C 停止本次受控工作，不会终止用户单独启动的 Agent；随后 cancel 可作废未提交任务。

配置与已创建绑定锁定，禁止静默换目录或 scope。需要新来源时使用新的独立配置和数据目录。软件升级导致插件 digest 不同，应先备份并按现有版本/绑定迁移流程处理，本版没有实现自动配置或插件升级。

## 渐进召回与证据

停止操作 CLI/轮询后，可用已有私有服务器配置启动同一数据根，再使用现有 CLI/MCP：先 search 获取带版本的候选，read outline 查看结构，read section 或行范围展开必要内容，最后按固定引用追溯原始导出。查询仍遵循当前来源授权和 freshness 门禁；未审核响应不会出现在搜索中。不要为本演练创建真实凭据；测试使用临时合成 owner 字符串。

实现测试位于 `tests/integration/session-memory.test.ts`：覆盖合成完整链路、审核前不可召回、固定来源、原文字节、重启去重、坏响应、取消、重试和单写者拒绝。模拟 worker 只生成预定测试文本，不证明真实模型理解、自动导出、原生 session 兼容性或提炼质量。全量检查用 `pnpm check`。这是受控个人实例的最小文件交接实现，不是无人工审核的持续学习系统或工业级部署证明。

## 显式本地 Codex worker（软件契约，尚未真实模型验收）

新增 `session-memory:worker` 命令只在 `run` / `retry` 且带 `--execute-model` 时启动进程；prepare/status/cancel/submit 不调用模型。没有 daemon、Hook、自动重试或配置写入。当前测试全部使用 fake 可执行程序与合成任务，没有读取现有认证或运行真实 Codex。

1. 使用已有在线 `task` 命令导出当前服务器任务 JSON，交给 `pnpm session-memory:worker prepare TASK_JSON`。返回独立私有临时 JOB_DIR，固定任务 hash；新建空 codex-home/runtime-home，不复制用户配置或登录文件。
2. 真实启用是后续独立授权步骤：先确认固定官方 Codex **0.161.0**，以及专用 JOB_DIR/codex-home 的认证、消费方式和系统沙箱能力。若没有专用登录就停止，不能借用现有 HOME 认证或回退到 API key；本轮不执行认证或模型命令。
3. 将服务端 owner/query 凭据从执行进程环境移除，再显式运行 `pnpm session-memory:worker run JOB_DIR --execute-model`。失败后只有显式 `retry JOB_DIR --execute-model` 才能再执行，每个 job 最多三次。成功后同一任务返回已验证缓存，不重新启动进程。
4. 在独立、持有既有 owner 凭据的命令进程执行 `pnpm session-memory:worker submit JOB_DIR`。它只连接 OPENCONTEXT_URL（默认 loopback），重新获取并比对完整当前任务，然后提交响应。迟到任务在客户端和服务器再次拒绝。submit 永远不启动 worker，也不批准发布；仍须人工审阅当前 reviewHash 并单独 approve。

固定调用使用 structured argv、shell:false、stdin JSON 证据，官方 `exec --strict-config --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox read-only --color never --cd ... --output-schema ... --output-last-message ... -`。另固定禁用 shell、工具搜索、MCP、应用、插件、子 Agent、Hook、技能指令和 Web 搜索等特性；不接受用户 shell 模板、自定义程序/参数或额外可写目录。参数契约依据固定官方 [exec CLI](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/exec/src/cli.rs)、[共享选项](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/utils/cli/src/shared_options.rs)、[配置 schema](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/config.schema.json) 与 [feature 定义](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/features/src/lib.rs)。真实 CLI 接受这些组合及运行时工具禁用效果尚未实测，不能把静态核对当作模型沙箱验收。

执行父进程若带 OPENCONTEXT_OWNER_TOKEN 或 OPENCONTEXT_QUERY_TOKEN 即拒绝。子进程仅继承 PATH 和固定私有 HOME/CODEX_HOME/TMPDIR/locale；不传入 API key、NODE_OPTIONS 或服务器 token。PATH 指向的 Codex 必须可信；版本输出不是二进制签名。引导提示与证据分开组装，但提示文字不是权限边界。原生进程仍受当前用户 OS 权限约束，此适配器不是恶意可执行程序的 OS 沙箱，也不保证阻止恶意二进制访问其他同用户文件。

任务上限 4 MiB，逐消息核对规范化 contentHash；inputHash 保持服务端固定身份，提交时比对完整权威任务。响应上限 1 MiB，沿用 TypeBox，候选最多 200 项且每项 16 KiB，核验引用、行号、重复槽位和非空 Markdown。只接收 schema/output 两个尝试文件，符号链接、额外产物及未知字段拒绝。stdout 限 1 MiB，stderr 限 64 KiB 并全部丢弃，只返回白名单错误码；模型执行限 120 秒、版本检查另限 5 秒，超时/取消对 POSIX 进程组 TERM 后 200ms KILL。

`cancel JOB_DIR` 请求取消当前尝试；运行状态在进程停止后变为 cancelled。取消与完成使用同一原子状态锁：完成已占锁时取消返回 RESOURCE_BUSY，已完成则 POLICY_DENIED，不能据失败的取消命令推断任务已取消。SIGINT/SIGTERM 同样停止当前尝试。独立 setsid 后代、父进程被 SIGKILL、物理断电及恶意文件竞争没有 OS 级保障；遗留锁不会自动强拆，应确认进程已退出后重新 prepare 新任务目录。临时 job 含任务及候选，操作员应在工作结束后按私有数据策略清理，不属于服务器联合备份。

合成回归入口 `pnpm demo:session-worker`：fake executable → 固定响应 → 独立提交 → 人工审核门禁。完整 worker 测试还覆盖超时、取消/完成竞争、手动重试、幂等缓存、退出码、stderr 清除、大小/schema/hash/路径拒绝和迟到响应。当前只验证 Linux；Windows 明确拒绝，macOS 未运行验收。0.161.0 JSONL 现支持成对文本工具和有限压缩摘要证据，继承/分页及复杂压缩状态仍拒绝，见 [准确矩阵](SESSION_JSONL_ASSESSMENT.md)。
