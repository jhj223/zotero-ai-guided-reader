import assert from "node:assert/strict";
import test from "node:test";
import {
  extractJsonObject,
  filterOutlineToKnownAnchors,
  normalizeSectionGuide,
  sectionGuideToMarkdown,
} from "../src/core/llmResponses";
import type { AnchorChunk } from "../src/core/types";

const anchors: AnchorChunk[] = [
  {
    id: "chunk_0001",
    type: "text",
    pageIndex: 0,
    pageNumber: 1,
    text: "The samples reacted at 180 C for three hours.",
    sectionPath: ["Methods"],
  },
  {
    id: "chunk_0002",
    type: "text",
    pageIndex: 1,
    pageNumber: 2,
    text: "The dispersion remained stable in 7000 mg/L NaCl.",
    sectionPath: ["Results"],
  },
  {
    id: "figure_0001",
    type: "image",
    pageIndex: 4,
    pageNumber: 5,
    bbox: [100, 200, 900, 700],
    text: "Figure 2. Viscosity response",
    sectionPath: ["Results"],
    richContent: { caption: "Figure 2. Viscosity response" },
  },
  {
    id: "corrosion_text",
    type: "text",
    pageIndex: 4,
    pageNumber: 5,
    text: "由结果可见 缓蚀剂 的缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准 因此选择缓蚀剂作为稠化酸体系用缓蚀剂",
    sectionPath: ["Results"],
  },
  {
    id: "corrosion_image_3",
    type: "image",
    pageIndex: 4,
    pageNumber: 5,
    text: "(d) 缓蚀剂3 图 6 腐蚀后状态图",
    sectionPath: ["Results"],
  },
  {
    id: "selection_text_without_metric",
    type: "text",
    pageIndex: 4,
    pageNumber: 5,
    text: "该缓蚀性能达到行业评价标准，因此确定了最终配方。",
    sectionPath: ["Results"],
  },
  {
    id: "other_corrosion_text",
    type: "text",
    pageIndex: 4,
    pageNumber: 5,
    text: "另一段只报告腐蚀速率为 39.494 达到行业评价标准",
    sectionPath: ["Results"],
  },
  {
    id: "corrosion_table_3",
    type: "table",
    pageIndex: 4,
    pageNumber: 5,
    text: "表 3 缓蚀剂的缓蚀性能评价结果",
    sectionPath: ["Results"],
    richContent: {
      caption: "表 3 缓蚀剂的缓蚀性能评价结果",
      tableHtml:
        "<table><tr><td>缓蚀剂1</td><td>180</td><td>39.494</td></tr><tr><td>缓蚀剂2</td><td>180</td><td>154.412</td></tr><tr><td>缓蚀剂3</td><td>90</td><td>69.793</td></tr></table>",
    },
  },
];

test("extractJsonObject parses fenced JSON from an LLM response", () => {
  assert.deepEqual(
    extractJsonObject<{ title: string }>('```json\n{"title":"Guide"}\n```'),
    { title: "Guide" },
  );
});

test("filterOutlineToKnownAnchors drops claims without a verified quote", () => {
  const outline = {
    title: "Paper",
    sections: [
      {
        title: "Methods",
        anchorIds: ["chunk_0001", "chunk_missing"],
        bullets: [
          {
            claim: "Verified",
            anchorIds: ["chunk_missing"],
            evidence: [
              {
                anchorId: "chunk_0001",
                quote: "reacted at 180 C for three hours",
              },
              { anchorId: "chunk_missing", quote: "made up" },
            ],
          },
          {
            claim: "Wrong quote",
            anchorIds: ["chunk_0001"],
            evidence: [
              { anchorId: "chunk_0001", quote: "a result not in the source" },
            ],
          },
        ],
      },
    ],
  };

  assert.deepEqual(filterOutlineToKnownAnchors(outline, anchors), {
    title: "Paper",
    sections: [
      {
        title: "Methods",
        anchorIds: ["chunk_0001"],
        bullets: [
          {
            claim: "Verified",
            anchorIds: ["chunk_0001"],
            evidence: [
              {
                anchorId: "chunk_0001",
                quote: "reacted at 180 C for three hours",
              },
            ],
          },
        ],
      },
    ],
  });
});

