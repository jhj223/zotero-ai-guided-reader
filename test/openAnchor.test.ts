import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  highlightQuoteInReader,
  highlightRectInReader,
  openAnchor,
} from "../src/runtime/highlight";
import type { AnchorChunk } from "../src/core/types";

test("jumps to the anchor's page through Zotero.Reader, not a URL", async () => {
  const calls: Array<[number, { pageIndex: number }]> = [];
  await openAnchor(
    {
      attachment: { id: 9 } as Zotero.Item,
      anchor: { id: "chunk_0001", pageIndex: 4, pageNumber: 5 } as AnchorChunk,
    },
    {
      openReader: (itemID, location) => {
        calls.push([itemID, location]);
      },
      wantsHighlight: () => false,
    },
  );

  assert.deepEqual(calls, [[9, { pageIndex: 4 }]]);
});

test("uses the exact quote selection before any bbox fallback", async () => {
  const calls: Array<[string, unknown]> = [];
  const reader = { itemID: 9 };

  await openAnchor(
    {
      attachment: { id: 9 } as Zotero.Item,
      anchor: {
        id: "chunk_0002",
        pageIndex: 1,
        pageNumber: 2,
        bbox: [62, 100, 500, 120],
        bboxSpace: "page-points",
      } as AnchorChunk,
      pageSize: { width: 612, height: 792 },
      quote: "reacted at 180 C for three hours",
    },
    {
      openReader: (itemID, location) => {
        calls.push(["open", [itemID, location]]);
        return reader;
      },
      highlightQuote: async (
        openedReader,
        itemID,
        pageIndex,
        quote,
        expectedRect,
      ) => {
        calls.push([
          "exact",
          [openedReader, itemID, pageIndex, quote, expectedRect],
        ]);
        return true;
      },
      resolvePageSize: async () => {
        calls.push(["resolve", null]);
        return { width: 612, height: 792 };
      },
      navigateReader: () => {
        calls.push(["fallback", null]);
      },
      wantsHighlight: () => true,
    },
  );

  assert.deepEqual(calls, [
    ["open", [9, { pageIndex: 1 }]],
    [
      "exact",
      [reader, 9, 1, "reacted at 180 C for three hours", [62, 672, 500, 692]],
    ],
  ]);
});

test("falls back to the chunk bbox when the exact quote is not in the PDF", async () => {
  const calls: Array<[string, unknown]> = [];
  const reader = { itemID: 9 };

  await openAnchor(
    {
      attachment: { id: 9 } as Zotero.Item,
      anchor: {
        id: "chunk_0002",
        pageIndex: 0,
        pageNumber: 1,
        bbox: [62, 100, 500, 120],
        bboxSpace: "page-points",
      } as AnchorChunk,
      pageSize: { width: 612, height: 792 },
      quote: "quote absent from the PDF text layer",
    },
    {
      openReader: (itemID, location) => {
        calls.push(["open", [itemID, location]]);
        return reader;
      },
      highlightQuote: async () => false,
      navigateReader: (openedReader, itemID, location) => {
        calls.push(["fallback", [openedReader, itemID, location]]);
      },
      wantsHighlight: () => true,
    },
  );

  assert.deepEqual(calls, [
    ["open", [9, { pageIndex: 0 }]],
    [
      "fallback",
      [reader, 9, { position: { pageIndex: 0, rects: [[62, 672, 500, 692]] } }],
    ],
  ]);
});

test("uses the live page size to disambiguate exact quotes without cached dimensions", async () => {
  const calls: Array<[string, unknown]> = [];
  const reader = { itemID: 9 };

  await openAnchor(
    {
      attachment: { id: 9 } as Zotero.Item,
      anchor: {
        id: "chunk_0002",
        pageIndex: 0,
        pageNumber: 1,
        bbox: [100, 500, 900, 950],
      } as AnchorChunk,
      quote: "a repeated source quotation",
    },
    {
      openReader: () => reader,
      resolvePageSize: async () => {
        calls.push(["resolve", null]);
        return { width: 500, height: 1000 };
      },
      highlightQuote: async (_reader, _itemID, _pageIndex, _quote, rect) => {
        calls.push(["exact", rect]);
        return true;
      },
      wantsHighlight: () => true,
    },
  );

  assert.deepEqual(calls, [
    ["resolve", null],
    ["exact", [50, 50, 450, 500]],
  ]);
});

