# 查询接入：REST、TypeScript、CLI 与 MCP

版本：0.1.0-preview；受控本机开发预览。前置条件：Node24.19、pnpm11.19、已构建并运行的OpenContext，以及owner明确发放的单project只读token。数据流向：客户端仅向指定服务器发送查询和Bearer token，接收已授权文件；不扫描本机历史、不存token、不更改Agent配置。成功判据：search返回的fileId/revisionId用于read，citation和contentHash一致；撤权后读请求失败。

## API真相源

共享路径在packages/contracts/src/query-api.ts；请求校验仍来自同一TypeBox SearchSchema/ReadSchema。`GET /api/openapi.json`提供OpenAPI3.1的查询子集：projects、tree、search、read。该元数据公开但不含文件或凭据。管理mutation、完整response schema和稳定外部版本兼容承诺仍未交付，不能把子集当成完整管理API。

REST使用Authorization Bearer。树只包含当前有效文件；read必须给精确fileId和revisionId。历史revision依然受当前project/source权限，来源撤权不是改读最新版。服务器的当前授权为准，SDK没有第二套授权缓存。

## 本机CLI

在自己的私有环境提供OPENCONTEXT_QUERY_TOKEN；不要写入命令参数、仓库或共享截图。默认服务器为http://127.0.0.1:4310；可用OPENCONTEXT_URL明确指定。CLI使用JSON输出；失败以非零退出并输出稳定错误码，不回显token、服务器URL或任意错误正文。

```sh
pnpm cli --help
pnpm cli readiness
pnpm cli projects
pnpm cli tree PROJECT_ID
pnpm cli search PROJECT_ID OpenContext grep
pnpm cli read PROJECT_ID FILE_ID REVISION_ID
```

查询词含空格时按shell规则加引号。没有latest-read捷径、写命令或持久配置。不要把owner token给日常Agent；reader无权创建项目、修改来源或导入。

## TypeScript源码SDK

`packages/http-client/src/index.ts`提供OpenContextClient及OpenContextError，当前是仓库内私有源码包，未发布npm。Node24可直接运行TypeScript。构造参数baseUrl必须只有origin，不接受userinfo、query或path；明文HTTP只允许loopback，远程必须HTTPS。所有请求禁止redirect并默认限时15秒；timeoutMs可在10–15000毫秒内缩短。解码响应上限16MiB，超限或无效JSON只返回稳定错误码，以免Bearer跟随跳转或错误正文进入日志。

方法：readiness()（owner-only，503返回依赖报告）、projects()、tree(projectId)、search(projectId,input)、read(projectId,fileId,revisionId)。SearchInput、FileEntry、SearchResult、ReadResult来自contracts。先search，再将命中里的fileId/revisionId交给read，核对citation；错误包含status/code/correlationId，没有任意上游错误文本。查询正文响应目前是TS契约断言，尚无客户端运行时response schema校验；readiness单独使用共享TypeBox响应契约和稳定故障码白名单，拒绝任意503错误正文。Python SDK后续从同一API契约实现，当前未提供。

可执行合成示例及REST/SDK/MCP一致性、跨project/历史/revoke测试在tests/integration/query-access.test.ts；它们不调用模型。

## MCP / Codex / Claude Code

已有HTTP MCP入口为/mcp，工具context_search/context_read/context_tree；与REST使用相同服务门禁。最小权限token、显式project scope及Codex配置说明见[快速开始](QUICKSTART.md)。手工配置会写用户客户端配置，应由用户明确选择目标；本实现不会自动执行。Claude真实客户端、模型跨会话自主调用和真实回答尚未验收，不能以协议测试代替。

可选hook/recall skill安装器尚未提供，默认不配置hook。主动JSON Session导入见[Session指南](SESSION_IMPORT.md)，不等同自动历史读取或模型认证。

## 错误与边界

401 UNAUTHORIZED：token缺失/撤销。403 FORBIDDEN：reader访问其他project或写入口。404 NOT_FOUND：文件/revision不可见，或binding已撤销。400 INVALID_SCHEMA：请求字段/类型不符合共享schema。SDK/CLI不自动扩大scope、重新认证、降级成owner或改读head。索引freshness不是授权依据。

health只代表存活；owner-only readiness检查依赖并在503时输出脱敏JSON、CLI非零退出。离线维护见[备份恢复与诊断](BACKUP_RECOVERY.md)；重启、备份、迁移和安全门槛见[产品就绪矩阵](PRODUCT_READINESS.md)。当前不支持多租户企业生产部署。

search的limit是最多命中数，另受4096字符总excerpt预算（每项最多512）约束，可能少于limit；这不是漏检或分页总量。固定全文需用命中revision再次read。
