# 关键变更的事务审计与故障策略

状态：受控单机预览。本批修复关键业务SQL提交与HTTP事后审计之间的崩溃窗口。仅本地SQLite sink，不接外部审计系统、不改OS、不删除用户数据；故障实验使用合成库、子进程和临时目录。

## 威胁模型与保证范围

在当前软件、单个Catalog写者、本机可靠持久盘和SQLite WAL/synchronous=FULL前提下，进程可在任意点退出、请求响应可丢失、本地sink可失败或积压。对于下表范围：**业务效果和固定审计意图同事务提交或一起回滚**。已提交意图在投递完成前不因超龄、重试失败或队列裁剪而删除；owner可单独查看pending。禁止把HTTP响应是否到达当作事务是否提交的证据。

| 原子覆盖的实际操作    | 同事务记录                                                            |
| --------------------- | --------------------------------------------------------------------- |
| 创建空间/来源         | 主体、project/binding ID、request ID                                  |
| 来源撤销              | active门禁、依赖失效与任务撤销、source.revoke意图                     |
| 创建/撤销reader token | token UUID、空间和主体；不存token值                                   |
| 导入登记/替换/删除    | active selector/CAS与import UUID；不存文件名或正文                    |
| 新任务入队            | 冻结执行引用、task.enqueue意图及job/request关联                       |
| 新内容commit发布      | head/版本/commit/CAS/index outbox与content.publish意图及job/commit ID |

直接受信Catalog调用没有HTTP身份时记system；API携带服务器已认证主体，不接受客户端伪造request ID。来源重复撤销、同内容导入、已有queued/running入队和已完成相同commit按既有幂等/CAS规则不新增相同业务效果；若是新的请求尝试，可另有best effort请求事件。重复创建token不是幂等操作，响应丢失后不能恢复明文token；应以已提交token UUID审计并撤销未知结果，不能声称所有HTTP请求exactly-once。

**未覆盖同事务保证**：固定读/搜索/拒绝、session登录退出、导出/retry的请求日志、worker claim/heartbeat/fail/noop结果、启动迁移和离线backup/restore/环境owner配置。它们不应被描述为已提交关键变更审计。事件`guarantee=committed`指与所列变更一起持久化的意图；`best_effort`指独立记录，崩溃窗口仍存在，旧记录缺字段默认best_effort。读取不会因日志失败变成假装未读；只读日志已丢失不能重造。

文件blob和可信插件checkpoint在SQLite外，失败可留未引用的私有对象；本批不删除这些对象或保证跨文件系统原子性。物理断电、损坏/丢盘、NFS/多节点、回滚数据库到旧快照、同OS/DB管理员篡改不在保证内；仍无外部不可篡改/合规保证。

## 本地事务outbox

`audit_pending`与控制库同事务保存有界、经TypeBox校验的固定字段事件。仅UUID目标（新增commit ID）、主体/机器动作/结果code/时间/请求任务关联；不保存正文、查询、名称、URL、token或任意native诊断。JSON上限2048字符（这些字段为ASCII），最多10000个pending；满队列拒绝新关键写入并返回503/AUDIT_QUEUE_FULL，变更不会部分提交。

意图写入/验证/数据库失败返回稳定AUDIT_UNAVAILABLE或既有数据库code，并回滚该操作。调用方必须识别失败：例如满队列时来源仍未撤销，不得提示撤销成功；紧急安全处置需操作员先停止共享入口并修复持久化，不能删outbox或绕过gate。应用不会自动改变OS入口。

本地投递每批最多100条：插入audit_events和删除pending在同一SQLite事务。event UUID有唯一索引，相同ID/规范序列化payload重复投递只保留一行；冲突ID/内容拒绝并保留pending，不覆盖已有审计。投递中进程退出会回滚sink插入与ACK，重启重放；已经ACK后无重复业务操作。这个保证只针对本地sink，未来外部sink须另外定义at-least-once、去重、ACK和认证。

后台每秒最多尝试一批；失败按1/2/4/8秒等退避，连续5次失败暂停自动投递，需要owner显式重试或进程重启。不循环等待清空、不无限创建后台任务、不靠删坏记录恢复。正常关键请求可促成一批有界投递；sender错误不撤销已经提交的业务效果。启动按同一批次上限恢复，积压可以跨多个tick排空。

## 健康与恢复入口

owner readiness报告audit的pending/maxPending/suspended/readGap：未投递积压为503/AUDIT_BACKLOG，sink故障为503/AUDIT_UNAVAILABLE。health仍仅存活。只读/拒绝日志失败会留下readGap告警；本机修复sink并成功投递后，owner可明确承认历史只读日志缺口，不能假称补回日志。

```sh
# 使用已有owner凭据；不打印、创建或存储token
curl --fail --header "Authorization: Bearer $OPENCONTEXT_OWNER_TOKEN" \
  'http://127.0.0.1:4310/api/audit/pending?limit=100'
curl --header "Authorization: Bearer $OPENCONTEXT_OWNER_TOKEN" \
  --header 'Content-Type: application/json' --data '{}' \
  'http://127.0.0.1:4310/api/audit/retry'
```

pending导出和retry均owner-only，reader403/无认证401；不允许客户端提供sink、路径、payload或预算。retry每次只恢复一次最多100条尝试，仍可能返回503/有积压。`{"acknowledgeReadGap":true}`只在sink已健康且pending排空时承认只读日志缺口并清除该告警，**不创建丢失事件**。恢复/retry请求本身是best effort事件。

已投递表保留最多10000条/30天，30天从本地投递时间计，以免多年pending一到sink立即超龄；旧表兼容回退原time。导出仍展示原事件时间。pending不参与该裁剪。保留上限达到较早条件会移除已投递事件；备份/导出另有保留责任，SQLite删除不等于安全擦除。导出仍用snapshotSequence高水位分页，不能将其称锁定快照。

## 兼容、备份与验收

兼容95546826旧表/记录，新增delivered_at和唯一事件索引、audit_pending、audit_format=2。未知audit_format在当前启动/停写预检中拒绝，启动不先写incarnation或迁移控制库。若旧表已有冲突事件ID会拒绝索引升级，须在备份后由受信操作员调查，不能自动删记录。**禁止降级到旧二进制写此库**：95546826没有检查新audit_format，不能宣称所有历史版本已强制防降级；完整迁移/回滚门禁仍是P0。

联合SQLite备份包含未投递意图；恢复后当前软件有界重放，原reader撤销/当前权限复核仍适用。审计不能知道快照之后的成员撤权、法规删除或OS操作，不替代原备份授权流程。

本批实际故障测试覆盖：真实SIGKILL发生在意图已插入而COMMIT前、COMMIT后和sink事务中；重复/冲突投递；意图失败回滚来源/token/import/queue与发布head；SQLite页预算造成真实SQLITE_FULL回滚；10000队列上限与重启；sink错误/circuit/owner恢复/readiness；秘密/正文不进记录。SQLITE_FULL是受控页预算测试，不是物理磁盘拔出；进程SIGKILL不是物理断电。完整check、浏览器及部署/恢复演练以本轮执行记录为准。身份/RBAC继续暂停，外部sink/OS隔离另见[出站审计](EGRESS_AUDIT.md)和[产品门槛](PRODUCT_READINESS.md)。
