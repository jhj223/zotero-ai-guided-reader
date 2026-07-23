import JSZip from "jszip";
import {
  normalizeMinerUOutput,
  validateMinerUInputLimits,
} from "../core/mineruNormalizer";
import { describeMinerUAsset } from "../core/mineruAssets";
import type { MinerUProgress, NormalizedMinerUOutput } from "../core/types";
import { PluginCache } from "./cache";
import type { ResolvedMinerUSettings } from "./preferences";

const API_BASE = "https://mineru.net/api/v4";
const MAX_POLLS = 240;
const MAX_ASSET_COUNT = 100;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 50 * 1024 * 1024;

export type ProgressCallback = (progress: MinerUProgress) => void;

interface MinerUResponse<T> {
  code: number;
  msg: string;
  trace_id?: string;
  data?: T;
}

interface FileUrlBatchData {
  batch_id?: string;
  file_urls?: Array<{ file_url?: string; url?: string } | string>;
}

interface ExtractResult {
  state?: MinerUProgress["state"];
  full_zip_url?: string;
  err_msg?: string;
  extract_progress?: {
    extracted_pages?: number;
    total_pages?: number;
  };
}

export class MinerUClient {
  constructor(
    private readonly settings: ResolvedMinerUSettings,
    private readonly cache = new PluginCache(),
  ) {}

  async parseLocalPdf(input: {
    filePath: string;
    fileName: string;
    attachmentKey: string;
    onProgress?: ProgressCallback;
  }): Promise<NormalizedMinerUOutput> {
    if (!this.settings.apiKey.trim()) {
      throw new Error("MinerU API Key is not configured.");
    }

    const stat = await IOUtils.stat(input.filePath);
    const limitErrors = validateMinerUInputLimits({ sizeBytes: stat.size });
    if (limitErrors.length) {
      throw new Error(limitErrors.join(" "));
    }

    input.onProgress?.({ state: "pending", message: "Creating MinerU task" });
    const { batchId, fileUrl } = await this.createSignedUpload(input);

    input.onProgress?.({
      state: "waiting-file",
      message: "Uploading PDF to MinerU signed URL",
    });
    const bytes = await IOUtils.read(input.filePath);
    const uploadResponse = await fetch(fileUrl, {
      method: "PUT",
      body: bytes,
    });
    if (!uploadResponse.ok) {
      throw new Error(
        `MinerU signed upload failed: HTTP ${uploadResponse.status}`,
      );
    }

    const zipUrl = await this.pollForZipUrl(batchId, input.onProgress);
    input.onProgress?.({ state: "done", message: "Downloading MinerU result" });
    return this.downloadAndNormalizeZip(zipUrl, input.attachmentKey);
  }

