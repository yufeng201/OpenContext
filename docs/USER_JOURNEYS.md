# OpenContext 用户使用闭环

状态：2026-09-30 完整用户流程目标；部分本机开发流程已实现并测试，精确范围见[实施状态](IMPLEMENTATION_STATUS.md)。正式产品验收仍按本矩阵逐条执行。配套：[PRD](PRD.md)、[技术方案](TECHNICAL_DESIGN.md)、[实施蓝图](IMPLEMENTATION_BLUEPRINT.md)、[文档导航](README.md)。本文定义用户应能完成的操作、界面反馈和测试证据，不是现有软件安装手册。

开发者可运行的harness命令另见[DEVELOPMENT](DEVELOPMENT.md)，不属于终端用户安装流程。开发skill与本文拟议的opencontext-recall用途不同；本轮未自动配置任何Hook。

本文所有 `opencontext …` 命令、配置字段、API、镜像、安装包和客户端模板均为**拟议设计**。仓库尚未发布可用 npm 包、安装 URL 或 Docker 镜像，不能照本文直接安装应用。Codex/Claude 命令单独注明官方来源，执行前仍须检查实际客户端版本。本轮没有连接用户来源、调用模型、安装集成或修改认证。

## 1. 用户先选哪条路径

| 模式 | 用户得到什么 | 必需组件与独立授权 | 首版入口 |
| --- | --- | --- | --- |
| 只查询 `query` | 在日常 Agent 中搜索、读原文、带引用使用 | 自托管 server/Web；Agent 的远程 MCP 配置；建议安装检索 Skill；**不需要 Companion** | Web“接入 Agent → 只查询”；也可只在 Web 搜索 |
| 查询并积累 `collect` | 查询已有内容，并选择性同步本机 sessions/文件 | query + 本地 collector（Companion 的采集角色）、项目与历史范围授权；Hooks 可选 | Web“添加设备”后在本机确认采集预览；默认不启动加工 worker |
| 后台加工 `worker` | 用本机 coding CLI 把固定文件输入转为产物集合 | 单独授予执行角色、CLI/provider 数据范围与预算；要求相应隔离能力 | Web“设备 → 启用加工”；可以只执行、不采集，查询/采集/执行 scope 不互相推导 |

server 连接器在 Web 配置，在 server 执行；本地来源与 local processor 由 Companion 执行，Web 只保存配置/调度。日常 Agent 是上下文消费者；headless `codex exec` / `claude -p` 是可选 processor 后端。前者接入成功，不代表用户同意后台调用后者。

“客户端集成包”可组合 MCP 配置、Skill 和 Hook 模板；它安装进 Codex/Claude 的使用环境。“服务端功能插件”是 connector/trigger/processor/indexer/retriever/context-assembler/embedding/publisher 协议实现，接受内核 gate 校验。两类包的权限、版本和安装位置分别记录，不因名称都叫插件而共享凭据。

P1 目标是 server 初始化、Codex/Claude 查询接入、sessions/repo、两台设备协作与模型缺失时的全文/grep。飞书正式 API、群聊、权限对账属于 P2；P1 的飞书文件加工链使用合成 fixture，界面须明确“演示数据”，不能把它当作真实飞书接通。

## 2. 从空服务器到第一份可搜索文件（UJ-01）

### 2.1 部署前表单与拓扑

首版目标支持一台 Linux x86_64 服务器，Docker Engine + Compose、本机持久磁盘、一个权威 writer。Linux arm64 待镜像与 SQLite native addon 验证后列入兼容矩阵；多副本 server、NFS 上共享 SQLite、Windows 原生 server 不属于首版保证。Companion 目标为 macOS/Linux；WSL2 与原生 Windows 的路径/进程树/隔离能力分别验收，不以“Node 可运行”代替兼容测试。内存、磁盘和吞吐阈值须用 fixture/目标数据测量，本文不承诺未经测试的最低硬件或最大容量。

最小 Compose 拓扑仍是 `TLS proxy → server(API + 静态 Web + scheduler + plugin host)`。SQLite 位于 server 的持久卷，不新增数据库或 Redis 容器。已有 TLS 代理时复用；否则部署一个代理服务。server 端口只暴露到代理所在受控网络，代理对用户提供同源 Web/API/MCP；设备只出站 HTTPS。没有公网域名也可用局域网 DNS 和受信任私有 CA；每台客户端须信任证书。HTTP 仅限隔离的 loopback 开发，不能用关闭证书验证实现跨机器接入。

以下是拟议部署配置，不是 Compose 文件或已支持的环境变量；构建部署包时由同一 schema 生成配置并映射 Compose 卷/网络：

```json
{
  "schemaVersion": "1",
  "publicUrl": "https://context.example.invalid",
  "serverListen": "0.0.0.0:8080",
  "tls": {"termination": "reverse-proxy", "trust": "private-ca"},
  "storage": {"dataRoot": "/var/lib/opencontext", "sqlite": "state/control.sqlite", "localDiskOnly": true},
  "secrets": {"mount": "/run/secrets/opencontext", "includeInContentBackup": false},
  "writerInstances": 1,
  "retrieval": {"modes": ["fts", "grep"], "embedding": null},
  "bootstrap": {"ownerCreation": "server-console"}
}
```

`example.invalid`仅占位；替换为用户实际地址。内容/控制库卷持久化 `/var/lib/opencontext`，代理证书状态有独立持久卷；secret store 单独挂载，不在 Space 或内容备份。容器可销毁，卷不可随重建删除。备份目的地与内容卷分离，选择由用户运维环境提供，不默认上传任何位置。

### 2.2 向导与健康检查

