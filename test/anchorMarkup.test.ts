import test from "node:test";
import assert from "node:assert/strict";
import {
  buildZoteroOpenPdfLink,
  parseAnchorPlaceholders,
} from "../src/core/anchorMarkup";

test("parseAnchorPlaceholders splits text and anchor placeholders", () => {
  const segments = parseAnchorPlaceholders(
    "先看方法 [[ANCHOR:chunk_0001]]，再看结论 [[ANCHOR:chunk_0042]].",
  );

  assert.deepEqual(segments, [
    { type: "text", text: "先看方法 " },
    { type: "anchor", anchorId: "chunk_0001" },
    { type: "text", text: "，再看结论 " },
    { type: "anchor", anchorId: "chunk_0042" },
    { type: "text", text: "." },
  ]);
});

test("buildZoteroOpenPdfLink converts MinerU 0-based page indexes to Zotero page numbers", () => {
  assert.equal(
    buildZoteroOpenPdfLink({
      attachmentKey: "9EAWYJY8",
      pageIndex: 0,
      libraryType: "library",
    }),
    "zotero://open-pdf/library/items/9EAWYJY8?page=1",
  );

  assert.equal(
    buildZoteroOpenPdfLink({
      attachmentKey: "9EAWYJY8",
      pageIndex: 2,
      libraryType: "group",
      groupID: 123456,
    }),
    "zotero://open-pdf/groups/123456/items/9EAWYJY8?page=3",
  );
});
