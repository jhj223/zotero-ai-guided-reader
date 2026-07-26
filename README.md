# Zotero AI 带读

面向 Zotero 9.0.x（当前已在 Zotero 9.0.6 验证）的中文论文带读插件。插件用用户自己的 MinerU Token 解析 PDF，再通过用户选择的云端 LLM 或本地 CLI 生成结构化导读。导读论述可点击返回原文，并优先精确选中对应文字。

项目基于 `windingwind/zotero-plugin-template`、`zotero-plugin-scaffold`、TypeScript、React、`zotero-plugin-toolkit`、`zotero-types`、JSZip 和 KaTeX。

## 开发与安装

```bash
npm install
npm test
npm run build
npm start
```

`npm start` 会启动 scaffold 开发模式、编译插件并热重载 Zotero。生产 XPI 由 `npm run build` 生成在 `.scaffold/build/`。

在文库中右击 PDF 附件或含 PDF 的父条目，选择 **AI 带读**；也可以打开 PDF 后，从右侧阅读器侧栏进入。

## 独立配置

在 Zotero 设置的 **AI 带读** 面板配置：

- LLM 提供商：Anthropic、OpenAI、DeepSeek、Qwen、VolcEngine、SiliconFlow、Codex CLI 或 Claude Code CLI。
- 模型：随提供商显示常用模型下拉框，也可选择“自定义模型”。
- 云端 Provider 可点击“获取模型”，使用当前 Key 和 Base URL 刷新可选模型列表；结果会缓存在插件设置中。
- 云端 LLM：填写该提供商自己的 API Key；Base URL 可按需覆盖。
- 本地 CLI：不需要在插件中填写 API Key，但本机必须已安装并登录 `codex` 或 `claude`。插件通过固定参数和标准输入调用，不经过 shell，默认禁止工具、文件读取和会话持久化。
- MinerU：单独填写 `mineru.net/apiManage` 申请的精准解析 Token；它与 LLM Key 完全独立。
- 可选语义定位：默认关闭，不填写也不影响解析、生成和原文定位。可选择 Voyage、OpenAI、Qwen、SiliconFlow、VolcEngine、Jina、Cohere、Ollama，或填写任意 OpenAI 兼容的向量服务。
- 语义定位也提供“获取模型”按钮和模型下拉框，按 Provider 分别缓存结果，并保留“自定义模型”。Voyage/Jina 使用官方公开模型目录，支持模型枚举接口的 Provider 则读取当前账号或本机可用模型。

核心的 LLM Key、MinerU Key 和可选的语义定位 Key 相互独立，均保存在插件 preference namespace：
`extensions.zotero.zoteroaiguidedreader.*`。校验提示会掩码，插件日志不会输出明文 Key。

## MinerU 解析和缓存

当前精准解析流程：

1. `POST https://mineru.net/api/v4/file-urls/batch` 获取上传地址和 batch id。
2. 向签名 URL 上传 PDF。
3. 轮询 `GET https://mineru.net/api/v4/extract-results/batch/{batch_id}`。
4. 下载结果 ZIP，读取 `content_list_v2.json`、`content_list.json`、`middle.json` 和 `full.md`。
5. 缓存结构化锚点、页尺寸及安全筛选后的 PNG/JPEG/WebP 图像资源。

MinerU 默认使用推荐的 `vlm` 模型，直接识别页面视觉内容、公式和复杂版面。模型仍可选择“自动”：有可用 PDF 文字层时使用 `pipeline`，扫描件或文字层过少时使用 `vlm`。OCR 只保留“强制开启”和“不强制开启”两个明确选项，默认不强制；VLM 本身不需要额外强制 OCR。原文定位优先使用 PDF 文本匹配，措辞不同时可启用语义定位兜底。

同一附件按 attachment key 缓存。重新打开文献会自动恢复解析结果、大纲和已生成的章节精读，不会重复消耗 MinerU 额度或 LLM Token。

已知 MinerU 限制：单文件不超过 200MB、200 页；每个账号每天有 1000 页最高优先级额度，超出后可能排队变慢。界面会显示排队、解析进度和完成状态。

额度用尽或接口报错时的降级提示：

> MinerU 解析暂时不可用或排队时间较长。已有缓存将继续保留；没有缓存时，请在最高优先级额度恢复或 API 错误解决后重试。v1 不使用 pdf.js 自建版面解析作为替代，以免丢失公式、表格和多栏阅读顺序。

`samples/mineru/` 预留真实响应样例。没有真实用户 Token 时无法完成线上端到端解析验证，接口版本变化应先保存脱敏响应，再更新 normalizer 和测试。

## 生成与个性化

