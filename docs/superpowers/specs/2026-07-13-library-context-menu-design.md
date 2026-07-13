# 文库条目“AI 带读”右键入口设计

## 目标

在 Zotero 文库条目列表中右击一篇论文记录或其 PDF 附件时，提供“AI 带读”菜单项。点击菜单项后，插件打开或切换到对应 PDF 阅读器标签，展开阅读器右侧上下文栏，并定位到 AI 带读区域。入口操作本身不调用 MinerU 或 LLM API。

## 适用范围

- 支持单选普通文献条目，并从其附件中选择最佳 PDF。
- 支持单选 PDF 附件本身。
- 单选条目没有 PDF 时显示禁用的“AI 带读”菜单项。
- 多选或不支持的条目类型不显示菜单项。
- 不增加 PDF 页面内部的右键菜单。
- 不在点击菜单项时自动开始解析或生成。

## 接口策略

### Zotero 9 当前接口

- 使用 `Zotero.MenuManager.registerMenu()`，目标设为 `main/library/item`。
- 使用 `Zotero.ItemPaneManager.registerSection()` 注册阅读器上下文栏区域。
- 保存两个注册调用返回的实际 ID，并在插件关闭时注销。

### Zotero 7 兼容回退

- 菜单 API 不存在时，在每个主窗口的 `#zotero-itemmenu` 中注册受控的 XUL `menuitem`，并在窗口或插件关闭时移除监听器和节点。当前依赖的 `zotero-plugin-toolkit@5.1.4` 已不暴露旧模板示例中的 `ztoolkit.Menu`，因此不依赖该过时 helper。
- `registerSection()` 不存在而 `registerView()` 存在时，保留旧视图注册路径。
- 所有兼容判断均使用运行时特性检测，不根据版本字符串猜测接口。

## 组件边界

### 文库菜单注册器

负责注册和注销菜单，读取当前单选条目，并控制菜单的可见及禁用状态。命令回调只把选中条目交给打开流程，不包含 PDF 查找或侧栏 DOM 操作。

### PDF 解析器

复用现有 `resolvePdfAttachment()`：PDF 附件直接返回；普通文献优先使用最佳附件，再回退到第一个 PDF 子附件。没有 PDF 时返回可识别错误。

### 阅读器入口协调器

依次执行：

1. 解析 PDF 附件。
2. 调用 `Zotero.Reader.open()` 打开或选择阅读器标签。
3. 等待对应 reader tab 和上下文栏完成初始化。
4. 展开 `ZoteroContextPane`，切换到 item 模式。
5. 使用注册返回的 pane ID 调用当前 item-details 容器的 `scrollToPane()`。

`scrollToPane()` 属于当前 Zotero UI 组件行为而非稳定插件 API，因此调用集中封装，并设置超时。若未来接口变化，PDF 仍保持打开，同时向用户显示“已打开 PDF，但无法自动定位 AI 带读侧栏”的降级提示并记录不含密钥的诊断日志。

### React 侧栏挂载器

Zotero 9 在 `registerSection()` 的同步渲染回调中创建固定容器并挂载 React 根节点；销毁回调卸载根节点。挂载过程必须幂等，重复渲染时复用根节点并更新当前条目 props。条目变化时同步更新启用状态和 React 内容，确保该区域只在 reader 上下文中可用且不会残留上一条目的数据。旧版继续使用现有 `registerView()` 挂载路径。

## 数据流

```text
文库条目右键
  -> MenuManager 上下文（单选条目）
  -> resolvePdfAttachment
  -> Zotero.Reader.open
  -> 等待读取器上下文栏
  -> 展开并 scrollToPane(AI 带读)
  -> 用户自行点击开始解析/生成
```

该流程不读取 API Key，不发起网络请求，也不改变 MinerU 缓存状态。

## 错误处理

- 无 PDF：菜单禁用；若状态在菜单打开后发生变化，命令层仍捕获并提示“该条目没有可用的 PDF 附件”。
- 本地文件缺失：阅读器打开失败时显示中文错误提示。
- 阅读器初始化超时：保留已打开的 PDF，提示用户手动点击右侧 AI 带读图标。
- 菜单或侧栏接口不可用：记录接口名称和 Zotero 版本，不记录 preference 值、Token、Key 或请求内容。
- 重复点击：复用 Zotero 已打开的 reader tab，不创建重复标签。

## 测试与验收

### 自动测试

- 普通条目解析到最佳 PDF。
- PDF 附件直接通过。
- 无 PDF 返回预期错误。
- 菜单状态：单个可用条目启用、单个无 PDF 禁用、多选隐藏。
- 入口流程按顺序执行打开、等待、展开、定位，并覆盖定位超时的降级路径。
- Zotero 9 使用 `registerSection()`；旧接口仅在新接口缺失时回退。

### 本机验收

1. 在 Zotero 文库列表右击 `Book of Proof (Edition 3)`，确认出现“AI 带读”。
2. 点击后确认 PDF 阅读器打开或获得焦点。
3. 确认右侧上下文栏展开并定位到 AI 带读区域。
4. 确认未自动启动 MinerU 解析或 LLM 生成。
5. 对无 PDF 条目和 PDF 附件分别检查菜单状态。
6. 执行测试、lint 和生产构建。

## 非目标

- 不增加 PDF 页面内容区的右键命令。
- 不在入口动作中执行解析、摘要或生成。
- 不创建持久批注。
- 不修改 MinerU、LLM provider、缓存或锚点跳转协议。
