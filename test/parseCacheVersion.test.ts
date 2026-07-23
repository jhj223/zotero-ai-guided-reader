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
});