- 阶段一生成 JSON 大纲，每个要点携带正文 anchor id 和逐字原文 quote；依据图、表或公式生成的论述还会携带单独的视觉锚点。
- 同一论述可保留最多 3 处独立原文证据；多来源时在侧栏折叠显示并可逐处跳转。
- 阶段二只在用户展开章节时生成精读，避免一次把 20–40 页全文送入上下文。
- 精读按原文事实、机制与逻辑、作者判断、边界与局限分组，可展开和收起。
- 大纲和已生成的章节精读都可单独重新生成；重新生成会调用当前所选模型并覆盖对应缓存。
- 读取 `item.getAnnotations(false)`，已标注区域降低展开优先级或标记为“你已关注过”。
- 公式用 KaTeX/MathML 渲染；表格使用安全解析后的 HTML 行列；图像从 MinerU 缓存资源读取。
- 概览和章节精读中凡依据图、表或公式生成的论述，都会显示经本地校验的图表索引；点击后优先高亮对应完整 bbox，失败时降级到所在页面。
- 章节末尾继续集中展示本节涉及的完整公式、表格和图片卡片，视觉锚点按 id 去重。
- 生成大纲后即可保存为 Zotero Note；正文页码和图表索引使用标准 `zotero://open-pdf/...` 链接。
- 生成大纲后即可导出 Anki；已展开章节使用精读内容，未展开章节使用大纲要点。
- Anki 导出通过系统“另存为”窗口生成不含 Zotero 跳转链接的纯问答 UTF-8 TSV（Front、Back、Tags），复习调度由 Anki 的 FSRS 负责。

## 原文定位

定位按以下顺序降级：

1. 在当前 Reader 的字符层精确匹配 LLM 返回的原文 quote，并按 MinerU bbox 解决同页重复文本。
2. 精确匹配失败时，只在 bbox 附近做高置信 OCR 近似匹配；歧义结果不会强行选中。
3. 用户启用语义定位后，前两步都失败时才把当前锚点附近的少量候选原文交给所选向量服务，找回“含义相同但措辞不同”的句子；低分或歧义结果会被拒绝。
4. 无可靠文字匹配时，持续显示对应 bbox 区域高亮。
5. Reader 私有接口变化或页面尚未加载时，至少按 1-based 用户页码跳转到页面。

MinerU `page_idx` 和 Zotero Reader 内部 `pageIndex` 都按 0 开始；`zotero://open-pdf/...?...page=N` 使用用户可见的 1-based 页码，因此链接写入 `page_idx + 1`。

高亮仅保留在当前阅读会话，不创建持久 annotation，也不依赖已知不稳定的 `Zotero.Annotations.saveFromJSON()` 跳转方案。字符级定位依赖 PDF 自带文字层；扫描件、错误 OCR、公式或纯图像区域会降级为 bbox 高亮。

图、表和公式索引直接使用 MinerU 锚点的整对象 bbox，并携带页尺寸完成坐标换算；没有可靠 bbox 时降级为所在页跳转。索引标签和页码均从本地锚点元数据生成，不信任模型自行填写。

语义定位不会代替坐标：向量服务只负责在 MinerU 锚点附近选出候选句，最终高亮仍由 Zotero Reader 字符偏移生成。关闭该功能时不会发出语义定位请求；启用后只发送该次点击所需的 AI 论述和局部候选文本，不发送整篇论文，也不记录 Key 或候选正文。

## 已知限制

- MinerU 在线解析必须由用户 Token 实测；不同账号或后续 API 版本可能调整响应字段。
- 精确高亮使用 Zotero Reader 私有字段，并已针对 Zotero 9.0.6 加防御性降级；Zotero 后续升级可能需要适配。
- 旧版 v2 缓存不含图像文件和明确 bbox 坐标空间。定位异常或看不到图表时，手动重新解析一次以生成 v3 缓存。
- 图、表和公式支持完整对象级定位；子图、曲线、数据点、表格单元格和公式子表达式级定位不在当前范围。
- 本地 Codex/Claude CLI 会使用用户现有登录状态和模型额度；插件不代管登录。
- 不同语义向量厂商的模型名称和可用额度会变化；预设失效时可填写厂商当前模型，非预设厂商可使用“自定义 OpenAI 兼容接口”。
- 不包含插件商店上架流程。

## 后续方向

- 用脱敏的真实 MinerU 响应扩充版本兼容测试。
- 跟随 Zotero Reader 公共定位 API，逐步替换私有字段。
- 增加图表区域与正文引用之间的关系抽取。
- 增加缓存管理、单篇成本统计和可选重生成策略。

## 参考实现与文档

- Zotero 7 插件开发：https://www.zotero.org/support/dev/zotero_7_for_developers
- Zotero Reader 源码：https://github.com/zotero/reader
- Zotero MCP 文本定位参考：https://github.com/54yyyu/zotero-mcp
- MinerU：https://github.com/opendatalab/MinerU
- MinerU 输出格式：https://opendatalab.github.io/MinerU/reference/output_files/
- Codex CLI：https://github.com/openai/codex
- Claude Code CLI：https://docs.anthropic.com/en/docs/claude-code/cli-usage
