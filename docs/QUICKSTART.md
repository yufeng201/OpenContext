# 快速开始：当前开发预览版

本指南对应仓库已实现的本机切片，不是未来部署设计。适合可信开发者在 Linux 或 macOS 上用公开或合成数据试用。服务只绑定 `127.0.0.1`，无需向量服务、模型、Companion 或云账户。私有部署预检、TLS前置与限制见[部署安全](DEPLOYMENT_SECURITY.md)。未提供正式容器镜像、远程域名/TLS/生产初始化向导；不要按本文把端口转发到公网。

## 1. 安装并构建

准备 Node.js **24.19.0**、pnpm **11.19.0**、系统 Git。检查 `node --version`、`pnpm --version`、`git --version`；版本不符先按相应工具的官方安装方式准备开发环境，不能忽略 engine 检查。所有以下命令都从仓库根运行，shell 示例使用 Bash。

```sh
git clone https://github.com/yufeng201/OpenContext.git
cd OpenContext
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
```

构建后 Web 才能由 server 提供。`pnpm check` 可额外运行全部当前工程/业务检查并构建；它不包含真实模型回答或完整产品验收。安装只获取锁定依赖，不运行安装脚本；不要为解决失败而全局放开脚本或手改锁文件。

## 2. 选择一种启动方式

### 只试公开或合成数据

在没有 `OPENCONTEXT_OWNER_TOKEN` 的终端运行：

```sh
pnpm dev
```

打开 `http://127.0.0.1:4310`，复制终端打印的公开合成 demo token 到登录框。这个 token 任何人都能知道，不能保护私有数据。默认数据写 `runtime-demo/`，与私有开发模式隔离；若设置了 `OPENCONTEXT_OWNER_TOKEN`，demo 启动会拒绝混用，不会偷偷忽略或打印它。

### 使用自己的私有开发数据

这仍然是本机开发运行方式，不会变成生产部署。先在私有终端/秘密存储提供随机 owner token，长度 **32–256 字符**。不要把它写入源码、共享 `.env`、命令参数或截图。下面以隐藏输入读取用户已有 token，不生成凭据：

```sh
read -r -s -p 'Owner token: ' OPENCONTEXT_OWNER_TOKEN
printf '\n'
export OPENCONTEXT_OWNER_TOKEN
pnpm start
```

浏览器输入同一 token。私有模式默认数据根 `runtime/`；该 token 通过启动环境提供，恢复服务需自行保管，平台不会保存一份可导出的 owner 明文。需要改位置或端口时，在启动前设置 `OPENCONTEXT_DATA_ROOT` 和 `PORT`，例如使用自己拥有的持久目录。`pnpm dev:web` 的代理固定指向 4310；改后端端口时不要直接期待这个开发代理随之改变。

数据库会记录 demo/private 模式；已有无标记数据按 private 处理。遇到 `DATA_MODE_MISMATCH`，使用原模式、原目录与相应凭据启动，或另选空目录开始独立演示。**不要删控制库或修改标记绕过保护。**

从首个公开版本升级时，保留原 `runtime/`，不要移动或删除它。新版 `pnpm dev` 打开独立的 `runtime-demo/`，因此不会显示旧目录的项目，这不表示旧数据丢失。旧版无模式标记的库按 private 处理；要读取它，请设置自己的私有 owner 环境并用 `pnpm start` 打开原 `runtime/`，不要修改模式标记把它降为 demo。

`Ctrl+C` 停服；相同模式、凭据和目录重启会继续使用原数据。不要同时启动两个进程访问同一数据根。`runtime/` 和 `runtime-demo/` 都必须保持在 Git 之外。内容导出不能替代完整备份；停写快照/新目录恢复见[备份恢复](BACKUP_RECOVERY.md)，未提供生产RPO/RTO承诺；测试数据清理应在停服并确认不需保留后进行。

## 3. 第一次 Git → 原文 → Markdown 成功

