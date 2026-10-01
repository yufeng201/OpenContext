# 开发与验证

状态：工程 harness 已落地；首条业务切片已实现，范围见[实施状态](IMPLEMENTATION_STATUS.md)。本指南面向开发者，当前可执行启动步骤见[快速开始](QUICKSTART.md)；[USER_JOURNEYS](USER_JOURNEYS.md)是完整产品目标，不能用其拟议命令安装当前版本。先读仓库根 AGENTS.md；技术基线见 [ADR](adr/0001-engineering-baseline.md)。

## 安装与唯一检查入口

使用仓库 `.node-version` 中的 Node 24.19.0、packageManager 中的 pnpm 11.19.0。harness检查点只安装检查工具；后续业务授权已加入Web、Fastify、TypeBox与MCP SDK等实际使用依赖，无模型调用。TypeScript 5.9.3 来自项目锁文件。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

CI 执行相同两条命令；工作流文件仅提供配置，不代表已在 GitHub 运行或启用分支保护。依赖获取需要 npm registry，安装后所有现有检查不访问网络。pnpm 设置在 pnpm-workspace.yaml，安装脚本默认关闭，store/cache 位于忽略的 .cache；新增依赖若确需构建脚本，应单独审查必要包，不能全局放开。不要手改锁文件或安装未锁版“latest”。[pnpm 配置说明](https://pnpm.io/settings)。

| 命令                                     | 实际覆盖                                                                           | 不覆盖                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| `pnpm format:check` / `pnpm format`      | 工程与应用文件格式；根 README、四份既有长方案及历史档案不做批量格式化              | 文档事实正确性                      |
| `pnpm lint` / `pnpm typecheck`           | harness TS/JS、严格类型；packages/plugins/server已纳入根tsconfig，Web单独typecheck | 运行时行为与生产环境兼容性          |
| `pnpm check:docs`                        | JSON、相对链接、蓝图 TS 与场景配置类型、SQLite DDL、纯规则例子、shell 语法         | 实际 API、磁盘耐久性、调度或 UI E2E |
| `pnpm check:boundaries`                  | apps/packages/plugins 的静态 import/export/require 边界                            | 操作系统沙箱或运行时授权            |
| `pnpm check:skills` / `pnpm sync:skills` | frontmatter、规则导入、链接、命令、单源镜像一致                                    | 模型是否调用 skill                  |
| `pnpm check:safety`                      | 忽略规则正反例及有限秘密模式                                                       | 完整秘密扫描、已跟踪秘密撤销        |
| `pnpm test:harness`                      | checker 正反例、配置引用及故障 fixture                                             | 应用单元/集成/E2E                   |

当前真实提供 `pnpm test:app`（Vitest）、`pnpm build`（Web类型与生产构建）、`pnpm dev` / `pnpm start`（server）及 `pnpm dev:web`。`pnpm check`已包含业务测试和构建；浏览器用 apps/web 的 test:browser 对真实server与合成fixture运行，见实施状态。

## 干净复制验证

验证副本排除 .git、node_modules、.cache、运行数据和秘密；副本里初始化空 Git 元数据仅供 git check-ignore（不创建 commit），执行上述冻结安装和 `pnpm check`。不可从已有 node_modules 偷渡依赖。发布 harness ZIP 以显式文件清单打包，解压到根目录后可重复此流程；普通设计 ZIP 仅供阅读，不宣称可执行安装。

现有 Codex 云容器曾无法自动安装全局 TypeScript；saved environment 的安装脚本持久性没有证实。现在以项目 `pnpm install` 为明确 bootstrap，`pnpm typecheck` 使用本地依赖，不依赖全局 tsc、PATH 修改或账户设置。

## Agent 规则与开发 skill

规则唯一源为各目录 AGENTS.md；同目录 CLAUDE.md 仅写 `@AGENTS.md` 导入。Codex 项目 skill 放 .agents/skills；Claude 项目 skill 放 .claude/skills。只维护前者，后者通过 sync:skills 生成同字节镜像并在 CI 拒绝分叉。当前仅有 validate-design；没有虚构插件生成器或自动发布 skill。

官方支持手工创建带 name/description YAML 的 SKILL.md。Codex 使用项目祖先目录 .agents/skills；Claude 使用 .claude/skills，CLAUDE.md 相对导入可兼容较早客户端。Claude 原生读取 AGENTS.md 属于较新版本能力（官方说明 v2.1.277 起），因此不只依赖它。[Codex skills](https://learn.chatgpt.com/docs/build-skills)、[Claude skills](https://code.claude.com/docs/en/skills)、[Claude memory](https://code.claude.com/docs/en/memory)。

本次环境有Codex 0.159.0-alpha.3，未安装Claude。文件解析/镜像/发现路径符合官方规范。后续验收隔离安装官方Codex 0.159.2：原受保护状态目录仍启动失败；全新无凭据目录的app-server初始化及显式RPC驱动MCP search/read已通过。没有模型会话，因此不能声称两家实际会话的skill发现或模型采用已通过，详见实施状态。待云端客户端正式授权后，分别在skills列表和Claude上下文检查中确认；不改权限。没有通用skill-creator可用，采用官方手工创建路径。

不配置 Hook、approval bypass 或自动执行。Harness 的开发 skill 与产品给日常 Agent 的查询 Skill 是不同内容，后者仍按产品任务实现。

## 任务与证据

每个开发任务固定范围、对应 RF/AC/UJ、输入输出契约和成功/失败用例。先完成 [P1-001 repo→recall](tasks/P1-001-repo-recall.md)，不一次建设所有插件实现、飞书或复杂 UI。改契约同时改配置、类型与规则 fixture；变更数据库、ACL、CAS、输出保护时必须在实现层增加集成/故障注入，不能仅靠本指南或 prompt。

提交审查材料包含改了什么、真实执行命令、失败与未覆盖项、数据迁移风险。commit/push 需用户明确授权；不能据开发授权创建凭据或调用真实用户资源。测试只用临时目录/合成 repo、文档和设备；外部模型、发布和生产数据需另行明确授权。

## 飞书模拟开发入口

安装并构建后，`node scripts/feishu-fixture-server.ts`使用临时目录、loopback 4534及合成token启动真实API/Web/MCP；飞书请求由注入fetch返回合成官方响应，绝不连接真实群。配置与首条成功步骤见[飞书指南](FEISHU_CHAT.md)。真实接入使用私有owner和服务器secretRef映射；公开demo模式检测到飞书token即拒绝启动。已确认plugin-state是联合备份的一部分，忽略规则覆盖该目录；不要为重置测试而删除非本次创建的数据。
