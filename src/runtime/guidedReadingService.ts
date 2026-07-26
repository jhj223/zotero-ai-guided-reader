import type {
  AnchorChunk,
  MinerUProgress,
  NormalizedMinerUOutput,
  ReadingOutline,
  ReadingOutlineSection,
  SectionGuide,
} from "../core/types";
import {
  filterOutlineToKnownAnchors,
  normalizeSectionGuide,
} from "../core/llmResponses";
import { restoreRichContentFromMarkdown } from "../core/mineruNormalizer";
import { resolveMinerUOptions } from "../core/mineruOptions";
import {
  CACHE_VERSION,
  GUIDE_CACHE_VERSION,
  PluginCache,
  isUsableParseCache,
  type CachedParse,
} from "./cache";
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

  async loadCachedState(): Promise<{
    parsed?: NormalizedMinerUOutput;
    outline?: ReadingOutline;
    sections: Record<string, SectionGuide>;
  }> {
    const attachment = await this.getAttachment();
    const parseCache = await this.cache.readParse(attachment.key);
    if (!isUsableParseCache(parseCache)) return { sections: {} };
    this.parsed = await this.restoreCachedParse(parseCache, attachment);

    const guideCache = await this.cache.readGuide(attachment.key);
    if (guideCache?.version !== GUIDE_CACHE_VERSION) {
      return { parsed: this.parsed, sections: {} };
    }

    const outline = guideCache.outline
      ? filterOutlineToKnownAnchors(guideCache.outline, this.parsed.anchors)
      : undefined;
    const sections: Record<string, SectionGuide> = {};
    for (const [title, rawGuide] of Object.entries(
      guideCache.structuredSections || {},
    )) {
      try {
        sections[title] = normalizeSectionGuide(
          rawGuide,
          this.parsed.anchors,
          title,
        );
      } catch (error) {
        ztoolkit.log("Ignoring invalid cached section guide", {
          attachmentKey: attachment.key,
          title,
          reason: String(error),
        });
      }
    }
    return { parsed: this.parsed, outline, sections };
  }

  async readAsset(assetName: string): Promise<
    | {
        bytes: Uint8Array;
        mimeType: string;
      }
    | undefined
  > {
    const attachment = await this.getAttachment();
    const bytes = await this.cache.readAsset(attachment.key, assetName);
    if (!bytes) return undefined;
    const extension = assetName.slice(assetName.lastIndexOf(".")).toLowerCase();
    const mimeType =
      extension === ".png"
        ? "image/png"
        : extension === ".webp"
          ? "image/webp"
          : "image/jpeg";
    return { bytes, mimeType };
  }

  async ensureParsed(force = false): Promise<NormalizedMinerUOutput> {
    const attachment = await this.getAttachment();
    if (!force) {
      const cached = await this.cache.readParse(attachment.key);
      if (isUsableParseCache(cached)) {
        return this.restoreCachedParse(cached, attachment);
      }
    }

    const filePath = await getAttachmentFilePath(attachment);
    const mineruSettings = readMinerUSettings();
    let extractedText = "";
    let totalPages: number | undefined;
    if (mineruSettings.modelVersion === "auto") {
      try {
        extractedText = await attachment.attachmentText;
      } catch (error) {
        ztoolkit.log("Unable to inspect PDF text layer for MinerU auto mode", {
          attachmentKey: attachment.key,
          reason: String(error),
        });
      }
      try {
        const pageInfo = await Zotero.Fulltext.getPages(attachment.id);
        totalPages = pageInfo ? pageInfo.total : undefined;
      } catch {
        totalPages = undefined;
      }
    }
    const resolvedOptions = resolveMinerUOptions(mineruSettings, {
      extractedText,
      totalPages,
    });
    ztoolkit.log("Resolved MinerU parsing options", {
      attachmentKey: attachment.key,
      modelVersion: resolvedOptions.modelVersion,
      enableOcr: resolvedOptions.enableOcr,
      textLayerUsable: resolvedOptions.textLayerUsable,
    });
    const parsed = await new MinerUClient({
      apiKey: mineruSettings.apiKey,
      language: mineruSettings.language,
      pollIntervalMs: mineruSettings.pollIntervalMs,
      modelVersion: resolvedOptions.modelVersion,
      enableOcr: resolvedOptions.enableOcr,
    }).parseLocalPdf({
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
    const currentCache =
      cached?.version === GUIDE_CACHE_VERSION ? cached : undefined;
    if (!force && currentCache?.outline) return currentCache.outline;

    const parsed = await this.ensureParsed();
    const outline = await new LLMClient(readProviderSettings()).generateOutline(
      {
        title: this.title(),
        anchors: parsed.anchors,
        annotations: readAnnotationContext(attachment),
      },
    );
    await this.cache.writeGuide({
      version: GUIDE_CACHE_VERSION,
      attachmentKey: attachment.key,
      createdAt: new Date().toISOString(),
      outline,
      sections: force ? {} : currentCache?.sections || {},
      structuredSections: force ? {} : currentCache?.structuredSections || {},
    });
    return outline;
  }

  async generateSectionGuide(
    section: ReadingOutlineSection,
    force = false,
  ): Promise<SectionGuide> {
    const attachment = await this.getAttachment();
    const parsed = await this.ensureParsed();
    const cacheKey = section.title;
    const cached = await this.cache.readGuide(attachment.key);
    const currentCache =
      cached?.version === GUIDE_CACHE_VERSION ? cached : undefined;
    if (!force && currentCache?.structuredSections?.[cacheKey]) {
      try {
        return normalizeSectionGuide(
          currentCache.structuredSections[cacheKey],
          parsed.anchors,
          section.title,
        );
      } catch (error) {
        ztoolkit.log(
          "Ignoring invalid structured guide cache",
          attachment.key,
          String(error),
        );
      }
    }

    const guide = await new LLMClient(
      readProviderSettings(),
    ).generateSectionGuide({
      title: this.title(),
      section,
      anchors: parsed.anchors,
    });
    await this.cache.writeGuide({
      version: GUIDE_CACHE_VERSION,
      attachmentKey: attachment.key,
      createdAt: new Date().toISOString(),
      outline: currentCache?.outline,
      sections: currentCache?.sections || {},
      structuredSections: {
        ...(currentCache?.structuredSections || {}),
        [cacheKey]: guide,
      },
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

  async exportAnki(markdown: string): Promise<string | undefined> {
    return exportAnkiTsv({
      title: this.title(),
      guideText: markdown,
    });
  }

  findAnchor(id: string): AnchorChunk | undefined {
    return this.parsed?.anchors.find((anchor) => anchor.id === id);
  }

  title(): string {
    return (this.item.getField("title") as string) || "Untitled paper";
  }

  private async restoreCachedParse(
    cached: CachedParse,
    attachment: Zotero.Item,
  ): Promise<NormalizedMinerUOutput> {
    const parsed = restoreRichContentFromMarkdown(cached.parsed);
    if (cached.version !== CACHE_VERSION || parsed !== cached.parsed) {
      try {
        await this.cache.writeParse(
          attachment.key,
          parsed,
          cached.itemVersion ?? attachment.version,
        );
      } catch (error) {
        ztoolkit.log("Unable to persist upgraded parse cache", {
          attachmentKey: attachment.key,
          reason: String(error),
        });
      }
    }
    this.parsed = parsed;
    return parsed;
  }
}
