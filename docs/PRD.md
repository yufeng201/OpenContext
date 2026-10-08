# OpenContext 需求文档

状态：完整产品目标设计，已有首条受限业务实现。实际覆盖、运行与测试见[实施状态](IMPLEMENTATION_STATUS.md)，不代表整个P1已完成。日期：2026-09-30。配套：[技术方案](TECHNICAL_DESIGN.md)、[实施蓝图](IMPLEMENTATION_BLUEPRINT.md)、[用户使用闭环](USER_JOURNEYS.md)。原始快照和历史checkpoint另存工作区，不属于本次主方案和工程指南交付，也不代表本版状态。

## 1. 已确认需求与设计建议

OpenContext 是 filesystem-first context platform。源文件与加工产物长期保存在统一、可维护的文件空间；人可以浏览、编辑，Agent 可以搜索、渐进读取和引用。它是受管理的版本化文件库，普通内容导出便于离线使用；完整恢复还须控制库与内容联合备份，不能从任意目录猜出授权/head。知识库、经验记忆、代码 Wiki 是插件场景，不限定唯一客户群。插件负责连接、处理、索引和召回，并可组合。

内核负责稳定文件身份、版本、权限、事件/任务持久化与发布安全 gate；连接、触发、处理、索引、召回、上下文组装和可选外部发布使用同一插件协议。首版可只交付官方插件，但这些能力的扩展接口从首版存在；没有插件市场不等于没有扩展接口。SQLite 驱动、认证和提交事务是内核实现细节，无需全部插件化。

已确认部署架构：最终部署到用户自己的服务器。服务器维护权威内容文件、元数据、索引、插件配置、调度与召回；Web 管理后台是正式组件。Local Companion 安装在用户电脑，采集 sessions 和本地文件，也可调用该电脑已安装的 Codex/Claude Code 处理器。远程 SaaS 连接器在 Web 配置后通常由服务器执行。配置入口不等于执行位置，浏览器不是长驻同步 Worker。

本轮按用户授权补最小工程harness，TypeScript/Node、统一前端栈和单一TypeBox契约作为开发默认，记录于[ADR](adr/0001-engineering-baseline.md)。单节点SQLite等产品设计仍须实际验证；插件协议、隔离与阶段验收不因配置存在而完成。随后用户授权开始P0/P1切片开发；已安装实现所需依赖。未修改用户Agent凭据或账户权限，未提交或推送。

上下文与记忆的基本正文规范是 Markdown 文件与渐进式披露：原始来源保留原格式；记忆、规则、经验、知识的派生正文以 Markdown 为主，附件通过固定版本引用和 lineage 关联。结构化元数据和可重建索引不取代正文权威；网站、视频等其它合法插件产物不受此 Markdown 格式限制。当前可执行读取范围与未交付项见[渐进披露](PROGRESSIVE_CONTEXT.md)。

## 2. 目标与非目标

目标是让“采集 → 文件修订 → 加工 → 文件产物 → 搜索召回”形成可追溯、可恢复的闭环。来源和派生关系不能只存在模型对话里；任务失败不能留下半成品为正式内容；换 Agent 或电脑仍可访问同一上下文空间。

首版不建设 n8n/Dify 式通用流程编辑器，不自建默认 Agent loop，不以数据库记录替代内容文件，不实现完整 POSIX/FUSE，不承诺复杂分布式多主自动合并。网站、视频等文件属于完整产品目标，可由后续插件产生；外部部署或发布是独立副作用。

本地 CLI 运行不等于离线模型推理；模型请求可能离开电脑。使用本地已登录 CLI 也不保证第三方产品能够复用其订阅额度。鉴权和使用方式应由适配器依据厂商支持方式检查，不复制用户 token 到服务器。

## 3. 核心概念与用户动作

