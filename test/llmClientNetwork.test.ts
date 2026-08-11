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

test("does not duplicate Anthropic v1 in the messages endpoint", async () => {
  const calls: string[] = [];
  const client = new LLMClient(
    {
      llmProvider: "anthropic",
      llmApiKey: "secret",
      mineruApiKey: "mineru",
      model: "claude-sonnet-4-5",
      baseUrl: "https://api.anthropic.com/v1",
    },
    async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: '{"title":"Paper","sections":[]}' }],
        }),
      } as Response;
    },
  );

  await client.generateOutline({
    title: "Paper",
    anchors: [],
    annotations: [],
  });
  assert.deepEqual(calls, ["https://api.anthropic.com/v1/messages"]);
});
