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
