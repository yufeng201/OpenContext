# ADR 0001：最小工程基线

状态：2026-09-30 按用户“先补 harness”的授权采用工程默认；此为harness建立时决策；后续已授权的首条实现与驱动差异见[实施状态](../IMPLEMENTATION_STATUS.md)。关联：[技术方案](../TECHNICAL_DESIGN.md)、[开发流程](../DEVELOPMENT.md)。

选择 TypeScript/Node、pnpm workspace、TypeBox/JSON Schema 单一契约。服务端按单节点 SQLite/Fastify 的既有设计推进；不因多台 Companion 就引入第二权威库。前端采用 [统一架构](../FRONTEND_ARCHITECTURE.md)，不创建另一套路由、状态缓存或 Zod API schema。

当前锁定只为 harness 所用的依赖与 Node/pnpm；应用依赖在首个模块实现时核对兼容与许可证后精确锁版。使用 ESLint、Prettier、严格 TS 与 Node 自带测试运行器验证检查工具；应用测试默认 Vitest/Playwright，harness检查点尚未安装；业务开发阶段已安装并运行。短期保留已有长文档排版，避免混入无关改动。

文件身份、版本、当前权限、持久任务/事件与内部 commit gate 是内核不变量；八类功能能力按统一插件协议开发，数据库驱动不插件化。InstanceRef 指向实例配置修订，PluginRef 指向包版本；部署配置也必须引用实例，不能绕过 grants/config/锁版。

权衡：规则与导入检查能尽早发现误用，不能证明 ACL、fsync、fencing 或隔离正确。先做一个真实 Git 插件与文件→全文/grep→MCP 闭环，再扩展后台加工/Companion；保持插件平台方向，但不为每个未来模块建空包或规则。

更改这些默认需写清理由、迁移影响和验证；不要求每个普通实现选择都新建 ADR。外部 provider、隔离平台、性能门槛和用户保留策略仍待对应模块验证。
