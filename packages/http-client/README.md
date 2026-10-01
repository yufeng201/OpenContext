# OpenContext TypeScript查询客户端

私有源码预览包，Node24运行，未发布npm。接口及安全边界见[查询接入](../../docs/QUERY_ACCESS.md)。复用contracts类型和查询路径，不自行决定授权。仅projects/tree/search/read；read需要固定revision。15秒超时、禁止redirect和cookie、拒绝明文远程URL与带凭据URL。无token持久化、自动retry或写操作。

实际跨工具/授权验收见tests/integration/query-access.test.ts，包含历史版本、来源撤销、跨project及只读token写拒绝。response仍依赖TS类型，尚无运行时完整schema校验；Python SDK未实现。
