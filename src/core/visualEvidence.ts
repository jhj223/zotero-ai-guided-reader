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
    if (
      !anchorId ||
      seen.has(anchorId) ||
      !isVisualAnchor(anchorById.get(anchorId))
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
  const source = [
    anchor.richContent?.caption,
    anchor.richContent?.description,
    anchor.text,
  ]
    .filter(Boolean)
    .join(" ");

  if (anchor.type === "image") {
    const match = source.match(
      /(?:图|Figure|Fig\.?)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)?)/iu,
    );
    return match ? `图 ${match[1]}` : "图表";
  }

  if (anchor.type === "table") {
    const match = source.match(
      /(?:表|Table)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)?)/iu,
    );
    return match ? `表 ${match[1]}` : "表格";
  }

  const explicit = source.match(
    /(?:公式|Equation|Eq\.?)\s*\(?([A-Za-z0-9.-]+)\)?/iu,
  );
  const trailing = source.match(/\(([0-9]+(?:\.[0-9]+)?)\)\s*$/u);
  const number = explicit?.[1] || trailing?.[1];
  return number ? `公式 ${number}` : "公式";
}
