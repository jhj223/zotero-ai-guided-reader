import type {
  AnchorChunk,
  MinerUProgress,
  NormalizedMinerUOutput,
  ReadingOutline,
  ReadingOutlineSection,
} from "../core/types";
import { CACHE_VERSION, PluginCache } from "./cache";
import { exportAnkiTsv } from "./ankiExport";
import { LLMClient } from "./llmClient";
import { MinerUClient } from "./mineruClient";
import { saveGuideAsNote } from "./notes";
import { readMinerUSettings, readProviderSettings } from "./preferences";
import {
  getAttachmentDisplayName,
  getAttachmentFilePath,
  getParentForOutput,
  readAnnotationContext,
  resolvePdfAttachment,
} from "./zoteroItems";

export class GuidedReadingService {
  private readonly cache = new PluginCache();
  private attachment?: Zotero.Item;
  private parsed?: NormalizedMinerUOutput;

  constructor(
    private readonly item: Zotero.Item,
    private readonly onProgress: (progress: MinerUProgress) => void,
  ) {}

  async getAttachment(): Promise<Zotero.Item> {
    this.attachment ??= await resolvePdfAttachment(this.item);
    return this.attachment;
  }

  async ensureParsed(force = false): Promise<NormalizedMinerUOutput> {
    const attachment = await this.getAttachment();
    if (!force) {
      const cached = await this.cache.readParse(attachment.key);
      if (cached?.version === CACHE_VERSION && cached.parsed?.anchors?.length) {
        this.parsed = cached.parsed;
        return cached.parsed;
      }
    }

    const filePath = await getAttachmentFilePath(attachment);
    const parsed = await new MinerUClient(readMinerUSettings()).parseLocalPdf({
      filePath,
      fileName: getAttachmentDisplayName(attachment),
      attachmentKey: attachment.key,
      onProgress: this.onProgress,
    });
    await this.cache.writeParse(attachment.key, parsed, attachment.version);
    this.parsed = parsed;
    return parsed;
  }

  async generateOutline(force = false): Promise<ReadingOutline> {
    const attachment = await this.getAttachment();
    const cached = await this.cache.readGuide(attachment.key);
    if (!force && cached?.outline) return cached.outline;

    const parsed = await this.ensureParsed();
    const outline = await new LLMClient(readProviderSettings()).generateOutline(
      {
        title: this.title(),
        anchors: parsed.anchors,
        annotations: readAnnotationContext(attachment),
      },
    );
    await this.cache.writeGuide({
      version: 1,
      attachmentKey: attachment.key,
      createdAt: new Date().toISOString(),
      outline,
      sections: cached?.sections || {},
    });
    return outline;
  }

  async generateSectionGuide(section: ReadingOutlineSection): Promise<string> {
    const attachment = await this.getAttachment();
    const parsed = await this.ensureParsed();
    const cacheKey = section.title;
    const cached = await this.cache.readGuide(attachment.key);
    if (cached?.sections[cacheKey]) return cached.sections[cacheKey];

    const guide = await new LLMClient(
      readProviderSettings(),
    ).generateSectionGuide({
      title: this.title(),
      section,
      anchors: parsed.anchors,
    });
    await this.cache.writeGuide({
      version: 1,
      attachmentKey: attachment.key,
      createdAt: new Date().toISOString(),
      outline: cached?.outline,
      sections: { ...(cached?.sections || {}), [cacheKey]: guide },
    });
    return guide;
  }

  async saveNote(markdown: string): Promise<number> {
    const attachment = await this.getAttachment();
    const parsed = await this.ensureParsed();
    const note = await saveGuideAsNote({
      attachment,
      parentItem: getParentForOutput(attachment),
      title: `${this.title()} - AI 带读`,
      markdown,
      anchors: parsed.anchors,
    });
    return note.id;
  }

  async exportAnki(markdown: string): Promise<string> {
    const parsed = await this.ensureParsed();
    return exportAnkiTsv({
      title: this.title(),
      guideText: markdown,
      anchors: parsed.anchors,
    });
  }

  findAnchor(id: string): AnchorChunk | undefined {
    return this.parsed?.anchors.find((anchor) => anchor.id === id);
  }

  title(): string {
    return (this.item.getField("title") as string) || "Untitled paper";
  }
}
