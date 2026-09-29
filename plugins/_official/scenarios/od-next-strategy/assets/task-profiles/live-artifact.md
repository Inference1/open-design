# 实时产物 Skill v3.1.0

适用可刷新看板、同步报告。route=live-artifact、kind=live。先确认真实数据来源与刷新方式，使用用户授权的本地数据或现有连接器；静态样例不得声称实时同步。

需要连接器时先运行 `"$OD_NODE_BIN" "$OD_BIN" tools connectors list --format compact`，通过已连接的只读工具读取。不要重复询问已知来源，不绕过权限、不直接持有供应商 token。未连接或请求不明确时澄清具体缺口。禁止自行创建定时刷新或外部写入。

制作 template.html、data.json、artifact.json、provenance.json；模板仅用转义的 {{data.path}} 和单层 data-od-repeat="item in data.items"，不使用未转义 HTML 注入。数据仅保留预览所需字段、来源和时间，不保存凭据、请求头或完整原始响应。

artifact.json 示例结构：
```json
{"title":"数据看板","slug":"data-dashboard","preview":{"type":"html","entry":"index.html"},"document":{"format":"html_template_v1","templatePath":"template.html","generatedPreviewPath":"index.html","dataPath":"data.json","dataJson":{"summary":{"value":42}}}}
```

可刷新的本地 JSON 来源必须在 document.sourceJson 中声明，例如：
```json
{"type":"local_file","toolName":"project_files.read_json","input":{"path":"source.json"},"outputMapping":{"dataPaths":[{"from":"json.tasks","to":"tasks"}],"transform":"identity"},"refreshPermission":"manual_refresh_granted_for_read_only"}
```
outputMapping 的 from/to 使用实际字段名；示例表示将源文件 tasks 复制到预览数据的 tasks。将实际数据写入同目录 data.json，CLI 会读入 document.dataJson。provenance.json 使用 {"generatedAt":"<当前 ISO 时间>","generatedBy":"agent","sources":[{"label":"用户提供的数据","type":"local_file","ref":"source.json"}]}。只有声明了真实 sourceJson 的注册才支持重新读取来源；缺少来源时只能交付静态快照并明确说明。

以下命令、JSON 与文件结构是内部制作说明，不复制到面向用户的计划或完成回复。普通设计请求只说明看板内容、数据来源、刷新方式和设计方向，例如：“制作任务状态看板，读取你提供的本地示例，展示任务和状态；采用清晰的浅色布局，支持手动刷新。”

直接使用现有 OD_NODE_BIN/OD_BIN 环境变量执行以下命令，不用 env/printenv 枚举环境或读取配置、凭据。直接按以上现有 CLI 和输入结构制作，不查找宿主源码或重新实现注册服务。需要了解命令选项时运行 tools live-artifacts --help；失败根据返回的结构化字段修正，不循环猜测接口。

生产阶段运行 `"$OD_NODE_BIN" "$OD_BIN" tools live-artifacts create --input artifact.json`。更新已有产物则用 update --artifact-id <已知ID> --input artifact.json。不要提供 daemon 拥有的 id/projectId/timestamps；只使用工具返回的 ID 和文件。index.html 是 daemon 生成的预览，不由 Agent 冒造。对用户说明产物名称即可；内部选择稳定的小写连字符 slug，create 输入使用该 slug，不向用户解释内部标识。使用工具返回的真实注册 ID 和预览入口，不猜测随机 ID。不把复制的静态 HTML 冒充可刷新入口。更新时保留同一个注册 ID 与 slug。

注册失败如实报告并保留源文件。渲染源数据属于制作步骤，完成后不再启动循环评价。

## 数据与刷新规则

- 普通静态看板不因“看板”二字就注册实时产物。需要刷新时，优先用户已指定的本地文件或已连接数据源；使用 connected 且只读、支持刷新的工具，不能把外部写操作绑定刷新按钮。
- 连接器调用使用 tools connectors execute 的现有入口；只记录安全 connectorId、toolName、accountLabel、必要 input 和 outputMapping。源字段与预览字段对应，刷新不得重做模板。
- 用户点名已连接的来源时，先用目录中实际存在的只读搜索工具按主题定位内容，不重复询问已知来源。例如Notion先搜索，只有给定或搜索确认数据库ID后才获取数据库；多个候选或主题不足时才澄清具体页面/主题。
- JSON 边界：深度最多8、每对象100键、数组500项、单字符串16KiB、总量256KiB；超过时聚合为预览所需数据，不保存完整接口响应。
- 所有会随来源变化的展示字段必须随 sourceJson/outputMapping 更新。来源只有任务数组时可直接展示列表；不能把首次统计的总数、完成数等硬编码到 data.json 后声称它们实时刷新。不能可靠重新计算的派生指标就不展示。
- 绑定仅支持转义文本与单层 repeat；不用嵌套循环、过滤器或脚本表达式，也不在 script/style、事件属性、标签名或 srcdoc 中插值。空数据、旧数据和读取失败要有可理解的展示。
- 首次注册及后续更新都接受宿主校验；根据具体错误修正自己提供的输入，不能绕过校验。刷新失败保留之前有效内容，不把失败标成同步成功；没有用户授权不得安排定时刷新。