| 概念 | 定义与动作 |
| --- | --- |
| Space | 权威服务器上的上下文文件空间；创建、配置访问范围、备份 |
| Source | 来源实例；绑定外部资源、设备和同步游标，检查同步结果 |
| File | 有稳定 file ID 的内容实体；逻辑路径可变，重命名不自动变成新实体 |
| Revision | 文件某次不可变内容版本，带 hash、来源、派生输入与作者类型 |
| Commit | 一组修订的可见边界；不可变清单绑定精确内容版本，可变 head 指向当前版本；不必是 Git commit |
| Plugin / Instance / Binding | 包提供能力；实例统一保存配置、位置、权限与预算；Binding引用实例组成场景，普通用户从预设启动 |
| Run / Attempt | 固定输入与配置的一次任务，以及重试执行尝试 |
| Staging | 不参与正式浏览和检索的暂存输出；校验后才能发布 |
| Local Companion | 出站连接服务器的设备组件；采集、缓存、按授权执行任务 |
| Output Set | 一个 binding 管理的命名产物集合；一次成功运行可原子更新整套 Wiki/站点，增改删都有明确归属和版本 |

推荐文件区分 `sources/`、`derived/`、`authored/`：来源副本、机器生成产物、人工维护文件。它们都是真实文件，不是三类数据库正文。人修改来源或派生文件时应明确选择保留草稿、提升为人工维护文件或合并，不能静默被下次同步覆盖。

浏览用 `files/` 是只读投影，编辑用独立 `working-copies/` 或 Web 草稿；平台不会异步刷新可写工作副本。首版“提升”保留同一 file ID，重命名到 authored 并改变所有权，原生成 binding 的该输出槽转为仅提案。复制另建文件属于另一个操作，不隐含原生成文件的冲突保护。下游按稳定输出槽选择正式revision，提升改变目录后仍会使用人工版本；只按目录订阅的高级配置会明确提示不会跟随移动。

典型动作：先在Web导入一个文件并搜到原文；要做Repo Wiki时选择官方预设、仓库范围和执行设备 → 预览费用/输出/权限 → 开始 → 查看Wiki并通过Agent引用。没有加工设备也能先搜索代码原文；Companion仅在选择本机采集或加工时安装。DAG、JSON、挂载和插件实例收进高级配置。

以上是含采集/加工的完整路径。只查询用户可用远程MCP + 检索Skill，无需Companion；查询并积累才启用collector，可选Hooks；后台worker另授执行权限。首次部署先初始化owner、Space/project并搜到首文件，embedding可以后配。具体表单、状态、接入与回滚见用户使用闭环；其中所有OpenContext命令/安装包均为拟议设计。

## 4. 功能与验收

下表同时给出成功结果和关键失败边界；详细一致性规则见技术方案。编号供实现与测试追踪。

