# 文库条目“AI 带读”右键入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Zotero 文库列表右击单篇论文或 PDF 附件时显示“AI 带读”，点击后打开对应 PDF 并聚焦 Zotero 9 的 AI 带读侧栏，且不自动调用 MinerU 或 LLM。

**Architecture:** 用纯函数计算菜单可见和启用状态；用 `Zotero.MenuManager` 注册 Zotero 9 文库菜单，并保留旧版窗口级 XUL 回退。阅读器侧栏优先改用 `ItemPaneManager.registerSection()`，旧版才回退到现有 `registerView()`；打开 PDF 与聚焦侧栏由可注入依赖的协调器完成，以便在 Node 测试中覆盖时序和降级路径。

**Tech Stack:** TypeScript 5、React 19、Zotero 7-9 bootstrapped plugin API、zotero-plugin-scaffold、zotero-types、Node `node:test`。

---

## 文件结构

- Create: `src/core/librarySelection.ts` - 纯函数判断右键选择是否支持 AI 带读。
- Create: `src/core/zoteroCompatibility.ts` - 选择当前可用的侧栏注册 API。
- Create: `src/runtime/openGuidedReader.ts` - 解析 PDF、打开 reader、等待并聚焦侧栏。
- Create: `src/runtime/libraryContextMenu.ts` - 注册 Zotero 9 菜单与旧版窗口级回退菜单。
- Modify: `src/runtime/readerView.tsx` - 使用 `registerSection()` 挂载 React，并保留 `registerView()` 回退。
- Modify: `src/hooks.ts` - 接入菜单和侧栏的注册、窗口加载与注销生命周期。
- Modify: `addon/locale/en-US/mainWindow.ftl` - 英文菜单名称。
- Modify: `addon/locale/zh-CN/mainWindow.ftl` - 中文菜单名称。
- Modify: `typings/i10n.d.ts` - 纳入新 Fluent message ID；构建时由 scaffold 校验生成结果。
- Create: `test/librarySelection.test.ts` - 菜单状态单元测试。
- Create: `test/zoteroCompatibility.test.ts` - Zotero 9 优先及旧版回退测试。
- Create: `test/openGuidedReader.test.ts` - 打开顺序、重试、成功和降级测试。

### Task 1: 文库选择状态纯函数

**Files:**

- Create: `src/core/librarySelection.ts`
- Test: `test/librarySelection.test.ts`

- [ ] **Step 1: 写入失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  getLibraryMenuState,
  type PdfInspectableItem,
} from "../src/core/librarySelection";

function makeItem(options: {
  id: number;
  pdf?: boolean;
  regular?: boolean;
  attachments?: number[];
}): PdfInspectableItem {
  return {
    id: options.id,
    isPDFAttachment: () => options.pdf === true,
    isRegularItem: () => options.regular === true,
    getAttachments: () => options.attachments || [],
  };
}

test("enables AI guided reading for one selected PDF", () => {
  const pdf = makeItem({ id: 1, pdf: true });
  assert.deepEqual(
    getLibraryMenuState([pdf], () => undefined),
    {
      visible: true,
      enabled: true,
      item: pdf,
    },
  );
});

test("enables a regular item when one child attachment is a PDF", () => {
  const paper = makeItem({ id: 1, regular: true, attachments: [2, 3] });
  const children = new Map([
    [2, makeItem({ id: 2 })],
    [3, makeItem({ id: 3, pdf: true })],
  ]);
  assert.deepEqual(
    getLibraryMenuState([paper], (id) => children.get(id)),
    {
      visible: true,
      enabled: true,
      item: paper,
    },
  );
});

test("keeps the menu visible but disabled for a paper without a PDF", () => {
  const paper = makeItem({ id: 1, regular: true, attachments: [2] });
  assert.deepEqual(
    getLibraryMenuState([paper], () => makeItem({ id: 2 })),
    { visible: true, enabled: false, item: paper },
  );
});

