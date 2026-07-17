import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest supports Zotero 9.0.x", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../addon/manifest.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.applications.zotero.strict_max_version, "9.0.*");
});
