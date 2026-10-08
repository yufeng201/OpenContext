# OpenContext 技术方案

状态：完整目标方案；已实现范围与验证以[实施状态](IMPLEMENTATION_STATUS.md)为准，不代表本方案全部落地。日期：2026-09-30。配套：[PRD](PRD.md)、[实施蓝图](IMPLEMENTATION_BLUEPRINT.md)、[用户使用闭环](USER_JOURNEYS.md)。原始快照另存工作区且不作修改，主方案及新增工程指南独立可读。RF、AC编号和P0–P3、Q1–Q6以PRD为准。

## 1. 推荐架构与技术选型

已确认：用户自托管服务器是权威节点，正式 Web 后台负责配置与管理，Local Companion 在用户电脑采集或加工。单机 all-in-one 仅用于开发，不作为正式产品的纯本地主架构。本轮工程默认按[ADR 0001](adr/0001-engineering-baseline.md)采用；产品协议仍须实现验证，不代表功能已交付。

首版主语言推荐 **TypeScript，运行时 Node.js 支持中的 LTS**；控制服务、本地 Companion、CLI、插件 SDK 和 Web 共用类型及 schema。Python 仅是可选处理插件语言；Go 作为未来分发/CPU 需求的对比，不默认引入第三栈。

| 维度 | TypeScript / Node.js | Python | Go |
| --- | --- | --- | --- |
| 生态与插件门槛 | 与用户现有背景一致，Web/MCP/CLI 共用契约；插件作者可从单个 TS 包开始 | 文档/模型处理生态适合专用 processor；另维护环境与跨语言契约 | 网络/系统工具适合，但首版增加语言与 SDK 成本 |
| 文件与子进程 | 异步文件/网络、spawn 和流处理适合连接/调度；不用 shell 拼接输入 | subprocess 与文件处理可行，模型插件较自然 | 标准库覆盖良好，进程监管仍需平台差异处理 |
| 并发与 CPU | Node 可以并发异步 I/O和多个子进程；CPU 重活用 worker_threads/独立进程，不能阻塞事件循环 | I/O 可异步或线程；CPU/原生库依具体实现分进程 | goroutine 便于并发，多核计算仍需资源预算 |
| 安装/跨平台 | npm 分发便捷，但要求 Node；SQLite native addon 要检查预编译包与 ABI | 虚拟环境和原生依赖更复杂，作为可选插件隔离 | 常见场景可分发单二进制，CGO/系统依赖会改变复杂度 |

