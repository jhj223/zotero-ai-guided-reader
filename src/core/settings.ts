import type { LLMProviderId, ProviderSettings } from "./types";

export interface LLMProviderDefinition {
  label: string;
  kind: "api" | "cli";
  defaultModel: string;
  models: string[];
  baseUrl?: string;
}

export const LLM_PROVIDERS: Record<LLMProviderId, LLMProviderDefinition> = {
  anthropic: {
    label: "Anthropic",
    kind: "api",
    defaultModel: "claude-sonnet-4-5",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
    baseUrl: "https://api.anthropic.com",
  },
  openai: {
    label: "OpenAI",
    kind: "api",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-4.1", "gpt-4.1-mini"],
    baseUrl: "https://api.openai.com/v1",
  },
  deepseek: {
    label: "DeepSeek",
    kind: "api",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    baseUrl: "https://api.deepseek.com",
  },
  qwen: {
    label: "Qwen",
    kind: "api",
    defaultModel: "qwen-plus",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  volcengine: {
    label: "VolcEngine",
    kind: "api",
    defaultModel: "doubao-seed-1-6",
    models: ["doubao-seed-1-6", "doubao-seed-1-6-thinking"],
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  siliconflow: {
    label: "SiliconFlow",
    kind: "api",
    defaultModel: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    models: ["Qwen/Qwen3-235B-A22B-Instruct-2507", "deepseek-ai/DeepSeek-V3.2"],
    baseUrl: "https://api.siliconflow.cn/v1",
  },
  "codex-cli": {
    label: "Codex CLI（本机登录）",
    kind: "cli",
    defaultModel: "",
    models: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
  },
  "claude-cli": {
    label: "Claude Code CLI（本机登录）",
    kind: "cli",
    defaultModel: "opus",
    models: ["opus", "sonnet", "haiku"],
  },
};

export function getProviderHints(provider: unknown): {
  model: string;
  baseUrl: string;
} {
  const info = providerDefinition(provider);
  return { model: info?.defaultModel || "", baseUrl: info?.baseUrl || "" };
}

export function getProviderModels(provider: unknown): string[] {
  return [...(providerDefinition(provider)?.models || [])];
}

export function providerRequiresApiKey(provider: LLMProviderId): boolean {
  return LLM_PROVIDERS[provider].kind === "api";
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length < 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function validateProviderSettings(settings: ProviderSettings): string[] {
  const errors: string[] = [];
  if (
    providerRequiresApiKey(settings.llmProvider) &&
    !settings.llmApiKey.trim()
  ) {
    errors.push("LLM API Key is required for guided reading generation.");
  }
  if (!settings.mineruApiKey.trim()) {
    errors.push("MinerU API Key is required for PDF structured parsing.");
  }
  return errors;
}

function providerDefinition(value: unknown): LLMProviderDefinition | undefined {
  const id = String(value || "");
  return id in LLM_PROVIDERS ? LLM_PROVIDERS[id as LLMProviderId] : undefined;
}
