export type SemanticProviderId =
  | "none"
  | "voyage"
  | "openai"
  | "qwen"
  | "siliconflow"
  | "volcengine"
  | "jina"
  | "cohere"
  | "ollama"
  | "openai-compatible";

export interface SemanticProviderSettings {
  provider: SemanticProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface SemanticProviderDefinition {
  label: string;
  kind: "disabled" | "openai" | "cohere" | "ollama";
  defaultModel: string;
  models: readonly string[];
  baseUrl: string;
  queryInputType?: string;
  documentInputType?: string;
}

export const SEMANTIC_PROVIDERS: Record<
  SemanticProviderId,
  SemanticProviderDefinition
> = {
  none: {
    label: "关闭（默认）",
    kind: "disabled",
    defaultModel: "",
    models: [],
    baseUrl: "",
  },
  voyage: {
    label: "Voyage AI",
    kind: "openai",
    defaultModel: "voyage-4-large",
    models: [
      "voyage-4-large",
      "voyage-4",
      "voyage-4-lite",
      "voyage-3-large",
      "voyage-3.5",
      "voyage-3.5-lite",
      "voyage-code-3",
      "voyage-finance-2",
      "voyage-law-2",
    ],
    baseUrl: "https://api.voyageai.com/v1",
    queryInputType: "query",
    documentInputType: "document",
  },
  openai: {
    label: "OpenAI",
    kind: "openai",
    defaultModel: "text-embedding-3-large",
    models: [
      "text-embedding-3-large",
      "text-embedding-3-small",
      "text-embedding-ada-002",
    ],
    baseUrl: "https://api.openai.com/v1",
  },
  qwen: {
    label: "Qwen / DashScope",
    kind: "openai",
    defaultModel: "text-embedding-v4",
    models: ["text-embedding-v4", "text-embedding-v3", "text-embedding-v2"],
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  siliconflow: {
    label: "SiliconFlow",
    kind: "openai",
    defaultModel: "Qwen/Qwen3-Embedding-8B",
    models: ["Qwen/Qwen3-Embedding-8B", "BAAI/bge-m3"],
    baseUrl: "https://api.siliconflow.cn/v1",
  },
  volcengine: {
    label: "VolcEngine",
    kind: "openai",
    defaultModel: "",
    models: [],
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  jina: {
    label: "Jina AI",
    kind: "openai",
    defaultModel: "jina-embeddings-v4",
    models: [
      "jina-embeddings-v5-text-small",
      "jina-embeddings-v5-text-nano",
      "jina-embeddings-v4",
      "jina-embeddings-v3",
    ],
    baseUrl: "https://api.jina.ai/v1",
  },
  cohere: {
    label: "Cohere",
    kind: "cohere",
    defaultModel: "embed-v4.0",
    models: ["embed-v4.0", "embed-multilingual-v3.0", "embed-english-v3.0"],
    baseUrl: "https://api.cohere.com/v2",
  },
  ollama: {
    label: "Ollama（本机）",
    kind: "ollama",
    defaultModel: "qwen3-embedding",
    models: [
      "qwen3-embedding",
      "nomic-embed-text",
      "mxbai-embed-large",
      "all-minilm",
    ],
    baseUrl: "http://127.0.0.1:11434",
  },
  "openai-compatible": {
    label: "自定义 OpenAI 兼容接口",
    kind: "openai",
    defaultModel: "",
    models: [],
    baseUrl: "",
  },
};

export function semanticProviderDefinition(
  value: unknown,
): SemanticProviderDefinition {
  const id = String(value || "none") as SemanticProviderId;
  return SEMANTIC_PROVIDERS[id] || SEMANTIC_PROVIDERS.none;
}

export function normalizeSemanticProvider(value: unknown): SemanticProviderId {
  const id = String(value || "none");
  return id in SEMANTIC_PROVIDERS ? (id as SemanticProviderId) : "none";
}

export function getSemanticProviderModels(value: unknown): string[] {
  return [...semanticProviderDefinition(value).models];
}
