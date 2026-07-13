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

  // Zotero 9 MenuManager sets data-l10n-id on a XUL <menuitem>, which renders
  // its `label` attribute. A flat Fluent value only sets textContent and leaves
  // the menu item blank, so the id must expose a `.label` attribute.
  assert.match(
    chinese,
    /library-menu-ai-guided-reading =\r?\n\s+\.label = AI 带读/,
  );
  assert.match(
    english,
    /library-menu-ai-guided-reading =\r?\n\s+\.label = AI Guided Reader/,
  );
});

test("library menu label is a XUL attribute, not a blank flat value", async () => {
  const [chinese, english] = await Promise.all([
    readSource("../addon/locale/zh-CN/mainWindow.ftl"),
    readSource("../addon/locale/en-US/mainWindow.ftl"),
  ]);

  for (const source of [chinese, english]) {
    // A flat `id = text` value renders blank on a XUL menuitem in Zotero 9.
    assert.doesNotMatch(
      source,
      /^library-menu-ai-guided-reading = \S/m,
      "menu label must use a `.label` attribute, not a flat Fluent value",
    );
    assert.match(source, /library-menu-ai-guided-reading =\r?\n\s+\.label = /);
  }
});
