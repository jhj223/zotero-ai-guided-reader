export type LLMProviderId =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "qwen"
  | "volcengine"
  | "siliconflow"
  | "codex-cli"
  | "claude-cli";

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
export type BBoxSpace = "normalized-1000" | "page-points";

export interface AnchorRichContent {
  latex?: string;
  tableHtml?: string;
  caption?: string;
  description?: string;
  assetName?: string;
}

export interface AnchorChunk {
  id: string;
  type: AnchorType;
  pageIndex: number;
  pageNumber: number;
  bbox?: BBox;
  bboxSpace?: BBoxSpace;
  text: string;
  sectionPath: string[];
  richContent?: AnchorRichContent;
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

export interface EvidenceReference {
  anchorId: string;
  quote: string;
}

export interface VisualEvidenceReference {
  anchorId: string;
}

export interface OutlineBullet {
  claim: string;
  anchorIds: string[];
  evidence: EvidenceReference[];
  visualEvidence?: VisualEvidenceReference[];
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

export type SectionGuideCategory =
  | "fact"
  | "mechanism"
  | "judgment"
  | "caution";

export interface SectionGuidePoint {
  category: SectionGuideCategory;
  text: string;
  evidence: EvidenceReference[];
  visualEvidence?: VisualEvidenceReference[];
}

export interface SectionGuide {
  title: string;
  points: SectionGuidePoint[];
}

export interface AnnotationContext {
  text: string;
  comment?: string;
  pageLabel?: string;
  color?: string;
}
