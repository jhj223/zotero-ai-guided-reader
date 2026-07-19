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
        ],
      },
    ],
  });
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
      },
    ],
  });

  assert.match(
    markdown,
    /The sample reacted for three hours\. \[\[ANCHOR:chunk_0001\]\]/,
  );
});
