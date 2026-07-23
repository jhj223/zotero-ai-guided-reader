import type { LLMProviderId, ProviderSettings } from "../core/types";
import type {
  MinerUModelPreference,
  MinerUOcrMode,
  ResolvedMinerUModel,
} from "../core/mineruOptions";
import {
  normalizeSemanticProvider,
  semanticProviderDefinition,
  type SemanticProviderSettings,
} from "../core/semanticSettings";
import { LLM_PROVIDERS } from "../core/settings";
import { getPref } from "../utils/prefs";

export interface MinerUSettings {
  apiKey: string;
  modelVersion: MinerUModelPreference;
  language: string;
  ocrMode: MinerUOcrMode;
  pollIntervalMs: number;
}

export interface ResolvedMinerUSettings {
  apiKey: string;
  modelVersion: ResolvedMinerUModel;
  language: string;
  enableOcr: boolean;
  pollIntervalMs: number;
}

export function readProviderSettings(): ProviderSettings {
  const provider = normalizeProvider(getPref("llmProvider"));
  const providerDefaults = LLM_PROVIDERS[provider];
  const selectedModel = String(getPref("llmModel") || "");
  const model =
    selectedModel === "__custom__"
      ? String(getPref("llmCustomModel") || "")
      : selectedModel || providerDefaults.defaultModel;
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
    modelVersion: normalizeMinerUModel(getPref("mineruModelVersion")),
    language: String(getPref("mineruLanguage") || "ch"),
    ocrMode: normalizeOcrMode(getPref("mineruOcrMode")),
    pollIntervalMs: Number(getPref("mineruPollIntervalMs") || 3000),
  };
}

export function readSemanticSettings(): SemanticProviderSettings {
  const provider = normalizeSemanticProvider(getPref("semanticProvider"));
  const definition = semanticProviderDefinition(provider);
  const selectedModel = String(getPref("semanticModel") || "");
  return {
    provider,
    apiKey: String(getPref("semanticApiKey") || ""),
    model:
      selectedModel === "__custom__"
        ? String(getPref("semanticCustomModel") || "")
        : selectedModel || definition.defaultModel,
    baseUrl: String(getPref("semanticBaseUrl") || definition.baseUrl),
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

function normalizeMinerUModel(value: unknown): MinerUModelPreference {
  return value === "pipeline" || value === "vlm" ? value : "auto";
}

function normalizeOcrMode(value: unknown): MinerUOcrMode {
  return value === "always" ? "always" : "never";
}
