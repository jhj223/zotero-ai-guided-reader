import type {
  AnchorChunk,
  AnchorType,
  BBox,
  NormalizedMinerUOutput,
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
    normalizeContentListV2(raw.contentListV2) ??
    normalizeContentList(raw.contentList) ??
    normalizeMiddleJson(raw.middleJson) ??
    [];

  return {
    anchors,
    markdown: raw.markdown,
    sourceFiles: [
      raw.contentListV2 ? "content_list_v2.json" : "",
      raw.contentList ? "content_list.json" : "",
      raw.middleJson ? "middle.json" : "",
      raw.markdown ? "full.md" : "",
    ].filter(Boolean),
  };
}

function normalizeContentList(input: unknown): AnchorChunk[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const state = createChunkState();

  for (const block of input) {
    if (!isRecord(block)) continue;
    const type = String(block.type ?? "unknown");
    if (SKIPPED_TYPES.has(type)) continue;

    const text = textFromLegacyBlock(block).trim();
    if (!text) continue;

    const pageIndex = toPageIndex(block.page_idx);
    const anchorType = mapLegacyType(type, block.text_level);
    state.push({
      type: anchorType,
      pageIndex,
      bbox: toBBox(block.bbox),
      text,
      headingLevel:
        anchorType === "heading" ? toHeadingLevel(block.text_level) : 0,
    });
  }

  return state.anchors;
}

function normalizeContentListV2(input: unknown): AnchorChunk[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const state = createChunkState();

  input.forEach((pageBlocks, pageIndex) => {
    if (!Array.isArray(pageBlocks)) return;
    for (const block of pageBlocks) {
      if (!isRecord(block)) continue;
      const type = String(block.type ?? "unknown");
      if (SKIPPED_TYPES.has(type)) continue;

      const text = textFromV2Block(block).trim();
      if (!text) continue;

      const anchorType = mapV2Type(type);
      const headingLevel =
        type === "title" && isRecord(block.content)
          ? toHeadingLevel(block.content.level)
          : 0;
      state.push({
        type: anchorType,
        pageIndex,
        bbox: toBBox(block.bbox),
        text,
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
        text,
        headingLevel: anchorType === "heading" ? 1 : 0,
      });
    }
  }

  return state.anchors;
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
      text: string;
      headingLevel: number;
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
        text: input.text,
        sectionPath: sectionPath.filter(Boolean),
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
  if (Array.isArray(block.image_caption))
    return joinStringArray(block.image_caption);
  if (Array.isArray(block.list_items)) return joinStringArray(block.list_items);
  if (typeof block.code_body === "string") return block.code_body;
  return "";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
