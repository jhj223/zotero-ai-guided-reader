import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { hasReaderSectionApi } from "../core/zoteroCompatibility";
import { GuidedReaderApp } from "../ui/GuidedReaderApp";
import { getLocaleID } from "../utils/locale";

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
}

const roots = new WeakMap<Element, Root>();
const PANE_LOCAL_ID = "guided-reader";
let registeredPaneID: string | false | undefined;

export function registerReaderView(): void {
  if (registeredPaneID) return;

  const manager = Zotero.ItemPaneManager as unknown as ReaderPaneManager;
  if (!hasReaderSectionApi(manager) || !manager.registerSection) {
    ztoolkit.log(
      "ItemPaneManager.registerSection is unavailable; guided reader pane disabled",
    );
    return;
  }

  registeredPaneID = manager.registerSection({
    paneID: PANE_LOCAL_ID,
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("reader-view-head"),
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    sidenav: {
      l10nID: getLocaleID("reader-view-sidenav"),
      icon: "chrome://zotero/skin/20/universal/book.svg",
    },
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
  if (!registeredPaneID) {
    ztoolkit.log("ItemPaneManager.registerSection rejected guided-reader");
  }
}

export function unregisterReaderView(): void {
  const manager = Zotero.ItemPaneManager as unknown as ReaderPaneManager;
  if (typeof registeredPaneID === "string") {
    manager.unregisterSection?.(registeredPaneID);
  }
  registeredPaneID = undefined;
}

export function getRegisteredReaderPaneID(): string | undefined {
  return typeof registeredPaneID === "string" ? registeredPaneID : undefined;
}

function mount(target: HTMLElement, item?: Zotero.Item): void {
  const doc = target.ownerDocument;
  if (!doc) {
    throw new Error("Reader view target has no ownerDocument.");
  }
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
