import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  // The bootstrap sandbox lacks browser globals; react-dom reads the bare
  // `window` global during render, so expose them like the plugin template.
  defineGlobal("window");
  defineGlobal("document");
  defineGlobal("AbortController");
  defineGlobal("AbortSignal");
  // JSZip's async workers call the bare `setImmediate` global (a Node/IE
  // API); without it, unpacking the MinerU result ZIP throws.
  if (typeof _globalThis.setImmediate !== "function") {
    _globalThis.setImmediate = (
      callback: (...args: unknown[]) => void,
      ...args: unknown[]
    ) => basicTool.getGlobal("window").setTimeout(callback, 0, ...args);
  }
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
