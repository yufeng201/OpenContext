# 开发静态可信插件

本页描述当前开发版本的插件扩展边界。产品仍是文件上下文平台：插件产生来源或候选产物，平台决定身份、版本、授权和是否发布。不要把插件接口理解为可绕过权限的脚本入口。

## 当前可替换的能力

| 能力                                              | 当前实现                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| connector                                         | `ConnectorDefinition`：受控输入对象/配置 → 完整来源文本集合                        |
| processor                                         | `ProcessorDefinition`：固定文件 revision/正文 → 完整候选输出集合                   |
| trigger / indexer / retriever / context-assembler | 调度、FTS/grep、召回门禁与片段预算仍由内建代码提供；未开放这些能力的可执行注册接口 |
| embedding / publisher                             | 尚未实现；不承诺向量、付费模型或外部发布                                           |

八类是产品目标；当前只让前两类通过同一静态注册机制执行。没有第三方市场、动态安装、热更新、跨进程隔离或通用工作流画布。插件必须经过代码审查并随服务器一起分发。

## Definition 与锁

类型在 [plugin-sdk](../packages/plugin-sdk/src/index.ts)，通用请求和锁在 [contracts/plugins.ts](../packages/contracts/src/plugins.ts)，执行校验在 [plugin-host](../packages/plugin-host/src/index.ts)。沿用 TypeBox/JSON Schema，不再复制一套 Zod 契约。

一个 definition 声明：

- `manifest`：ID、版本、协议、能力、`location: server` 和可信 native 等级。
- `capability`：当前选择 connector 或 processor；`probe`报告本机能力与限制。
- `configSchema`：运行时配置验证；`fields`给后台现有 text/select 表单渲染，不是任意插件 UI。
- `artifactPaths`：需要锁定的实际源文件或构建产物的 file URL；包括影响行为的插件文件，不能只填包名。修改未列入清单的依赖不会自动成为完整供应链证明。
- `invoke`：只返回来源/产物提案；可选 `validateConfig`做配置的附加验证。
- connector可实现`validateImport(content, config, context?)`做上传前预检；server必须await成功后才保存对象，invoke读取冻结对象时仍须复验。Session的格式/scope/已知秘密检查沿用同一parser。
- `acceptsImports`：是否接受用户主动上传的对象；connector 只可通过 host 提供的 `readImport`读取任务已冻结的对象引用。

`packageRef`标识包及版本。`packageDigest`由manifest、config schema与声明的artifact字节计算；`configHash`来自规范序列化配置；`ref`是独立配置实例的版本身份，形如`instance:<UUID>@1`。同配置可有相同hash，却必须允许两个project/binding拥有各自的实例，不能用配置hash充当全局唯一实例ID。任务固定实例身份、包digest及配置hash；权限仍由project/binding上下文决定，不依赖ref保密。注册后的源字节漂移会拒绝执行，旧任务不会静默使用新代码。digest不是发行签名，trusted-native也不是操作系统沙箱。

`StaticRegistry.prepare`先校验能力与配置，再生成锁；调度使用绑定/任务保存的锁，`resolve`和`invokeConnector`/`invokeProcessor`会再次核对。配置不兼容、包不可用、digest或实例锁变化必须显式失败，不能降级到“同名最新插件”。当前没有在线配置迁移或跨版本热升级界面。

## 输入输出规则

connector 输入是已验证配置、上一来源版本、冻结的 import object refs 与文件/字节预算。输出必须给 `sourceVersion`、`complete: true`、`files`、`renames`和`skipped`。它不能靠省略失败文件伪称完整快照。无法完整读取时抛错，正式内容保持原样。

processor 得到固定输入 commit 和精确文件 revision。输出仅支持 `mode: full`、`complete: true`：每个文件有稳定 `slotKey`、相对路径、正文和指向本次输入的 `derivedFrom`。full 成功提交才允许回收本绑定拥有而新集合缺失的旧输出；失败、取消或不完整输出不能删正式内容。人工所有权及发布 CAS 由内核保护，不因插件返回了某个路径就放行。delta 仍不是本轮实现。

host 会验证 schema、重复/越界路径、输出预算、slot 和依赖引用；`readImport`检查引用是否属于本次任务以及 hash/长度一致。发布仍需经过当前授权、fence、输入新鲜度、输出 base 和事务 outbox。插件不拿 Catalog、Fastify request 或任意数据库写接口。

## 从一个包开始

