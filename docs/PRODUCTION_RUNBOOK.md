# 单机受控部署：安装、升级与隔离回滚

状态：可执行操作流程与合成演练，**尚不是生产就绪承诺**。目标范围为单机、本机可靠磁盘、一个受信Catalog写者、静态可信插件；单组织是部署假设，尚无组织成员/OIDC/RBAC，不表示用户已选择团队方案。文件身份、固定版本、当前授权和插件发布门禁保持不变。

## 兼容矩阵与升级门禁

| 程序/数据                    | 当前写者                               | 停写校验/备份      | 操作                           |
| ---------------------------- | -------------------------------------- | ------------------ | ------------------------------ |
| 新空目录                     | schema2初始化                          | 无迁移             | preflight后start               |
| schema2、audit_format2       | 允许；必要审计结构损坏拒绝             | 完整校验           | 同兼容版本升级先备份           |
| schema1或已知无storage标记库 | UPGRADE_REQUIRED，控制库写前拒绝       | 可校验已知完整形状 | 必须显式新目录升级             |
| 新目录升级输入               | 只支持schema1且audit_format2的审阅基线 | verify必须成功     | 原目录不改，新目录事务迁移     |
| 未知/较新schema              | SCHEMA_UNSUPPORTED，写前拒绝           | 校验失败           | 使用匹配受审程序，不能手改标记 |

当前APPLICATION_COMPATIBILITY为single-writer-schema2-preview，写入版本仅2；离线工具读取备份storageVersion1/2并核对实际库标记。备份容器仍为opencontext-backup/v1，其格式版本与库schema版本不同。旧无审计/955 ledger虽可验证，直接升级要求先在隔离环境用受审ce2基线建立audit_format2并重新备份；本批不承诺所有历史发行版本可直接迁移。

新版本在新目录事务内把storage_version从1设为2并写storage.upgrade committed审计意图；还原的reader默认撤销、缺口标记保留。事务失败回滚标记/意图；提交前后退出均保留.restore-incomplete，禁止启动。完成验收后才移除标记并fsync。异常目录保留供调查，不自动删除；重试选另一个不存在的新目录。

真实ce2旧Catalog在合成数据上拒绝schema2，且schema1回滚库保留固定引用/hash和撤销门禁。但更早程序可能根本不检查版本/恢复标记：不能阻止任意历史程序或同OS管理员直接写库。部署操作员必须隔离旧release与数据卷、只把匹配版本目录交给单写者；禁止删锁/标记或降级写新库。回滚不是把schema2标记手改成1。

## 安装和私有启动

先从受审release取得源码，记录commit、锁hash和构建产物；构建与数据目录分离。Node24.19.0、pnpm11.19.0、Git2.50.1为本机实测工具链，Linux现有CI是基础工程检查，不替代目标部署验收。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm drill:deploy
pnpm drill:restore
pnpm drill:upgrade
pnpm drill:load
```

upgrade演练使用Git历史ce2源码，仅对自有临时恢复库验证旧程序行为；要求仓库有该受审历史commit，浅克隆须由操作员取受审历史后再跑。不下载或执行不受审旧程序，不借此运行真实用户库。

操作员私下提供已有owner秘密、绝对私有数据路径和端口。以下只示变量名，不创建凭据；不在shell参数、日志或截图中放秘密。

```sh
export NODE_ENV=production
export OPENCONTEXT_DATA_ROOT=/absolute/private/new-data
export PORT=4310
pnpm preflight
pnpm start
```

已有owner环境由操作员提供。没有自启/OS/TLS配置写入；默认127.0.0.1，任何远程入口先完成[部署安全](DEPLOYMENT_SECURITY.md)的真实TLS、Origin和日志脱敏门禁。启动后分别确认公开health存活、owner readiness依赖、固定read和权限负例。preflight是停写检查，实例存活会拒绝，不是在线probe。

## Node 发行目录与服务生命周期

当前发行是 Node24.19.0 原生 TypeScript 服务入口及预构建 Web，不使用开发热重载。构建机仍需要完整冻结安装；运行机只安装锁定的生产依赖。发行目录提供 start、preflight、admin、cli 和归档验证运行路径；完整开发检查/构建/演练必须在源码 checkout 执行，文档跨页链接以完整源码文档站为准。发行工具按显式文件白名单复制 src、workspace manifests/lock、Web dist 和离线 admin/preflight/cli 与部署示例，排除运行库、秘密、环境文件、Git 与 node_modules。release-manifest.json 给出每个文件 SHA256、treeHash、sourceCommit/sourceDirty；dirty=true 不能当成精确 commit 发行。归档通过 Node24 标准 USTAR/gzip 实现，不调用系统 tar 或读取 xattr/resource fork；固定 mode、uid/gid、mtime、空 owner 名及中立 gzip OS字段，不产生 AppleDouble。仅接受 manifest 的完整文件集合（加 manifest 本身）和精确祖先目录；拒绝多余/缺失/重复文件或目录、链接/特殊条目、绝对/点段/非规范路径、非零 padding/附加数据与不匹配 hash。解压大小64MiB、成员2048、manifest文件1024上限；hash不是来源认证，同样须核验可信交付包整体 SHA256。相同 Node24.19.0与文件字节/manifest下本机验证归档字节可重复；尚未实跑Linux构建，不以此宣称跨系统位级重现。treeHash 是内容摘要，不是签名或来源认证。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
# OUTPUT 必须不存在且位于源码目录外
pnpm release:build /absolute/private/OUTPUT
# 首装前归档：OUTPUT 必须干净且只含 manifest 规定内容
pnpm release:archive build /absolute/private/OUTPUT /absolute/private/OUTPUT.tgz
pnpm release:archive verify /absolute/private/OUTPUT.tgz
cd /absolute/private/OUTPUT
pnpm install --prod --frozen-lockfile --ignore-scripts
# 由操作员预置一个已有秘密文件；绝对路径、普通文件、仅 owner 可读写
export OPENCONTEXT_OWNER_TOKEN_FILE=/absolute/private/owner-token
export OPENCONTEXT_DATA_ROOT=/absolute/private/new-data
export NODE_ENV=production
export PORT=4310
node scripts/preflight.ts
node --max-old-space-size=512 apps/server/src/main.ts
```

