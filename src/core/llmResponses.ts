import {
  normalizeForQuoteMatch,
  quoteMatchesSource,
  toVisibleSourceText,
} from "./textQuote";
import { tableHtmlToRows } from "./tableHtml";
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

interface GroundableStatement {
  text: string;
  evidence: EvidenceReference[];
  visualEvidence: Array<{ anchorId: string }>;
}

interface TableEntitySupport {
  entity: string;
  tableAnchorId: string;
  metric: string;
  evidence: EvidenceReference[];
}

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
  const filteredOutline = {
    title:
      typeof outline.title === "string" && outline.title.trim()
        ? cleanGuideText(outline.title)
        : "论文导读",
    sections: rawSections
      .map((section) => {
        const rawBullets = Array.isArray(section.bullets)
          ? section.bullets
          : [];
        const prepared = rawBullets
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
            return { text: claim, evidence, visualEvidence };
          })
          .filter((bullet): bullet is NonNullable<typeof bullet> =>
            Boolean(bullet),
          );
        const bullets = restoreOmittedNumberedEntities(prepared, anchorById)
          .map(({ text: claim, evidence, visualEvidence }) => {
            if (
              !numberedEntitiesAreGrounded(
                claim,
                evidence,
                visualEvidence,
                anchorById,
              )
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
  return addOmittedTableBackedSelections(filteredOutline, anchors, anchorById);
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

  const preparedPoints = rawPoints
    .map((rawPoint) => {
      if (!isRecord(rawPoint) || typeof rawPoint.text !== "string") {
        return undefined;
      }
      const text = cleanGuideText(rawPoint.text);
      if (!text) return undefined;
      const evidence = normalizeEvidence(rawPoint.evidence, anchorById);
      const visualEvidence = normalizeVisualEvidence(
        rawPoint.visualEvidence,
        anchorById,
      );
      if (
        evidence.length === 0 ||
        (requiresVisualEvidence(text) && visualEvidence.length === 0)
      ) {
        return undefined;
      }
      const category = GUIDE_CATEGORIES.has(
        rawPoint.category as SectionGuideCategory,
      )
        ? (rawPoint.category as SectionGuideCategory)
        : "fact";
      return { text, evidence, visualEvidence, category };
    })
    .filter((point): point is NonNullable<typeof point> => Boolean(point));

  for (const point of restoreOmittedNumberedEntities(
    preparedPoints,
    anchorById,
  )) {
    const { text, evidence, visualEvidence, category } = point;
    if (
      !numberedEntitiesAreGrounded(text, evidence, visualEvidence, anchorById)
    ) {
      continue;
    }
    const dedupeKey = text
      .replace(/\s+/g, "")
      .replace(/[.!?。！？]+$/gu, "")
      .toLocaleLowerCase();
    if (seenTexts.has(dedupeKey)) continue;
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

function addOmittedTableBackedSelections(
  outline: ReadingOutline,
  anchors: AnchorChunk[],
  anchorById: Map<string, AnchorChunk>,
): ReadingOutline {
  const { sections } = outline;
  for (const textAnchor of anchors) {
    if (!["text", "list"].includes(textAnchor.type)) continue;
    const selection = /选择\s*缓蚀剂(?!\s*[0-9])\s*作为/u.exec(textAnchor.text);
    if (selection?.index === undefined) continue;

    const metric = decimalMetrics(textAnchor.text.slice(0, selection.index)).at(
      -1,
    );
    if (!metric) continue;
    const metricQuote = textAnchor.text
      .slice(Math.max(0, selection.index - 200), selection.index)
      .trim();
    const selectionQuote = textAnchor.text
      .slice(selection.index, selection.index + 120)
      .trim();
    const evidence = [
      { anchorId: textAnchor.id, quote: metricQuote },
      { anchorId: textAnchor.id, quote: selectionQuote },
    ];
    const matches = anchors.flatMap((tableAnchor) => {
      if (
        tableAnchor.type !== "table" ||
        tableAnchor.pageNumber !== textAnchor.pageNumber ||
        !sections.some(
          (section) =>
            section.anchorIds?.includes(textAnchor.id) &&
            section.anchorIds.includes(tableAnchor.id),
        ) ||
        normalizeForQuoteMatch(tableAnchor.sectionPath.at(-1) || "") !==
          normalizeForQuoteMatch(textAnchor.sectionPath.at(-1) || "")
      ) {
        return [];
      }
      const tableNumber = /(?:表|Table)\s*([0-9]+)/iu.exec(
        visualAnchorSource(tableAnchor),
      )?.[1];
      if (!tableNumber) return [];
      const supports = findUniqueTableEntitySupports(
        {
          text: "",
          evidence: [evidence[0]],
          visualEvidence: [{ anchorId: tableAnchor.id }],
        },
        anchorById,
      );
      return supports.map((support) => ({
        ...support,
        tableAnchor,
        tableNumber,
      }));
    });
    if (matches.length !== 1) continue;

    const match = matches[0];
    if (
      sections.some((section) =>
        section.bullets.some(
          (bullet) =>
            /最终选择|优选|被选(?:择)?|选为|选择/u.test(bullet.claim) &&
            (bullet.anchorIds.includes(textAnchor.id) ||
              sourceContainsEntity(bullet.claim, match.entity)),
        ),
      )
    ) {
      continue;
    }
    const visibleSelection = toVisibleSourceText(selectionQuote);
    const claim = `表 ${match.tableNumber}中与原文指标 ${match.metric} 对应的条目是${match.entity}；原文随后写明“${visibleSelection}”。`;
    const visualEvidence = [{ anchorId: match.tableAnchor.id }];
    if (
      !numberedEntitiesAreGrounded(claim, evidence, visualEvidence, anchorById)
    ) {
      continue;
    }
    const bullet = {
      claim,
      anchorIds: [textAnchor.id, match.tableAnchor.id],
      evidence,
      visualEvidence,
    };
    const target = sections.find(
      (section) =>
        section.anchorIds?.includes(textAnchor.id) &&
        section.anchorIds.includes(match.tableAnchor.id),
    );
    target?.bullets.push(bullet);
  }
  return outline;
}

function restoreOmittedNumberedEntities<T extends GroundableStatement>(
  statements: T[],
  anchorById: Map<string, AnchorChunk>,
): T[] {
  const supportsByTable = new Map<string, Map<string, TableEntitySupport>>();
  const directlyGrounded = statements.map((statement) => {
    const supports = findUniqueTableEntitySupports(statement, anchorById);
    let text = statement.text;
    for (const support of supports) {
      const byEntity =
        supportsByTable.get(support.tableAnchorId) ||
        new Map<string, TableEntitySupport>();
      byEntity.set(support.entity, support);
      supportsByTable.set(support.tableAnchorId, byEntity);
      text = restoreMetricOwner(text, support.entity, support.metric);
    }
    return { ...statement, text };
  });

  return directlyGrounded.map((statement) => {
    if (!hasUnresolvedFinalInhibitorSelection(statement.text)) {
      return statement;
    }
    const evidenceAnchorIds = new Set(
      statement.evidence.map((reference) => reference.anchorId),
    );
    const candidates = statement.visualEvidence
      .flatMap((reference) => [
        ...(supportsByTable.get(reference.anchorId)?.values() || []),
      ])
      .filter((support) =>
        support.evidence.some((reference) =>
          evidenceAnchorIds.has(reference.anchorId),
        ),
      );
    const entities = [...new Set(candidates.map((support) => support.entity))];
    if (entities.length !== 1) return statement;
    const entity = entities[0];
    const support = candidates.find((candidate) => candidate.entity === entity);
    if (!support) return statement;
    return {
      ...statement,
      text: restoreFinalSelectionEntity(statement.text, entity),
      evidence: mergeEvidence(statement.evidence, support.evidence),
    };
  });
}

function findUniqueTableEntitySupports(
  statement: GroundableStatement,
  anchorById: Map<string, AnchorChunk>,
): TableEntitySupport[] {
  const metricEvidence = statement.evidence.flatMap((reference) =>
    decimalMetrics(reference.quote).map((metric) => ({ metric, reference })),
  );
  if (metricEvidence.length === 0) return [];

  const supports: TableEntitySupport[] = [];
  for (const visualReference of statement.visualEvidence) {
    const anchor = anchorById.get(visualReference.anchorId);
    if (!anchor?.richContent?.tableHtml) continue;
    const matches: TableEntitySupport[] = [];
    for (const row of tableHtmlToRows(anchor.richContent.tableHtml)) {
      const source = row.join(" ");
      const rowMetrics = row.flatMap(decimalMetrics);
      const entities = extractNumberedEntities(source).filter((entity) =>
        entity.startsWith("缓蚀剂"),
      );
      if (entities.length !== 1) continue;
      for (const { metric, reference } of metricEvidence) {
        if (!rowMetrics.includes(metric)) continue;
        matches.push({
          entity: entities[0],
          tableAnchorId: anchor.id,
          metric,
          evidence: [reference],
        });
      }
    }
    const matchedEntities = [
      ...new Set(matches.map((support) => support.entity)),
    ];
    if (matchedEntities.length !== 1) continue;
    const entity = matchedEntities[0];
    const entityMatches = matches.filter(
      (support) => support.entity === entity,
    );
    supports.push({
      entity,
      tableAnchorId: anchor.id,
      metric: entityMatches[0].metric,
      evidence: mergeEvidence(
        [],
        entityMatches.flatMap((support) => support.evidence),
      ),
    });
  }
  return supports;
}

function restoreMetricOwner(
  text: string,
  entity: string,
  metric: string,
): string {
  if (sourceContainsEntity(text, entity)) return text;
  const metricIndex = text.indexOf(metric);
  if (metricIndex < 0) return text;
  const matches = [
    ...text.slice(0, metricIndex).matchAll(/缓蚀剂(?!\s*[0-9])/gu),
  ].filter((match) => {
    if (match.index === undefined) return false;
    const suffix = text.slice(match.index + match[0].length, metricIndex);
    return /^\s*(?:(?:的|在|于|以)[^，。；]{0,50})?(?:腐蚀速率|缓蚀性能)/u.test(
      suffix,
    );
  });
  const match = matches.at(-1);
  if (match?.index === undefined) return text;
  let start = match.index;
  const quantityPrefix = text.slice(0, start).match(/(?:一种|某种)\s*$/u)?.[0];
  if (quantityPrefix) start -= quantityPrefix.length;
  return `${text.slice(0, start)}${entity}${text.slice(
    match.index + match[0].length,
  )}`;
}

function restoreFinalSelectionEntity(text: string, entity: string): string {
  if (sourceContainsEntity(text, entity)) return text;
  const detailed = text.match(
    /(最终选择|优选|选择)([^。；]{1,80}?)的缓蚀剂(?=\s*(?:作为|用作))/u,
  );
  if (detailed?.index !== undefined) {
    const replacement = `${detailed[1]}${entity}（${detailed[2]}）`;
    return `${text.slice(0, detailed.index)}${replacement}${text.slice(
      detailed.index + detailed[0].length,
    )}`;
  }
  const selectionIndex = text.search(
    /最终选择|优选|被选(?:择)?|选为|选择[^。；]{0,80}(?:作为|用作)/u,
  );
  if (selectionIndex < 0) return text;
  const tail = text.slice(selectionIndex);
  const generic = /(?:一种|某种)?缓蚀剂(?!\s*[0-9])/u.exec(tail);
  if (generic?.index === undefined) return text;
  const start = selectionIndex + generic.index;
  return `${text.slice(0, start)}${entity}${text.slice(
    start + generic[0].length,
  )}`;
}

function mergeEvidence(
  current: EvidenceReference[],
  additions: EvidenceReference[],
): EvidenceReference[] {
  const result: EvidenceReference[] = [];
  const seen = new Set<string>();
  for (const reference of [...current, ...additions]) {
    const key = `${reference.anchorId}\u0000${reference.quote.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    result.push(reference);
    seen.add(key);
    if (result.length >= 3) break;
  }
  return result;
}

function hasUnresolvedFinalInhibitorSelection(text: string): boolean {
  if (!/缓蚀剂(?!\s*[0-9])/u.test(text)) return false;
  const numberedInhibitors = extractNumberedEntities(text).filter((entity) =>
    entity.startsWith("缓蚀剂"),
  );
  if (numberedInhibitors.length === 1) {
    return false;
  }
  return /最终选择|优选|被选(?:择)?|选为|选择[^。；]{0,80}(?:作为|用作)/u.test(
    text,
  );
}

function numberedEntitiesAreGrounded(
  claim: string,
  evidence: EvidenceReference[],
  visualEvidence: Array<{ anchorId: string }>,
  anchorById: Map<string, AnchorChunk>,
): boolean {
  const entities = extractNumberedEntities(claim);
  if (entities.length === 0) return true;

  const isSelectionClaim =
    /最低|最高|最优|较优|优选|被选|选择|选为|满足.{0,8}(?:标准|指标)/u.test(
      claim,
    );
  const evidenceMetrics = [
    ...new Set(
      evidence.flatMap((reference) => decimalMetrics(reference.quote)),
    ),
  ];

  return entities.every((entity) => {
    const groundedInText = evidence.some((reference) => {
      const anchor = anchorById.get(reference.anchorId);
      return Boolean(anchor && sourceContainsEntity(reference.quote, entity));
    });
    if (groundedInText) return true;

    return visualEvidence.some((reference) => {
      const anchor = anchorById.get(reference.anchorId);
      if (!anchor || (isSelectionClaim && anchor.type === "image")) {
        return false;
      }
      if (anchor.richContent?.tableHtml) {
        if (isSelectionClaim && evidenceMetrics.length === 0) {
          return false;
        }
        return tableHtmlToRows(anchor.richContent.tableHtml).some((row) => {
          const source = row.join(" ");
          const rowMetrics = row.flatMap(decimalMetrics);
          return (
            sourceContainsEntity(source, entity) &&
            (evidenceMetrics.length === 0 ||
              evidenceMetrics.some((metric) => rowMetrics.includes(metric)))
          );
        });
      }
      if (isSelectionClaim) return false;
      return sourceContainsEntity(visualAnchorSource(anchor), entity);
    });
  });
}

function extractNumberedEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const match of text.matchAll(/缓蚀剂\s*([0-9]+)/gu)) {
    entities.add(`缓蚀剂${match[1]}`);
  }
  for (const match of text.matchAll(/\bSH\s*[-_ ]?([0-9]+)\b/giu)) {
    entities.add(`sh${match[1]}`);
  }
  return [...entities];
}

function decimalMetrics(text: string): string[] {
  return [...compactVisibleText(text).matchAll(/[0-9]+\.[0-9]+/gu)].map(
    (match) => match[0],
  );
}

function compactVisibleText(text: string): string {
  return toVisibleSourceText(text).replace(/\s+/gu, "");
}

function sourceContainsEntity(source: string, entity: string): boolean {
  const visibleSource = toVisibleSourceText(source)
    .normalize("NFKC")
    .toLocaleLowerCase();
  const inhibitor = /^缓蚀剂([0-9]+)$/u.exec(entity);
  if (inhibitor) {
    return new RegExp(`缓蚀剂\\s*${inhibitor[1]}(?![0-9])`, "u").test(
      visibleSource,
    );
  }
  const thickener = /^sh([0-9]+)$/iu.exec(entity);
  if (thickener) {
    return new RegExp(`\\bsh\\s*[-_ ]?${thickener[1]}(?![0-9])`, "iu").test(
      visibleSource,
    );
  }
  return normalizeForQuoteMatch(source).includes(
    normalizeForQuoteMatch(entity),
  );
}

function visualAnchorSource(anchor: AnchorChunk): string {
  return [
    anchor.text,
    anchor.richContent?.caption,
    anchor.richContent?.description,
    anchor.richContent?.latex,
    anchor.richContent?.tableHtml,
  ]
    .filter(Boolean)
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
