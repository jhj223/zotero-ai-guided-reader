import { quoteMatchesSource } from "./textQuote";
import {
  normalizeVisualEvidence,
  requiresVisualEvidence,
} from "./visualEvidence";
import type {
  AnchorChunk,
  EvidenceReference,
  ReadingOutline,
  SectionGuide,
  SectionGuideCategory,
} from "./types";

const GUIDE_CATEGORIES = new Set<SectionGuideCategory>([
  "fact",
  "mechanism",
  "judgment",
  "caution",
]);

const GUIDE_CATEGORY_LABELS: Record<SectionGuideCategory, string> = {
  fact: "原文事实",
  mechanism: "机制与逻辑",
  judgment: "作者判断",
  caution: "边界与局限",
};

export function extractJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    }
    throw new Error("LLM 响应中没有有效 JSON 对象。");
  }
}

export function filterOutlineToKnownAnchors(
  outline: ReadingOutline,
  anchors: AnchorChunk[],
): ReadingOutline {
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const rawSections = Array.isArray(outline.sections) ? outline.sections : [];
  return {
    title:
      typeof outline.title === "string" && outline.title.trim()
        ? cleanGuideText(outline.title)
        : "论文导读",
    sections: rawSections
      .map((section) => {
        const rawBullets = Array.isArray(section.bullets)
          ? section.bullets
          : [];
        const bullets = rawBullets
          .map((bullet) => {
            const evidence = normalizeEvidence(bullet.evidence, anchorById);
            const claim = cleanGuideText(bullet.claim || "");
            const visualEvidence = normalizeVisualEvidence(
              bullet.visualEvidence,
              anchorById,
            );
            if (
              !claim ||
              evidence.length === 0 ||
              (requiresVisualEvidence(claim) && visualEvidence.length === 0)
            ) {
              return undefined;
            }
            return {
              claim,
              anchorIds: [
                ...new Set([
                  ...evidence.map((item) => item.anchorId),
                  ...visualEvidence.map((item) => item.anchorId),
                ]),
              ],
              evidence,
              ...(visualEvidence.length > 0 ? { visualEvidence } : {}),
            };
          })
          .filter((bullet): bullet is NonNullable<typeof bullet> =>
            Boolean(bullet),
          );
        if (bullets.length === 0) return undefined;
        const anchorIds = [
          ...new Set([
            ...(Array.isArray(section.anchorIds)
              ? section.anchorIds.filter((id) => anchorById.has(id))
              : []),
            ...bullets.flatMap((bullet) => bullet.anchorIds),
          ]),
        ];
        return {
          title: cleanGuideText(section.title || "") || "未命名章节",
          anchorIds,
          bullets,
        };
      })
      .filter((section): section is NonNullable<typeof section> =>
        Boolean(section),
      ),
  };
}

export function normalizeSectionGuide(
  value: unknown,
  anchors: AnchorChunk[],
  fallbackTitle: string,
): SectionGuide {
  const candidate = isRecord(value) ? value : {};
  const rawPoints = Array.isArray(candidate.points) ? candidate.points : [];
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const points: SectionGuide["points"] = [];
  const seenTexts = new Set<string>();

  for (const rawPoint of rawPoints) {
    if (!isRecord(rawPoint) || typeof rawPoint.text !== "string") continue;
    const text = cleanGuideText(rawPoint.text);
    if (!text) continue;
    const dedupeKey = text
      .replace(/\s+/g, "")
      .replace(/[.!?。！？]+$/gu, "")
      .toLocaleLowerCase();
    if (seenTexts.has(dedupeKey)) continue;
    const evidence = normalizeEvidence(rawPoint.evidence, anchorById);
    const visualEvidence = normalizeVisualEvidence(
      rawPoint.visualEvidence,
      anchorById,
    );
    if (
      evidence.length === 0 ||
      (requiresVisualEvidence(text) && visualEvidence.length === 0)
    ) {
      continue;
    }
    const category = GUIDE_CATEGORIES.has(
      rawPoint.category as SectionGuideCategory,
    )
      ? (rawPoint.category as SectionGuideCategory)
      : "fact";
    points.push({
      category,
      text,
      evidence,
      ...(visualEvidence.length > 0 ? { visualEvidence } : {}),
    });
    seenTexts.add(dedupeKey);
    if (points.length >= 18) break;
  }

  if (points.length === 0) {
    throw new Error(
      "模型未返回带逐字原文 evidence quote 的可追溯内容，请重试。",
    );
  }
  return {
    title:
      cleanGuideText(
        typeof candidate.title === "string" ? candidate.title : fallbackTitle,
      ) || fallbackTitle,
    points,
  };
}

export function sectionGuideToMarkdown(guide: SectionGuide): string {
  const groups = [...GUIDE_CATEGORIES].map((category) => ({
    category,
    points: guide.points.filter((point) => point.category === category),
  }));
  return [
    `## ${guide.title}`,
    ...groups
      .filter((group) => group.points.length > 0)
      .flatMap((group) => [
        `### ${GUIDE_CATEGORY_LABELS[group.category]}`,
        ...group.points.map((point) => {
          const anchorIds = [
            ...new Set([
              ...point.evidence.map((item) => item.anchorId),
              ...(point.visualEvidence || []).map((item) => item.anchorId),
            ]),
          ];
          return `- ${point.text} ${anchorIds
            .map((anchorId) => `[[ANCHOR:${anchorId}]]`)
            .join(" ")}`;
        }),
      ]),
  ].join("\n\n");
}

function normalizeEvidence(
  value: unknown,
  anchorById: Map<string, AnchorChunk>,
): EvidenceReference[] {
  if (!Array.isArray(value)) return [];
  const evidence: EvidenceReference[] = [];
  const seen = new Set<string>();
  for (const rawItem of value) {
    if (
      !isRecord(rawItem) ||
      typeof rawItem.anchorId !== "string" ||
      typeof rawItem.quote !== "string"
    ) {
      continue;
    }
    const anchor = anchorById.get(rawItem.anchorId);
    const quote = rawItem.quote.trim();
    if (!anchor || !quoteMatchesSource(anchor.text, quote)) continue;
    const key = `${anchor.id}\u0000${quote.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    evidence.push({ anchorId: anchor.id, quote });
    seen.add(key);
    if (evidence.length >= 3) break;
  }
  return evidence;
}

function cleanGuideText(text: string): string {
  return text
    .replace(/\[\[ANCHOR:[^\]]+\]\]/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*#>]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