| 编号 | 功能 | 可验收条件与失败处理 |
| --- | --- | --- |
| RF-01 | 文件空间与浏览 | Web 能列目录、预览、下载原始文件、查看来源和修订。索引失败不使已发布文件丢失；未发布 staging 不出现在正式目录 |
| RF-02 | 连接器 | 支持 Codex/Claude Code sessions、本地目录、飞书文档/群聊、网页、代码仓库的插件契约；每个 binding 标明 server/local 执行位置与 web/local 配置入口；缺鉴权显示 blocked，不擅自登录 |
| RF-03 | 增量同步 | 支持追加、覆盖、rename、delete 与二进制。追加/覆盖是写法，commit 是版本边界。相同外部版本重复送达不重复追加；失败后游标不越过未发布数据；通过摄入政策的原件按精确字节保存，解析失败单独报告；疑似秘密排除或隔离，不为保留原件而默认上传 |
| RF-04 | 触发 | 提交、定时、webhook、本地文件变化统一为持久事件；重复/乱序可处理；抖动文件变化经稳定检测后摄入；加工产物不能无限触发自己的生成器 |
| RF-05 | 加工 | VLM、外部 Agent loop 或本地 coding CLI 读取固定文件/目录版本，输出经验、Wiki、Markdown、站点或视频。首版优先调用本地已有 CLI；未安装、断连、超时、额度不足均保留明确状态，不自动换付费服务 |
| RF-06 | 插件组合 | connector/trigger/processor/indexer/retriever/context-assembler/embedding/publisher 共用注册与调用协议，首版有官方实现；插件只能提出内容/索引/召回结果，内核仍校验。升级不改变已运行任务的插件/配置版本；八类能力共用实例配置和精确锁版；Binding/pipeline只引用实例，不重复位置/权限/预算；不兼容协议、缺少能力实现或权限时阻止启用 |
| RF-07 | 搜索与渐进披露 | 当前快照支持全文、向量、grep；历史快照首版仅支持 tree/read/grep，显式请求历史全文或语义检索返回不支持，允许降级时标明模式。结果带 file ID、revision、commit、出处、预算和索引覆盖；目录、摘要、命中数量、片段、citation 返回前均检查当前 ACL。freshness独立于检索降级；允许stale永不允许invalid/撤权 |
| RF-08 | 版本与人工编辑 | 能固定版本引用、查看 diff、恢复历史；恢复产生新 commit。人工修改有所有权保护；来源更新或迟到生成结果遇到冲突进入 needs_review，不能覆盖人工版本。纠正/取代须明确审核关系、确切revision及项目范围；不按authored身份自动优先，关系可冲突、复核及撤销 |
| RF-09 | 多机器 | 两台 Companion 使用同一服务器 Space；只建立出站连接。断连可缓存授权输入和暂存结果；重连校验租约、版本和权限；过期 worker 不能提交，重复执行不产生两个正式结果 |
| RF-10 | 权限与数据边界 | 首版单 owner：Web session、API/MCP token、设备凭据各自受限可撤销，匿名请求拒绝；凭据不进入内容目录、prompt、索引或日志。设备仅访问授权来源/任务。权限撤销先阻断读取、召回、任务和发布，再清理缓存/索引；已复制到离线机器的数据无法保证远程即时擦除 |
| RF-11 | 运维与恢复 | Web 显示同步/加工/索引分开状态、错误、重试与设备心跳。内容和状态库备份能恢复并验证 hash；索引可重建，凭据/权限/租约/回执不能假称从文件正文安全重建 |
| RF-12 | 外部发布 | 内部文件发布成功与网站/远程文档等外部发布结果分开；外部动作有幂等键与回执。超时后结果不明进入 unknown，先查验，不能宣称跨系统原子事务或无限重发 |
| RF-13 | 文件继续加工 | Binding可用路径选sources/derived/authored，也可按稳定输出槽选择人工提升后的正式版本；固定快照，声明trigger、recipe、依赖与输出，执行/预算从实例引用；飞书→主题→PRD/技术方案→Wiki 仅改插件配置即可装配，各级已发布产物都能检索 |
| RF-14 | 产物集合生命周期 | delta 缺失文件不删除；full 仅在显式完整集合和授权清理策略下删除仍归本 binding 自动管理的缺失产物；rename 保留 file ID。人工提升/修改受保护；失败/部分结果不改正式集合；删除在同一 commit 形成 tombstone并退出当前召回 |
| RF-15 | 部署与首次使用 | 向导覆盖TLS/持久卷/owner/Space/project/首文件；doctor分查存储、DB、task、来源网络和检索，未配embedding可用FTS/grep；备份恢复/升级回滚有验证证据 |
| RF-16 | Agent接入与项目隔离 | query/collect/worker角色独立；MCP/Skill/可选Hook按版本probe并生成配置diff、私有备份与安装receipt；卸载保留无关配置；cwd仅通过确认的project映射选scope，无映射不全库搜索 |
| RF-17 | 选择性会话采集与Hooks | 远程MCP不自动获取本机会话；官方只读接口优先，历史范围/脱敏/游标/未知格式明确；Hook轻量且不阻塞编码，Stop与SessionEnd独立，worker会话默认排除自采 |
| RF-18 | 来源连接体验 | Git/飞书向导分开验证网络、身份、资源访问及完整扫描；首同步/解析/索引分状态；漏事件定期对账，扫描不全不推导删除；真实飞书P2、fixtureP1，文档和群聊独立binding |
| RF-19 | 召回使用与诊断 | project→search→read→引用可验证；trace区分提供上下文、实际工具调用和可观察引用；空结果可排错但不泄露无权内容；server/embedding/设备离线分别降级。来源更新+设备离线时能先读最新原文，显式选择过期产物，看到恢复动作；无权和invalid永不可选 |

