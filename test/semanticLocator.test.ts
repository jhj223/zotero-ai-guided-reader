import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSemanticWindows,
  locateSemanticSpan,
} from "../src/core/semanticLocator";

test("builds bounded local windows with source segment offsets", () => {
  const segments = [
    ..."第一句介绍研究背景。第二句说明样品在高温下仍保持稳定。第三句讨论局限。",
  ];
  const windows = buildSemanticWindows(segments);
  assert.ok(windows.length >= 3);
  assert.ok(
    windows.some(
      (window) =>
        window.text.includes("样品在高温下仍保持稳定") &&
        segments
          .slice(window.startSegment, window.endSegment + 1)
          .join("")
          .includes("样品在高温下仍保持稳定"),
    ),
  );
  assert.ok(windows.every((window) => window.text.length <= 96));
});

test("uses semantic scores to select a local source span", async () => {
  const segments = [
    ..."样品制备完成。材料在180摄氏度下保持稳定。作者未讨论长期循环性能。",
  ];
  const match = await locateSemanticSpan(
    segments,
    "该材料具有良好的高温稳定性",
    async (_query, documents) =>
      documents.map((document) =>
        document.includes("180摄氏度") ? 0.86 : 0.31,
      ),
  );
  assert.ok(match);
  assert.match(
    segments.slice(match.startSegment, match.endSegment + 1).join(""),
    /180摄氏度下保持稳定/,
  );
});

test("rejects ambiguous semantic matches", async () => {
  const segments = [..."第一处结果保持稳定。第二处结果同样保持稳定。"];
  assert.equal(
    await locateSemanticSpan(segments, "结果稳定", async (_query, documents) =>
      documents.map(() => 0.8),
    ),
    undefined,
  );
});
