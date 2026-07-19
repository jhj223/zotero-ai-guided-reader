import React, { useMemo, useState } from "react";
import { sectionGuideToMarkdown } from "../core/llmResponses";
import { describeMinerUProgress } from "../core/progressText";
import type {
  AnchorChunk,
  MinerUProgress,
  NormalizedMinerUOutput,
  PageSize,
  ReadingOutline,
  ReadingOutlineSection,
  SectionGuide,
  SectionGuideCategory,
} from "../core/types";
import { openAnchor } from "../runtime/highlight";
import { isPluginEnabled } from "../runtime/preferences";
import { GuidedReadingService } from "../runtime/guidedReadingService";

export function GuidedReaderApp({ item }: { item: Zotero.Item }) {
  const [progress, setProgress] = useState<MinerUProgress>({ state: "idle" });
  const [parsed, setParsed] = useState<NormalizedMinerUOutput>();
  const [outline, setOutline] = useState<ReadingOutline>();
  const [expanded, setExpanded] = useState<Record<string, SectionGuide>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const service = useMemo(
    () =>
      new GuidedReadingService(item, (nextProgress) => {
        setProgress(nextProgress);
      }),
    [item.id],
  );

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
    } catch (err) {
      ztoolkit.log("Guided reader task failed", String(err));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const ensureParsed = () =>
    run(async () => {
      setParsed(await service.ensureParsed());
      setMessage("解析完成，已写入本地缓存。");
    });

  const generateOutline = () =>
    run(async () => {
      const nextParsed = await service.ensureParsed();
      setParsed(nextParsed);
      setOutline(await service.generateOutline());
    });

  const expandSection = (section: ReadingOutlineSection) =>
    run(async () => {
      const guide = await service.generateSectionGuide(section);
      setExpanded((current) => ({ ...current, [section.title]: guide }));
    });

  const mergedGuideText = Object.values(expanded)
    .map(sectionGuideToMarkdown)
    .join("\n\n");

  return (
    <Shell>
      <div className="zg-header">
        <div>
          <div className="zg-eyebrow">AI Guided Reader</div>
          <h2>{service.title()}</h2>
        </div>
      </div>

      <div className="zg-toolbar">
        <button disabled={busy} onClick={ensureParsed}>
          解析 PDF
        </button>
        <button disabled={busy} onClick={generateOutline}>
          生成大纲
        </button>
        <button
          disabled={busy || !mergedGuideText}
          onClick={() =>
            run(async () => {
              const id = await service.saveNote(mergedGuideText);
              setMessage(`已保存为 Zotero Note #${id}`);
            })
          }
        >
          保存 Note
        </button>
        <button
          disabled={busy || !mergedGuideText}
          onClick={() =>
            run(async () => {
              const path = await service.exportAnki(mergedGuideText);
              setMessage(`Anki TSV 已导出：${path}`);
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
          先解析 PDF，再生成 section
          级导读大纲。展开章节时才会请求精读正文，避免一次性把全文塞给模型。
        </div>
      )}

      {outline?.sections.map((section) => (
        <section className="zg-section" key={section.title}>
          <div className="zg-section-head">
            <h3>{section.title}</h3>
            <button disabled={busy} onClick={() => expandSection(section)}>
              展开精读
            </button>
          </div>
          <ul>
            {section.bullets.map((bullet) => {
              const primaryEvidence = bullet.evidence[0];
              const primaryAnchor = parsed?.anchors.find(
                (anchor) => anchor.id === primaryEvidence?.anchorId,
              );
              return (
                <li key={`${section.title}-${bullet.claim}`}>
                  <button
                    className="zg-outline-claim"
                    disabled={!primaryAnchor || !primaryEvidence}
                    title="点击后逐字定位并持续高亮对应原文"
                    onClick={async () => {
                      if (!primaryAnchor || !primaryEvidence) return;
                      await openAnchor({
                        attachment: await service.getAttachment(),
                        anchor: primaryAnchor,
                        pageSize: parsed?.pageSizes?.[primaryAnchor.pageIndex],
                        quote: primaryEvidence.quote,
                      });
                    }}
                  >
                    {bullet.claim}
                  </button>
                </li>
              );
            })}
          </ul>
          {expanded[section.title] && (
            <GuideContent
              guide={expanded[section.title]}
              anchors={parsed?.anchors || []}
              pageSizes={parsed?.pageSizes}
              attachmentPromise={service.getAttachment()}
            />
          )}
        </section>
      ))}
    </Shell>
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
  anchors,
  pageSizes,
  attachmentPromise,
}: {
  guide: SectionGuide;
  anchors: AnchorChunk[];
  pageSizes?: Record<number, PageSize>;
  attachmentPromise: Promise<Zotero.Item>;
}) {
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const groups = GUIDE_CATEGORY_ORDER.map((category) => ({
    category,
    points: guide.points.filter((point) => point.category === category),
  })).filter((group) => group.points.length > 0);

  return (
    <div className="zg-guide">
      <div className="zg-guide-title">{guide.title}</div>
      {groups.map((group) => (
        <div className="zg-guide-group" key={group.category}>
          <h4>{GUIDE_CATEGORY_LABELS[group.category]}</h4>
          <ol>
            {group.points.map((point, pointIndex) => {
              const primaryEvidence = point.evidence[0];
              const primaryAnchor = anchorsById.get(primaryEvidence?.anchorId);
              return (
                <li key={`${group.category}-${pointIndex}-${point.text}`}>
                  <button
                    className="zg-guide-point"
                    disabled={!primaryAnchor || !primaryEvidence}
                    title="点击后逐字定位并持续高亮对应原文"
                    onClick={async () => {
                      if (!primaryAnchor || !primaryEvidence) return;
                      await openAnchor({
                        attachment: await attachmentPromise,
                        anchor: primaryAnchor,
                        pageSize: pageSizes?.[primaryAnchor.pageIndex],
                        quote: primaryEvidence.quote,
                      });
                    }}
                  >
                    {point.text}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
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
.zg-root {
  color: #202124;
  font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 10px;
}
.zg-header {
  border-bottom: 1px solid #d8dde6;
  margin-bottom: 10px;
  padding-bottom: 8px;
}
.zg-eyebrow {
  color: #5f6b7a;
  font-size: 11px;
  text-transform: uppercase;
}
.zg-header h2 {
  font-size: 15px;
  line-height: 1.35;
  margin: 2px 0 0;
}
.zg-toolbar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 8px;
}
.zg-toolbar button,
.zg-section-head button {
  background: #f7f9fb;
  border: 1px solid #c8d0da;
  border-radius: 6px;
  color: #202124;
  cursor: pointer;
  font: inherit;
  min-height: 28px;
}
.zg-toolbar button:disabled,
.zg-section-head button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.zg-status {
  align-items: center;
  background: #f6f8fa;
  border: 1px solid #d8dde6;
  border-radius: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 8px;
}
.zg-dot {
  background: #8a96a3;
  border-radius: 999px;
  height: 8px;
  width: 8px;
}
.zg-dot.busy {
  animation: zg-pulse 1s infinite;
  background: #1d66d1;
}
.zg-error {
  background: #fff1f1;
  border: 1px solid #e0b4b4;
  border-radius: 6px;
  color: #8a1f1f;
  margin-bottom: 8px;
  padding: 8px;
}
.zg-message,
.zg-empty {
  background: #f5fbf7;
  border: 1px solid #cfe8d7;
  border-radius: 6px;
  color: #24533a;
  margin-bottom: 8px;
  padding: 8px;
}
.zg-section {
  border-top: 1px solid #d8dde6;
  padding: 10px 0;
}
.zg-section-head {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
}
.zg-section h3 {
  font-size: 14px;
  margin: 0;
}
.zg-section ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.zg-section li {
  margin: 4px 0;
}
.zg-outline-claim {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
  line-height: inherit;
  padding: 0;
  text-align: left;
}
.zg-outline-claim:hover {
  color: #174f86;
  text-decoration: underline;
}
.zg-outline-claim:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.zg-guide {
  border-left: 3px solid #4c6f91;
  margin-top: 8px;
  padding: 4px 0 2px 10px;
}
.zg-guide-title {
  color: #263746;
  font-size: 13px;
  font-weight: 650;
  margin: 2px 0 8px;
}
.zg-guide-group + .zg-guide-group {
  border-top: 1px solid #e0e5ea;
  margin-top: 10px;
  padding-top: 8px;
}
.zg-guide-group h4 {
  color: #52606d;
  font-size: 11px;
  font-weight: 650;
  margin: 0 0 4px;
}
.zg-guide-group ol {
  margin: 0;
  padding-left: 21px;
}
.zg-guide-group li {
  padding: 2px 0 8px;
}
.zg-guide-point {
  background: transparent;
  border: 0;
  color: #202124;
  cursor: pointer;
  display: block;
  font: inherit;
  line-height: 1.58;
  padding: 0;
  text-align: left;
  width: 100%;
}
.zg-guide-point:hover {
  color: #174f86;
  text-decoration: underline;
}
.zg-guide-point:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
@keyframes zg-pulse {
  0% { opacity: 0.35; }
  50% { opacity: 1; }
  100% { opacity: 0.35; }
}
`;