test("builds a persistent Reader selection from exact PDF characters", async () => {
  const calls: Array<[string, unknown]> = [];
  const phrase = "thoroughly dis-solved";
  const chars = [...phrase].map((c, index) => ({
    c,
    inlineRect: [index, 10, index + 1, 20],
    rect: [index, 10, index + 1, 20],
    lineBreakAfter: index === 14,
  }));
  const view = {
    _iframeWindow: {},
    _pdfPages: [{ chars }],
    _selectionRanges: [],
    _render() {
      calls.push(["render", this._selectionRanges]);
    },
    navigateToPosition(position: unknown, options: unknown) {
      calls.push(["navigate", [position, options]]);
    },
  };
  const reader = {
    itemID: 9,
    _internalReader: { _lastView: view },
  };
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousComponents = (globalThis as { Components?: unknown })
    .Components;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Promise: { delay: async () => {} },
    Reader: { _readers: [reader] },
  };
  (globalThis as { Components?: unknown }).Components = {
    utils: { cloneInto: (value: unknown) => value },
  };

  try {
    assert.equal(
      await highlightQuoteInReader(reader, 9, 0, "thoroughly dissolved"),
      true,
    );
  } finally {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    (globalThis as { Components?: unknown }).Components = previousComponents;
  }

  assert.equal(view._selectionRanges.length, 1);
  assert.deepEqual(view._selectionRanges[0].position, {
    pageIndex: 0,
    rects: [
      [0, 10, 15, 20],
      [15, 10, 21, 20],
    ],
  });
  assert.equal(calls[0][0], "render");
  assert.equal(calls[1][0], "navigate");
});

test("uses a high-confidence OCR match within the MinerU block", async () => {
  const phrase = "the catalyst concentration was 0.30 wt percent";
  const chars = [...phrase].map((c, index) => ({
    c,
    inlineRect: [index, 10, index + 1, 20],
    rect: [index, 10, index + 1, 20],
  }));
  const view = {
    _iframeWindow: {},
    _pdfPages: [{ chars }],
    _selectionRanges: [] as Array<{ anchorOffset: number; headOffset: number }>,
    _render() {},
    navigateToPosition() {},
  };
  const reader = { itemID: 9, _internalReader: { _lastView: view } };
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousComponents = (globalThis as { Components?: unknown })
    .Components;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Promise: { delay: async () => {} },
    Reader: { _readers: [reader] },
  };
  (globalThis as { Components?: unknown }).Components = {
    utils: { cloneInto: (value: unknown) => value },
  };

  try {
    assert.equal(
      await highlightQuoteInReader(
        reader,
        9,
        0,
        "the catalyst concentratlon was 0.30 wt percent",
        [-2, 8, 50, 22],
      ),
      true,
    );
  } finally {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    (globalThis as { Components?: unknown }).Components = previousComponents;
  }

  assert.equal(view._selectionRanges[0].anchorOffset, 0);
  assert.equal(view._selectionRanges[0].headOffset, chars.length);
});