### 状态与用户反馈

Source 状态建议为 `idle / syncing / blocked / error`，显示最后成功游标与 commit。Run 状态统一为 `queued / leased / running / staged / validating / published / blocked / retry_wait / needs_review / superseded / failed / cancelled`。`published` 只表示内部内容已发布，索引独立显示 `pending / ready / partial / failed`。外部发布独立显示 `pending / publishing / succeeded / failed / unknown`。

Web 应给出下一动作：blocked 说明所缺设备、鉴权或能力；needs_review 提供 base/current/proposed 差异；superseded 说明输入已更新；索引 partial 说明哪些召回能力降级。自动重试仅适用于短暂网络、限流等可恢复错误，权限与结构错误不能无限重试。

向导中的blocked_auth、access_unverified、unsupported等是诊断reason/能力标志，不另造一套Run状态；身份、资源访问、扫描coverage、解析、索引分别显示。P1单owner是同一用户设备的信任域，不承诺企业多用户来源ACL映射。远端撤权存在检测窗口，收到可信证据或权限验证到期后立即阻断本服务读取，不能把“当前ACL gate”宣传为全供应商实时撤权。

## 5. 三种参考插件组合

| 组合 | 输入与插件链 | 文件输出与验收 |
| --- | --- | --- |
| 经验库 | Local session connector → 本地 Codex/Claude processor → 摘要与混合检索插件 | 原始 session JSONL、经验 Markdown；每条经验引用具体 session 修订；人工审核后可提升到 authored；重复同步不重复经验 |
| 飞书知识整理 | 飞书原文 → 主题/结论 → PRD与技术方案 → Wiki；各步由 Binding 指定官方插件和 recipe | 每一级都是有版本/出处的文件，可继续作输入和被检索；无须修改 server 代码；来源改变沿依赖链更新，人工文档可作为额外输入 |
| Repo Wiki | Server Git connector → 固定 Git commit 快照 → Local 或 Server processor → Wiki/站点文件 | 代码快照、模块 Wiki、静态站点文件；引用文件版本；仓库更新只重做相关依赖，人工 Wiki 不被覆盖；外部部署单独配置 |

三种组合验证小内核和组合契约，不代表平台变成单一垂直应用。MVP 可先以 session 和 repo 组合实跑，飞书使用契约测试 fixture，正式飞书鉴权与权限撤销在后续阶段验收。

完整可解析的飞书四级配置、全部拟议插件实例和 Binding 类型见实施蓝图第3节。该例的spec→wiki按槽选PRD/技术方案，PRD提升到authored后仍命中同file ID的新正式revision。文件集选择器可选 sources/derived/authored，不限制 processor 只读原始来源。首版限制配置依赖为无环图，输出不能匹配本 binding 输入；仅监听输入成员/版本变化，索引事件不再触发内容加工。空输入默认 blocked，不因临时空响应清空产物；需要清理时必须显式选择完整空集合并证明上游快照完整。

Repo Wiki预设的普通表单和成功证据见用户使用闭环第6.1节；它编译为同一插件契约，不新增专用server逻辑。Repo Wiki 示例：删除一个代码模块后，成功的 full Wiki 集合省略其自动管理页面，发布时生成 tombstone，旧页面立即退出当前召回；站点资源改名以原 output slot/file ID 的 rename 提案完成。若页面已提升为人工维护，则保留并标明来源过期，不能因为生成器不再输出就删除它。

