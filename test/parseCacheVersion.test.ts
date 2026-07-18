import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("parse caches without page sizes are invalidated by a version bump", async () => {
  const cache = await readFile(
    new URL("../src/runtime/cache.ts", import.meta.url),
    "utf8",
  );
  const service = await readFile(
    new URL("../src/runtime/guidedReadingService.ts", import.meta.url),
    "utf8",
  );

  assert.match(cache, /const CACHE_VERSION = 2;/);
  assert.match(cache, /export const CACHE_VERSION|export \{ CACHE_VERSION/);
  // ensureParsed must reject caches written by older builds, which lack
  // pageSizes and would silently disable the anchor flash highlight.
  assert.match(service, /cached\?\.version === CACHE_VERSION/);
});