test("keeps validated visual evidence and adds it to section scope", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim: "如图 2 所示，分散体保持稳定。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "chunk_0002",
                  quote: "remained stable in 7000 mg/L NaCl",
                },
              ],
              visualEvidence: [{ anchorId: "figure_0001" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.deepEqual(outline.sections[0].bullets[0].visualEvidence, [
    { anchorId: "figure_0001" },
  ]);
  assert.deepEqual(outline.sections[0].anchorIds, [
    "chunk_0002",
    "figure_0001",
  ]);
});

test("drops explicit visual claims without a valid visual anchor", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim: "Figure 2 shows a monotonic response.",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "chunk_0002",
                  quote: "remained stable in 7000 mg/L NaCl",
                },
              ],
              visualEvidence: [{ anchorId: "missing" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.deepEqual(outline.sections, []);
});

test("rejects a numbered selection claim supported only by a nearby image", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim:
                "缓蚀剂3的腐蚀速率最低，满足行业标准，被选为体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_image_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.deepEqual(outline.sections, []);
});

test("rejects a numbered selection claim paired with another table row", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim:
                "缓蚀剂3的腐蚀速率最低，满足行业标准，被选为体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.deepEqual(outline.sections, []);
});

test("does not confuse a numbered entity with a longer identifier", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim:
                "缓蚀剂1的腐蚀速率最低，满足行业标准，被选为体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_10" }],
            },
          ],
        },
      ],
    },
    [
      ...anchors,
      {
        id: "corrosion_table_10",
        type: "table",
        pageIndex: 4,
        pageNumber: 5,
        text: "表 10 缓蚀剂评价结果",
        sectionPath: ["Results"],
        richContent: {
          caption: "表 10 缓蚀剂评价结果",
          tableHtml:
            "<table><tr><td>缓蚀剂10</td><td>180</td><td>39.494</td></tr></table>",
        },
      },
    ],
  );

  assert.deepEqual(outline.sections, []);
});

test("does not treat a decimal suffix as the same table metric", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim:
                "缓蚀剂1的腐蚀速率为39.494，满足行业标准，被选为体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_suffix" }],
            },
          ],
        },
      ],
    },
    [
      ...anchors,
      {
        id: "corrosion_table_suffix",
        type: "table",
        pageIndex: 4,
        pageNumber: 5,
        text: "表 11 缓蚀剂评价结果",
        sectionPath: ["Results"],
        richContent: {
          caption: "表 11 缓蚀剂评价结果",
          tableHtml:
            "<table><tr><td>缓蚀剂1</td><td>180</td><td>139.494</td></tr></table>",
        },
      },
    ],
  );

  assert.deepEqual(outline.sections, []);
});

test("rejects a numbered table selection claim without a row metric", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim:
                "缓蚀剂3的腐蚀速率最低，满足行业标准，被选为体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "selection_text_without_metric",
                  quote: "缓蚀性能达到行业评价标准，因此确定了最终配方",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.deepEqual(outline.sections, []);
});

test("keeps a numbered selection claim grounded in the results table", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim:
                "缓蚀剂1的腐蚀速率最低，满足行业标准，被选为体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.equal(
    outline.sections[0].bullets[0].claim.startsWith("缓蚀剂1"),
    true,
  );
  assert.deepEqual(outline.sections[0].bullets[0].visualEvidence, [
    { anchorId: "corrosion_table_3" },
  ]);
});

test("adds a table-backed final selection when the model omits that bullet", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          anchorIds: ["chunk_0002", "corrosion_text", "corrosion_table_3"],
          bullets: [
            {
              claim: "The dispersion remained stable.",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "chunk_0002",
                  quote: "The dispersion remained stable",
                },
              ],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.equal(outline.sections[0].bullets.length, 2);
  const selection = outline.sections[0].bullets[1];
  assert.match(selection.claim, /表 3.*39\.494.*缓蚀剂1/u);
  assert.match(selection.claim, /原文随后写明.*选择缓蚀剂作为/u);
  assert.doesNotMatch(selection.claim, /原文据此选择缓蚀剂1/u);
  assert.deepEqual(selection.visualEvidence, [
    { anchorId: "corrosion_table_3" },
  ]);
  assert.deepEqual(selection.anchorIds, [
    "corrosion_text",
    "corrosion_table_3",
  ]);
  assert.ok(
    selection.evidence.some((reference) => reference.quote.includes("39.494")),
  );
  assert.ok(
    selection.evidence.some((reference) =>
      reference.quote.includes("选择缓蚀剂作为"),
    ),
  );
});