## 6. 完整使用例：经验生成、断连与人工并发

1. 用户在 Web 建立经验库 binding，并把设备 A 授权到指定 session 目录；Companion 通过出站 HTTPS 同步，不暴露本机端口。
2. connector 读取一个已稳定的 session 片段，记录外部 session ID 和消息范围，追加到来源文件暂存区。服务器校验后发布 source commit `C1`，游标才前进。
3. 用户搜索相关问题，获得 C1 上的摘要和固定版本引用，展开原始片段。摘要与原文权限一致；当前索引未就绪时可使用已覆盖的全文或 grep；若 C1 已成历史，按历史 grep 规则返回。
4. `content.committed` 事件触发经验 processor；Run 固定 C1、输入 revision、插件版本、配置 hash、输出 base revision；服务器为设备 A 的 attempt 发放租约和 fencing token。
5. 假定当前已有生成文件 F，输出槽 `(experience, main, retry)` 绑定其 file ID。A 的本地 CLI 读取输入副本，准备更新 F（`derived/experience/retry.md`），结果写 staging。服务器只调度任务，不假设自己能执行笔记本上的 CLI。模型请求是否离机由所选 provider 决定。
6. A 断连，心跳租约到期。服务器可把任务交给授权设备 B，分配更大的 token。A 的本地输出仍是暂存文件，不能自封为正式结果。
7. 用户在工作副本编辑 F，然后提升到 `authored/experience/retry.md`，以同一 file ID 提交人工版本 C2。提升事务同时把原输出槽设为 proposal_only，保留槽到 F 的映射，禁止生成器以旧路径再创建一个同槽文件。
8. B 上传字节获得服务器 objectRef 后提交。服务器校验 incarnation、当前 token、输入新鲜度、F 的输出 base、ACL epoch 与所有权，因 F 已人工修改而进入 needs_review。A 晚到的旧 token 被拒绝。若仅无关文件更新 head，重新组装 manifest 后重试 CAS，复用已生成候选，不重跑模型。
9. 用户比较 base/current/proposed 后接受部分内容，产生 merge commit C3。原始来源、生成候选和人工修订均保留出处；这不要求 Git 存储视频或二进制。
10. 索引消费 C3 更新，新的召回引用 C3。若配置外部网站发布，创建独立发布任务；内部 C3 成功而外部超时显示 unknown，经查验回执后完成。

### 校读补充验收（设计用例，尚未执行应用测试）

