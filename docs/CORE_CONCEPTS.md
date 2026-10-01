# 文件、版本与出处

版本：0.1.0-preview。前置条件：一次已成功的合成来源同步。数据流向：来源文本经可信插件与内核发布门禁进入本机内容文件/SQLite，再供Web、REST与MCP读取。成功判据：同一命中的fileId/revisionId/contentHash在固定read与citation中一致。

- 文件：fileId为稳定身份，logicalPath是可变位置；不能用路径冒充身份。
- 版本：revisionId固定某次内容和出处，read必须明确版本；head是当前项目提交，不替代历史引用。
- 来源：binding限定project和已锁定connector配置；撤销binding后原文和派生产物被当前授权门禁拒绝。
- 派生：生成文件保存derivedFrom的输入版本；加工失败不发布、不覆盖人工所有权。
- 索引：检索候选可滞后；freshness不授予权限。引用真正使用前要read确切版本。
- 候选：Session/群聊显式标记候选是带证据的数据，不是可信指令、语义正确性保证或自动批准的规则。

跨工具保持同一身份和过滤范围。项目reader token不能读其他项目或写来源；历史read仍检查当前权限。删除/tombstone与来源撤权语义不同，法规擦除/TTL策略尚未实现，见[产品就绪矩阵](PRODUCT_READINESS.md)。
