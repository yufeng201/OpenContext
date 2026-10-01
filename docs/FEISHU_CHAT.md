# 飞书 / Lark 群消息接入

状态：本轮已实现指定群开发切片；网络适配通过合成官方响应验证，最终实测范围以[实施状态](IMPLEMENTATION_STATUS.md)为准。本文不表示真实群、企业权限或生产部署已经验收。先按[快速开始](QUICKSTART.md)启动当前开发版；不使用公开 demo token 保存真实群消息。

这条来源由服务器拉取明确指定群的历史消息，再通过普通插件任务发布文件、生成候选、搜索和读取引用。它不扫描电脑，不运行 Codex / Claude，不发送群消息，也不写飞书文档。本轮的网络适配器可以被合成响应替换来验证真实任务链；`simulated`结果只能证明模拟链路，不能证明某个真实群可读。

先体验无需凭据的合成流程：完成仓库安装后运行以下实际脚本。它使用临时数据目录与注入的官方响应形状，监听`http://127.0.0.1:4534`；登录值会明确以synthetic标识打印。停止用`Ctrl+C`，数据位置也会打印，不混入默认私有目录。

```sh
pnpm build
node scripts/feishu-fixture-server.ts
```

后台选择本页两种插件，填写`realm=feishu`、`chatId=oc_synthetic_group`、`secretRef=secret:feishu/synthetic`、`startTime=2026-09-30T00:00:00Z`、`endTime=now`、`overlapSeconds=300`。测试连接应显示模拟；同步并加工后搜索`feishu-amber-plan`，打开来源与候选核对引用。真实接入使用下面的私有启动步骤，不使用该fixture入口。

## 1. 先选范围与归档策略

开始前，操作者需明确：飞书还是国际 Lark、目标 `chat_id`、允许采集的起止时间、应用或用户只读身份、服务器上的秘密引用，以及是否接受下述归档策略。不要在聊天、共享仓库或网页表单中提供 token；配置只保存 `secretRef`。

**当前是单 owner 管理的本地归档，不是企业成员权限的实时镜像。** 飞书返回403或身份失效会阻止新的同步，但已发布内容仍按 OpenContext 本地授权保留；它不会因此自动消失。需要立即阻断读取时，由 owner 撤销该来源，来源及依赖它的产物都经过本地授权 gate。若需要“群成员退出后同步撤销每位终端用户的历史访问”，本轮不满足，应先完成企业身份与来源ACL映射，不能把当前模式当作团队权限方案。

