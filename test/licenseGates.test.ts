import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("commercial gates protect new generation and exports but not cached reading", async () => {
  const source = await readFile(
    new URL("../src/runtime/guidedReadingService.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /getLicenseManager/);
  assert.match(
    source,
    /if \(!force && currentCache\?\.outline\) return currentCache\.outline;[\s\S]{0,180}requirePro\(\)/,
  );
  assert.match(
    source,
    /if \(!force && currentCache\?\.structuredSections\?\.\[cacheKey\]\)[\s\S]*?return normalizeSectionGuide[\s\S]*?requirePro\(\)/,
  );
  assert.match(source, /async saveNote[\s\S]{0,160}requirePro\(\)/);
  assert.match(source, /async exportAnki[\s\S]{0,160}requirePro\(\)/);
  assert.doesNotMatch(
    source,
    /async loadCachedState[\s\S]{0,300}requirePro\(\)/,
  );
});
