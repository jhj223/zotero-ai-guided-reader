import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("parse cache v3 keeps legacy v2 text caches readable", async () => {
  const cache = await readFile(
    new URL("../src/runtime/cache.ts", import.meta.url),
    "utf8",
  );
  const service = await readFile(
    new URL("../src/runtime/guidedReadingService.ts", import.meta.url),
    "utf8",
  );

  assert.match(cache, /const CACHE_VERSION = 3;/);
  assert.match(cache, /export const CACHE_VERSION|export \{ CACHE_VERSION/);
  assert.match(cache, /isUsableParseCache/);
  assert.match(service, /isUsableParseCache/);
  assert.match(service, /restoreRichContentFromMarkdown/);
  assert.match(service, /writeParse/);
  assert.match(service, /try\s*\{/);
  assert.match(service, /catch\s*\(/);
  assert.match(service, /Unable to persist upgraded parse cache/);
});
