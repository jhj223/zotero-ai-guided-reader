import assert from "node:assert/strict";
import test from "node:test";
import {
  focusGuidedReaderPane,
  openGuidedReaderForItem,
} from "../src/runtime/openGuidedReader";

test("opens the resolved PDF before focusing the registered pane", async () => {
  const calls: string[] = [];
  const attachment = { id: 42 } as Zotero.Item;
  const contextPane = {
    collapsed: true,
    context: { mode: "notes" },
    sidenav: {
      container: {
        tabType: "reader",
        getEnabledPane: () => ({}),
        scrollToPane: async (id: string) => calls.push(`focus:${id}`),
      },
    },
  };

  const result = await openGuidedReaderForItem({ id: 7 } as Zotero.Item, {
    resolvePdf: async () => {
      calls.push("resolve");
      return attachment;
    },
    openReader: async (id) => {
      calls.push(`open:${id}`);
    },
    getPaneID: () => "plugin-guided-reader",
    getMainWindow: () => ({ ZoteroContextPane: contextPane }),
    delay: async () => {},
    attempts: 1,
  });

  assert.deepEqual(calls, [
    "resolve",
    "open:42",
    "focus:plugin-guided-reader",
  ]);
  assert.equal(contextPane.collapsed, false);
  assert.equal(contextPane.context.mode, "item");
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