  private async createSignedUpload(input: {
    fileName: string;
    attachmentKey: string;
  }): Promise<{ batchId: string; fileUrl: string }> {
    const response = await this.request<FileUrlBatchData>(
      `${API_BASE}/file-urls/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          files: [
            {
              name: input.fileName,
              data_id: input.attachmentKey,
              is_ocr: this.settings.enableOcr,
            },
          ],
          model_version: this.settings.modelVersion,
          enable_formula: true,
          enable_table: true,
          language: this.settings.language,
        }),
      },
    );

    const batchId = response.data?.batch_id;
    const rawFileUrl = response.data?.file_urls?.[0];
    const fileUrl =
      typeof rawFileUrl === "string"
        ? rawFileUrl
        : rawFileUrl?.file_url || rawFileUrl?.url;

    if (!batchId || !fileUrl) {
      ztoolkit.log(
        "TODO MinerU API shape changed or account response differs; expected data.batch_id and data.file_urls[0].file_url.",
        { traceID: response.trace_id },
      );
      throw new Error("MinerU did not return a batch id and signed file URL.");
    }

    return { batchId, fileUrl };
  }

  private async pollForZipUrl(
    batchId: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      const response = await this.request<{
        extract_result?: ExtractResult | ExtractResult[];
      }>(`${API_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`, {
        method: "GET",
      });
      const result = Array.isArray(response.data?.extract_result)
        ? response.data?.extract_result[0]
        : response.data?.extract_result;
      const state = result?.state || "pending";

      onProgress?.({
        state,
        extractedPages: result?.extract_progress?.extracted_pages,
        totalPages: result?.extract_progress?.total_pages,
        message: state,
      });

      if (state === "done") {
        if (!result?.full_zip_url) {
          throw new Error("MinerU result is done but full_zip_url is missing.");
        }
        return result.full_zip_url;
      }
      if (state === "failed") {
        throw new Error(result?.err_msg || "MinerU parsing failed.");
      }

      await Zotero.Promise.delay(this.settings.pollIntervalMs);
    }
    throw new Error("MinerU parsing timed out while polling results.");
  }

  private async downloadAndNormalizeZip(
    zipUrl: string,
    attachmentKey: string,
  ): Promise<NormalizedMinerUOutput> {
    const response = await fetch(zipUrl);
    if (!response.ok) {
      throw new Error(
        `MinerU result ZIP download failed: HTTP ${response.status}`,
      );
    }
    const zip = await JSZip.loadAsync(await response.arrayBuffer());

    const readJson = async (suffixes: string[]) => {
      const file = findZipFile(zip, suffixes);
      return file ? JSON.parse(await file.async("string")) : undefined;
    };
    const markdownFile = findZipFile(zip, ["full.md", ".md"]);
    const assetMap = await this.extractAssets(zip, attachmentKey);

    return normalizeMinerUOutput({
      contentListV2: await readJson([
        "_content_list_v2.json",
        "content_list_v2.json",
      ]),
      contentList: await readJson(["_content_list.json", "content_list.json"]),
      middleJson: await readJson(["_middle.json", "middle.json"]),
      markdown: markdownFile ? await markdownFile.async("string") : undefined,
      assetMap,
    });
  }

  private async extractAssets(
    zip: JSZip,
    attachmentKey: string,
  ): Promise<Record<string, string>> {
    const assetMap: Record<string, string> = {};
    let count = 0;
    let totalBytes = 0;

    for (const file of Object.values(zip.files)) {
      if (file.dir || count >= MAX_ASSET_COUNT) continue;
      const descriptor = describeMinerUAsset(file.name);
      if (!descriptor) continue;
      const bytes = await file.async("uint8array");
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        ztoolkit.log("Skipping oversized MinerU image asset", {
          path: descriptor.zipPath,
          bytes: bytes.byteLength,
        });
        continue;
      }
      if (totalBytes + bytes.byteLength > MAX_TOTAL_ASSET_BYTES) {
        ztoolkit.log("MinerU image asset cache reached its size limit", {
          attachmentKey,
          totalBytes,
        });
        break;
      }

      await this.cache.writeAsset(attachmentKey, descriptor.storedName, bytes);
      descriptor.aliases.forEach((alias) => {
        assetMap[alias] = descriptor.storedName;
      });
      count += 1;
      totalBytes += bytes.byteLength;
    }
    return assetMap;
  }

  private async request<T>(
    url: string,
    init: RequestInit,
  ): Promise<MinerUResponse<T>> {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.settings.apiKey}`,
        ...(init.headers || {}),
      },
    });

    const payload = (await response.json()) as unknown as MinerUResponse<T>;
    if (!response.ok || payload.code !== 0) {
      throw new Error(
        `MinerU API error: ${payload.msg || `HTTP ${response.status}`}`,
      );
    }
    return payload;
  }
}

function findZipFile(
  zip: JSZip,
  suffixes: string[],
): JSZip.JSZipObject | undefined {
  const files = Object.values(zip.files).filter((file) => !file.dir);
  return files.find((file) =>
    suffixes.some((suffix) => file.name.toLowerCase().endsWith(suffix)),
  );
}
