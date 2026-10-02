# 查询接入：REST、TypeScript、CLI 与 MCP

版本：0.1.0-preview；受控本机开发预览。前置条件：Node24.19、pnpm11.19、已构建并运行的OpenContext，以及owner明确发放的单project只读token。数据流向：客户端仅向指定服务器发送查询和Bearer token，接收已授权文件；不扫描本机历史、不存token、不更改Agent配置。成功判据：search返回的fileId/revisionId用于read，citation和contentHash一致；撤权后读请求失败。

## API真相源

共享路径在packages/contracts/src/query-api.ts；请求校验仍来自同一TypeBox SearchSchema/ReadSchema。`GET /api/openapi.json`提供OpenAPI3.1的查询子集：projects、tree、search、read。该元数据公开但不含文件或凭据。查询成功/错误响应已有共享TypeBox运行时校验；管理mutation、完整管理SDK和稳定外部版本兼容承诺仍未交付，不能把子集当成完整管理API。

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

`packages/http-client/src/index.ts`提供OpenContextClient及OpenContextError，当前是Node24仓库内私有只读源码包，未发布npm。Node24可直接运行TypeScript。构造参数baseUrl必须只有origin，不接受userinfo、query或path；明文HTTP只允许loopback，远程必须HTTPS。所有请求禁止redirect，默认限时15秒；同一计时覆盖连接、响应头和响应体读取，调用方可传AbortSignal取消；timeoutMs可在10–15000毫秒内缩短。解码响应上限16MiB（maxResponseBytes可收紧至128字节）；只接受application/json及有效UTF-8，超限或无效JSON只返回稳定错误码，以免Bearer跟随跳转或错误正文进入日志。

方法：readiness()（owner-only，503返回依赖报告）、projects()、tree(projectId)、search(projectId,input)、read(projectId,fileId,revisionId)、filesPage(projectId,{limit,cursor})。所有方法最后可传{signal}。SearchInput、FileEntry、SearchResult、ReadResult来自contracts。先search，再将命中里的fileId/revisionId交给read，核对citation；错误包含status/code/correlationId，没有任意上游错误文本。成功响应、错误、分页和固定revision共享TypeBox schema，额外字段/未知形状拒绝而非静默丢弃；read复核正文UTF-8长度和SHA256，citation必须与文件/所请求revision一致。readiness单独使用共享TypeBox响应契约和稳定故障码白名单，拒绝任意503错误正文。Python SDK后续从同一API契约实现，当前未提供。

可执行合成示例及REST/SDK/MCP一致性、跨project/历史/revoke测试在tests/integration/query-access.test.ts；它们不调用模型。

## MCP / Codex / Claude Code

已有HTTP MCP入口为/mcp，工具context_search/context_read/context_tree；与REST使用相同服务门禁。最小权限token、显式project scope及Codex配置说明见[快速开始](QUICKSTART.md)。手工配置会写用户客户端配置，应由用户明确选择目标；本实现不会自动执行。Claude真实客户端、模型跨会话自主调用和真实回答尚未验收，不能以协议测试代替。

可选hook/recall skill安装器尚未提供，默认不配置hook。主动JSON Session导入见[Session指南](SESSION_IMPORT.md)，不等同自动历史读取或模型认证。

## 错误与边界

401 UNAUTHORIZED：token缺失/撤销。403 FORBIDDEN：reader访问其他project或写入口。404 NOT_FOUND：文件/revision不可见，或binding已撤销。400 INVALID_SCHEMA：请求字段/类型不符合共享schema。SDK/CLI不自动扩大scope、重新认证、降级成owner或改读head。索引freshness不是授权依据。

health只代表存活；owner-only readiness检查依赖并在503时输出脱敏JSON、CLI非零退出。离线维护见[备份恢复与诊断](BACKUP_RECOVERY.md)；重启、备份、迁移和安全门槛见[产品就绪矩阵](PRODUCT_READINESS.md)。当前不支持多租户企业生产部署。

search的limit是最多命中数，另受4096字符总excerpt预算（每项最多512）约束，可能少于limit；这不是漏检或分页总量。固定全文需用命中revision再次read。

## 固定快照文件分页与可执行例子

`GET /api/projects/:id/files?limit=100&cursor=...`、SDK `filesPage`、CLI `files PROJECT [LIMIT] [CURSOR]` 和 MCP `context_tree({projectId,limit,cursor})` 共用当前授权与页契约。limit为1–200，默认100，nextCursor为null表示结束；不返回未授权总量。原tree数组/MCP不传分页参数的files对象保持兼容。旧tree拒绝未知query字段，不静默忽略cursor。

游标只表示当前已授权文件集合的读取位置，不是凭据。游标绑定project、head和可见文件集合指纹；来源撤权/发布/head变化令旧游标返回409 CURSOR_STALE，调用方显式从第一页重取。跨project仍先执行当前授权；篡改/无效游标报400 INVALID_CURSOR。不能保证跨写入的长寿命分页快照，不自动改读新的head。

如下命令真正启动合成loopback协议服务、无真实凭据/来源/模型，并清理自有临时服务：

```sh
pnpm exec vitest run tests/integration/query-response.test.ts tests/integration/query-access.test.ts packages/mcp/tests/query-pagination.test.ts
```

覆盖REST/TS SDK/CLI/真实MCP SDK分页及固定读取一致性、发布/撤源游标失效、撤token、超时取消与错误脱敏。SDK支持等级为Node24只读源码预览，不提供管理写方法、Python包、OAuth、用户Agent自动配置或生产版本稳定承诺。

请求body/query和响应中的额外字段明确拒绝。JSON错误、错误media type、无效UTF-8、协议字段/固定revision错误均只暴露稳定码，不回显原正文/URL/abort reason。CLI收到SIGINT/SIGTERM取消；SDK非合作transport也有deadline竞争和晚到响应体清理。网络断开不会成为对同步native代码的抢占式终止保证。

共享成功payload最多16MiB；MCP的text+structuredContent重复包装另按16MiB工具结果预算检查，因此大文件在MCP可能比REST更早拒绝；JSON-RPC transport元数据另有请求上限。超限不能返回截断成功结果。搜索limit仍只是最多命中数，4096 excerpt预算和默认10条保持，不能当总数/搜索分页；本批分页仅限文件集合，projects/search分页尚未提供。

明确的来源历史read保留现有授权语义：来源已删除但binding仍获授权时，固定历史内容可读，其metadata可保留tombstone/invalid；不把freshness当授权凭据。树/搜索仍排除这些条目，无效派生产物及撤源后的历史均拒绝。SDK的schema例外只接纳服务器授权后返回的明确来源历史，不能代替服务器ACL。

SDK整请求使用单调时钟的绝对期限（默认15秒，配置10–15000ms），覆盖transport、headers/body、解码/JSON/schema/citation/readiness和固定正文SHA256；每阶段结束与返回前复验，同步处理过期不能返回成功。单个请求最多8192次body读取（含空chunk/EOF），超限为RESPONSE_WORK_LIMIT；空chunk不保留，自有分段最多64KiB，每64次读取让出事件循环。超过碎片工作预算也会拒绝有效JSON，不能当字节截断或自动retry。同步transport throw、异步reject都稳定转换为REQUEST_FAILED，CLI按共享错误白名单输出。详情及可执行边界测试见[SDK包说明](../packages/http-client/README.md)。
