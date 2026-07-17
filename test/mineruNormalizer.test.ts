import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMinerUOutput,
  validateMinerUInputLimits,
} from "../src/core/mineruNormalizer";

test("normalizeMinerUOutput maps flat content_list blocks into anchored chunks", () => {
  const normalized = normalizeMinerUOutput({
    contentList: [
      {
        type: "text",
        text: "1 Introduction",
        text_level: 1,
        bbox: [62, 100, 946, 120],
        page_idx: 0,
      },
      {
        type: "text",
        text: "This paper studies anchored reading.",
        bbox: [62, 130, 946, 190],
        page_idx: 0,
      },
      {
        type: "page_number",
        text: "1",
        bbox: [490, 980, 510, 995],
        page_idx: 0,
      },
    ],
  });

  assert.equal(normalized.anchors.length, 2);
  assert.deepEqual(normalized.anchors[0], {
    id: "chunk_0001",
    type: "heading",
    pageIndex: 0,
    pageNumber: 1,
    bbox: [62, 100, 946, 120],
    text: "1 Introduction",
    sectionPath: ["1 Introduction"],
  });
  assert.deepEqual(normalized.anchors[1].sectionPath, ["1 Introduction"]);
});

test("normalizeMinerUOutput maps content_list_v2 page arrays into anchored chunks", () => {
  const normalized = normalizeMinerUOutput({
    contentListV2: [
      [
        {
          type: "title",
          content: {
            title_content: [{ type: "text", content: "Abstract" }],
            level: 1,
          },
          bbox: [83, 121, 917, 156],
        },
        {
          type: "paragraph",
          content: {
            paragraph_content: [
              { type: "text", content: "We propose a plugin. " },
              { type: "inline_equation", content: "$x^2$" },
            ],
          },
          bbox: [83, 170, 917, 260],
        },
      ],
    ],
  });

  assert.equal(normalized.anchors.length, 2);
  assert.equal(normalized.anchors[1].text, "We propose a plugin. $x^2$");
  assert.equal(normalized.anchors[1].pageNumber, 1);
});

test("normalizeMinerUOutput falls back to middle.json paragraph blocks", () => {
  const normalized = normalizeMinerUOutput({
    middleJson: {
      pdf_info: [
        {
          page_idx: 1,
          para_blocks: [
            {
              type: "text",
              bbox: [52, 61, 294, 82],
              lines: [
                {
                  spans: [
                    { type: "text", content: "The main theorem " },
                    { type: "inline_equation", content: "$a=b$" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });

  assert.equal(normalized.anchors[0].id, "chunk_0001");
  assert.equal(normalized.anchors[0].pageIndex, 1);
  assert.equal(normalized.anchors[0].pageNumber, 2);
  assert.equal(normalized.anchors[0].text, "The main theorem $a=b$");
});

test("validateMinerUInputLimits reports documented size and page limits", () => {
  assert.deepEqual(
    validateMinerUInputLimits({
      sizeBytes: 201 * 1024 * 1024,
      pageCount: 201,
    }),
    [
      "MinerU precise parsing supports a single file up to 200MB.",
      "MinerU precise parsing supports documents up to 200 pages.",
    ],
  );
});
