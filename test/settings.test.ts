import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getProviderHints,
  maskSecret,
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
    model: "claude-sonnet-5",
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
  assert.match(source, /placeholder/);
});
