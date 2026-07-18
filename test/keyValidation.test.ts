import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validateLlmKey,
  validateMinerUKey,
} from "../src/runtime/keyValidation";
import type { ProviderSettings } from "../src/core/types";

type FetchCall = { url: string; init?: RequestInit };

function fakeFetch(
  responses: Array<{ status: number; body?: unknown }>,
  calls: FetchCall[] = [],
) {
  let index = 0;
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body ?? {},
    };
  };
}

function llmSettings(
  overrides: Partial<ProviderSettings> = {},
): ProviderSettings {
  return {
    llmProvider: "deepseek",
    llmApiKey: "sk-llm",
    mineruApiKey: "sk-mineru",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
    ...overrides,
  };
}

test("mineru: empty key fails locally without any request", async () => {
  const calls: FetchCall[] = [];
  const result = await validateMinerUKey(
    "  ",
    fakeFetch([{ status: 200 }], calls),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /未填写/);
  assert.equal(calls.length, 0);
});

test("mineru: 401 reports an invalid or expired key", async () => {
  const result = await validateMinerUKey(
    "sk-bad",
    fakeFetch([{ status: 401, body: { code: -1, msg: "unauthorized" } }]),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /无效|过期/);
});

test("mineru: param-level rejection still proves the key works", async () => {
  const calls: FetchCall[] = [];
  const result = await validateMinerUKey(
    "sk-good",
    fakeFetch(
      [{ status: 200, body: { code: -60012, msg: "params error" } }],
      calls,
    ),
  );
  assert.equal(result.ok, true);
  assert.match(result.message, /通过/);
  assert.match(calls[0].url, /mineru\.net\/api\/v4\/file-urls\/batch$/);
  const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
  assert.equal(auth, "Bearer sk-good");
});

test("mineru: network failure reports a connection error", async () => {
  const result = await validateMinerUKey("sk-good", async () => {
    throw new Error("dns down");
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /无法连接/);
  assert.match(result.message, /dns down/);
});

test("llm: empty key fails locally without any request", async () => {
  const calls: FetchCall[] = [];
  const result = await validateLlmKey(
    llmSettings({ llmApiKey: "" }),
    fakeFetch([{ status: 200 }], calls),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /未填写/);
  assert.equal(calls.length, 0);
});

test("llm: openai-compatible provider validates via GET /models", async () => {
  const calls: FetchCall[] = [];
  const result = await validateLlmKey(
    llmSettings(),
    fakeFetch([{ status: 200, body: { data: [] } }], calls),
  );
  assert.equal(result.ok, true);
  assert.match(result.message, /通过/);
  assert.equal(calls[0].url, "https://api.deepseek.com/models");
  const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
  assert.equal(auth, "Bearer sk-llm");
});

test("llm: 401 from the provider reports an invalid key", async () => {
  const result = await validateLlmKey(
    llmSettings(),
    fakeFetch([{ status: 401, body: { error: { message: "bad key" } } }]),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /无效/);
});

test("llm: falls back to a minimal chat call when /models is missing", async () => {
  const calls: FetchCall[] = [];
  const result = await validateLlmKey(
    llmSettings({
      llmProvider: "volcengine",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "doubao-seed-1-6",
    }),
    fakeFetch([{ status: 404 }, { status: 200, body: {} }], calls),
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /chat\/completions$/);
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.max_tokens, 1);
});

test("llm: anthropic validates via /v1/models with x-api-key", async () => {
  const calls: FetchCall[] = [];
  const result = await validateLlmKey(
    llmSettings({
      llmProvider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-5",
    }),
    fakeFetch([{ status: 200, body: { data: [] } }], calls),
  );
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-llm");
  assert.ok(headers["anthropic-version"]);
});

test("preferences use live validation with Chinese toasts, not alert()", async () => {
  const source = await readFile(
    new URL("../src/modules/preferenceScript.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /validateMinerUKey|validateLlmKey/);
  assert.match(source, /ProgressWindow/);
  assert.doesNotMatch(source, /Local validation passed/);
  assert.doesNotMatch(source, /win\.alert/);
});