test("hides the menu for multiple selection or unsupported item types", () => {
  const paper = makeItem({ id: 1, regular: true });
  const second = makeItem({ id: 2, regular: true });
  assert.deepEqual(
    getLibraryMenuState([paper, second], () => undefined),
    {
      visible: false,
      enabled: false,
    },
  );
  assert.deepEqual(
    getLibraryMenuState([makeItem({ id: 3 })], () => undefined),
    { visible: false, enabled: false },
  );
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/librarySelection.test.ts`

Expected: FAIL，错误包含 `Cannot find module '../src/core/librarySelection'`。

- [ ] **Step 3: 实现最小纯函数**

```ts
export interface PdfInspectableItem {
  id: number;
  isPDFAttachment(): boolean;
  isRegularItem(): boolean;
  getAttachments(): number[];
}

export interface LibraryMenuState<T extends PdfInspectableItem> {
  visible: boolean;
  enabled: boolean;
  item?: T;
}

export function getLibraryMenuState<T extends PdfInspectableItem>(
  items: readonly T[] | undefined,
  lookupItem: (id: number) => T | false | undefined,
): LibraryMenuState<T> {
  if (!items || items.length !== 1) {
    return { visible: false, enabled: false };
  }

  const item = items[0];
  if (item.isPDFAttachment()) {
    return { visible: true, enabled: true, item };
  }
  if (!item.isRegularItem()) {
    return { visible: false, enabled: false };
  }

  const enabled = item
    .getAttachments()
    .some((id) => lookupItem(id)?.isPDFAttachment() === true);
  return { visible: true, enabled, item };
}
```

- [ ] **Step 4: 运行目标测试**

Run: `npx tsx --test test/librarySelection.test.ts`

Expected: 4 tests PASS。

- [ ] **Step 5: 提交该逻辑单元**

```powershell
git add src/core/librarySelection.ts test/librarySelection.test.ts
git commit -m "feat(menu): add library selection state"
```

### Task 2: Zotero 9 侧栏注册迁移

**Files:**

- Create: `src/core/zoteroCompatibility.ts`
- Create: `test/zoteroCompatibility.test.ts`
- Modify: `src/runtime/readerView.tsx`

- [ ] **Step 1: 写入 API 选择失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { chooseReaderPaneApi } from "../src/core/zoteroCompatibility";

test("prefers registerSection on Zotero 9", () => {
  assert.equal(
    chooseReaderPaneApi({ registerSection() {}, registerView() {} }),
    "section",
  );
});

test("falls back to registerView for older Zotero", () => {
  assert.equal(chooseReaderPaneApi({ registerView() {} }), "view");
});

test("reports no API when neither registration function exists", () => {
  assert.equal(chooseReaderPaneApi({}), "none");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/zoteroCompatibility.test.ts`

Expected: FAIL，错误包含 `Cannot find module '../src/core/zoteroCompatibility'`。

- [ ] **Step 3: 实现 API 选择函数**

```ts
export type ReaderPaneApi = "section" | "view" | "none";

export function chooseReaderPaneApi(manager: {
  registerSection?: unknown;
  registerView?: unknown;
}): ReaderPaneApi {
  if (typeof manager.registerSection === "function") return "section";
  if (typeof manager.registerView === "function") return "view";
  return "none";
}
```

- [ ] **Step 4: 将 `readerView.tsx` 改为新接口优先**

用以下完整内容替换 `src/runtime/readerView.tsx`：

```tsx
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { chooseReaderPaneApi } from "../core/zoteroCompatibility";
import { GuidedReaderApp } from "../ui/GuidedReaderApp";
import { getLocaleID } from "../utils/locale";

type RegistrationKind = "section" | "view";

interface SectionHookProps {
  body: HTMLElement;
  item: Zotero.Item;
  tabType: "library" | "reader";
  setEnabled(enabled: boolean): void;
}

interface ReaderPaneManager {
  registerSection?: (options: {
    paneID: string;
    pluginID: string;
    header: { l10nID: string; icon: string };
    sidenav: { l10nID: string; icon: string };
    onItemChange(props: SectionHookProps): void;
    onRender(props: SectionHookProps): void;
    onDestroy(props: { body: HTMLElement }): void;
  }) => string | false;
  unregisterSection?: (id: string) => boolean;
  registerView?: (options: {
    id: string;
    pluginID: string;
    label: string;
    mode: string[];
    header: { l10nID: string; icon: string };
    sidenav: { l10nID: string; icon: string };
    onReady(props: { item?: Zotero.Item; target: HTMLElement }): void;
    onDestroy(props: { target: HTMLElement }): void;
  }) => string | false;
  unregisterView?: (id: string) => boolean;
}

const roots = new WeakMap<Element, Root>();
const PANE_LOCAL_ID = "guided-reader";
let registeredPaneID: string | false | undefined;
let registrationKind: RegistrationKind | undefined;

export function registerReaderView(): void {
  if (registeredPaneID) return;

  const manager = Zotero.ItemPaneManager as unknown as ReaderPaneManager;
  const api = chooseReaderPaneApi(manager);
  const header = {
    l10nID: getLocaleID("reader-view-head"),
    icon: "chrome://zotero/skin/16/universal/book.svg",
  };
  const sidenav = {
    l10nID: getLocaleID("reader-view-sidenav"),
    icon: "chrome://zotero/skin/20/universal/book.svg",
  };

  if (api === "section" && manager.registerSection) {
    registeredPaneID = manager.registerSection({
      paneID: PANE_LOCAL_ID,
      pluginID: addon.data.config.addonID,
      header,
      sidenav,
      onItemChange: ({ tabType, setEnabled }) => {
        setEnabled(tabType === "reader");
      },
      onRender: ({ body, item, tabType, setEnabled }) => {
        const enabled = tabType === "reader";
        setEnabled(enabled);
        if (enabled) mount(body, item);
        else unmount(body);
      },
      onDestroy: ({ body }) => unmount(body),
    });
    registrationKind = registeredPaneID ? "section" : undefined;
    if (!registeredPaneID) {
      ztoolkit.log("ItemPaneManager.registerSection rejected guided-reader");
    }
    return;
  }

  if (api === "view" && manager.registerView) {
    registeredPaneID = manager.registerView({
      id: PANE_LOCAL_ID,
      pluginID: addon.data.config.addonID,
      label: "AI Guided Reader",
      mode: ["reader"],
      header,
      sidenav,
      onReady: ({ item, target }) => mount(target, item),
      onDestroy: ({ target }) => unmount(target),
    });
    registrationKind = registeredPaneID ? "view" : undefined;
    if (!registeredPaneID) {
      ztoolkit.log("ItemPaneManager.registerView rejected guided-reader");
    }
    return;
  }

  ztoolkit.log(
    "No supported ItemPaneManager section/view registration API is available",
  );
}

export function unregisterReaderView(): void {
  const manager = Zotero.ItemPaneManager as unknown as ReaderPaneManager;
  if (typeof registeredPaneID === "string") {
    if (registrationKind === "section") {
      manager.unregisterSection?.(registeredPaneID);
    } else if (registrationKind === "view") {
      manager.unregisterView?.(registeredPaneID);
    }
  }
  registeredPaneID = undefined;
  registrationKind = undefined;
}

export function getRegisteredReaderPaneID(): string | undefined {
  return typeof registeredPaneID === "string" ? registeredPaneID : undefined;
}

function mount(target: HTMLElement, item?: Zotero.Item): void {
  const doc = target.ownerDocument;
  let container = target.querySelector<HTMLElement>(
    ".zotero-ai-guided-reader-root",
  );
  if (!container) {
    container = doc.createElement("div");
    container.className = "zotero-ai-guided-reader-root";
    target.appendChild(container);
  }

  let root = roots.get(target);
  if (!root) {
    root = createRoot(container);
    roots.set(target, root);
  }
  root.render(
    item ? (
      <GuidedReaderApp item={item} key={item.id} />
    ) : (
      <div>Open a PDF reader tab to use AI Guided Reader.</div>
    ),
  );
}

function unmount(target: Element): void {
  const root = roots.get(target);
  if (root) {
    root.unmount();
    roots.delete(target);
  }
  target.querySelector(".zotero-ai-guided-reader-root")?.remove();
}
```

- [ ] **Step 5: 运行目标测试、类型检查和构建**

Run: `npx tsx --test test/zoteroCompatibility.test.ts`

Expected: 3 tests PASS。

Run: `npm run build`

Expected: scaffold build 完成且 `tsc --noEmit` 退出码为 0。

- [ ] **Step 6: 提交侧栏迁移**

```powershell
git add src/core/zoteroCompatibility.ts src/runtime/readerView.tsx test/zoteroCompatibility.test.ts
git commit -m "fix(reader): register guided view on Zotero 9"
```

### Task 3: 打开 PDF 并聚焦 AI 带读

**Files:**

- Create: `src/runtime/openGuidedReader.ts`
- Test: `test/openGuidedReader.test.ts`

- [ ] **Step 1: 写入协调流程失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  focusGuidedReaderPane,
  openGuidedReaderForItem,
} from "../src/runtime/openGuidedReader";

test("opens the resolved PDF before focusing the registered pane", async () => {
  const calls: string[] = [];
  const attachment = { id: 42 } as Zotero.Item;
  const result = await openGuidedReaderForItem({ id: 7 } as Zotero.Item, {
    resolvePdf: async () => {
      calls.push("resolve");
      return attachment;
    },
    openReader: async (id) => {
      calls.push(`open:${id}`);
    },
    getPaneID: () => "plugin-guided-reader",
    getMainWindow: () => ({
      ZoteroContextPane: {
        collapsed: true,
        context: { mode: "notes" },
        sidenav: {
          container: {
            tabType: "reader",
            getEnabledPane: () => ({}),
            scrollToPane: async (id) => calls.push(`focus:${id}`),
          },
        },
      },
    }),
    delay: async () => {},
    attempts: 1,
  });

  assert.deepEqual(calls, ["resolve", "open:42", "focus:plugin-guided-reader"]);
  assert.deepEqual(result, { attachment, paneFocused: true });
});

test("retries until the reader item-details container is ready", async () => {
  let checks = 0;
  const focused = await focusGuidedReaderPane(
    {
      ZoteroContextPane: {
        collapsed: true,
        context: { mode: "notes" },
        sidenav: {
          container: {
            tabType: "reader",
            getEnabledPane: () => (++checks < 3 ? null : {}),
            scrollToPane: async () => true,
          },
        },
      },
    },
    "plugin-guided-reader",
    { attempts: 3, delay: async () => {} },
  );
  assert.equal(focused, true);
  assert.equal(checks, 3);
});

test("returns a non-throwing fallback when pane activation times out", async () => {
  const focused = await focusGuidedReaderPane(
    {
      ZoteroContextPane: {
        collapsed: true,
        context: { mode: "item" },
        sidenav: { container: undefined },
      },
    },
    "plugin-guided-reader",
    { attempts: 2, delay: async () => {} },
  );
  assert.equal(focused, false);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/openGuidedReader.test.ts`

Expected: FAIL，错误包含 `Cannot find module '../src/runtime/openGuidedReader'`。

- [ ] **Step 3: 实现可注入的打开和聚焦协调器**

```ts
import { getRegisteredReaderPaneID } from "./readerView";
import { resolvePdfAttachment } from "./zoteroItems";

interface PaneContainer {
  tabType?: string;
  getEnabledPane?: (paneID: string) => unknown;
  scrollToPane?: (
    paneID: string,
    behavior: "instant" | "smooth",
  ) => Promise<unknown> | unknown;
}

interface GuidedReaderWindow {
  ZoteroContextPane?: {
    collapsed: boolean;
    context?: { mode?: string };
    sidenav?: { container?: PaneContainer };
  };
}

interface OpenDependencies {
  resolvePdf(item: Zotero.Item): Promise<Zotero.Item>;
  openReader(itemID: number): Promise<unknown>;
  getPaneID(): string | undefined;
  getMainWindow(): GuidedReaderWindow | undefined;
  delay(milliseconds: number): Promise<void>;
  attempts: number;
}

const defaults: OpenDependencies = {
  resolvePdf: resolvePdfAttachment,
  openReader: (itemID) => Zotero.Reader.open(itemID),
  getPaneID: getRegisteredReaderPaneID,
  getMainWindow: () => Zotero.getMainWindow() as GuidedReaderWindow,
  delay: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts: 40,
};

export async function openGuidedReaderForItem(
  item: Zotero.Item,
  overrides: Partial<OpenDependencies> = {},
): Promise<{ attachment: Zotero.Item; paneFocused: boolean }> {
  const dependencies = { ...defaults, ...overrides };
  const attachment = await dependencies.resolvePdf(item);
  await dependencies.openReader(attachment.id);

  const paneID = dependencies.getPaneID();
  const win = dependencies.getMainWindow();
  const paneFocused =
    paneID && win
      ? await focusGuidedReaderPane(win, paneID, {
          attempts: dependencies.attempts,
          delay: dependencies.delay,
        })
      : false;
  return { attachment, paneFocused };
}

export async function focusGuidedReaderPane(
  win: GuidedReaderWindow,
  paneID: string,
  options: {
    attempts: number;
    delay(milliseconds: number): Promise<void>;
  },
): Promise<boolean> {
  const contextPane = win.ZoteroContextPane;
  if (!contextPane) return false;

  contextPane.collapsed = false;
  if (contextPane.context) contextPane.context.mode = "item";

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const container = contextPane.sidenav?.container;
    if (
      container?.tabType === "reader" &&
      container.getEnabledPane?.(paneID) &&
      container.scrollToPane
    ) {
      await container.scrollToPane(paneID, "instant");
      return true;
    }
    await options.delay(50);
  }
  return false;
}
```

- [ ] **Step 4: 运行目标测试**

Run: `npx tsx --test test/openGuidedReader.test.ts`

Expected: 3 tests PASS。

- [ ] **Step 5: 提交打开协调器**

```powershell
git add src/runtime/openGuidedReader.ts test/openGuidedReader.test.ts
git commit -m "feat(reader): open and focus guided reading pane"
```

### Task 4: 注册文库右键菜单并接入生命周期

**Files:**

- Create: `src/runtime/libraryContextMenu.ts`
- Modify: `src/hooks.ts`
- Modify: `addon/locale/en-US/mainWindow.ftl`
- Modify: `addon/locale/zh-CN/mainWindow.ftl`
- Modify: `typings/i10n.d.ts`

- [ ] **Step 1: 添加 Fluent 文案**

`addon/locale/zh-CN/mainWindow.ftl`：

```ftl
reader-view-head =
    .label = AI 带读
reader-view-sidenav =
    .tooltiptext = AI 带读
library-menu-ai-guided-reading = AI 带读
```

`addon/locale/en-US/mainWindow.ftl`：

```ftl
reader-view-head =
    .label = AI Guided Reader
reader-view-sidenav =
    .tooltiptext = AI Guided Reader
library-menu-ai-guided-reading = AI Guided Reader
```

在 `typings/i10n.d.ts` 的 union 中加入 `'library-menu-ai-guided-reading'`，随后由构建命令确认该生成类型与 FTL 一致。

- [ ] **Step 2: 实现 Zotero 9 菜单和命令错误边界**

本地 `zotero-plugin-toolkit@5.1.4` 不再提供旧模板中的 `ztoolkit.Menu`，因此标准路径使用 Zotero 当前 API，旧版路径创建并受控清理一个 XUL 节点。创建 `src/runtime/libraryContextMenu.ts`：

```ts
import { getLibraryMenuState } from "../core/librarySelection";
import { getLocaleID } from "../utils/locale";
import { openGuidedReaderForItem } from "./openGuidedReader";

interface LibraryMenuContext {
  items?: Zotero.Item[];
  setVisible(visible: boolean): void;
  setEnabled(enabled: boolean): void;
}

interface MenuManagerLike {
  registerMenu?: (options: Record<string, unknown>) => string | false;
  unregisterMenu?: (menuID: string) => boolean;
}

interface LegacyRegistration {
  popup: Element;
  menuItem: XULElement;
  onPopupShowing: EventListener;
  onCommand: EventListener;
}

const MENU_ID = "zotero-ai-guided-reader-library-item";
const legacyRegistrations = new WeakMap<Window, LegacyRegistration>();
let registeredMenuID: string | false | undefined;

export function registerLibraryContextMenu(): void {
  if (registeredMenuID) return;
  const manager = getMenuManager();
  if (!manager?.registerMenu) {
    ztoolkit.log(
      "MenuManager.registerMenu unavailable; using window-level menu fallback",
    );
    return;
  }

  registeredMenuID = manager.registerMenu({
    menuID: MENU_ID,
    pluginID: addon.data.config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("library-menu-ai-guided-reading"),
        icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`,
        onShowing: (_event: Event, context: LibraryMenuContext) => {
          const state = readState(context.items);
          context.setVisible(state.visible);
          context.setEnabled(state.enabled);
        },
        onCommand: (_event: Event, context: LibraryMenuContext) => {
          const state = readState(context.items);
          if (state.enabled && state.item) void runMenuCommand(state.item);
        },
      },
    ],
  });

  if (!registeredMenuID) {
    ztoolkit.log("MenuManager.registerMenu rejected the AI guided reader menu");
  }
}

export function registerLegacyLibraryContextMenu(
  win: _ZoteroTypes.MainWindow,
): void {
  if (getMenuManager()?.registerMenu || legacyRegistrations.has(win)) return;

  const popup = win.document.getElementById("zotero-itemmenu");
  if (!popup) {
    ztoolkit.log("Legacy item context popup #zotero-itemmenu was not found");
    return;
  }

  const menuItem = win.document.createXULElement("menuitem");
  menuItem.id = `${MENU_ID}-legacy`;
  menuItem.classList.add("menuitem-iconic");
  menuItem.style.setProperty(
    "list-style-image",
    `url(chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png)`,
  );
  win.document.l10n.setAttributes(
    menuItem,
    getLocaleID("library-menu-ai-guided-reading"),
  );

  const getSelectedItems = () => win.ZoteroPane.getSelectedItems();
  const update = () => {
    const state = readState(getSelectedItems());
    menuItem.toggleAttribute("hidden", !state.visible);
    menuItem.toggleAttribute("disabled", !state.enabled);
  };
  const onPopupShowing: EventListener = (event) => {
    if (event.target === popup) update();
  };
  const onCommand: EventListener = () => {
    const state = readState(getSelectedItems());
    if (state.enabled && state.item) void runMenuCommand(state.item);
  };

  popup.addEventListener("popupshowing", onPopupShowing);
  menuItem.addEventListener("command", onCommand);
  popup.appendChild(menuItem);
  legacyRegistrations.set(win, {
    popup,
    menuItem,
    onPopupShowing,
    onCommand,
  });
}

export function unregisterLegacyLibraryContextMenu(win: Window): void {
  const registration = legacyRegistrations.get(win);
  if (!registration) return;
  registration.popup.removeEventListener(
    "popupshowing",
    registration.onPopupShowing,
  );
  registration.menuItem.removeEventListener("command", registration.onCommand);
  registration.menuItem.remove();
  legacyRegistrations.delete(win);
}

export function unregisterLibraryContextMenu(): void {
  const manager = getMenuManager();
  if (typeof registeredMenuID === "string") {
    manager?.unregisterMenu?.(registeredMenuID);
  }
  registeredMenuID = undefined;
  for (const win of Zotero.getMainWindows()) {
    unregisterLegacyLibraryContextMenu(win);
  }
}

function getMenuManager(): MenuManagerLike | undefined {
  return (Zotero as unknown as { MenuManager?: MenuManagerLike }).MenuManager;
}

function readState(items: Zotero.Item[] | undefined) {
  return getLibraryMenuState(items, (id) => Zotero.Items.get(id));
}

async function runMenuCommand(item: Zotero.Item): Promise<void> {
  try {
    const { paneFocused } = await openGuidedReaderForItem(item);
    if (!paneFocused) {
      showNotice(
        "PDF 已打开，但无法自动定位 AI 带读侧栏，请点击右侧 AI 带读图标",
        "default",
      );
    }
  } catch (error) {
    const diagnostic =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    ztoolkit.log("Open AI guided reader failed", diagnostic);
    const text = /No PDF attachment found/i.test(diagnostic)
      ? "该条目没有可用的 PDF 附件"
      : "无法打开 AI 带读：PDF 本地文件不可读或阅读器启动失败";
    showNotice(text, "fail");
  }
}

function showNotice(text: string, type: string): void {
  new ztoolkit.ProgressWindow("AI 带读").createLine({ text, type }).show(5000);
}
```

- [ ] **Step 3: 接入启动、窗口和关闭生命周期**

在 `src/hooks.ts` 中加入以下导入：

```ts
import {
  registerLegacyLibraryContextMenu,
  registerLibraryContextMenu,
  unregisterLegacyLibraryContextMenu,
  unregisterLibraryContextMenu,
} from "./runtime/libraryContextMenu";
```

`onStartup()` 按以下顺序接入：

```ts
initLocale();
registerPrefs();
registerReaderView();
registerLibraryContextMenu();
```

用以下函数替换对应生命周期实现：

```ts
async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
  registerLegacyLibraryContextMenu(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterLegacyLibraryContextMenu(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unregisterLibraryContextMenu();
  unregisterReaderView();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}
```

- [ ] **Step 4: 运行完整自动检查**

Run: `npm test`

Expected: 原有 12 个测试及新增 10 个测试全部 PASS。

Run: `npm run lint:check`

Expected: Prettier 与 ESLint 均退出码为 0。

Run: `npm run build`

Expected: XPI 构建完成且 TypeScript 退出码为 0。

- [ ] **Step 5: 提交菜单集成**

```powershell
git add addon/locale/en-US/mainWindow.ftl addon/locale/zh-CN/mainWindow.ftl typings/i10n.d.ts src/hooks.ts src/runtime/libraryContextMenu.ts
git commit -m "feat(menu): add AI guided reading context action"
```

### Task 5: 独立代码审查与修正

**Files:**

- Review: `src/core/librarySelection.ts`
- Review: `src/core/zoteroCompatibility.ts`
- Review: `src/runtime/readerView.tsx`
- Review: `src/runtime/openGuidedReader.ts`
- Review: `src/runtime/libraryContextMenu.ts`
- Review: `src/hooks.ts`
- Review: `test/librarySelection.test.ts`
- Review: `test/zoteroCompatibility.test.ts`
- Review: `test/openGuidedReader.test.ts`

- [ ] **Step 1: 向 Claude Code 提交收窄审查上下文**

只提供设计规格、上述文件 diff、Zotero 9.0.6 已确认的 `MenuManager.registerMenu` / `ItemPaneManager.registerSection` 行为、以及以下验收命令：

```powershell
npm test
npm run lint:check
npm run build
```

要求审查生命周期泄漏、异步竞态、Zotero 7 回退、React root 重复挂载、无 PDF 状态和密钥日志风险。

- [ ] **Step 2: 处理审查发现**

对范围内问题增加回归测试后修复。若审查没有阻塞项，不创建无关重构。

- [ ] **Step 3: 重新执行完整检查**

Run: `npm test`

Expected: 全部 PASS。

Run: `npm run lint:check`

Expected: 退出码为 0。

Run: `npm run build`

Expected: 退出码为 0，并生成 `.scaffold/build/zotero-ai-guided-reader.xpi`。

- [ ] **Step 4: 提交审查修正**

仅在存在实际修正时执行：

```powershell
git add src test addon/locale typings/i10n.d.ts
git commit -m "fix(reader): harden context menu activation"
```

### Task 6: Zotero 9.0.6 热重载与实机验收

**Files:**

- Verify: `.scaffold/build/zotero-ai-guided-reader.xpi`
- Inspect: `.scaffold/dev-server.stdout.log`
- Inspect: `.scaffold/dev-server.stderr.log`

- [ ] **Step 1: 确认开发服务与 Zotero 进程**

Run:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'zotero-plugin serve|zotero.exe' } |
  Select-Object ProcessId, Name, CommandLine
```

Expected: 有一个 `zotero-plugin serve` Node 进程和一个使用开发 profile 的 Zotero 进程；若服务不存在，运行 `npm start` 并等待热重载完成。

- [ ] **Step 2: 检查启动日志**

Run:

```powershell
Get-Content .scaffold/dev-server.stdout.log -Tail 120
Get-Content .scaffold/dev-server.stderr.log -Tail 120
```

Expected: 插件启动完成；没有 `registerSection is unavailable`、未捕获异常或明文 Key。

- [ ] **Step 3: 验证文库右键菜单**

在 Zotero 文库列表单选 `Book of Proof (Edition 3)` 并右击。确认菜单中出现可用的“AI 带读”；多选时不显示；无 PDF 普通条目上显示但禁用。

- [ ] **Step 4: 验证打开和侧栏聚焦**

点击“AI 带读”，确认：

1. 对应 PDF reader tab 打开或切换到前台。
2. 右侧上下文栏自动展开。
3. AI 带读 section 滚动到可见位置。
4. 页面仍处于 idle 状态，没有“排队中”或“解析中”状态。
5. MinerU 与 LLM 未出现新请求日志或缓存任务。

- [ ] **Step 5: 验证 PDF 附件行**

展开父条目后直接右击 PDF 附件，确认同一菜单和聚焦流程可用，且不会创建重复 reader tab。

- [ ] **Step 6: 最终构建证据**

Run:

```powershell
npm test
npm run lint:check
npm run build
Get-Item .scaffold/build/zotero-ai-guided-reader.xpi |
  Select-Object FullName, Length, LastWriteTime
```

Expected: 所有命令退出码为 0，XPI 路径、大小和最新修改时间可见。
