# 最小 Web 切片

从仓库根安装锁定依赖后运行 `pnpm --filter @opencontext/web dev`。
Vite 只绑定 127.0.0.1:5173，`/api` 与 `/mcp` 转发到 127.0.0.1:4310。
`pnpm --filter @opencontext/web build` 同时执行严格类型检查并输出 dist，由 server 同源托管。

真实范围：owner/reader cookie 会话、空间选择/创建、由插件描述生成的来源/处理器配置、Git 同步、显式 Codex/Claude JSON 导入、飞书/Lark 指定群配置与连接诊断、确定性 Markdown/会话/群聊候选加工、来源与产物目录、全文/grep 检索、固定 revision 原文和引用。没有模型、自动历史扫描、Companion、设备管理、飞书文档或外部发布界面。
来源与处理器选择来自 `/api/plugins`，字段使用服务端 JSON Schema 校验；Web 不注册插件或自行决定执行权限。导入只预览用户所选文件的文件名/大小，上传后仍需同步发布，再运行处理器。相同文件名覆盖携带当前对象 ID；冲突清空选择并要求用户重新确认，删除也需显式确认且下一同步才影响正式来源。reader 不请求插件配置或待导入对象。
RHF 使用 contracts 的 TypeBox schema，通过 Ajv 校验；token 不进 URL/localStorage/sessionStorage。读取正文只渲染文本；权限错误取消请求并清除内存缓存。服务器 gate 是权限依据。

支持 `supportsConnectionTest` 的来源创建后显示“测试连接”。诊断不发布文件；模拟证据固定显示“模拟接口验证，未连接真实飞书”，真实可读也只代表指定群历史接口。缺凭据由管理员在服务器配置 secretRef，Web 没有飞书 token 输入。取消等待、切换空间、撤权会清除本次诊断，不能让旧结果出现在新空间；取消等待不保证服务器已经停止只读请求。

退出先清除当前页面内容，再限时请求清理 HttpOnly cookie。断线失败会明确提示 cookie 可能残留；sessionStorage 仅保存无凭据的断开标记，使本标签刷新后不会自动连接，重新输入 token 才解除。其他标签与浏览器禁止存储的情况不承诺同步退出，应清理站点 cookie。固定版本正文显示服务端报告的过期状态，不自动改读最新内容；来源撤销后保留 owner 审计卡，但禁用同步/加工。

组件采用 shadcn 的本地源码与 Radix primitives 模式，components.json 固定 new-york / Radix 路径。本环境官方 CLI `shadcn@4.21.0 docs/view` 的公开 registry 请求失败（Request was cancelled，直接公开 HTTP 请求返回 403）；没有扩大网络权限。基础 Button 根据官方公开源码的 Slot/CVA 接口手动适配，其余有限控件按官方 Field/Card/Alert/Empty 组合接口本地实现，不能声称 CLI 自动生成或逐字镜像。没有引入其他 registry 或第二组件库。

参考：[shadcn Vite](https://ui.shadcn.com/docs/installation/vite)、[官方 Button 源码](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/button.tsx)、[Field](https://ui.shadcn.com/docs/components/field)、[React Router](https://reactrouter.com/start/declarative/installation)。

## 浏览器检查

当前没有 Browser 插件，使用 Playwright。`pnpm --filter @opencontext/web test:browser` 连接真实已启动的 server；要求显式提供合成 fixture：

- `OPENCONTEXT_E2E_URL`：默认 loopback 4310。
- `OPENCONTEXT_E2E_OWNER_TOKEN`：测试服务器的合成 owner token。
- `OPENCONTEXT_E2E_REPO_URL`：测试自建 Git 仓库（main 分支 README.md 含 browser-needle，asset.bin 为不可摄入的二进制 fixture）。
- `OPENCONTEXT_BROWSER_BINARY`：可选浏览器可执行文件；本容器已有 /usr/bin/chromium，无需下载浏览器。

全套浏览器用例包含飞书模拟接口，需要先用 `node scripts/feishu-fixture-server.ts` 启动专用 loopback 服务（默认 4534，数据自动进入全新临时目录），将其打印的合成 token 和地址传给上述测试变量。服务器还需 `OPENCONTEXT_TEST_REPO_ROOT` 指向自建 Git fixture 的父目录。该脚本在服务端注入合成官方响应，不访问真实飞书；不要给它真实凭据。普通 `pnpm dev` 不满足模拟飞书用例条件，不能将连接失败改成 skip。

变量缺失会失败，不会退为 mock 或 skip。测试执行登录→建空间→添加 Git→同步→检索→固定原文→生成产物→窄屏→退出；截图与 trace 只写 /tmp。`tests/session-imports.spec.ts` 使用仓库内合成导出验证 Codex/Claude → 同步 → 候选 → 同库检索/固定引用，以及同名替换冲突、取消/删除、跨空间未提交文件清理和撤权；它不调用真实 Agent 或复制本地会话。

`tests/feishu.spec.ts` 验证群配置→模拟诊断→同步→候选→共同检索/固定引用，并覆盖缺凭据、取消、跨空间、离线错误恢复、撤权与窄屏。浏览器不伪造诊断正文；取消用例只延迟真实请求。此套件不证明真实飞书权限、生产连接或模型提炼已验收。

协议/API 集成及磁盘耐久性测试由仓库业务测试负责；这条浏览器流程不能证明真实 Agent 模型调用或完整 P1 已完成。

`tests/readiness.spec.ts`新增3项用户视角验收（全套17项）：目录/快速筛选/历史/跨空间/焦点/窄屏，失败任务恢复，以及真实HTTP MCP固定版本/权限/撤销。fixture还必须有`docs/guide.md`和`docs/architecture/decision.md`，后者含`reverify-multilevel-needle`。本地验收创建一次性合成仓库和Feishu fixture，不读取真实凭据或会话。仓库CI目前只运行pnpm check；浏览器CI提案因现有OAuth缺workflow权限而未提交。

当前 Reader 默认返回8KiB，并提供确定性章节目录、按标题定位、续读及显式全文按钮；新浏览器用例还要求fixture的`docs/large.md`包含`# Large`、`## Start`、足够超过8KiB的合成正文及`## End`后`budget-tail-needle`。这是渐进式读取验证，不是模型摘要或真实Agent调用。
