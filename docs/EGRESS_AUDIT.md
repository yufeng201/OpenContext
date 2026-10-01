# 连接器出站边界与本地审计

状态：应用层硬化已实现，仍是受控单机预览。实验只用合成DNS答案和本轮拥有的HTTP/TLS服务；未连接真实私网、云元数据、飞书群或模型，也未修改OS网络设置。成功判据是危险地址/重定向拒绝、固定连接地址、预算和审计拒绝矩阵通过；不是网络沙箱或合规认证。

## 默认出站策略

Git仓库只接受无凭据/query/fragment的HTTPS公共域名、443端口；禁止原始IP、单标签、本地/内部/保留域名和尾点。URL解析会先归一化整数、十六进制、八进制、百分号编码IP，归一化后仍拒绝。飞书请求只接受`open.feishu.cn`或`open.larksuite.com`精确主机；消息链接、附件URL不会被自动下载。SDK连接用户明确指定的OpenContext服务（含loopback）不是服务端采集出站，继续既有查询安全规则。

每次实际联网前解析全部A/AAAA结果，任一不安全、空、矛盾或超过32个答案即拒绝，不能挑出一个公共地址来忽略同组私网答案。拒绝IPv4回环、RFC1918、链路本地、共享地址、文档/基准/组播/保留块和云元数据所在块；IPv6只允许2000::/3中的保守公共子集，排除特殊协议、文档和6to4，拒绝mapped IPv4、ULA、link-local、NAT64等。该策略允许保守误拒，列表须随[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/)和[IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/)更新审阅；不是永久、完整的路由可达性判定。

DNS最多等待2秒；失败只报告`EGRESS_DENIED`、`EGRESS_TIMEOUT`或`EGRESS_RESOLUTION_FAILED`，不向客户端回显底层解析细节。HTTPS实际socket使用已校验的单个IP，仍以原主机做SNI/证书检查，不重用共享Agent，也不继承用户代理。每个飞书重试重新解析/校验并固定地址。Git把非过期精确HOST:443地址固定给libcurl，强制TLS验证、禁proxy、并发1、重试0、禁packfile URI及重定向；总Git预算30秒、文本快照8MiB/单文件1MiB等既有限额仍生效。依据[Git curloptResolve/followRedirects配置](https://git-scm.com/docs/git-config)；本机实际Git2.50.1已在自己的TLS服务验证固定地址与302拒绝，其他Git/libcurl构建需先做兼容验收。

**重定向预算为0**：所有3xx立即拒绝，不发第二跳，也不向Location转发Authorization。未来若允许重定向，必须重新执行完整URL/域名/DNS/证书/凭据scope检查。飞书每次请求包含响应正文的10秒预算、2MiB上限（Content-Length与实际字节均检查），仅identity编码；最多3次429/5xx重试，每次延迟最多2秒；整个同步60秒，最多100页/500消息/10MiB。合作式AbortSignal终止网络；不可信native代码忽略取消仍需进程沙箱。

`OPENCONTEXT_TEST_REPO_ROOT`只用于显式合成夹具；`NODE_ENV=production`的main和preflight拒绝它，HTTP配置不能提供resolver、transport或允许私网开关。测试内部依赖注入会把传输路由到自己创建的loopback服务，不能当成生产配置范例。没有安装自定义CA或修改系统信任。

## 仍需OS隔离的门槛

应用校验和pin减少常见DNS重绑定窗口，**未证明完全解决DNS rebinding/SSRF**：原生Git的辅助/dumb HTTP/alternates行为、多构建libcurl差异、特殊路由、未来协议扩展和其他可信native插件尚无全出站强制控制；Git pack磁盘占用也不能由stdout预算兜底。需操作员准备独立低权限进程/容器、强制出站公共网规则/域名代理、无内网路由、磁盘/CPU/并发quota，做真实受控沙箱验收后才开放公网多人采集。未替用户部署这些设置。

DNS计时器不取消底层系统lookup；只阻止其结果继续发起请求。同步CPU/SQLite/文件系统仍不能被计时器抢占。不要以本页测试通过关闭产品就绪矩阵的OS隔离门槛。

Git/飞书的helper字节纳入插件package digest。旧锁定instance不会被静默改成新实现：源码升级后digest漂移必须审阅并按现有配置流程显式建立新实例/来源，旧固定引用与授权读取保留；尚无原地来源配置迁移UI。不要手改旧锁或关闭artifact gate来恢复同步。

## 默认结构化审计

控制库新增可兼容的`audit_events`表。事件仅包含版本内固定字段：事件UUID、UTC时间、主体ID/角色、机器动作、project/binding/file/revision/import/token UUID目标、success/denied/failed、有限代码、服务端request ID及可选job ID。不保存Authorization/Cookie/token值、URL、Host、IP、查询、正文、文件名、空间/来源名或native异常；无效目标字符串被归为null。当前owner主体是聚合`owner`，reader是token ID，不等于真实用户归属。

已覆盖已知API的授权失败、管理操作、来源撤销、导入/删除、REST及MCP固定版本读取/搜索、任务入队与完成。MCP工具结果在协议层记录，不能把HTTP200中的工具错误当成功；搜索内部候选读取不作为额外用户动作。服务端生成request ID，忽略客户端伪造；任务完成标为system，通过job ID关联入队请求，不声称确定具体人。只读查询也产生审计写入。未知路由、公开静态/health/OpenAPI探针不作为完整访问日志。

```sh
# 由已有owner凭据调用；示例不创建或打印真实token
curl --fail --header "Authorization: Bearer $OPENCONTEXT_OWNER_TOKEN" \
  'http://127.0.0.1:4310/api/audit?limit=100'
```

仅owner可导出；reader403/未认证401。参数`after`默认0、`limit`默认100且最多1000。首次响应带`nextCursor`、`snapshotSequence`；后续页传`after=<nextCursor>&until=<snapshotSequence>`，避免导出动作自身新增事件导致追逐尾部。每页返回`oldestSequence`，裁剪后的序号缺口可见；高水位不是保证保留的锁定快照，并发保留清理可能令页产生缺口。没有SDK/CLI审计导出命令或公开OpenAPI完整管理参考。

默认最多10000条/30天：每次追加事务清理，导出立即过滤超龄记录；实例闲置时物理旧行会等下次追加才清理。SQLite删除不保证安全擦除；备份可保留更旧记录，导出文件由操作员按隐私策略保管。尚无可配置保留/独立擦除/自动导出，不额外创建审计秘密或启用stdout日志。

这是本地可修改的审计基础，响应明确`tamperEvident=false`；同OS账号/DB管理员可改删，时间依赖本机钟，未有签名、链、独立sink、WORM或合规承诺。事件与产品变更未共用事务：崩溃/写审计失败可能留下缺口，不能当exactly-once证据。审计失败不把已完成写入误报回滚，但owner readiness降为503/`AUDIT_UNAVAILABLE`；不能继续声称审计健康。后续须定义真实操作者、事务outbox、失败时是否拒绝新管理写入、导出/告警及法定保留策略。

合成回归覆盖持久化重启、reader拒绝、历史固定读取/撤源404、job/request关联、敏感值不落库、10000/30天裁剪和审计故障readiness降级；完整检查与备份/首装演练另行记录实际结果。下一阶段身份选择见[团队权限决策](TEAM_IDENTITY_DECISION.md)。
