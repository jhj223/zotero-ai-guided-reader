import {
  semanticProviderDefinition,
  type SemanticProviderSettings,
} from "../core/semanticSettings";
import {
  fetchWithTimeout,
  normalizeServiceBaseUrl,
  type FetchLike,
} from "./networkSafety";

const EMBEDDING_TIMEOUT_MS = 60_000;

export class SemanticClient {
  constructor(
    private readonly settings: SemanticProviderSettings,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async score(query: string, documents: string[]): Promise<number[]> {
    const definition = semanticProviderDefinition(this.settings.provider);
    if (definition.kind === "disabled" || documents.length === 0) return [];
    if (!this.settings.model.trim()) {
      throw new Error("语义定位模型未填写。");
    }
    if (definition.kind !== "ollama" && !this.settings.apiKey.trim()) {
      throw new Error("语义定位 API Key 未填写。");
    }
    this.baseUrl();

    let queryVector: number[];
    let documentVectors: number[][];
    if (definition.kind === "cohere") {
      queryVector = (await this.embedCohere([query], "search_query"))[0];
      documentVectors = await this.embedCohere(documents, "search_document");
    } else if (definition.kind === "ollama") {
      const vectors = await this.embedOllama([query, ...documents]);
      [queryVector, ...documentVectors] = vectors;
    } else if (this.settings.provider === "jina") {
      queryVector = (await this.embedOpenAI([query], "retrieval.query"))[0];
      documentVectors = await this.embedOpenAI(documents, "retrieval.passage");
    } else if (definition.queryInputType && definition.documentInputType) {
      queryVector = (
        await this.embedOpenAI([query], definition.queryInputType)
      )[0];
      documentVectors = await this.embedOpenAI(
        documents,
        definition.documentInputType,
      );
    } else {
      const vectors = await this.embedOpenAI([query, ...documents]);
      [queryVector, ...documentVectors] = vectors;
    }
    if (!queryVector || documentVectors.length !== documents.length) {
      throw new Error("语义定位服务返回的向量数量不正确。");
    }
    return documentVectors.map((vector) =>
      cosineSimilarity(queryVector, vector),
    );
  }

  private async embedOpenAI(
    input: string[],
    inputType?: string,
  ): Promise<number[][]> {
    const outputFormat =
      this.settings.provider === "voyage"
        ? { output_dtype: "float" }
        : this.settings.provider === "jina"
          ? { embedding_type: "float" }
          : { encoding_format: "float" };
    const taskType =
      this.settings.provider === "jina"
        ? inputType
          ? { task: inputType }
          : {}
        : inputType
          ? { input_type: inputType }
          : {};
    const payload = await this.request(`${this.baseUrl()}/embeddings`, {
      model: this.settings.model,
      input,
      ...outputFormat,
      ...taskType,
    });
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data
      .map((item, index) => ({
        index: Number(item?.index ?? index),
        embedding: toVector(item?.embedding),
      }))
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
  }

  private async embedCohere(
    texts: string[],
    inputType: "search_query" | "search_document",
  ): Promise<number[][]> {
    const payload = await this.request(`${this.baseUrl()}/embed`, {
      model: this.settings.model,
      texts,
      input_type: inputType,
      embedding_types: ["float"],
    });
    const embeddings = payload.embeddings as { float?: unknown } | undefined;
    return Array.isArray(embeddings?.float)
      ? embeddings.float.map(toVector)
      : [];
  }

  private async embedOllama(input: string[]): Promise<number[][]> {
    const payload = await this.request(`${this.baseUrl()}/api/embed`, {
      model: this.settings.model,
      input,
    });
    return Array.isArray(payload.embeddings)
      ? payload.embeddings.map(toVector)
      : [];
  }

  private async request(
    url: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.settings.apiKey) {
      headers.Authorization = `Bearer ${this.settings.apiKey}`;
    }
    const response = await fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify(body),
      },
      EMBEDDING_TIMEOUT_MS,
    );
    const payload = asRecord(await response.json());
    if (!response.ok) {
      const error = asRecord(payload.error);
      throw new Error(
        String(
          error.message ||
            payload.message ||
            `语义定位服务 HTTP ${response.status}`,
        ),
      );
    }
    return payload;
  }

  private baseUrl(): string {
    const definition = semanticProviderDefinition(this.settings.provider);
    return normalizeServiceBaseUrl(this.settings.baseUrl, {
      allowLoopbackHttp: definition.kind === "ollama",
      label: "语义定位 Base URL",
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toVector(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isFinite);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return Number.NaN;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (!leftNorm || !rightNorm) return Number.NaN;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
