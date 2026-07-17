import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasReaderSectionApi } from "../src/core/zoteroCompatibility";

test("accepts a manager exposing the Zotero 9 section API", () => {
  assert.equal(hasReaderSectionApi({ registerSection() {} }), true);
});

test("rejects a manager with only the legacy view API", () => {
  assert.equal(hasReaderSectionApi({ registerView() {} }), false);
});

test("rejects a manager without registration APIs", () => {
  assert.equal(hasReaderSectionApi({}), false);
});

test("reader view registers only through the section API", async () => {
  const source = await readFile(
    new URL("../src/runtime/readerView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /hasReaderSectionApi\(manager\)/);
  assert.match(source, /manager\.unregisterSection/);
  assert.doesNotMatch(source, /registerView/i);
});
