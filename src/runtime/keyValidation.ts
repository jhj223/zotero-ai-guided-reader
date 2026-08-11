import { LLM_PROVIDERS } from "../core/settings";
import type { ProviderSettings } from "../core/types";
import { validateLocalCli } from "./localCliRunner";
import {
  ensureApiVersionBaseUrl,
  fetchWithTimeout,
  normalizeServiceBaseUrl,
} from "./networkSafety";

export interface KeyCheckResult {
  ok: boolean;
  message: string;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<FetchResponseLike>;

type CliValidator = (
  provider: "codex-cli" | "claude-cli",
) => Promise<KeyCheckResult>;

const MINERU_BATCH_URL = "https://mineru.net/api/v4/file-urls/batch";
const VALIDATION_TIMEOUT_MS = 30_000;

export async function validateMinerUKey(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<KeyCheckResult> {
  if (!apiKey.trim()) return { ok: false, message: "MinerU API Key 未填写" };

  let response: FetchResponseLike;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      MINERU_BATCH_URL,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        // Parameter-level rejection is sufficient to verify authentication and
        // does not create a parsing task or consume page quota.
        body: JSON.stringify({ files: [] }),
      },
      VALIDATION_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      ok: false,
      message: `无法连接 MinerU 服务器：${describeError(error)}`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: `MinerU Key 无效或已过期（服务器返回 ${response.status}）`,
    };
  }
  return { ok: true, message: "MinerU Key 校验通过（服务器鉴权成功）" };
}

export async function validateLlmKey(
  settings: ProviderSettings,
  fetchImpl: FetchLike = fetch,
  cliValidator: CliValidator = validateLocalCli,
): Promise<KeyCheckResult> {
  if (
    settings.llmProvider === "codex-cli" ||
    settings.llmProvider === "claude-cli"
  ) {
    return cliValidator(settings.llmProvider);
  }
  if (!settings.llmApiKey.trim()) {
    return { ok: false, message: "LLM API Key 未填写" };
  }

  const provider = LLM_PROVIDERS[settings.llmProvider];
  const baseUrl = normalizeServiceBaseUrl(
    settings.baseUrl || provider.baseUrl || "",
    { label: "LLM Base URL" },
  );
  try {
    if (settings.llmProvider === "anthropic") {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${ensureApiVersionBaseUrl(baseUrl, "v1")}/models`,
        {
          method: "GET",
          redirect: "error",
          headers: {
            "x-api-key": settings.llmApiKey,
            "anthropic-version": "2023-06-01",
          },
        },
        VALIDATION_TIMEOUT_MS,
      );
      return interpretLlmStatus(response.status, provider.label);
    }

    const models = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/models`,
      {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${settings.llmApiKey}` },
      },
      VALIDATION_TIMEOUT_MS,
    );
    if (models.status !== 404 && models.status !== 405) {
      return interpretLlmStatus(models.status, provider.label);
    }

    const chat = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.llmApiKey}`,
        },
        body: JSON.stringify({
          model: settings.model || provider.defaultModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      },
      VALIDATION_TIMEOUT_MS,
    );
    if (chat.ok) {
      return { ok: true, message: `LLM Key 校验通过（${provider.label}）` };
    }
    if (chat.status === 401 || chat.status === 403) {
      return {
        ok: false,
        message: `LLM Key 无效（${provider.label} 返回 ${chat.status}）`,
      };
    }
    return {
      ok: true,
      message: `LLM Key 未被拒绝（${provider.label} 返回 ${chat.status}），生成报错时请检查模型名`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `无法连接 ${provider.label} 服务器：${describeError(error)}`,
    };
  }
}

function interpretLlmStatus(status: number, label: string): KeyCheckResult {
  if (status >= 200 && status < 300) {
    return { ok: true, message: `LLM Key 校验通过（${label}）` };
  }
  if (status === 401 || status === 403) {
    return { ok: false, message: `LLM Key 无效（${label} 返回 ${status}）` };
  }
  return {
    ok: false,
    message: `无法确认 LLM Key（${label} 返回 ${status}），可直接尝试生成一次`,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
