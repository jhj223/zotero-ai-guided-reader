import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chooseReaderPaneApi } from "../src/core/zoteroCompatibility";

test("prefers registerSection on Zotero 9", () => {
  assert.equal(
    chooseReaderPaneApi({ registerSection() {}, registerView() {} }),
    "section",
  );
});

test("falls back to registerView for older Zotero", () => {
  assert.equal(chooseReaderPaneApi({ registerView() {} }), "view");
});

test("reports no API when neither registration function exists", () => {
  assert.equal(chooseReaderPaneApi({}), "none");
});

test("reader view uses and unregisters the Zotero 9 section API", async () => {
  const source = await readFile(
    new URL("../src/runtime/readerView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /chooseReaderPaneApi\(manager\)/);
  assert.match(source, /manager\.registerSection/);
  assert.match(source, /manager\.unregisterSection/);
});