test("uses optional semantic ranking after lexical matching fails", async () => {
  const phrase =
    "样品制备完成。材料在180摄氏度下保持稳定。作者未讨论循环性能。";
  const chars = [...phrase].map((c, index) => ({
    c,
    inlineRect: [index, 10, index + 1, 20],
    rect: [index, 10, index + 1, 20],
  }));
  const view = {
    _iframeWindow: {},
    _pdfPages: [{ chars }],
    _selectionRanges: [] as Array<{ anchorOffset: number; headOffset: number }>,
    _render() {},
    navigateToPosition() {},
  };
  const reader = { itemID: 9, _internalReader: { _lastView: view } };
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousComponents = (globalThis as { Components?: unknown })
    .Components;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Promise: { delay: async () => {} },
    Reader: { _readers: [reader] },
  };
  (globalThis as { Components?: unknown }).Components = {
    utils: { cloneInto: (value: unknown) => value },
  };

  try {
    assert.equal(
      await highlightQuoteInReader(
        reader,
        9,
        0,
        "完全不同的措辞",
        [0, 8, phrase.length, 22],
        "该材料具有良好的高温稳定性",
        async (_query, documents) =>
          documents.map((document) =>
            document.includes("180摄氏度") ? 0.9 : 0.2,
          ),
      ),
      true,
    );
  } finally {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    (globalThis as { Components?: unknown }).Components = previousComponents;
  }

  const selected = phrase.slice(
    view._selectionRanges[0].anchorOffset,
    view._selectionRanges[0].headOffset,
  );
  assert.match(selected, /180摄氏度下保持稳定/);
});

test("does not log semantic provider response text", async () => {
  const phrase = "样品在高温条件下保持稳定。";
  const chars = [...phrase].map((c, index) => ({
    c,
    inlineRect: [index, 10, index + 1, 20],
    rect: [index, 10, index + 1, 20],
  }));
  const reader = {
    itemID: 9,
    _internalReader: {
      _lastView: {
        _iframeWindow: {},
        _pdfPages: [{ chars }],
        _selectionRanges: [],
        _render() {},
        navigateToPosition() {},
      },
    },
  };
  const logged: unknown[] = [];
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Promise: { delay: async () => {} },
    Reader: { _readers: [reader] },
  };
  (globalThis as { ztoolkit?: unknown }).ztoolkit = {
    log: (...args: unknown[]) => logged.push(args),
  };

  try {
    assert.equal(
      await highlightQuoteInReader(
        reader,
        9,
        0,
        "完全不同的措辞",
        [0, 8, phrase.length, 22],
        "该材料耐高温",
        async () => {
          throw new Error("provider echoed private paper fragment");
        },
      ),
      false,
    );
  } finally {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = previousZtoolkit;
  }

  assert.equal(logged.length, 1);
  assert.doesNotMatch(JSON.stringify(logged), /private paper fragment/);
  assert.match(JSON.stringify(logged), /SemanticProviderError/);
});

test("keeps bbox fallback as a region instead of selecting a whole paragraph", async () => {
  const chars = [..."selected block"].map((c, index) => ({
    c,
    inlineRect: [index, 10, index + 1, 20],
    rect: [index, 10, index + 1, 20],
  }));
  const calls: string[] = [];
  const view = {
    _iframeWindow: {},
    _pdfPages: [{ chars }],
    _selectionRanges: [] as unknown[],
    _highlightedPosition: { stale: true } as unknown,
    _render() {
      calls.push("render");
    },
    navigateToPosition() {
      calls.push("navigate");
    },
  };
  const reader = { itemID: 9, _internalReader: { _lastView: view } };
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousComponents = (globalThis as { Components?: unknown })
    .Components;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Promise: { delay: async () => {} },
    Reader: { _readers: [reader] },
  };
  (globalThis as { Components?: unknown }).Components = {
    utils: { cloneInto: (value: unknown) => value },
  };

  try {
    assert.equal(
      await highlightRectInReader(reader, 9, 0, [0, 8, 14, 22]),
      true,
    );
  } finally {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    (globalThis as { Components?: unknown }).Components = previousComponents;
  }

  assert.deepEqual(view._selectionRanges, []);
  assert.deepEqual(view._highlightedPosition, {
    pageIndex: 0,
    rects: [[0, 8, 14, 22]],
  });
  assert.deepEqual(calls, ["render", "navigate"]);
});

