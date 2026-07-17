import type { LLMProviderId, ProviderSettings } from "../core/types";
import { LLM_PROVIDERS } from "../core/settings";
import { getPref } from "../utils/prefs";

export interface MinerUSettings {
  apiKey: string;
  modelVersion: string;
  language: string;
  enableOcr: boolean;
  pollIntervalMs: number;
}

export function readProviderSettings(): ProviderSettings {
  const provider = normalizeProvider(getPref("llmProvider"));
  const providerDefaults = LLM_PROVIDERS[provider];
  const model = String(getPref("llmModel") || providerDefaults.defaultModel);
  const baseUrl = String(
    getPref("llmBaseUrl") || providerDefaults.baseUrl || "",
  );

  return {
    llmProvider: provider,
    llmApiKey: String(getPref("llmApiKey") || ""),
    mineruApiKey: String(getPref("mineruApiKey") || ""),
    model,
    baseUrl,
  };
}

export function readMinerUSettings(): MinerUSettings {
  return {
    apiKey: String(getPref("mineruApiKey") || ""),
    modelVersion: String(getPref("mineruModelVersion") || "vlm"),
    language: String(getPref("mineruLanguage") || "ch"),
    enableOcr: Boolean(getPref("mineruEnableOcr")),
    pollIntervalMs: Number(getPref("mineruPollIntervalMs") || 3000),
  };
}

export function isPluginEnabled(): boolean {
  return Boolean(getPref("enable"));
}

export function shouldTryTemporaryHighlight(): boolean {
  return Boolean(getPref("temporaryHighlight"));
}

function normalizeProvider(value: unknown): LLMProviderId {
  const provider = String(value || "deepseek");
  return provider in LLM_PROVIDERS ? (provider as LLMProviderId) : "deepseek";
}
