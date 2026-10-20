# 2026-10-20 发布准备与隔离验收

本轮不是生产就绪声明。环境为原 Linux 工作区 `/workspace/oc-linux-acceptance`，分支 `feat/local-session-agent-chain`；恢复时 HEAD 为 `0697ba5a5424f4ed2f60f7625de52c0fd53841f3`，工作区干净。该提交及之前未发布成果已正常推送到开发分支并核对远端哈希，没有强推或合并 main。本轮补充提交仅增加可复现浏览器验收入口及文档，产品运行代码未修改。

## 验收结果与层次

| 项目         | 实际验证                                                                                                                                                                | 边界                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 工程基线     | Node 24.19.0、pnpm 11.19.0；完整 `pnpm check` 含 520 应用测试、18 harness、类型/边界/文档/Web 构建                                                                      | 静态规则检查不等同应用测试                                       |
| 干净安装     | 全新源码目录、冻结锁文件安装、禁用安装脚本、无借用 node_modules，实际私有服务启动/HTTP/匿名 401                                                                         | 合成 owner，未改原运行数据                                       |
| 升级与恢复   | 已知旧 schema 预检、迁移后 head/固定引用保持；未知 schema 拒绝且控制库不变；备份、校验、诊断、恢复与 CLI read                                                           | 本地单节点，不是物理断电或异地容灾                               |
| 浏览器       | 25 项全套通过；owner/reader、Git/会话/模拟飞书、Markdown、渐进读取、权限撤销、审核批准/拒绝/重试和窄屏                                                                  | Playwright + 已安装 Chromium；未运行其他浏览器                   |
| 新浏览器入口 | `test:browser:acceptance` 自动建立合成 fixture，实跑全部 25 项                                                                                                          | 不下载浏览器、不连接真实账号                                     |
| 会话加工     | 合成 JSON/固定版本 JSONL → 文件/来源凭据 → fake worker → Markdown 审核发布 → CLI/MCP 召回                                                                               | fake 可执行程序不是真实 Codex 模型；不声称提炼质量通过           |
| Agent 协议   | 已安装 Codex 0.159.0-alpha.3，独立临时 HOME/CODEX_HOME，无 auth.json，app-server initialize/临时 thread/显式 MCP 搜索与固定版本 256 字节读取                            | 模型 turn 为 0；不是模型自主调用，也不是 0.161.0 worker 实机验收 |
| Docker       | 从本轮干净发布包构建新镜像；无网络、无主机端口、只读根、uid1000、cap-drop、768 MiB/1 CPU/128 pids；真实 MCP SDK、CLI、权限、历史读取、重启 head/hash 不变，停止退出码 0 | 未重新验收 Compose、HTTPS 反向代理或系统服务                     |
| 敏感信息     | 首次推送前扫描 11 个待推送提交涉及的 114 个新增 blob，有限私钥/凭据模式无命中；13 个新镜像层及元数据检查构建 CA/代理原值无残留                                          | 不是完整秘密扫描或任意编码泄漏证明；不审计外部 builder cache     |

Docker 产品运行包来自上述 `0697ba5`，release tree SHA-256 为 `245a4a26020bf2b15ef77e988a6b76ab16baffc2b44a32bdf2960da995facdb2`；本地镜像 ID 为 `sha256:6125c9a8200592de7d6997cd163def14f3115df07448de7e71d40ae047911bbd`。没有上传镜像或公开部署。

## 可执行复验

Docker 构建与运行、实际 Codex app-server 的公开探针及完整步骤见[协议与容器复验](ACCEPTANCE_PROBES.md)。补充探针在同一本地镜像和已安装 Codex 上重跑通过；新增 3 个 harness 正反例，补充后的完整检查为 520 个应用测试与 21 个 harness。原始 18 项计数对应上表的历史验收批次。

在独立 checkout 使用已安装的受支持工具：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
OPENCONTEXT_BROWSER_BINARY=/usr/bin/chromium pnpm test:browser:acceptance
pnpm drill:deploy
pnpm drill:upgrade
pnpm drill:restore
pnpm demo:session-complex
```

`drill:deploy` 会在本次创建的临时目录重新安装依赖，需要可用 npm 网络；只在安装子进程继承已有代理/CA 配置，不把它们传给运行服务。浏览器入口和各 drill 使用合成凭据与临时目录，不能拿真实用户数据运行这些 fixture。首次生产配置应按[部署安全](DEPLOYMENT_SECURITY.md)和[运维](OPERATIONS.md)准备现有私有 owner 文件、持久目录及备份；本文不生成长期凭据。

用户的实际使用顺序仍是：[快速开始](QUICKSTART.md)建立空间和来源 → 同步文件 → 查看固定来源 → [个人记忆](SESSION_MEMORY.md)显式上传/worker 交接 → 在管理后台阅读候选并批准 → 通过[查询接入](QUERY_ACCESS.md)的只读 CLI/MCP 搜索并按[渐进披露](PROGRESSIVE_CONTEXT.md)读取固定 revision。网页不会读取 Mac 路径，未启用功能不会扫描会话，批准不会安装系统规则。

Docker 探针后续稳健性修订强制本地 Unix socket 并过滤子进程环境；create 超时后按本次唯一 label、名称和完整 ID 验证归属再清理。针对性故障测试与本地容器实跑通过，完整检查为 520 应用测试、22 harness；未修改产品运行代码。

## 已遇问题与处理

- Docker 构建环境的代理主机无法解析（`EAI_AGAIN`）：仅在此次构建传入当前环境解析出的 `--add-host`，使用已有 CA 的 BuildKit secret；未修改全局 DNS、证书或网络安全设置。修正后当前 Dockerfile 构建通过。
- 容器探针首次未显式设置 loopback，默认非 loopback 监听需要 public origin，启动退出；修正探针为 `OPENCONTEXT_BIND_HOST=127.0.0.1` 后通过。没有放宽产品的 public-origin 门禁。
- 初始临时 Agent 探针误写插件 ID，被 `UNKNOWN_PLUGIN` 拒绝；按已注册描述符改为 `org.opencontext.codex-sessions@0.1.0` 后协议流程通过。产品代码未为测试增加旁路。

## 证据与未覆盖范围

本云端证据目录为 `/workspace/oc-session-evidence/release-20261020/`，包含完整检查、两轮全套浏览器、新包 manifest、安装/升级/恢复、Agent 协议、镜像层审计、容器生命周期与推送日志。该目录不进入仓库，浏览器截图也不推送；未来环境不可用时，可用上面的命令重跑，不能把旧日志当作新版本验收。

仍未覆盖：真实飞书授权/采集、真实用户会话、真实模型计费与提炼质量、固定 Codex 0.161.0 运行时工具/沙箱效果、Windows/macOS、物理断电、多节点/NFS写者、高并发压力与生产 SLO、OIDC/组织级权限、HTTPS/Compose/系统服务的本轮部署。文件、Markdown、固定引用和插件门禁仍是核心，没有引入 TOS、向量数据库或新的长期凭据。
