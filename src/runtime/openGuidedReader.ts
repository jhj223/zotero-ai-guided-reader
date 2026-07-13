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
