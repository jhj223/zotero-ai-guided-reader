import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettings } from "../src/core/types";
import type { SemanticProviderSettings } from "../src/core/semanticSettings";
import {
  extractModelIds,
  fetchLlmModels,
  fetchSemanticModels,
} from "../src/runtime/modelDiscovery";

type FetchCall = { url: string; init?: RequestInit };

function settings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    llmProvider: "qwen",
    llmApiKey: "sk-test",
    mineruApiKey: "mineru-test",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    ...overrides,
  };
}

function semanticSettings(
  overrides: Partial<SemanticProviderSettings> = {},
): SemanticProviderSettings {
  return {
    provider: "siliconflow",
    apiKey: "embedding-test",
    model: "Qwen/Qwen3-Embedding-8B",
    baseUrl: "https://api.siliconflow.cn/v1",
    ...overrides,
  };
}

function fakeFetch(status: number, body: unknown, calls: FetchCall[]) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
}

test("fetches and deduplicates OpenAI-compatible model IDs", async () => {
  const calls: FetchCall[] = [];
  const result = await fetchLlmModels(
    settings(),
    fakeFetch(
      200,
      { data: [{ id: "qwen-max" }, { id: "qwen-plus" }, { id: "qwen-max" }] },
      calls,
    ),
  );

  assert.deepEqual(result.models, ["qwen-max", "qwen-plus"]);
  assert.equal(
    calls[0].url,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
  );
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer sk-test",
  );
});

test("uses the Anthropic models endpoint and authentication headers", async () => {
  const calls: FetchCall[] = [];
  await fetchLlmModels(
    settings({
      llmProvider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    }),
    fakeFetch(200, { data: [{ id: "claude-sonnet-4-5" }] }, calls),
  );

  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-test");
  assert.ok(headers["anthropic-version"]);
  assert.equal(headers.Authorization, undefined);
});

test("filters SiliconFlow discovery to text chat models", async () => {
  const calls: FetchCall[] = [];
  await fetchLlmModels(
    settings({
      llmProvider: "siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
    }),
    fakeFetch(200, { data: [{ id: "Qwen/Qwen3" }] }, calls),
  );
  assert.equal(
    calls[0].url,
    "https://api.siliconflow.cn/v1/models?type=text&sub_type=chat",
  );
});

test("reports authentication and unsupported endpoint errors", async () => {
  await assert.rejects(
    fetchLlmModels(settings(), fakeFetch(401, {}, [])),
    /Key 无效|无权/,
  );
  await assert.rejects(
    fetchLlmModels(settings(), fakeFetch(404, {}, [])),
    /不支持模型枚举/,
  );
});

test("extracts defensive model list response variants", () => {
  assert.deepEqual(
    extractModelIds({ models: ["model-b", { name: "model-a" }, null] }),
    ["model-a", "model-b"],
  );
  assert.deepEqual(extractModelIds({ result: { data: [{ model: "m1" }] } }), [
    "m1",
  ]);
});

test("uses the documented Voyage embedding catalog without a list request", async () => {
  let requested = false;
  const result = await fetchSemanticModels(
    semanticSettings({
      provider: "voyage",
      apiKey: "",
      model: "voyage-4-large",
      baseUrl: "https://api.voyageai.com/v1",
    }),
    async () => {
      requested = true;
      throw new Error("must not request");
    },
  );

  assert.equal(requested, false);
  assert.ok(result.models.includes("voyage-4-large"));
  assert.ok(result.models.includes("voyage-4-lite"));
});

test("fetches only SiliconFlow embedding models", async () => {
  const calls: FetchCall[] = [];
  const result = await fetchSemanticModels(
    semanticSettings(),
    fakeFetch(
      200,
      {
        data: [{ id: "Qwen/Qwen3-Embedding-8B" }, { id: "BAAI/bge-m3" }],
      },
      calls,
    ),
  );

  assert.equal(
    calls[0].url,
    "https://api.siliconflow.cn/v1/models?sub_type=embedding",
  );
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer embedding-test",
  );
  assert.deepEqual(result.models, ["BAAI/bge-m3", "Qwen/Qwen3-Embedding-8B"]);
});

test("uses Cohere's embed-filtered model list endpoint", async () => {
  const calls: FetchCall[] = [];
  const result = await fetchSemanticModels(
    semanticSettings({
      provider: "cohere",
      baseUrl: "https://api.cohere.com/v2",
      model: "embed-v4.0",
    }),
    fakeFetch(200, { models: [{ name: "embed-v4.0" }] }, calls),
  );

  assert.equal(
    calls[0].url,
    "https://api.cohere.com/v1/models?endpoint=embed&page_size=1000",
  );
  assert.deepEqual(result.models, ["embed-v4.0"]);
});

test("lists locally installed Ollama models without requiring a key", async () => {
  const calls: FetchCall[] = [];
  const result = await fetchSemanticModels(
    semanticSettings({
      provider: "ollama",
      apiKey: "",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding",
    }),
    fakeFetch(200, { models: [{ name: "qwen3-embedding:latest" }] }, calls),
  );

  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/tags");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    undefined,
  );
  assert.deepEqual(result.models, ["qwen3-embedding:latest"]);
});

test("filters generic semantic model catalogs to embedding models", async () => {
  for (const provider of ["volcengine", "openai-compatible"] as const) {
    const result = await fetchSemanticModels(
      semanticSettings({
        provider,
        baseUrl: "https://example.test/v1",
      }),
      fakeFetch(
        200,
        {
          data: [
            { id: "chat-model" },
            { id: "text-embedding-model" },
            { id: "another-chat-model" },
          ],
        },
        [],
      ),
    );

    assert.deepEqual(result.models, ["text-embedding-model"]);
  }
});
