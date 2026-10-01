# 最小团队身份与RBAC决策稿

状态：一页下一阶段提案，未实现、未连接IdP、未创建真实凭据。目标是团队共享和维护空间，同时保留稳定fileId、不可变revision、当前来源授权及固定引用。

**建议先做single-tenant团队：一实例一组织、多私有空间、显式邀请成员。** 与当前单机控制库、全局native registry/凭据映射一致。暂不托管互不信任组织：multi-tenant须把tenant贯穿索引、任务、secret、插件状态、备份及隔离执行，再验收跨租户反例；“空间”尚不等于租户隔离。

| 最小角色            | 允许                                              | 默认拒绝                                       |
| ------------------- | ------------------------------------------------- | ---------------------------------------------- |
| 实例管理员          | 组织邀请/IdP映射、运行/备份/审计导出              | 产品身份不自动读所有空间；OS数据卷管理员仍可信 |
| space owner         | 该空间成员、来源/导入、任务/加工及维护            | 其他空间、其他人的采集secret、实例配置         |
| space reader        | 获准来源查询、固定历史读、复制引用                | 来源/导入/任务/成员修改、管理审计导出          |
| Agent/service token | 归属稳定主体、显式space scope、默认查询、有限期限 | 代他人发任务、跨空间、模型自行扩大权限         |

最小版本先用owner/reader。若需非owner纠正/推广候选，再定义editor具体动作；不要发全局owner来实现协作。组织成员不自动读所有空间，退出/移除影响已有REST/SDK/CLI/MCP连接和后台发布；历史读也查当前权限。已复制字节无法收回。

OIDC只产出稳定`issuer + subject`，由服务器映射本地成员/space角色，不信任邮箱显示名或客户端角色。Web用有限寿命Secure/HttpOnly session，Agent用独立可撤销scope token；IdP token不当采集secret或传给模型。bootstrap owner须受控迁移/轮换，不映射所有SSO用户。统一gate：active成员→space角色→来源当前权限→固定revision；任务执行/发布和检索到读取重新校验。审计归属真实subject，后续加事务outbox和独立sink。OIDC协议/PKCE/state/nonce、session撤销须单独实施验收。

**四项待确认：** 是否接受一实例一组织；IdP组同步还是管理员邀请；owner/reader是否足够、哪些维护动作需editor；空间内是否需逐来源授权。另需用户指定已有IdP、撤销时效、审计负责人/保留策略和合成测试空间，未确认前不连账号。

最小验收：两空间多主体正反矩阵；撤成员/来源/token时历史读取和队列发布拒绝；普通成员不能绑定他人secret；恢复旧快照不复活离职权限；审计主体归属、OIDC/CSRF负例和实际受控登录。完成后称single-tenant团队预览；出站OS隔离和[产品门槛](PRODUCT_READINESS.md)仍独立，不能称企业或多租户SaaS完成。见[出站与审计](EGRESS_AUDIT.md)。
