import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getProviderHints,
  getProviderModels,
  maskSecret,
  providerRequiresApiKey,
  validateProviderSettings,
} from "../src/core/settings";

test("maskSecret avoids logging plaintext API keys", () => {
  assert.equal(maskSecret("sk-1234567890abcdef"), "sk-1...cdef");
  assert.equal(maskSecret("short"), "*****");
  assert.equal(maskSecret(""), "");
});

test("validateProviderSettings keeps LLM and MinerU keys independent", () => {
  assert.deepEqual(
    validateProviderSettings({
      llmProvider: "openai",
      llmApiKey: "",
      mineruApiKey: "mineru-token",
    }),
    ["LLM API Key is required for guided reading generation."],
  );

  assert.deepEqual(
    validateProviderSettings({
      llmProvider: "deepseek",
      llmApiKey: "deepseek-key",
      mineruApiKey: "",
    }),
    ["MinerU API Key is required for PDF structured parsing."],
  );
});

test("getProviderHints exposes each provider's default model and base URL", () => {
  assert.deepEqual(getProviderHints("qwen"), {
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
  assert.deepEqual(getProviderHints("anthropic"), {
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com",
  });
  assert.deepEqual(getProviderHints("unknown-provider"), {
    model: "",
    baseUrl: "",
  });
});

test("preferences show provider defaults as input placeholders", async () => {
  const source = await readFile(
    new URL("../src/modules/preferenceScript.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /getProviderHints/);
  assert.match(source, /getProviderModels/);
  assert.match(source, /placeholder/);
  assert.match(source, /__custom__/);
  assert.match(source, /new win\.Event/);
  assert.doesNotMatch(source, /new Event\(/);
});

test("preference controls wait for Zotero 9 preference synchronization", async () => {
  const source = await readFile(
    new URL("../src/modules/preferenceScript.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /getPref\("llmProvider"\)/);
  assert.match(source, /getPref\("llmModel"\)/);
  assert.match(source, /getPref\("semanticProvider"\)/);
  assert.match(source, /getPref\("semanticModel"\)/);
  assert.match(source, /syncfrompreference/);
  assert.match(source, /applyProvider\(false, false, true\)/);
});

test("model catalogs include custom selection and local CLI providers need no key", () => {
  assert.ok(getProviderModels("openai").length > 1);
  assert.ok(getProviderModels("codex-cli").includes("gpt-5.4"));
  assert.ok(getProviderModels("claude-cli").includes("opus"));
  assert.equal(providerRequiresApiKey("codex-cli"), false);
  assert.equal(providerRequiresApiKey("claude-cli"), false);
  assert.equal(providerRequiresApiKey("deepseek"), true);

  assert.deepEqual(
    validateProviderSettings({
      llmProvider: "codex-cli",
      llmApiKey: "",
      mineruApiKey: "mineru-token",
    }),
    [],
  );
});

test("semantic locator settings are optional and expose provider families", async () => {
  const markup = await readFile(
    new URL("../addon/content/preferences.xhtml", import.meta.url),
    "utf8",
  );
  assert.match(markup, /preference="semanticProvider"/);
  assert.match(markup, /value="none"/);
  assert.match(markup, /value="voyage"/);
  assert.match(markup, /value="openai-compatible"/);
  assert.match(markup, /value="cohere"/);
  assert.match(markup, /value="ollama"/);
  assert.match(markup, /id="__addonRef__-fetch-semantic-models"/);
  assert.match(
    markup,
    /<html:select[\s\S]*id="zotero-prefpane-__addonRef__-semanticModel"/,
  );
  assert.match(markup, /preference="semanticCustomModel"/);
});

test("MinerU recommends VLM and exposes only explicit OCR forcing", async () => {
  const [markup, defaults, script] = await Promise.all([
    readFile(
      new URL("../addon/content/preferences.xhtml", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../addon/prefs.js", import.meta.url), "utf8"),
    readFile(
      new URL("../src/modules/preferenceScript.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(defaults, /pref\("mineruModelVersion", "vlm"\)/);
  assert.match(defaults, /pref\("mineruOcrMode", "never"\)/);
  assert.doesNotMatch(markup, /value="auto"[\s\S]*pref-mineru-ocr-auto/);
  assert.match(markup, /value="always"/);
  assert.match(markup, /value="never"/);
  assert.match(script, /getPref\("mineruOcrMode"\) === "auto"/);
  assert.match(script, /setPref\("mineruOcrMode", "never"\)/);
});
