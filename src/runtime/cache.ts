import type { NormalizedMinerUOutput, ReadingOutline } from "../core/types";

// v2: parse caches carry pageSizes for the anchor flash highlight.
export const CACHE_VERSION = 2;

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
  sections: Record<string, string>;
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

  private async ensureDir(child?: string): Promise<string> {
    const dir = child ? PathUtils.join(this.rootDir(), child) : this.rootDir();
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    return dir;
  }

  private rootDir(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, "zotero-ai-guided-reader");
  }
}