test("uses the table-matched metric in an added final selection", () => {
  const anchorsWithTrailingMetric = anchors.map((anchor) =>
    anchor.id === "corrosion_text"
      ? {
          ...anchor,
          text: `${anchor.text.replace(" 因此", " 缓蚀率高达 0.85 因此")}`,
        }
      : anchor,
  );
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          anchorIds: ["chunk_0002", "corrosion_text", "corrosion_table_3"],
          bullets: [
            {
              claim: "The dispersion remained stable.",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "chunk_0002",
                  quote: "The dispersion remained stable",
                },
              ],
            },
          ],
        },
      ],
    },
    anchorsWithTrailingMetric,
  );

  const selection = outline.sections[0].bullets[1];
  assert.match(selection.claim, /表 3.*39\.494.*缓蚀剂1/u);
  assert.doesNotMatch(selection.claim, /指标 0\.85/u);
});

test("restores an omitted inhibitor number from a uniquely matching table row", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim:
                "在180℃高温高压下，仅有一种缓蚀剂的腐蚀速率为39.494 g/(m²·h)，达到行业评价标准。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.match(outline.sections[0].bullets[0].claim, /缓蚀剂1/);
  assert.doesNotMatch(outline.sections[0].bullets[0].claim, /一种缓蚀剂/);
});

test("propagates a unique table-backed inhibitor number to the final selection", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim:
                "在180℃高温高压下，仅有一种缓蚀剂的腐蚀速率为39.494 g/(m²·h)，达到行业评价标准。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
            {
              claim:
                "最终选择主要成分为醛酮胺类小分子聚合物的缓蚀剂作为稠化酸体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "因此选择缓蚀剂作为稠化酸体系用缓蚀剂",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.equal(outline.sections[0].bullets.length, 2);
  assert.match(outline.sections[0].bullets[1].claim, /最终选择缓蚀剂1/);
  assert.ok(
    outline.sections[0].bullets[1].evidence.some((reference) =>
      reference.quote.includes("39.494"),
    ),
  );
});

test("keeps a grounded generic final selection when no numbered row can resolve it", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim: "最终选择缓蚀剂作为稠化酸体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "因此选择缓蚀剂作为稠化酸体系用缓蚀剂",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.equal(outline.sections.length, 1);
  assert.equal(outline.sections[0].bullets.length, 1);
  assert.equal(
    outline.sections[0].bullets[0].claim,
    "最终选择缓蚀剂作为稠化酸体系用缓蚀剂。",
  );
});

test("does not propagate a table match from an unrelated text anchor", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim: "腐蚀速率为39.494 g/(m²·h)，达到行业评价标准。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "other_corrosion_text",
                  quote: "腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
            {
              claim: "最终选择缓蚀剂作为稠化酸体系用缓蚀剂。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "因此选择缓蚀剂作为稠化酸体系用缓蚀剂",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.equal(outline.sections[0].bullets.length, 2);
  for (const bullet of outline.sections[0].bullets) {
    assert.doesNotMatch(bullet.claim, /缓蚀剂1/);
  }
});

test("does not replace an inhibitor evaluation label with a row identity", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim: "该结果低于缓蚀剂评价指标，腐蚀速率为39.494 g/(m²·h)。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "corrosion_text",
                  quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
                },
              ],
              visualEvidence: [{ anchorId: "corrosion_table_3" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.equal(
    outline.sections[0].bullets[0].claim,
    "该结果低于缓蚀剂评价指标，腐蚀速率为39.494 g/(m²·h)。",
  );
});

test("restores the same table-backed inhibitor number in section close reading", () => {
  const guide = normalizeSectionGuide(
    {
      title: "Results",
      points: [
        {
          category: "judgment",
          text: "仅有一种缓蚀剂的腐蚀速率为39.494 g/(m²·h)，达到行业评价标准。",
          evidence: [
            {
              anchorId: "corrosion_text",
              quote: "缓蚀性能较优 腐蚀速率为 39.494 达到行业评价标准",
            },
          ],
          visualEvidence: [{ anchorId: "corrosion_table_3" }],
        },
        {
          category: "judgment",
          text: "最终选择缓蚀剂作为稠化酸体系用缓蚀剂。",
          evidence: [
            {
              anchorId: "corrosion_text",
              quote: "因此选择缓蚀剂作为稠化酸体系用缓蚀剂",
            },
          ],
          visualEvidence: [{ anchorId: "corrosion_table_3" }],
        },
      ],
    },
    anchors,
    "Results",
  );

  assert.equal(guide.points.length, 2);
  assert.match(guide.points[0].text, /缓蚀剂1/);
  assert.match(guide.points[1].text, /最终选择缓蚀剂1/);
});

