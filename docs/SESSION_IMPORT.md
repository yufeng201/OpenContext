# 主动导入 Codex / Claude 会话

这是用户主动选择导出文件的入口，不是后台扫描电脑。服务器不会读取 `~/.codex`、`~/.claude`或整个 home，不启动真实 coding CLI，不登录模型，不自动上传会话。产品的 MCP 查询与这条来源导入是两个方向：连接 MCP 不会让服务器自动取得历史会话。

**当前支持已结束的顶层会话，不是所有客户端格式的通用归档器。** 已识别的工具/非文本事件保留在raw并报告诊断，只把受支持的用户/助手文本归一化和提取候选；未知事件或不完整历史仍拒绝，不静默删掉后声称完整。需要更宽的兼容性时应扩展明确版本的适配器并增加测试。

请先按[快速开始](QUICKSTART.md)启动开发版本。demo 仅适合合成/公开示例；涉及真实私有会话时用私有模式并先审查上传范围。当前仅验证合成材料，不代表 macOS 导出器、真实厂商授权或模型语义抽取已验收。

## 什么算导出文件

使用明确版本的 OpenContext JSON envelope，而不是任意 JSONL、私有 transcript 路径或一段聊天文本。本轮协议名为 `opencontext.session-import/v1`；结构化字段固定为 `schema`、`provider`、`projectScope`、`sessionId`、`complete`、`payload`，不接受任意附加顶层字段。`provider`为 `codex`或 `claude`，`complete`必须为 `true`。Codex payload 是 `thread/read`的结果对象；Claude payload 是 SDK `SessionMessage`数组。

这不是研究草案中的 `session-export`格式，也不是厂商原生统一导出命令。`complete: true`是导出者的完整性声明；解析器可以拒绝不支持结构，却不能证明用户未漏分页、供应商消息全集齐全或导出过程是原子快照。仅导入已经停止变化、由受支持接口完整获取的选定会话。项目归属以后台可信 binding 配置为准，文件里的 cwd 或 project 字段不能扩大授权。

官方可读取接口与本项目交换格式不同：

