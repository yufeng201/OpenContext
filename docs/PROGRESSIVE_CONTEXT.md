# Markdown 上下文与渐进式披露

上下文正文以 Markdown 文件为核心：当前官方 Session 记忆/规则/经验候选和 Markdown 导航处理器输出 `.md`，保留稳定 fileId、不可变 revision、原始材料的固定引用/hash 和 derivedFrom。Session 原始 envelope 仍为 `.json`，归一化消息仍为结构化 JSON；不把原件改写成 Markdown 后冒称原格式保留。搜索/向量索引、控制元数据及原始多模态附件不是记忆正文权威来源。这项约束针对上下文与记忆，不禁止网站、视频等合法插件产物。

当前支持的渐进路径：

1. `files PROJECT LIMIT` / SDK filesPage / REST files 分页发现文件路径、大小、稳定身份与版本，读取目录不返回正文。MCP context_tree 兼容旧调用，支持现有分页模式；文件目录不自动摘要；Markdown另可用 outline=true 读取确定性ATX标题/行号/层级目录，不使用LLM。超大目录优先分页。
2. 搜索默认最多10条、上限50条；单命中片段最多512字符，响应片段总量受4096字符约束。结果带固定 revision 引用。这里的搜索片段不是全文证据。
3. `context_read`、REST read、SDK read 和 CLI read 可按行、ATX 标题章节和明确字节预算读取同一个固定版本。当前权限/来源撤销 gate 每次执行，不能凭历史引用绕过。
4. 需要更多上下文时继续读取该选择范围的下一段，或显式读全文。候选的 `Provenance` 章节提供原始归一化消息及 raw 的版本引用/hash；按需再读这些原件，而不是只相信生成正文。

## 可执行读取契约

固定 `projectId/fileId/revisionId` 仍必需。新增参数全部可选，旧版不带新参数时保持全文结果和旧响应形状：

| 参数                 | 含义与边界                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| outline              | true 时返回标题目录而不返回正文；maxBytes 约束目录 JSON 字节，最多200项；startLine 为目录分页起点，nextOutlineLine 给出下一页起点；不能与 section、maxLines、offsetBytes 混用 |
| startLine / maxLines | 1-based 起始行；默认第1行、最多40行；maxLines 1–200                                                                                                                           |
| section              | `.md` 文件内唯一、大小写精确的 ATX 标题正文；包含子标题，到下一同级/上级标题前结束；忽略 fenced code 内标题；不支持 Setext 标题；不存在/重名拒绝                              |
| maxBytes             | 返回正文 UTF-8 预算4–65536字节；只要指定任一新参数，省略时默认8192字节                                                                                                        |
| offsetBytes          | 选择范围内续读偏移，默认0，必须是UTF-8边界；预算截断不会返回半个字符                                                                                                          |

section 不能与行参数混用。返回 `disclosure` 包含选择模式、起始行、全文/选择/返回字节数、offsetBytes、nextOffsetBytes 和返回片段 textHash。nextOffsetBytes=null 表示选定范围结束，不代表已经读完整个文件。非null 时重用同样 file/revision/section 或行范围，仅更新 offsetBytes，直到该范围完成。

citation.contentHash 和 file.contentHash **始终是完整原文件 hash**，片段只用 disclosure.textHash 校验。SDK验证返回片段hash、字节数及请求预算，拒绝服务器忽略选择器返回全文；不能用片段重算全文hash，也不把片段保存成一个新的正式 revision。旧客户端不懂新增 disclosure 时应继续只用旧全文调用。预算约束的是返回正文；编码传输另有有限预算：正文对象16MiB，read JSON112MiB（最坏6倍转义+16MiB metadata），MCP工具结果256MiB+1024字节（重复与再次转义），其他查询16MiB。SDK/CLI默认支持该正文范围的合法UTF-8全文；自定义更紧响应预算、期限或工作量限制仍可拒绝。正文超限413 BYTE_LIMIT，传输预算超限RESPONSE_TOO_LARGE，不截断成功返回；超过对象上限不能靠片段读取绕过。详见[查询接入](QUERY_ACCESS.md)。服务端当前仍先读取并校验完整存储对象，不宣称流式磁盘读取或只读取片段的I/O成本。

Reader默认8KiB有限读取，展示章节目录，可点击标题按行读取，点击“读取下一段”续读或显式“读取全文”。刷新固定引用仍从有限读取开始；续读片段采用惰性文本呈现，避免缺少围栏前文时误解Markdown结构。

存储读取前先检查revision字节数，并在非阻塞/拒末级链接的fd打开后用fstat复检对象为普通文件且不超过16MiB，再进行有界读取和完整hash/UTF-8验证；超限返回BYTE_LIMIT，不先把超大对象加载到内存再截取。章节解析逐行扫描，避免全量split形成百万行数组。依然会读取上限内的完整对象并扫描，没有宣称流式片段I/O或慢文件系统墙钟保证；并发容量仍需独立验收。

CLI示例（使用已有、明确授权的查询环境；不创建凭据）：

```sh
pnpm cli read "$PROJECT" "$FILE" "$REVISION" --outline true --max-bytes 4096
pnpm cli read "$PROJECT" "$FILE" "$REVISION" --section Content --max-bytes 4096
pnpm cli read "$PROJECT" "$FILE" "$REVISION" --start-line 1 --max-lines 20 --max-bytes 2048
pnpm cli read "$PROJECT" "$FILE" "$REVISION" --section Content --max-bytes 4096 --offset-bytes "$NEXT_OFFSET"
```

SDK使用第四个参数，例如 `{ section: 'Content', maxBytes: 4096 }`；MCP context_read arguments 加入相同属性；REST将其作为read query参数。不接受仅fileId、head替代revisionId、未知参数或超限值。CLI仍只读，不写客户端配置。

Session候选以 `Status`、`Provenance`、`Content` 三个章节支持逐层读取。它们仍是确定性显式标记候选，不是LLM语义总结，也不是已批准的Agent规则；再次加工产生新revision，不改旧版正文。其他现有处理器也保留Markdown和lineage，但不保证这些相同章节。

尚未交付：自动多模态附件下载/字节入库、自动摘要/持久标题索引、语义记忆提炼、真实客户端导出器、自动上下文预算组装、所有第三方插件的记忆格式准入。现有静态插件格式以执行测试约束；没有宣称通用插件类型规则或真实Agent调用已通过。

原始Session的非文本事件可以保留在raw JSON，但尚未为外部多模态附件实际字节建立独立revision；不能把保留路径/URL称为已下载并版本化附件。当前可点击和读回的lineage依赖是已入库的文本材料。
