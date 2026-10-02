# 停写备份、恢复与依赖诊断

版本：opencontext-backup/v1，storage_version=1，Node24单机开发预览。前置条件：本机文件系统操作员、完整停止该目录的服务和外部写入者、足够磁盘空间。数据流向：本机控制数据库、内容/版本/commit、plugin-state进入新建私有快照目录，再恢复到新的数据目录；不访问网络、真实账号或用户Agent配置。成功判据：manifest与文件hash通过，恢复实例的head、固定版本正文/hash/citation和搜索一致，旧reader token被拒绝，新token仍受项目/来源权限约束。

## 边界与一致性

不是在线零停机备份。先正常停止进程并等待退出；不得删除authority锁文件“解锁”。离线命令取得与Catalog相同的SQLite生命周期排他锁，存活服务或另一备份持锁时返回CATALOG_IN_USE。锁在进程退出/SIGKILL后由OS释放；要求同一台机器、本机磁盘，不能当作多节点/NFS锁或阻止任意直接修改文件的程序。

控制库使用Node SQLite backup API复制，包含已提交WAL页；快照副本规范化为DELETE journal，避免依赖未校验的wal/shm。源库不迁移或改授权。内容保存全部历史blob/revision/commit，包含inactive导入对象；飞书快照/游标所需plugin-state一起复制。每个文件有路径、bytes、SHA256，manifest也有SHA256、格式/存储版本、部署模式和项目head。SQLite quick_check/foreign_key_check、所有引用、版本元数据、commit hash、导入对象、飞书确认checkpoint、索引generation/正文关联在完成前核对。

当前硬限额：20,000个文件，单文件128MiB，总512MiB，manifest8MiB。完整性探针也有界；重复引用会计入检查预算。这些是开发预览防滥用限制，不是已压测的容量承诺。目录包不压缩，不接受tar/zip解包路径。拒绝绝对/上级/编码路径、重复项、符号链接、硬链接及额外文件；macOS系统/var和/tmp标准别名允许，数据内部链接拒绝。未知版本或缺blob/checkpoint均fail closed。审计格式/表字段/主键/唯一索引、事件与pending语义也纳入校验；当前格式缺表/损坏拒绝，合法旧无审计库和955 ledger可迁移。合法pending/readGap会原样进入快照，离线校验允许它们，不能据此声称在线审计健康；恢复启动后检查owner readiness并显式确认持久缺口，详见[事务审计](AUDIT_DURABILITY.md)。

## 操作命令

以下命令在仓库根运行。NEW_SNAPSHOT和NEW_DATA_ROOT必须不存在，父目录必须已存在；连预先建好的空目录也拒绝。永不覆盖或自动删除现有目录。

```sh
pnpm admin --help
pnpm admin diagnose STOPPED_DATA_ROOT
pnpm admin backup STOPPED_DATA_ROOT NEW_SNAPSHOT
pnpm admin verify NEW_SNAPSHOT
pnpm admin restore NEW_SNAPSHOT NEW_DATA_ROOT
pnpm admin diagnose NEW_DATA_ROOT
```

这是离线文件系统操作员能力，不是reader token管理API。若环境提供OPENCONTEXT_QUERY_TOKEN，admin命令拒绝执行；查询凭据不能授权备份/恢复。目录的OS权限才是离线边界，能直接读数据的操作员已经拥有该数据；unset变量不能把一个无目录权限的reader变成操作员。服务没有HTTP备份/恢复写入口。

快照/恢复目录0700、文件0600。快照包含私有正文、授权摘要和游标，必须按秘密数据保管；未加密、未签名，hash只验证完整性，不证明来源可信。只恢复自己可信的快照；不要执行第三方提供的SQLite包。owner token、飞书环境凭据和Agent配置不在备份中，恢复启动需由操作员另行提供授权秘密。

## 中断和权限恢复

备份在最后保留.backup-incomplete，恢复保留.restore-incomplete；任何异常/SIGKILL后的新目录留在原处隔离，不自动删除，也不能当数据根启动。不要手动移除标记绕过校验；选择另一个不存在的目标重试，隔离目录由操作员审查后处理。完成前逐文件再次验hash，完成后fsync。原来源和快照不会因恢复失败被覆盖。

恢复保留fileId、revision、head、历史出处、binding范围和快照时的active/revoked状态；但快照无法知道备份之后的撤权，因此**默认吊销全部reader token**。用owner启动新实例，确认上游/本地来源授权后显式发放新项目token；此前撤销的来源不得自动重新启用。无法从旧快照推断之后的来源撤权或法规删除，必须人工对照最新授权/删除记录；仅有owner可读的隔离恢复不能被宣传为权限全局同步。

存储版本未知会在Catalog迁移/写入前拒绝；缺字段的旧版本只按已有兼容迁移处理。完整跨发行升级/回滚、密钥轮换、加密备份、保留/擦除和物理断电演练仍未交付。

## liveness 与 readiness

GET /api/health仍是公开存活信号，文件损坏时也可返回200。GET /api/readiness是owner-only，全部依赖通过返回200，否则503；reader收到403，匿名401。

readiness报告database（SQLite完整性/外键）、migration（存储版本/必要表字段）、storage（历史对象、版本、manifest、head、导入）、pluginState（已确认飞书checkpoint）、index（generation/outbox和索引正文/版本对应）、scheduler。只返回稳定code、数量和requestId，不返回正文、路径、SQL、token或credential。每个HTTP响应有服务器生成X-Request-Id；错误correlationId与该request ID一致，任务仍有durable run ID。客户端提供的X-Request-Id不作为权威。

```sh
pnpm cli readiness
pnpm drill:restore
```

readiness CLI需owner token在私有环境中；503输出经过共享TypeBox契约校验的依赖报告并以非零退出表示，任意错误正文不会回显。drill:restore不接受任何用户目录/凭据，自动创建和清理合成临时实例，通过真实admin backup/verify/restore/diagnose、HTTP查询CLI、固定引用和撤权演练；不调用模型或真实飞书。

探针是有界同步完整性审计，可能耗时，不应高频轮询；不是低成本负载均衡probe、OS磁盘配额、HA/SLO或完整审计平台。索引不就绪先查看诊断并按正常启动恢复outbox；未知schema、缺内容或损坏不要“修复”为忽略断言。详细缺口见[产品就绪矩阵](PRODUCT_READINESS.md)。
