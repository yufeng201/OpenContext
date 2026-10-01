# 产品与企业就绪矩阵

状态：**受控本机开发预览，不是生产 ready**。文件系统核心保持稳定身份、不可变版本、当前授权、出处和受控发布；接入方式围绕这些契约扩展，不建立旁路。这里记录实现事实与下一阶段验收边界，不承诺与其他记忆产品功能等同。

优先级：P0 是对不可信用户/公网开放前必须解决的门槛；P1 是下一批可运行的本机接入和文档增量；P2 是部署与规模化能力。尚未实现项不能因文档或测试 fixture 存在而勾选。

| 能力                  | 当前实现和实测                                                                                                                                  | 缺口 / 优先级                                                                          | 自动验收方法                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 文件核心              | stable fileId、immutable revision、固定引用、SQLite事务/outbox、fence/CAS、人工所有权保护；业务故障测试                                         | 完整delta、纠正/提升界面；P2                                                           | catalog/application事务、过期worker、撤权、失败不发布测试       |
| 文件授权              | owner和单project只读token；API/MCP每次请求重验；跨项目隔离与撤销测试                                                                            | SSO/OIDC、细粒度RBAC、组织/成员/团队模型不存在；P0                                     | 50文件/两版本REST SDK CLI MCP拒绝矩阵，13类管理入口reader403    |
| REST                  | 实际Web使用项目、binding、任务、tree/search/read入口                                                                                            | 查询OpenAPI子集已有；对外稳定API版本、完整response schema、分页、完整错误/预算契约；P1 | HTTP契约和跨项目拒绝，不依赖Web                                 |
| MCP                   | HTTP search/read/tree，官方客户端协议测试和显式Codex RPC传输                                                                                    | 模型自主调用与带引用回答未验收；P1                                                     | synthetic MCP search→固定read→citation；真实模型另需授权        |
| CLI                   | 只读readiness/projects/tree/search/read CLI；离线操作员backup/verify/restore/diagnose、非零错误码；真实隔离HTTP验收，无持久配置/写命令          | 发行安装包、配置向导未提供；P1                                                         | 安装后health/tree/search/read，失败退出码，无token参数/日志泄漏 |
| TypeScript SDK        | 源码查询SDK复用contracts，固定读取/撤销/跨项目实测；私有包未发布npm                                                                             | response运行时schema校验、稳定兼容契约；P1                                             | 与真实隔离server调用tree/search/read；拒绝、固定版本一致        |
| Python SDK            | 无                                                                                                                                              | 后续从同一契约实现源码查询客户端、独立安装/导入；P2                                    | Python标准库客户端对真实server及401/跨项目/固定read             |
| Codex/Claude Code接入 | 手工MCP说明；主动导入合成JSON；Codex显式RPC实测；Claude客户端未装                                                                               | recall skill、可选hook、导出工具/安装器未交付；P1                                      | 隔离HOME配置生成/解析，默认不改用户设置；实际认证另验           |
| 安装                  | pinned Node24/pnpm，冻结锁安装、Web构建；Linux CI配置与macOS本地验证                                                                            | 已有首装/私有启动/preflight合成演练；正式容器/初始化向导、Windows验证；P1/P2           | 干净克隆安装→构建→隔离demo→第一次检索                           |
| 升级/迁移             | Git-only legacy binding锁迁移、旧pending run显式失败；storage_version=1与未知版本写前拒绝、停写兼容预检、未知版本控制库不变实验；schema版本检查 | 完整发行版本迁移/回滚矩阵和操作工具；P2                                                | 旧版合成库升级、失败回滚、未知版本拒绝                          |
| 备份恢复              | 停写排他锁、SQLite backup与content/版本/plugin-state联合hash/版本快照；仅新目录恢复；默认撤销旧reader                                           | 在线快照、加密/签名、物理断电和生产RPO/RTO未做；P2，生产前门槛                         | 停机/一致快照恢复到隔离目录，引用hash/ACL/任务/游标比对         |
| 密钥管理              | startup模式隔离；reader token摘要存储；飞书server secretRef，Web不输入秘密                                                                      | KMS/轮换/审批/多租户密钥隔离；P0                                                       | 撤销与模式拒绝；未来轮换/不可逆存储/日志扫描                    |
| 来源撤权              | binding revoke后源与派生不可读；MCP/历史read和索引测试；Web轮询清理                                                                             | 上游权限变更无通用持续发现；不能收回已复制字节；P0                                     | 源撤权与已打开固定版本、stale search、跨空间测试                |
| 保留/删除             | source同步完整删除、导入删除、tombstone与历史引用语义明确                                                                                       | TTL/法规删除/物理清除和备份删除策略；P0                                                | 删除不泄漏检索；未来保留/擦除/备份策略测试                      |
| 审计                  | durable任务/来源状态、commit/固定引用；有界结构化主体/动作/目标/request-job审计、owner导出/敏感值排除；非防篡改                                 | 真实操作者、事务outbox、独立防篡改sink/告警、完整擦除保留；P0                          | 请求→操作者→决策→对象记录，敏感值脱敏与不可篡改验证             |
| 插件开发              | 静态可信registry、JSON Schema、实例/包digest锁、host输出门禁；通用binding集成                                                                   | 动态安装/签名/依赖闭包、第三方隔离/沙箱不存在；P0/P2                                   | 参考PLUGIN_DEVELOPMENT；漂移、越界、部分输出、撤权拒绝          |
| Git路径/网络安全      | HTTPS公共域名443、DNS全部答案拒私网/元数据、连接pin与0重定向；production禁测试root；路径/字节/时间预算                                          | 应用pin未证明完整DNS rebinding隔离；无OS全出站沙箱/pack配额；P0                        | 当前拒绝fixtures；未来网络策略/资源配额与攻击测试               |
| Web可用性             | 目录树/面包屑/筛选/固定预览、版本/来源、空间切换；弹窗焦点/取消；窄屏回归                                                                       | Firefox/WebKit、完整无障碍审计；P1                                                     | 14原浏览器回归+3readiness验收；短视口几何断言                   |
| 文档网站              | 12页本地文档站、查询OpenAPI、llms.txt；构建、桌面/窄屏和链接/路径检查通过                                                                       | 公开部署、完整API reference自动生成；P1                                                | 站点构建、内部链接检查、示例真实HTTP调用；不自动公开部署        |
| 可观测性              | health存活；owner readiness依赖完整性审计、脱敏故障码、request ID；离线diagnose                                                                 | 结构化指标/trace/告警、SLO和低成本探针；P2                                             | 对象损坏、索引lag、失败任务注入；不能把health当健康审计         |
| 可靠性/规模           | 单机authority锁、重启恢复、事务故障、预算测试                                                                                                   | 诊断4并发/15秒和队列100已实测；HA、物理断电、全局压测/容量与恢复目标；P2               | 多进程/故障注入；未来负载曲线/磁盘配额/恢复演练                 |
| 扫描/供应链           | pinned依赖、忽略安装脚本、静态边界和有限秘密检查；CI check入口                                                                                  | 官方pnpm审计已执行0已知漏洞；完整秘密/SAST、SBOM、签名与持续漏洞响应；P0               | 必需检查不可删除；未来扫描留真实结果和例外期限                  |
| 飞书真实E2E           | 注入官方形状响应的本地mock全链路；缺secret与撤权测试                                                                                            | 真实群权限/分页/撤权未验收；P1授权后                                                   | 限定测试群同步→候选→固定引用，凭据不进仓库                      |
| 模型Agent E2E         | 确定性加工和真实本地MCP；未认证模型不算成功                                                                                                     | 登录、模型工具采用/引用正确性及Claude真实客户端；P1授权后                              | 用户指定测试账号/源，真实模型search/read→有依据回答             |