test("keeps a persistent region highlight when the page has no text layer", async () => {
  const view = {
    _iframeWindow: {},
    _pdfPages: [{ chars: [] }],
    _selectionRanges: [{ stale: true }] as unknown[],
    _highlightedPosition: undefined as unknown,
    _render() {},
    navigateToPosition() {},
  };
  const reader = { itemID: 9, _internalReader: { _lastView: view } };
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousComponents = (globalThis as { Components?: unknown })
    .Components;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Promise: { delay: async () => {} },
    Reader: { _readers: [reader] },
  };
  (globalThis as { Components?: unknown }).Components = {
    utils: { cloneInto: (value: unknown) => value },
  };

  try {
    assert.equal(
      await highlightRectInReader(reader, 9, 0, [10, 20, 50, 60]),
      true,
    );
  } finally {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    (globalThis as { Components?: unknown }).Components = previousComponents;
  }

  assert.deepEqual(view._selectionRanges, []);
  assert.deepEqual(view._highlightedPosition, {
    pageIndex: 0,
    rects: [[10, 20, 50, 60]],
  });
});

test("selects the repeated quote nearest to the MinerU anchor rect", async () => {
  const phrase = "alpha beta filler alpha beta";
  const chars = [...phrase].map((c, index) => {
    const secondOccurrence = index >= 18;
    const x = secondOccurrence ? 100 + index : index;
    return {
      c,
      inlineRect: [x, 10, x + 1, 20],
      rect: [x, 10, x + 1, 20],
    };
  });
  const view = {
    _iframeWindow: {},
    _pdfPages: [{ chars }],
    _selectionRanges: [] as Array<{ anchorOffset: number }>,
    _render() {},
    navigateToPosition() {},
  };
  const reader = { itemID: 9, _internalReader: { _lastView: view } };
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousComponents = (globalThis as { Components?: unknown })
    .Components;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Promise: { delay: async () => {} },
    Reader: { _readers: [reader] },
  };
  (globalThis as { Components?: unknown }).Components = {
    utils: { cloneInto: (value: unknown) => value },
  };

  try {
    assert.equal(
      await highlightQuoteInReader(
        reader,
        9,
        0,
        "alpha beta",
        [115, 8, 130, 22],
      ),
      true,
    );
  } finally {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    (globalThis as { Components?: unknown }).Components = previousComponents;
  }

  assert.equal(view._selectionRanges[0].anchorOffset, 18);
});

test("uses a persistent rect highlight before the navigation fallback", async () => {
  const calls: Array<[string, unknown]> = [];
  const reader = { itemID: 9 };
  await openAnchor(
    {
      attachment: { id: 9 } as Zotero.Item,
      anchor: {
        id: "chunk_0002",
        pageIndex: 0,
        pageNumber: 1,
        bbox: [62, 100, 500, 120],
        bboxSpace: "page-points",
      } as AnchorChunk,
      pageSize: { width: 612, height: 792 },
    },
    {
      openReader: (itemID, location) => {
        calls.push(["open", [itemID, location]]);
        return reader;
      },
      highlightRect: async (openedReader, itemID, pageIndex, rect) => {
        calls.push(["rect", [openedReader, itemID, pageIndex, rect]]);
        return true;
      },
      navigateReader: () => {
        calls.push(["fallback", null]);
      },
      wantsHighlight: () => true,
    },
  );

  assert.deepEqual(calls, [
    ["open", [9, { pageIndex: 0 }]],
    ["rect", [reader, 9, 0, [62, 672, 500, 692]]],
  ]);
});

