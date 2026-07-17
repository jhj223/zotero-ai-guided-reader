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

const MENU_ID = "zotero-ai-guided-reader-library-item";
let registeredMenuID: string | false | undefined;

export function registerLibraryContextMenu(): void {
  if (registeredMenuID) return;
  const manager = getMenuManager();
  if (!manager?.registerMenu) {
    ztoolkit.log(
      "MenuManager.registerMenu is unavailable; AI guided reading menu disabled",
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

export function unregisterLibraryContextMenu(): void {
  if (typeof registeredMenuID === "string") {
    getMenuManager()?.unregisterMenu?.(registeredMenuID);
  }
  registeredMenuID = undefined;
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
