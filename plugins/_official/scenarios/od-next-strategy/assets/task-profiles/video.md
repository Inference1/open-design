# 视频交付 Skill v3.1.0

交付的是实际可播放的 MP4。HTML 动画、脚本、分镜、工具 taskId 都不能代替 MP4。

先确定内容、时长、比例、是否有声音。明确的请求直接使用用户参数，低影响缺项可以说明默认值。用户只要文字动效时可以使用 HyperFrames 本地渲染；需要实拍/生成式画面时使用可用的媒体模型，不把文字动画冒充写实视频。

## 文字动效的制作路线

在 production 阶段使用现有媒体 CLI：

1. 用原生 Shell 执行 `"$OD_NODE_BIN" "$OD_BIN" media scaffold --project "$OD_PROJECT_ID" --composition-dir .hyperframes-cache/video`。
2. 读取生成的 index.html，修改文字、配色、布局和 GSAP 时间线。保留脚手架的注册方式，根元素 data-duration 与时长匹配。源文件放在隐藏目录，不另建占位网页。
3. 执行 `"$OD_NODE_BIN" "$OD_BIN" media generate --project "$OD_PROJECT_ID" --surface video --model hyperframes-html --output video.mp4 --composition-dir .hyperframes-cache/video`。
4. generate 若返回 taskId，继续用 `"$OD_NODE_BIN" "$OD_BIN" media wait <taskId> --since <nextSince>` 等待。退出码 2 表示仍运行，0 表示完成，5 表示失败。每次 wait 有限等待；不能把排队成功当完成。

渲染是产生交付物所需的 Build 步骤，允许执行。生成成功后不额外截图、播放打分或开启循环评价。失败时说明失败，不生成假视频或仅改扩展名。

在普通文本计划中说明视频的制作方式和输出路径；视频成功后继续完成用户要求的其他产物。

媒体工具失败后说明失败及缺口，不自行直接调用 HyperFrames CLI，不搜索或修改运行环境、不安装依赖。运行环境问题由宿主修复，不能用另一条未申明的路径冒充正式媒体链路成功。

生成式视频先通过 media --help 与 generate --help 发现当前模型与参数，再使用相同 media generate / wait 流程；只使用可用模型，保留现有权限和配额。输出路径按计划，不把多个视频覆盖到同一个固定文件。

规划阶段先通过 `"$OD_NODE_BIN" "$OD_BIN" media models --json` 查询当前注册模型；使用目录中匹配 surface 的真实模型 ID，在内部确定使用该模型。HyperFrames 本地成片的 modelId 为 hyperframes-html。制作时使用相同模型，不静默切换供应商。

模型目录表示支持的模型，不等于供应商已配置或配额可用。优先用户明确指定的服务，否则沿用当前已配置且支持所需能力的服务；不要因目录排名而换供应商。配置缺失或配额不足时只说明所缺能力和设置入口，不索取用户在聊天中粘贴密钥。

## 画面与时间规则

- 先将内容拆成有叙事目的的镜头或片段，锁定文案、时长、比例、声音及品牌素材；首段尽早呈现主题。场景之间保持人物、商品、光线和配色连续。
- 文字按阅读时间安排停留，字幕与对应话语对齐，避开画面边缘和播放器遮挡；不要用快速动效掩盖信息。转场服务叙事，不能让每个镜头随机采用不同风格。
- 本地动效保留 scaffold 的固定画布、data-duration、暂停时间线与 window.__timelines 注册；用时间线明确开始、结束、缓动，禁止依赖随机实时时钟导致渲染不确定。总时长覆盖所有片段，音轨不提前截断。
- 输入图像保持原比例与主体完整。生成式画面按能力使用参考图，无法锁定角色或精确文字时说明限制；不将工具返回时长之外的内容虚构为已生成。
- 多个视频使用独立 composition 目录和输出文件。作为视频制作依赖的音频或时间线不自动增加独立主交付物；用户另要可编辑源码时才额外交付源码。
