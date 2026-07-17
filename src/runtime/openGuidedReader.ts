import { getRegisteredReaderPaneID } from "./readerView";
import { resolvePdfAttachment } from "./zoteroItems";

interface PaneContainer {
  tabType?: string;
  collapsed?: boolean;
  pinnedPane?: string;
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
  getMainWindow: () =>
    Zotero.getMainWindow() as unknown as GuidedReaderWindow | undefined,
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

export const PIN_RESTORE_DELAY_MS = 1000;

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
      // Zotero 9 cold-starts the reader item-details asynchronously, and a
      // later render discards a plain scrollToPane target. Pin the pane so
      // renders inside the grace window re-apply it, expand item-details (a
      // collapsed container makes scrollToPane return early), then scroll.
      const previousPin = container.pinnedPane ?? "";
      container.pinnedPane = paneID;
      if (container.collapsed) container.collapsed = false;
      await container.scrollToPane(paneID, "instant");

      // Hand the pin back after the cold-start window so the menu action
      // leaves no lasting side effect, unless the user re-pinned meanwhile.
      await options.delay(PIN_RESTORE_DELAY_MS);
      const current = contextPane.sidenav?.container;
      if (current && current.pinnedPane === paneID) {
        current.pinnedPane = previousPin;
      }
      return true;
    }
    await options.delay(50);
  }
  return false;
}
