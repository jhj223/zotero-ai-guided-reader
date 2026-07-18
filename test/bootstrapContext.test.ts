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

test("plugin scope polyfills setImmediate for JSZip", async () => {
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );

  // JSZip's async workers call the bare `setImmediate` global, which does not
  // exist in the bootstrap sandbox; unpacking the MinerU result ZIP throws
  // "setImmediate is not defined" without a polyfill.
  assert.match(source, /setImmediate/);
});

test("runtime timers avoid bare setTimeout in the sandbox", async () => {
  const source = await readFile(
    new URL("../src/runtime/openGuidedReader.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /Zotero\.Promise\.delay/);
  assert.doesNotMatch(source, /setTimeout\(/);
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
