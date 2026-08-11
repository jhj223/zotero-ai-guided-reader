import {
  extractJsonObject,
  filterOutlineToKnownAnchors,
  normalizeSectionGuide,
} from "../core/llmResponses";
import { LLM_PROVIDERS } from "../core/settings";
import type {
  AnchorChunk,
  AnnotationContext,
  ProviderSettings,
  ReadingOutline,
  ReadingOutlineSection,
  SectionGuide,
} from "../core/types";
import { runLocalCli } from "./localCliRunner";
import {
  ensureApiVersionBaseUrl,
  fetchWithTimeout,
  normalizeServiceBaseUrl,
  type FetchLike,
} from "./networkSafety";

const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;

export class LLMClient {
  constructor(
    private readonly settings: ProviderSettings,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generateOutline(input: {
    title: string;
    anchors: AnchorChunk[];
    annotations: AnnotationContext[];
  }): Promise<ReadingOutline> {
    const response = await this.complete({
      system:
        "你是严谨的中文学术论文带读助手。只能根据给定论文锚点写作，不得补充外部事实。只输出有效 JSON。",
      user: buildOutlinePrompt(input.title, input.anchors, input.annotations),
      json: true,
    });
    return filterOutlineToKnownAnchors(
      extractJsonObject<ReadingOutline>(response),
      input.anchors,
    );
  }

  async generateSectionGuide(input: {
    title: string;
    section: ReadingOutlineSection;
    anchors: AnchorChunk[];
  }): Promise<SectionGuide> {
    const scopedAnchors = getScopedSectionAnchors(input.section, input.anchors);
    if (scopedAnchors.length === 0) {
      throw new Error("当前章节没有可用原文锚点，无法生成可追溯精读。");
    }

    const response = await this.complete({
      system:
        "你是严谨的中文论文精读助手。每个论述必须附带逐字原文证据；不得输出无证据内容、外部知识或 Markdown。只输出有效 JSON。",
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
    if (
      this.settings.llmProvider === "codex-cli" ||
      this.settings.llmProvider === "claude-cli"
    ) {
      return runLocalCli({
        provider: this.settings.llmProvider,
        model: this.settings.model,
        system: input.system,
        user: input.user,
      });
    }
    if (!this.settings.llmApiKey.trim()) {
      throw new Error("尚未配置 LLM API Key。");
    }
    return this.settings.llmProvider === "anthropic"
      ? this.completeAnthropic(input)
      : this.completeOpenAICompatible(input);
  }

  private async completeAnthropic(input: {
    system: string;
    user: string;
  }): Promise<string> {
    const baseUrl = normalizeServiceBaseUrl(
      this.settings.baseUrl || LLM_PROVIDERS.anthropic.baseUrl!,
      { label: "LLM Base URL" },
    );
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${ensureApiVersionBaseUrl(baseUrl, "v1")}/messages`,
      {
        method: "POST",
        redirect: "error",
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
      },
      GENERATION_TIMEOUT_MS,
    );
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
    const baseUrl = normalizeServiceBaseUrl(
      this.settings.baseUrl || provider.baseUrl || "",
      { label: "LLM Base URL" },
    );
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        redirect: "error",
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
      GENERATION_TIMEOUT_MS,
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
  const compactAnchors = anchors.slice(0, 160).map(compactAnchorForPrompt);
  return `论文标题：${title}

按阅读顺序排列的 MinerU 锚点：
${JSON.stringify(compactAnchors)}

用户已有高亮/批注（相关区域降低展开优先级，必要时标注“你已关注过”）：
${JSON.stringify(annotations.slice(0, 50))}

先生成 section 级结构化大纲，不展开全文。只输出以下 JSON：
{"title":"中文导读标题","sections":[{"title":"章节名","anchorIds":["chunk_0001"],"bullets":[{"claim":"有证据支持的中文要点","evidence":[{"anchorId":"chunk_0001","quote":"从对应 text 连续逐字复制的原文"}],"visualEvidence":[{"anchorId":"chunk_0042"}]}]}]}

规则：
1. 每个 bullet 必须有 1 至 3 条 evidence；同一论述若由多处正文共同支持或在多处重复出现，必须保留所有直接相关位置，不得只返回第一处；anchorId 只能使用给定 id。
2. quote 必须从该锚点 text 连续逐字复制，不得翻译、改写、拼接或使用省略号。
3. 凡 claim 依据图、表或公式生成，除正文 evidence 外，visualEvidence 必须列出直接支持该论述的视觉锚点；其 anchorId 对应 type 必须是 equation、table 或 image。其他 claim 返回空数组。
4. 不得把同章节但与当前 claim 无关的图、表或公式加入 visualEvidence。
5. 每个 section 的 anchorIds 应覆盖该章节后续精读需要的关键正文、公式和图表锚点。
6. 图片只有标题/描述而没有可核实数据时，不得推断图中结论。
7. claim 中出现的样品、配方或缓蚀剂编号，必须在该 claim 选择的直接证据中明确出现；不得根据相邻图片补写缺失编号。
8. 比较、优选、最高/最低或是否达标的结论若来自表格数据，必须引用包含对应行和数值的 table 表格锚点；不得用相邻样品图片代替表格证据。
9. visualEvidence 只引用正文中能识别出图、表或公式编号的完整对象；不得把无编号子图作为独立索引。
10. 原文明确给出最终优选或选择结果时，必须覆盖且不得省略；必须写出直接证据支持的具体编号，不得笼统写“样品、配方或缓蚀剂”。
11. 只输出 JSON。`;
}

export function buildSectionPrompt(
  title: string,
  section: ReadingOutlineSection,
  scopedAnchors: AnchorChunk[],
): string {
  return `论文标题：${title}
当前章节：${section.title}
章节大纲：${JSON.stringify(section)}
可引用锚点：${JSON.stringify(scopedAnchors.map(compactAnchorForPrompt))}

输出 JSON：
{"title":"中文章节标题","points":[{"category":"fact | mechanism | judgment | caution","text":"一条可独立阅读的中文原子化要点，可保留 $...$ 或 $$...$$ LaTeX","evidence":[{"anchorId":"chunk_0001","quote":"从该锚点 text 连续逐字复制的原文"}],"visualEvidence":[{"anchorId":"chunk_0042"}]}]}

规则：
1. 生成 6 至 14 条；证据不足可以更少，不得凑数。
2. 每条只表达一个事实、机制、作者判断或局限，并有 1 至 3 条 evidence；若多处原文共同支撑该论述，必须返回所有直接相关且不重复的位置，不得只取第一处。
3. quote 必须保留源语言并逐字复制，不得翻译、改写、跨段拼接或使用省略号。
4. 凡 text 依据图、表或公式生成，除正文 evidence 外，visualEvidence 必须列出直接支持该论述的视觉锚点；其 anchorId 对应 type 必须是 equation、table 或 image。其他 point 返回空数组。
5. 不得把同章节但与当前 point 无关的图、表或公式加入 visualEvidence。
6. 公式使用锚点 rich.latex 中的 LaTeX；表格仅解释给定 tableHtml；图表仅解释 caption/description 明示内容。
7. text 中出现的样品、配方或缓蚀剂编号，必须在该 point 选择的直接证据中明确出现；不得根据相邻图片补写缺失编号。
8. 比较、优选、最高/最低或是否达标的结论若来自表格数据，必须引用包含对应行和数值的 table 表格锚点；不得用相邻样品图片代替表格证据。
9. visualEvidence 只引用正文中能识别出图、表或公式编号的完整对象；不得把无编号子图作为独立索引。
10. 原文明确给出最终优选或选择结果时，必须覆盖且不得省略；必须写出直接证据支持的具体编号，不得笼统写“样品、配方或缓蚀剂”。
11. 不得输出外部知识、建议、过渡段、模型推测或 JSON 之外的文字。`;
}

function compactAnchorForPrompt(anchor: AnchorChunk) {
  return {
    id: anchor.id,
    type: anchor.type,
    page: anchor.pageNumber,
    section: anchor.sectionPath.join(" > "),
    text: truncate(anchor.text, 1000),
    rich: anchor.richContent
      ? {
          latex: truncate(anchor.richContent.latex || "", 700),
          tableHtml: truncate(anchor.richContent.tableHtml || "", 1400),
          caption: truncate(anchor.richContent.caption || "", 500),
          description: truncate(anchor.richContent.description || "", 700),
        }
      : undefined,
  };
}

function getScopedSectionAnchors(
  section: ReadingOutlineSection,
  anchors: AnchorChunk[],
): AnchorChunk[] {
  const ids = new Set([
    ...(section.anchorIds || []),
    ...section.bullets.flatMap((bullet) => bullet.anchorIds),
  ]);
  return anchors.filter((anchor) => ids.has(anchor.id)).slice(0, 80);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
