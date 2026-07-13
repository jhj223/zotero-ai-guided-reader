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

  const menuItem = win.document.createXULElement("menuitem") as XULElement;
  menuItem.id = `${MENU_ID}-legacy`;
  menuItem.classList.add("menuitem-iconic");
  menuItem.style.setProperty(
    "list-style-image",
    `url(chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png)`,
  );
  menuItem.setAttribute(
    "data-l10n-id",
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
