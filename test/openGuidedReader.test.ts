import assert from "node:assert/strict";
import test from "node:test";
import {
  focusGuidedReaderPane,
  openGuidedReaderForItem,
  PIN_RESTORE_DELAY_MS,
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

  assert.deepEqual(calls, ["resolve", "open:42", "focus:plugin-guided-reader"]);
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

test("holds the pin through the grace period, then restores it", async () => {
  const container = {
    tabType: "reader",
    collapsed: false,
    pinnedPane: "",
    getEnabledPane: () => ({}),
    scrollToPane: async () => {},
  };
  const pinDuringGrace: string[] = [];

  const focused = await focusGuidedReaderPane(
    {
      ZoteroContextPane: {
        collapsed: true,
        context: { mode: "notes" },
        sidenav: { container },
      },
    },
    "plugin-guided-reader",
    {
      attempts: 1,
      delay: async (ms) => {
        if (ms === PIN_RESTORE_DELAY_MS)
          pinDuringGrace.push(container.pinnedPane);
      },
    },
  );

  assert.equal(focused, true);
  assert.deepEqual(pinDuringGrace, ["plugin-guided-reader"]);
  assert.equal(container.pinnedPane, "");
});

test("restores the user's previously pinned pane", async () => {
  const container = {
    tabType: "reader",
    collapsed: false,
    pinnedPane: "attachments",
    getEnabledPane: () => ({}),
    scrollToPane: async () => {},
  };

  const focused = await focusGuidedReaderPane(
    {
      ZoteroContextPane: {
        collapsed: true,
        context: { mode: "notes" },
        sidenav: { container },
      },
    },
    "plugin-guided-reader",
    { attempts: 1, delay: async () => {} },
  );

  assert.equal(focused, true);
  assert.equal(container.pinnedPane, "attachments");
});

test("keeps a pin the user changed during the grace period", async () => {
  const container = {
    tabType: "reader",
    collapsed: false,
    pinnedPane: "",
    getEnabledPane: () => ({}),
    scrollToPane: async () => {},
  };

  const focused = await focusGuidedReaderPane(
    {
      ZoteroContextPane: {
        collapsed: true,
        context: { mode: "notes" },
        sidenav: { container },
      },
    },
    "plugin-guided-reader",
    {
      attempts: 1,
      delay: async (ms) => {
        if (ms === PIN_RESTORE_DELAY_MS) container.pinnedPane = "notes";
      },
    },
  );

  assert.equal(focused, true);
  assert.equal(container.pinnedPane, "notes");
});

test("expands a collapsed item-details before scrolling", async () => {
  const calls: string[] = [];
  const container = {
    tabType: "reader",
    collapsed: true,
    pinnedPane: "",
    getEnabledPane: () => ({}),
    scrollToPane: async (id: string) => {
      // Zotero's item-details returns early from scrollToPane while collapsed.
      if (container.collapsed) return;
      calls.push(`scroll:${id}`);
    },
  };

  const focused = await focusGuidedReaderPane(
    {
      ZoteroContextPane: {
        collapsed: true,
        context: { mode: "notes" },
        sidenav: { container },
      },
    },
    "plugin-guided-reader",
    { attempts: 1, delay: async () => {} },
  );

  assert.equal(focused, true);
  assert.equal(container.collapsed, false);
  assert.deepEqual(calls, ["scroll:plugin-guided-reader"]);
});

test("keeps the target pane across a cold-start re-render in the grace period", async () => {
  const container = {
    tabType: "reader",
    collapsed: false,
    pinnedPane: "",
    currentPane: "",
    getEnabledPane: () => ({}),
    scrollToPane(id: string) {
      container.currentPane = id;
    },
    // Reproduces Zotero's async cold-start render: the transient scroll target
    // is discarded, then whichever pane is pinned gets re-applied.
    render() {
      container.currentPane = container.pinnedPane;
    },
  };

  const focused = await focusGuidedReaderPane(
    {
      ZoteroContextPane: {
        collapsed: true,
        context: { mode: "notes" },
        sidenav: { container },
      },
    },
    "plugin-guided-reader",
    {
      attempts: 1,
      delay: async (ms) => {
        if (ms === PIN_RESTORE_DELAY_MS) container.render();
      },
    },
  );

  assert.equal(focused, true);
  assert.equal(container.currentPane, "plugin-guided-reader");
  assert.equal(container.pinnedPane, "");
});
