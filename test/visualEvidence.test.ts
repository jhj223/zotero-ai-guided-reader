import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeVisualEvidence,
  requiresVisualEvidence,
  visualEvidenceLabel,
} from "../src/core/visualEvidence";
import type { AnchorChunk } from "../src/core/types";

const anchors: AnchorChunk[] = [
  {
    id: "text_1",
    type: "text",
    pageIndex: 0,
    pageNumber: 1,
    text: "Ordinary paragraph",
    sectionPath: ["Results"],
  },
  {
    id: "image_1",
    type: "image",
    pageIndex: 4,
    pageNumber: 5,
    bbox: [100, 200, 900, 700],
    text: "Figure 2. Viscosity response",
    sectionPath: ["Results"],
    richContent: { caption: "Figure 2. Viscosity response" },
  },
  {
    id: "table_1",
    type: "table",
    pageIndex: 6,
    pageNumber: 7,
    text: "表 1 实验条件",
    sectionPath: ["Methods"],
    richContent: {
      caption: "表 1 实验条件",
      tableHtml: "<table></table>",
    },
  },
  {
    id: "equation_1",
    type: "equation",
    pageIndex: 7,
    pageNumber: 8,
    text: "Equation (3)",
    sectionPath: ["Theory"],
    richContent: { latex: "y=ax+b", caption: "Equation (3)" },
  },
  {
    id: "image_subfigure",
    type: "image",
    pageIndex: 4,
    pageNumber: 5,
    text: "(b) 缓蚀剂1 图 6 腐蚀后状态图",
    sectionPath: ["Results"],
  },
];

test("keeps unique known visual anchors and rejects invalid references", () => {
  assert.deepEqual(
    normalizeVisualEvidence(
      [
        { anchorId: "image_1" },
        { anchorId: "text_1" },
        { anchorId: "missing" },
        { anchorId: "image_1" },
        { anchorId: "table_1" },
        { anchorId: "equation_1", page: 99 },
      ],
      new Map(anchors.map((anchor) => [anchor.id, anchor])),
    ),
    [{ anchorId: "image_1" }, { anchorId: "table_1" }],
  );
});

test("derives visual labels from local caption metadata", () => {
  assert.equal(visualEvidenceLabel(anchors[1]), "图 2");
  assert.equal(visualEvidenceLabel(anchors[2]), "表 1");
  assert.equal(visualEvidenceLabel(anchors[3]), "公式 3");
});

test("rejects subfigures with only a parent figure number as standalone indexes", () => {
  assert.deepEqual(
    normalizeVisualEvidence(
      [{ anchorId: "image_subfigure" }],
      new Map(anchors.map((anchor) => [anchor.id, anchor])),
    ),
    [],
  );
});

test("detects explicit visual references without matching ordinary words", () => {
  assert.equal(requiresVisualEvidence("如图 2 所示，黏度随温度变化。"), true);
  assert.equal(requiresVisualEvidence("Table 4 compares all samples."), true);
  assert.equal(requiresVisualEvidence("作者试图解释该机制。"), false);
  assert.equal(requiresVisualEvidence("该表达方式保持不变。"), false);
});
