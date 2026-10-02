# 私有部署预检、安全边界与演练

版本：0.1.0-preview。已实现受控单机私有运行，不是企业生产就绪证明。前置条件：可信操作员、macOS/Linux本机持久磁盘、Node24.19.0、pnpm11.19.0、Git；准备真实环境之前先执行合成演练。数据流向：正文、历史版本、控制库和checkpoint只进入明确的数据卷，API/SDK/MCP只返回当前获准的固定版本；依赖审计只向官方npm registry发送依赖名/版本，不上传源码。成功判据：首装、私有启动、兼容预检、固定引用和拒绝矩阵通过；TLS、SSO、真实飞书/模型另有live gate。

## 可重复首装与启动

从已审阅源码目录开始；不要复制其他目录的node_modules。以下命令不会放开依赖安装脚本。

```sh
node --version
pnpm --version
git --version
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm docs:build
pnpm drill:deploy
pnpm drill:restore
```

drill:deploy只复制明确Git文件清单到新的临时目录，使用空npm用户配置、全新本地依赖store冻结安装，构建后实际启动私有server并调用HTTP/CLI；合成旧标记库升级后head/固定原文不变，未知schema预检拒绝且control DB hash不变。drill:restore实际执行备份/校验/新目录恢复和引用/撤权测试。两者不接受真实数据路径或凭据，结束只清理自己创建的临时目录。不是Docker、systemd或云部署。

真实私有操作前，由用户在私有环境提供**已有**32–256字符可见ASCII owner token；无空白/换行。不得粘贴到参数、日志、截图或仓库。选取自己拥有的绝对路径数据卷，父目录须存在，数据根权限0700。新目录可以不存在或为空；既有目录必须包含可校验控制库，预检拒绝其他混杂目录。不要把源码、HOME或共享可写目录当数据卷。

```sh
export NODE_ENV=production
export OPENCONTEXT_DATA_ROOT=/absolute/private/opencontext-data
export PORT=4310
pnpm preflight
pnpm start
```

owner环境变量由操作员事先私下设置，此例不创建/打印凭据。preflight检查运行工具版本、安装脚本策略、Web构建、路径/链接/权限和停写数据库兼容性；输出脱敏JSON，失败非零，未迁移控制库。实例存活会拒绝停写预检，不能删authority文件绕过。start只监听127.0.0.1；Ctrl+C正常停止；本实现不配置防火墙、服务自启或用户Agent。production环境标记不替代本页门槛；不要因它存在宣称enterprise ready。

## 数据卷、单写者和升级

同一控制库只能有一个Catalog写者；同机SQLite authority锁不是多节点/NFS锁。持久卷必须包含control.sqlite、content历史blob/revision/commit和plugin-state，不能只留最新正文。迁移前正常停服，按[备份恢复](BACKUP_RECOVERY.md)建立可信完整快照，再对停写目录执行preflight。

当前写者仅接受storage_version=2；停写工具可校验已知schema1/无版本完整形状，但preflight报告upgradeRequired，新程序启动拒绝。演练通过停写备份→新目录显式upgrade后再启动，未验收所有历史发行版本。未知版本、缺对象/checkpoint、损坏或不安全路径均拒绝。预检不会静默修库、跳过校验或删除数据。若索引未就绪，先看稳定依赖code、正常启动重建outbox并等待owner readiness，不要手改内容/授权表。

更新程序、冻结安装和构建须在独立源码目录进行；保留数据卷与owner秘密。恢复仅创建新目录，默认撤销全部旧reader token。快照无法知道之后的来源撤权/法规删除；owner须对照当前授权和删除记录，再显式发放新项目token。已复制字节无法远程收回。完整跨版本迁移、回滚、加密备份、备份保留擦除、HA和物理断电演练仍缺失。

## TLS反向代理前置条件

任何远程试点先由操作员准备可信TLS终止代理、证书验证和受限入口；后端始终保持loopback，不直接转发明文端口。本批未安装代理、签发证书或改变OS设置。默认仅接受localhost/loopback Host；若已有受控TLS代理，可明确提供单个HTTPS origin。

```sh
export OPENCONTEXT_PUBLIC_ORIGIN=https://context.example.invalid
pnpm preflight
pnpm start
```

example.invalid只是占位符；不得当成已部署域名。代理须把浏览器原始Host和Origin保留到127.0.0.1:4310，配置值须与用户访问的HTTPS origin精确一致。应用拒绝该主机的HTTP Origin、其他Host、userinfo/path/query/fragment；不信任X-Forwarded-Host/Proto/For来授予权限。启用此配置后session cookie带Secure、HttpOnly、SameSite=Strict；API/MCP仍必须携带当前有效凭据，不能把代理登录自动映射成owner。