GitHub实际仓库状态：既有工程CI已在main合并提交通过；main当前未启用分支保护，未发现启用的ruleset。浏览器CI提案因现有OAuth缺workflow scope未提交；本地17项真实浏览器回归通过。企业发布前还需明确必需检查/审阅策略，不能把已有CI当成受保护合并门禁。本轮未改仓库权限或保护设置。

## 下一批可交付边界

独立功能分支已交付查询OpenAPI子集、只读CLI、TS查询客户端、接入指南及本地可构建文档站，等待审阅；Python SDK后续复用同一契约，避免多语言同步漂移。复用现有授权API和固定revision；不发布npm/PyPI、不绑定域名、不写用户Agent持久配置。默认hook关闭，skill安装须显式目标与确认。先以合成数据跑跨语言HTTP与CLI契约，当前增量已实现停写备份/校验/新目录恢复/readiness与合成演练；随后做完整迁移与部署硬化。生产开放必须补齐上述P0门槛，不能用“类似某产品”替代具体验收。

## 合入验证口径

`pnpm check`包含格式、lint、类型、文档、边界、skill、有限秘密检查、harness、业务测试和Web构建。浏览器另跑真实隔离fixture；readiness用例要求带docs/architecture/decision.md的合成多级仓库，不能缺fixture改skip。合入提交的实测结果记录于PR和CI；本文件的未来自动验收方法不是已经通过的测试。全部验收不需要真实账号、付费模型或私有会话。

本批安全与部署证据、TLS尚未live验收及SSO/RBAC建议见[部署安全](DEPLOYMENT_SECURITY.md)。不将零已知依赖漏洞、单机规模实验或production环境标记等同企业就绪。

本批应用出站与有界审计详见[出站与审计](EGRESS_AUDIT.md)；下一阶段建议single-tenant团队，选择及待确认项见[身份决策稿](TEAM_IDENTITY_DECISION.md)，尚未接IdP。
