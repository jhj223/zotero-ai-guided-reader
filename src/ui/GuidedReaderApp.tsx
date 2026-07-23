import katex from "katex";
import React, { useEffect, useMemo, useState } from "react";
import { sectionGuideToMarkdown } from "../core/llmResponses";
import { splitMathText } from "../core/mathText";
import { describeMinerUProgress } from "../core/progressText";
import { tableHtmlToRows } from "../core/tableHtml";
import type {
  AnchorChunk,
  EvidenceReference,
  MinerUProgress,
  NormalizedMinerUOutput,
  PageSize,
  ReadingOutline,
  ReadingOutlineSection,
  SectionGuide,
  SectionGuideCategory,
} from "../core/types";
import { GuidedReadingService } from "../runtime/guidedReadingService";
import { openAnchor } from "../runtime/highlight";
import { isPluginEnabled } from "../runtime/preferences";

export function GuidedReaderApp({ item }: { item: Zotero.Item }) {
  const [progress, setProgress] = useState<MinerUProgress>({ state: "idle" });
  const [parsed, setParsed] = useState<NormalizedMinerUOutput>();
  const [outline, setOutline] = useState<ReadingOutline>();
  const [guides, setGuides] = useState<Record<string, SectionGuide>>({});
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const service = useMemo(
    () => new GuidedReadingService(item, setProgress),
    [item.id],
  );

  useEffect(() => {
    let active = true;
    setError("");
    void service
      .loadCachedState()
      .then((cached) => {
        if (!active) return;
        setParsed(cached.parsed);
        setOutline(cached.outline);
        setGuides(cached.sections);
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [service]);

  if (!isPluginEnabled()) {
    return (
      <Shell>
        <div className="zg-empty">插件已在设置中停用。</div>
      </Shell>
    );
  }

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (reason) {
      ztoolkit.log("Guided reader task failed", String(reason));
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleSection = (section: ReadingOutlineSection) => {
    const existing = guides[section.title];
    if (existing) {
      setOpenSections((current) => ({
        ...current,
        [section.title]: !current[section.title],
      }));
      return;
    }
    void run(async () => {
      const guide = await service.generateSectionGuide(section);
      setGuides((current) => ({ ...current, [section.title]: guide }));
      setOpenSections((current) => ({ ...current, [section.title]: true }));
    });
  };

  const regenerateSection = (section: ReadingOutlineSection) => {
    void run(async () => {
      const guide = await service.generateSectionGuide(section, true);
      setGuides((current) => ({ ...current, [section.title]: guide }));
      setOpenSections((current) => ({ ...current, [section.title]: true }));
      setMessage(`已重新生成“${section.title}”精读。`);
    });
  };

  const generatedGuideText = outline
    ? outline.sections
        .map((section) => {
          const guide = guides[section.title];
          if (guide) return sectionGuideToMarkdown(guide);
          return section.bullets
            .map((bullet) => {
              const anchors = bullet.evidence
                .map((evidence) => `[[ANCHOR:${evidence.anchorId}]]`)
                .join(" ");
              return `${section.title}：${bullet.claim}${anchors ? ` ${anchors}` : ""}`;
            })
            .join("\n\n");
        })
        .filter(Boolean)
        .join("\n\n")
    : Object.values(guides).map(sectionGuideToMarkdown).join("\n\n");

  return (
    <Shell>
      <header className="zg-header">
        <div className="zg-eyebrow">AI 带读</div>
        <h2>{service.title()}</h2>
      </header>

      <div className="zg-toolbar">
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setParsed(await service.ensureParsed());
              setMessage("解析完成，结果已写入本地缓存。");
            })
          }
        >
          解析 PDF
        </button>
        <button
          disabled={busy}
          title={outline ? "重新调用当前模型并替换已有导读" : undefined}
          onClick={() =>
            void run(async () => {
              const nextParsed = await service.ensureParsed();
              setParsed(nextParsed);
              const force = Boolean(outline);
              setOutline(await service.generateOutline(force));
              if (force) {
                setGuides({});
                setOpenSections({});
                setMessage("导读已重新生成，旧章节精读已清除。");
              }
            })
          }
        >
          {outline ? "重新生成导读" : "生成导读"}
        </button>
        <button
          disabled={busy || !generatedGuideText}
          title={!generatedGuideText ? "生成导读后可保存" : undefined}
          onClick={() =>
            void run(async () => {
              const id = await service.saveNote(generatedGuideText);
              setMessage(`已保存为 Zotero Note #${id}`);
            })
          }
        >
          保存 Note
        </button>
        <button
          disabled={busy || !generatedGuideText}
          title={!generatedGuideText ? "生成导读后可导出" : undefined}
          onClick={() =>
            void run(async () => {
              const path = await service.exportAnki(generatedGuideText);
              setMessage(path ? `Anki TSV 已导出：${path}` : "已取消导出。");
            })
          }
        >
          导出 Anki
        </button>
      </div>

      <Status progress={progress} parsed={parsed} busy={busy} />
      {error && <div className="zg-error">{error}</div>}
      {message && <div className="zg-message">{message}</div>}

      {!outline && (
        <div className="zg-empty">
          解析 PDF 后生成导读。精读按章节请求，避免一次发送整篇论文。
        </div>
      )}

      {outline?.sections.map((section) => {
        const guide = guides[section.title];
        const isOpen = Boolean(openSections[section.title]);
        return (
          <section className="zg-section" key={section.title}>
            <div className="zg-section-head">
              <h3>{section.title}</h3>
              <div className="zg-section-actions">
                {guide && (
                  <button
                    disabled={busy}
                    title="重新调用当前模型并替换本节精读"
                    onClick={() => regenerateSection(section)}
                  >
                    重新生成
                  </button>
                )}
                <button disabled={busy} onClick={() => toggleSection(section)}>
                  {guide && isOpen ? "收起精读" : "展开精读"}
                </button>
              </div>
            </div>
            <ul className="zg-outline-list">
              {section.bullets.map((bullet) => (
                <li key={`${section.title}-${bullet.claim}`}>
                  <EvidenceLinkedClaim
                    evidence={bullet.evidence}
                    anchors={parsed?.anchors || []}
                    pageSizes={parsed?.pageSizes}
                    service={service}
                    semanticQuery={bullet.claim}
                  >
                    <RichText text={bullet.claim} />
                  </EvidenceLinkedClaim>
                </li>
              ))}
            </ul>
            {guide && isOpen && (
              <GuideContent
                guide={guide}
                sectionAnchorIds={section.anchorIds || []}
                anchors={parsed?.anchors || []}
                pageSizes={parsed?.pageSizes}
                service={service}
              />
            )}
          </section>
        );
      })}
    </Shell>
  );
}

function EvidenceLinkedClaim({
  evidence,
  anchors,
  pageSizes,
  service,
  semanticQuery,
  children,
}: {
  evidence: EvidenceReference[];
  anchors: AnchorChunk[];
  pageSizes?: Record<number, PageSize>;
  service: GuidedReadingService;
  semanticQuery: string;
  children: React.ReactNode;
}) {
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const locations = evidence
    .map((reference) => ({
      reference,
      anchor: anchorsById.get(reference.anchorId),
    }))
    .filter(
      (
        location,
      ): location is { reference: EvidenceReference; anchor: AnchorChunk } =>
        Boolean(location.anchor),
    );
  const parsed = { anchors, pageSizes, sourceFiles: [] };

  if (locations.length === 0) return <span>{children}</span>;
  if (locations.length === 1) {
    const location = locations[0];
    return (
      <AnchorButton
        anchor={location.anchor}
        quote={location.reference.quote}
        parsed={parsed}
        service={service}
        semanticQuery={semanticQuery}
      >
        {children}
      </AnchorButton>
    );
  }

  return (
    <details className="zg-evidence-picker">
      <summary>
        <span>{children}</span>
        <span className="zg-evidence-count">
          查看 {locations.length} 处原文
        </span>
      </summary>
      <div role="list" className="zg-evidence-locations">
        {locations.map(({ anchor, reference }, index) => (
          <div
            role="listitem"
            className="zg-evidence-location"
            key={`${anchor.id}-${reference.quote}-${index}`}
          >
            <AnchorButton
              anchor={anchor}
              quote={reference.quote}
              parsed={parsed}
              service={service}
              semanticQuery={semanticQuery}
            >
              <span className="zg-evidence-page">
                第 {anchor.pageNumber} 页
              </span>
              <span className="zg-evidence-quote">
                {shortenEvidenceQuote(reference.quote)}
              </span>
            </AnchorButton>
          </div>
        ))}
      </div>
    </details>
  );
}

function shortenEvidenceQuote(quote: string): string {
  const compact = quote.replace(/\s+/g, " ").trim();
  return compact.length > 96 ? `${compact.slice(0, 96)}…` : compact;
}

function AnchorButton({
  anchor,
  quote,
  parsed,
  service,
  semanticQuery,
  children,
}: {
  anchor?: AnchorChunk;
  quote?: string;
  parsed?: NormalizedMinerUOutput;
  service: GuidedReadingService;
  semanticQuery?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className="zg-anchor-button"
      disabled={!anchor}
      title="点击定位并持续高亮对应原文"
      onClick={() => {
        if (!anchor) return;
        void service.getAttachment().then((attachment) =>
          openAnchor({
            attachment,
            anchor,
            pageSize: parsed?.pageSizes?.[anchor.pageIndex],
            quote,
            semanticQuery,
          }),
        );
      }}
    >
      {children}
    </button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="zg-root">
      <style>{styles}</style>
      {children}
    </div>
  );
}

function Status({
  progress,
  parsed,
  busy,
}: {
  progress: MinerUProgress;
  parsed?: NormalizedMinerUOutput;
  busy: boolean;
}) {
  const progressText = describeMinerUProgress(progress, Boolean(parsed));
  return (
    <div className="zg-status">
      <span className={busy ? "zg-dot busy" : "zg-dot"} />
      <span>{progressText}</span>
      {parsed && <span>{parsed.anchors.length} 个锚点</span>}
    </div>
  );
}

function GuideContent({
  guide,
  sectionAnchorIds,
  anchors,
  pageSizes,
  service,
}: {
  guide: SectionGuide;
  sectionAnchorIds: string[];
  anchors: AnchorChunk[];
  pageSizes?: Record<number, PageSize>;
  service: GuidedReadingService;
}) {
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const groups = GUIDE_CATEGORY_ORDER.map((category) => ({
    category,
    points: guide.points.filter((point) => point.category === category),
  })).filter((group) => group.points.length > 0);
  const visualAnchors = [
    ...new Set([
      ...sectionAnchorIds,
      ...guide.points.flatMap((point) =>
        point.evidence.map((evidence) => evidence.anchorId),
      ),
    ]),
  ]
    .map((id) => anchorsById.get(id))
    .filter(
      (anchor): anchor is AnchorChunk =>
        Boolean(anchor?.richContent) &&
        ["equation", "table", "image"].includes(anchor?.type || ""),
    );

  return (
    <div className="zg-guide">
      <div className="zg-guide-title">{guide.title}</div>
      {groups.map((group) => (
        <div className="zg-guide-group" key={group.category}>
          <h4>{GUIDE_CATEGORY_LABELS[group.category]}</h4>
          <ol>
            {group.points.map((point, pointIndex) => {
              return (
                <li key={`${group.category}-${pointIndex}-${point.text}`}>
                  <EvidenceLinkedClaim
                    evidence={point.evidence}
                    anchors={anchors}
                    pageSizes={pageSizes}
                    service={service}
                    semanticQuery={point.text}
                  >
                    <RichText text={point.text} />
                  </EvidenceLinkedClaim>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      {visualAnchors.length > 0 && (
        <div className="zg-visuals">
          <h4>公式与图表证据</h4>
          {visualAnchors.map((anchor) => (
            <VisualEvidence key={anchor.id} anchor={anchor} service={service} />
          ))}
        </div>
      )}
    </div>
  );
}

function VisualEvidence({
  anchor,
  service,
}: {
  anchor: AnchorChunk;
  service: GuidedReadingService;
}) {
  const rich = anchor.richContent;
  if (!rich) return null;
  const rows = rich.tableHtml ? tableHtmlToRows(rich.tableHtml) : [];
  return (
    <figure className="zg-visual">
      {rich.latex && <MathFormula latex={rich.latex} displayMode />}
      {rows.length > 0 && <SafeTable rows={rows} />}
      {rich.assetName && (
        <CachedImage
          assetName={rich.assetName}
          alt={rich.caption || rich.description || "论文图表"}
          service={service}
        />
      )}
      {(rich.caption || rich.description) && (
        <figcaption>
          <RichText
            text={[rich.caption, rich.description].filter(Boolean).join(" ")}
          />
        </figcaption>
      )}
      <AnchorButton anchor={anchor} service={service}>
        查看原文位置
      </AnchorButton>
    </figure>
  );
}

function CachedImage({
  assetName,
  alt,
  service,
}: {
  assetName: string;
  alt: string;
  service: GuidedReadingService;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let objectUrl = "";
    let active = true;
    void service.readAsset(assetName).then((asset) => {
      if (!active || !asset) return;
      const copy = new Uint8Array(asset.bytes);
      objectUrl = URL.createObjectURL(
        new Blob([copy.buffer], { type: asset.mimeType }),
      );
      setUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetName, service]);
  return url ? <img className="zg-figure-image" src={url} alt={alt} /> : null;
}

function SafeTable({ rows }: { rows: string[][] }) {
  return (
    <div className="zg-table-wrap">
      <table>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${rowIndex}-${row.join("|")}`}>
              {row.map((cell, cellIndex) => {
                const Cell = rowIndex === 0 ? "th" : "td";
                return <Cell key={`${cellIndex}-${cell}`}>{cell}</Cell>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RichText({ text }: { text: string }) {
  return (
    <>
      {splitMathText(text).map((segment, index) =>
        segment.type === "math" ? (
          <MathFormula
            key={`${index}-${segment.value}`}
            latex={segment.value}
            displayMode={segment.display}
          />
        ) : (
          <React.Fragment key={`${index}-${segment.value}`}>
            {segment.value}
          </React.Fragment>
        ),
      )}
    </>
  );
}

function MathFormula({
  latex,
  displayMode,
}: {
  latex: string;
  displayMode: boolean;
}) {
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      output: "mathml",
      strict: "ignore",
      throwOnError: false,
      trust: false,
    });
    return (
      <span
        className={displayMode ? "zg-math display" : "zg-math"}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } catch {
    return <code>{latex}</code>;
  }
}

const GUIDE_CATEGORY_ORDER: SectionGuideCategory[] = [
  "fact",
  "mechanism",
  "judgment",
  "caution",
];

const GUIDE_CATEGORY_LABELS: Record<SectionGuideCategory, string> = {
  fact: "原文事实",
  mechanism: "机制与逻辑",
  judgment: "作者判断",
  caution: "边界与局限",
};

const styles = `
.zg-root { color: #202124; font: 13px/1.55 system-ui, "Segoe UI", sans-serif; padding: 10px; }
.zg-header { border-bottom: 1px solid #d8dde6; margin-bottom: 10px; padding-bottom: 8px; }
.zg-eyebrow { color: #5f6b7a; font-size: 11px; }
.zg-header h2 { font-size: 15px; line-height: 1.35; margin: 2px 0 0; }
.zg-toolbar { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 8px; }
.zg-root button { background: #f7f9fb; border: 1px solid #c8d0da; border-radius: 6px; color: #202124; cursor: pointer; font: inherit; min-height: 28px; }
.zg-root button:disabled { cursor: not-allowed; opacity: .55; }
.zg-status { align-items: center; background: #f6f8fa; border: 1px solid #d8dde6; border-radius: 6px; display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; padding: 6px 8px; }
.zg-dot { background: #8a96a3; border-radius: 50%; height: 8px; width: 8px; }
.zg-dot.busy { animation: zg-pulse 1s infinite; background: #1d66d1; }
.zg-error, .zg-message, .zg-empty { border: 1px solid; border-radius: 6px; margin-bottom: 8px; padding: 8px; }
.zg-error { background: #fff1f1; border-color: #e0b4b4; color: #8a1f1f; }
.zg-message, .zg-empty { background: #f5fbf7; border-color: #cfe8d7; color: #24533a; }
.zg-section { border-top: 1px solid #d8dde6; padding: 10px 0; }
.zg-section-head { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
.zg-section-actions { display: flex; flex: 0 0 auto; gap: 5px; }
.zg-section h3 { font-size: 14px; margin: 0; }
.zg-outline-list { margin: 6px 0 0; padding-left: 18px; }
.zg-section li { margin: 4px 0; }
.zg-anchor-button { background: transparent !important; border: 0 !important; display: inline; line-height: inherit; min-height: 0 !important; padding: 0; text-align: left; }
.zg-anchor-button:hover { color: #174f86; text-decoration: underline; }
.zg-evidence-picker { display: block; margin: 0; min-width: 0; width: 100%; }
.zg-evidence-picker > summary { cursor: pointer; display: list-item; line-height: 1.55; overflow-wrap: anywhere; }
.zg-evidence-count { color: #52606d; font-size: 11px; margin-left: 6px; white-space: nowrap; }
.zg-evidence-locations { border-left: 2px solid #c7d4e2; display: flex; flex-direction: column; gap: 6px; margin: 6px 0 2px 2px; min-width: 0; padding-left: 10px; }
.zg-evidence-location { display: block; margin: 0; min-width: 0; }
.zg-evidence-locations .zg-anchor-button { display: block; width: 100%; }
.zg-evidence-page { color: #315f8c; display: block; font-size: 11px; font-weight: 650; }
.zg-evidence-quote { color: #4b5563; display: block; font-size: 12px; line-height: 1.45; }
.zg-guide { border-left: 3px solid #4c6f91; margin-top: 8px; padding: 4px 0 2px 10px; }
.zg-guide-title { color: #263746; font-weight: 650; margin: 2px 0 8px; }
.zg-guide-group + .zg-guide-group { border-top: 1px solid #e0e5ea; margin-top: 10px; padding-top: 8px; }
.zg-guide h4 { color: #52606d; font-size: 11px; margin: 0 0 4px; }
.zg-guide-group ol { margin: 0; padding-left: 21px; }
.zg-guide-group li { clear: both; min-width: 0; overflow-wrap: anywhere; padding: 2px 0 8px; }
.zg-math { display: inline-block; margin: 0 2px; }
.zg-math.display { display: block; margin: 8px 0; overflow-x: auto; text-align: center; }
.zg-visuals { border-top: 1px solid #d8dde6; margin-top: 10px; padding-top: 8px; }
.zg-visual { border: 1px solid #d8dde6; border-radius: 6px; margin: 7px 0; overflow: hidden; padding: 8px; }
.zg-visual figcaption { color: #4b5563; margin: 6px 0; }
.zg-figure-image { display: block; height: auto; margin: 0 auto 6px; max-height: 360px; max-width: 100%; object-fit: contain; }
.zg-table-wrap { max-height: 320px; overflow: auto; }
.zg-table-wrap table { border-collapse: collapse; font-size: 12px; width: 100%; }
.zg-table-wrap th, .zg-table-wrap td { border: 1px solid #cfd6de; padding: 4px 5px; text-align: left; vertical-align: top; }
.zg-table-wrap th { background: #f2f5f8; font-weight: 650; }
@keyframes zg-pulse { 0% { opacity: .35; } 50% { opacity: 1; } 100% { opacity: .35; } }
`;
