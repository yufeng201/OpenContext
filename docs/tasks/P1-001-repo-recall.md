# P1-001：真实 Git 插件到可信召回

状态：已获后续开发授权并实现首条受限闭环；结果和剩余项见[实施状态](../IMPLEMENTATION_STATUS.md)，不等于整个P1完成。关联：[PRD](../PRD.md)、[技术方案](../TECHNICAL_DESIGN.md)、[用户流程](../USER_JOURNEYS.md)、[开发流程](../DEVELOPMENT.md)。

## 目标与边界

先在单节点 server + 最小 Web 上，用一个真实 repo connector 插件把指定分支的文本文件写入受管理文件库；通过官方 FTS/grep retriever/assembler 与 MCP search/read 取得固定 revision 的引用。第一条闭环不要求向量、模型、Companion 或全部八类插件实现；接口仍保持统一插件宿主/实例契约，不写成路由里特判 Git。

P0 补最小 TypeBox/schema、文件与 SQLite 事务、插件 host ports 和故障 fixture；进入 P1 后增加 Git 实际同步和用户闭环。之后再加 processor/OutputSet 与本地 worker，完成原 P1 的 session/repo、多机和故障目标；不能把这一切片完成声称为整个 P1 完成。正式飞书继续 P2。

## 可拆任务与验收

| 步骤                     | 产出                                                              | 可执行验收设计                                                                                                      |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1 contracts + core ports | TypeBox 单一契约、ID/revision/ObjectRef、InstanceRef 解析、错误码 | 拒绝包 ref 冒充实例、未知字段、非法路径、未 ready 对象；正例可序列化                                                |
| 2 server files + control | 临时内容卷、SQLite head/ACL/cursor/outbox；owner 初始化与最小 Web | temp→fsync→rename→父目录完成后 CAS；故障注入后无半可见 commit；当前权限拒绝读取                                     |
| 3 官方 Git 插件          | 注册/实例/最小授权→probe→fetch/tree/diff→变化提案                 | 使用测试自建本地 bare repo：新增/修改/rename/delete、重复同步、force-push；发布后才推进 SHA/cursor，插件不直接写 DB |
| 4 全文/grep 与引用       | 受限索引port、固定 revision chunk、scope 与 freshness gate        | 同一 snapshot 搜到来源文件，删除不再召回，历史 grep 明确；索引落后可降级但不跳过撤权                                |
| 5 MCP + 最小交互         | search/read/tree 与 Web 添加来源/状态/搜索/引用页                 | 无向量/无设备仍首次成功；测试 MCP 客户端实际 search→read，引用字节/hash吻合                                         |

映射 RF-01/03/04/07/10/11/14–19 中相关部分、UJ-01/02/03 的子集以及既有 CAS/幂等/权限验收；逐项列实现证据，不批量勾选整行需求。Agent 真实模型使用需单独授权；本地协议客户端测试只能证明工具可消费，不能证明模型实际采用答案。

## 失败与完成定义

网络/分支/身份错误分别显示，不跳过旧成功 snapshot；强推/缺旧 SHA 做受限完整对账。公开合成源无需秘密，私有源只做假 secretRef fixture，不调用用户真实仓库。webhook、LFS、submodule、复杂 UI 和外部发布不在切片中。

完成时须有 Vitest 单元/集成与实际临时目录故障测试、MCP 协议调用、最小页面 Playwright 用例；将真实命令接入 pnpm check 或清晰分层 CI。确认构建启动、备份恢复与权限 gate 的代码证据；现有 harness 的设计规则执行不能替代上述结果。
