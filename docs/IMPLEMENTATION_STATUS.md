# 首条可运行切片：运行与验收

日期：2026-09-30。已从设计进入源码实现；这是 P0 与 P1 首条受限闭环，不代表完整 P1 或生产部署就绪。[完整目标](PRD.md)、[开发检查](DEVELOPMENT.md)、[用户旅程](USER_JOURNEYS.md)。

## 实际运行

当前目标为 Linux、Node 24.19.0、pnpm 11.19.0，另需系统 Git。使用项目锁文件：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm dev
```

首次使用从[快速开始](QUICKSTART.md)按顺序安装、构建、启动。check 包含 Web 构建；dev 启动 Fastify，在 127.0.0.1:4310 同源提供构建后的 Web/API/MCP。浏览器用终端打印的明确合成 demo token 登录。该 token 是公开测试值，只用于本机演示，不能用于共享或生产部署。demo 默认写忽略的 runtime-demo/，私有开发模式写 runtime/；停止后可重启，不从临时内存重建文件身份。

非 demo 启动使用 `pnpm start`，要求从私有环境提供 OPENCONTEXT_OWNER_TOKEN（32–256字符）；不会自动生成或复制用户凭据。demo 与私有 owner 环境不能混用；控制库持久记录 demo/private 模式，旧未标记库按 private 处理，跨模式拒绝 DATA_MODE_MISMATCH。OPENCONTEXT_DATA_ROOT 指定持久开发数据目录，PORT 可改 loopback 端口。现阶段仅允许 localhost/127.0.0.1/::1 Host，拒绝跨源浏览器请求；TLS/反向代理域名、Compose 镜像与正式 owner 初始化向导尚未交付，不能直接当远程生产部署说明。

Web 开发热更新为 `pnpm dev:web`（127.0.0.1:5173），API/MCP代理到4310。首次使用：登录→创建上下文空间→选择Git来源/Markdown处理器→添加公开HTTPS仓库和分支→同步→搜索→打开固定版本原文→生成Markdown导航→再次搜索源和产物。另一条已接入的来源是用户主动上传Session JSON，操作见[Session导入](SESSION_IMPORT.md)，不是自动采集电脑。测试本地repo只在显式 OPENCONTEXT_TEST_REPO_ROOT 之内；这仅供合成 fixture，不默认开放任意服务器文件路径。

## 已实现边界

| 模块        | 已有代码与行为                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| server/权限 | owner bearer或HttpOnly/SameSite cookie，项目只读token及撤销；API/MCP每次检查当前项目授权，source撤销传播衍生内容                                   |
| 文件        | SHA256 blob、不可变revision/commit清单；临时写→文件fsync→rename→父目录fsync后，SQLite短事务发布head、cursor、run与outbox                           |
| 调度        | SQLite持久队列、单worker轮询、租约/心跳、十进制fence、新server incarnation；重启恢复queued工作，旧attempt不得发布                                  |
| 插件注册    | StaticRegistry统一发现、TypeBox manifest/配置验证、package digest/config/instance锁；有界生命周期与独立离线包conformance，任务冻结锁与导入对象引用 |
| Git插件     | 注册为ConnectorDefinition；固定SHA文本快照、重复幂等、rename稳定ID、增改删、强推/缺旧SHA对账、跳过报告                                             |
| Session插件 | Codex/Claude显式v1 envelope上传；预检后落盘，scope/ID/完整性校验；raw精确保留、文本归一化、已知工具项raw-only诊断                                  |
| processor   | 注册为ProcessorDefinition；Markdown导航/摘录不调用模型；full集合提交、稳定slot、删除旧产物；不得覆盖human-owned                                    |
| Session候选 | 显式Memory/Rule/Experience及中文标记→确定性Markdown；message/raw双revision引用与依赖；不是语义总结或自动规则批准                                   |
| 检索        | SQLite FTS5 + 固定snapshot文本grep降级；原文/产物共同召回、freshness/current revision gate、固定引用；索引失败outbox保留重试                       |
| MCP         | 官方SDK stateless Streamable HTTP，/mcp提供context_search/context_read/context_tree；TypeBox参数校验，projectId必填                                |
| Web         | React/Vite/Tailwind/shadcn模式、Router/Query/RHF；登录/项目/来源/任务/搜索/固定引用；失权清缓存，无token本地持久化                                 |

项目是本切片的权限和文件边界，Web 暂用“上下文空间”称呼；完整 Space 下多 project 层级还未实现。插件为静态注册的可信 native 代码；不支持安装任意第三方插件、隔离进程或动态更新。八类功能能力仍为平台目标，当前只有connector/processor可执行注册；其余内建能力和未实现能力见[插件开发](PLUGIN_DEVELOPMENT.md)。绑定配置只创建一次，没有在线编辑、配置迁移或热升级接口。

现在通过 `apps/server/src/plugins.ts`组合已审查definition；`GET /api/plugins`供后台发现，通用binding请求选择connector/processor及配置。Catalog只保存实例锁/对象引用，Coordinator按运行锁调用host，不再用Git URL判断场景。包digest覆盖声明的artifact文件真实字节、manifest和配置schema，配置hash与instance ref一并固定；修改已锁定代码不会悄悄按“同名最新版本”执行。手工artifact清单不是自动依赖闭包或发行签名，也不是沙箱。旧Git-only API由组合入口适配；旧未锁定待执行任务以LEGACY_RUN_REQUIRES_RETRY结束，需明确重试。新增包仍需审查、workspace依赖和composition注册，不能只上传manifest启用。

SQLite 使用 Node 24 自带 node:sqlite（首切片工程选择），没有安装 better-sqlite3 原生构建脚本。目标方案中的驱动可在测量后另迁移，文件与SQL事务边界不变。检索评分当前使用至多500个项目内候选的单文档查询词覆盖/词频，避免跨项目全局BM25统计影响；不是BM25质量或大规模检索验收。source成员、路径或revision变化会保守地使同binding旧generated产物变stale，删除/撤权的invalid仍不可放行。

每个控制库同时只允许一个 Catalog。独立 authority SQLite 文件持有进程生命周期锁，第二启动报 CATALOG_IN_USE，不能抢走存活服务的 incarnation。进程退出/崩溃由操作系统释放锁，重启才恢复任务；不要手工删除 `.authority.sqlite` 锁文件绕过排他。此机制只支持本机磁盘单服务，不是多节点分布式锁。

MCP SDK 1.31.0 自带声明与 exactOptionalPropertyTypes 不兼容，tsconfig 仅 skipLibCheck；本项目源码仍 strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes。

源内容限受支持UTF-8文本，BOM/CRLF保留；binary/LFS/submodule/symlink/>1MiB单文件列入skipped。Git调用禁交互/用户Git配置/凭据环境，限制执行时间与输出；这不等于OS/网络沙箱，没有DNS重绑定防护或pack磁盘配额。仅限可信owner、本地开发边界，不对不可信插件提供安全隔离承诺。

## 接入 Agent

先用Web或API取项目ID。Owner可通过 `POST /api/projects/:id/tokens` 发放一次显示的项目只读token，`DELETE /api/tokens/:tokenId` 撤销；秘密值只进个人安全存储/环境，不进仓库。当前不实现OAuth，因此不使用mcp login冒充鉴权。

本机Codex支持的命令形态（已读0.159.0-alpha.3 help；本轮仅以临时参数验证配置，不修改全局配置）：

```sh
codex mcp add opencontext --url http://127.0.0.1:4310/mcp --bearer-token-env-var OPENCONTEXT_QUERY_TOKEN
```

先在用户自己的私有环境提供 OPENCONTEXT_QUERY_TOKEN。上述add命令会写客户端配置，本轮没有执行；测试使用进程临时参数。每个工具请求传projectId；search之后用返回fileId/revisionId调用read，按citation引用原文。官方协议Client已实测连通。

真实Codex最初在只读CODEX_HOME下初始化失败：0.159.0-alpha.3与隔离安装的官方0.159.2都以退出1报Read-only file system；失败系统调用为installation_id的O_RDWR|O_CREAT打开。单独指定可写sqlite_home/log_dir未解决。随后按用户新增授权，仅为无凭据子进程使用全新可写客户端状态目录，未修改父进程环境/原只读目录、复制凭据或放宽沙箱。0.159.2 app-server成功初始化、退出0；正式官方mcpServerStatus/list和mcpServer/tool/call已对真实当前服务完成工具发现→search→read，正文SHA256和固定引用一致。这是显式RPC驱动的真实客户端传输验收，不是模型自主使用工具或生成回答。

新目录account/read返回account=null、requiresOpenaiAuth=true，没有auth文件；尚未发起登录或模型turn。因此真实Agent回答仍未验收。下一步需用户明确授权云端独立目录的登录，并自行完成官方设备登录确认（策略允许时使用codex login --device-auth），或由平台提供受支持的现有认证接入；不能复制原认证、改只读挂载或转到用户电脑来冒充通过。Claude未安装。[官方状态目录](https://learn.chatgpt.com/docs/config-file/config-advanced)、[认证](https://learn.chatgpt.com/docs/auth)、[app-server工具接口](https://learn.chatgpt.com/docs/app-server)。主动Session文件导入不改变此认证边界；产品opencontext-recall安装器、Hooks、自动历史会话采集/真实导出器、Companion与本地coding CLI后台加工仍未实现。

## 实测与未覆盖

业务测试在 `pnpm test:app`；使用临时合成Git仓库、真实SQLite、真实文件写入及本机HTTP，不调用付费模型或用户真实源。覆盖幂等/增改删/rename、固定历史引用、产物共同召回和删除、freshness降级、项目拒绝/token撤销/source衍生撤权、重启恢复、过期fence、事务回滚、manifest失败前不发布、索引outbox恢复。

真实Chromium流程见 apps/web/README.md（仓库路径）：登录→建空间→Git同步→搜索/固定原文重载→Markdown产物共同召回→390px窄屏→退出；包含跳过提示，无本地storage token。环境没有Browser插件，使用系统Chromium与Playwright，实际查看桌面和窄屏截图。独立浏览器还验证项目切换、重复提交、错误恢复、来源与token撤权、320px视口及真实服务停机重启。在线阅读器每3秒重验授权，收到404清空缓存正文和路径；这是有检测窗口的轮询，不能即时收回已复制字节。Firefox/WebKit、真实模型工具采用率未验证。

当前MCP/REST/Node源码SDK已有共享TypeBox查询响应校验、固定revision一致性与文件集合游标分页；读取正文验证UTF-8长度/hash，成功payload/工具包装另受16MiB上限。没有read分块、精确token预算、projects/search分页或历史snapshot search；1–50的search命中上限、512码元单摘录及4096码元摘录总上限保持，不能称总数。domain拒绝目前由SDK表达为协议错误，未完成细化的工具错误契约。管理后台没有任务取消、来源配置在线修改（错误分支需重新添加）；health只证明进程存活，未检查所有已发布对象完整性。

当前未做：物理断电测试、生产备份/恢复工具、正式TLS部署包、私有Git凭据、远程Companion、人工编辑/提升界面、纠正关系API、完整OutputSet delta/第三方publisher、真实飞书授权验收、向量、完整配置DAG或插件市场。核心保护的纯规则/单元测试不替代这些端到端功能。首次用户可用成功已验证，不以此勾选整个PRD/P1。

## 当前插件与Session开发边界

新增插件的实际示范在`tests/integration/plugin-runtime.test.ts`：只在composition注入合成definition，经通用binding创建、任务、文件/SQLite发布、索引和MCP门禁执行。与`packages/plugin-host/tests/registry.test.ts`的契约测试分开；后者单独通过不能证明整条应用链。实例是独立UUID版本身份，同配置的两个project可以各自绑定，配置hash相同不合并权限或实例。

Session入口使用`opencontext.session-import/v1`和明确的projectScope/provider/sessionId；上传前预检，运行再验冻结object/hash。完整性为导出者声明，不能据fixture证明真实供应商分页或Mac本地读取已兼容。已识别工具项保留raw并给诊断，不进入显式marker候选；未知/partial整批拒绝。相同字节去重，同名更新有expectedObjectId CAS；删除导入需再sync才改变正式集合；来源撤权立即由gate拒绝原文和衍生。命令、导入样例及原文/归一化/候选区别见[Session指南](SESSION_IMPORT.md)。

当前官方processor只做Markdown摘录或显式标记候选，不调用模型、不自动写AGENTS。候选async适配器接点只测合成实现，不能列作真实本地Agent功能。后续先稳定Session导出/导入/恢复，飞书适配器已做模拟响应闭环，后续单独授权指定群接入；真实飞书、Mac客户端与模型认证尚未验收。团队权限/协作目标仍需明确，当前single-owner项目隔离不冒充企业多用户ACL。

## Harness 与交付检查点

harness-only ZIP 是开始业务开发前的独立检查点，包含当时39个配置/检查/必要文档，已从空目录冻结安装并检查通过。不要用它覆盖当前业务开发树；恢复当前工作请使用包含所有源码的 source checkpoint。设计ZIP是阅读包。

私有Library附件写入曾返回网络错误，尚未确认新版附件；不能将本地ZIP存在当成上传成功。公开源码以Git提交及对应CI记录为准，首版定位仍是本文件所述开发切片。临时验收日志、设备状态、运行数据与历史写作归档不进入公开提交；历史材料保留在原工作区。

## 2026-09-30 独立验收修复

三位未参与原实现的reviewer分别审查架构/权限、真实浏览器及MCP，已复现并复验关闭：tombstone路径复用错身份、rename/成员变动freshness、撤权管理元数据、凭据URL前置拒绝、跨项目统计影响、搜索/产物Unicode截断、输入错误400/413、阅读器撤权缓存与失败诊断。回归已纳入业务测试及浏览器spec；独立报告和修前/修后证据单独交付，不把未实现的功能记为通过。

随后实际源码架构复审又发现并修复三项现有行为：删除来源后，旧derived历史引用不再因full加工将它标为tombstone而恢复可读；REST/MCP及重启持续拒绝，直接有权限的source历史引用仍保留。切换项目重置来源草稿，迟到的原项目提交不能清空新项目草稿；提交结果只失效原项目查询。任务卡片优先显示服务端当前queued/running任务，不让旧本地published结果遮住新任务。三项均有独立修前/修后证据，Web状态新增单元与真实浏览器回归；没有借此进行插件注册/数据库迁移等大范围重构。

公开首版后的独立复查补齐根 README、快速开始及项目只读 MCP token 的发放/撤销路径，并修复：demo 重用私有数据目录、失败的重复启动抢占存活服务、超过 Web 契约长度的 owner token 仍可启动、旧 derived revision 在重加工后被误标 fresh、离线退出未清正文，以及撤销来源仍显示可执行动作。对应回归保留修前失败证据；固定历史读取按请求 revision 评估 freshness，当前授权与 invalid 拒绝仍先执行。离线退出立即清本标签内容并保存非秘密断开标记；网络失败时明确提示无法确认 HttpOnly cookie 已清，其他标签和禁用存储场景不能假称同步退出。

## 飞书指定群插件检查点

已实现`org.opencontext.feishu-chat`和`org.opencontext.feishu-chat-analysis`：指定chatId/时间范围、chat与已发现thread分页、消息ID/版本去重、有限overlap与下次同步时的日对账、耐久pending恢复与已确认snapshot；网页配置secretRef并做显式连接诊断。每个来源文件携带live/simulated标记；分析仅提取显式主题/结论/待办/需求，保留固定消息版本出处。网络适配通过DI模拟官方响应测试，未连接真实群或获取凭据。

只对上游明确deleted形成当前文件删除并使依赖候选invalid；列表缺失不删除。HTTP拒绝/凭据失效仅阻止新同步，已发布档案仍按本地owner授权保留；owner撤销来源才阻断本地召回。没有远端ACL自动镜像、事件实时同步、附件下载或完整历史回复保证。当前500留存消息/100扫描页/10MiB容量超限即失败，不截断后宣称完整。完整操作、权限差别与必须备份plugin-state的理由见[飞书群指南](FEISHU_CHAT.md)。

飞书检查点实测：完整`pnpm check`含195项业务单元/集成、7组harness及Web构建；新connector17合同、analysis10合同，均含在业务计数中。浏览器原10回归与新3项均覆盖；断网诊断自动排队问题修复后，新3项再次通过。官方MCP SDK实际initialize/list/search/read验证合成群来源和候选共同命中、固定引用/hash、跨项目及撤权拒绝。独立审查复验未确认snapshot重放重新验凭据/群权限，以及两层JSON转义的已知token在写盘前被拒绝。没有真实飞书或模型调用。

## 2026-10-08 Markdown与真实用户操作补齐

官方Session候选仍为Markdown，新增Status/Provenance/Content章节；原始JSON及固定lineage保持。REST/SDK/CLI/MCP支持可选确定性标题目录、行/章节、UTF-8字节预算与offset续读；旧客户端无新参数时保留全文形状。Reader默认8KiB并提供目录、展开、续读和显式全文；空空间新增来源入口及导入错误恢复已补齐，预览支持两种安全代码围栏。存储在分配正文缓冲前对元数据和实际fd大小执行16MiB门禁，正文仍需上限内全文校验和扫描。

参数及准确未实现项见[渐进披露](PROGRESSIVE_CONTEXT.md)。这轮只使用隔离合成Git/Session，未运行真实客户端登录、模型调用或飞书采集，不创建真实访问凭据，不改现有演示服务。验收材料以固定本地提交和独立交接为准；历史测试结果不冒称本轮执行。