1. 在 `plugins/` 创建独立包，实现 SDK 的 definition，并依赖 `contracts`/`plugin-sdk`。参考 [Git definition](../plugins/repo-connector/src/index.ts) 和 [Markdown definition](../plugins/markdown-processor/src/index.ts)，不要复制 Coordinator 的场景分支。
2. 为配置和完整/失败输出增加单元测试。将所有决定行为的本地实现文件列入 `artifactPaths`。
3. 在 [apps/server/src/plugins.ts](../apps/server/src/plugins.ts) 的 `createDefaultRegistry`中显式注册 definition，并在 `apps/server/package.json`添加对应 workspace 包依赖。注册是运维者的代码审查决定，不接受网页 URL、npm 名或 manifest 上传后立即执行。
4. 经通用 binding 入口选择已注册的 connector/processor，执行真实任务，确认文件 commit 和共同召回。仅通过 `registry.resolve`的单测不足以证明整条扩展路径可用。
5. 运行 `pnpm check`；至少覆盖能力不匹配、配置错误、digest漂移、越权 import、部分输出、失败不发布、重启锁保持、撤权与固定引用。

目录边界检查仍适用：插件不导入 server、Catalog、SQLite 或其它场景内部实现。新增普通 connector/processor 不应要求修改调度器、文件发布或检索算法；若必须修改，应先明确新增的是平台能力还是当前接口不足。

## 真实 binding 和任务入口

owner 调用 `GET /api/plugins`取得当前 descriptor；后台也是从这个结果生成选择项。`POST /api/projects/:id/bindings`的通用请求如下，适用于已注册的官方 Git/Markdown 组合：

```json
{
  "name": "Repository notes",
  "connector": {
    "packageRef": "org.opencontext.repo@0.1.0",
    "config": {
      "repoUrl": "https://github.com/yufeng201/OpenContext.git",
      "branch": "main"
    }
  },
  "processor": {
    "packageRef": "org.opencontext.markdown@0.1.0",
    "config": {}
  }
}
```

服务端生成 instance locks，调用方不要猜或自填 digest。拿到 `bindingId`后，先 `POST /api/projects/:id/bindings/:bindingId/sync`，再按需 `POST .../process`；从 `GET /api/projects/:id/runs`确认结果，通过 tree/search/read验证文件发布和引用。`queued`或上传成功不是 commit 成功。旧 Git-only 请求只保留为兼容入口，由组合层转换；Catalog 与 Coordinator 不再根据 Git 参数选择具体插件。

运行入队时固定实例锁及 import refs；processor固定输入 commit。旧版未锁定的待执行任务不能安全推断原包版本，会以 `LEGACY_RUN_REQUIRES_RETRY`结束，需由用户明确重新发起。即使包版本字符串相同，源码 digest漂移也必须处理，不能擅自改数据库锁继续执行。

以下命令真实存在，不需要私有测试服务或模型：

```sh
pnpm exec vitest run packages/plugin-host/tests/registry.test.ts
pnpm exec vitest run tests/integration/plugin-runtime.test.ts
pnpm check
```

registry测试覆盖插件声明、实例锁、输出和import边界。[plugin-runtime.test.ts](../tests/integration/plugin-runtime.test.ts)给出完整的新增插件例子：合成`fixture.note` connector与`fixture.note-summary` processor仅通过`ApplicationOptions.registry`注册，随后经同一个HTTP binding→task→SQLite/文件commit→索引→MCP召回路径执行。没有为fixture修改route、Catalog或Coordinator。开发新包可以参考其中definition与验收结构；这些fixture不注册到默认列表，也不替代浏览器或模型验收。

## 可复制的离线示例与验收

[example-notes](../plugins/example-notes/src/index.ts) 是独立 workspace 包，包含 `example.notes@0.1.0` connector 和 `example.notes-summary@0.1.0` processor。前者只接受明确上传的 `{ "text": "..." }` JSON（正文 1–2000 字符、无额外字段），按导入对象 ID 生成稳定相对路径；后者生成确定性 Markdown 候选，并保持精确 `derivedFrom`。它不采集会话、不调用模型，也没有注册进默认服务器。

复制该包后修改包名、manifest ID/版本、配置 TypeBox schema 和实现；把全部本地行为文件列入 `artifactPaths`。开发验收可将 definitions 传入 `new StaticRegistry([connector, processor])` 和 `createApplication({ registry, dataRoot, ownerToken, autoStart: false })`，仅使用新建临时目录与合成 token。正式装配仍需上文的 workspace 依赖和显式代码审查注册；没有动态安装命令或在线 manifest 执行入口。

