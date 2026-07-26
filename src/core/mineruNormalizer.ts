import type {
  AnchorChunk,
  AnchorType,
  BBox,
  BBoxSpace,
  AnchorRichContent,
  NormalizedMinerUOutput,
  PageSize,
} from "./types";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PAGES = 200;
const SKIPPED_TYPES = new Set([
  "header",
  "footer",
  "page_header",
  "page_footer",
  "page_number",
  "page_aside_text",
  "aside_text",
]);

export interface MinerURawOutput {
  contentList?: unknown;
  contentListV2?: unknown;
  middleJson?: unknown;
  markdown?: string;
  assetMap?: Record<string, string>;
}

export function validateMinerUInputLimits(input: {
  sizeBytes?: number;
  pageCount?: number;
}): string[] {
  const errors: string[] = [];
  if (input.sizeBytes != null && input.sizeBytes > MAX_FILE_BYTES) {
    errors.push("MinerU precise parsing supports a single file up to 200MB.");
  }
  if (input.pageCount != null && input.pageCount > MAX_PAGES) {
    errors.push("MinerU precise parsing supports documents up to 200 pages.");
  }
  return errors;
}

export function normalizeMinerUOutput(
  raw: MinerURawOutput,
): NormalizedMinerUOutput {
  const anchors =
    normalizeContentListV2(raw.contentListV2, raw.assetMap) ??
    normalizeContentList(raw.contentList, raw.assetMap) ??
    normalizeMiddleJson(raw.middleJson) ??
    [];

  return restoreRichContentFromMarkdown({
    anchors,
    markdown: raw.markdown,
    pageSizes: extractPageSizes(raw.middleJson),
    sourceFiles: [
      raw.contentListV2 ? "content_list_v2.json" : "",
      raw.contentList ? "content_list.json" : "",
      raw.middleJson ? "middle.json" : "",
      raw.markdown ? "full.md" : "",
    ].filter(Boolean),
  });
}

export function restoreRichContentFromMarkdown(
  parsed: NormalizedMinerUOutput,
): NormalizedMinerUOutput {
  if (!parsed.markdown) return parsed;

  const tablesByNumber = extractMarkdownTables(parsed.markdown);
  if (tablesByNumber.size === 0) return parsed;

  let changed = false;
  const anchors = parsed.anchors.map((anchor) => {
    if (anchor.type !== "table" || anchor.richContent?.tableHtml) {
      return anchor;
    }
    const number = visualNumber(anchor.text, "table");
    const tableHtml = number ? tablesByNumber.get(number) : undefined;
    if (!tableHtml) return anchor;

    changed = true;
    return {
      ...anchor,
      richContent: {
        ...anchor.richContent,
        caption: anchor.richContent?.caption || anchor.text,
        tableHtml,
      },
    };
  });

  return changed ? { ...parsed, anchors } : parsed;
}

function normalizeContentList(
  input: unknown,
  assetMap?: Record<string, string>,
): AnchorChunk[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const state = createChunkState();

  for (const block of input) {
    if (!isRecord(block)) continue;
    const type = String(block.type ?? "unknown");
    if (SKIPPED_TYPES.has(type)) continue;

    const pageIndex = toPageIndex(block.page_idx);
    const anchorType = mapLegacyType(type, block.text_level);
    const richContent = richContentFromLegacyBlock(block, assetMap);
    const text =
      textFromLegacyBlock(block).trim() ||
      fallbackRichText(anchorType, richContent);
    if (!text) continue;
    state.push({
      type: anchorType,
      pageIndex,
      bbox: toBBox(block.bbox),
      bboxSpace: "normalized-1000",
      text,
      richContent,
      headingLevel:
        anchorType === "heading" ? toHeadingLevel(block.text_level) : 0,
    });
  }

  return state.anchors;
}

function normalizeContentListV2(
  input: unknown,
  assetMap?: Record<string, string>,
): AnchorChunk[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const state = createChunkState();

  input.forEach((pageBlocks, pageIndex) => {
    if (!Array.isArray(pageBlocks)) return;
    for (const block of pageBlocks) {
      if (!isRecord(block)) continue;
      const type = String(block.type ?? "unknown");
      if (SKIPPED_TYPES.has(type)) continue;

      const anchorType = mapV2Type(type);
      const richContent = richContentFromV2Block(block, assetMap);
      const text =
        textFromV2Block(block).trim() ||
        fallbackRichText(anchorType, richContent);
      if (!text) continue;
      const headingLevel =
        type === "title" && isRecord(block.content)
          ? toHeadingLevel(block.content.level)
          : 0;
      state.push({
        type: anchorType,
        pageIndex,
        bbox: toBBox(block.bbox),
        bboxSpace: "normalized-1000",
        text,
        richContent,
        headingLevel,
      });
    }
  });

  return state.anchors;
}