| 用户操作                                                                                  | 应看到的结果                                                          | 失败时                                                                                 |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 连接后创建“上下文空间”                                                                    | 新空间可选择；当前一个空间就是一个权限边界                            | 看页面错误；不要刷新到其他空间继续提交同一表单                                         |
| “来源”选择“Git 仓库”与推荐“Markdown 导航”处理插件，填写名称、公开 HTTPS Git URL、明确分支 | 例如 `https://github.com/yufeng201/OpenContext.git`、`main`；来源出现 | 不填密码、PAT、SSH URL或私有仓库；当前不支持这些鉴权方式                               |
| 点击“同步仓库”，到“任务”查看                                                              | 任务发布，来源显示成功版本，文件目录出现来源文件                      | 分支/网络错误保留旧已发布内容；错误分支需重新添加正确来源，当前没有在线改配置按钮      |
| “搜索”输入仓库中的词，如 `OpenContext`                                                    | 返回来源结果；点击后打开固定 revision 原文和引用                      | 无命中先看同步/跳过报告，再换明确正文词或 grep；不要把空结果等同丢数据                 |
| “来源”点击“生成 Markdown 导航”                                                            | 新任务发布；“文件”出现 `derived` 内容                                 | 先确认来源已有文本；这只是确定性导航/摘录，不是模型生成的完整 Wiki                     |
| 再搜索相同词并打开产物                                                                    | 来源和产物都可召回；正文、来源版本和 citation 可核对                  | 来源更新后旧产物可能 stale；重新加工得到新版本。invalid/已撤权内容不能靠“包含过期”绕过 |

支持指定分支的受限 UTF-8 文本快照。二进制、LFS、submodule、symlink 和超大文件会跳过并报告，不承诺整仓所有资源。授权测试本地目录需显式 `OPENCONTEXT_TEST_REPO_ROOT`，它只用于合成 fixture；普通试用用公开 HTTPS 来源，不开放任意服务器文件读取。

不需要先配置 embedding 或模型来完成这些步骤。“生成 Markdown 导航”不会使用 Codex/Claude，也不会消耗模型额度。

新空间默认空文件页可直接点击“新增数据源”。Markdown Reader默认有限读取，可用章节目录定位、续读及显式全文，见[渐进披露](PROGRESSIVE_CONTEXT.md)。

也可从[Session主动导入](SESSION_IMPORT.md)选择Codex/Claude来源，填写`synthetic-project`并上传仓库合成fixture，验证raw→归一化→显式标记候选→共同召回。这是用户选择的versioned JSON文件导入，不会扫描电脑或运行coding CLI；候选处理器没有模型兜底。两条来源路径共用平台任务、文件发布和检索门禁。

## 4. 给日常 Agent 配置只读 MCP

前提：上面已有可检索内容；Agent 客户端与本机 server 在同一可达环境。当前 `127.0.0.1` 地址不能直接供另一台电脑使用。查询授权与客户端模型登录是两件事；本指南不会要求复制厂商凭据。

### 取得项目 ID 与查询 token

选好空间，从浏览器地址栏的 `project=` 参数取其完整 ID。它不是空间显示名称。当前没有 token 管理界面，owner 需调用已有 API；下面给出可执行步骤。第二个私有终端也需从安全来源设置 owner token（demo 时输入终端打印的合成值）：

```sh
export OPENCONTEXT_URL='http://127.0.0.1:4310'
read -r -p 'Project ID: ' OPENCONTEXT_PROJECT_ID
export OPENCONTEXT_PROJECT_ID
read -r -s -p 'Owner token: ' OPENCONTEXT_OWNER_TOKEN
printf '\n'
export OPENCONTEXT_OWNER_TOKEN
node --input-type=module <<'JS'
const { OPENCONTEXT_URL: base, OPENCONTEXT_PROJECT_ID: project, OPENCONTEXT_OWNER_TOKEN: token } = process.env;
if (!base || !project || !token) throw new Error('Missing URL, project ID or owner token');
const response = await fetch(`${base}/api/projects/${encodeURIComponent(project)}/tokens`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
console.log(await response.text());
JS
```

响应中 `token` 是一次显示的查询秘密；`id` 是以后撤销它所需的 token ID。把二者保存到个人秘密存储，不分享终端输出。token 只授权这个 project，不给 Agent owner token。把查询 token 放在启动 Agent 的私有终端环境：

```sh
read -r -s -p 'Query token: ' OPENCONTEXT_QUERY_TOKEN
printf '\n'
export OPENCONTEXT_QUERY_TOKEN
unset OPENCONTEXT_OWNER_TOKEN
```

### Codex 配置与实际验证

先检查已安装客户端的 `codex --version`、`codex mcp add --help`。以下是支持 HTTP bearer 环境引用的官方 CLI 命令，会修改这个用户的客户端配置；仅在你确认要添加时运行：

