import type {
  NormalizedMinerUOutput,
  ReadingOutline,
  SectionGuide,
} from "../core/types";

// v3: anchors retain coordinate-space metadata and MinerU rich content.
export const CACHE_VERSION = 3;

// v7: supplement final selections omitted entirely by the model.
export const GUIDE_CACHE_VERSION = 7;

export interface CachedParse {
  version: number;
  attachmentKey: string;
  itemVersion?: number;
  createdAt: string;
  parsed: NormalizedMinerUOutput;
}

export interface CachedGuide {
  version: number;
  attachmentKey: string;
  createdAt: string;
  outline?: ReadingOutline;
  // Kept for reading v1 caches; new section guides use validated JSON below.
  sections: Record<string, string>;
  structuredSections?: Record<string, SectionGuide>;
}

export function isUsableParseCache(
  value: CachedParse | undefined,
): value is CachedParse {
  return Boolean(
    value &&
    (value.version === 2 || value.version === CACHE_VERSION) &&
    value.parsed?.anchors?.length,
  );
}

export class PluginCache {
  async readParse(attachmentKey: string): Promise<CachedParse | undefined> {
    return this.readJson<CachedParse>(this.parsePath(attachmentKey));
  }

  async writeParse(
    attachmentKey: string,
    parsed: NormalizedMinerUOutput,
    itemVersion?: number,
  ): Promise<void> {
    await this.writeJson(this.parsePath(attachmentKey), {
      version: CACHE_VERSION,
      attachmentKey,
      itemVersion,
      createdAt: new Date().toISOString(),
      parsed,
    } satisfies CachedParse);
  }

  async readGuide(attachmentKey: string): Promise<CachedGuide | undefined> {
    return this.readJson<CachedGuide>(this.guidePath(attachmentKey));
  }

  async writeGuide(guide: CachedGuide): Promise<void> {
    await this.writeJson(this.guidePath(guide.attachmentKey), guide);
  }

  async writeTextFile(fileName: string, content: string): Promise<string> {
    const dir = await this.ensureDir("exports");
    const path = PathUtils.join(dir, fileName);
    await IOUtils.writeUTF8(path, content, { tmpPath: `${path}.tmp` });
    return path;
  }

  async writeAsset(
    attachmentKey: string,
    assetName: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const path = await this.assetPath(attachmentKey, assetName, true);
    await IOUtils.write(path, bytes, { tmpPath: `${path}.tmp` });
  }

  async readAsset(
    attachmentKey: string,
    assetName: string,
  ): Promise<Uint8Array | undefined> {
    const path = await this.assetPath(attachmentKey, assetName, false);
    return (await IOUtils.exists(path)) ? IOUtils.read(path) : undefined;
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    if (!(await IOUtils.exists(path))) return undefined;
    const value = (await IOUtils.readJSON(path)) as T;
    if (!value || typeof value !== "object") return undefined;
    return value;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.ensureDir();
    await IOUtils.writeJSON(path, value, { tmpPath: `${path}.tmp` });
  }

  private parsePath(attachmentKey: string): string {
    return PathUtils.join(this.rootDir(), `${attachmentKey}.parse.json`);
  }

  private guidePath(attachmentKey: string): string {
    return PathUtils.join(this.rootDir(), `${attachmentKey}.guide.json`);
  }

  private async assetPath(
    attachmentKey: string,
    assetName: string,
    createDir: boolean,
  ): Promise<string> {
    if (!/^[A-Z0-9]{1,32}$/i.test(attachmentKey)) {
      throw new Error("Invalid Zotero attachment key for asset cache.");
    }
    if (!/^[A-Za-z0-9._-]{1,180}$/.test(assetName)) {
      throw new Error("Invalid MinerU asset name.");
    }
    const dir = PathUtils.join(this.rootDir(), "assets", attachmentKey);
    if (createDir) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    }
    return PathUtils.join(dir, assetName);
  }

  private async ensureDir(child?: string): Promise<string> {
    const dir = child ? PathUtils.join(this.rootDir(), child) : this.rootDir();
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    return dir;
  }

  private rootDir(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, "zotero-ai-guided-reader");
  }
}
