import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("sidebar uses whole claims for exact navigation without page chips", async () => {
  const source = await readFile(
    new URL("../src/ui/GuidedReaderApp.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /AnchorButton/);
  assert.doesNotMatch(source, /selectAnchorIdsByDistinctPage/);
  assert.doesNotMatch(source, /p\.\$\{anchor\.pageNumber\}/);
  assert.match(source, /quote:\s*primaryEvidence\.quote/);
});