function normalizeMiddleJson(input: unknown): AnchorChunk[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.pdf_info)) return undefined;
  const state = createChunkState();

  for (const page of input.pdf_info) {
    if (!isRecord(page) || !Array.isArray(page.para_blocks)) continue;
    const pageIndex = toPageIndex(page.page_idx);
    for (const block of page.para_blocks) {
      if (!isRecord(block)) continue;
      const type = String(block.type ?? "unknown");
      if (SKIPPED_TYPES.has(type)) continue;

      const text = textFromLines(block.lines).trim();
      if (!text) continue;

      const anchorType = type === "title" ? "heading" : mapLegacyType(type);
      state.push({
        type: anchorType,
        pageIndex,
        bbox: toBBox(block.bbox),
        bboxSpace: "page-points",
        text,
        headingLevel: anchorType === "heading" ? 1 : 0,
      });
    }
  }

  return state.anchors;
}

function extractPageSizes(
  input: unknown,
): Record<number, PageSize> | undefined {
  if (!isRecord(input) || !Array.isArray(input.pdf_info)) return undefined;
  const sizes: Record<number, PageSize> = {};

  for (const page of input.pdf_info) {
    if (!isRecord(page)) continue;
    const size = page.page_size;
    if (!Array.isArray(size) || size.length !== 2) continue;
    const [width, height] = size.map(Number);
    if (!(width > 0) || !(height > 0)) continue;
    sizes[toPageIndex(page.page_idx)] = { width, height };
  }

  return Object.keys(sizes).length ? sizes : undefined;
}

function createChunkState() {
  const anchors: AnchorChunk[] = [];
  const sectionPath: string[] = [];

  return {
    anchors,
    push(input: {
      type: AnchorType;
      pageIndex: number;
      bbox?: BBox;
      bboxSpace?: BBoxSpace;
      text: string;
      headingLevel: number;
      richContent?: AnchorRichContent;
    }) {
      if (input.headingLevel > 0) {
        sectionPath.splice(input.headingLevel - 1);
        sectionPath[input.headingLevel - 1] = input.text;
      }

      const id = `chunk_${String(anchors.length + 1).padStart(4, "0")}`;
      anchors.push({
        id,
        type: input.type,
        pageIndex: input.pageIndex,
        pageNumber: input.pageIndex + 1,
        bbox: input.bbox,
        ...(input.bboxSpace ? { bboxSpace: input.bboxSpace } : {}),
        text: input.text,
        sectionPath: sectionPath.filter(Boolean),
        ...(input.richContent ? { richContent: input.richContent } : {}),
      });
    },
  };
}