不得同时配置 OWNER_TOKEN 与 OWNER_TOKEN_FILE。秘密文件不允许末级 symlink、group/world 权限或超限；最多256 ASCII字符，可带一个尾部换行。生产入口不生成或打印秘密，只输出受审错误码。环境秘密仍兼容，但服务日志/环境读取权限应由部署操作员控制。Feishu 的明确环境 secretRef 解析保持原契约，不自动发现凭据。

最小健康验证：公开 GET /api/health 为存活信息，不能代替带 owner 的 GET /api/readiness；后者核验存储、索引、审计、调度器。先检查两者，再使用合成空间的固定 search/read 与权限负例。异常时不要删锁或数据库。信号 SIGINT/SIGTERM 开始停止领取并取消原生工作，再排空已接受 HTTP 请求；完成后关闭审计及单写者锁。OPENCONTEXT_SHUTDOWN_TIMEOUT_MS 默认15000，允许100–60000。关闭期限 timer 保持 referenced，直到成功/失败清理；即使 socket 已关闭且 close hook 只有悬挂 Promise，也不能提前当成功退出。超时以 SHUTDOWN_TIMEOUT 和 exit1 终止，可能留下 running 任务；新 incarnation 把它们重新排队并递增 fencing，提交门禁拒绝旧执行结果。恢复不能保证外部副作用 exactly-once，也不能中断阻塞事件循环的同步 native 代码。进程生命周期由前台终端或操作员服务管理器承担，本实现不安装自启。

生产启动前要求实际 V8 heap limit 至少256MiB，文件系统可用空间至少64MiB；OPENCONTEXT_MIN_FREE_BYTES 可上调，不可下调底线。准入失败发生在创建/获取数据写者前；它们不是持续容量监控或磁盘配额。Node --max-old-space-size=512 仅限制 old heap，RSS、CPU、native分配和磁盘仍须 OS 配额与告警。既有 body/任务/插件并发等应用预算继续生效，不表示完全隔离。

## 容器与 Linux 服务示例及支持矩阵

[Dockerfile](../deploy/Dockerfile)、[Compose](../deploy/compose.yaml)、[systemd unit](../deploy/opencontext.service) 是仓库示例，没有在用户 Mac 启用服务或修改网络安全设置。Dockerfile 的 build context 必须是上述白名单发行目录；操作员从仓库取 Dockerfile，显式提供经核验 digest 的 包含Node24.19.0和Git的基础镜像，不使用猜测 hash；官方 slim Node镜像通常不带Git，不能直接当此受审基础镜像。pnpm11.19.0固定安装、运行依赖冻结且禁 scripts。此阶段没有镜像签名/SBOM或离线 registry 保证。