| 步骤与用户动作 | 系统动作与界面 | 成功证据 / 错误恢复 |
| --- | --- | --- |
| 取得将来发布的固定版本部署包，或从明确 commit 自建镜像；填写地址、持久目录、证书方式 | 校验 release/commit 与 schema，生成部署差异；目前包未发布，文档不提供虚构下载命令 | 展示将创建的卷/网络；架构或数据库驱动不兼容则停止并给兼容记录 |
| 启动 Compose，在服务器控制台初始化 owner | 拟议 `opencontext server init-owner` 交互设置密码；只允许未初始化状态；不在参数/日志传密码，不开放匿名远程建 owner | Web 从“待初始化”变为登录页；重复初始化拒绝，不覆盖既有 owner |
| 登录 Web“首次设置 → 存储与健康” | 检查卷读写/持久化能力、DB迁移/WAL、writer锁、后台任务心跳、代理URL/TLS；错误分类显示 | “修复后重试”；磁盘/DB不安全为阻断，embedding未配置仅为可跳过项 |
| “创建 Space → 创建项目” | 建立空 manifest/head；输入 Space名、project名与允许路径；无需先配模型 | 能打开空目录；project是Space内受限查询范围，不是另一个数据库 |
| “添加首文件 → 预览 → 提交” | 使用用户选中的无敏感示例 Markdown，走 upload/commit、全文索引；不自动扫描磁盘 | 显示 commit/revision/hash、索引ready；搜索命中后能打开同一版本正文 |
| “接入 Agent”或“添加来源” | 保存向导进度，可跳过设备和embedding，以后补配 | 未完成来源不会伪装为已同步；首页分开显示内容、解析、索引、加工状态 |

拟议 `opencontext doctor --profile project-demo` 返回按组件分列的 `pass / warn / fail / skipped`：存储、DB、task、TLS/API/MCP、来源网络、索引覆盖、可选embedding。来源探测仅访问已配置且授权的端点；doctor不遍历网络、不发送私有正文给模型、不修复权限或自动重新登录。检索自检使用隔离的非敏感 fixture，结果写诊断 trace，不污染正式来源。按钮为“查看原因 / 重试检查 / 打开配置 / 下载脱敏诊断”。没有配置来源或模型时显示skipped，不能宣称这部分已连通。

### 2.3 备份、升级、停机

Web“运维 → 备份”显示一致性控制库快照、head、引用对象校验、schema版本、恢复验证日期。备份整个 control.sqlite 一致快照（其中也包含索引）及可见内容与必要pin对象；索引恢复后可重建，ACL/游标/回执不可丢。secret store另行安全备份或重新授权，不能混入内容导出。

升级流程：先doctor和备份 → 停止新claim、等待/取消attempt → 验证部署包与迁移 → 在停写窗口升级 → 校验引用/登录/搜索 → 恢复任务。失败不只回退镜像：若schema不向后兼容，停写恢复配套数据库和内容快照再启动旧版本；说明回滚会丢失备份之后尚未另行保存的更新，保留失败现场。恢复/重启更换server incarnation，拒绝旧worker令牌。正常停机保留卷和队列；重新启动先验证状态再调度，不重新导入全量历史。

### 2.4 内容导出与完整备份：两个按钮、两个承诺

本产品是受管理的版本化文件库。Web“导出内容”给所选snapshot的可读目录，可带出处/纠正关系清单，方便离线看文件或迁移正文；编辑导出不会自动改server，重新导入默认生成新身份。“创建完整备份”才保存内容对象/manifest及一致控制库，恢复当前head、授权、游标和运行状态；秘密另行恢复/重新授权。只有普通目录或blobs不等于完整备份，不能据此恢复授权或复活旧设备。缺控制库时明确“可救回内容，不能完整恢复服务”，不让用户误以为filesystem-first意味着数据库可以随意丢弃。

## 3. 新电脑接入与项目范围（UJ-02、UJ-06）

### 3.1 安装选择与可回滚计划

Web“接入 Agent”的必选字段为：server URL、Space、project；本机步骤选择客户端Codex/Claude、配置作用域、当前目录映射、query/collect/worker角色。可选项分别展开：历史回填起止/条数预览、原文或脱敏上传、排除目录、Hooks事件、后台自动加工、设备标签和限额。默认只查询、当前项目、不回填历史、不启用Hooks、不授worker；collector需要单独勾选来源和范围。

安装器先probe客户端版本、MCP传输/auth方式、Skill目录、Hook事件及输出格式、session读取API、CLI执行/隔离能力，形成兼容记录：`clientVersion + integrationVersion + platform + capability → supported / manual-only / blocked`。未测试版本先保留手动MCP路径，不猜配置信息；不擅自升级厂商CLI。不同机器可以选择不同客户端，不需要把本机厂商授权目录复制到server。

拟议 `opencontext integrate plan --client codex --profile project-demo` 只读生成本机配置diff：新增的MCP节点、Skill文件、可选Hook、原文件hash和冲突。用户选择“应用”才合并；只修改本包拥有的节点，保留已有MCP/Skill/Hook，命名冲突先选择别名。每次应用前保存受限权限备份和安装receipt，写入时检查原hash；中途失败回滚本次变动。备份可能含已有秘密，留本机私有目录，不上报server。

卸载提供“仅移除集成 / 同时撤销查询token / 同时解除设备配对”。按receipt移除本包节点；用户后来编辑过的区域给反向diff，不覆盖新编辑、不整文件恢复旧备份。先暂停collector/worker再解除设备配对；本地未上传变化与草稿提示导出/保留。已提交内容默认留server，卸载不等于删除Space。配置备份按用户选择清理，不碰其他插件和厂商登录。

### 3.2 项目与scope解析

本机私有映射由用户确认的规范绝对目录绑定 `server/spaceId/projectId`；同一项目多个worktree须显式添加或批准规则。最长匹配根用于选择profile，遇到冲突/未映射目录询问选择，不默认全Space。repo remote、分支名、`.opencontext`文件、AGENTS或模型传入的cwd只能是提示，不能扩大授权；服务器仍把请求scope与token的Space/project/路径白名单取交集。

