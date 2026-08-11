import assert from "node:assert/strict";
import test from "node:test";
import { LLMClient } from "../src/runtime/llmClient";

test("rejects an insecure LLM base URL before transmitting the API key", async () => {
  let requested = false;
  const client = new LLMClient(
    {
      llmProvider: "openai-compatible",
      llmApiKey: "secret",
      mineruApiKey: "mineru",
      model: "model",
      baseUrl: "http://api.example.test/v1",
    },
    async () => {
      requested = true;
      throw new Error("must not request");
    },
  );

  await assert.rejects(
    client.generateOutline({ title: "Paper", anchors: [], annotations: [] }),
    /HTTPS/,
  );
  assert.equal(requested, false);
});