Compose 使用预构建受审 image、127.0.0.1 发布端口、只读根、丢弃 capabilities、768MiB/1CPU/128pids 和有限 tmpfs。容器内部显式0.0.0.0需 OPENCONTEXT_PUBLIC_ORIGIN HTTPS origin，实际 TLS reverse proxy 由操作员另行验收；origin 配置不会自动安装 TLS。私有 data 目录和 owner 文件由操作员提前准备为 uid1000、目录0700/文件0400或0600；外部 bind secret 是只读，不内嵌入 image/Compose。不可给第二个实例同一 data mount。Git 工作区/大导入消耗持久数据卷，必须独立磁盘限额；64MiB tmpfs不是数据卷限额。

systemd 示例要求操作员已有 Linux 用户、绝对 Node路径、外部 EnvironmentFile 指向 owner 文件和持久数据路径，20秒停止预算大于默认15秒应用期限；只在 /var/lib/opencontext 可写，768MiB/CPU/pids 为示例限制。不要在 Mac 安装或 enable 此 unit，也不要把静态文件检查当 Linux 运行证据。

| 路径                          | 本批支持/验证方式                                  | 保留限制                                                            |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| Mac Node24.19.0 + pnpm11.19.0 | 实际隔离冻结生产安装、前台启动、信号/重启/失败检查 | 单机预览，无自启、长稳或工业SLO                                     |
| Linux Node24.19.0             | 可审阅相同发行入口和 systemd 示例                  | 本机未执行 Linux 服务/cgroup，需目标机验收                          |
| Docker/Compose                | 静态资源/卷/入口配置示例                           | 本执行器无 Docker/Podman/nerdctl；镜像 build/run 未测，不算部署通过 |
| 多写者/共享网络文件系统/HA    | 不支持                                             | 不得绕过锁或多副本写同库                                            |

升级/回滚仍按下节停写、完整快照、另一个不存在目录执行；发行目录与数据路径分别切换。相同 schema 的补丁发行也先备份，保留上一份 manifest/锁/完整程序。schema2数据不得交给schema1旧程序；回滚到旧程序必须同时恢复兼容的预升级快照，保留新实例期间写入/授权证据。不要用复制新 src 覆盖运行中的旧 release 代替停机验收。

## 停机升级与切换

正常停止所有该目录的写者并等退出；保留旧release、授权变更记录和原数据目录。离线命令应在没有OPENCONTEXT_QUERY_TOKEN的操作员环境执行，不能用reader身份授权维护。

```sh
pnpm admin diagnose STOPPED_OLD_DATA
pnpm admin backup STOPPED_OLD_DATA NEW_SNAPSHOT
pnpm admin verify NEW_SNAPSHOT
pnpm admin upgrade NEW_SNAPSHOT NEW_SCHEMA2_DATA
pnpm admin diagnose NEW_SCHEMA2_DATA
```

NEW_SNAPSHOT/NEW_SCHEMA2_DATA及后述ROLLBACK_DATA必须不存在，父目录须已存在。预检对schema1报告upgradeRequired，不直接start。升完只给新release提供NEW_SCHEMA2_DATA；旧目录仍停写。启动并核验原head/fileId/revision/citation/hash、权限与缺口告警，再明确切换受控客户端；只有这一验证成功才恢复共享入口。旧token默认失效；操作员对照最新来源撤权/删除记录，再显式发放最小project token。实例没有自动授权同步，不能让模型决定权限。

## 回滚

停止新实例和入口，保留失败现场与新版本期间的授权/写入/审计证据。恢复预升级快照只回到备份时点；新增提交不会自动合并，RPO由备份时点决定，不能宣称零丢失。

```sh
pnpm admin verify NEW_SNAPSHOT
pnpm admin restore NEW_SNAPSHOT ROLLBACK_DATA
pnpm admin diagnose ROLLBACK_DATA
```

schema1快照恢复成schema1；用受审兼容schema1旧release启动该新目录，新schema2程序会拒绝它。先复核最新撤权/删除与缺口，旧reader已默认吊销；明确发新token后才切换入口。无法从旧快照知道之后的成员/来源撤权或法规删除。若要重新前进，再从schema1快照做新目录upgrade，不能复用隔离失败目标。备份未加密/签名，只有可信本机快照；hash不证明来源可信。

## 支持边界、预算与负载门槛

