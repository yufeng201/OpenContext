# OpenContext

OpenContext 是插件驱动的文件上下文平台：把来源和加工产物保存为带稳定身份、版本和出处的文件，让人浏览，让 Agent 检索、读取并引用。

**当前是本机开发预览版，不是可直接部署到公网的产品。** 已实现公开 Git 文本快照及用户主动上传的 Codex/Claude JSON会话 → 文件入库 → 全文/grep 检索 → 固定版本阅读 → 确定性 Markdown 导航/显式标记候选，以及最小 Web 和 MCP。完整目标是自托管服务器加可选本地连接器；当前服务只监听 loopback。

## 开始一次本机验证

需要 **Linux 或 macOS、Node.js 24.19.0、pnpm 11.19.0 和系统 Git**。版本由 `.node-version`、`package.json` 和锁文件固定；当前不支持 Node 22。先准备这几个工具，再在仓库根运行：

```sh
git clone https://github.com/yufeng201/OpenContext.git
cd OpenContext
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm dev
```

打开终端显示的 `http://127.0.0.1:4310`，使用终端打印的**公开合成 demo token**连接。它不是秘密，只适合演示数据；不要把真实私有材料导入 demo。若当前终端已设置 `OPENCONTEXT_OWNER_TOKEN`，请选择下面的私有开发启动方式，或换一个未设置该变量的终端。

1. 创建“上下文空间”。
2. 在“来源”选择“Git 仓库”，填写公开 HTTPS 地址和明确分支，保留推荐“Markdown 导航”处理器；例如本仓库，分支 `main`。
3. 点击“同步仓库”，等任务发布完成；在“搜索”查找 `OpenContext`，打开结果核对原文和固定版本引用。
4. 点击“生成 Markdown 导航”，再搜索或浏览“文件”。来源和派生产物共用检索；这一步不调用模型。

`pnpm dev` 默认使用忽略的 `runtime-demo/`；`pnpm start` 默认使用 `runtime/`，并要求私有环境中的 32–256 字符 owner token。两种模式不能互相打开数据目录。停止后用相同模式和目录重新启动可保留数据。完整步骤、MCP 最小权限配置及排错见 **[快速开始](docs/QUICKSTART.md)**。

另一条无需模型的验证路径是[主动导入合成Session](docs/SESSION_IMPORT.md)：后台选择Codex或Claude来源、设`projectScope`、上传仓库fixture、同步并生成候选。当前候选仅提取显式Memory/Rule/Experience标记，不能当作已完成LLM经验总结；没有自动扫描、CLI导出器或AGENTS写入。

指定群采集与主题/结论/待办/需求候选已加入静态插件，见[飞书群指南](docs/FEISHU_CHAT.md)。目前只以注入的模拟官方响应完成网络适配与归档闭环验证；真实群读取仍需服务器配置限定范围的凭据，网页不接收明文 token。

## 当前能力与边界

| 已能验证 | 尚未交付 |
| --- | --- |
| Web 登录、空间、Git 来源、任务、文件与搜索 | 正式 TLS/反向代理/Compose 包与生产初始化向导 |
| Git 文本增改删、不可变 revision/commit、SQLite/outbox | 私有 Git 凭据、飞书真实群授权验收、自动历史会话采集、Companion |
| 主动上传versioned Session JSON、归一化与可引用候选 | 真实Mac/客户端导出工具、语义经验提炼、自动写Agent规则 |
| 源文件和 Markdown 产物共同召回、固定版本引用 | 向量检索、真实模型 Wiki、任意第三方插件隔离 |
| 静态可信 connector/processor 注册、通用绑定与包/配置锁 | 其余能力的可执行插件接口、动态安装/热升级、插件市场 |
| 项目只读 token、MCP search/read/tree | 日常 Agent Skill/Hook 安装器、后台本地 coding CLI 加工 |

MCP 的官方协议客户端和真实 Codex 客户端显式 RPC 传输已验证；**模型自主检索并生成带引用回答尚未验收**，需要独立的客户端认证。不要把添加 MCP 配置当成已登录模型。当前仅适合可信开发者本机试用，不开放公网，不使用 demo token 承载私有数据。

## 文档与检查

- [快速开始](docs/QUICKSTART.md)：从克隆到第一次 Git/搜索/Markdown/MCP 成功，含停止、重启与错误恢复。
- [Session 主动导入](docs/SESSION_IMPORT.md)：Codex/Claude 文件交换、范围、完整性与候选边界。
- [飞书群采集](docs/FEISHU_CHAT.md)：指定范围、服务器凭据、模拟验证与历史归档限制。
- [插件开发](docs/PLUGIN_DEVELOPMENT.md)：静态可信注册、包/配置锁和真实 binding/任务入口。
- [实施状态](docs/IMPLEMENTATION_STATUS.md)：真实支持范围、已验证层次和未实现项。
- [开发指南](docs/DEVELOPMENT.md)：工程约束、测试与本地工具；`pnpm check` 是统一检查入口。
- [设计文档](docs/README.md)：产品目标、架构、蓝图与未来用户旅程；规划内容不代表已实现。

完整恢复需要内容文件、控制数据库和飞书已确认游标引用的 plugin-state 一起备份；只复制导出正文不能恢复授权、当前版本和任务。已有停写快照/新目录恢复工具，但生产RPO/RTO、加密与保留策略未验收。凭据、运行数据、缓存和临时验收材料不要提交到 Git。

企业与接入成熟度、缺口及下一阶段验收见 [产品就绪矩阵](docs/PRODUCT_READINESS.md)。当前仅为受控开发预览。

## 本地查询接入与文档站（源码预览）

查询路径与TypeBox请求契约共用；`/api/openapi.json`是查询子集，源码TS SDK和只读CLI不存token。详见[查询接入](docs/QUERY_ACCESS.md)。`pnpm docs:build`生成14页静态文档、OpenAPI和llms.txt；`pnpm docs:preview`仅在本机4400预览。没有发布npm/PyPI或公开部署网站。停写快照和新目录恢复已实现；生产RPO/RTO、断电耐久性、加密签名、完整响应schema及真实Agent E2E仍待验收。

停写备份与恢复：`pnpm admin --help`、`pnpm drill:restore`，见[运维操作](docs/BACKUP_RECOVERY.md)。恢复只使用新目录，默认撤销旧reader token；不覆盖用户数据。

私有部署审查：`pnpm preflight`、`pnpm drill:deploy`，见[部署安全与限制](docs/DEPLOYMENT_SECURITY.md)。不自动配置TLS/防火墙/自启，仍需完成公网P0门槛。

停机升级与隔离回滚、明确版本门禁和有界负载计划见[单机操作指南](docs/PRODUCTION_RUNBOOK.md)；仍不宣称企业或工业级就绪。
