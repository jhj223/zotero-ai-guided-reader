import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bootstrap exposes console to the React bundle", async () => {
  const bootstrap = await readFile(
    new URL("../addon/bootstrap.js", import.meta.url),
    "utf8",
  );

  assert.match(
    bootstrap,
    /const ctx = \{ rootURI, console: Zotero\.getMainWindow\(\)\.console \};/,
  );
});