选择 TS 的依据是契约共享和开发门槛，不是 Node 有独特的文件系统能力。推荐把大文件 hash、解析、向量扫描放到受限 worker 池；CLI 子进程独立监管。[Node 线程说明](https://nodejs.org/api/worker_threads.html)。

### 首版目标组合（实际切片差异见实施状态）

| 层 | 首版建议 | 取舍与演进 |
| --- | --- | --- |
| API / Web 服务 | Fastify REST + JSON Schema 验证；SSE 传进度；同服务托管静态 Web | 不同时引入 GraphQL/另一个 BFF；SDK 与 API 共用契约 |
| Web | React/TS/Vite、Tailwind/shadcn、React Router、TanStack Query、RHF；React局部状态，Zustand按需 | TypeBox/JSON Schema统一契约，不另建Zod模型；[前端架构](FRONTEND_ARCHITECTURE.md)与[UI规范](UI_GUIDELINES.md)规定缓存、权限、版本与状态反馈 |
| 工程 | pnpm workspace、TypeScript strict、tsc；Web 用 Vite 构建 | 暂不加 Nx/Turbo；运行时、构建器、包版本以开发开始时的官方兼容信息锁定 |
| 配置/schema | JSON 配置 + JSON Schema；TypeBox 描述共享契约，Fastify/Ajv 校验 | 配置版本和非秘密配置 hash 随任务固定；secret 只保存引用 |
| 内容 | 服务器本地持久卷上的普通文件、不可变 blob 和 commit 清单 | 逻辑路径与物理 blob 分离，用户能导出当前目录；二进制无需 Git |
| 状态/metadata | SQLite + better-sqlite3，单服务串行短写事务、WAL | 本机磁盘，不共享到 NFS；服务器只有一个发布权威；测量后 P2 可整体迁移 PostgreSQL |
| 全文/向量 | 官方 indexer/retriever 插件通过受控索引port使用同一 SQLite FTS5/chunk/vector；worker池做精确扫描 | 统一插件接口可替换算法，SQLite驱动归内核；实验规模基线，P2根据规模考虑 PostgreSQL/pgvector |
| embedding | 独立 HTTP provider 接口，绑定 endpoint/model/dimensions/version | 可接本地或远程服务；不推断与 Agent CLI 共用模型/额度；不可用时向量降级 |
| 队列/调度 | 同一 SQLite 的 runs、attempts、outbox、schedule 表；runs 承担逻辑 jobs 队列，定期领取 | 不先加 Redis/Kafka；定时与事件持久化，至少一次执行 |
| 插件 | 全部功能能力共用manifest、probe/invoke/cancel、JSON-RPC/Schema；首版装配官方插件 | stdout仅协议、stderr日志；插件只经受限host ports提案/查询，子进程不是安全沙箱 |
| 日志/测试/发布 | Pino 脱敏结构化日志；Vitest 契约/单元，Playwright Web；npm 包 + server Docker image | 业务测试工具按模块实现时安装；本轮Node内置runner仅测harness，不能替代应用验收；供应链发布机制P2完善 |

官方能力参考：[Fastify 校验](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[pnpm workspace](https://pnpm.io/workspaces)、[Vite](https://vite.dev/guide/)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、[SQLite FTS5](https://www.sqlite.org/fts5.html)、[pgvector](https://github.com/pgvector/pgvector)。版本、预编译目标和依赖许可证在实际锁版时再次核对；本文不指定补丁版本或项目许可证。

### SQLite 与 PostgreSQL 的决策边界

保留单节点 SQLite 首版建议：多台 Companion 通过 API 访问一个服务器，并不需要多台机器共享数据库文件。一个发布 writer、短事务、有限索引批次可以显著减少自托管部署与备份成本；WAL 允许读者与 writer 协作，但仍只有一个 writer。所有 DB 写入由 server 内的专用写入队列/线程串行完成，模型、上传、hash、检索计算不持有写事务；计算 worker 不能自行打开写连接。初始化启用 foreign_keys、WAL、synchronous=FULL 及有界 busy_timeout。磁盘须为本机持久卷，不用网络共享文件系统。[SQLite WAL](https://www.sqlite.org/wal.html)

PostgreSQL/pgvector 是后续候选，适用于多 server 副本/高可用、持续写竞争或扫描型向量查询已超预算的情况，不因“多设备”直接引入。P1 用合成数据记录 busy 比例、写队列等待、索引积压、向量扫描耗时与内存；达到用户定义的容量目标后再决定迁移。迁移保留 file/revision/commit ID，先停写导出并核对控制状态，再切换一个权威后端和重建索引；不做首版 SQLite/PG 双写。

### 最小正式部署

```text
用户服务器：TLS reverse proxy → OpenContext server（API + Web + scheduler + server plugin host）
                              ├─ 持久内容卷
                              └─ SQLite 状态/索引卷
用户电脑 A/B：Local Companion ──出站 HTTPS──→ server
              ├─ session/local connector
              ├─ 受限输入缓存与 staging
              └─ 本机已有 Codex / Claude CLI（需要时调用）
```

建议 Compose 两个服务：OpenContext 与 TLS 代理（例如 Caddy）；不部署外部数据库或队列。Node 和构建结果拟封装进 server image；Companion 首版拟以 npm 包分发并要求兼容 Node。embedding endpoint、coding CLI、Python/视频工具按插件启用，是可选依赖。用户不需要把本地 CLI 安装到服务器，也不暴露电脑入站端口。

上述镜像/npm分发是拟议形态，当前没有可用发布物。首版目标Linux x86_64单server、本机持久磁盘；其他架构/OS按兼容矩阵验证。只查询用户可直接连远程MCP而不安装Companion；collect与worker为独立角色。TLS/owner初始化/首文件/doctor/备份升级步骤及支持边界集中在用户使用闭环第2节，Codex云端开发容器的bootstrap另在文档导航中说明，不作为用户安装步骤。

## 2. 内容模型与持久性（RF-01、RF-08、RF-11）

OpenContext 提供**受管理的版本化文件库**，不是把任意普通目录自动当作完整系统。正文、不可变revision/commit清单保存内容、身份、历史与血缘证据；数据库保存权威head和控制状态。仅余完整blob/manifest可核对内容及已记录版本关系，但不能安全推断哪个head获批准、当前授权、设备、游标或回执。数据库丢失时必须从配套备份恢复，不能按文件mtime或最新manifest猜测授权。必须分别持久化：

| 数据 | 性质 | 恢复边界 |
| --- | --- | --- |
| 原始/派生内容 blob、来源记录、revision、commit 清单 | 不可丢的持久内容与出处 | 备份、校验 hash；可生成当前文件树 |
| head、ACL/撤权、设备授权、游标、run/attempt、fencing counter、外部发布回执 | 不可丢的控制/运行状态 | 状态库备份恢复；不能从正文安全猜测或重建 |
| 凭据 | OS keychain/secret store 中的秘密 | 独立保管/恢复或重新授权；不进入共享文件空间 |
| 全文/向量索引、目录摘要（未人工编辑）、路径缓存 | 可派生数据 | 从精确内容版本及配置重建；摘要重新生成不保证字节相同 |
| staging、临时缓存、脱敏日志 | 有保留周期的运行文件 | 未发布产物可清理；人工冲突候选按策略保留，不能静默丢弃 |

`fileId` 是随机稳定 ID；`logicalPath` 是相对 Space 根的规范 UTF-8 路径，拒绝 `..`、绝对路径、符号链接逃逸，规定大小写/Unicode碰撞策略。rename 保留 ID；复制产生新 ID；无法可靠识别 rename 时按 delete+create 记录，不以 hash 相同强认同一文件。

`revisionId` 不可变，绑定实际存储字节的 `contentHash`、size/MIME、sourceRef、外部版本、作者类型及 `derivedFrom[{fileId,revisionId}]`。SHA-256 对未转换的已接收字节计算；换行转换、解析或脱敏均产生独立文件/revision，不能沿用原 hash。通过摄入政策的二进制原件按精确字节保留，解析文本是独立派生文件，索引不直接读取巨大视频。同 hash 可复用同 Space 内 blob，但 file ID、权限与来源不合并；拒绝跨 Space hash 存在性探测。来源 URL、外部 ID 也是敏感元数据，不能全量送 embedding。

binding 使用稳定 ID 和 Space 内唯一 `pathAlias`。逻辑路径采用 `sources/<pathAlias>/<relativePath>` 或 `derived/<pathAlias>/<relativePath>`；例如 source alias=sessions、processor alias=experience，得到 `sources/sessions/a.jsonl` 与 `derived/experience/retry.md`。插件 manifest 的输入/输出范围相对 binding 的挂载根表达，由 host 解析到固定 binding ID 与根；alias 更改是保留 file ID 的受控批量 rename，不能改变权限。已发布 revision 保存 path-at-commit，不随 alias 变化重写。

commit 是不可变清单，首版建议完整列出 snapshot 的 fileId→revision/path/tombstone；同时绑定 parent commit、kind、作者、causation、配置引用。清单引用精确 blob，当前 head 是控制库中的可变指针；导出的 head 文件只是镜像。不是每次 append 都发布 commit，也不是 Git 的硬依赖。

创建 Space 先持久化空 manifest，再在创建事务中建立初始 commit/head；对外可用的 Space 总有有效 head，空同步批次也能返回当前 commit。序列化 manifest 的 canonical JSON 规则与 schemaVersion 固定，hash 对实际存储字节计算；commit ID 与 manifest hash 分开，不把对象是否存在等同于是否已发布。

目录 `.context/summary.md` 和 `overview.md` 是派生 sidecar，记录覆盖的 commit、输入 revisions、生成器版本与 freshness。它们参与版本和权限管理但不反馈到同一生成器。用户编辑后应提升/锁定为人工维护；不能把“索引存在”当成“摘要内容新鲜”。

软删除产生 tombstone 并排除当前召回，历史可保留但每次读取都按当前 ACL 校验。权限撤销首先使 gate 立即拒绝查询/下载/运行/发布，再异步清索引、摘要与缓存；混合来源派生文件继承来源权限交集，放宽权限需独立审查。离线机器已获得副本无法承诺即时擦除。

## 3. 摄入、事件与发布生命周期（RF-03、RF-04）

推荐生命周期：source connector 拉取 → 暂存写入 → 内容校验 → source commit 发布 → outbox 事件 → processor Run → staging → 校验 → derived commit → 索引更新。每个环节有独立成功状态。

内部发布分为不可变对象落盘与 DB 可见性两个阶段：

1. 在目标对象所在文件系统写唯一临时文件，流式计算 size/hash；校验完成后 fsync 文件。校验已存在目标与预期一致，不覆盖既有内容；以原子 rename 安装新对象并 fsync 父目录（新建目录也须持久化其父目录项）。blob → revision → manifest 依次完成持久化，记录 in-flight pin。跨盘 staging 必须先复制到目标盘临时文件，不把跨盘 rename 当原子操作。目标存储若无法提供要求的 durability，不能确认发布成功。
2. 以 `BEGIN IMMEDIATE` 获取短写事务；查幂等回执、有效身份、incarnation/lease/fence、取消状态、当前 ACL、输入依赖与输出 base/所有权。事务内条件更新 head，原子写可见 commit、当前 file catalog、发布回执、run 状态、source 去重记录及 cursor、outbox。任何条件失败均 ROLLBACK；COMMIT 成功才 durableAck。文件写入与模型调用均在事务外。[SQLite 事务](https://www.sqlite.org/lang_transaction.html)
3. DB 是可见性边界。提交前崩溃只留下受 pin/保留期保护的不可达对象；提交后通知失败由 outbox 重试。SQLite outbox 同时承担持久事件 journal，不另设权威文件 journal；普通日志不能代替回执。投影与 refs 异步更新且仅用于浏览，API 从 manifest/head 读一致快照。

whole-head CAS 失败不等于模型失败。若 head 仅有无关变动，读取新 head，重新校验全部输入 revision、目录成员摘要（防漏掉新增/删除输入）、输出 file ID/base/path/ownership/output slot 和授权；在事务外把原候选合入新 snapshot，持久化新 manifest，再短事务重试。最多有界重组，写竞争耗尽进入 retry_wait 继续发布已有候选，不重跑模型。真实输入依赖改变才 superseded 并建立新 Run；输出被改、提升或路径冲突进入 needs_review。候选沿用同一个发布幂等键，其 payload hash 绑定输入/输出提案而不包含可重组的 expectedHead/manifest ID。

标准事件建议为 `content.committed`、`index.updated`、`access.changed`、`run.state_changed`、`external_publish.state_changed`。`content.committed` 的 `kind` 为 source/human/derived/merge/restore；source commit 不额外制造两种重复触发事件。事件带 eventId、Space序号、commit、origin、causationId、bindingId、深度。Webhook 只唤醒 connector，仍读取并比较来源版本；源版本优先于到达顺序。

增量同步按 `(bindingId, externalId, externalVersion/消息区间)` 幂等。游标与 source commit 同边界推进；外部有单调版本时忽略旧版本，只有时间戳时用 overlap 拉取、hash 对账和周期全量 reconcile。append 必须按稳定消息 ID/区间去重，不对每次 delivery 盲目追加。覆盖验证来源 base；delete/权限事件及时失效；附件下载失败不能提交伪完整快照。本地 watcher 用 debounce + 大小/mtime稳定检查 + hash，定期目录扫描补丢失事件。

来源事件使用稳定 sourceKey，传输重试沿用 batchId；同键不同 payload hash 返回 IDEMPOTENCY_MISMATCH。append 包含有序 recordId、每条字节引用及源顺序键，服务器按连接器的分帧格式合成新 blob；无法证明顺序/基线时返回 SOURCE_GAP 并 reconcile，不能按抵达时间拼接。rename/delete 携带 file ID 与 base revision，tombstone 保留外部映射以拦截迟到旧事件；新建必须声明 expectedAbsent。一个批次的全部变化和 candidateCursor 同事务发布；无内容变化也记录去重回执并在确认完批次后推进 cursor，不制造空 content.committed。Companion 先将变化和 object 上传状态写本机 SQLite outbox，收到服务器 durableAck 才在本机事务更新 cursor/清 outbox。

源变更通过持久 `derivedFrom` 反向依赖找到受影响的产物/目录摘要，标记 stale 并对受影响 binding 去重排队；删除与目录成员变化同样参与依赖判定，不只比较正文 hash。未声明完整依赖的处理器按整个输入根 snapshot digest 失效，不能声称精确增量。

Binding 选择器覆盖 sources/derived/authored，可以把前一级产物作为输入；首版配置为显式 DAG，拒绝循环、输入输出根重叠和隐含自匹配，不支持以“最大深度”代替循环证明。trigger插件只提出 RunIntent，内核按 input-set digest + recipe/config/plugin版本去重并固定快照；origin/binding/causation 是额外的重放/自触发防护。索引、进度事件不当作文件变化。定时插件解释计划，内核持久化到期/补跑状态，不由浏览器计时；内容不变且成员/元数据不变时不发布空commit。

### Binding 与文件加工链（RF-13）

Binding 只描述组合：输入选择器、trigger规则、recipe、依赖、输出集合和失败策略；执行位置、设备能力、秘密引用与硬预算只来自其引用的PluginInstance，见第5节。选择器有两类：来源/人工目录用path；前级产物用output-set，以 `(producerBinding,setKey,slotKey)→fileId` 在固定commit解析**正式版本**。正式版本就是该commit清单中fileId的已提交revision，不新增第二个“正式head”。提升保留槽与ID，即使路径移到authored，下游仍选到人工revision；复制出来的新ID不会自动取代原槽。

不可变commit保存集合版本、slot成员和文件revision的同快照关系，DB中的current集合为该head的事务状态，历史解析不套用当前slot表。挂载给recipe稳定的slot名及对应实际path/ref；path选择器按路径工作，不承诺跟随移动。选择结果仍需当前授权和fresh/valid检查，选择到不等于允许加工。成员/正式revision变化会触发下游，即使生产者binding没有再运行。

`dependsOn`约束拓扑；可运行条件是所选正式产物已经覆盖当前上游输入代次，不能只看某个Run曾成功。人工提交须生成新revision，记录reviewedAgainst当前输入refs及成员digest作为其validityInputs；derivedFrom仍保留历史证据，从而使该槽就绪；未审核最新输入的人工内容仍stale，下游等待。只要所有required选中槽就绪，未采纳的机器提案无需阻塞下游。输入挂载在同一Space commit冻结；触发合并最新代次不改变在途Run。

示例：飞书connector提交原文文件 → topic processor产出主题/结论 → spec processor同时产出PRD和技术方案 → wiki processor组装Wiki；spec还可挂载authored人工约束。所有输出走同一文件commit，均进入配置的indexer/retriever链。recipe固定prompt文本/版本、输入挂载和所需输出，CLI只是执行后端，无须自建agent loop或改server业务代码。蓝图第3节给出全部拟议插件注册项和可解析配置；这不是现成插件或已实现集成。

空输入默认blocked，optional挂载为空不算失败。`skip`只记录未执行，保留既有集合且标stale；`publish-empty`必须显式配置、上游证明snapshot完整、输出为full且允许清理、recipe没有requiredOutputs，否则拒绝。离线/权限收紧/分页未完成不能解释为权威空集合。默认失败策略保留正式集合，重试有界，不将部分输出变成下游输入。

## 4. Run、多机与本地 Agent（RF-05、RF-09）

Run 固定输入 commit/revisions、插件版本及包 digest、配置 hash、prompt模板版本、目标 base revisions、ACL epoch。输入挂到 attempt 的只读副本；所有输出在 attempt 独立 staging。job ID 与 providerSessionId 分开，不用厂商会话 ID 做平台幂等键。

采用至少一次执行语义：run 可有多个 attempts，正式发布只接受一个有效 attempt。令牌是 `(serverIncarnation, runId, attemptId, fence)`；fence 在该 Run 单调递增，以十进制字符串传输、SQLite INTEGER/驱动 BigInt 处理并检查溢出。server 每次启动（包括备份恢复）在独占启动锁内创建新 incarnation 并持久化，失效旧租约，再开放接口，避免旧备份回退 counter 后重用令牌；incarnation 不是身份凭据。claim 使用 `BEGIN IMMEDIATE` 和条件 UPDATE，受影响行数必须为1，否则回滚；心跳/提交均匹配整个令牌、当前 worker、未过期 server 时间和未取消状态。过期 worker 即使进程仍在运行也不能提交；旧结果只能在授权后成为新 review proposal，不能重贴新 token 发布。外部副作用不由租约保证幂等，另见第8节。

统一 Run 状态见 PRD。短暂失败进入 retry_wait，指数退避与抖动、最大次数；SQLite busy 先 rollback、短暂有界重试，不占着事务等待设备或网络；缺鉴权/设备/capability 为 blocked；输出冲突为 needs_review；真实输入变化使候选 superseded 并另建固定新输入的 Run。不同任务对同一路径仍依赖 base CAS，不仅靠 token。取消在 DB 先标 cancelled、撤销 active attempt，随后通知 supervisor 中断进程树；因此即便进程未及时停止也不能发布。审核状态不保持执行租约，保存受 pin 保护的候选；接受审核由单独授权 human/merge 操作重新检查当前 base。

Local Companion 仅出站 HTTPS 拉任务/发送心跳，SSE 为通知优化，持久任务查询才是可靠来源。断连能浏览已授权缓存并采集待上传来源；本机未确认的 commit 只能叫 pending change。重连先更新 ACL/设备状态、对账 head与游标，再上传幂等变化；服务器才决定权威 commit。撤权设备不能继续领取或发布。缓存包含私有内容，需要本机访问控制及保留周期。

适配器建议统一 `probe → start → events → cancel → result`，`spawn(binary,args,{shell:false,cwd})`；stdin 传任务，stdout 解析结构化事件，stderr bounded且脱敏；超时终止整个进程树，处理 EOF、无效 JSON、权限交互和非零退出。遇到批准/登录要求进入 blocked，不自动点击批准、不生成新凭据。

每 attempt 固定 wallTime、输出字节、进程数/内存等可强制限额与模型预算。可用 provider token/cost 上限需 probe；不支持硬预算的 CLI 明确显示估算，要求硬费用上限的任务应 blocked。取消先调用适配器 interrupt，再在宽限期后终止进程树；不把退出码0当作有效输出，仍验证 schema/hash。设备离线不自动切换云端模型；可缓存已授权输入继续离线文件处理，但模型网络与执行租约可用性分别判断。

原作者设备记录为 Codex 0.151.0、Claude 2.1.280 help；这是历史核实记录，不能当作当前云端安装。当前云端只读检查为 codex-cli 0.159.0-alpha.3，`exec --help` 提供 `--json`/输出 schema；未发现 Claude CLI，也未执行任何模型任务。引用的 Codex 固定提交 SDK 使用 `--experimental-json`，再次说明适配器必须本机 capability probe 并以兼容矩阵锁定生产版本，不能默认推广云端 alpha 版本。[Codex SDK 源码](https://github.com/openai/codex/blob/9ef9cb1d9fc6013f6c1994346e0ee93ad9e6f986/sdk/typescript/src/exec.ts)、[Claude 非交互](https://code.claude.com/docs/en/headless)。

Claude 当前官方文档说明 `--bare` 不读取订阅 OAuth/keychain，需要支持的 API/provider 鉴权；不能为了复用订阅就默认推荐 bare。SDK文档对第三方使用 claude.ai 登录/额度也有明确边界。首版须分别验证“调用用户本机 CLI”与“产品集成 SDK”的支持路径，不承诺额度复用。[Claude SDK](https://code.claude.com/docs/en/agent-sdk/overview)。

## 5. 插件边界与安全（RF-06、RF-10）

统一采用三层配置：PackageRegistration声明精确包版本、能力、entry和支持位置；PluginInstance以不可变`id@revision`保存该包的配置/schema、secretRef、execution、grantRef和budgetRef；Binding或检索pipeline只引用实例，不能再覆盖这些字段。八类能力均如此，trigger也引用实例，publisher可注册但默认不启用。recipe只保留任务prompt/输出要求，不再另存CLI adapter；adapter属于processor实例配置。

启用时校验包manifest、配置schema、能力、位置/隔离、网络/secret授权和预算，记录resolved package digest、instance配置hash及grant版本的ExecutionLock。Run、索引generation和查询各自固定完整调用链的锁；当前撤权仍即时约束旧锁。整份配置按规范化hash保存不可变快照；schemaVersion只表示结构版本。budget/grant引用解析到该快照的定义及版本，旧锁不读取被原地覆盖的配置；新的配置需重新预检，当前授权和预算收紧仍可使旧执行停止。升级创建新实例revision，经预检后CAS切换引用；不原地改旧配置。embedding/model/dimensions或indexer配置变化建立新generation，完成coverage后才切换；retriever/assembler变化不必重算内容，但查询固定一个pipeline版本。迁移失败保留旧引用，旧Run仍用旧锁且不能绕过最新授权。

蓝图提供同一包的embedding实例替换和权限拒绝实例。绑定选择的是实例，不存在另一份Binding placement/secret/budget事实源；请求token预算与任务额度只可进一步收窄实例上限。

内核不可替换部分是 file/revision身份、snapshot/CAS、当前授权、事件/任务/租约持久化、对象上传与内部commit gate。功能插件经同一个 `invoke(capability,input,grant)` 接口工作，官方插件与未来第三方插件遵守同一契约；首版可只允许owner安装经审核的官方包，不需要市场。UNSUPPORTED_CAPABILITY只表示未知协议能力或该包没有声明/实现所请求能力，不能把indexer/retriever等既定核心能力整体排除。

| 能力 | 最小输入→输出 | 首版官方装配 / 内核边界 |
| --- | --- | --- |
| connector | 配置、游标→Change批次、candidateCursor | session/repo/feishu；只提来源变化，游标与commit由内核确认 |
| trigger | 持久事件或到期tick、Binding→RunIntent/幂等eventKey | manual/commit/schedule/webhook；内核去重、解析依赖并持久排队 |
| processor | 固定SnapshotMounts、recipe、目标集合base→OutputSetManifest | CLI recipe、解析、主题/规格/Wiki；输出只是整批提案 |
| indexer | 固定文件版本、索引配置/代次→IndexBatch与coverage | 文本切块、FTS/vector；host校验后写受控索引port，插件无DB句柄 |
| retriever | query、授权snapshot/索引句柄、limit→带出处的候选 | FTS/vector/grep/hybrid；host限制可查集合并复查ACL/revision |
| context-assembler | 已验候选、token预算→有出处的有序片段/摘要计划 | 渐进披露；host实际读取、计数、过滤，模型新摘要须标派生 |
| embedding | 文本对象 + 实例中的model/dimensions→向量/usage | HTTP provider独立配置，网络/费用按授权和预算控制 |
| publisher | 已提交artifact snapshot、target、幂等键→外部回执 | 可选static-site等；默认未启用，unknown按RF-12对账；不取代内部commit |

这些算法接口不意味着SQLite驱动、网络传输或每个工具函数也要插件化。插件使用host发放的授权对象/索引句柄，不能传SQL、任意路径或绕过预算。indexer只写其隔离的generation命名空间；retriever只能查询host给定的授权revision集合，且返回结果仍会重验。官方插件可以随server镜像装配，但调用和结果gate不因“官方”省略。只替换插件实例及其引用即可换功能实现，core不认识“经验/PRD/Wiki”等场景名称。

权限声明只有授权意图；host 在文件 API、任务 API、凭据代理与网络代理边界执行检查。普通 native 子进程仍可能绕开 host 直接读取主机文件。无 OS 强制隔离时只允许管理员信任的插件，并如实标注可信执行；不是因为有 manifest 或 stdio 就变成沙箱。

本地 Codex/Claude 是用户身份下的原生程序。CLI工具权限/沙箱只对其实际覆盖的工具路径有效，用户配置、hooks、MCP、shell和网络能力都需 probe并限制。单独 cwd 不是磁盘隔离；allowTools 不是 OS 网络隔离；不同 OS 保证不同。强隔离任务需要专用 OS用户/容器或支持的 OS沙箱，限定只读输入、可写 staging、资源和网络。无可验证隔离能力就阻止这类任务；不能悄悄降级到 unrestricted。

凭据留在服务器 secret store 或设备 keychain；配置只有 opaque secretRef。执行只注入必要秘密，不继承完整环境。provider CLI 自身的鉴权目录按厂商支持方式留在本机且不上传。session 默认只采集授权路径，排除凭据目录和已知密钥文件，不能扫描整个 home。设备上执行 upload 前检查，服务器执行发布前复查；秘密检测是风险控制而非检测完整性的保证。

“保留 raw”指通过摄入政策的精确字节，不能与“任意含秘密原件都进 Space”同时承诺。默认策略：已知凭据文件排除且记录非敏感排除理由；疑似秘密内容留在执行端独立 quarantine，状态 blocked，不上传、不索引、不进入 prompt。用户可选择不导入，或生成明确标记的 sanitized 派生文件再导入；原件留在本地/连接器隔离区，普通内容目录不保存 secret 原文。sanitized 文件的 contentHash 仅覆盖脱敏后实际字节，provenance 记录变换版本、来源标识和 redacted 标志；原始 hash 只在获准的私有隔离记录中保留。发现已发布遗漏时立即撤销相关读取、暂停衍生与索引并隔离处理，不依赖“以后索引重建”。

把来源内容视为不可信数据：不能执行仓库/网页中要求安装插件、读取密钥或外部发布的指令。受控工作目录不加载来源中的 hooks/config/AGENTS 作为平台授权；模型输出必须经路径、schema、大小、来源与权限校验。仅 prompt 指示无法保证阻止 injection，权限隔离和发布 gate 是实际边界。provider 数据离机范围由配置显示并限制，本地进程不代表内容不上传模型服务。

### 单 owner 认证与设备最小模型

P1 为单 owner 自托管实例，不做匿名内容服务或多人角色管理。首次部署仅通过服务器本地管理命令设置 owner 密码，保存抗暴力猜测的密码散列；本轮不生成任何凭据。Web 登录建立可撤销的服务器 session，cookie 为 HttpOnly/Secure/SameSite，设置空闲和绝对过期；所有状态变更校验 CSRF token 与 Origin，登录和配对限流，同源 Web 默认不开放跨域。

API/远程 MCP/CLI 使用独立 opaque bearer token，经 owner 显式发放、限定 Space/读写/执行 scope/有效期，服务器只保存 token hash。Web session 不下发给插件，token 不放 URL 或日志。设备通过已登录 Web 产生短时一次性配对码，用户在 Companion 输入并确认授权根/能力；消费配对码后获得只存本机 keychain 的设备 token，服务端只存散列与设备 scope，可单独撤销。配对/授权能力是方案，不是本轮执行。

每次 claim、heartbeat、object 上传/下载、result、tree/read/search 和 SSE 订阅都检查身份、scope 和当前 ACL；SSE 不能绕过撤权。鉴权失败401，越权统一403或为防存在性泄露返回404。设备能提交的只有授权 binding/attempt，不能凭 owner 的单人身份推导全盘读取权。native 插件必须报告可强制的隔离能力；无对应保证则拒领需要该隔离的任务。管理员显式允许的 trusted_native 只适用不要求强隔离的任务，UI 展示可访问宿主资源的真实边界。

## 6. 人工编辑与冲突（RF-08）

文件所有权建议 `source_managed / generated / human_owned`。`files/` 仅为只读浏览投影，自动投影 writer 无权刷新 `working-copies/`；Web 编辑器和本机编辑器都基于固定 revision 创建独立可写副本及 base 元数据。禁止可编辑副本或可编辑导出硬链接到不可变 blob；只读投影也采用独立复制/受控快照，不依赖“用户不会 chmod”。投影按 commit 建新只读目录后切指针，读取时携带投影的 commit；API 仍以 manifest 为准。直接修改只读投影属于不受支持操作，权限应拒绝；不能靠 watcher 抢在异步刷新前拯救人工编辑。工作副本 watcher 仅辅助自动保存，停止 watcher 也不会让发布器覆盖草稿。

“提升到 authored”使用同一 file ID：原子提交新 revision、rename、human_owned 与输出槽 proposal_only。输出槽以 `(bindingId, setKey, slotKey)` 指向 file ID，逻辑路径不是生成器的新建依据；升级/运行中的 binding 不可绕过这个控制状态，以旧 derived 路径再建同槽文件。generated 自动发布仅适用于仍为 auto 模式、base 未变的槽；提升后处理器可提出 review，不能改人工正文。用户若选择“复制”则新 ID，与提升区分，不声称原文件因此受保护。对 source 文件，首版编辑以独立 authored 副本保留来源，连接器继续管理源；不把源同步偷偷改成人工编辑。

发布同时校验 input freshness 与 output base/owner/slot；无关 head 变化按第3节重组，真实依赖变化为 superseded，人工/同目标变化为 needs_review。保存 base/current/proposed 及 review pin；人工接受时重新校验当前版本和权限，合并形成新 commit。首版不实现多主自动合并；设备离线 edits 是 pending changes，服务器 CAS 决定是否可发布。保存 working copy 不等于提交，Web 明确提示草稿、本地待传和服务器已提交三种状态。

### 纠正、取代与撤销（RF-08/19）

人工身份不自动提高事实可信度。首版以owner审核的Relation记录“此项目中，这份确切revision纠正/取代那份确切revision”：scope为同一Space/project，target与replacement都是完整InputRef，附reason；不跨项目、不使用模糊主题或通配符。`corrects`必须一同呈现纠正和原证据；`supersedes`把旧revision移出默认主结果，提供“查看被取代证据”，原件不删除。只支持整文件关系，局部纠错应生成只讨论该争议的文件并解释范围；不假装已做段落级裁决。

关系激活/撤销走owner授权、expected relationVersion和当前refs/ACL检查，与审计/outbox在同一短事务提交。每个scope+target最多一个active关系；竞争提案进入needs_review，不能最后写入者获胜。首版禁止链/环：一个文件不可同时成为active关系的target与replacement；多份原件可各自明确关联同一纠正文件。复制源文件仅保留derivedFrom，不自动建立关系。纠正文件继承其引用来源的授权约束，撤销关系不能删除这些血缘限制。

关系只作用于请求snapshot中的确切revision，两端及其来源依赖必须当前可读、fresh/valid，配置scope匹配；任一内容更新、删除、权限验证到期或撤权则关系不生效。上游更新令纠正文件stale并进入复核；新source revision不继承旧关系。撤权gate先拒绝相应文件及其依赖产物，绝不因关系失效恢复泄露。显式撤销关系不删文件；随后在各自仍授权/有效时恢复普通候选，继续保留不可变引用和审核记录。

召回先做权限/version/freshness gate，再在命中的任一端补齐有效关系的另一端，最后排序/预算；与纠正有关的两份引用作为一组计费，预算不足返回“需展开”引用组或省略整组，不能截断为裸旧结论。呈现relation ID/version、类型、理由、两端revision/hash及scope，不用模型自动改写原始事实。普通用户看不到无权关系或两端元数据；read旧证据也按当前关系/权限返回纠正提示，避免直接引用绕开。激活关系不改正文，SQLite关系状态/审计是完整备份的一部分，可导出关系清单用于人工查看，但不能靠该导出恢复当前授权。

### 产物集合生命周期（RF-14）

每个Binding拥有命名 `setKey`，内核持久保存集合版本与 `(bindingId,setKey,slotKey)→fileId`。Run固定baseSetVersion及每个受管成员的base；slotKey来自稳定业务实体（如repo模块ID），不是每次生成的文件名。OutputSetManifest必须声明成功且完整，携带固定inputCommit，使用以下两种互斥模式：

- `delta`：只执行明确的put/rename/delete；没有出现的slot一律保留。delete须携带existing base并具有该集合的delete权限，不能用“输出目录没看到”推断删除。
- `full`：列出期望保留的完整集合（put/keep/rename），不含隐式全目录删除。只有Binding明确 `allowDelete=true`与`missingPolicy=tombstone-owned`、输入完整、覆盖的是整个命名集合且complete=true时，才对“起始集合中仍由该binding自动管理且base未变的缺失slot”生成tombstone。默认missingPolicy=retain。人工提升的protected slot不属于可自动清理集合，省略时保留并记录retainedProtected；显式修改/删除/rename该slot则整批needs_review。

已有slot的put只改内容，rename只改路径并保留file ID/slot；同一批每slot最多一个操作。需要改名且改正文时分两次提交或以后扩展显式复合操作，不用delete+create冒充rename。目标路径碰撞、新增slot的expectedAbsent、修改base、集合成员版本、fence/ACL均参与同一publish gate；集合CAS防止并发新成员被full误删。成功才以一个commit安装全部修订、tombstone、集合版本和outbox；任何无效对象、部分结果或失败都不改变正式集合。内核返回applied/retainedProtected供UI审查，保护决定也写进发布回执。

代码模块消失后，Repo Wiki官方recipe在完整repo快照上输出full清单，缺失的自动页面被tombstone；资源从`assets/logo.svg`改名到`assets/brand.svg`用同slot rename，旧路径退出当前tree，历史引用仍可解释。源变化后先将旧产物标stale，依赖删除标invalid：默认当前召回排除invalid/tombstone，stale仅在请求允许时返回并显式标注；人工保留文档也须说明其出处过期。历史读取仍受当前ACL与请求snapshot约束，索引物理删除可异步，不能让旧结果永远留在当前召回。

## 7. 检索与渐进披露（RF-07）

上下文/记忆派生正文以 Markdown 为主；原件、附件、结构化元数据和可重建索引保持适当格式，不将这条约束扩大为网站/视频等产物的禁令。现有固定版本行/章节/字节预算读取已实现，详见[当前渐进披露契约](PROGRESSIVE_CONTEXT.md)；本节其余上下文组装及摘要能力仍为目标。

建议将当前可读 snapshot 的文本切 chunk，索引键为 `(fileId,revisionId,chunkId,indexConfigVersion)`；保留 byte/line范围、来源、权限引用、heading 与 MIME。embedding key 包含模型、维度、预处理版本和内容hash，不同配置不可混用。

检索先固定 `requestedCommit`（缺省在请求开始解析 head），随后权限/路径过滤 → FTS5、向量、grep 独立候选 → 对该 snapshot 校验 revision → RRF → 可选 rerank → 去重与预算裁剪。新 head 到来不改变本次 servedCommit；索引键中的 revision 必须等于请求清单中的 revision，不能用当前 head 的版本取代。grep 只扫描授权 snapshot 的文本对象，限制文件数/字节/耗时，截断显式报告，不向任意主机路径运行 shell。

首版仅维护当前索引 generation。请求开始时已是历史 commit 的 tree/read/grep 受支持，历史 FTS/vector 明确返回 HISTORICAL_MODE_UNSUPPORTED；`allowDegraded=true` 才可回退 grep 并报告实际模式。请求开始固定的是当前 generation 时，允许 pin 该 generation 完成本次查询，即使其间 head 改变。当前索引覆盖不足可返回可验证子集并标 partial，或预算内补 grep；不伪装完整语义覆盖。响应含 servedCommit、generation、各模式 coveredSeq/missingFiles、degraded/reason、truncated 和 tokenUsage。

当前 ACL 在所有输出前复查，覆盖文件名、目录导航、summary、count、snippet、citation 与正文，不只 read API。混合来源摘要仅在所有依赖均获授权且未撤权时可返回，否则省略或从可见子集重建。检索捕获 aclEpoch，响应序列化前短事务确认 epoch 和各候选授权；变化则重新过滤/重算 count 或有界重试。这个 gate 是读取的授权线性化点，之后发生撤权不能收回已发送字节；长流式读取每批复查，离线副本局限同 RF-10。

freshness与检索模式是两个独立参数：`freshnessPolicy=current_only`（默认）仅返回fresh；`include_stale`可返回仍有效/获授权的旧产物，并附基于的输入版本、最新来源引用、等待原因和恢复动作。`allowDegraded`只决定vector/FTS失败或历史请求能否降为grep，不能放宽freshness。invalid、tombstone、撤权或权限验证过期在两种策略下均拒绝；current_only不意味着必须有向量。授权递归检查完整来源血缘；freshness递归检查各revision的validityInputs及成员digest，不能等异步重建完成才阻断失效后代。

read与search使用同一freshness策略；search返回stale引用后，read也须显式include_stale并重新gate，不把它重新标成fresh。历史snapshot的版本有效性仍按该snapshot解释，但当前授权和来源撤权独立生效；include_stale不能恢复在请求snapshot中invalid的产物。诊断只对已获管理权限的来源/任务提供latestSource/pendingRun/device状态，不泄露受限存在性。源更新而local worker离线时，原文的新commit仍能全文/grep；旧Wiki默认隐藏，可显式带过期标志读取；设备恢复后校验租约、输入和人工保护再提交，不能发布断连前的旧结果。

索引插件使用的 generation 由内核记录 Space、configHash、targetCommit、coveredSeq、status。解析/embedding 在事务外完成；每个经校验的有限批次由host在短事务原子写 chunks、FTS、vectors、per-file coverage 和该批回执。仅当前连续已处理事件前缀推进 consumer cursor，失败事件阻止完整水位前移，可单独记录 partial。构建新 generation 时先 pin 目标 commit 和 outbox 起点；完成基线后按序补事件，再在短事务检查 coverage/目标版本并切 active_generation 与 cursor。旧 generation 等所有读者解除 pin 后回收，失败构建不切指针；向量未完成不宣称 ready。索引消费不可再次制造 content.committed，防止闭环触发。

同一 active generation 增量更新也不提前删除已有读者固定 revision 的 chunks；新 revision 追加索引行，当前候选由 manifest gate 排除旧版。请求经 writer 的一个短事务固定 servedCommit、generation 与 coverage 并登记 reader pin，随后在只读连接查询，不能把登记 pin 的写入混称为只读事务。物理清理旧行须等相关读者释放，或改用新 generation。超时取消的查询释放 pin，不能无限阻止清理。删除内容不必等物理清理才生效，ACL/tombstone gate 先阻断。

渐进披露返回目录短摘要、导航和候选引用，按需读取 chunk/全文；允许全局直接命中文本，不要求递归目录搜索。目录摘要表明输入覆盖/新鲜度，缺摘要时可回退文件名与原文片段。固定引用建议 `oc://space/<spaceId>/file/<fileId>@<revisionId>` 加 commit、path-at-commit、行/字节范围与hash；历史引用仍受当前ACL控制。

token预算包括摘要、正文和出处，provider tokenizer可用时精确计数，否则标明估算；按任务请求预算，不硬承诺固定压缩比。用内容hash与来源关系去重；没有有效纠正关系的矛盾材料并列显示，不按authored目录强行裁决。有审核关系时先按第6节组成证据组，再裁剪预算。embedding故障时全文/grep仍可用，Web显示向量未覆盖。

API/MCP/CLI是三种入口，共用应用服务：概念 API 为 `GET tree/read`、`POST search/sync/runs/changes`；MCP 暴露 `context_search/context_read/context_tree`，写入工具单独授权；CLI拟用 `opencontext` 前缀，避免假定已有同名项目的 `oc` 命令可共存。接口细节在蓝图中继续细化。[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

## 8. 外部发布、备份与升级（RF-11、RF-12）

内部发布成功后，外部publisher以 `(target,binding,artifactCommit,operation)` 为稳定幂等键单独运行，持久保存attempt、请求hash和provider回执。支持远端幂等键则传递；不支持时read-before-write并对账。请求超时可能已成功，标为unknown并查询回执；无查询能力时需人工确认，不能盲目重发。数据库与外部系统不存在统一原子提交。

内容导出仅给授权snapshot的普通文件及可选引用/关系清单，可离线阅读或重新摄入；重新摄入默认新身份，不恢复任务、当前授权或设备。完整备份才用于原系统恢复：包含控制库、内容对象、清单及备份pin；秘密独立恢复。首版备份按整库处理：`control.sqlite` 同时含 control 与索引，使用 SQLite backup API 或停写并正确处理 WAL 的一致快照，不能热复制孤立 db，也不能声称只备份该文件中的 control 而自动跳过索引。[SQLite 备份](https://www.sqlite.org/backup.html) P1 建议维护窗口暂停新 claim/publish、完成在途发布，固定 backup pin，取得 DB 快照并复制其引用的 blobs/revisions/manifests；恢复后索引仍可丢弃重建。记录备份 head、对象清单/hash、schema、插件版本；完成校验才释放临时备份 pin，保留中的备份集合仍是 GC 根。

GC 只回收超过保留期、不可达且无 pin 的对象，根包括保留 commit、当前 refs、in-flight 上传/发布、活跃 Run 输入/输出、待 review 候选、未提交工作副本、备份、索引查询与构建 snapshot。发布器在对象安装前登记 pin；GC 在隔离删除/最终 unlink 前再次与 writer 协调检查，不只根据上一次 mark 扫描判断。过期 in-flight pin 须对账任务状态与宽限期后释放，不能因网络断开直接删除候选。

恢复先关闭设备流量，验证所有引用对象与 SQLite 完整性；若丢引用则停止开放服务，不回退到猜测 head。更新 server incarnation、失效所有旧 attempt/session，核对恢复时间后可能丢失的撤权；P1 默认撤销 API/设备 token、重新授权后开放远程访问，防止旧备份复活权限。索引重建后再报告 ready；外部 unknown 回执先对账，不复活旧 worker 或盲重发。备份恢复是运维切换，不允许原实例与恢复实例同时作权威 writer。

升级前停止领取新任务、完成或取消当前attempt，备份；迁移状态schema/插件config后校验，再启用服务。回滚需兼容数据库schema，不能仅换回镜像而假设所有迁移可逆。server volume与companion私有配置/缓存各自备份；不要把本机CLI凭据合入内容备份。

## 9. 评估、测试与尚未完成项

| 测试维度 | 必测情况 | 通过标准 |
| --- | --- | --- |
| sync | 重复/乱序、消息追加、rename/delete、损坏附件、游标中途失败 | 不重复正文，不跳过未发布数据，来源可追溯 |
| publish | 写blob后崩溃、事务后通知失败、两个base竞争 | 无半正式commit，outbox可恢复，只有一个CAS成功 |
| worker | 租约过期、设备断连、晚到token、取消进程树 | 过期worker不能发布，重试不产生第二正式输出 |
| human | 人改generated、提升、源更新与合并 | 不静默覆盖，候选保留，merge有出处 |
| access | 撤权后旧索引/历史读取/离线回传、派生摘要 | 服务器所有读写gate拒绝，承认离线副本局限 |
| retrieval | 中英混合、相似重复、矛盾、索引落后、预算不足 | 出处正确、固定版本、降级透明，无权限泄露 |
| ops/plugins | 备份恢复、迁移失败、协议EOF/超长消息、CLI能力不符 | 可恢复或blocked，有诊断且不自动扩权 |

记录来源延迟、队列年龄、租约拒绝数、attempt重试、冲突率、索引滞后、Recall@k/nDCG与出处正确率、token和模型成本；先基线测量再设目标，不在本文承诺吞吐或毫秒级延迟。

版本/可靠性与产品契约的判据见PRD AC-01–AC-22，用户操作与证据见UJ-01–UJ-13；对应schema、传输和事务见实施蓝图。剩余实现前事项：生成完整runtime schema及兼容测试；确认各OS的CLI隔离/auth/限额矩阵；测量中文分词和向量扫描；应用锁版核对native ABI与依赖许可证。Q1–Q6仍是待决，文档与语法检查均不等于应用故障测试通过。

## 10. 用户接入的应用服务契约（RF-15–RF-19）

**初始化与诊断。** server首次启动只提供无敏感信息的存活状态；owner由服务器控制台设置，远程向导必须登录后使用。onboarding保存完成步骤，不以“配置已填”代替“真实探测成功”。doctor每项返回status、reasonCode、checkedAt、可执行的恢复动作，来源网络检查限定在配置端点。诊断不自动发模型请求、改权限或重新授权；没有embedding时FTS/grep仍为可用服务。

**profile与项目范围。** Project是Space内的有版本路径/来源白名单，查询scope为用户确认映射、profile与当前token授权的交集；repo文本/remote只作建议。远程MCP默认profile绑定唯一project，不假设HTTP请求带可信cwd；可选stdio桥接在本机解析已确认根。缺少唯一scope返回SCOPE_REQUIRED。profile变更不更新旧token授权，需显式调整grant；客户端名称为user scope也不意味着server全库可见。

**安装事务。** 集成plan包含client/integration版本、beforeHash、拥有的配置节点与diff；apply前备份并检查hash，原子写本机配置后记录receipt。未知格式/冲突不覆盖；remove只撤销本包节点，后续人工修改以反向diff处理。配置与含秘密的备份都留本机受限目录，server只接收脱敏能力和安装状态。远程MCP首版使用独立bearer查询token；不宣称OAuth已实现。MCP/Skill/Hook配置生成器与服务端八类插件分属不同安装边界。

**采集与Hook。** session-connector内部按provider版本适配官方只读接口；文件fallback先稳态/完整记录检查，未知格式隔离。归一化HookEvent保留vendor/clientVersion/eventId/origin，command Hook只执行有界bootstrap或本机outbox入队；collector可靠性依靠游标与reconcile，不依靠Hook必达。查询、采集和worker凭据独立；模型会话origin持久关联run，默认排除回采。Hook输入不是授权来源，也不允许启动长LLM或阻止日常编码。

**来源与权限。** Git向导分别probe网络/身份/repo/分支；完整tree和最后成功SHA决定增量，webhook只是加速。飞书正式P2，文档/群聊preset分别保存binding与scope。SourceProbe区分token身份、资源访问、扫描完整性、解析支持、索引coverage；reasonCode不另造Run状态。权限重验持久保存lastAccessVerifiedAt/validUntil/accessState，可信撤权或验证到期立即使本服务read/search gate拒绝，包括派生摘要。远端变化到被检测之间存在窗口；single-owner数据域不冒充企业多员工权限映射。一次缺失或不完整扫描不形成删除。

**召回可观测性。** server记录scope、servedCommit、coverage、返回引用与预算；客户端在有证据时报告search/read调用和回答中的引用。trace把offered、tool_called、read_returned、citation_observed分开，无法观察则unknown，不断言模型内部使用。普通token不能查看未授权文件的过滤数量或存在性；owner诊断是独立管理scope。server离线、embedding失败、来源不可达和worker离线分别降级，不能自动扩大数据范围或换模型。