function textFromLegacyBlock(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return block.text;
  if (
    Array.isArray(block.table_caption) ||
    typeof block.table_body === "string"
  ) {
    return [joinStringArray(block.table_caption), block.table_body]
      .filter(Boolean)
      .join("\n");
  }
  if (
    Array.isArray(block.image_caption) ||
    Array.isArray(block.chart_caption)
  ) {
    return [
      joinStringArray(block.image_caption),
      joinStringArray(block.chart_caption),
      joinStringArray(block.image_description),
      joinStringArray(block.chart_description),
      typeof block.content === "string" ? block.content : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(block.list_items)) return joinStringArray(block.list_items);
  if (typeof block.code_body === "string") return block.code_body;
  return "";
}

function richContentFromLegacyBlock(
  block: Record<string, unknown>,
  assetMap?: Record<string, string>,
): AnchorRichContent | undefined {
  const type = String(block.type ?? "unknown");
  const caption = [
    joinStringArray(block.table_caption),
    joinStringArray(block.image_caption),
    joinStringArray(block.chart_caption),
  ]
    .filter(Boolean)
    .join("\n");
  const description = [
    joinStringArray(block.image_description),
    joinStringArray(block.chart_description),
    typeof block.content === "string" ? block.content : "",
  ]
    .filter(Boolean)
    .join("\n");
  const rich = compactRichContent({
    latex:
      type === "equation" || type === "interline_equation"
        ? stripMathDelimiters(typeof block.text === "string" ? block.text : "")
        : undefined,
    tableHtml:
      type === "table" && typeof block.table_body === "string"
        ? block.table_body
        : undefined,
    caption: caption || undefined,
    description: description || undefined,
    assetName: resolveAssetName(block.img_path, assetMap),
  });
  return hasRichContent(rich) ? rich : undefined;
}

function richContentFromV2Block(
  block: Record<string, unknown>,
  assetMap?: Record<string, string>,
): AnchorRichContent | undefined {
  const content = isRecord(block.content) ? block.content : {};
  const type = String(block.type ?? "unknown");
  const rich = compactRichContent({
    latex: type.includes("equation")
      ? stripMathDelimiters(inlineContentToText(content.math_content))
      : undefined,
    tableHtml:
      type === "table" ? inlineContentToText(content.table_body) : undefined,
    caption:
      [
        inlineContentToText(content.table_caption),
        inlineContentToText(content.image_caption),
        inlineContentToText(content.chart_caption),
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    description:
      [
        inlineContentToText(content.image_description),
        inlineContentToText(content.chart_description),
        inlineContentToText(content.chart_content),
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    assetName: resolveAssetName(
      block.img_path ??
        block.image_path ??
        content.img_path ??
        content.image_path,
      assetMap,
    ),
  });
  return hasRichContent(rich) ? rich : undefined;
}

function fallbackRichText(
  type: AnchorType,
  rich: AnchorRichContent | undefined,
): string {
  if (!rich) return "";
  if (rich.caption) return rich.caption;
  if (rich.description) return rich.description;
  if (rich.latex) return rich.latex;
  if (type === "table") return "[Table without extractable text]";
  if (type === "image" && rich.assetName) {
    return "[Image without extractable caption]";
  }
  return "";
}

function resolveAssetName(
  value: unknown,
  assetMap?: Record<string, string>,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return assetMap?.[normalized] ?? assetMap?.[value];
}

function stripMathDelimiters(value: string): string {
  return value
    .trim()
    .replace(/^\$\$\s*/, "")
    .replace(/\s*\$\$$/, "")
    .replace(/^\$\s*/, "")
    .replace(/\s*\$$/, "")
    .trim();
}

function hasRichContent(value: AnchorRichContent): boolean {
  return Object.values(value).some(Boolean);
}

function compactRichContent(value: AnchorRichContent): AnchorRichContent {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => Boolean(entry[1])),
  ) as AnchorRichContent;
}

function textFromV2Block(block: Record<string, unknown>): string {
  const content = block.content;
  if (!isRecord(content)) return "";
  const keys = [
    "title_content",
    "paragraph_content",
    "math_content",
    "table_caption",
    "table_body",
    "image_caption",
    "chart_caption",
    "code_content",
    "algorithm_content",
    "list_items",
  ];

  return keys
    .map((key) => inlineContentToText(content[key]))
    .filter(Boolean)
    .join("\n");
}

function inlineContentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (!isRecord(entry)) return "";
        if (typeof entry.content === "string") return entry.content;
        if (Array.isArray(entry.children))
          return inlineContentToText(entry.children);
        return "";
      })
      .join("");
  }
  return "";
}

function textFromLines(lines: unknown): string {
  if (!Array.isArray(lines)) return "";
  return lines
    .map((line) => {
      if (!isRecord(line) || !Array.isArray(line.spans)) return "";
      return line.spans
        .map((span) => {
          if (!isRecord(span)) return "";
          return typeof span.content === "string" ? span.content : "";
        })
        .join("");
    })
    .join("\n");
}

function mapLegacyType(type: string, textLevel?: unknown): AnchorType {
  if (type === "text" && toHeadingLevel(textLevel) > 0) return "heading";
  if (type === "title") return "heading";
  if (type === "equation" || type === "interline_equation") return "equation";
  if (type === "table") return "table";
  if (type === "image" || type === "chart") return "image";
  if (type === "list" || type === "index") return "list";
  if (type === "code" || type === "algorithm") return "code";
  if (type === "text") return "text";
  return "unknown";
}

function mapV2Type(type: string): AnchorType {
  if (type === "title") return "heading";
  if (type === "paragraph") return "text";
  if (type === "equation_interline") return "equation";
  if (type === "table") return "table";
  if (type === "image" || type === "chart") return "image";
  if (type === "list" || type === "index") return "list";
  if (type === "code" || type === "algorithm") return "code";
  return "unknown";
}

function toHeadingLevel(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? Math.max(1, Math.floor(numberValue))
    : 0;
}

function toPageIndex(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? Math.floor(numberValue)
    : 0;
}

function toBBox(value: unknown): BBox | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const numbers = value.map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return undefined;
  return numbers as BBox;
}

function joinStringArray(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((entry) => typeof entry === "string").join("\n");
}

function extractMarkdownTables(markdown: string): Map<string, string> {
  const tables = new Map<string, string>();
  for (const match of markdown.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/giu)) {
    const start = match.index ?? 0;
    const context = markdown.slice(Math.max(0, start - 1000), start);
    const captions = [
      ...context.matchAll(
        /(?:^|\n)\s*(?:表|Table)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)[^\n]*/gimu,
      ),
    ];
    const number = captions.at(-1)?.[1]?.toLocaleLowerCase();
    if (number) tables.set(number, match[0]);
  }
  return tables;
}

function visualNumber(
  source: string,
  type: "table" | "image",
): string | undefined {
  const pattern =
    type === "table"
      ? /(?:表|Table)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)/iu
      : /(?:图|Figure|Fig\.?)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)/iu;
  return source.match(pattern)?.[1]?.toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
