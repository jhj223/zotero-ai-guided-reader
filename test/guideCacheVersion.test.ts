import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("guide caches without strict numbered evidence are invalidated", async () => {
  const cache = await readFile(
    new URL("../src/runtime/cache.ts", import.meta.url),
    "utf8",
  );
  const service = await readFile(
    new URL("../src/runtime/guidedReadingService.ts", import.meta.url),
    "utf8",
  );

  assert.match(cache, /GUIDE_CACHE_VERSION = 7/);
  assert.match(service, /cached\?\.version === GUIDE_CACHE_VERSION/);
  assert.doesNotMatch(service, /version:\s*1/);
});
