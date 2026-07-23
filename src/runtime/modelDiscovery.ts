import { LLM_PROVIDERS } from "../core/settings";
import {
  getSemanticProviderModels,
  semanticProviderDefinition,
  type SemanticProviderSettings,
} from "../core/semanticSettings";
import type { ProviderSettings } from "../core/types";
import type { FetchLike } from "./keyValidation";

export interface ModelDiscoveryResult {
  models: string[];
  providerLabel: string;
}

export type SemanticModelDiscoveryResult = ModelDiscoveryResult;

export async function fetchLlmModels(
  settings: ProviderSettings,
  fetchImpl: FetchLike = fetch,
): Promise<ModelDiscoveryResult> {
  const provider = LLM_PROVIDERS[settings.llmProvider];
  if (provider.kind !== "api") {
    throw new Error("本地 CLI 没有可用的模型枚举接口。");
  }
  if (!settings.llmApiKey.trim()) {
    throw new Error("请先填写 LLM API Key。");
  }

  const baseUrl = (settings.baseUrl || provider.baseUrl || "").replace(
    /\/+$/,
    "",
  );
  if (!baseUrl) throw new Error("请先填写 Base URL。");

  const anthropic = settings.llmProvider === "anthropic";
  const endpoint = anthropic
    ? `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models`
    : `${baseUrl}/models${
        settings.llmProvider === "siliconflow" ? "?type=text&sub_type=chat" : ""
      }`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (anthropic) {
    headers["x-api-key"] = settings.llmApiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${settings.llmApiKey}`;
  }

  let response;
  try {
    response = await fetchImpl(endpoint, { method: "GET", headers });
  } catch (error) {
    throw new Error(
      `无法连接 ${provider.label}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider.label} API Key 无效或无权读取模型列表。`);
  }
  if (response.status === 404 || response.status === 405) {
    throw new Error(
      `${provider.label} 当前 Base URL 不支持模型枚举，请检查 Base URL 或使用自定义模型名。`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${provider.label} 获取模型失败（HTTP ${response.status}）。`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${provider.label} 返回的模型列表不是有效 JSON。`);
  }
  const models = extractModelIds(payload);
  if (!models.length) {
    throw new Error(`${provider.label} 没有返回可选择的模型。`);
  }
  return { models, providerLabel: provider.label };
}

export async function fetchSemanticModels(
  settings: SemanticProviderSettings,
  fetchImpl: FetchLike = fetch,
): Promise<SemanticModelDiscoveryResult> {
  const provider = semanticProviderDefinition(settings.provider);
  if (provider.kind === "disabled") {
    throw new Error("请先选择语义定位 Provider。");
  }

  if (settings.provider === "voyage" || settings.provider === "jina") {
    return {
      models: getSemanticProviderModels(settings.provider),
      providerLabel: provider.label,
    };
  }

  const baseUrl = (settings.baseUrl || provider.baseUrl || "").replace(
    /\/+$/,
    "",
  );
  if (!baseUrl) throw new Error("请先填写语义定位 Base URL。");
  if (provider.kind !== "ollama" && !settings.apiKey.trim()) {
    throw new Error("请先填写语义定位 API Key。");
  }

  const endpoint = semanticModelsEndpoint(settings.provider, baseUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.kind !== "ollama") {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  let response;
  try {
    response = await fetchImpl(endpoint, { method: "GET", headers });
  } catch (error) {
    throw new Error(
      `无法连接 ${provider.label}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider.label} API Key 无效或无权读取模型列表。`);
  }
  if (response.status === 404 || response.status === 405) {
    throw new Error(
      `${provider.label} 当前 Base URL 不支持模型枚举，请检查 Base URL 或使用自定义模型名。`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${provider.label} 获取模型失败（HTTP ${response.status}）。`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${provider.label} 返回的模型列表不是有效 JSON。`);
  }
  const discovered = extractModelIds(payload);
  const models = filterSemanticModels(settings.provider, discovered);
  if (!models.length) {
    throw new Error(`${provider.label} 没有返回可选择的 Embedding 模型。`);
  }
  return { models, providerLabel: provider.label };
}

export function extractModelIds(payload: unknown): string[] {
  const record = asRecord(payload);
  const nestedResult = asRecord(record?.result);
  const candidates = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(nestedResult?.data)
        ? nestedResult.data
        : [];

  return [
    ...new Set(
      candidates
        .map((candidate) => {
          if (typeof candidate === "string") return candidate.trim();
          const item = asRecord(candidate);
          const value = item?.id ?? item?.model ?? item?.name;
          return typeof value === "string" ? value.trim() : "";
        })
        .filter((model) => model.length > 0 && model.length <= 256),
    ),
  ]
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )
    .slice(0, 500);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function semanticModelsEndpoint(provider: string, baseUrl: string): string {
  if (provider === "ollama") return `${baseUrl}/api/tags`;
  if (provider === "siliconflow") {
    return `${baseUrl}/models?sub_type=embedding`;
  }
  if (provider === "cohere") {
    const origin = baseUrl.replace(/\/v[12]$/, "");
    return `${origin}/v1/models?endpoint=embed&page_size=1000`;
  }
  return `${baseUrl}/models`;
}

function filterSemanticModels(provider: string, models: string[]): string[] {
  if (
    !["openai", "qwen", "volcengine", "openai-compatible"].includes(provider)
  ) {
    return models;
  }
  const embeddingModels = models.filter((model) => /embed/i.test(model));
  return embeddingModels.length ? embeddingModels : models;
}