test("normalizeSectionGuide keeps only unique points with verified evidence", () => {
  const guide = normalizeSectionGuide(
    {
      title: "**Methods**",
      points: [
        {
          category: "fact",
          text: "**The reaction used 180 C for three hours.**",
          evidence: [
            {
              anchorId: "chunk_0001",
              quote: "reacted at 180 C for three hours",
            },
            {
              anchorId: "chunk_0002",
              quote: "remained stable in 7000 mg/L NaCl",
            },
            {
              anchorId: "chunk_0001",
              quote: "reacted at 180 C for three hours",
            },
          ],
        },
        {
          category: "mechanism",
          text: "The reaction used 180 C for three hours.",
          evidence: [
            {
              anchorId: "chunk_0002",
              quote: "remained stable in 7000 mg/L NaCl",
            },
          ],
        },
        {
          category: "caution",
          text: "This statement cannot be traced.",
          evidence: [
            { anchorId: "chunk_0002", quote: "not present in this anchor" },
          ],
        },
      ],
    },
    anchors,
    "Section guide",
  );

  assert.deepEqual(guide, {
    title: "Methods",
    points: [
      {
        category: "fact",
        text: "The reaction used 180 C for three hours.",
        evidence: [
          {
            anchorId: "chunk_0001",
            quote: "reacted at 180 C for three hours",
          },
          {
            anchorId: "chunk_0002",
            quote: "remained stable in 7000 mg/L NaCl",
          },
        ],
      },
    ],
  });
});

test("keeps valid section visual evidence", () => {
  const guide = normalizeSectionGuide(
    {
      title: "Results",
      points: [
        {
          category: "fact",
          text: "Figure 2 shows the reported response.",
          evidence: [
            {
              anchorId: "chunk_0002",
              quote: "remained stable in 7000 mg/L NaCl",
            },
          ],
          visualEvidence: [{ anchorId: "figure_0001" }],
        },
      ],
    },
    anchors,
    "Results",
  );

  assert.deepEqual(guide.points[0].visualEvidence, [
    { anchorId: "figure_0001" },
  ]);
});

test("rejects an explicit section visual claim without a valid visual anchor", () => {
  assert.throws(
    () =>
      normalizeSectionGuide(
        {
          title: "Results",
          points: [
            {
              category: "fact",
              text: "Figure 2 shows the reported response.",
              evidence: [
                {
                  anchorId: "chunk_0002",
                  quote: "remained stable in 7000 mg/L NaCl",
                },
              ],
              visualEvidence: [{ anchorId: "missing" }],
            },
          ],
        },
        anchors,
        "Results",
      ),
    /traceable|quote|evidence/i,
  );
});

test("normalizeSectionGuide rejects old anchor-only cache entries", () => {
  assert.throws(
    () =>
      normalizeSectionGuide(
        {
          title: "Old guide",
          points: [
            {
              category: "fact",
              text: "No exact quote is stored.",
              anchorIds: ["chunk_0001"],
            },
          ],
        },
        anchors,
        "Old guide",
      ),
    /traceable|quote|evidence/i,
  );
});

test("sectionGuideToMarkdown preserves a link anchor for every point", () => {
  const markdown = sectionGuideToMarkdown({
    title: "Methods",
    points: [
      {
        category: "fact",
        text: "The sample reacted for three hours.",
        evidence: [
          {
            anchorId: "chunk_0001",
            quote: "reacted at 180 C for three hours",
          },
        ],
        visualEvidence: [{ anchorId: "figure_0001" }],
      },
    ],
  });

  assert.match(
    markdown,
    /The sample reacted for three hours\. \[\[ANCHOR:chunk_0001\]\] \[\[ANCHOR:figure_0001\]\]/,
  );
});