代理另需配置请求体/连接/速率限制、超时、MCP POST透传和日志脱敏；不要记录Authorization/Cookie/请求正文。API健康与Web构建探针独立；owner readiness不是公开探针。上述origin/cookie/转发头拒绝已通过本机HTTP实验，真实TLS链、代理配置、跨浏览器cookie和SSO尚未live验收。框架建议见[Fastify反向代理指南](https://fastify.dev/docs/latest/Guides/Recommendations/)和[超时选项](https://fastify.dev/docs/latest/Reference/Server/)。

## 已验证的安全与规模界限

| 边界      | 本批实际实验 / 限额                                                                                          | 实际限制                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 权限      | 50文件、两版本；REST/SDK/CLI/MCP跨project拒绝；13类管理入口reader403；撤来源后历史read404/空检索，撤token401 | project是当前workspace边界；没有团队/成员或逐来源角色           |
| 错误      | MCP缺blob不再泄露本机路径；任意大写原生异常/连接结果不再变成持久/公开秘密码；SDK invalid JSON/任意错误码脱敏 | 可信native插件本身仍拥有进程权限；不是第三方沙箱                |
| 文件      | 静态构建拒绝内部链接/硬链接/非普通文件，8MiB上限；private数据根0700，源/备份路径拒绝测试                     | 同OS账号恶意写者的TOCTOU/磁盘配额隔离未提供                     |
| 输入/响应 | 普通HTTP body64KiB，import独立2,105,344字节外壳/1MiB正文；MCP query300字符/limit50；SDK解码响应16MiB上限     | 超限拒绝；无分页的tree/历史增长仍需容量规划                     |
| 超时      | HTTP完整请求接收10秒、连接20秒、keepalive5秒；SDK默认15秒，可缩短至10毫秒；真实挂起loopback请求取消          | 同步CPU/SQLite/FS审计不能靠计时器抢占；不算负载SLO              |
| 并发/队列 | 实测4个连接诊断并发，第5个429；诊断15秒deadline；100个queued/running任务，第101个429，重复入队幂等           | 仅诊断和任务 admission有界；不是所有HTTP请求的全局并发/速率限制 |

忽略取消的native连接诊断超时后仍占其槽位，直到真实调用结束，防止连续超时生成无限后台工作。已知合作式插件取消可释放槽位；不可信代码的CPU/网络隔离需要OS沙箱。Git已有30秒/字节/文件预算，但DNS重绑定/出站私网限制、pack磁盘quota仍是公网P0门槛，不因本批测试通过而移除。

## 依赖审计与供应链

```sh
pnpm audit --json
```

使用仓库既有官方pnpm11审计，查询npm registry的bulk advisories；不会上传源码、运行数据或私人会话。本批报告0个已知info/low/moderate/high/critical漏洞，锁定依赖无需兼容安全升级，未用force/override绕过，也未安装扫描器。冻结安装确认锁文件hash不变。结果有时间边界，0不是“没有漏洞”或恶意包签名证明；完整SAST、SBOM、签名、受保护CI门禁和持续漏洞响应仍需后续。流程依据[官方pnpm audit说明](https://pnpm.io/cli/audit)。

## SSO/RBAC选择与live gate

建议下一批先确认用户/团队/空间共享边界，再选OIDC适配器；后端主体改为稳定subject与space owner/reader关系，token映射最小项目scope，REST/MCP共用同一authorize gate。保留fileId/revision/current-source门禁与撤销，避免建第二套权限缓存。需要决定：个人实例还是多人组织、空间成员谁管理、逐来源限制是否必要、匿名入口是否永远关闭、代理与IdP谁可信。

受控个人实例可先保留现有owner/reader模式；团队实例须完成上述决策、身份/撤销/审计矩阵后才开放。不能简单把所有SSO用户换成owner，也不为企业标签重写文件/插件架构。真实飞书群权限/撤权与认证模型采用仍停在用户明确授权后的live gate；本批不创建凭据或修改真实Agent配置。详见[产品就绪矩阵](PRODUCT_READINESS.md)。

连接器当前新增DNS全部答案校验、实际连接pin与0重定向策略；保留OS隔离门槛。控制库新增有界审计，owner导出与readiness故障降级，非防篡改。具体实测边界见[出站与审计](EGRESS_AUDIT.md)，团队single-tenant提案见[团队身份决策](TEAM_IDENTITY_DECISION.md)。

新schema2写入版本门禁与旧release隔离回滚、预算和可追踪生产门槛见[可执行runbook](PRODUCTION_RUNBOOK.md)。
