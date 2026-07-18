import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { openAnchor } from "../src/runtime/highlight";
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

test("passes a flash-highlight position when a bbox and page size exist", async () => {
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
      wantsHighlight: () => true,
    },
  );

  assert.deepEqual(calls, [
    [9, { position: { pageIndex: 0, rects: [[62, 672, 500, 692]] } }],
  ]);
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
