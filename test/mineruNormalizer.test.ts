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
    bboxSpace: "normalized-1000",
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

test("normalizeMinerUOutput keeps per-page sizes from middle.json", () => {
  const normalized = normalizeMinerUOutput({
    contentListV2: [
      [
        {
          type: "paragraph",
          content: { paragraph_content: "Hello" },
          bbox: [1, 2, 3, 4],
        },
      ],
    ],
    middleJson: {
      pdf_info: [
        { page_idx: 0, page_size: [612, 792], para_blocks: [] },
        { page_idx: 1, page_size: [612, 792.5], para_blocks: [] },
      ],
    },
  });

  assert.deepEqual(normalized.pageSizes, {
    0: { width: 612, height: 792 },
    1: { width: 612, height: 792.5 },
  });
});

test("normalizeMinerUOutput omits pageSizes without middle.json", () => {
  const normalized = normalizeMinerUOutput({
    contentList: [{ type: "text", text: "Hi", page_idx: 0 }],
  });
  assert.equal(normalized.pageSizes, undefined);
});

test("preserves MinerU formula, table, image, and bbox coordinate metadata", () => {
  const normalized = normalizeMinerUOutput({
    contentList: [
      {
        type: "equation",
        text: "$$E=mc^2$$",
        text_format: "latex",
        bbox: [50, 100, 400, 200],
        page_idx: 0,
      },
      {
        type: "table",
        table_caption: ["Table 1"],
        table_body: "<table><tr><td>A</td><td>1</td></tr></table>",
        img_path: "images/table.jpg",
        bbox: [80, 250, 900, 500],
        page_idx: 0,
      },
      {
        type: "image",
        image_caption: ["Figure 1"],
        image_description: ["A monotonic response curve."],
        img_path: "images/figure.jpg",
        bbox: [80, 520, 900, 900],
        page_idx: 0,
      },
    ],
    assetMap: {
      "images/table.jpg": "table.jpg",
      "images/figure.jpg": "figure.jpg",
    },
  });

  assert.deepEqual(normalized.anchors[0].richContent, {
    latex: "E=mc^2",
  });
  assert.equal(normalized.anchors[0].bboxSpace, "normalized-1000");
  assert.equal(
    normalized.anchors[1].richContent?.tableHtml,
    "<table><tr><td>A</td><td>1</td></tr></table>",
  );
  assert.equal(normalized.anchors[1].richContent?.assetName, "table.jpg");
  assert.equal(normalized.anchors[2].richContent?.assetName, "figure.jpg");
  assert.match(normalized.anchors[2].text, /monotonic response curve/);
});

test("restores a missing table body from MinerU full markdown", () => {
  const normalized = normalizeMinerUOutput({
    contentList: [
      {
        type: "table",
        table_caption: [
          "表 3 缓蚀剂的缓蚀性能评价结果",
          "Table 3 Evaluation results",
        ],
        bbox: [515, 135, 905, 250],
        page_idx: 4,
      },
    ],
    markdown: [
      "表 3 缓蚀剂的缓蚀性能评价结果",
      "Table 3 Evaluation results",
      "",
      "<table><tr><td>体系</td><td>温度/°C</td><td>腐蚀速率</td></tr>",
      "<tr><td>缓蚀剂1</td><td>180</td><td>39.494</td></tr></table>",
    ].join("\n"),
  });

  assert.match(
    normalized.anchors[0].richContent?.tableHtml || "",
    /缓蚀剂1[\s\S]*39\.494/,
  );
});

test("marks middle-json bboxes as PDF page points", () => {
  const normalized = normalizeMinerUOutput({
    middleJson: {
      pdf_info: [
        {
          page_idx: 0,
          page_size: [612, 792],
          para_blocks: [
            {
              type: "text",
              bbox: [52, 61, 294, 82],
              lines: [{ spans: [{ type: "text", content: "hello" }] }],
            },
          ],
        },
      ],
    },
  });

  assert.equal(normalized.anchors[0].bboxSpace, "page-points");
});

test("keeps image assets even when MinerU returns no caption text", () => {
  const normalized = normalizeMinerUOutput({
    contentList: [
      {
        type: "image",
        img_path: "images/uncaptioned.png",
        bbox: [100, 200, 800, 700],
        page_idx: 2,
      },
    ],
    assetMap: { "images/uncaptioned.png": "uncaptioned.png" },
  });

  assert.equal(normalized.anchors.length, 1);
  assert.equal(normalized.anchors[0].type, "image");
  assert.equal(normalized.anchors[0].richContent?.assetName, "uncaptioned.png");
  assert.equal(
    normalized.anchors[0].text,
    "[Image without extractable caption]",
  );
});
