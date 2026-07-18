import React, { useMemo, useState } from "react";
import { parseAnchorPlaceholders } from "../core/anchorMarkup";
import { describeMinerUProgress } from "../core/progressText";
import type {
  AnchorChunk,
  MinerUProgress,
  NormalizedMinerUOutput,
  ReadingOutline,
  ReadingOutlineSection,
} from "../core/types";
import { openAnchor } from "../runtime/highlight";
import { isPluginEnabled } from "../runtime/preferences";
import { GuidedReadingService } from "../runtime/guidedReadingService";

export function GuidedReaderApp({ item }: { item: Zotero.Item }) {
  const [progress, setProgress] = useState<MinerUProgress>({ state: "idle" });
  const [parsed, setParsed] = useState<NormalizedMinerUOutput>();
  const [outline, setOutline] = useState<ReadingOutline>();
  const [expanded, setExpanded] = useState<Record<string, string>>({});
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

  const mergedGuideText = Object.values(expanded).join("\n\n");

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
            {section.bullets.map((bullet) => (
              <li key={`${section.title}-${bullet.claim}`}>
                {bullet.claim}
                <span className="zg-anchor-list">
                  {bullet.anchorIds.map((id) => (
                    <AnchorButton
                      attachmentPromise={service.getAttachment()}
                      anchor={parsed?.anchors.find(
                        (candidate) => candidate.id === id,
                      )}
                      id={id}
                      key={id}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
          {expanded[section.title] && (
            <GuideText
              text={expanded[section.title]}
              anchors={parsed?.anchors || []}
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

function GuideText({
  text,
  anchors,
  attachmentPromise,
}: {
  text: string;
  anchors: AnchorChunk[];
  attachmentPromise: Promise<Zotero.Item>;
}) {
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  return (
    <div className="zg-guide">
      {text.split(/\n{2,}/).map((paragraph, paragraphIndex) => (
        <p key={paragraphIndex}>
          {parseAnchorPlaceholders(paragraph).map((segment, index) => {
            if (segment.type === "text")
              return <span key={index}>{segment.text}</span>;
            return (
              <AnchorButton
                attachmentPromise={attachmentPromise}
                anchor={anchorsById.get(segment.anchorId)}
                id={segment.anchorId}
                key={`${segment.anchorId}-${index}`}
              />
            );
          })}
        </p>
      ))}
    </div>
  );
}

function AnchorButton({
  id,
  anchor,
  attachmentPromise,
}: {
  id: string;
  anchor?: AnchorChunk;
  attachmentPromise: Promise<Zotero.Item>;
}) {
  return (
    <button
      className="zg-anchor"
      disabled={!anchor}
      title={anchor ? `跳转到第 ${anchor.pageNumber} 页` : `未知锚点 ${id}`}
      onClick={async () => {
        if (!anchor) return;
        openAnchor({ attachment: await attachmentPromise, anchor });
      }}
    >
      {anchor ? `p.${anchor.pageNumber}` : id}
    </button>
  );
}

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
.zg-section-head button,
.zg-anchor {
  background: #f7f9fb;
  border: 1px solid #c8d0da;
  border-radius: 6px;
  color: #202124;
  cursor: pointer;
  font: inherit;
  min-height: 28px;
}
.zg-toolbar button:disabled,
.zg-section-head button:disabled,
.zg-anchor:disabled {
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
.zg-anchor-list {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-left: 4px;
}
.zg-anchor {
  color: #1f5faa;
  display: inline-block;
  font-size: 11px;
  margin: 0 2px;
  min-height: 20px;
  padding: 0 5px;
}
.zg-guide {
  background: #fbfcfd;
  border-left: 3px solid #5a7fa8;
  margin-top: 8px;
  padding: 2px 8px;
}
.zg-guide p {
  margin: 8px 0;
}
@keyframes zg-pulse {
  0% { opacity: 0.35; }
  50% { opacity: 1; }
  100% { opacity: 0.35; }
}
`;
