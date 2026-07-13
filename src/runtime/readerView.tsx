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
