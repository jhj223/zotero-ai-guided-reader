import type { AnchorChunk, VisualEvidenceReference } from "./types";

type VisualAnchor = AnchorChunk & {
  type: "equation" | "table" | "image";
};

const VISUAL_TYPES = new Set<AnchorChunk["type"]>([
  "equation",
  "table",
  "image",
]);
const MAX_VISUAL_EVIDENCE = 3;

export function isVisualAnchor(
  anchor: AnchorChunk | undefined,
): anchor is VisualAnchor {
  return Boolean(anchor && VISUAL_TYPES.has(anchor.type));
}

export function normalizeVisualEvidence(
  value: unknown,
  anchorById: Map<string, AnchorChunk>,
): VisualEvidenceReference[] {
  if (!Array.isArray(value)) return [];

  const result: VisualEvidenceReference[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "anchorId") ||
      typeof record.anchorId !== "string"
    ) {
      continue;
    }

    const anchorId = record.anchorId.trim();
    const anchor = anchorById.get(anchorId);
    if (
      !anchorId ||
      seen.has(anchorId) ||
      !isVisualAnchor(anchor) ||
      !visualEvidenceNumber(anchor)
    ) {
      continue;
    }

    result.push({ anchorId });
    seen.add(anchorId);
    if (result.length >= MAX_VISUAL_EVIDENCE) break;
  }

  return result;
}

export function requiresVisualEvidence(text: string): boolean {
  return /(?:\b(?:Fig(?:ure)?\.?|Table|Equation|Eq\.?)\s*\(?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*\)?|(?:图|表)\s*[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*|如图|由表|公式\s*\(?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*\)?)/iu.test(
    text,
  );
}

export function visualEvidenceLabel(anchor: AnchorChunk): string {
  const number = visualEvidenceNumber(anchor);
  if (anchor.type === "image") {
    return number ? `图 ${number}` : "图表";
  }
  if (anchor.type === "table") {
    return number ? `表 ${number}` : "表格";
  }
  return number ? `公式 ${number}` : "公式";
}

export function visualEvidenceNumber(anchor: AnchorChunk): string | undefined {
  const sourceParts = [
    anchor.richContent?.caption,
    anchor.richContent?.description,
    anchor.text,
  ].filter((value): value is string => Boolean(value));
  const source = sourceParts.join(" ");

  if (anchor.type === "image") {
    const hasSubfigurePrefix = sourceParts.some((value) =>
      /^\s*(?:\([A-Za-z0-9]+\)|（[A-Za-z0-9]+）)/u.test(value),
    );
    const hasStandaloneFigureCaption = sourceParts.some((value) =>
      /^\s*(?:图|Figure|Fig\.?)\s*[A-Za-z0-9]/iu.test(value),
    );
    if (hasSubfigurePrefix && !hasStandaloneFigureCaption) {
      return undefined;
    }
    const match = source.match(
      /(?:图|Figure|Fig\.?)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)?)/iu,
    );
    return match?.[1];
  }

  if (anchor.type === "table") {
    const match = source.match(
      /(?:表|Table)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)?)/iu,
    );
    return match?.[1];
  }

  const explicit = source.match(
    /(?:公式|Equation|Eq\.?)\s*\(?([A-Za-z0-9.-]+)\)?/iu,
  );
  const trailing = source.match(/\(([0-9]+(?:\.[0-9]+)?)\)\s*$/u);
  return explicit?.[1] || trailing?.[1];
}
