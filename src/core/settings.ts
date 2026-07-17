import type { LLMProviderId, ProviderSettings } from "./types";

export const LLM_PROVIDERS: Record<
  LLMProviderId,
  { label: string; defaultModel: string; baseUrl?: string }
> = {
  anthropic: {
    label: "Anthropic",
    defaultModel: "claude-sonnet-5",
    baseUrl: "https://api.anthropic.com",
  },
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
  },
  deepseek: {
    label: "DeepSeek",
    defaultModel: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
  },
  qwen: {
    label: "Qwen",
    defaultModel: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  volcengine: {
    label: "VolcEngine",
    defaultModel: "doubao-seed-1-6",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  siliconflow: {
    label: "SiliconFlow",
    defaultModel: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    baseUrl: "https://api.siliconflow.cn/v1",
  },
};

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length < 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function validateProviderSettings(settings: ProviderSettings): string[] {
  const errors: string[] = [];
  if (!settings.llmApiKey.trim()) {
    errors.push("LLM API Key is required for guided reading generation.");
  }
  if (!settings.mineruApiKey.trim()) {
    errors.push("MinerU API Key is required for PDF structured parsing.");
  }
  return errors;
}
