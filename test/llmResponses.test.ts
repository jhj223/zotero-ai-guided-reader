import test from "node:test";
import assert from "node:assert/strict";
import {
  extractJsonObject,
  filterOutlineToKnownAnchors,
} from "../src/core/llmResponses";

test("extractJsonObject parses fenced JSON from an LLM response", () => {
  const result = extractJsonObject<{ title: string }>(
    '```json\n{"title":"导读"}\n```',
  );

  assert.deepEqual(result, { title: "导读" });
});

test("filterOutlineToKnownAnchors removes unknown anchor references defensively", () => {
  const outline = {
    title: "Paper",
    sections: [
      {
        title: "Intro",
        bullets: [
          {
            claim: "Known",
            anchorIds: ["chunk_0001", "chunk_9999"],
          },
          {
            claim: "Unknown only",
            anchorIds: ["chunk_9999"],
          },
        ],
      },
    ],
  };

  assert.deepEqual(
    filterOutlineToKnownAnchors(outline, new Set(["chunk_0001"])),
    {
      title: "Paper",
      sections: [
        {
          title: "Intro",
          bullets: [{ claim: "Known", anchorIds: ["chunk_0001"] }],
        },
      ],
    },
  );
});
