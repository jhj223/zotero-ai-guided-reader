import assert from "node:assert/strict";
import test from "node:test";
import { resolveMinerUOptions } from "../src/core/mineruOptions";

test("automatic model selection keeps born-digital PDFs on pipeline", () => {
  const text = "可检索论文正文".repeat(200);
  assert.deepEqual(
    resolveMinerUOptions(
      { modelVersion: "auto", ocrMode: "never" },
      { extractedText: text, totalPages: 8 },
    ),
    { modelVersion: "pipeline", enableOcr: false, textLayerUsable: true },
  );
});

test("automatic model selection uses VLM without forcing separate OCR", () => {
  assert.deepEqual(
    resolveMinerUOptions(
      { modelVersion: "auto", ocrMode: "never" },
      { extractedText: "扫描页标题", totalPages: 12 },
    ),
    { modelVersion: "vlm", enableOcr: false, textLayerUsable: false },
  );
});

test("manual model and OCR choices override automatic detection", () => {
  assert.deepEqual(
    resolveMinerUOptions(
      { modelVersion: "vlm", ocrMode: "never" },
      { extractedText: "", totalPages: 20 },
    ),
    { modelVersion: "vlm", enableOcr: false, textLayerUsable: false },
  );
  assert.deepEqual(
    resolveMinerUOptions(
      { modelVersion: "pipeline", ocrMode: "always" },
      { extractedText: "足够的文本".repeat(200), totalPages: 2 },
    ),
    { modelVersion: "pipeline", enableOcr: true, textLayerUsable: true },
  );
});
