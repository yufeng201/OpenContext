# OpenContext 设计与开发入口

本目录保留 2026-09-30 的 v3 产品设计，并补充最小工程 harness。已有可执行工程检查与首条业务实现，可从源码本机运行；没有已发布 npm 包或 Docker 镜像。实际入口、测试覆盖与限制见[实施状态](IMPLEMENTATION_STATUS.md)，不代表完整P1完成。

## 产品设计

- [PRD](PRD.md)：目标、编号需求、验收与阶段。
- [技术方案](TECHNICAL_DESIGN.md)：文件与控制库、插件、发布一致性和安全边界。
- [实施蓝图](IMPLEMENTATION_BLUEPRINT.md)：未来业务目录、接口、配置与规则示例。
- [用户使用闭环](USER_JOURNEYS.md)：部署、Agent/Git/飞书/会话接入、召回及故障恢复。

最短产品路径仍为自托管初始化→导入一个文件→搜索并打开引用，无需 embedding 或本机 worker。需要 Wiki 时用官方 Repo Wiki 预设；DAG/JSON 留高级配置。日常 Agent 使用 MCP + Skill，Hook 可选，后台 coding CLI 加工单独授权。

OpenContext 是受管理的版本化文件库。内容导出便于阅读；完整恢复权威 head、授权和运行状态需要内容与控制库联合备份。原件及各级产物共用检索 gate；人工提升保持稳定身份，纠正关系不等于 blanket authored 优先。

## 开发入口

- [DEVELOPMENT](DEVELOPMENT.md)：真实安装与检查命令、规则/skills、云开发环境限制。
- [ADR 0001](adr/0001-engineering-baseline.md)：本轮采用的最小工程默认及取舍。
- [前端架构](FRONTEND_ARCHITECTURE.md)与[UI规范](UI_GUIDELINES.md)：统一栈、状态分工、权限与版本交互。
- [首条 P1 repo→recall 任务](tasks/P1-001-repo-recall.md)：从真实插件到 Agent 可消费引用，避免一次实现全部平台。

PRD AC-01–AC-22、用户流程 UJ-01–UJ-13 仍是待实现的应用验收。pnpm check 现在同时运行工程检查、业务Vitest与Web构建；浏览器另跑真实Playwright流程。全套PRD尚未全部实现，不能用这些子集结果替代完整部署/隔离验收。

历史原稿与 checkpoint 仅留工作区，未改字节；独立设计包不需要它们。本次交付含五份主文档、工程指南及实施状态；单独 harness 包按仓库根布局提供规则、配置、检查脚本和必要文档，不含依赖、Git 元数据、秘密或缓存。根目录 README、项目许可证与账户权限未改。
