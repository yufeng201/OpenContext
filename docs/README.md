# OpenContext 设计与开发入口

本目录保留产品设计与实际开发说明。**第一次运行请从[快速开始](QUICKSTART.md)进入**；[实施状态](IMPLEMENTATION_STATUS.md)列出真实能力、验证层次和限制。当前是本机开发预览版，没有已发布 npm 包、Docker 镜像或生产部署包，不代表完整P1完成。

## 当前可运行入口

- [仓库首页](../README.md)：定位、工具前提、最短启动和当前边界。
- [快速开始](QUICKSTART.md)：Git→检索→固定引用→Markdown→MCP，含模式隔离、查询token和恢复步骤。
- [Session 主动导入](SESSION_IMPORT.md)：用户选择导出文件，区别原文、归一化和确定性候选；不扫描电脑或启动模型。
- [飞书群采集](FEISHU_CHAT.md)：限定群与时间范围、连接诊断、模拟/真实边界及归档恢复。
- [插件开发](PLUGIN_DEVELOPMENT.md)：当前静态可信 connector/processor 注册与锁定机制，区别实际接口和八类目标。
- [实施状态](IMPLEMENTATION_STATUS.md)：实现事实与未实现项；协议连通不等于模型自主调用通过。
- [开发指南](DEVELOPMENT.md)：工程检查、测试与贡献流程。

## 产品设计

- [PRD](PRD.md)：目标、编号需求、验收与阶段。
- [技术方案](TECHNICAL_DESIGN.md)：文件与控制库、插件、发布一致性和安全边界。
- [实施蓝图](IMPLEMENTATION_BLUEPRINT.md)：未来业务目录、接口、配置与规则示例。
- [用户使用闭环](USER_JOURNEYS.md)：未来部署、Agent/Git/飞书/会话接入、召回及故障恢复的目标与验收设计，不是当前安装手册。

目标产品路径是自托管初始化→导入一个文件→搜索并打开引用，无需embedding或本机worker。官方Repo Wiki预设、日常Agent Skill/Hook和后台coding CLI加工属于后续目标；当前有公开Git文本导入、主动Session JSON导入、确定性Markdown/显式标记候选与只读MCP，不把设计叙述当成现成按钮。

OpenContext 是受管理的版本化文件库。内容导出便于阅读；完整恢复权威 head、授权和运行状态需要内容与控制库联合备份。原件及各级产物共用检索 gate；人工提升保持稳定身份，纠正关系不等于 blanket authored 优先。

## 开发入口

- [DEVELOPMENT](DEVELOPMENT.md)：真实安装与检查命令、规则/skills、云开发环境限制。
- [ADR 0001](adr/0001-engineering-baseline.md)：本轮采用的最小工程默认及取舍。
- [前端架构](FRONTEND_ARCHITECTURE.md)与[UI规范](UI_GUIDELINES.md)：统一栈、状态分工、权限与版本交互。
- [首条 P1 repo→recall 任务](tasks/P1-001-repo-recall.md)：从真实插件到 Agent 可消费引用，避免一次实现全部平台。

PRD AC-01–AC-22、用户流程 UJ-01–UJ-13 仍是待实现的应用验收。pnpm check 现在同时运行工程检查、业务Vitest与Web构建；浏览器另跑真实Playwright流程。全套PRD尚未全部实现，不能用这些子集结果替代完整部署/隔离验收。

历史原稿与 checkpoint 仅留工作区，未改字节；公开源码不依赖私有归档或临时验收材料。源码以 Git 提交为准，设计阅读包与早期 harness 检查点不能替代当前实现。项目许可证与账户权限未在本轮变更。

企业与接入成熟度、缺口及下一阶段验收见 [产品就绪矩阵](PRODUCT_READINESS.md)。当前仅为受控开发预览。

新增：[查询接入](QUERY_ACCESS.md)、[核心概念](CORE_CONCEPTS.md)、[当前运维边界](OPERATIONS.md)。本地文档站使用`pnpm docs:build`/`pnpm docs:preview`，复用这些指南，不公开发布。

- [停写备份、恢复与依赖诊断](BACKUP_RECOVERY.md)：v1快照、仅新目录恢复、撤权与合成演练。

- [私有部署与安全门槛](DEPLOYMENT_SECURITY.md)：首装/升级预检、TLS前置、已复现风险与SSO决策边界。

本批连接器出站默认策略、真实合成TLS/Git实验与可修改审计基础见[出站与审计](EGRESS_AUDIT.md)；下一阶段一页提案见[团队身份决策](TEAM_IDENTITY_DECISION.md)。

关键写入审计持久性、重试/队列与owner故障恢复见[事务审计](AUDIT_DURABILITY.md)。

单机版本兼容、显式新目录升级/隔离回滚、短负载与生产门禁见[可执行操作指南](PRODUCTION_RUNBOOK.md)。
