import type { MinerUProgress } from "./types";

export function describeMinerUProgress(
  progress: MinerUProgress,
  hasParsed: boolean,
): string {
  if (hasParsed && progress.state !== "failed") {
    return "解析完成";
  }
  switch (progress.state) {
    case "idle":
      return "尚未解析";
    case "pending":
      return "正在创建解析任务…";
    case "waiting-file":
      return "正在上传 PDF…";
    case "converting":
      return "转换中…";
    case "running":
      return progress.totalPages && progress.extractedPages != null
        ? `解析中 ${progress.extractedPages}/${progress.totalPages} 页`
        : "解析中…";
    case "done":
      return "正在下载解析结果…";
    case "failed":
      return "解析失败";
  }
}
