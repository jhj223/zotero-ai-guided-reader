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

test("plugin scope defines the browser globals react-dom needs", async () => {
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );

  // The bootstrap sandbox has no window/document. react-dom's render path
  // reads the bare `window` global (resolveUpdatePriority -> window.event)
  // and throws "ReferenceError: window is not defined", leaving the reader
  // section body empty.
  assert.match(source, /defineGlobal\("window"\)/);
  assert.match(source, /defineGlobal\("document"\)/);
});
