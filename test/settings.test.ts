import test from "node:test";
import assert from "node:assert/strict";
import { maskSecret, validateProviderSettings } from "../src/core/settings";

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
