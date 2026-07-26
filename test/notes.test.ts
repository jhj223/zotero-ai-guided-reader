import assert from "node:assert/strict";
import test from "node:test";
import { saveGuideAsNote } from "../src/runtime/notes";
import type { AnchorChunk } from "../src/core/types";

test("renders type-aware text and visual links in a Zotero Note", async () => {
  const runtime = globalThis as unknown as Record<string, unknown>;
  const previousZotero = runtime.Zotero;
  let savedHtml = "";

  class FakeNote {
    id = 101;
    libraryID = 0;
    parentID = 0;

    setNote(value: string) {
      savedHtml = value;
    }

    async saveTx() {
      return this.id;
    }
  }

  runtime.Zotero = {
    Item: FakeNote,
    Libraries: {
      get() {
        return { libraryType: "user" };
      },
    },
  };

  const anchors: AnchorChunk[] = [
    {
      id: "text_1",
      type: "text",
      pageIndex: 0,
      pageNumber: 1,
      text: "Methods",
      sectionPath: [],
    },
    {
      id: "figure_1",
      type: "image",
      pageIndex: 4,
      pageNumber: 5,
      text: "Figure 2. Viscosity response",
      sectionPath: [],
      richContent: { caption: "Figure 2. Viscosity response" },
    },
  ];

  try {
    await saveGuideAsNote({
      attachment: {
        key: "ATTACH1",
        libraryID: 1,
      } as Zotero.Item,
      parentItem: { id: 20, libraryID: 1 } as Zotero.Item,
      title: "Paper",
      markdown: "方法 [[ANCHOR:text_1]]\n\n图表结论 [[ANCHOR:figure_1]]",
      anchors,
    });
  } finally {
    runtime.Zotero = previousZotero;
  }

  assert.match(savedHtml, />p\.1<\/a>/);
  assert.match(savedHtml, />图 2 · p\.5<\/a>/);
  assert.match(
    savedHtml,
    /zotero:\/\/open-pdf\/library\/items\/ATTACH1\?page=5/,
  );
});
