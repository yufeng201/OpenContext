# 当前运维边界

版本：0.1.0-preview；不是生产部署指南。前置条件：可信开发者、本机磁盘、loopback服务器和合成数据。数据流向：内容文件、SQLite控制库与plugin-state留在本机；查询token发给明确指定的服务器。成功判据：重启后固定引用可读，撤销后拒绝访问；停写快照与恢复演练使用合成数据，未设生产RPO/RTO。

## 启停和升级

按[快速开始](QUICKSTART.md)选择demo或私有开发模式；两种数据目录不能混用。服务依赖前台进程，不自动安装自启。单控制库只允许一个Catalog，CATALOG_IN_USE不能靠删authority文件绕过。

升级前停止写入并保存完整一致的数据集合；锁文件冻结安装，再检查schema兼容与插件锁。现有legacy binding迁移不是完整发行迁移框架，没有成熟升级/回滚工具。不要直接把新版覆盖到真实数据上宣称兼容。

## 备份与恢复

离线管理CLI取得Catalog同一排他锁，以SQLite backup API与全部content/plugin-state生成带版本/hash的快照。只恢复到不存在的新目录；缺对象、损坏、非法路径和中断均拒绝启动或恢复，原数据不覆盖。默认撤销所有旧reader token，重新核对来源授权后发放新token。操作步骤、限额、恢复演练和未覆盖的生产条件见[备份恢复与诊断](BACKUP_RECOVERY.md)。

## 安全和健康

/api/health仅证明进程存活；owner-only /api/readiness核对DB/schema/content/checkpoint/index/scheduler，依赖失败503且不暴露正文或路径。pnpm cli readiness提供JSON与非零失败退出；停机可用pnpm admin diagnose。X-Request-Id与错误correlationId一致，但仍没有指标/告警、SLO或完整操作者安全审计。项目只读token和secretRef不能替代SSO、团队RBAC或KMS；不开放公网。

Git和静态插件是可信native边界，没有OS/网络沙箱、DNS重绑定防护或磁盘quota。完整保留/删除、供应链扫描、真实飞书与认证模型Agent E2E仍缺失。参见[产品就绪矩阵](PRODUCT_READINESS.md)，不要把单机合成测试结论扩大到生产。

首装、停写升级预检与安全审查步骤见[部署安全与演练](DEPLOYMENT_SECURITY.md)，`pnpm preflight`和`pnpm drill:deploy`不修改用户OS/TLS/自启。

连接器DNS/pin预算、审计导出分页与10000条/30天保留、失败readiness降级见[出站与审计](EGRESS_AUDIT.md)。保留OS隔离及独立审计sink门槛。
