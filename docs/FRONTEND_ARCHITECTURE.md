# 管理后台架构

本轮采用的开发默认，最小 Web 已实现；当前范围和验证见[实施状态](IMPLEMENTATION_STATUS.md)。关联：[技术方案](TECHNICAL_DESIGN.md)、[界面规范](UI_GUIDELINES.md)、[首条任务](tasks/P1-001-repo-recall.md)。

| 层         | 唯一默认与分工                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| 构建       | React + TypeScript + Vite，静态 SPA 与 API 同源；不另加 Next/SSR                                                           |
| 组件与样式 | Tailwind + shadcn；组件源码进入 apps/web/src/components/ui，由项目维护。首个页面锁定一个 primitives 实现；不混第二组件库   |
| 路由       | React Router；Space/project、目录、查询、筛选和固定 commit/revision 在 URL；敏感 token 永不进入 URL                        |
| 服务端状态 | TanStack Query：tree/read/search、binding/run/device/health；mutation 后按服务端确认失效缓存                               |
| 本地状态   | React useState/useReducer：弹窗、选中、未提交表单。只有真实跨页 UI 状态才加 Zustand；不存服务器实体、权限或重复 Query 缓存 |
| 表单       | React Hook Form；TypeBox 生成 JSON Schema，复用 Ajv 校验/适配器；表单表现与字段消息可局部定义，不能复制 API 业务 schema    |
| 测试       | Vitest 组件/契约；Playwright 用合成后端/临时数据跑用户流程。未有页面时不装浏览器或伪建测试                                 |

官方参考：[React](https://react.dev/)、[Vite](https://vite.dev/guide/)、[Tailwind](https://tailwindcss.com/docs/installation/using-vite)、[shadcn](https://ui.shadcn.com/docs/installation/vite)、[React Router](https://reactrouter.com/start/declarative/installation)、[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)、[RHF](https://react-hook-form.com/)、[TypeBox](https://github.com/sinclairzx81/typebox)。当前使用版本已固定在 workspace package 与锁文件；只安装实际页面使用的依赖。

## 数据与缓存边界

Query key 至少区分 server/principal 会话、Space、project scope、请求 snapshot/revision 和影响结果的筛选/预算/检索配置。当前 head 查询与固定历史引用不能复用同一正文缓存。服务器仍在返回摘要、目录、计数、citation 和正文前检查当前 ACL，前端 key 不是安全边界。

SSE 是失效通知，不能代替查询权威状态；重连重新获取任务、ACL epoch、head 与 coverage。收到撤权/401/403/退出登录先取消请求并清理相关内存缓存、隐藏内容；默认不把正文或 token 持久化到 localStorage。过期响应不得写回新会话缓存。

发布、删除、合并、人工提升和配置启用都等服务端确认，不乐观写成成功。重试沿用幂等键；CAS 冲突呈现 base/current/proposed。一次 Run published 不等于 index ready，更不等于外部网站已发布。

## 文件布局与首屏范围

当前 apps/web/src 以 app.tsx 管理小规模路由/页面与 Query providers，components/ui、api、lib 分离；styles.css 保存 tokens。后续页面增长再拆 pages/features，不先建空目录。API 类型来自 packages/contracts；浏览器不导入 server/core/SQLite/插件 host。

首条切片只做初始化、来源设置与同步状态、搜索结果和固定引用阅读。DAG 编辑器、完整插件市场、大型监控仪表盘与复杂 diff 编辑器不作为首次成功前提。