- Codex `thread/read`可读取存储线程，`includeTurns`请求正文；分页 turns/items 接口仍有 experimental 与内容视图限制。不要把只返回摘要的结果伪装成完整会话。这里没有承诺一个不存在的通用 `codex export`命令。[官方 app-server](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)
- Claude SDK `list_sessions`和`get_session_messages`可读取已选目录/会话的消息，读文件本身不等于启动模型。具体分页和版本兼容要由导出适配器验证；本服务不代替用户运行 SDK。[官方 session browser](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser)
- Claude `/export`输出 plain text，不能冒充带稳定 UUID、角色和完整性信息的结构化导出。当前主动 Session 接口不会猜测该文本的消息边界。[官方命令](https://code.claude.com/docs/en/commands)

本轮Codex接受`historyMode`为legacy或省略、turn状态为completed/interrupted/failed、itemsView为full或省略。userMessage的文本content及agentMessage.text进入归一化；命令执行、文件修改、MCP等解析器白名单里的工具/事件只保留raw。图像/音频/skill等已识别输入同样仅保留raw，不读取其中路径或下载URL。Claude接受顶层、角色一致的user/assistant消息，字符串/text块进入归一化；合法tool_use/tool_result/thinking块保留raw。完整白名单与必要字段以[解析器](../plugins/session-connector/src/index.ts)为准。

inProgress/pending、summary-only、未知item、缺必需字段、Claude子Agent消息或空历史拒绝本次操作。raw-only诊断说明“已保留但未文本解析”，不是删除了原件；raw来源仍可按授权读/搜。旧字段省略的兼容不能证明返回的是完整全集。

不要仅把文件后缀改成 `.json`。未知格式、partial或仍在变化的capture不能据此删除上次已入库内容。真实导出工具尚需按目标客户端版本和用户授权范围接入；合成 fixture 证明格式和平台生命周期，不证明从用户机器获取数据已完成。

## 在后台导入一次

| 操作                                                                          | 预期结果与下一步                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录目标空间，在“添加来源”填“来源名称”，选择 Codex 或 Claude 的来源插件       | 服务器 `GET /api/plugins`提供选项；来源插件包分别为 `org.opencontext.codex-sessions@0.1.0`、`org.opencontext.claude-sessions@0.1.0`               |
| 配置“Export project scope”（`projectScope`），保留推荐的 Session 候选处理插件 | scope必须与导出一致；它是已选 project 内的导入范围，不是目录路径，也不能让文件选择另一个项目。处理包为 `org.opencontext.session-candidates@0.1.0` |
| 在来源卡“选择 JSON 导出文件”                                                  | 页面预览文件名和字节数，不自动扫描目录；检查文件内容及共享范围后再确认                                                                            |
| 点击“上传所选文件”                                                            | 只保存待摄入对象，尚无新的正式来源 commit；单文件上限1MiB，单binding最多32个活动导入、总计10MiB                                                   |
| 点击“同步导入”，查看任务                                                      | 成功后原文和归一化消息出现在来源文件中；失败保留上次已发布版本，先修复输入，不点加工掩盖错误                                                      |
| 点击“生成”后面的候选处理器名称                                                | 仅提取显式标记的确定性候选，发布在derived；没有匹配内容时不制造“模型总结”                                                                         |
| 搜索已知文本，打开来源和候选                                                  | 核对provider、session/message ID、revision和citation。MCP沿用[快速开始](QUICKSTART.md)的project只读token和search→read步骤                         |

当前配置创建后不可在线修改。scope填错或要换provider时新建正确binding，不修改上传正文伪装为其它项目。选择文件只是本次主动上传，不会因此持续监控本机。

第一次验证请用仓库公开合成材料，避免取真实会话：

1. 选择`Codex session import`，scope填`synthetic-project`，使用推荐`Session candidates (explicit markers)`。
2. 选择[Codex fixture](../plugins/session-connector/fixtures/codex-session.json)，上传→同步导入→生成候选。
3. 搜索`bounded backoff`，打开归一化来源与experience候选，核对固定引用。raw也作为来源文件保留，但不被重复当成另一份消息流提取候选。
4. 另建`Claude session import`来源，scope同为`synthetic-project`，上传[Claude fixture](../plugins/session-connector/fixtures/claude-session.json)；搜索`可重建的全文索引`并读取其来源和memory候选。provider不能在同一binding中混装。

这些JSON是合成接口fixture，不包含用户历史，不是导出工具。等价的Codex绑定请求为：

```json
{
  "name": "Synthetic Codex sessions",
  "connector": {
    "packageRef": "org.opencontext.codex-sessions@0.1.0",
    "config": { "projectScope": "synthetic-project" }
  },
  "processor": {
    "packageRef": "org.opencontext.session-candidates@0.1.0",
    "config": {}
  }
}
```

API等价入口均要求owner：`GET/POST /api/projects/:id/bindings/:bindingId/imports`列举/上传对象；POST携 `filename`、UTF-8 JSON字符串 `content`及 `expectedObjectId`。新建用null；同名更新必须使用刚读取的当前object ID。文件名最长120字符，只用英数、点、下划线、连字符，以英数开头并以`.json`结束。不要把本地 `stagingPath`传给服务器让它读取。

## 原文、归一化与候选

| 层                | 用途                                                                                                   | 不能宣称                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 上传对象/原文来源 | 保留服务器接收的UTF-8 envelope文本字节及hash；来源路径含 `sessions/<provider>/<session hash>/raw.json` | 自动等同厂商磁盘原件，或含所有隐藏/工具/子 Agent 内容             |
| 归一化来源        | 以稳定消息 ID、角色、文本和出处表达受支持内容，便于阅读和检索                                          | raw-only工具/非文本内容已参与文本解析或经验抽取                   |
| 确定性候选        | 从显式 Memory/Rule/Experience 或记忆/规则/经验标记产生可引用的Markdown候选，仍属derived                | LLM 已总结出可信经验、已人工批准、已写入 AGENTS 或已被 Agent 使用 |

来源和候选都通过当前项目授权、freshness和固定版本引用门禁。候选同时记录归一化message和raw的固定revision引用/hash，二者都是派生依赖；候选不能替代原文证据，使用前应打开其来源。原文含指令也只是数据，不授予工具或写文件权限。

候选只识别正文独立行上的 `Memory:`、`Rule:`、`Experience:` 或 `记忆：`、`规则：`、`经验：`（英文大小写不敏感）。没有标记时处理成功但输出为空，旧的本绑定候选由full集合规则清理。彼此矛盾的消息保持为独立候选，不自动裁决优先级，不写用户的AGENTS或规则文件。

如果上传前脱敏，hash对应脱敏后的实际上传字节，不再叫“原始未改字节”。Session上传先调用同一解析器预检，再写blob/对象记录；已知凭据元字段、私钥标记、scope/格式等错误会在落盘前拒绝，正式同步还会复验。但这不是可保证捕获所有秘密的自动脱敏器，用户仍须审查自然语言和工具载荷中的敏感内容。删除已经接受的活动输入不承诺抹除历史blob；不要把撤权当成物理擦除。

## 更新、删除和撤权的使用边界

| 动作                       | 实际影响                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 重复导入同一会话、相同字节 | 去重，不追加重复消息；同会话同时存在冲突内容则拒绝，不做last-write-wins                                                                                                                           |
| 同名导出文件更新后重新上传 | 后台携带当前object ID进行条件更新；409 IMPORT_CONFLICT会清所选文件并刷新列表，需重新选择确认，不自动重试覆盖                                                                                      |
| 更新后“同步导入”           | 新输入形成新revision；稳定消息ID对应稳定身份，完整同会话集合缺失的旧消息可tombstone；未导入其它会话不会被暗中跨范围删除                                                                           |
| “删除导入”→“确认删除”      | 先移除活动输入；下一次“同步导入”才将对应来源从当前集合移除，之后重新生成候选清理旧集合；有权限的source历史仍可读取，旧invalid候选不可返回。上传列表空是明确的空输入集合，不等同厂商返回了一次空页 |
| 撤销整个binding            | 当前授权gate阻止来源及衍生读取；这是权限动作，不需等待再次同步。当前通过owner API `DELETE /api/projects/:id/bindings/:bindingId`，没有Web撤销按钮                                                 |

厂商SDK返回空消息不是完整删除证据；当前空Claude history会拒绝。`DELETE /api/projects/:id/bindings/:bindingId/imports/:objectId`是主动删除输入，与撤权API不同。已复制到外部 Agent 会话的字节无法远程收回。

若发生输入冲突，保留现有正式版本并重新读取当前导入状态；不要靠改 session ID、改 projectScope 或换文件名掩盖同一来源的更新。切换范围应使用独立 binding，不由 envelope 自行改写授权。

## 验证与后续边界

从仓库根可执行以下合成插件契约测试；完整应用检查仍用`pnpm check`：

```sh
pnpm exec vitest run plugins/session-connector/tests/session.test.ts plugins/session-candidates/tests/candidates.test.ts
```

完整协议、raw-only白名单、限制与fixture出处见[连接器说明](../plugins/session-connector/README.md)；候选格式、双引用和async开发接点见[处理器说明](../plugins/session-candidates/README.md)。async接点只验证了合成适配器；当前默认注册没有真实Agent或provider可选。插件合同测试、真实后台上传/检索测试与实际模型采用是不同层次，不能互相代替。

本页与[插件开发](PLUGIN_DEVELOPMENT.md)描述的 static trusted-native 执行一致。[飞书指定群适配器](FEISHU_CHAT.md)已另行接入模拟官方响应验证；真实飞书、团队使用和 Mac 客户端尚未验收。