| 编号 | 对应需求 / 故障注入 | 必须观察到的结果 |
| --- | --- | --- |
| AC-01 | RF-01/08：编辑工作副本时暂停 watcher，连续发布并重建投影 | 草稿字节不变；只读投影不可写；工作副本与 blob 不共享可修改 inode，提交携带 base |
| AC-02 | RF-05/08：模型完成后只更新无关文件，再更新真实输入 | 前者只重组 manifest/CAS 且模型调用数不增加；后者 superseded 并另建 Run；输出被人改则 needs_review |
| AC-03 | RF-08：按第6节提升 F，旧生成器提交旧路径 | F 的 ID 不变；旧路径不能绕开输出槽再创建；人工内容保留，候选可三方合并 |
| AC-04 | RF-09/11：并发 claim、SQLite busy、恢复旧备份后重放旧 token | 只有一个有效租约；busy 有界重试且无半事务；新 server incarnation 拒绝所有恢复前 token |
| AC-05 | RF-03/11：在 fsync/rename/DB commit/outbox 消费各边界崩溃并执行 GC | 不可读对象永不成为 head；已提交事件可重放；in-flight/review/backup pin 不被回收；索引 cursor 不越过未完成覆盖 |
| AC-06 | RF-03/06：重复与乱序 append、相同幂等键不同内容、非法路径、本机 stagingPath、超时取消 | 去重不重复字节；同键异内容拒绝；本机路径不能当服务器对象；取消撤租约；缺失能力实现/不兼容协议启用失败 |
| AC-07 | RF-07/10：历史检索、索引滞后、查询中途撤权 | 历史语义请求显式不支持或显式降级；revision 对请求 snapshot 有效；撤权内容不出现在目录摘要/count/citation/片段中 |
| AC-08 | RF-02/05/10：匿名访问、CSRF、撤销设备、无隔离能力、含密钥 session | 认证/授权分别拒绝；能力不足 blocked；秘密原件不进入普通 Space，脱敏文件单独标记并校验其实际字节 hash |
| AC-09 | RF-06：替换官方 trigger/indexer/retriever/assembler 插件 | 不改 server 业务代码；同协议/授权可装配；越权候选、错误 revision、超预算组装均被内核拒绝 |
| AC-10 | RF-13：执行飞书→主题→规格→Wiki 配置，再修改来源/人工约束 | 每级产物被后级选中且可检索；固定输入与依赖可追溯；循环配置拒绝；空输入按策略处理，失败上游不使下游读取半成品 |
| AC-11 | RF-14：delta 只更新A，随后完整 full 集合省略B | delta 保留B；full仅在允许清理且B仍自动归属、base未变时 tombstone B；旧索引不能让B回到当前召回 |
| AC-12 | RF-08/14：资源rename、删除人工提升文件、集合执行中失败或并发更新 | rename保留slot/file ID；显式改删人工文件进入review，full省略则保留并报告；失败/部分集合完全不提交；集合版本冲突重新校验，不覆盖新成员 |
| AC-13 | RF-15：从空server到首文件与恢复 | UJ-01/10向导、doctor、FTS/grep与备份引用校验通过；不要求先装模型或Companion |
| AC-14 | RF-16：两种Agent的新机接入与卸载 | UJ-02/06实际search/read/citation有证据；配置合并保留其他节点；scope与三角色独立；卸载可回滚 |
| AC-15 | RF-17：Hook超时、半写会话、重复回填与误采秘密 | UJ-07/08编码不被阻塞；未确认数据不越过游标；worker不回采；原始秘密不上传 |
| AC-16 | RF-18：Git变更/漏事件、飞书分页/撤权 | UJ-03/04/05区分身份与资源权限；不完整扫描不删除；正式飞书验收不得以fixture代替 |
| AC-17 | RF-19：无结果、跨项目、组件离线 | UJ-09诊断不泄露受限元信息；有scope、coverage及实际调用trace，不推断模型内部使用 |
| AC-18 | RF-08/13：实际四级配置将spec的prd槽提升到authored并审核当前输入 | wiki挂载仍含同ID的人工revision与design槽；未审核的新输入使其等待，机器提案不能取代正式版本 |
| AC-19 | RF-08/19：原文纠正、取代、并发审核、源更新、撤权及显式撤销 | 仅精确revision+项目生效；两端引用/理由可查；冲突不自动裁决；失效不泄漏；撤销恢复普通排序而不删文件 |
| AC-20 | RF-05/15/18：用户只填写Repo Wiki预设，未接模型先完成原文搜索 | 不编辑DAG/JSON即可同步→启用加工→搜索Wiki；设备/模型缺失有明确继续路径；输出/费用/授权预览准确 |
| AC-21 | RF-07/09/19：更新源后关闭worker，组合freshness和检索降级 | 最新原文可查；旧产物默认不返回，显式stale带依据；invalid/撤权始终拒绝；恢复设备后只发布有效新结果 |
| AC-22 | RF-06/10：按蓝图替换embedding实例、改retriever位置或给越权endpoint | 锁版任务不漂移；新向量generation就绪才切；位置/网络/secret缺权拒绝，Binding无第二份配置覆盖 |