示例的通用 binding 配置使用 connector `{ "prefix": "Example" }`、processor `{ "heading": "Candidate" }`。创建 project/binding 后，向 `/api/projects/:id/bindings/:bindingId/imports` 上传 `filename` 和包含 JSON 的 `content`，再分别执行 `sync`、`process` 并等待 runs 为 `published`。以 reader token 搜索正文词，使用搜索返回的 **fileId 和 revisionId** 读取来源及产物，核对 citation/hash/lineage；不能只看到 202 就宣称验收通过。

以下实际命令执行可复制的 conformance 入口，不需要外部来源、私密数据或模型认证：

```sh
pnpm exec vitest run tests/integration/example-plugin.test.ts
pnpm exec vitest run packages/plugin-host/tests/registry.test.ts packages/plugin-host/tests/lifecycle.test.ts tests/integration/plugin-runtime.test.ts
```

第一个入口实际创建隔离服务器和数据目录，注册独立包，检查非法配置/上传不落盘、来源与产物任务发布、共同搜索、固定版本引用、分页和撤权。另包含真实 HTTP 断连时配置/导入取消，以及超时 native worker 迟到返回也不发布。第二个入口检查不兼容 manifest/protocol、包 digest 漂移、锁/能力、路径/预算/引用、失败不发布及各生命周期截止和配额；这些是应用/协议测试，不是已认证模型端到端。

## 有界生命周期

manifest 必须通过共享 `PluginManifestSchema`：协议固定 `1`、语义版本、合法 namespace ID、能力去重、server/official-trusted-native 和无未知字段；配置 schema 必须是 TypeBox object。`StaticRegistry` 默认每个 async config/import/connection/invoke 操作最多等待 30 秒，整个 registry 同时最多 4 个操作。开发构造参数仅允许 `timeoutMs` 10–30000、`maxConcurrent` 1–16；它们不是未验证的 HTTP 用户配置。

host 向 hook 传入自己的 `AbortSignal`，同时传播调用方取消；HTTP 配置/导入连接断开会取消预检，落盘前再检查取消及当前授权。执行超时返回 `PLUGIN_TIMEOUT`，调用方取消返回 `CANCELLED`，配额耗尽返回 `RESOURCE_BUSY`；连接诊断保留 `CONNECTION_TEST_TIMEOUT/CANCELLED` 契约。只允许受审稳定错误码，未知 native 错误变为 `PROCESSING_FAILED`，不回传正文、凭据或任意 abort reason。

超时或取消后迟到输出不会进入发布。仍在运行的 native Promise **继续占用配额直到实际结束**，避免反复超时绕过并发限制；冻结 import 端口在取消后拒绝读取。同步 CPU 阻塞、任意 native 磁盘/网络访问无法被进程内 timer 中断；永久不结束的操作会持续占槽。恢复需要受控停止整个实例，不提供任意第三方强隔离、自动重试或杀进程承诺。

## 安全与演进

当前插件在服务器进程内以可信代码运行。`AbortSignal`、预算和 SDK 能保护合作实现的调用边界，不能阻止恶意 native 代码自行读磁盘/联网；这里没有强沙箱承诺。不得把用户来源里的 AGENTS、hook、指令或脚本当作安装授权。不要在测试中读取真实会话、复制厂商凭据、调用付费模型或发布外站。

飞书群连接器与分析处理器已沿同一registry装配，详见[接入指南](FEISHU_CHAT.md)。本轮新增可选`ConnectorDefinition.testConnection`和host提供的`ExecutionContext.instanceRef`：前者只返回有界状态/错误码及`live/simulated`证据，后者来自锁定实例，用于隔离插件自有恢复目录。UI只在descriptor声明支持时显示连接诊断；Catalog、Coordinator与发布/检索gate无需飞书分支。实例ref仍不构成操作系统隔离。

网络适配器在组合层注入fetch和严格按群/区域授权的凭据解析器。客户端配置只保存secretRef，不能注入URL、fetch或明文token。飞书持久snapshot由`previousVersion`选择，pending仅为分页暂存；不是另一个可决定正式head的主库，但已确认snapshot是恢复必需文件，必须备份。完整分页后才返回full集合，不把丢页/权限错误/列表缺失推断为删除。模拟测试通过不代表真实来源授权或生产验收。团队多用户模型仍未明确。

真实 Session 采集也分两步：在用户指定项目和历史范围内，通过经过版本探测的厂商读取接口生成完整 envelope；然后复用已实现的导入与发布门禁。采集器需要单独的设备授权、源读取/游标恢复和卸载配置回滚，不把当前 Web 上传当成自动采集已完成。候选的真实本地 Agent/provider 提取实现可接现有 async `CandidateExtractor`，但必须另验证认证、预算、取消和结构化输出；当前只注册确定性实现。团队含义确认后再设计身份、成员权限与协作模型。
