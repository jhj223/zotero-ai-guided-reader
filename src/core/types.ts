export type LLMProviderId =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "qwen"
  | "volcengine"
  | "siliconflow";

export type AnchorType =
  | "heading"
  | "text"
  | "equation"
  | "table"
  | "image"
  | "list"
  | "code"
  | "unknown";

export type BBox = [number, number, number, number];

export interface AnchorChunk {
  id: string;
  type: AnchorType;
  pageIndex: number;
  pageNumber: number;
  bbox?: BBox;
  text: string;
  sectionPath: string[];
}

export interface PageSize {
  width: number;
  height: number;
}

export interface NormalizedMinerUOutput {
  anchors: AnchorChunk[];
  markdown?: string;
  sourceFiles: string[];
  pageSizes?: Record<number, PageSize>;
}

export interface MinerUProgress {
  state:
    | "idle"
    | "waiting-file"
    | "pending"
    | "converting"
    | "running"
    | "done"
    | "failed";
  extractedPages?: number;
  totalPages?: number;
  message?: string;
}

export interface ProviderSettings {
  llmProvider: LLMProviderId;
  llmApiKey: string;
  mineruApiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface OutlineBullet {
  claim: string;
  anchorIds: string[];
}

export interface ReadingOutlineSection {
  title: string;
  anchorIds?: string[];
  bullets: OutlineBullet[];
}

export interface ReadingOutline {
  title: string;
  sections: ReadingOutlineSection[];
}

export interface AnnotationContext {
  text: string;
  comment?: string;
  pageLabel?: string;
  color?: string;
}