## 7. 阶段与退出条件

| 阶段 | 范围 | 退出条件 |
| --- | --- | --- |
| P0 契约验证 | 文件/commit、统一插件协议、Binding/OutputSet、CLI probe、故障fixture | 全部核心能力有契约和官方注册项；组合实例/类型/引用可验证，稳定选择、纠正撤销、freshness真值表、full/delta及人工保护有用例 |
| P1 MVP | 自托管单服务器、Web初始化与诊断、query/collect/worker接入、两台Companion、官方功能插件、SQLite；session/repo实跑与飞书链fixture；基础备份恢复 | 跑通第6节、AC-09–15/17–22及AC-16的Git部分；UJ-01/02/03/06/07/08/09/11/12/13与UJ-10基础恢复；无embedding也可FTS/grep，默认不启用外部publisher |
| P2 多机与连接治理 | 飞书文档/群聊正式接入、来源权限重验、设备管理强化、完整升级回滚矩阵、插件schema迁移、运行隔离强化 | UJ-04/05与UJ-10完整矩阵；撤权、重试、冲突、迁移失败可验收；根据测量决定是否迁移PostgreSQL/pgvector；企业多用户ACL另行定义范围 |
| P3 扩展生态 | 更多处理器、站点/视频、外部发布、插件分发 | 二进制存储、外部副作用幂等、兼容测试与权限审查可维护 |

不承诺固定工期或未经测量的性能。每阶段以数据完整性、权限正确性、可恢复性和参考组合的实际结果判断。

## 8. 成功指标与待决事项

建议跟踪来源到 commit 延迟、加工成功率与人工接受率、冲突数、重复事件去重率、索引覆盖/滞后、召回相关性与出处正确率、token/模型成本、断连恢复成功率。权限泄露、静默覆盖人工文件、过期 worker 成功发布属于验收失败，不用平均成功率掩盖。

| 编号 | 待用户确认 | 当前建议 |
| --- | --- | --- |
| Q1 | 工程默认已采用，产品部署兼容仍待验证 | TS/Node、统一Web栈/TypeBox；单节点SQLite与Compose按首条切片验证，不阻塞harness |
| Q2 | 首批来源优先级和本地 CLI 鉴权边界 | sessions + repo 先实跑；保持用户 CLI 鉴权在本机，能力不满足时 blocked |
| Q3 | 人工产物归属与自动发布策略 | derived 自动更新，提升到 authored 后只提合并建议；外部发布默认禁用 |
| Q4 | embedding/VLM provider、数据离机策略与预算 | 独立配置，显式展示发送内容范围；不默认安装本地模型 |
| Q5 | 保留周期、规模与检索质量目标 | 先用公开/合成测试集测量，再定存储和索引阈值 |
| Q6 | 插件信任与隔离要求 | 首版只允许运维者信任的插件；需要强隔离的任务无隔离能力时阻止运行 |

## 9. 参考边界

OpenViking 是直接参考：目录摘要/概览/原文分层及文件与派生索引的区分值得借鉴；当前官方检索说明是全局向量搜索，并非递归导航召回。[分层](https://docs.openviking.ai/en/concepts/03-context-layers)、[检索](https://docs.openviking.ai/en/concepts/07-retrieval)、[恢复](https://docs.openviking.ai/en/concepts/09-transaction)。

Letta 已有 Git-backed MemFS 和可信本地 Mods；Supermemory SMFS 提供文件系统使用入口。同名 0xranx/OpenContext 已复用 coding CLI，因此“文件 + 插件 + 本地 CLI”不能单独作为独有声明。本项目建议重点验证文件生命周期、来源追踪、插件组合和用户服务器/本地设备协作。[MemFS](https://docs.letta.com/concepts/memfs)、[Mods](https://docs.letta.com/configuration/mods)、[SMFS](https://supermemory.ai/docs/smfs/overview)、[同名项目](https://github.com/0xranx/OpenContext)。
