import {
  extractJsonObject,
  filterOutlineToKnownAnchors,
  normalizeSectionGuide,
} from "../core/llmResponses";
import type {
  AnchorChunk,
  AnnotationContext,
  ProviderSettings,
  ReadingOutline,
  ReadingOutlineSection,
  SectionGuide,
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
    return filterOutlineToKnownAnchors(outline, input.anchors);
  }

  async generateSectionGuide(input: {
    title: string;
    section: ReadingOutlineSection;
    anchors: AnchorChunk[];
  }): Promise<SectionGuide> {
    const scopedAnchors = getScopedSectionAnchors(input.section, input.anchors);
    if (scopedAnchors.length === 0) {
      throw new Error("当前章节没有可用的原文锚点，无法生成可追溯精读。");
    }

    const response = await this.complete({
      system:
        "你是严谨的中文学术论文精读助手。只输出 JSON。每个要点必须是原子化陈述，并附带源语言逐字原文引文；禁止无证据内容、Markdown、外部知识和重复表述。",
      user: buildSectionPrompt(input.title, input.section, scopedAnchors),
      json: true,
    });
    return normalizeSectionGuide(
      extractJsonObject<unknown>(response),
      scopedAnchors,
      input.section.title,
    );
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

export function buildOutlinePrompt(
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
        {
          "claim": "要点",
          "evidence": [
            {"anchorId": "chunk_0001", "quote": "从锚点 text 复制的源语言逐字原文引文"}
          ]
        }
      ]
    }
  ]
}

要求：
1. 每个 bullet 必须有 evidence；每条 evidence 的 anchorId 只能使用已提供的 id。
2. quote 必须从对应锚点 text 中连续逐字复制，保留原文语言，不能翻译、改写、拼接或使用省略号。
3. quote 建议为 8 至 35 个英文词或 12 至 80 个中文字符，必须足以唯一定位该 claim。
4. claim 可以用中文解释，但必须严格受 evidence 支持；无法提供逐字引文的 claim 不得输出。
5. 优先覆盖未被用户批注过的重要章节。
6. 页数较多时只做 section 级摘要，不展开逐段精读。`;
}

export function buildSectionPrompt(
  title: string,
  section: ReadingOutlineSection,
  scopedAnchors: AnchorChunk[],
): string {
  const compactAnchors = scopedAnchors.map((anchor) => ({
    id: anchor.id,
    type: anchor.type,
    page: anchor.pageNumber,
    section: anchor.sectionPath.join(" > "),
    text: truncate(anchor.text, 1200),
  }));

  return `论文标题：${title}
当前章节：${section.title}
章节大纲：${JSON.stringify(section, null, 2)}
可引用锚点：${JSON.stringify(compactAnchors, null, 2)}

请输出以下结构的 JSON 对象：
{
  "title": "简洁的中文章节标题",
  "points": [
    {
      "category": "fact | mechanism | judgment | caution",
      "text": "一条可独立阅读的中文原子化要点",
      "evidence": [
        {"anchorId": "chunk_0001", "quote": "从该锚点 text 连续复制的源语言逐字引文"}
      ]
    }
  ]
}

硬性要求：
1. 生成 6 至 14 条要点；证据不足时可以更少，但不能为凑数扩写。
2. 每条只表达一个事实、机制、作者判断或局限，建议 35 至 120 个中文字符。
3. 每条必须有 1 至 3 条 evidence，anchorId 只能来自“可引用锚点”。
4. 每个 quote 必须从对应锚点 text 中连续逐字复制，保留源语言，不得翻译、改写、跨段拼接或使用省略号；建议为 8 至 35 个英文词或 12 至 80 个中文字符。
5. fact 必须由原文直接陈述；mechanism 必须有原文机制或论证链依据；judgment 只表达作者的判断；caution 只表达原文限制、条件或证据边界。
6. 不要输出无原文依据的背景知识、建议、过渡段、总结段或模型推测。
7. 不要输出 Markdown、锚点占位符、列表符号、粗体标记或 JSON 之外的文字。
8. 不要重复同一结论；优先选择能让读者理解本节研究问题、方法、关键结果和边界的内容。`;
}

function getScopedSectionAnchors(
  section: ReadingOutlineSection,
  anchors: AnchorChunk[],
): AnchorChunk[] {
  const sectionAnchorIds = new Set([
    ...(section.anchorIds || []),
    ...section.bullets.flatMap((bullet) => bullet.anchorIds),
  ]);
  return anchors
    .filter((anchor) => sectionAnchorIds.has(anchor.id))
    .slice(0, 80);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