远程MCP不能自动知道本机cwd。默认每个客户端profile绑定一个project，使用仅限该project的token；用户切项目时选择对应profile/独立MCP名称。可选本地stdio桥接器可根据已确认目录映射路由，但仍逐次验证scope；它是轻量查询CLI，不需要常驻Companion。无scope请求只有在token唯一绑定project时才取该project，否则返回 SCOPE_REQUIRED，禁止回落到全库。

拟议本机配置示例；所有ID和secret引用均为占位，不能作为真实凭据：

```json
{
  "schemaVersion": "1",
  "profileId": "project-demo",
  "serverUrl": "https://context.example.invalid",
  "spaceId": "space-demo",
  "projectId": "project-demo",
  "roles": ["query"],
  "queryCredentialRef": "keychain:opencontext/project-demo/query",
  "projectMapping": {"roots": ["/home/example/work/project-demo"], "onUnmapped": "ask", "allowCrossProject": false},
  "agent": {"client": "codex", "transport": "http", "installScope": "user", "skill": true},
  "collector": {"enabled": false, "sourceClients": [], "backfill": "none", "uploadPolicy": "sanitized", "excludeWorkerOrigin": true},
  "worker": {"enabled": false, "bindings": []},
  "hooks": {"sessionStart": false, "stopEnqueue": false, "sessionEndEnqueue": false, "promptRecall": false, "deadlineMs": 1000, "bootstrapTokenBudget": 600}
}
```

启用collect时再取得独立device credentialRef并保存授权根；启用worker还需绑定Binding和执行能力。查询token不可拿来上传/claim。这里deadline与token值是可调设计默认值，须通过测试，不是测量过的性能承诺。

## 4. MCP、Skill、Hook、CLI各做什么（UJ-02、UJ-07）

### 4.1 默认接入：远程MCP + 检索Skill

默认使用经TLS的HTTP MCP，工具为 `context_search / context_read / context_tree`。`context_propose_changes`单独授予proposal scope，只存候选，不自动获得发布/执行权限。owner在Web创建项目受限的查询凭据，秘密交付到本机keychain或仅当前进程环境，不写URL、共享repo或命令历史。

以下是官方Codex CLI注册命令的占位示例；URL和环境变量值须由实际部署提供，命令会修改客户端配置，本轮未执行：

```sh
codex mcp add opencontext --url https://context.example.invalid/mcp --bearer-token-env-var OPENCONTEXT_QUERY_TOKEN
```

