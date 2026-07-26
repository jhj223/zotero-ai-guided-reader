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