现阶段支持等级仍是受控开发预览。已有硬预算：单机单写者；普通body64KiB、导入正文1MiB、SDK响应16MiB、Git30秒/文本8MiB、诊断4并发/15秒、任务队列100、audit pending10000/批100、离线快照512MiB/单文件128MiB/20000文件。无OS磁盘/CPU配额，不能把应用预算称系统资源隔离。

本批drill:load只承诺验证一个短实验：2空间、1可信来源、50文件/100版本、4并发、200次真实loopback请求（160搜索+40历史固定读）、30秒请求预算、采样进程RSS不超过512MiB、局部p95不超过1000ms、意外失败0及权限/readiness正确。长正文搜索受4096字符excerpt预算约束，本实验精确要求8条/4096字符而不是假设limit50总能返回50。结果记录实际机器与数字；不能把200次或单机延迟当工业级SLO。超过此已测规模需独立容量验收，不能宣传5000文件或持续4并发生产支持。

本机已顺序重复5轮，共1000请求，意外失败0，各轮p95为16.62–38.66ms，采样RSS为199720960–206028800字节；这是短实验波动，不是长稳。夹具使用重复正文并受内容去重影响，不能代表不同正文的大规模语料或冷缓存负载。

下一阶段负载验收计划：先扩大不同正文/冷热缓存样本，再逐级500/2000文件、4/8并发；仅获操作员资源预算后在独立部署做1小时/24小时稳定性、磁盘增长、撤权风暴、sink失败恢复、备份/升级并行拒绝和断电/RPO/RTO。每级定义停止条件（错误率、延迟、RSS、磁盘上限），不在用户Mac无界加压。真实上游分页/限流与模型依赖不在合成负载中。

## 可追踪生产验收门禁

| 门禁            | 当前证据                                          | 仍阻塞/下一验收                        |
| --------------- | ------------------------------------------------- | -------------------------------------- |
| 文件/授权契约   | 固定版本、当前来源/project gate、本地回归         | 团队身份与上游ACL撤销                  |
| 发行兼容/回滚   | schema2写门禁、schema1新目录升级、真实ce2隔离回滚 | 完整历史发行矩阵、旧程序部署隔离       |
| 私有启动/供应链 | 冻结首装、禁安装脚本、preflight/check             | SBOM/签名/完整安全扫描/保护门禁        |
| 审计            | 关键事务意图、重放/缺口确认、离线结构校验         | 真操作者、独立防篡改sink和故障存储告警 |
| 数据保全        | 停写hash快照、仅新目录恢复、旧reader撤销          | 加密/保留擦除、物理断电、生产RPO/RTO   |
| 资源和可靠性    | 明确应用预算、短合成负载                          | OS全出站/pack磁盘配额、长稳/容量/HA    |
| 入口与秘密      | loopback、token摘要/secretRef                     | 真实TLS/IdP/KMS/轮换/速率限制          |
| 真实集成        | 飞书mock、MCP协议                                 | 限定真实飞书/认证模型授权与验收        |

这些门禁的代码、合成实测、真实环境实测分别记录；不能用测试数量或与mem0功能相似替代。新批次仅本地提交，无远端CI或公开发布结论；[产品矩阵](PRODUCT_READINESS.md)持续跟踪剩余P0。

## 不完整状态的拒写诊断

`SCHEMA_INCOMPLETE` 表示已有 schema2 控制库缺失必需表、列、标记或约束。停止实例并保留原目录和诊断证据；使用受审的完整停写快照恢复到新目录，再核对固定版本和审计账本。不能通过补表、删除库或手改 schema/audit 标记来消除错误。仅新的空库允许初始化，旧合法 schema1 仍走显式新目录升级。

数据库、authority、WAL/SHM 文件及父目录的符号链接被 `UNSAFE_SYMLINK` 拒绝；硬链接/非普通文件被 `UNSAFE_FILE` 拒绝。使用普通私有目录和文件；保留 `.restore-incomplete` 隔离目录，不能绕过标记启动。`CORRUPT_HEAD`/`CORRUPT_REFERENCE` 表示 head manifest、当前文件或历史行引用不一致，备份校验与恢复拒绝该快照；保留证据并选择已验证完整的快照，不自动重建丢失内容。

若 control.sqlite 缺失且数据根目录非空，启动以 `DATA_ROOT_NOT_EMPTY` 拒绝，且不新建控制库或 authority。保留原内容并从已验证联合快照恢复至新目录；不能让空控制库掩盖丢失的索引、授权和账本。
