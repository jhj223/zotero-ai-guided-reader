import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8").catch(() => "");
}

test("library context menu targets Zotero item rows and opens guided reading", async () => {
  const source = await readSource("../src/runtime/libraryContextMenu.ts");

  assert.match(source, /registerMenu/);
  assert.match(source, /target:\s*"main\/library\/item"/);
  assert.match(source, /openGuidedReaderForItem\(item\)/);
});

test("plugin hooks register and unregister the library context menu", async () => {
  const source = await readSource("../src/hooks.ts");

  assert.match(source, /registerLibraryContextMenu\(\)/);
  assert.match(source, /registerLegacyLibraryContextMenu\(win\)/);
  assert.match(source, /unregisterLegacyLibraryContextMenu\(win\)/);
  assert.match(source, /unregisterLibraryContextMenu\(\)/);
});

test("library context menu has Chinese and English Fluent labels", async () => {
  const [chinese, english] = await Promise.all([
    readSource("../addon/locale/zh-CN/mainWindow.ftl"),
    readSource("../addon/locale/en-US/mainWindow.ftl"),
  ]);

  assert.match(chinese, /library-menu-ai-guided-reading = AI 带读/);
  assert.match(english, /library-menu-ai-guided-reading = AI Guided Reader/);
});