```sh
codex mcp add opencontext --url http://127.0.0.1:4310/mcp --bearer-token-env-var OPENCONTEXT_QUERY_TOKEN
```

该环境变量必须对启动 Codex 的进程可见；IDE/其他终端不会自动继承。当前 server 没有 OAuth，不执行 `codex mcp login` 来替代 bearer 配置。若要撤掉客户端节点，使用已安装版本支持的 `codex mcp remove opencontext`；删除节点不会自动撤销服务端 token。

在自己已获授权、已登录的 Agent 会话中明确要求：

> 只在 projectId“刚才的完整 ID”中用 context_search 查找 OpenContext；从结果取 fileId/revisionId，调用 context_read 核对原文，再回答，并给出返回的 citation。无权或无命中时直接说明，不猜正文。

验收看真实工具记录：是否调用 search 和 read、projectId是否正确、正文是否对应返回 revision、最终引用是否一致。不要仅以“连接成功”或模型说“我已读取”为证据。**当前已验证官方协议客户端和真实 Codex 显式 RPC 传输，尚未验证模型自主调用和引用回答。** 模型登录或额外额度由用户单独授权，本文不是登录授权。真实Claude客户端MCP验收、Skill/Hook安装器与Companion接入仍未完成；主动上传Claude会话文件是另一条已实现的来源路径，不等于客户端/模型验收通过。

官方能力说明：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。模型认证和客户版本兼容边界见[实施状态](IMPLEMENTATION_STATUS.md)。

### 撤销查询 token

在私有终端重新设置 owner token 和 `OPENCONTEXT_URL`，把先前保存的 token `id` 输入下面变量。不要把查询秘密误作 ID：

```sh
read -r -p 'Token ID to revoke: ' OPENCONTEXT_TOKEN_ID
export OPENCONTEXT_TOKEN_ID
node --input-type=module <<'JS'
const { OPENCONTEXT_URL: base, OPENCONTEXT_TOKEN_ID: id, OPENCONTEXT_OWNER_TOKEN: owner } = process.env;
if (!base || !id || !owner) throw new Error('Missing URL, token ID or owner token');
const response = await fetch(`${base}/api/tokens/${encodeURIComponent(id)}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${owner}` },
});
if (!response.ok) throw new Error(`Revoke failed: ${response.status}`);
console.log(await response.text());
JS
unset OPENCONTEXT_OWNER_TOKEN OPENCONTEXT_QUERY_TOKEN
```

撤销后后续 API/MCP 请求应拒绝；已复制到 Agent 会话或离线文件的内容不会被远程抹除。

## 5. 常见问题与下一步

| 症状                         | 检查与恢复                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| engine/Node语法/SQLite不兼容 | 核对 Node 24.19.0、pnpm11.19.0；按锁文件重装，不忽略引擎约束                                             |
| 浏览器503 “Web not built”    | 在仓库根执行 `pnpm build`，再加载；`pnpm dev`本身不构建Web                                               |
| 登录401                      | 确认连接的是同一端口/模式/数据根；用本次启动的 owner 或有效项目 token；不要把 projectId/tokenId 当 token |
| `DATA_MODE_MISMATCH`         | 用原模式打开原数据；演示另用空目录，不删除状态库绕过                                                     |
| `CATALOG_IN_USE`             | 先停止仍在访问同一数据根的服务，再启动；不要删除 authority 锁文件来绕过单进程保护                        |
| 同步失败或文件少             | 看任务的错误码和跳过列表；确认公开HTTPS、明确分支、网络可达和文本支持范围                                |
| MCP401/工具参数错误          | 确认查询环境变量在客户端进程中、token未撤销、projectId完整；工具不能自行猜项目                           |
| 服务离线/重启                | 页面可能暂时显示旧查询结果；检查错误提示，重启相同数据根后重试；旧固定引用仍受当前授权                   |
| 过期产物                     | 默认当前检索可能不返回；在允许的范围查看stale或重新生成导航，invalid始终拒绝                             |

开发和测试从[开发指南](DEVELOPMENT.md)继续。完整未来产品流程见[用户旅程](USER_JOURNEYS.md)，其中生产飞书接入、部署向导、Hooks 等不代表已经验收；当前指定群适配器与模拟验证另见[飞书群指南](FEISHU_CHAT.md)。精确边界以[实施状态](IMPLEMENTATION_STATUS.md)为准。
