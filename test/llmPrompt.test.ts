import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOutlinePrompt,
  buildSectionPrompt,
} from "../src/runtime/llmClient";
import type { AnchorChunk, ReadingOutlineSection } from "../src/core/types";

const anchor: AnchorChunk = {
  id: "chunk_0001",
  type: "text",
  pageIndex: 0,
  pageNumber: 1,
  text: "The samples reacted at 180 C for three hours.",
  sectionPath: ["Methods"],
};

test("outline prompt requires a verbatim quote for every visible claim", () => {
  const prompt = buildOutlinePrompt("Paper", [anchor], []);

  assert.match(prompt, /"evidence"/);
  assert.match(prompt, /"visualEvidence"/);
  assert.match(prompt, /"anchorId"/);
  assert.match(prompt, /"quote"/);
  assert.match(prompt, /verbatim|逐字|原文引文/i);
  assert.match(prompt, /1 至 3 条 evidence/);
  assert.match(prompt, /不得只返回第一处/);
  assert.match(prompt, /visualEvidence.*必须|必须.*visualEvidence/i);
  assert.match(prompt, /equation.*table.*image/i);
});

test("section prompt requires contiguous source-language evidence", () => {
  const section: ReadingOutlineSection = {
    title: "Methods",
    anchorIds: [anchor.id],
    bullets: [
      {
        claim: "Reaction conditions",
        anchorIds: [anchor.id],
        evidence: [
          {
            anchorId: anchor.id,
            quote: "reacted at 180 C for three hours",
          },
        ],
      },
    ],
  };
  const prompt = buildSectionPrompt("Paper", section, [anchor]);

  assert.match(prompt, /"evidence"/);
  assert.match(prompt, /"visualEvidence"/);
  assert.match(prompt, /连续/);
  assert.match(prompt, /源语言/);
  assert.match(prompt, /不得翻译|不能翻译/);
  assert.match(prompt, /不得只取第一处/);
  assert.match(prompt, /visualEvidence.*必须|必须.*visualEvidence/i);
  assert.match(prompt, /equation.*table.*image/i);
});