启动Agent的受信任本机进程从keychain注入指定环境变量，配置仅保存变量名。`codex mcp login opencontext`仅在服务实现OAuth时使用；本版首版bearer方案没有实现OAuth，安装器不能自动调用login或假装OAuth成功。[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

Claude官方注册形式如下，同样不是本轮执行；仅注册URL并不完成鉴权：

```sh
claude mcp add --transport http --scope user opencontext https://context.example.invalid/mcp
```

安装器在兼容版本的私有用户配置中合并 `headersHelper`，指向本机受信任、固定绝对路径的拟议 `opencontext auth headers --profile project-demo`。此专用helper从keychain读取token，仅向调用客户端返回认证header JSON；不得记录该输出或让来源仓库替换helper。旧版无安全动态header能力时提供经验证的环境引用方式或stdio桥接，不把token字面值放CLI参数/shared配置。[Claude MCP动态认证](https://code.claude.com/docs/en/mcp)

Skill模板叫 `opencontext-recall`，内容限定为：先确定当前project → 有相关历史/规范需要时search → 读命中原文相关段落 → 区分来源/派生/人工文件 → 回答附固定revision/citation → 无证据就说明未找到 → 经验写回仅提出授权候选。它不承诺每轮自动搜索，也不把全部Skill正文和全部上下文每轮注入。Codex个人/项目目录为`~/.agents/skills` / `.agents/skills`；Claude为`~/.claude/skills` / `.claude/skills`。安装前按版本和运行环境验证，默认个人作用域；云端Agent不会自动获得电脑个人目录中的配置。[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[Claude Skills](https://code.claude.com/docs/en/skills)

点击“验证接入”分三步显示：协议/鉴权连通 → 明确要求Agent执行一次search和read → 检查返回citation与已知fixture一致。MCP工具出现在列表不代表模型会调用；Skill已安装不代表它被使用。跨项目可见性另做负例验证。

### 4.2 可选Hooks：轻量入口，不承担长加工

| 用户选项 | 适配器行为 | 失败与边界 |
| --- | --- | --- |
| SessionStart引导 | command Hook调用拟议 `opencontext hook bootstrap`，按已确认scope通过CLI/受控API读取很少的现有导航/上下文，标来源、版本及数据属性 | MCP可能未就绪，不能依赖启动时MCP工具；超时返回无上下文并记录诊断，正常编码继续 |
| Stop补采 | 仅将session ID/进度提示写本机持久队列，collector稍后读取；不在Hook同步上传全文或调用LLM总结 | Stop表示本轮停止，不等于会话结束；去重且不启动新聊天轮次，抑制自触发 |
| SessionEnd补漏 | 再次入队/刷新collector游标，定期扫描补偿未触发或崩溃退出 | 不能仅靠SessionEnd保证采集完整 |
| UserPromptSubmit召回 | 默认关闭；启用后限定project、超时、token与频率，只查已有索引 | 不把整段prompt无条件上传；敏感检测/用户策略先于查询；超时跳过，不阻塞提交 |

当前Codex官方已支持Hooks；Claude也有Hooks，但事件payload、设置位置、输出字段、运行环境分别适配，不能复制一份vendor JSON当永久协议。Claude `TaskCompleted`是任务完成事件，不等同每轮回答结束。`transcript_path`仅是便利信息，不作为稳定跨版本会话格式。适配器把已识别事件归一为平台`session.start / turn.stopped / session.end / prompt.submitted`，未知事件记录为unsupported，不猜字段。Hook仅输出可信模板包裹的数据，不把来源指令提升成权限；不调用长LLM、不发起外部发布、不返回阻止编码的决策。[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Claude Hooks](https://code.claude.com/docs/en/hooks)

本地队列写失败/超时显示非阻断诊断，定期collector reconcile补漏；worker自身会话带`origin=opencontext-worker`并排除回采。Hook安装与collector启用分别勾选：只查询用户可仅启用bootstrap而不采集历史。

### 4.3 拟议OpenContext CLI界面

以下仅是需实现的命令分组，尚不能运行：`opencontext connect`（设置profile/安全凭据引用）、`integrate plan/apply/remove`（配置差异与回滚）、`doctor`（分层诊断）、`sync`（授权binding同步）、`search/read`（同API召回）、`mcp serve`（stdio桥接）、`hook bootstrap/enqueue/recall`（轻量Hook入口）、`companion`（采集/执行角色）、`server init-owner`（服务器控制台初始化）。CLI与Web不能各自实现另一套权限或发布规则。

## 5. 从会话到可复用经验（UJ-07、UJ-08）

远程MCP只收到工具请求，不会自动获得电脑上的历史聊天。用户在本机“采集范围”选择Codex/Claude、已授权项目、开始日期/最近数量、是否包含已归档会话、原文/脱敏策略；预览会话数量、估计字节、排除原因后才启用。浏览器不读取本机私有目录，server也不假定笔记本在线。

collector优先用官方只读接口：Claude SDK的`list_sessions` / `get_session_messages`；Codex app-server的`thread/list` / `thread/read(includeTurns=true)`。安装器记录provider版本及返回schema；Codex turns/items分页等实验接口按实际probe启用。分页和checkpoint由本机adapter管理，不因一次API返回部分消息就前移完整会话游标。这些接口用于读取，不发起新模型turn。[Claude会话读取示例](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)

| 处理节点 | 用户可见结果 | 具体约束 |
| --- | --- | --- |
| 来源预览 | “待导入 / 已同步 / 排除 / 格式未知”及非敏感原因 | 私有配置/凭据目录强制排除；不扫描整个home；来源的cwd只能匹配已批准根 |
| 增量读取 | 当前session、稳定记录数、分页/游标状态 | 去重键含provider安装实例、session/thread ID、稳定item/record ID及版本；无稳定ID时用锁定parser的范围/hash对账，不只靠mtime |
| 半写/未知格式 | “等待文件稳定”或“需要兼容适配” | 读取文件fallback按稳定边界/完整记录摄入，尾部半条保留重试；未知schema留本机quarantine，不上传乱码或猜transcript字段 |
| 上传 | “本机待传 → 服务器已提交 → 已索引”分开 | SQLite outbox、ObjectRef与durableAck；重复送达不重复append；断网保留cursor与pending |
| 敏感策略 | “原件排除 / 隔离待处理 / 脱敏后导入” | raw只指通过政策的精确字节；sanitized的hash针对实际脱敏字节；原密钥不进入普通Space，用户无需为了导入而上传厂商凭据 |
| 加工与经验 | “排队 / 等待设备 / 候选冲突 / 已发布” | 用户另行启用recipe；授权derived集合内可自动发布，不要求人工批准每个机器文件；人工提升、冲突和外部发布另行控制 |

collector回填与实时增量共用幂等键；删改源记录产生新的revision或tombstone，来源未支持删除检测时明示能力缺口，不虚构删除。后台processor的providerSessionId与平台run关联并标worker origin；collector默认排除这些会话，避免“经验加工自己的加工会话”递归。用户主动保留运行证据时由run日志/产物导出独立路径，不再触发同一session采集链。

## 6. Git仓库连接向导（UJ-03）

Web“来源 → 添加 → Git仓库”，配置在Web，fetch在server的受限connector执行。公开仓库默认不需凭据；私有仓库可选最小只读PAT、只读deploy key或GitHub App安装身份。只读同步不要求push、管理仓库/组织或复制Agent查询token；SSH host key单独校验，secret由server store提供。具体供应商权限按连接器版本列出并测试，不能把API scope选择当成已授权全部资源。[GitHub PAT权限](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

| 页面/字段 | 按钮与系统检查 | 用户看到的状态 |
| --- | --- | --- |
| repo URL、认证方式、secretRef | “检测网络”只检查到所选host；“验证身份”与“读取仓库”分开；限制允许协议/重定向，不能让任意URL变成主机文件读取 | DNS/TLS/SSH、401/403、repo不可读分别报错；不把权限不足误报为空仓库 |
| branch、include/exclude、单文件/总量上限 | “预览分支与范围”；用户选择明确分支，保存解析出的ref；显示排除、二进制、LFS指针、submodule条目 | 可读branch不等于整个导入已成功；规则变更预览新增/删除影响 |
| 手动或定时频率、可选webhook | “保存并首同步”；先创建binding，再排队fetch | 抓取进度、解析进度、索引覆盖分别显示，可暂停/重试 |
| 首次成功结果 | 展示最后成功Git SHA、OpenContext commit、文件数及部分错误 | “浏览来源 / 搜索验证 / 配置Wiki”；首次无有效快照则不能显示ready |

P1默认一个指定分支的当前完整树，不导入完整提交历史或自动跟随所有分支。利用Git对象读取tree/blobs，不执行repo hooks、构建或checkout过滤器；symlink作为记录处理，不沿链接读宿主文件。submodule只记录gitlink/URL与SHA，不递归；Git LFS只保留指针并标记未下载；需另授权/支持后启用内容下载。二进制可按限制保留原件，未支持的解析明确标记；超大文件显示排除，不假装已全文索引。[git clone](https://git-scm.com/docs/git-clone)

增量以最后成功SHA为基线：fetch所选ref → 比较新旧tree/diff → 对授权范围生成Change → 一个完整批次发布 → 才前移SHA/cursor。新旧SHA不构成祖先关系的force-push按两棵完整树对账；旧对象不可得则重新枚举新树，不能把失败diff当无变化。分支被删/权限变化显示blocked并保留旧快照、标失去新鲜度；不自动把整个来源清空，用户选择新分支或确认停用。rename能可靠识别时保留file ID，否则按delete/create解释。[git fetch](https://git-scm.com/docs/git-fetch)、[git diff](https://git-scm.com/docs/git-diff)

GitHub webhook在验签、大小限制与去重后快速持久入队，随后connector读取真实ref；它只加速，不提供完整性。定期fetch对账仍开启，失败投递不会由GitHub自动重投，需运维重投或对账补漏。[失败投递说明](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)

首版以Git对象为主。若以后走GitHub API，Compare API全次比较的文件列表最多300项，不能通过commit分页推导完整变更；recursive tree返回truncated时必须逐子树补全。扫描不完整不得推进完整cursor或从“未见文件”推导删除。[Compare限制](https://docs.github.com/en/rest/commits/commits#compare-two-commits)、[Tree限制](https://docs.github.com/en/rest/git/trees)

### 6.1 官方Repo Wiki预设：普通用户的默认加工路径（UJ-11）

入口为“新建场景 → Repo Wiki”，已有Git来源可直接点“生成Wiki”。这是通用插件体系的官方验收预设，不是一套特殊server流程；以下UI和插件均待实现。缺省页面只显示三张卡片，DAG、JSON、挂载和实例版本藏在“高级配置”，用户无需成为流程工程师。

| 卡片 / 普通字段 | 默认与按钮 | 系统动作及用户成功证据 |
| --- | --- | --- |
| 1 选择代码 | Space/project；已有Git来源或URL、明确分支；可展开排除目录。公开仓库不填token | “检查并同步”：复用第6节身份/范围预览，展示成功SHA与可检索文件；先搜一个代码符号并打开原文，不依赖模型 |
| 2 选择加工方式 | 缺省“先同步原文”；可选“本机Codex/Claude”或已授权server处理器。选本机后列已配对/在线且能力满足的设备；缺设备给“连接这台电脑”入口 | 首次连接复用query/collect/worker向导，只授worker所需范围；显示模型是否离机、预算目标/硬限能力及预计发送范围。未授权时“生成Wiki”禁用，“继续使用原文”可用，不自动选付费provider |
| 3 确认并开始 | 输出为“项目Wiki”；默认中文Markdown、首页+模块页、15分钟对账代码且成功同步后更新（可改手动）；外部站点发布关闭 | “预览并开始”：展示输入范围、可自动更新/删除的机器页面和预算；确认后保存同一实例/Binding配置。UI显示“原文已同步 → Wiki等待/加工中 → 校验发布 → 可搜索”，可暂停加工而继续同步 |

预设装配官方repo connector、events trigger、cli-recipe processor、text-index、hybrid、progressive插件；embedding默认未启用，publisher未引用。源码按一个分支快照输入，recipe逐页带代码revision引用，首页为required，模块页采用完整OutputSet。scope、排除目录和输出归属来自预览；包/实例/recipe锁版记录在运行详情。Web表单只编辑统一配置的字段，不能另存一份预设参数与高级配置竞争。技术类型和最小编译函数见[蓝图第3.5节](IMPLEMENTATION_BLUEPRINT.md#35-统一实例替换与官方repo-wiki预设)。

第一次可信Wiki结果必须同时有：可打开的代码SHA/版本 → 已发布Wiki页 → 该页实际引用的代码片段 → Agent search/read后使用的引用证据；“任务完成”或“网页出现”不足以证明正确。生成期间可以继续搜索已同步代码；没有本机worker时，原文检索仍是完整的首次成功，不把Wiki不存在伪装为全平台不可用。

更新例：删除模块A并把站点资源logo改名，下一次成功完整集合对自动A页tombstone，资源rename保留ID。用户把模块B页点“改为我维护”后，B的ID和正式槽保留；处理器只提合并建议，后续按槽订阅的汇总页继续引用B的已审核人工版本。来源再次变化时人工B也会标过期，不能因目录叫authored就永远视为最新。

## 7. 飞书文档与群聊接入（UJ-04、UJ-05，正式能力P2）

### 7.1 文档向导

P1的`oc.feishu`只提供合成fixture用于组合契约测试；P2才以真实API通过本节验收。Web“来源 → 飞书文档”与“飞书群聊”是两个独立preset/binding，允许同一connector包实现，但身份scope、资源范围、cursor、附件策略分别保存；文档授权不能复用成全群权限。

| 表单与动作 | 检查及成功证据 | 失败与恢复按钮 |
| --- | --- | --- |
| “区域”：中国飞书 / 国际Lark；“身份”：企业应用 / 用户OAuth | 使用对应区域的API与授权配置；说明应用以谁的权限读取；OAuth依当前官方流程实现，不硬编码过时v2端点 | 区域不匹配或auth方式未实现显示blocked，不能自动换端点/身份 |
| 应用配置或授权secretRef → “验证token” | 只证明身份token有效，记录过期/刷新状态 | “重新授权 / 重试”；秘密不在配置导出中 |
| 文档URL / 指定文件夹 / Wiki空间或节点 → “验证资源访问” | scopes足够且资源向该身份分享/可访问；显示具体可读范围 | “查看缺少的授权”；token有效但文档不可读不可算通过 |
| include/exclude、子节点范围、附件/导出格式、同步频率 → “预览” | 分页列出计划资源、类型/解析支持、估计附件量；只处理选定范围 | “缩小范围 / 重试失败页面”；不默认全租户扫描 |
| “开始同步” | 拉取→解析→附件→提交→索引分别统计；独立文档可分批成功，每份文档/依赖附件的完整性边界明确 | “重试失败资源”；部分成功不标成整个范围ready，不推进未完成扫描的完整水位 |

API scopes与资源分享授权是两层；附件下载还可能需要独立权限。企业应用、用户身份能看到的范围不同，不能保证全租户抓取。现有single-owner服务只适合owner有权导入并允许这些设备使用的信任域；它没有企业各员工身份映射，不能声称自动继承企业多用户ACL。正式接入前UI须提示该边界；多人共享部署需另行实现终端用户身份与来源权限映射。[云文档FAQ](https://open.feishu.cn/document/server-docs/docs/faq)、[云空间FAQ](https://open.feishu.cn/document/server-docs/docs/drive-v1/faq)

读取文档保留结构：docx blocks递归/分页获取并绑定一致revision，处理中版本变化则重试该文档；原始结构数据、解析Markdown、附件分文件保存。Wiki node先解析到obj token/type，再按实际资源获取；子节点和文件夹都遍历到has_more=false，空items且has_more=true仍继续next page。遇到重复cursor或缺少下一页标扫描不完整，而不是结束并删除遗漏文件。[文件夹列表](https://open.feishu.cn/document/server-docs/docs/drive-v1/folder/list)、[Wiki子节点](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/list)

P2最小解析矩阵：docx blocks为结构主路径，纯文本仅预览/降级并标格式损失；导出任务是异步job，需轮询和取得结果后才确认文件；媒体/附件另行下载校验。sheet/bitable、嵌入块、评论等未实现类型显示unsupported，不返回伪完整Markdown；可保留已授权原始响应或明确不导入。必需附件失败使该文档保持partial，不能用空附件替代；允许省略的附件必须在manifest和UI标出coverage。[导出任务](https://open.feishu.cn/document/server-docs/docs/drive-v1/export_task/create)

### 7.2 更新、撤权、事件与删除

| 观察到的情况 | 处理规则与显示 |
| --- | --- |
| token失效/刷新失败 | 暂停该binding并blocked_auth；“重新授权”；不能把所有资源当删除 |
| 明确资源撤权或读权限拒绝 | 标记access_unverified/denied，立即停止本地服务的read/search与依赖摘要暴露，保留受限历史供owner排查；重新验证后才解封 |
| 404/资源缺失但不能区分删除与权限 | 标记待核对并阻断该资源召回；后续权威确认删除才tombstone，不从一次缺失猜删除 |
| 网络/限流/5xx | retry_wait，指数退避；不推进cursor、不删除；到达权限验证有效期后仍未验证则阻断召回 |
| 完整扫描确认删除 | source tombstone同commit发布，影响派生产物invalid，读/search gate立即生效；索引清理异步 |
| 分页未完/扫描失败 | 保留已确认结果，范围partial；既有文件不能因本次没列出就删除 |

来源权限有效期/重验周期可配置，UI显示lastAccessVerifiedAt与到期时间。远端刚撤权到本机收到证据之间存在检测窗口，不能宣称跨系统即时撤权；一旦收到可信撤权或有效期到期，server立即阻断。敏感部署可选每次读取前重新验证或更短有效期，并承担API延迟/限流；不支持的验证策略必须显示。

P2默认指定范围手动+定时对账。事件仅加速：文档订阅常要求owner/manager，文件夹订阅的事件覆盖有限（主要创建），不能以成功订阅保证全部编辑/删除实时同步。企业自建应用可选择出站WebSocket长连接接收支持事件，不强制公网callback；公开callback方案须验签。断连/漏事件仍由定时扫描补偿，用户能看到事件连接状态和最后完整对账时间。[文档事件订阅](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/subscribe)

### 7.3 群聊独立向导

Web“飞书群聊”要求选择机器人/应用身份、已加入的指定群、消息读取scope、起止历史范围、thread回复与附件策略。先验证机器人及群访问，再预览可读历史；不推断文档secretRef授予聊天权限，不保证入群前全部历史可用。以message_id去重，编辑版本另记revision；thread回复按接口单独获取，不能只读群主列表就宣称完整。[历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)

事件接收同样只唤醒增量拉取；群加入/机器人权限变更需重新验证。附件、撤回/删除事件和历史回补分别列能力标志，不支持时明确“未覆盖”，不虚构恢复已撤回正文。可确认撤回时记录tombstone/状态和出处，保留是否留历史由政策控制。群聊文本中的指令不执行；后续主题/PRD/Wiki组合复用已有Binding和OutputSet。[消息事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)

本节细节沿用此次用户流程审查提供的官方核实记录；本轮访问飞书链接只能取得页面标题，未把正文独立复核冒充已完成。实现锁版时须再次核对区域、OAuth、scope与事件权限，不因此把正式API验收提前到P1。

## 8. 每天如何召回、验证和排错（UJ-02、UJ-09）

日常路径为：用户在项目A提问 → 客户端profile解析到A的scope → Agent按Skill或用户明确要求调用search → 返回摘要/候选与coverage → 调用read取得相关原文段落 → 回答附revision/source引用 → 可选提出经验候选。摘要是导航，不能替代证据；来源材料包含的动作指令仍按数据处理。首次验收先手动明确要求search/read，成功后才打开可选自动引导。

| 用户看到的结果 | 诊断依据与下一动作 |
| --- | --- |
| 未同步 | 对用户有管理权限的binding显示还无成功commit；“开始同步/查看来源错误” |
| 未索引或部分索引 | 已有commit，但当前索引coverage不足；“重试索引”或预算内grep降级 |
| 被路径/时间/类型/freshness筛掉 | 仅对本来获授权的集合显示过滤条件与可解释数量；“调整范围”；stale默认不冒充当前事实 |
| 无权限或不存在 | 普通Agent统一“无可访问内容”，不透露受限文件名、count或是否存在；管理诊断另按管理权限显示原因 |
| 解析不支持 | 对可见文件显示原件存在、可下载但未参与正文召回；“选择支持的解析插件” |
| 已覆盖范围内无命中 | 显示实际scope/servedCommit/modes与截断状态；可修改关键词，不自动跨项目全库搜索 |

trace采用同一requestId贯穿client与server，记录scope解析、插件/配置版本、候选过滤、read字节范围、引用ID和预算；默认不记录完整问题/正文，脱敏诊断按保留周期清理。UI分列“工具已提供”“search被调用”“read返回引用”“客户端报告回答包含引用”，只有实际证据才点亮；server无法观察最终回答时该栏unknown。不得从MCP连通、Hook注入或模型文字推断其内部一定使用了材料。

server离线：查询清楚报错，日常编码继续；query-only默认无本机内容缓存。可选授权缓存仅显示缓存commit/时间和离线未验证权限，不假装新鲜；断网collector持久排队。embedding失败：退回FTS/grep并说明vector缺失；processor模型不可用：保留原始同步/索引，run为blocked/retry_wait，不自动换付费服务。worker设备离线：只有该local加工等待，server查询/Git同步继续。源权限过期：即使缓存索引存在也不绕过读取gate；已送往离线设备的内容无法保证远程即时擦除。

### 8.1 来源更新、加工电脑关机时如何继续使用（UJ-13）

假定Repo Wiki已经基于代码C1发布W1，负责加工的电脑A随后关机。服务器同步到C2时，原文照常提交/索引；受影响W1标stale，依赖被删除的页面及其后代标invalid，未受影响页面仍fresh。UI不用用户理解租约，而是呈现“代码已到C2，3页等待电脑A更新”，只有管理该任务的用户能见设备名称/数量。

| 用户动作 / 情况 | 正常结果 | 恢复与不可越过的边界 |
| --- | --- | --- |
| 默认直接问Agent / Web搜索 | current_only：返回C2原文和仍fresh的页面，提示当前可用覆盖；不把W1当最新 | “查看原文 / 查看更新进度”；可读原文不依赖embedding或设备在线 |
| owner在Web勾选“包含过期内容”，或明确让Agent参考旧Wiki | search和随后的read都用include_stale，显示“W1基于C1，当前来源C2”及固定引用；答案须标这是旧解释 | 能看到为什么过期、授权范围内的最新原文、等待原因；一次请求选项不永久放宽其他会话默认值 |
| embedding失败 / 当前FTS未覆盖 | allowDegraded决定能否转FTS/grep；仍遵守所选freshness | 开启检索降级不等于允许旧Wiki；include_stale也不保证语义索引可用 |
| 模块已删、来源撤权、权限验证到期 | invalid/tombstone/无权内容及其依赖产物一律不返回，过期选项不能勾选恢复 | 对普通查询统一“无可访问内容”；只有管理面按授权给出重验/修复建议，不泄漏受限文件名 |
| 启动电脑A，或owner选择另一台已授权且兼容的设备 | “恢复加工”：校验设备/权限/最新输入，排队新attempt；有效新集合发布后显示基于C2 | 旧租约结果不能覆盖；若输入已到C3则superseded，若人工编辑则保留候选并needs_review |
| 选择“保持人工版本” | 人在diff中核对C2，提交新人工revision及reviewedAgainst，正式槽就绪，允许下游继续 | 单纯关闭提醒不能洗成fresh；未完成审核仍过期，不偷偷删除人工文件 |

默认只传播已提交的正式版本；staging/失败集合永不参与检索或下游输入。权限收紧沿来源依赖传递，即使索引或多级Wiki尚未重建也先阻断。重新连网不自动授权新设备、换provider或扩大上传范围。

### 8.2 更正错误经验，而不是让“人工内容”全面压过原文（UJ-12）

用户发现某条经验把“重试次数3”写成“30”，可从引用页点“纠正此版本”，基于当前材料写一份更正文件并给出依据。提交表单只要确认：适用项目、被纠正的确切版本、替代文件版本、理由和“纠正并列 / 整文件取代默认结果”。源副本照常同步，平台不会修改历史原文；简单复制到authored也不会自动成为规则。首版关系只针对整份确切revision，需要用户明确范围，不会按相似关键词自动裁决。

接受后，正常search/read把纠正和原证据作为同组引用；取代模式默认读更正正文，并可展开被取代证据。无有效关系时，人工与机器材料按相关性/出处展示，冲突并列。证据组超预算则请求展开或省略整组，不单独返回被纠正的错误结论。普通Agent只可按另授proposal scope提出候选，不能自行审核关系。

“撤销纠正”展示影响预览，确认后使关系不再生效，两份文件仍在且保留审核记录；权限和版本仍分别检查。两人/两窗口同时纠正同一版本会进入冲突选择，不能最后保存覆盖。原文有新revision或更正文件被修改，旧关系显示“需重新核对”，不自动适用新内容；任一端无权或来源撤权时不泄漏其文字、理由或关系存在性。人工提升的同file ID编辑由正式revision选择处理，跨文件纠正使用本节关系，两个动作在UI分开。

## 9. 完整用户E2E验收矩阵

以下都是待实现的测试设计。本轮只验证文档/配置与类型，未执行这些用户场景。使用合成或明确授权fixture，不用用户私有内容作为默认测试数据。

| 编号 / 阶段 / PRD | 用户操作 | 系统动作与成功证据 | 错误注入与恢复 |
| --- | --- | --- | --- |
| UJ-01 / P1 / RF-01,11,15 | 空服务器初始化owner、Space/project；上传首Markdown并搜索 | 向导完成；commit/revision/hash可打开；FTS/grep命中；未配embedding仍可用 | 不可写卷/DB迁移失败阻断启动；修复后doctor通过且首文件仍在 |
| UJ-02 / P1 / RF-07,16,19 | 新电脑分别以Codex与Claude安装query profile；明确要求search→read→引用，再试Skill引导 | 不装Companion也能读取；实际tool trace及引用与fixture一致；另一project负例不泄露 | token失效/未知客户端版本有诊断；安全更新配置后重试，原有MCP节点不变 |
| UJ-03 / P1 / RF-03,14,18 | Git指定分支首次同步；新增/改名/修改/删除文件；触发Wiki更新 | Git SHA→source commit→OutputSet→引用链一致；旧页面退出当前召回；rename稳定ID条件满足时保留 | force-push、缺旧SHA、漏webhook用完整tree对账；branch删除不清空来源；分页截断不能确认完整 |
| UJ-04 / P2 / RF-03,10,18 | 授权指定飞书文档/Wiki，修改正文，再撤销资源访问；Agent重读 | 分页/blocks/revision及索引coverage可查；收到撤权或验证过期后正文与摘要均拒绝；记录检测窗口 | token有效但资源无权不算成功；空页has_more继续；限流重试，扫描不全不删；P1只能跑fixture部分 |
| UJ-05 / P2 / RF-02,03,18 | 机器人加入指定群，导入范围内消息/thread/附件，再接收编辑或撤回 | message_id去重；thread/附件coverage明确；支持的撤回更新可见性；文档授权不能代替群权限 | 缺消息scope/群访问blocked；断连后补拉；未支持撤回能力显式标缺口 |
| UJ-06 / P1 / RF-09,16 | 电脑A采集并断网，B查询/执行；server停机重启；A恢复；最后卸载A集成 | durableAck后才前移游标；旧fence拒绝；重复上传不重复；卸载不改其他配置、不删已提交内容 | pending草稿提示保留；人工改过配置用反向diff；撤销设备后不能上传/claim，B继续使用 |
| UJ-07 / P1 / RF-04,17 | 开启可选Hook，开始会话、结束一轮、结束会话；暂停MCP/网络 | bootstrap不依赖MCP就绪；Stop/End队列去重；collector定期补漏；worker会话不自采 | Hook超时、队列满、未知payload不阻塞正常编码、不启动长LLM；查看诊断并可单独关闭Hook |
| UJ-08 / P1 / RF-05,10,17 | 导入带合成密钥的session；禁用加工模型/embedding，再同步普通文本 | 密钥原件隔离或排除；sanitized hash对应实际字节；普通同步/FTS可用，模型状态独立 | 不上传厂商凭据、不自动切付费provider；修复配置后显式重试，旧正式产物保留 |
| UJ-09 / P1 / RF-07,10,19 | 在项目A查询B专属词；测试空结果、旧索引、历史引用与查询中撤权 | 无跨项目泄漏；diagnostic不暴露受限count；历史仅按既定grep/read范围；trace区分提供/调用/引用 | 无scope时要求选择；无权与不存在对普通Agent一致；可授权管理员定位同步/解析问题 |
| UJ-10 / P1基础、P2完整升级矩阵 / RF-11,15 | 创建备份，在隔离恢复环境校验，再试失败升级回滚 | 控制库与blob引用一致，owner/ACL/cursor保留，索引可重建，新incarnation拒绝旧attempt | 不用热复制孤立db；不兼容schema恢复配套备份；记录RPO和备份后更新处置，secret另行恢复 |
| UJ-11 / P1 / RF-06,13,15,18 | 按Repo Wiki三卡片表单先搜代码，再选设备生成Wiki；将spec的PRD提升后继续生成Wiki | 不写JSON即可启用；注册/实例锁可查；真实四级fixture提升前后均选同ID正式PRD，机器提案不遮盖人工版本 | 无设备/模型时原文可用；slot未就绪则等待；配置越权endpoint或错误位置阻止启用，可回到原配置 |
| UJ-12 / P1 / RF-08,19 | 为错误经验创建纠正/取代关系；引用查看后撤销 | 两端revision、scope、理由与审核版本可查；仅指定项目/版本生效；撤销保留字节并恢复普通候选 | 同target并发关系needs_review；源更新需复核；撤权时关系/派生材料不泄漏；预算不足不返回裸旧结论 |
| UJ-13 / P1 fixture、P2真实飞书 / RF-07,09,10,19 | C1生成W1；停worker，来源更新C2；默认查询、允许过期、再恢复设备 | 最新原文可查；stale展示旧依据与等待动作；新attempt只基于有效输入提交，新正式产物解除等待 | 完整枚举freshness与降级选项，invalid/撤权始终拒绝；三层派生撤权同样生效；人工更新转review；飞书真实事件延迟仍按P2边界 |

## 10. 设计覆盖结论与实施出口

现有八类插件、Binding DAG与OutputSet可以承载上述闭环；本版补上的产品接口是部署向导、profile/scope、客户端安装receipt、来源分层probe、collector适配、Hook队列和召回trace。正式版本选择、纠正关系、Repo Wiki预设与统一插件实例补上日常使用的衔接；它们复用已有内核，不要求更换SQLite、重新建设Agent loop或通用流程画布。

P1发布前必须真正交付部署包/镜像、兼容矩阵、UI与CLI/模板并完成UJ-01/02/03/06/07/08/09/11/12/13及基础恢复，不能因为本文命令和表单已定义就声称可安装。P2完成真实飞书及企业来源权限验证；跨员工身份ACL、其他OS、OAuth MCP与更多来源能力按独立范围验收。选型和数据离机/预算等用户决策仍见PRD Q1–Q6。
