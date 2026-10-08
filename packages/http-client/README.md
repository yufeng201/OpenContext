# OpenContext TypeScript 查询客户端

私有源码预览包，Node 24 运行，未发布 npm。接口及权限边界见[查询接入](../../docs/QUERY_ACCESS.md)。只读方法：`readiness`（owner）、`projects`、`tree`、`filesPage`、`search`、`read`。read 必须提供固定 fileId/revisionId；分页使用当前授权，发布/撤权改变可见集后旧 cursor 返回 CURSOR_STALE。SDK 不决定授权，也不改读最新版本。

请求与成功/错误响应复用共享 TypeBox 运行时 schema。拒绝额外字段、错误媒体类型/UTF-8/正文大小；校验 project/revision、citation、正文 UTF-8 长度和实际 SHA256。所有错误返回新的闭合 OpenContextError，不凭同类实例透传；只从自有data属性复制<=80字符白名单code、0或100–599整数status、36字符UUID correlationId。getter、原型、name/details/cause、原始message/stack不读取或复制；受审message前缀仍保留平台稳定code。CLI独立按相同边界投影metadata。同步 throw 与异步 transport reject 均转换为 REQUEST_FAILED，不保留原始 native 诊断。

所有方法最后接受 `{ signal }`。`timeoutMs` 默认 15000ms，允许 10–15000；同一绝对单调期限覆盖 transport、响应 headers/body、解码/JSON/schema/citation/readiness 与固定正文 hash 校验。每次读取、阶段完成及返回前检查期限，配合 timer 中断等待；到期返回 TIMEOUT，调用方取消返回 CANCELLED，不传播其原始 reason。同步 CPU 不能被强抢占，但过期后不能返回成功。

只接受HTTP200成功；readiness另接受503共享诊断报告。其他2xx及3xx在获取reader/消费正文前返回INVALID_RESPONSE，并取消body；真实fetch重定向因redirect:error返回REQUEST_FAILED，不跟随目标。只给200 read较大编码预算；所有错误及readiness503均16MiB。缺少/伪造content-length不改变实际流检查。此边界测试见`tests/integration/query-status-admission.test.ts`。

`maxResponseBytes` 默认112MiB，允许128字节–112MiB，只能收紧各操作实际上限：read成功编码JSON112MiB，其他查询与错误响应16MiB。112MiB为16MiB UTF-8正文的最坏6倍JSON转义加16MiB编码metadata余量，并非允许112MiB原文件。正文对象超16MiB返回BYTE_LIMIT（服务端413）；声明/实际编码响应越界返回RESPONSE_TOO_LARGE。默认SDK/CLI与REST/MCP正文范围一致，包括控制字符最坏转义；更紧自定义预算仍可能提前拒绝。MCP重复包装由服务端单独限制256MiB+1024字节。建议默认outline/片段与offset续读；超16MiB对象本身仍拒绝，不能用片段绕过。编码预算不等于进程峰值内存/并发承诺。每次请求最多 8192 次 `reader.read()`（包含空 chunk 和 EOF），超过返回 RESPONSE_WORK_LIMIT；空 chunk 不保留，正文复制到最多 64KiB 的自有分段，避免保留任意 backing buffer。每64次读取让出事件循环，避免热流饿死 timer/调用方取消。过度碎片化的有效 JSON 也会因工作预算失败，调用方需显式处理，SDK 不截断或自动重试。失败/取消清理 reader、锁、timer 和监听器；不等待不合作 transport 的无限 Promise，迟到 response 尝试取消 body。

禁止 redirect/cookie、明文远程 URL 和带凭据 URL；没有 token 持久化、写 API、自动 retry、Python SDK、OAuth、用户 Agent 自动配置或强 native 沙箱。

实际16MiB ASCII、多字节、8MiB引号、16MiB NUL最坏转义及正文超限的REST/SDK/CLI/MCP测试见`tests/integration/read-transport-budget.test.ts`；有限预算/客户端收紧/非read边界也保留拒绝断言。

实际测试：`tests/integration/query-access.test.ts`（跨工具/历史/撤权/跨project）、`query-response.test.ts`（schema/hash/真实慢 HTTP）、`query-stream-boundary.test.ts`（同步/异步异常、热流/空流/工作预算/绝对期限/取消清理/CLI白名单），以及真实 MCP SDK 分页测试 `packages/mcp/tests/query-pagination.test.ts`。这些合成协议验收不代表认证模型端到端。
