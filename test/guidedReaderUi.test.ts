import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("sidebar uses whole claims for navigation without page chips", async () => {
  const source = await readFile(
    new URL("../src/ui/GuidedReaderApp.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /selectAnchorIdsByDistinctPage/);
  assert.doesNotMatch(source, /p\.\$\{anchor\.pageNumber\}/);
  assert.doesNotMatch(source, /evidence\[0\]/);
  assert.match(source, /<AnchorButton/);
  assert.match(source, /<EvidenceLinkedClaim/);
  assert.match(source, /查看 \{locations\.length\} 处原文/);
  assert.match(source, /shortenEvidenceQuote/);
  assert.match(source, /semanticQuery=/);
  assert.doesNotMatch(source, /<ol className="zg-evidence-locations">/);
  assert.match(source, /role="list" className="zg-evidence-locations"/);
});

test("sidebar restores cache, supports collapse, renders rich content, and exposes Anki export", async () => {
  const source = await readFile(
    new URL("../src/ui/GuidedReaderApp.tsx", import.meta.url),
    "utf8",
  );
  const serviceSource = await readFile(
    new URL("../src/runtime/guidedReadingService.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /loadCachedState/);
  assert.match(source, /useEffect/);
  assert.match(source, /展开精读|收起精读/);
  assert.match(source, /重新生成导读/);
  assert.match(source, /generateOutline\(force\)/);
  assert.match(source, /generateSectionGuide\(section, true\)/);
  assert.match(serviceSource, /sections: force \? \{\} :/);
  assert.match(
    serviceSource,
    /if \(!force && currentCache\?\.structuredSections\?\.\[cacheKey\]\)/,
  );
  assert.match(source, /RichText/);
  assert.match(source, /VisualEvidence/);
  assert.match(source, /sectionAnchorIds=\{section\.anchorIds \|\| \[\]\}/);
  assert.match(source, /const generatedGuideText = outline/);
  assert.match(source, /disabled=\{busy \|\| !generatedGuideText\}/);
  assert.match(source, />\s*保存 Note\s*</);
  assert.match(source, />\s*导出 Anki\s*</);
  assert.doesNotMatch(source, /className="zg-more"/);
});
