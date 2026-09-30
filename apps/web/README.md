# 最小 Web 切片

从仓库根安装锁定依赖后运行 `pnpm --filter @opencontext/web dev`。
Vite 只绑定 127.0.0.1:5173，`/api` 与 `/mcp` 转发到 127.0.0.1:4310。
`pnpm --filter @opencontext/web build` 同时执行严格类型检查并输出 dist，由 server 同源托管。

真实范围：owner/reader cookie 会话、空间选择/创建、Git 来源配置与同步、确定性 Markdown 导航加工、来源与产物目录、全文/grep 检索、固定 revision 原文和引用。没有模型、设备管理、飞书或外部发布界面。
RHF 使用 contracts 的 TypeBox schema，通过 Ajv 校验；token 不进 URL/localStorage/sessionStorage。读取正文只渲染文本；权限错误取消请求并清除内存缓存。服务器 gate 是权限依据。

组件采用 shadcn 的本地源码与 Radix primitives 模式，components.json 固定 new-york / Radix 路径。本环境官方 CLI `shadcn@4.21.0 docs/view` 的公开 registry 请求失败（Request was cancelled，直接公开 HTTP 请求返回 403）；没有扩大网络权限。基础 Button 根据官方公开源码的 Slot/CVA 接口手动适配，其余有限控件按官方 Field/Card/Alert/Empty 组合接口本地实现，不能声称 CLI 自动生成或逐字镜像。没有引入其他 registry 或第二组件库。

参考：[shadcn Vite](https://ui.shadcn.com/docs/installation/vite)、[官方 Button 源码](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/button.tsx)、[Field](https://ui.shadcn.com/docs/components/field)、[React Router](https://reactrouter.com/start/declarative/installation)。

## 浏览器检查

当前没有 Browser 插件，使用 Playwright。`pnpm --filter @opencontext/web test:browser` 连接真实已启动的 server；要求显式提供合成 fixture：

- `OPENCONTEXT_E2E_URL`：默认 loopback 4310。
- `OPENCONTEXT_E2E_OWNER_TOKEN`：测试服务器的合成 owner token。
- `OPENCONTEXT_E2E_REPO_URL`：测试自建 Git 仓库（main 分支 README.md 含 browser-needle，asset.bin 为不可摄入的二进制 fixture）。
- `OPENCONTEXT_BROWSER_BINARY`：可选浏览器可执行文件；本容器已有 /usr/bin/chromium，无需下载浏览器。

变量缺失会失败，不会退为 mock 或 skip。测试执行登录→建空间→添加 Git→同步→检索→固定原文→生成产物→窄屏→退出；截图与 trace 只写 /tmp。协议/API 集成及磁盘耐久性测试由仓库业务测试负责；这条浏览器流程不能证明真实 Agent 模型调用或完整 P1 已完成。
