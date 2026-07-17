import {
  extractJsonObject,
  filterOutlineToKnownAnchors,
} from "../core/llmResponses";
import type {
  AnchorChunk,
  AnnotationContext,
  ProviderSettings,
  ReadingOutline,
  ReadingOutlineSection,
} from "../core/types";
import { LLM_PROVIDERS } from "../core/settings";

export class LLMClient {
  constructor(private readonly settings: ProviderSettings) {}

  async generateOutline(input: {
    title: string;
    anchors: AnchorChunk[];
    annotations: AnnotationContext[];
  }): Promise<ReadingOutline> {
    const response = await this.complete({
      system:
        "你是严谨的中文学术论文带读助手。只根据提供的论文结构和锚点写作，不编造外部事实。",
      user: buildOutlinePrompt(input.title, input.anchors, input.annotations),
      json: true,
    });
    const outline = extractJsonObject<ReadingOutline>(response);
    return filterOutlineToKnownAnchors(
      outline,
      new Set(input.anchors.map((anchor) => anchor.id)),
    );
  }

  async generateSectionGuide(input: {
    title: string;
    section: ReadingOutlineSection;
    anchors: AnchorChunk[];
  }): Promise<string> {
    return this.complete({
      system:
        "你是中文学术论文带读助手。每个关键论述必须引用给定锚点占位符，格式必须是 [[ANCHOR:chunk_0001]]。",
      user: buildSectionPrompt(input.title, input.section, input.anchors),
      json: false,
    });
  }

  private async complete(input: {
    system: string;
    user: string;
    json: boolean;
  }): Promise<string> {
    if (!this.settings.llmApiKey.trim()) {
      throw new Error("LLM API Key is not configured.");
    }

    if (this.settings.llmProvider === "anthropic") {
      return this.completeAnthropic(input);
    }
    return this.completeOpenAICompatible(input);
  }

  private async completeAnthropic(input: {
    system: string;
    user: string;
  }): Promise<string> {
    const baseUrl = this.settings.baseUrl || LLM_PROVIDERS.anthropic.baseUrl!;
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.settings.llmApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.settings.model || LLM_PROVIDERS.anthropic.defaultModel,
        max_tokens: 4096,
        temperature: 0.2,
        system: input.system,
        messages: [{ role: "user", content: input.user }],
      }),
    });
    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(
        payload.error?.message || `Anthropic HTTP ${response.status}`,
      );
    }
    return payload.content?.map((part) => part.text || "").join("") || "";
  }

  private async completeOpenAICompatible(input: {
    system: string;
    user: string;
    json: boolean;
  }): Promise<string> {
    const provider = LLM_PROVIDERS[this.settings.llmProvider];
    const baseUrl = this.settings.baseUrl || provider.baseUrl || "";
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.llmApiKey}`,
        },
        body: JSON.stringify({
          model: this.settings.model || provider.defaultModel,
          temperature: 0.2,
          response_format: input.json ? { type: "json_object" } : undefined,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
      },
    );
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(payload.error?.message || `LLM HTTP ${response.status}`);
    }
    return payload.choices?.[0]?.message?.content || "";
  }
}

function buildOutlinePrompt(
  title: string,
  anchors: AnchorChunk[],
  annotations: AnnotationContext[],
): string {
  const compactAnchors = anchors.slice(0, 120).map((anchor) => ({
    id: anchor.id,
    type: anchor.type,
    page: anchor.pageNumber,
    section: anchor.sectionPath.join(" > "),
    text: truncate(anchor.text, 700),
  }));
  return `论文标题：${title}

已解析锚点（按阅读顺序，MinerU page_idx 已转成用户可见页码）：
${JSON.stringify(compactAnchors, null, 2)}

用户已有批注/高亮（这些区域降低展开优先级，必要时标注“你已关注过”）：
${JSON.stringify(annotations.slice(0, 50), null, 2)}

请先生成结构化大纲 JSON，不要写正文。格式：
{
  "title": "中文导读标题",
  "sections": [
    {
      "title": "章节名",
      "anchorIds": ["chunk_0001"],
      "bullets": [
        {"claim": "要点", "anchorIds": ["chunk_0001", "chunk_0002"]}
      ]
    }
  ]
}

要求：
1. 只能引用已提供的 anchor id。
2. 每个 bullet 至少有一个 anchorIds。
3. 优先覆盖未被用户批注过的重要章节。
4. 页数较多时只做 section 级摘要，不展开逐段精读。`;
}

function buildSectionPrompt(
  title: string,
  section: ReadingOutlineSection,
  anchors: AnchorChunk[],
): string {
  const sectionAnchorIds = new Set([
    ...(section.anchorIds || []),
    ...section.bullets.flatMap((bullet) => bullet.anchorIds),
  ]);
  const scopedAnchors = anchors
    .filter((anchor) => sectionAnchorIds.has(anchor.id))
    .slice(0, 80)
    .map((anchor) => ({
      id: anchor.id,
      type: anchor.type,
      page: anchor.pageNumber,
      section: anchor.sectionPath.join(" > "),
      text: truncate(anchor.text, 1200),
    }));

  return `论文标题：${title}
当前章节：${section.title}
章节大纲：${JSON.stringify(section, null, 2)}
可引用锚点：${JSON.stringify(scopedAnchors, null, 2)}

请生成中文“带读”正文，面向正在阅读论文 PDF 的用户。要求：
1. 解释研究问题、方法、关键假设、论证链条和局限。
2. 每个关键论述后都插入对应锚点占位符，例如 [[ANCHOR:chunk_0042]]。
3. 不要引用不存在的锚点，不要编造论文外信息。
4. 输出 Markdown 文本，不要输出 JSON。
5. 语气清晰、学术、中文。`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