test("recovers a missing cached page size from the open reader", async () => {
  const calls: Array<[string, unknown]> = [];
  const reader = { itemID: 9 };

  await openAnchor(
    {
      attachment: { id: 9 } as Zotero.Item,
      anchor: {
        id: "chunk_0002",
        pageIndex: 0,
        pageNumber: 1,
        bbox: [100, 500, 900, 950],
      } as AnchorChunk,
    },
    {
      openReader: (itemID, location) => {
        calls.push(["open", [itemID, location]]);
        return reader;
      },
      resolvePageSize: async (itemID, pageIndex, openedReader) => {
        calls.push(["resolve", [itemID, pageIndex, openedReader]]);
        return { width: 500, height: 1000 };
      },
      navigateReader: (openedReader, itemID, location) => {
        calls.push(["navigate", [openedReader, itemID, location]]);
      },
      wantsHighlight: () => true,
    },
  );

  assert.deepEqual(calls, [
    ["open", [9, { pageIndex: 0 }]],
    ["resolve", [9, 0, reader]],
    [
      "navigate",
      [reader, 9, { position: { pageIndex: 0, rects: [[50, 50, 450, 500]] } }],
    ],
  ]);
});

test("reads the PDF page box from the Zotero reader at runtime", async () => {
  const calls: Array<[string, unknown]> = [];
  const reader = {
    itemID: 9,
    navigate(location: unknown) {
      calls.push(["navigate", location]);
    },
    _internalReader: {
      _lastView: {
        _iframeWindow: {
          PDFViewerApplication: {
            pdfDocument: {
              getPage: async (pageNumber: number) => {
                calls.push(["getPage", pageNumber]);
                return { view: [0, 0, 600, 800] };
              },
            },
          },
        },
      },
    },
  };
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Reader: {
      _readers: [reader],
      open: (itemID: number, location: unknown) => {
        calls.push(["open", [itemID, location]]);
        return reader;
      },
    },
    Promise: { delay: async () => {} },
  };

  try {
    await openAnchor(
      {
        attachment: { id: 9 } as Zotero.Item,
        anchor: {
          id: "chunk_0002",
          pageIndex: 0,
          pageNumber: 1,
          bbox: [50, 100, 400, 200],
        } as AnchorChunk,
      },
      { wantsHighlight: () => true },
    );
  } finally {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
  }

  assert.deepEqual(calls, [
    ["open", [9, { pageIndex: 0 }]],
    ["getPage", 1],
    ["navigate", { position: { pageIndex: 0, rects: [[30, 640, 240, 720]] } }],
  ]);
});

test("keeps the page jump when the reader page size is unavailable", async () => {
  const calls: Array<[string, unknown]> = [];

  await openAnchor(
    {
      attachment: { id: 9 } as Zotero.Item,
      anchor: {
        id: "chunk_0002",
        pageIndex: 0,
        pageNumber: 1,
        bbox: [100, 500, 900, 950],
      } as AnchorChunk,
    },
    {
      openReader: (itemID, location) => {
        calls.push(["open", [itemID, location]]);
      },
      resolvePageSize: async () => undefined,
      navigateReader: () => {
        calls.push(["navigate", null]);
      },
      wantsHighlight: () => true,
    },
  );

  assert.deepEqual(calls, [["open", [9, { pageIndex: 0 }]]]);
});

test("falls back to a page jump when highlighting is disabled", async () => {
  const calls: Array<[number, unknown]> = [];
  await openAnchor(
    {
      attachment: { id: 9 } as Zotero.Item,
      anchor: {
        id: "chunk_0002",
        pageIndex: 0,
        pageNumber: 1,
        bbox: [62, 100, 500, 120],
      } as AnchorChunk,
      pageSize: { width: 612, height: 792 },
    },
    {
      openReader: (itemID, location) => {
        calls.push([itemID, location]);
      },
      wantsHighlight: () => false,
    },
  );

  assert.deepEqual(calls, [[9, { pageIndex: 0 }]]);
});

test("anchor jumps never launch external zotero:// URLs", async () => {
  const source = await readFile(
    new URL("../src/runtime/highlight.ts", import.meta.url),
    "utf8",
  );

  // Zotero.launchURL hands the link to the OS protocol handler, which makes
  // Firefox ask "Allow this site to open the zotero link with Zotero?"
  // instead of just turning the page.
  assert.doesNotMatch(source, /launchURL/);
  assert.match(source, /Zotero\.Reader\.open/);
});