权限、可访问资源与时间范围是三项独立检查。具备 API scope 不等于能读取任意群，token有效也不等于选定群可读；群历史可见性设置还会影响实际返回范围。[飞书历史可见性公告](https://open.feishu.cn/document/platform-notices/breaking-change/visibility-control-of-historical-messages?lang=zh-CN)。

## 2. 服务器配置秘密，后台只填引用

当前只支持一条显式服务器映射，不自动发现环境变量，也不管理应用密钥、登录、token换取或自动续期：

| 启动环境变量                    | 内容与约束                                                            |
| ------------------------------- | --------------------------------------------------------------------- |
| `OPENCONTEXT_FEISHU_SECRET_REF` | 例如 `secret:feishu/team-context`；与 binding 的 `secretRef` 完全匹配 |
| `OPENCONTEXT_FEISHU_REALM`      | `feishu` 或 `lark`；与 binding 的 realm 完全匹配                      |
| `OPENCONTEXT_FEISHU_CHAT_ID`    | 经授权的一个群ID；与 binding 的 chatId 完全匹配                       |
| `OPENCONTEXT_FEISHU_TOKEN`      | 已获得授权的访问token，只通过服务器私有环境注入                       |

引用不匹配时不提供凭据；引用匹配但realm/chatId不同会拒绝，不能靠复制同一个 `secretRef` 跨群或跨区域取秘密。引用字符串不是凭据，也不代替用户授权。当前单映射意味着不能用同一服务环境随意绑定多个群；需要多群时先扩展受限凭据映射，不在配置正文塞token。

在已经配置私有 owner 环境的终端，可用下面方式提供现有凭据。示例不创建或打印token；先把示例群ID换成自己明确授权的群。服务器默认仍只监听loopback，这不是远程生产部署步骤。

```sh
export OPENCONTEXT_FEISHU_SECRET_REF='secret:feishu/team-context'
export OPENCONTEXT_FEISHU_REALM='feishu'
export OPENCONTEXT_FEISHU_CHAT_ID='oc_replace_with_authorized_chat_id'
read -r -s -p 'Existing authorized Feishu/Lark access token: ' OPENCONTEXT_FEISHU_TOKEN
printf '\n'
export OPENCONTEXT_FEISHU_TOKEN
pnpm start
```

不要将这些秘密写入共享 `.env`、命令参数、配置JSON或日志。身份到期时先在官方支持流程中更新授权，再由管理员更新服务器环境并重启；本轮不会自行创建持续授权或偷偷换成另一种身份。凭据解析的实际边界见[服务器映射](../apps/server/src/feishu-credentials.ts)。

`pnpm dev`检测到`OPENCONTEXT_FEISHU_TOKEN`时拒绝启动，防止公开demo登录值访问服务器私有群凭据。真实接入只能使用单独的私有开发数据目录与owner；模拟流程使用专用fixture服务器，不读取该环境凭据。

## 3. 后台完成一次导入与召回

选中目标上下文空间，以owner操作“添加来源”。来源选 `Feishu / Lark group archive`（`org.opencontext.feishu-chat@0.1.0`），处理器选“飞书群聊候选分析（显式标记）”（`org.opencontext.feishu-chat-analysis@0.1.0`）。以下是同一普通 binding 的配置，不需要另建场景专用接口：

```json
{
  "name": "Selected team chat",
  "connector": {
    "packageRef": "org.opencontext.feishu-chat@0.1.0",
    "config": {
      "realm": "feishu",
      "chatId": "oc_replace_with_authorized_chat_id",
      "secretRef": "secret:feishu/team-context",
      "startTime": "2026-09-01T00:00:00Z",
      "endTime": "now",
      "overlapSeconds": "300"
    }
  },
  "processor": {
    "packageRef": "org.opencontext.feishu-chat-analysis@0.1.0",
    "config": {}
  }
}
```

配置值均为字符串，以适配现有插件表单。`startTime`使用带`Z`的UTC ISO时间；`endTime`为UTC ISO时间或`now`，必须晚于起点且不能在未来；`overlapSeconds`是0–3600的十进制秒数字符串。`now`在开始一轮扫描时固定，不随每页请求变化。300秒重叠用于重复拉取和去重，不保证捕获任意久远消息的修改。创建后配置与插件版本锁定，当前没有在线改配置入口；范围填错应新建正确来源，不修改持久状态伪装为原binding。

这是有界开发切片：一轮最多100页、累计读取500条记录、响应累计10MiB，单页响应最多2MiB；留存快照也最多500个消息身份（含撤回记录）。处理最多200条候选，每个完整候选文件最多16KiB。超过限制会失败并保留旧正式版本，不截掉尾部后宣称成功；第一次应选小时间范围。大量长期归档需要扩展规模与迁移策略，不能靠删耐久状态绕过上限。

| 操作                                                                    | 应检查的证据                                                 | 失败后的动作                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 填来源名称、选择两种插件，填写区域、群ID、secretRef和时间范围，添加来源 | 目标空间与配置范围正确，未出现token输入框                    | 检查配置与服务器映射，不通过扩大群范围解决拒绝                          |
| 点击“测试连接”                                                          | 查看结果是 `live` 还是 `simulated`；后者必须明确显示模拟性质 | 缺凭据、范围不符、权限或网络错误分别处理；不要把测试失败当成空群        |
| 点击来源同步，查看任务状态                                              | 任务成功发布；来源版本与文件可见；失败时旧正式版本仍在       | 修复原因后重试，未完成扫描不能冒充完整结果                              |
| 在同一空间搜索群内已知文字并打开来源                                    | 原始消息信息、归一化文本、消息ID与固定revision引用可核对     | 无命中先查时间范围、类型支持和任务状态，不能推断消息不存在              |
| 运行推荐处理插件                                                        | derived中出现显式标记候选；没有标记可能是成功的空集合        | 候选不是模型理解；不为制造结果调用付费模型                              |
| 搜索并读取来源与候选                                                    | 二者共用检索入口；候选引用可打开固定版本消息                 | 旧来源变化后看freshness，再重新加工；invalid/撤销不能靠包含过期结果绕过 |

连接测试的owner入口是 `POST /api/projects/:id/bindings/:bindingId/test-connection`；它不会发布来源文件，也不是分页、附件或全历史完整性验收。合成测试通过注入网络适配器提供响应，不存在一个允许普通用户在生产表单中把模拟身份当真实授权的开关。MCP消费沿用[快速开始](QUICKSTART.md)的project只读token及search→read流程；接入MCP不会自行授予飞书身份。

## 4. 本轮内容与加工范围

| 内容层     | 当前行为                                                                                             | 明确不包含                                          |
| ---------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 消息来源   | 按稳定message ID合并；保留受支持响应的raw信息、时间、群与消息标识                                    | 飞书服务器字节级原件、全租户或全群完整备份的保证    |
| 归一化文本 | 解析text消息；其他消息类型仅保留raw信息或记录跳过诊断                                                | 富文本、卡片、音视频、附件的完整语义解析与附件下载  |
| 讨论候选   | 识别显式Topic/Conclusion/Todo/Requirement及对应主题/结论/待办/需求标记，生成带固定引用的Markdown候选 | LLM总结、事实确认、自动分派任务、写回群聊或外部文档 |

候选保留所引用内容与版本依据，不把聊天中的行为指令作为平台权限。互相矛盾或过时的讨论需用户核对来源；生成候选不等于批准了其中要求，也不等于Agent实际采用。没有显式标记时允许空输出，不能以“成功”声称已经完成语义抽取。当前可信原生插件同进程运行，插件接口不是操作系统沙箱，见[插件开发边界](PLUGIN_DEVELOPMENT.md)。

本轮不启用回调、WebSocket长连接、自动事件订阅、附件下载或任何外部写操作。网络模拟可以覆盖真实平台任务、发布和召回过程，不能替代真实身份、群权限、限流和企业环境验收。

## 5. 增量、恢复、修改与撤回

连接器以已发布的 `sourceVersion`定位耐久快照；状态位于所选数据根的 `plugin-state/feishu-chat/`。未结束的分页扫描保留固定 `scanEnd` 和进度，重试恢复同一轮。只有平台成功提交来源版本，才确认推进同步状态；网络读取成功或暂存文件落盘本身不是发布成功。

| 情况                         | 本轮规则                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| 重复页、重叠范围、重试       | 按消息身份与内容版本合并，不重复追加正文                                           |
| `items`为空而`has_more=true` | 继续分页；无有效下一页或分页异常应失败/报告不完整，不提前宣布扫描完成              |
| 一次列表里未出现旧消息       | 保留历史归档，不根据缺失删除；过滤、可见性变化和失败均可能造成缺失                 |
| 观察到消息更新               | 新来源revision保留版本关系；依赖旧版本的候选需重新检查freshness并按规则重算        |
| 明确观察到`deleted=true`     | 从当前可用正文中移除该消息；依赖它的派生内容invalid，不再通过普通召回返回          |
| 上游403或token失效           | 新同步失败；已发布档案仍按本地授权保留，不冒称企业ACL已同步撤销                    |
| owner撤销来源                | 本地授权gate立即阻断来源与依赖产物，包括按旧引用读取；已发到外部会话的字节无法追回 |

删除当前消息与撤销访问都不等于安全擦除不可变blob、历史版本或既有备份。本轮没有安全擦除服务。若不接受本地归档保留策略，不应导入真实群数据。

**备份必须包含 `plugin-state/feishu-chat/`。** 它参与恢复已发布消息集合、扫描状态和来源版本，不能当作可任意清空的缓存。应与控制库、对象/版本内容一起取得一致性备份；当前没有生产在线联合备份工具。不要通过删除插件状态“修复”游标，也不要只恢复SQLite却假定群历史集合能安全猜回。

## 6. 覆盖边界：话题、时间与编辑

历史API的chat查询按创建时间筛选；普通群中的话题回复要用发现的 `thread_id`另行分页拉取。thread接口不支持服务端起止时间筛选，本插件需在读取后按本地时间范围筛选。[官方请求与话题说明](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/model.go#L13207)。

因此，**话题根在配置起始时间之前、回复却在范围之内**的场景，可能无法从本次chat列表发现；只拉已发现thread不能保证完整。距上次全范围读取至少24小时后，下一次同步会重新读取配置范围；这不是已启用的每日自动调度，也不能把它称为全群扫描。需要完整旧话题覆盖时必须明确扩大获准历史范围或补充话题目录方案，不能在后台无声扩大采集范围。

创建时间窗口也不是编辑时间游标：很久以前的消息今天修改，未必进入最近创建窗口。重叠拉取和配置范围对账能改善检测，不能承诺任意旧消息即时更新。当前核验到撤回事件但没有可依赖的通用消息编辑事件；本轮未启用事件接收，只有实际读取到更新/撤回时才处理。[官方撤回事件模型](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/api/im/v1/model/p2_im_message_recalled_v1.py)、[官方事件注册表](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/event/dispatcher_handler.py#L1820)。

## 7. 官方权限与后续扩展

当前只读接入不需要发送、编辑或撤回消息的写权限。官方资料将 `im:message:readonly`定义为读取单聊和群聊消息，群历史应用身份还需要对应群访问和 `im:message.group_msg`；应用需开启机器人能力并加入目标群。用户身份读取群消息另有 `im:message.group_msg:get_as_user`要求，不能仅替换token就忽略身份差异。最终以所选区域、身份的官方接口权限检查为准。[权限教程](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-development-tutorial/turn-on-app-permissions)、[历史接口](https://open.feishu.cn/document/server-docs/im-v1/message/list?lang=zh-CN)。

未来若接收事件，还需单独确认事件scope：官方区分仅用户群消息的 `im:message.group_msg` 和包含其他机器人消息的 `im:message.group_msg.include_bot`；只有“@机器人”读取权限不能宣称全群消息覆盖。[官方接收事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)。

附件是独立扩展：应使用消息资源API，验证message ID与资源key匹配、大小及权限，不能任意跟随正文URL。本轮不下载附件，也不声称已经验证其完整scope；官方限制包括100MB、部分卡片/合并转发资源不支持。[官方资源接口](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/resource.go#L1664)。飞书与Lark域名来自[官方SDK常量](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/core/const.py#L4)，不能让来源正文决定带凭据请求的地址。

## 8. 当前验证说明

文档示例与链接使用仓库已有 `pnpm check:docs`校验；最终工程/业务检查入口仍是 `pnpm check`。本轮连接器、处理器、恢复与后台测试记录见实施状态；模拟通过与真实群验收严格分开。

真实群验收仍需操作者在官方支持流程中准备最小只读身份，明确授权区域、群、时间范围与归档策略，再验证测试连接、分页来源、候选及引用。不要将token发到聊天中。本轮尚未验证真实飞书/Lark授权、企业多用户ACL、附件、事件、生产运维或模型加工。
